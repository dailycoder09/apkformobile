package com.familywatch.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

// Periodic (every 15 min, see MainActivity.scheduleWorkManagerRestart) low-priority
// heartbeat — NOT resurrecting a service that should have stayed alive. KeepAliveService is
// dormant by default now (no permanent wake lock, no self-resurrection on swipe-away — see
// its own idle-shutdown/onTaskRemoved) and relies on the admin's FCM "Wake up" push to come
// back on demand. This tick's only job is to briefly wake it so registerCallLogObserver()/
// syncCallLog() can catch up on anything missed while dormant (bounded by lastCallLogId, so
// it's a correct catch-up regardless of how long it was asleep) before it goes back to sleep
// on its own via the same idle-shutdown timer.
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
