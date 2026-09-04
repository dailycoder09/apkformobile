package com.familywatch.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.content.FileProvider;
import com.getcapacitor.BridgeActivity;
import java.io.File;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestAllFilesAccess();
        registerNativeBridge();
        DeviceBackupWorker.scheduleDaily(getApplicationContext());
    }

    @Override
    public void onPause() {
        super.onPause();
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) webView.resumeTimers();
    }

    @Override
    public void onStop() {
        super.onStop();
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) webView.resumeTimers();
    }

    // ── JavaScript interface so React can talk to native ────────────────────────
    private void registerNativeBridge() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new MeeeeNative(), "MeeeeNative");
        }
    }

    class MeeeeNative {
        // connect()/disconnect() used to start/stop the background KeepAliveService (FCM
        // wake-up, remote file access, live camera/mic/location streaming, call-log sync)
        // for the admin/child-device monitoring feature — all removed now that this is a
        // single-user offline app with no admin and no second device to watch. Kept as
        // no-ops (rather than deleted outright) because Dashboard.jsx still calls
        // `window.MeeeeNative.connect(...)` unconditionally whenever the bridge object is
        // present; removing the methods entirely would throw at that call site.
        @JavascriptInterface
        public void connect(String serverUrl, String name) {
        }

        @JavascriptInterface
        public void disconnect() {
        }

        // Mirrors the WebView's own localStorage device id into native SharedPreferences —
        // see localData.js's getDeviceId() for why: DeviceBackupWorker.java's background
        // job runs via WorkManager, independent of this WebView, and can't read
        // localStorage directly, but needs the SAME device id the rest of the app (and
        // the parent's restore screen) already knows this device by.
        @JavascriptInterface
        public void cacheDeviceId(String deviceId) {
            if (deviceId == null || deviceId.isEmpty()) return;
            // commit() (synchronous), not apply() — this write needs to survive the app
            // process dying shortly after, since the later WorkManager backup job runs in
            // its own process and must see it; apply()'s async write can be lost to that
            // race, which is exactly what caused a fresh random device id on every single
            // backup run during testing on this (MIUI, aggressively process-killing) device.
            getApplicationContext()
                .getSharedPreferences(DeviceBackupWorker.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(DeviceBackupWorker.PREF_DEVICE_ID, deviceId)
                .commit();
        }

        // Mirrors the display name the person entered at onboarding, purely so the
        // parent can tell whose backup is whose (bucket path + in-app device list)
        // instead of just an opaque device id — see App.jsx's cacheDeviceName().
        @JavascriptInterface
        public void cacheDeviceName(String name) {
            if (name == null || name.isEmpty()) return;
            getApplicationContext()
                .getSharedPreferences(DeviceBackupWorker.PREFS, Context.MODE_PRIVATE)
                .edit()
                .putString(DeviceBackupWorker.PREF_DEVICE_NAME, name)
                .commit();
        }

        // Testing-only trigger — see DeviceBackupWorker.runNow()'s own comment. Not part
        // of the real daily schedule (that's enqueued once in onCreate() above); this is
        // purely so a manual test doesn't need to wait a real 24 hours to see a result.
        @JavascriptInterface
        public void runBackupNow() {
            DeviceBackupWorker.runNow(getApplicationContext());
        }

        @JavascriptInterface
        public void installApk(String filePath) {
            File file = new File(filePath);
            Uri apkUri = FileProvider.getUriForFile(MainActivity.this, getPackageName() + ".fileprovider", file);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(intent);
        }
    }

    // ── Permissions ──────────────────────────────────────────────────────────
    private void requestAllFilesAccess() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (!Environment.isExternalStorageManager()) {
                Intent intent = new Intent(
                    Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
                    Uri.parse("package:" + getPackageName())
                );
                startActivity(intent);
            }
        }
    }
}
