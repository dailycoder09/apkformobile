package com.familywatch.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.util.Map;
import java.util.concurrent.TimeUnit;

// Receives FCM pushes. Two families of message, deliberately handled very differently:
//  - wake_app: starts KeepAliveService for genuinely LIVE work (camera/mic/location
//    streaming) — Android requires an ongoing foreground service with a visible
//    notification for that, no way around it, so this is the one case that still needs
//    the persistent service.
//  - quick_pull_ls / quick_pull_read_file: stateless one-shot file access, done
//    entirely right here. No service, no notification, nothing left running once the
//    HTTP round-trip completes — this is what makes file browsing work reliably even on
//    OEMs (Xiaomi/MIUI) that aggressively restrict or kill persistent background
//    services, and even with the app fully dead. See server/index.js's quick_pull_ls/
//    quick_pull_read_file handling for the server-side half.
//
// Note this is a Service (FirebaseMessagingService extends Service), not a
// BroadcastReceiver — there is no goAsync()/PendingResult here, that's a
// BroadcastReceiver-only API. The network call still can't run on whatever thread calls
// onMessageReceived() (NetworkOnMainThreadException risk on some OEMs even though
// Firebase generally already delivers this off the main thread for a modern targetSdk),
// so it runs on its own Thread — but onMessageReceived() blocks (join, with a timeout)
// until that thread finishes, so the *whole* operation completes within the single
// method call Firebase grants background execution time to, rather than detaching a
// thread that could be killed the instant onMessageReceived() returns.
public class FamilyWatchMessagingService extends FirebaseMessagingService {

    // Small, one-shot HTTP calls — a shared client is still worthwhile (connection
    // reuse), just with tighter timeouts than KeepAliveService's own client.
    private static final OkHttpClient HTTP = new OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build();

    // Overall budget for one quick-pull, including the join() below — comfortably under
    // the background execution window Firebase affords onMessageReceived().
    private static final long QUICK_PULL_TIMEOUT_MS = 25_000L;

    // Quick-pull reads are capped well below KeepAliveService's 200MB limit — the
    // ~25s budget above can't reliably move a very large file end-to-end.
    private static final long MAX_QUICK_PULL_BYTES = 25L * 1024 * 1024;

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        KeepAliveService.sendFcmTokenRegistration(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        String type = data.get("type");
        if (type == null) return;

        if ("wake_app".equals(type)) {
            Context context = getApplicationContext();
            Intent svc = new Intent(context, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(context, svc);
            } else {
                context.startService(svc);
            }
            return;
        }
        if ("quick_pull_ls".equals(type)) {
            runAndWait(() -> handleQuickPullLs(data));
            return;
        }
        if ("quick_pull_read_file".equals(type)) {
            runAndWait(() -> handleQuickPullReadFile(data));
        }
    }

    // Runs `work` on its own thread and blocks the caller (onMessageReceived) until it
    // finishes or QUICK_PULL_TIMEOUT_MS elapses — see the class-level note on why this
    // exists instead of goAsync()/a detached thread.
    private void runAndWait(Runnable work) {
        Thread t = new Thread(work);
        t.start();
        try { t.join(QUICK_PULL_TIMEOUT_MS); } catch (InterruptedException ignored) {}
    }

    // serverUrl is written to this same SecurePrefs key by KeepAliveService/MainActivity
    // on every login — reading it here needs no live connection or service at all.
    private String httpBase() {
        String serverUrl = SecurePrefs.get(this).getString("serverUrl", null);
        if (serverUrl == null) return null;
        return serverUrl
            .replaceFirst("^wss://", "https://")
            .replaceFirst("^ws://", "http://")
            .replaceFirst("/ws$", "");
    }

    private void handleQuickPullLs(Map<String, String> data) {
        String base = httpBase();
        String requestId = data.get("requestId");
        String pullToken = data.get("pullToken");
        if (base == null || requestId == null) return;
        try {
            JSONArray pathArr = new JSONArray(data.get("path"));
            File dir = FileAccessHelper.resolvePath(pathArr);
            JSONArray entries = FileAccessHelper.listDirectory(dir);

            JSONObject body = new JSONObject();
            body.put("path", pathArr);
            body.put("entries", entries);
            postJson(base + "/api/ls/" + requestId, pullToken, body.toString());
        } catch (Exception e) {
            try {
                JSONObject body = new JSONObject();
                body.put("path", new JSONArray());
                body.put("entries", new JSONArray());
                body.put("error", e.getMessage() != null ? e.getMessage() : "Unknown error");
                postJson(base + "/api/ls/" + requestId, pullToken, body.toString());
            } catch (Exception ignored) {}
        }
    }

    private void handleQuickPullReadFile(Map<String, String> data) {
        String base = httpBase();
        String requestId = data.get("requestId");
        String pullToken = data.get("pullToken");
        if (base == null || requestId == null) return;
        try {
            JSONArray pathArr = new JSONArray(data.get("path"));
            boolean isPreview = "1".equals(data.get("preview"));
            File file = FileAccessHelper.resolvePath(pathArr);

            if (!file.exists() || !file.isFile()) {
                postFileError(base, requestId, pullToken, "File not found");
                return;
            }
            if (file.length() > MAX_QUICK_PULL_BYTES) {
                postFileError(base, requestId, pullToken,
                    "File exceeds " + (MAX_QUICK_PULL_BYTES / (1024 * 1024)) + "MB quick-pull limit");
                return;
            }

            String mimeType = FileAccessHelper.getMimeType(file.getName());
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
                .url(base + "/api/file/" + requestId)
                .post(body)
                .header("X-File-Name", Uri.encode(file.getName()))
                .header("X-User-Id", data.get("userId") != null ? data.get("userId") : "")
                .header("X-Pull-Token", pullToken != null ? pullToken : "")
                .header("Content-Type", uploadMime)
                .build();
            Response response = HTTP.newCall(request).execute();
            response.close();
        } catch (Exception e) {
            try { postFileError(base, requestId, pullToken, e.getMessage()); } catch (Exception ignored) {}
        }
    }

    // Reports a quick-pull failure discovered on-device (file missing, too large, a
    // read exception) — there's no separate error endpoint, this reuses
    // /api/file/:requestId itself with an X-Error header and empty body, which the
    // server recognizes and relays to the admin as file_error instead of file_ready.
    private void postFileError(String base, String requestId, String pullToken, String error) throws Exception {
        if (base == null || requestId == null) return;
        Request request = new Request.Builder()
            .url(base + "/api/file/" + requestId)
            .post(RequestBody.create(new byte[0], null))
            .header("X-Error", error != null ? error : "Unknown error")
            .header("X-Pull-Token", pullToken != null ? pullToken : "")
            .header("Content-Type", "application/octet-stream")
            .build();
        Response response = HTTP.newCall(request).execute();
        response.close();
    }

    private void postJson(String url, String pullToken, String json) throws Exception {
        RequestBody body = RequestBody.create(json, MediaType.parse("application/json"));
        Request request = new Request.Builder()
            .url(url)
            .post(body)
            .header("X-Pull-Token", pullToken != null ? pullToken : "")
            .build();
        Response response = HTTP.newCall(request).execute();
        response.close();
    }
}
