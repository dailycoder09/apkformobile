package com.familywatch.app;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.annotation.NonNull;
import androidx.core.content.ContextCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

// Receives FCM pushes so an admin can wake a fully-killed app on demand (see the
// admin "Wake up" action / server's wake_user handler) — Android starts this service
// to deliver the message even when our process is dead, which is the one thing
// KeepAliveService itself can't do once it's been killed. Every push here is a
// data-only message (no `notification` block, see server/firebaseAdmin.js's
// sendWakeUp), so nothing is ever shown to the user — this is silent infrastructure,
// not a user-facing notification feature.
public class FamilyWatchMessagingService extends FirebaseMessagingService {

    @Override
    public void onNewToken(@NonNull String token) {
        super.onNewToken(token);
        KeepAliveService.sendFcmTokenRegistration(getApplicationContext(), token);
    }

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        super.onMessageReceived(message);
        Map<String, String> data = message.getData();
        if (!"wake_app".equals(data.get("type"))) return;

        // Same one-liner BootReceiver.java already uses to (re)start the service after a
        // reboot — KeepAliveService's own existing connect logic takes it from there using
        // its already-saved serverUrl/credentials, no extra wiring needed here.
        Context context = getApplicationContext();
        Intent svc = new Intent(context, KeepAliveService.class);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            ContextCompat.startForegroundService(context, svc);
        } else {
            context.startService(svc);
        }
    }
}
