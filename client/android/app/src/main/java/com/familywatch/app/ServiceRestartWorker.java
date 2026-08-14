package com.familywatch.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

public class ServiceRestartWorker extends Worker {

    public ServiceRestartWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        // Only restart if the user was previously connected (credentials saved)
        String url = SecurePrefs.get(ctx).getString("serverUrl", null);
        if (url != null && !url.isEmpty()) {
            Intent svc = new Intent(ctx, KeepAliveService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ContextCompat.startForegroundService(ctx, svc);
            } else {
                ctx.startService(svc);
            }
        }
        return Result.success();
    }
}
