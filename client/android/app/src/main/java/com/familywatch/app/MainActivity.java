package com.familywatch.app;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestAllFilesAccess();
        requestBatteryOptimizationExemption(); // KEY: bypass Doze mode
        startKeepAlive();
        registerNativeBridge();
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
}
