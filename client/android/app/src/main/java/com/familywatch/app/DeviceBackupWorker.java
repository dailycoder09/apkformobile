package com.familywatch.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;
import android.os.Environment;
import android.util.Base64;
import android.util.Log;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.Data;
import androidx.work.ExistingWorkPolicy;
import androidx.work.ForegroundInfo;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.OutOfQuotaPolicy;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.SecureRandom;
import java.security.spec.MGF1ParameterSpec;
import java.security.spec.RSAPublicKeySpec;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Comparator;
import java.util.Date;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.crypto.Cipher;
import javax.crypto.CipherOutputStream;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

// Daily background job (see scheduleInitial/onCreate in MainActivity) that backs up new/
// changed files in a fixed set of media folders — Camera/DCIM, Pictures, Movies,
// Downloads, WhatsApp media — to the family server, end-to-end encrypted so only
// whoever holds the parent's private key (generated and kept in backupKeys.js, never
// sent anywhere) can ever decrypt them. Runs fully independently of the app's WebView
// via WorkManager: no dependency on the app being open, on FCM, or on any live network
// session — see the approved plan's rationale ("we can't get access of child when we
// want") for why this is a push-on-a-schedule design rather than the old on-demand pull.
public class DeviceBackupWorker extends Worker {

    // Package-visible (not private) — MainActivity.java's cacheDeviceId() writes into
    // this same SharedPreferences file/key so this Worker and the WebView agree on one
    // device identity instead of each minting their own.
    static final String PREFS = "device_backup_prefs";
    static final String PREF_DEVICE_ID = "device_id";
    static final String PREF_DEVICE_NAME = "device_name";
    // "yyyy-MM-dd" of the last day a real backup attempt actually started (scanning +
    // uploading, not the schedule-only/trigger-only/Wi-Fi-watch lightweight paths) —
    // lets backupOnAppOpen() and the Wi-Fi-watch trigger both skip redundantly
    // re-attempting a backup the exact-time daily schedule already handled today, while
    // still trying if that scheduled attempt was skipped or never fired at all.
    private static final String PREF_LAST_BACKUP_ATTEMPT_DATE = "last_backup_attempt_date";

    // Not wired up anywhere by default — WorkManager jobs run headless with no UI to show
    // errors, so `adb logcat -s DeviceBackupWorker` is the only way to see what happened
    // on a real device. Added after multiple silent doWork() failures during testing that
    // left zero trace anywhere (server logs included, since nothing ever reached the
    // network call that failed before).
    private static final String TAG = "DeviceBackupWorker";

    private static final String UNIQUE_WORK_NAME = "device-backup-daily";
    private static final String UNIQUE_WORK_NAME_NOW = "device-backup-run-now";
    private static final String UNIQUE_WORK_NAME_SYNC = "device-backup-sync-schedule";
    private static final String UNIQUE_WORK_NAME_EXPEDITED = "device-backup-expedited";
    // Separate from UNIQUE_WORK_NAME's exact-time chain — this one carries no delay, only
    // a Wi-Fi constraint, so Android/JobScheduler runs it the moment Wi-Fi next connects
    // (even from a fully-dead app process, the same mechanism that makes any WorkManager
    // network constraint work at all). Complements, doesn't replace, the exact-time
    // schedule: if Wi-Fi connects before/after the configured time and today's backup
    // hasn't happened yet, this is what actually catches it, rather than only ever
    // trying right at the configured clock time regardless of whether Wi-Fi exists then.
    private static final String UNIQUE_WORK_NAME_WIFI_WATCH = "device-backup-wifi-watch";
    private static final String INPUT_WIFI_WATCH = "wifi_watch";
    private static final String INPUT_SCHEDULE_ONLY = "schedule_only";
    // Fires on every single app open, unconditionally — unlike fetchBackupToken()'s
    // /pair call, which only happens when a real backup body actually executes (see
    // didBackupRunToday()/backupOnAppOpen()'s early-return). Once today's backup has
    // already run, every later app open used to make zero network calls at all, so the
    // parent's "online now"/last-seen display went stale after the first check-in of
    // the day. No network-type constraint on purpose (see heartbeat() below) — a tiny
    // presence ping is fine over cellular even though real backup data never is.
    private static final String UNIQUE_WORK_NAME_HEARTBEAT = "device-backup-heartbeat";
    private static final String INPUT_HEARTBEAT_ONLY = "heartbeat_only";
    // Fixed daily notifications, independent of the backup schedule/state entirely —
    // no backup/upload progress is ever mentioned in these (see NOTIFICATION_CHANNEL_ID
    // above for that separate, near-invisible channel). Each entry is {hour, minute};
    // each gets its own self-perpetuating chain (own unique work name) so one firing/
    // rescheduling never interferes with the others.
    private static final int[][] APP_OPEN_REMINDER_TIMES = {{8, 0}, {13, 0}, {21, 0}};
    private static final String UNIQUE_WORK_NAME_REMINDER_PREFIX = "device-backup-reminder-";
    private static final String INPUT_REMINDER_ONLY = "reminder_only";
    private static final String INPUT_REMINDER_HOUR = "reminder_hour";
    private static final String INPUT_REMINDER_MINUTE = "reminder_minute";
    private static final String REMINDER_CHANNEL_ID = "device_backup_reminder";
    private static final int REMINDER_NOTIFICATION_ID = 4822;
    // Which FAITH_QUOTES indices have not been shown yet in the current cycle, stored
    // as a comma-separated string — consumed one at a time in shuffled order; once
    // empty, a fresh shuffle of all indices is generated. This is what guarantees no
    // quote repeats until every other one has been shown at least once (plain random
    // selection, tried earlier, could and did repeat the same quote back-to-back).
    private static final String PREF_FAITH_QUOTE_QUEUE = "faith_quote_queue";
    // {reference, English, Hindi}. A small, easily-edited set of short, extremely
    // well-known Quran verses and Hadith with standard Hindi renderings — review/
    // expand this list to taste; these are commonly-cited short excerpts, kept to a
    // handful on purpose rather than an exhaustive collection.
    private static final String[][] FAITH_QUOTES = {
        {"Quran 94:6",
            "Indeed, with hardship will be ease.",
            "निस्संदेह कठिनाई के साथ आसानी भी है।"},
        {"Quran 65:3",
            "And whoever relies upon Allah - then He is sufficient for him.",
            "और जो अल्लाह पर भरोसा करे, तो वह उसके लिए काफ़ी है।"},
        {"Quran 13:28",
            "Verily, in the remembrance of Allah do hearts find rest.",
            "सुन लो! अल्लाह की याद से ही दिलों को चैन मिलता है।"},
        {"Quran 2:286",
            "Allah does not burden a soul beyond that it can bear.",
            "अल्लाह किसी जीव पर उसकी सामर्थ्य से बढ़कर बोझ नहीं डालता।"},
        {"Quran 2:152",
            "So remember Me; I will remember you.",
            "अतः तुम मुझे याद करो, मैं तुम्हें याद करूँगा।"},
        {"Sahih al-Bukhari",
            "The best among you are those who have the best manners and character.",
            "तुम में सबसे अच्छा वह है जो अच्छे अख़लाक़ (चरित्र) वाला है।"},
        {"Sahih al-Bukhari, Hadith 13",
            "None of you truly believes until he loves for his brother what he loves for himself.",
            "तुम में से कोई मोमिन नहीं हो सकता जब तक कि वह अपने भाई के लिए वही पसंद न करे जो अपने लिए पसंद करता है।"},
        {"Sahih al-Bukhari & Muslim",
            "Whoever believes in Allah and the Last Day should speak good or remain silent.",
            "जो अल्लाह और आख़िरत के दिन पर ईमान रखता है, उसे चाहिए कि अच्छी बात कहे या ख़ामोश रहे।"},
        {"Sahih al-Bukhari & Muslim",
            "The strong person is not the one who wrestles others down; the strong person is the one who controls himself when angry.",
            "असली ताक़तवर वह नहीं जो कुश्ती में जीत जाए, बल्कि असली ताक़तवर वह है जो ग़ुस्से के वक़्त खुद पर काबू रखे।"},
        {"Jami at-Tirmidhi",
            "Smiling at your brother is charity.",
            "अपने भाई को देखकर मुस्कुराना भी सदक़ा (दान) है।"},
    };
    // Full-storage inventory scan (filenames/sizes/dates only, no content) — separate
    // from the real 5-folder media backup above. Runs once automatically the moment
    // file access is granted (see backupOnAppOpen()'s permission branch), plus
    // on-demand whenever the parent taps "Scan folders" (delivered via the same
    // one-shot-heartbeat-flag mechanism as INPUT_HEARTBEAT_ONLY's forceBackup).
    private static final String UNIQUE_WORK_NAME_TREE_SCAN = "device-backup-tree-scan";
    private static final String INPUT_TREE_SCAN_ONLY = "tree_scan_only";
    private static final String PREF_TREE_SCAN_DONE = "tree_scan_done";
    // Safety net against a runaway scan on an unusual device (a huge SD card, a
    // symlink loop, etc.) — the report is marked truncated rather than growing
    // unbounded or running forever.
    private static final int MAX_TREE_SCAN_ENTRIES = 300_000;
    // WorkManager forbids combining setExpedited() with setInitialDelay() on the same
    // request, but setExpedited() is what grants the OS exemption needed to reliably
    // call setForegroundAsync() when the app isn't currently visible — confirmed
    // necessary via a real ForegroundServiceStartNotAllowedException on an actually-
    // scheduled, unattended run during testing (manually-triggered runs worked fine,
    // since the app was recently visible then). So scheduleNext()'s delayed request
    // only carries this flag and, when it fires, immediately hands off to a second,
    // separate expedited request (no delay) that does the real backup work.
    private static final String INPUT_TRIGGER_ONLY = "trigger_only";
    // Re-added after production logs (Sep 8-10) showed a large chunk's upload getting
    // killed mid-transfer, over and over, every single night — WorkManager's ordinary
    // ~10-minute background execution budget, with no foreground-service exemption,
    // is genuinely not enough for a 100+MB file on a slow upload connection. This is
    // the SAME mechanism removed earlier per an explicit no-notifications request; it
    // is back now because that request's accepted trade-off (large uploads can get
    // silently killed) turned out to cause real, ongoing data-loss-risk in practice,
    // not just a theoretical risk. Made as close to invisible as Android actually
    // permits: IMPORTANCE_MIN (hidden from the status bar, collapsed at the bottom of
    // the shade) and — deliberately — no runtime POST_NOTIFICATIONS request anywhere in
    // this app, so on Android 13+ the notification most likely never becomes visible at
    // all (the execution-time benefit does not depend on that permission, only the
    // notification's visibility does). There is still no way to make a foreground
    // service exist with literally zero notification ever, on any Android version —
    // that is an OS-enforced rule, not a setting.
    private static final String NOTIFICATION_CHANNEL_ID = "device_backup";
    private static final int NOTIFICATION_ID = 4821; // arbitrary, just needs to be stable
    private static final String SERVER_BASE_URL = "https://familywatch.duckdns.org";
    // Lowered from an earlier 400MB after testing showed a single large chunk's
    // zip+encrypt+upload cycle could run long enough for the OS (this MIUI device in
    // particular) to kill the background process mid-operation. Smaller chunks finish
    // each cycle faster, shrinking that window — now the ONLY mitigation for that risk,
    // since foreground-service promotion (which used to remove the time limit entirely
    // while visible) was deliberately removed along with every other notification in
    // this file (a single file already over this cap still gets its own oversized
    // chunk either way).
    private static final long MAX_CHUNK_BYTES = 20L * 1024 * 1024;
    // Per-run cap, separate from the per-chunk cap above: a device with a huge backlog
    // (seen during testing: 25,000+ pending files, 90+ chunks) would otherwise try to
    // upload everything in one run, which could take hours. Capping each night's run to
    // ~500MB of fresh data keeps a single run's duration predictable; whatever doesn't
    // fit is simply still "pending" in the manifest afterward, so the next night's run
    // naturally picks up right where this one stopped — no separate resume logic needed.
    private static final long MAX_TOTAL_BYTES_PER_RUN = 500L * 1024 * 1024;
    // Temporary cap on any SINGLE file, separate from MAX_CHUNK_BYTES (which just bin-
    // packs multiple normal-sized files together — a lone file already over that cap
    // gets its own chunk regardless of size). A file over this limit is skipped for now
    // rather than attempted as one giant chunk — not because it can't work (the OOM
    // crash, foreground-service exception, and self-cancelling-run bugs that made large
    // single files unreliable are all fixed), but as a deliberate short-term choice
    // while a proper fix (splitting one large file across multiple normal-sized chunks,
    // reassembled on the parent's decrypt/view side) is still to be built. Skipped files
    // stay "pending" forever (never marked uploaded) so they're picked up automatically,
    // with zero extra logic, the moment this cap is raised or removed — and every run
    // reports how many/which were skipped, so this is a visible gap, not a silent one.
    private static final long MAX_SINGLE_FILE_BYTES = 200L * 1024 * 1024;
    private static final int CONNECT_TIMEOUT_MS = 30_000;
    private static final int READ_TIMEOUT_MS = 60_000;

    // Folders backed up, relative to external storage root — specific known media
    // locations a parent actually cares about, not an unbounded walk of every readable
    // file (narrowed from "everything readable" during planning).
    private static final String[] TARGET_FOLDERS = {
        "DCIM/Camera",
        "Pictures",
        "Movies",
        "Download",
        "Android/media/com.whatsapp/WhatsApp/Media",
    };

    public DeviceBackupWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    // Called once from MainActivity.onCreate() — only seeds the chain if nothing is
    // scheduled yet (KEEP policy: later app launches don't reset/duplicate an
    // already-scheduled job). Uses a fixed 23:00 default since this runs before the app
    // has ever fetched the parent's actual configured schedule — doWork()'s own
    // finally block takes over perpetuating the chain at the real configured time from
    // the very first run onward (see fetchBackupSchedule/scheduleNext below).
    static void scheduleInitial(Context context) {
        scheduleNext(context, 23, 0, ExistingWorkPolicy.KEEP);
    }

    // Computes the exact delay to the next occurrence of hour:minute (today if it
    // hasn't passed yet, else tomorrow) and enqueues a single OneTimeWorkRequest for
    // exactly that delay — no flex window, no approximation, unlike the PeriodicWorkRequest
    // this replaced (whose flex-window timing had real, acknowledged ambiguity in how
    // it interacted with an initial delay). Called both by scheduleInitial (once, at
    // first app launch) and by doWork()'s own finally block (every run, perpetuating
    // the chain for tomorrow at whatever schedule was just fetched from the server).
    static void scheduleNext(Context context, int hour, int minute, ExistingWorkPolicy policy) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresBatteryNotLow(true)
            .build();

        Calendar target = Calendar.getInstance();
        target.set(Calendar.HOUR_OF_DAY, hour);
        target.set(Calendar.MINUTE, minute);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        if (target.before(Calendar.getInstance())) {
            target.add(Calendar.DAY_OF_YEAR, 1);
        }
        long initialDelayMs = target.getTimeInMillis() - System.currentTimeMillis();

        // This request only carries INPUT_TRIGGER_ONLY — it cannot also be setExpedited()
        // (WorkManager forbids that combination with setInitialDelay), so it does nothing
        // but hand off to a real expedited request the moment it fires. See
        // INPUT_TRIGGER_ONLY's own comment and triggerExpeditedBackup() below.
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInputData(new Data.Builder().putBoolean(INPUT_TRIGGER_ONLY, true).build())
            .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, OneTimeWorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME, policy, request);
        Log.d(TAG, "scheduleNext: next run in " + initialDelayMs + "ms (target " + hour + ":" + minute + ")");
    }

    // Fires when scheduleNext()'s delayed trigger elapses — immediately enqueues the
    // real backup as a separate expedited request (no delay, so setExpedited() is
    // allowed) and returns right away. Expedited status gives the OS exemption needed
    // to actually run promptly even though the app isn't currently visible.
    // Network constraint only — confirmed via a real IllegalArgumentException during
    // testing ("Expedited jobs only support network and storage constraints") that
    // setRequiresBatteryNotLow() (used on the plain delayed trigger in scheduleNext) is
    // NOT allowed on an expedited request. The battery check already happened once, on
    // the trigger that led here, so dropping it here isn't a meaningful gap.
    private void triggerExpeditedBackup() {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .build();
        // KEEP, not REPLACE — confirmed via real testing that REPLACE cancels an
        // already-running backup outright the moment a new trigger fires (e.g. a large
        // file's upload got cut off mid-transfer this way when a subsequent scheduled
        // occurrence landed while the previous run was still active). A run in progress
        // should be left alone; it reschedules the next occurrence itself when it
        // finishes anyway, via doWork()'s own finally block.
        WorkManager.getInstance(getApplicationContext())
            .enqueueUniqueWork(UNIQUE_WORK_NAME_EXPEDITED, ExistingWorkPolicy.KEEP, request);
        Log.d(TAG, "triggerExpeditedBackup: handed off to expedited work");
    }

    // Kicks off a full-storage inventory scan (see scanDeviceTree()) — expedited and
    // Wi-Fi-gated for the same reasons as triggerExpeditedBackup() above (may run while
    // the app isn't visible, and a scan across a large device can take a while). KEEP,
    // not REPLACE, so a manual re-trigger from the parent never cancels a scan already
    // in progress. Called both by backupOnAppOpen()'s one-time auto-trigger and by
    // doWorkInternal()'s INPUT_HEARTBEAT_ONLY branch when the parent requests one.
    private static void scheduleTreeScan(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build();
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInputData(new Data.Builder().putBoolean(INPUT_TREE_SCAN_ONLY, true).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_TREE_SCAN, ExistingWorkPolicy.KEEP, request);
        Log.d(TAG, "scheduleTreeScan: enqueued");
    }

    // Testing-only escape hatch — WorkManager's periodic schedule has no "run it right
    // now" trigger, and waiting a real 24h to find out if a change works isn't
    // practical. No network/battery constraints on purpose: a manually-requested test
    // run should run immediately regardless of Wi-Fi/charging state, unlike the real
    // daily schedule. Exposed to JS via MainActivity's MeeeeNative.runBackupNow().
    // Expedited for the same reason as the real schedule's trigger hand-off — even a
    // manual run isn't guaranteed to still count as "recently visible" by the time it
    // actually executes (e.g. the person taps the button then immediately backgrounds
    // the app).
    static void runNow(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_NOW, ExistingWorkPolicy.REPLACE, request);
    }

    // Called from MainActivity.onCreate() on every app launch — a lightweight, network-
    // only check for whether the parent changed the backup schedule since last time,
    // WITHOUT running an actual backup. There is no live channel to push a schedule
    // change to a child device (see localTransport.js — this app fakes all messaging
    // locally), so simply opening the app on the child's phone is the only realistic way
    // to prompt it to re-check — much lighter than requiring a full "Run backup now"
    // (which was the only way to force this before, and does a real file scan/upload as
    // an unwanted side effect just to pick up a time change). doWork() checks
    // INPUT_SCHEDULE_ONLY at the very top and, if set, skips straight to re-fetching the
    // schedule and re-anchoring UNIQUE_WORK_NAME's chain, doing nothing else.
    static void syncScheduleNow(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInputData(new Data.Builder().putBoolean(INPUT_SCHEDULE_ONLY, true).build())
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_SYNC, ExistingWorkPolicy.REPLACE, request);
    }

    private static String todayString() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(new Date());
    }

    // True once a real backup attempt (scanning + uploading, not a lightweight
    // schedule-only/trigger-only/Wi-Fi-watch check) has already started today — lets
    // backupOnAppOpen() and the Wi-Fi-watch trigger both skip redundantly re-attempting
    // what the exact-time daily schedule already handled, while still trying if that
    // scheduled attempt was skipped (permission not granted, no parent key yet) or never
    // fired at all (background execution failing silently, which this device has done
    // more than once during testing).
    private static boolean didBackupRunToday(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return todayString().equals(prefs.getString(PREF_LAST_BACKUP_ATTEMPT_DATE, ""));
    }

    private static void markBackupAttemptedToday(Context context) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString(PREF_LAST_BACKUP_ATTEMPT_DATE, todayString()).commit();
    }

    // Called from MainActivity.onCreate() on every app launch — attempts a real backup
    // right away, not just a schedule check, unless today's backup already ran (see
    // didBackupRunToday()). Background execution alone has proven unreliable on this
    // device (WorkManager's own time limits, MIUI's own restrictions on top of that, and
    // background WiFi sometimes being turned off entirely to save power) — opening the
    // app is a much stronger signal that the phone is awake, in the person's hand, and
    // (if on WiFi) in a good position to actually complete an upload. NetworkType.
    // UNMETERED is the gate for "only when WiFi" — WorkManager simply won't run this
    // until that's satisfied, so no manual connectivity check is needed here. KEEP (not
    // REPLACE) so this never interrupts a backup already in progress — same reasoning as
    // triggerExpeditedBackup()'s own KEEP policy.
    static void backupOnAppOpen(Context context) {
        if (didBackupRunToday(context)) {
            Log.d(TAG, "backupOnAppOpen: today's backup already ran, skipping");
            return;
        }
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build();

        if (!Environment.isExternalStorageManager()) {
            // Permission not granted yet — most commonly right after a fresh install,
            // before the person has had a chance to navigate to system settings and
            // grant MANAGE_EXTERNAL_STORAGE. An immediate attempt here is guaranteed to
            // fail (confirmed via real testing: it tries and gets rejected within
            // seconds of install). Delay a couple minutes instead of trying-and-failing
            // right away. setExpedited() can't be combined with setInitialDelay() (a
            // real IllegalArgumentException hit earlier this session), so this reuses
            // the same delayed-trigger-hands-off-to-expedited pattern the exact-time
            // schedule already uses — see INPUT_TRIGGER_ONLY and triggerExpeditedBackup().
            OneTimeWorkRequest delayed = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
                .setInputData(new Data.Builder().putBoolean(INPUT_TRIGGER_ONLY, true).build())
                .setInitialDelay(2, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
            WorkManager.getInstance(context)
                .enqueueUniqueWork(UNIQUE_WORK_NAME_EXPEDITED, ExistingWorkPolicy.KEEP, delayed);
            Log.d(TAG, "backupOnAppOpen: permission not granted yet, delaying 2 minutes before attempting");
            return;
        }

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_EXPEDITED, ExistingWorkPolicy.KEEP, request);
        Log.d(TAG, "backupOnAppOpen: backup requested (will wait for WiFi if not already connected)");
    }

    // Called from MainActivity.onCreate() on every launch (cheap no-op once already
    // done — separate from backupOnAppOpen()'s own permission check, which is skipped
    // entirely once didBackupRunToday() is true, so this could never reliably fire from
    // inside that method). Runs the one-time full-storage inventory scan the moment
    // file access is granted, regardless of the daily backup's own state.
    static void scheduleTreeScanIfNeeded(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (prefs.getBoolean(PREF_TREE_SCAN_DONE, false)) return;
        if (!Environment.isExternalStorageManager()) return;
        scheduleTreeScan(context);
        // Marked done at schedule time, not on confirmed success — same reasoning as
        // markBackupAttemptedToday(): this is a one-off inventory, not worth retrying
        // forever if the one attempt fails, and the parent's "Scan folders" button
        // covers wanting a fresh/retried scan later anyway.
        prefs.edit().putBoolean(PREF_TREE_SCAN_DONE, true).commit();
    }

    // Called from MainActivity.onCreate() on EVERY app launch, regardless of Wi-Fi,
    // permission state, or whether today's backup already ran — a tiny presence ping so
    // the parent's device list actually reflects reality (see UNIQUE_WORK_NAME_HEARTBEAT's
    // own comment for the bug this fixes). REPLACE, not KEEP: unlike a real backup
    // attempt, there's nothing to protect an in-progress heartbeat from — the newest one
    // is always the one worth running. Also carries any parent-requested manual "back up
    // now" flag home (see doWorkInternal()'s INPUT_HEARTBEAT_ONLY branch below), which is
    // how a parent can force a re-backup even on a device that already ran today.
    static void heartbeat(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInputData(new Data.Builder().putBoolean(INPUT_HEARTBEAT_ONLY, true).build())
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_HEARTBEAT, ExistingWorkPolicy.REPLACE, request);
    }

    // Called from MainActivity.onCreate() (idempotent — KEEP policy means repeated calls
    // are harmless) to (re-)arm a standing watch for "Wi-Fi just became available." No
    // delay, only a network constraint, so JobScheduler runs it the instant Wi-Fi
    // connects — even if the app process is completely dead at that moment, the same
    // mechanism any WorkManager network constraint relies on. When it actually fires
    // (see doWork()'s INPUT_WIFI_WATCH branch), it checks didBackupRunToday(): if today's
    // backup already happened (via the exact-time schedule or an earlier app open), it
    // does nothing but re-arm itself for tomorrow's first Wi-Fi connection; otherwise it
    // attempts the backup right then.
    static void scheduleWifiWatch(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .build();
        // Expedited (network constraint only, no delay — both compatible with
        // setExpedited(), confirmed via the same real exceptions hit earlier) since this
        // can fire while the app is fully backgrounded.
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInputData(new Data.Builder().putBoolean(INPUT_WIFI_WATCH, true).build())
            .setExpedited(OutOfQuotaPolicy.RUN_AS_NON_EXPEDITED_WORK_REQUEST)
            .setConstraints(constraints)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_WIFI_WATCH, ExistingWorkPolicy.KEEP, request);
    }

    // Called once from MainActivity.onCreate() (idempotent — KEEP policy on each chain
    // makes repeated calls harmless) to seed all three fixed daily reminder times.
    static void scheduleAppOpenReminders(Context context) {
        for (int[] time : APP_OPEN_REMINDER_TIMES) {
            scheduleAppOpenReminder(context, time[0], time[1], ExistingWorkPolicy.KEEP);
        }
    }

    // Same exact-delay pattern as scheduleNext() (today if the time has not passed yet,
    // else tomorrow) but for one fixed reminder time — no network/battery constraints,
    // since posting a local notification needs neither. Self-perpetuating: firing (see
    // doWorkInternal()'s INPUT_REMINDER_ONLY branch) re-calls this for tomorrow.
    private static void scheduleAppOpenReminder(Context context, int hour, int minute, ExistingWorkPolicy policy) {
        Calendar target = Calendar.getInstance();
        target.set(Calendar.HOUR_OF_DAY, hour);
        target.set(Calendar.MINUTE, minute);
        target.set(Calendar.SECOND, 0);
        target.set(Calendar.MILLISECOND, 0);
        if (target.before(Calendar.getInstance())) {
            target.add(Calendar.DAY_OF_YEAR, 1);
        }
        long initialDelayMs = target.getTimeInMillis() - System.currentTimeMillis();

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInputData(new Data.Builder()
                .putBoolean(INPUT_REMINDER_ONLY, true)
                .putInt(INPUT_REMINDER_HOUR, hour)
                .putInt(INPUT_REMINDER_MINUTE, minute)
                .build())
            .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME_REMINDER_PREFIX + hour + "_" + minute, policy, request);
        Log.d(TAG, "scheduleAppOpenReminder: next " + hour + ":" + minute + " reminder in " + initialDelayMs + "ms");
    }

    // Posts a Quran verse or Hadith, in English and Hindi together — never anything
    // backup/upload-related (see NOTIFICATION_CHANNEL_ID's own comment for that
    // separate, near-invisible channel). Draws from a shuffled queue of FAITH_QUOTES
    // indices persisted in SharedPreferences, consuming one per call and reshuffling a
    // fresh full set only once the current one is exhausted — guarantees no quote
    // repeats until every other one has been shown at least once.
    private void postFaithReminder() {
        try {
            Context context = getApplicationContext();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationManager manager = context.getSystemService(NotificationManager.class);
                if (manager.getNotificationChannel(REMINDER_CHANNEL_ID) == null) {
                    manager.createNotificationChannel(new NotificationChannel(
                        REMINDER_CHANNEL_ID, "Daily reminders", NotificationManager.IMPORTANCE_DEFAULT));
                }
            }
            int index = nextFaithQuoteIndex(context);
            String reference = FAITH_QUOTES[index][0];
            String english = FAITH_QUOTES[index][1];
            String hindi = FAITH_QUOTES[index][2];
            String body = english + "\n" + hindi;

            Intent openApp = new Intent(context, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT
                | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0);
            PendingIntent pendingIntent = PendingIntent.getActivity(context, 0, openApp, flags);
            Notification notification = new NotificationCompat.Builder(context, REMINDER_CHANNEL_ID)
                .setContentTitle(reference)
                .setContentText(english)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT)
                .build();
            NotificationManager manager = context.getSystemService(NotificationManager.class);
            manager.notify(REMINDER_NOTIFICATION_ID, notification);
        } catch (Exception e) {
            Log.w(TAG, "postFaithReminder: failed to post", e);
        }
    }

    // Pops one index off the persisted shuffled queue, refilling and reshuffling with
    // a fresh full set (0..FAITH_QUOTES.length-1) whenever it is empty — see
    // PREF_FAITH_QUOTE_QUEUE's own comment for why this replaces plain random pick.
    private static int nextFaithQuoteIndex(Context context) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String stored = prefs.getString(PREF_FAITH_QUOTE_QUEUE, "");
        List<Integer> queue = new ArrayList<>();
        if (!stored.isEmpty()) {
            for (String part : stored.split(",")) {
                try { queue.add(Integer.parseInt(part)); } catch (NumberFormatException ignored) { }
            }
        }
        if (queue.isEmpty()) {
            for (int i = 0; i < FAITH_QUOTES.length; i++) queue.add(i);
            Collections.shuffle(queue);
        }
        int next = queue.remove(0);
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < queue.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(queue.get(i));
        }
        prefs.edit().putString(PREF_FAITH_QUOTE_QUEUE, sb.toString()).commit();
        return next;
    }

    @NonNull
    @Override
    public Result doWork() {
        // Wraps doWorkInternal() so the Wi-Fi watch is re-armed after EVERY execution,
        // regardless of which of doWorkInternal()'s several early-return branches was
        // taken (trigger-only, schedule-only, wifi-watch-already-done-today, permission
        // skip, parent-key skip, success, or failure) — a plain `finally` inside any one
        // of those branches would miss all the others. KEEP policy makes re-arming an
        // already-pending watch a safe no-op, so calling this unconditionally here is
        // harmless on every single doWork() call, not just the ones that matter.
        try {
            return doWorkInternal();
        } finally {
            scheduleWifiWatch(getApplicationContext());
        }
    }

    private Result doWorkInternal() {
        Log.d(TAG, "doWork: starting");

        if (getInputData().getBoolean(INPUT_TRIGGER_ONLY, false)) {
            // The exact-time delayed request fired — hand off to a real expedited
            // request immediately (see triggerExpeditedBackup()'s own comment for why
            // this two-step hand-off exists) and return right away; this execution does
            // nothing else. Wrapped in try/catch (unlike before) because a prior version
            // of this call site had no exception handling at all — if setExpedited()'s
            // WorkRequest construction ever throws, it would propagate uncaught with
            // zero logged reason, indistinguishable from the expedited work silently
            // never starting. reportStatus() here so this is visible from server logs
            // too, not just adb (which already missed this exact failure once).
            String deviceId = getDeviceId();
            Log.d(TAG, "doWork: trigger fired, handing off to expedited work");
            reportStatus(deviceId, "trigger fired, handing off to expedited work");
            try {
                triggerExpeditedBackup();
                reportStatus(deviceId, "expedited work enqueued OK");
            } catch (Exception e) {
                Log.e(TAG, "doWork: triggerExpeditedBackup failed", e);
                reportStatus(deviceId, "FAILED to hand off to expedited work: "
                    + e.getClass().getSimpleName() + ": " + e.getMessage());
                return Result.retry();
            }
            return Result.success();
        }

        if (getInputData().getBoolean(INPUT_REMINDER_ONLY, false)) {
            // Plain attention nudge — no permission/Wi-Fi/backup-state checks at all,
            // unlike every other branch here. Just post and re-arm for tomorrow at the
            // same fixed time.
            int hour = getInputData().getInt(INPUT_REMINDER_HOUR, 8);
            int minute = getInputData().getInt(INPUT_REMINDER_MINUTE, 0);
            postFaithReminder();
            scheduleAppOpenReminder(getApplicationContext(), hour, minute, ExistingWorkPolicy.REPLACE);
            Log.d(TAG, "doWork: posted " + hour + ":" + minute + " reminder, rescheduled for tomorrow");
            return Result.success();
        }

        if (getInputData().getBoolean(INPUT_HEARTBEAT_ONLY, false)) {
            // Lightweight presence ping — no permission check, no Wi-Fi check, no
            // didBackupRunToday() gate, since this must succeed and report "online" even
            // when none of those are true. If the parent has requested a manual backup
            // (forceBackup:true in the response), hand off to the SAME expedited,
            // Wi-Fi-gated work request the daily schedule uses — this bypasses only the
            // "already ran today" gate, never the Wi-Fi-only guarantee, since
            // triggerExpeditedBackup()'s own request still carries NetworkType.UNMETERED.
            // forceTreeScan works the same way, just for scheduleTreeScan() instead.
            String deviceId = getDeviceId();
            try {
                JSONObject response = sendHeartbeat(deviceId, getDeviceName());
                boolean forceBackup = response.optBoolean("forceBackup", false);
                boolean forceTreeScan = response.optBoolean("forceTreeScan", false);
                if (forceBackup) {
                    Log.d(TAG, "doWork: heartbeat, parent requested a manual backup, handing off");
                    triggerExpeditedBackup();
                }
                if (forceTreeScan) {
                    Log.d(TAG, "doWork: heartbeat, parent requested a folder scan, handing off");
                    scheduleTreeScan(getApplicationContext());
                }
                if (!forceBackup && !forceTreeScan) {
                    Log.d(TAG, "doWork: heartbeat sent");
                }
            } catch (Exception e) {
                Log.w(TAG, "doWork: heartbeat failed (non-fatal)", e);
            }
            return Result.success();
        }

        if (getInputData().getBoolean(INPUT_TREE_SCAN_ONLY, false)) {
            // Full-storage inventory — filenames/sizes/dates only, never file content.
            // Same permission/Wi-Fi checks as the real backup body below (belt-and-
            // suspenders on top of the request's own constraints, same reasoning as
            // isOnWifi()'s own comment), but otherwise fully independent of it.
            String deviceId = getDeviceId();
            try {
                if (!Environment.isExternalStorageManager()) {
                    Log.w(TAG, "doWork: tree scan skipped, MANAGE_EXTERNAL_STORAGE not granted");
                    return Result.success();
                }
                if (!isOnWifi()) {
                    Log.w(TAG, "doWork: tree scan skipped, not on Wi-Fi");
                    return Result.success();
                }
                String backupToken = fetchBackupToken(deviceId);
                JSONObject report = scanDeviceTree();
                int count = report.getJSONArray("entries").length();
                postFileReport(deviceId, backupToken, report);
                Log.d(TAG, "doWork: tree scan uploaded (" + count + " entries"
                    + (report.optBoolean("truncated", false) ? ", truncated" : "") + ")");
                reportStatus(deviceId, "folder scan uploaded (" + count + " entries"
                    + (report.optBoolean("truncated", false) ? ", truncated" : "") + ")");
            } catch (Exception e) {
                Log.e(TAG, "doWork: tree scan failed", e);
                reportStatus(deviceId, "FAILED folder scan: "
                    + e.getClass().getSimpleName() + ": " + e.getMessage());
            }
            return Result.success();
        }

        if (getInputData().getBoolean(INPUT_SCHEDULE_ONLY, false)) {
            // Lightweight path from syncScheduleNow() — just re-check the schedule and
            // re-anchor the daily chain (UNIQUE_WORK_NAME), no file scan/upload, no
            // permission check needed. fetchBackupSchedule() already catches its own
            // exceptions internally (falls back to 2:00), so no try/catch needed here.
            int[] schedule = fetchBackupSchedule();
            scheduleNext(getApplicationContext(), schedule[0], schedule[1], ExistingWorkPolicy.REPLACE);
            Log.d(TAG, "doWork: schedule-only sync, rescheduled next run for " + schedule[0] + ":" + schedule[1]);
            return Result.success();
        }

        if (getInputData().getBoolean(INPUT_WIFI_WATCH, false)) {
            // Wi-Fi just became available (that's the request's only constraint — see
            // scheduleWifiWatch()). If today's backup already happened, there's nothing
            // to do — the outer doWork() wrapper re-arms this watch for the next
            // connection regardless of which branch returns. Otherwise HAND OFF to the
            // same triggerExpeditedBackup() the exact-time chain uses (KEEP policy under
            // UNIQUE_WORK_NAME_EXPEDITED), rather than continuing the real backup body
            // inline under this job's own separate unique name — falling through here
            // used to run as a second, independent job in parallel with whatever
            // backupOnAppOpen() had already started, confirmed via real testing (multiple
            // concurrent "doWork: starting" entries with different thread ids on a single
            // app open). Handing off to the shared job slot lets WorkManager's own KEEP
            // policy deduplicate simultaneous triggers into one real attempt, not several.
            if (didBackupRunToday(getApplicationContext())) {
                Log.d(TAG, "doWork: wifi-watch fired, today's backup already ran, nothing to do");
                return Result.success();
            }
            Log.d(TAG, "doWork: wifi-watch fired, today's backup hasn't run yet, handing off");
            try {
                triggerExpeditedBackup();
            } catch (Exception e) {
                Log.e(TAG, "doWork: wifi-watch's triggerExpeditedBackup failed", e);
            }
            return Result.success();
        }

        // Declared outside the try so the catch block below can still report a failure
        // against this device's id even if the exception happened partway through.
        String deviceId = getDeviceId();
        try {
            if (!Environment.isExternalStorageManager()) {
                // Permission not granted yet — nothing readable. Not worth aggressive
                // retry; WorkManager tries again next period regardless.
                Log.w(TAG, "doWork: MANAGE_EXTERNAL_STORAGE not granted, skipping run");
                reportStatus(deviceId, "skipped: MANAGE_EXTERNAL_STORAGE not granted");
                return Result.success();
            }

            if (!isOnWifi()) {
                // Belt-and-suspenders on top of every request's NetworkType.UNMETERED
                // constraint (see isOnWifi()'s own comment for why that alone isn't a
                // strict enough guarantee) — checked before any network call at all,
                // including the lightweight token/key fetches below, so genuinely zero
                // bytes go over cellular for a backup, not even a small metadata request.
                Log.w(TAG, "doWork: not on Wi-Fi, skipping run");
                reportStatus(deviceId, "skipped: not on Wi-Fi");
                return Result.success();
            }

            String deviceName = getDeviceName();
            Log.d(TAG, "doWork: deviceId=" + deviceId + " deviceName=" + deviceName);
            reportStatus(deviceId, "starting (name=" + deviceName + ")");
            String backupToken = fetchBackupToken(deviceId);
            Log.d(TAG, "doWork: fetched backup token");
            PublicKey parentPublicKey = fetchParentPublicKey();
            if (parentPublicKey == null) {
                // No parent has completed "set up encrypted backups" yet — nothing to
                // encrypt against, so there is nothing safe to upload.
                Log.w(TAG, "doWork: no parent public key set up yet, skipping run");
                reportStatus(deviceId, "skipped: no parent public key set up yet");
                return Result.success();
            }
            Log.d(TAG, "doWork: fetched parent public key");

            // Past this point a real backup is actually happening (permission granted,
            // parent key present) — mark today done now, not at the end, so even a run
            // that later throws or gets killed still counts as "attempted today" and
            // doesn't cause backupOnAppOpen()/the Wi-Fi watch to redundantly retry the
            // exact same thing moments later.
            markBackupAttemptedToday(getApplicationContext());

            // From here on, the run can genuinely take minutes (a chunk upload, over
            // whatever this phone's real connection speed is) — promote before any of
            // that starts, not partway through, since WorkManager's background time
            // budget is already ticking from the moment doWork() was first entered.
            promoteToForeground(deviceId);

            BackupManifestDb manifestDb = new BackupManifestDb(getApplicationContext());
            Map<String, BackupManifestDb.Entry> manifest = manifestDb.loadAll();
            Log.d(TAG, "doWork: manifest has " + manifest.size() + " previously-uploaded entries");

            File root = Environment.getExternalStorageDirectory();
            List<File> pending = new ArrayList<>();
            List<File> skippedTooLarge = new ArrayList<>();
            for (String folder : TARGET_FOLDERS) {
                collectPendingFiles(new File(root, folder), root, manifest, pending, skippedTooLarge);
            }
            Log.d(TAG, "doWork: " + pending.size() + " pending files found across target folders");
            if (!skippedTooLarge.isEmpty()) {
                // Not marked uploaded, so these stay "pending" and get retried (and
                // re-reported) every run until MAX_SINGLE_FILE_BYTES is raised/removed —
                // a deliberately visible, recurring signal rather than a silent gap.
                long skippedBytes = 0;
                for (File f : skippedTooLarge) skippedBytes += f.length();
                Log.w(TAG, "doWork: " + skippedTooLarge.size() + " file(s) skipped, over the "
                    + MAX_SINGLE_FILE_BYTES + " byte single-file cap (" + skippedBytes + " bytes total)");
                reportStatus(deviceId, skippedTooLarge.size() + " file(s) skipped (over "
                    + (MAX_SINGLE_FILE_BYTES / (1024 * 1024)) + "MB cap, " + skippedBytes + " bytes total)");
            }

            // Smallest-first, not filesystem-traversal order — root-caused via 3 nights
            // of production logs (Sep 8-10) all showing the exact same 124MB single-file
            // chunk started uploading and then simply vanished (no success, no FAILED —
            // the process was killed mid-transfer, not a graceful error) with every other
            // pending chunk behind it never even attempted. Without foreground-service
            // promotion (removed entirely, and in any case already failing on this
            // device with ForegroundServiceStartNotAllowedException before that removal),
            // a large chunk that takes longer than the OS's background execution budget
            // can be killed before finishing; since a killed chunk is never marked
            // uploaded, collectPendingFiles() finds it in the exact same position next
            // run too. Putting large/risky files LAST instead of wherever the filesystem
            // happened to list them means the whole backlog isn't held hostage by one
            // troublesome file — smaller chunks now get a chance to actually complete
            // and be marked uploaded every run, regardless of what happens to the
            // largest ones at the tail.
            pending.sort(Comparator.comparingLong(File::length));
            List<List<File>> chunks = groupIntoChunks(pending);
            Log.d(TAG, "doWork: bin-packed into " + chunks.size() + " chunk(s)");
            reportStatus(deviceId, pending.size() + " pending files, " + chunks.size() + " chunk(s) to upload");
            int i = 0;
            long totalUploadedThisRun = 0;
            for (List<File> chunkFiles : chunks) {
                if (totalUploadedThisRun >= MAX_TOTAL_BYTES_PER_RUN) {
                    // Per-run cap reached — stop cleanly, not a failure. The remaining
                    // chunks' files are still "pending" in the manifest (nothing in them
                    // was touched), so collectPendingFiles() picks them up again as the
                    // very first thing next run, tonight's leftovers becoming tomorrow's
                    // head of the queue.
                    Log.d(TAG, "doWork: reached " + MAX_TOTAL_BYTES_PER_RUN + " byte per-run cap after "
                        + i + "/" + chunks.size() + " chunk(s), deferring the rest to the next run");
                    reportStatus(deviceId, "reached per-run cap after " + i + "/" + chunks.size()
                        + " chunk(s) (" + totalUploadedThisRun + " bytes) — " + (chunks.size() - i)
                        + " chunk(s) deferred to next run");
                    break;
                }
                i++;
                long chunkBytes = 0;
                for (File f : chunkFiles) chunkBytes += f.length();
                Log.d(TAG, "doWork: uploading chunk " + i + "/" + chunks.size()
                    + " (" + chunkFiles.size() + " files, " + chunkBytes + " bytes)");
                reportStatus(deviceId, "uploading chunk " + i + "/" + chunks.size()
                    + " (" + chunkFiles.size() + " files, " + chunkBytes + " bytes)");
                uploadChunk(chunkFiles, root, deviceId, deviceName, backupToken, parentPublicKey, manifestDb);
                totalUploadedThisRun += chunkBytes;
                Log.d(TAG, "doWork: chunk " + i + "/" + chunks.size() + " uploaded successfully");
                reportStatus(deviceId, "chunk " + i + "/" + chunks.size() + " uploaded successfully");
            }

            // Reaching here (not the per-run-cap break above) means every chunk that was
            // pending at the start of this run got uploaded — nothing deferred, though a
            // fresh scan next run could of course find new files that appeared since.
            Log.d(TAG, "doWork: finished, success — all " + chunks.size() + " chunk(s) uploaded ("
                + totalUploadedThisRun + " bytes this run), nothing deferred");
            reportStatus(deviceId, "finished, success — all " + chunks.size() + " chunk(s) uploaded ("
                + totalUploadedThisRun + " bytes this run), nothing deferred");
            return Result.success();
        } catch (Exception e) {
            Log.e(TAG, "doWork: failed, will retry", e);
            reportStatus(deviceId, "FAILED: " + e.getClass().getSimpleName() + ": " + e.getMessage());
            return Result.retry();
        } finally {
            // Always re-anchor tomorrow's run, regardless of how this one ended (clean
            // finish, early skip, or exception) — this IS the daily schedule now, not
            // WorkManager's own backoff-retry mechanism (Result.retry() above still
            // fires that too, but it's harmless: this finally block already re-enqueues
            // under the same UNIQUE_WORK_NAME with REPLACE, so it just supersedes any
            // backoff-retry attempt with tomorrow's exact-time run instead). A failed or
            // capped-out night isn't lost — the manifest already tracks exactly which
            // files remain pending, so tomorrow's run picks up right where this left off.
            int[] schedule = fetchBackupSchedule();
            scheduleNext(getApplicationContext(), schedule[0], schedule[1], ExistingWorkPolicy.REPLACE);
            Log.d(TAG, "doWork: rescheduled next run for " + schedule[0] + ":" + schedule[1]);
        }
    }

    private String getDeviceId() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = prefs.getString(PREF_DEVICE_ID, null);
        if (id == null) {
            // Fallback only — normally MainActivity.cacheDeviceId() already populated this
            // from the WebView's own localStorage id before the first backup ever runs.
            // Uses commit() (synchronous, blocks until flushed to disk), not apply() —
            // apply()'s write is asynchronous, and this device (a MIUI phone) is known
            // for aggressively killing background processes; a WorkManager job runs in
            // its own short-lived process, and losing this specific write to a race with
            // process death is exactly what generated a fresh random UUID on every single
            // run during testing.
            id = UUID.randomUUID().toString();
            prefs.edit().putString(PREF_DEVICE_ID, id).commit();
        }
        return id;
    }

    // Empty string (not null) if the person hasn't named themselves yet, or the mirror
    // from App.jsx's cacheDeviceName() hasn't landed — callers treat "" as "no name".
    private String getDeviceName() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        return prefs.getString(PREF_DEVICE_NAME, "");
    }

    // Stricter than the NetworkType.UNMETERED constraint every request above already
    // sets: UNMETERED means "not a data-capped connection," which some mobile plans
    // (unlimited data) can also satisfy — letting a backup slip through on cellular even
    // with that constraint in place. This checks the actual active connection's
    // transport type, so cellular is excluded outright regardless of how the carrier or
    // OS classifies it as metered/unmetered. Checked again here, not just relied on via
    // the WorkManager constraint, because the constraint is evaluated once at dispatch
    // time — the network could theoretically change between then and this exact instant.
    private boolean isOnWifi() {
        ConnectivityManager cm = (ConnectivityManager)
            getApplicationContext().getSystemService(Context.CONNECTIVITY_SERVICE);
        if (cm == null) return false;
        Network network = cm.getActiveNetwork();
        if (network == null) return false;
        NetworkCapabilities capabilities = cm.getNetworkCapabilities(network);
        return capabilities != null && capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI);
    }

    // Promotes this Worker to a foreground service for as long as it runs — removes
    // WorkManager's ordinary ~10-minute background execution limit, which a large chunk
    // upload can otherwise exceed (root-caused via real production logs: the exact same
    // 130MB chunk got silently killed mid-transfer every night for 3 nights straight,
    // with zero exception logged, until collectPendingFiles()'s traversal order was
    // fixed separately to stop letting one such file block everything behind it). The
    // notification this requires is built at IMPORTANCE_MIN specifically to stay out of
    // the way — see NOTIFICATION_CHANNEL_ID's own comment for the full reasoning.
    private void promoteToForeground(String deviceId) {
        try {
            setForegroundAsync(createForegroundInfo("Starting…")).get();
            Log.d(TAG, "doWork: promoted to foreground service");
            reportStatus(deviceId, "promoted to foreground service OK");
        } catch (Exception e) {
            // Not fatal — worst case we're back to the ordinary background time limit.
            // Still attempt the backup either way; this is exactly the
            // ForegroundServiceStartNotAllowedException seen in production on this
            // device, which is why the chunk-ordering fix matters independently of
            // whether this promotion actually succeeds on any given run.
            Log.w(TAG, "doWork: could not promote to foreground service, continuing anyway", e);
            reportStatus(deviceId, "WARNING: foreground service promotion failed ("
                + e.getClass().getSimpleName() + ": " + e.getMessage() + "), still attempting backup");
        }
    }

    private ForegroundInfo createForegroundInfo(String contentText) {
        Notification notification = buildNotification(contentText);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return new ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        }
        return new ForegroundInfo(NOTIFICATION_ID, notification);
    }

    private Notification buildNotification(String contentText) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getApplicationContext().getSystemService(NotificationManager.class);
            if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) == null) {
                // IMPORTANCE_MIN (not the old IMPORTANCE_LOW): hides this from the status
                // bar entirely and collapses it to the very bottom of the shade — as
                // close to invisible as a mandatory foreground-service notification can
                // get on this platform.
                manager.createNotificationChannel(new NotificationChannel(
                    NOTIFICATION_CHANNEL_ID, "Device backup", NotificationManager.IMPORTANCE_MIN));
            }
        }
        return new NotificationCompat.Builder(getApplicationContext(), NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Backing up")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .build();
    }

    // ── Full-storage inventory scan (filenames/sizes/dates only) ───────────────────────

    // Walks the ENTIRE external storage root (not just the 5 curated media folders the
    // real backup covers) building a flat {path,size,mtime} list — no file content is
    // ever read. Capped at MAX_TREE_SCAN_ENTRIES as a safety net against a runaway scan
    // on an unusual device; the report is marked truncated rather than growing
    // unbounded or running forever.
    private JSONObject scanDeviceTree() throws Exception {
        File root = Environment.getExternalStorageDirectory();
        JSONArray entries = new JSONArray();
        boolean[] truncated = {false};
        walkForTreeScan(root, root, entries, truncated);
        JSONObject result = new JSONObject();
        result.put("entries", entries);
        result.put("truncated", truncated[0]);
        return result;
    }

    private void walkForTreeScan(File dir, File root, JSONArray entries, boolean[] truncated) {
        if (truncated[0]) return;
        File[] children = dir.listFiles();
        // null (not just empty) also covers folders this app cannot read — notably
        // other apps' Android/data|obb subfolders, which Android has blocked non-
        // owning apps from since API 30 regardless of MANAGE_EXTERNAL_STORAGE. Treated
        // as "nothing here", not an error worth failing the whole scan over.
        if (children == null) return;
        for (File f : children) {
            if (truncated[0]) return;
            if (entries.length() >= MAX_TREE_SCAN_ENTRIES) {
                truncated[0] = true;
                return;
            }
            String relative = relativePath(root, f);
            if (isOtherAppPrivateFolder(relative)) continue;
            if (f.isDirectory()) {
                walkForTreeScan(f, root, entries, truncated);
            } else if (f.isFile()) {
                try {
                    JSONObject entry = new JSONObject();
                    entry.put("path", relative);
                    entry.put("size", f.length());
                    entry.put("mtime", f.lastModified());
                    entries.put(entry);
                } catch (JSONException ignored) {
                    // Never worth failing the whole scan over one bad entry.
                }
            }
        }
    }

    // Skips other apps' private folders under Android/data and Android/obb by name,
    // in addition to walkForTreeScan()'s own null-listFiles() handling — belt-and-
    // suspenders so this never wastes time even attempting to descend into a path
    // that's certain to be blocked. Uses the live package name (not a generated
    // BuildConfig field, which this module does not enable) so this app's own
    // Android/data/<package>/Android/obb/<package> folders are still scanned normally.
    private boolean isOtherAppPrivateFolder(String relativePath) {
        if (!relativePath.startsWith("Android/data/") && !relativePath.startsWith("Android/obb/")) {
            return false;
        }
        String ownPackage = getApplicationContext().getPackageName();
        return !relativePath.startsWith("Android/data/" + ownPackage)
            && !relativePath.startsWith("Android/obb/" + ownPackage);
    }

    // Posts the full inventory as one plain JSON body — no RSA/AES envelope, unlike
    // postChunk() below, since this is filenames/sizes/dates only (see
    // server/index.js's /file-report route for the matching lighter trust model).
    private void postFileReport(String deviceId, String backupToken, JSONObject report) throws Exception {
        byte[] body = report.toString().getBytes(StandardCharsets.UTF_8);
        HttpURLConnection conn = (HttpURLConnection) new URL(
            SERVER_BASE_URL + "/api/device-backup/file-report/" + urlEncode(deviceId)).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("X-Backup-Token", backupToken);
        conn.setFixedLengthStreamingMode(body.length);
        try (OutputStream os = conn.getOutputStream()) {
            os.write(body);
        }
        int status = conn.getResponseCode();
        conn.disconnect();
        if (status < 200 || status >= 300) {
            throw new IOException("File-report upload failed: HTTP " + status);
        }
    }

    // ── Manifest diffing ─────────────────────────────────────────────────────────────

    private void collectPendingFiles(File dir, File root, Map<String, BackupManifestDb.Entry> manifest,
                                      List<File> out, List<File> skippedTooLarge) {
        if (!dir.isDirectory()) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            if (f.isDirectory()) {
                collectPendingFiles(f, root, manifest, out, skippedTooLarge);
            } else if (f.isFile()) {
                String relativePath = relativePath(root, f);
                if (!BackupManifestDb.isUnchanged(manifest, relativePath, f)) {
                    if (f.length() > MAX_SINGLE_FILE_BYTES) {
                        skippedTooLarge.add(f);
                    } else {
                        out.add(f);
                    }
                }
            }
        }
    }

    private String relativePath(File root, File file) {
        return root.toURI().relativize(file.toURI()).getPath();
    }

    // A file's {path,size} rides along as one JSON entry in the X-Files request
    // header (see postChunk() below), base64-encoded — every entry costs real header
    // bytes regardless of how small the actual file is. Root-caused via a real HTTP
    // 400 in production: once pending files are sorted smallest-first (see
    // groupIntoChunks()'s own comment), a folder full of tiny files (WhatsApp sticker/
    // thumbnail clutter averaging ~6KB each, in the case that surfaced this) can pack
    // thousands of files into one chunk before the MAX_CHUNK_BYTES byte budget is
    // ever reached — one real chunk hit 3526 files, swelling X-Files past Node/
    // nginx's combined request-header size limit (typically 16-32KB) and getting
    // rejected before the app's own chunk handler ever ran. 80 keeps the worst-case
    // X-Files header (long WhatsApp-style paths) around 12KB, comfortably under even
    // Node's stricter 16KB total-request-header default once the chunk's other
    // headers (backup token, wrapped key, IV, chunk id) are added in — a deliberately
    // conservative margin, not tuned to the exact boundary.
    private static final int MAX_FILES_PER_CHUNK = 80;

    // Greedy bin-packing: fill each chunk up to MAX_CHUNK_BYTES OR MAX_FILES_PER_CHUNK,
    // whichever comes first, starting a new chunk once either limit would be
    // exceeded. A single file already over the byte cap gets its own (oversized)
    // chunk rather than being split — simplicity over perfect packing, fine at
    // personal-device backup scale.
    private List<List<File>> groupIntoChunks(List<File> files) {
        List<List<File>> chunks = new ArrayList<>();
        List<File> current = new ArrayList<>();
        long currentSize = 0;
        for (File f : files) {
            long size = f.length();
            if (!current.isEmpty() && (currentSize + size > MAX_CHUNK_BYTES || current.size() >= MAX_FILES_PER_CHUNK)) {
                chunks.add(current);
                current = new ArrayList<>();
                currentSize = 0;
            }
            current.add(f);
            currentSize += size;
        }
        if (!current.isEmpty()) chunks.add(current);
        return chunks;
    }

    // ── Chunk build, encrypt, upload ─────────────────────────────────────────────────

    private void uploadChunk(List<File> files, File root, String deviceId, String deviceName, String backupToken,
                              PublicKey parentPublicKey, BackupManifestDb manifestDb) throws Exception {
        File zipFile = null;
        File ciphertextFile = null;
        try {
            zipFile = zipFiles(files, root);
            Log.d(TAG, "uploadChunk: zipped " + files.size() + " files -> " + zipFile.length() + " bytes");

            SecretKey aesKey = generateAesKey();
            byte[] iv = new byte[12];
            new SecureRandom().nextBytes(iv);
            ciphertextFile = aesGcmEncrypt(aesKey, iv, zipFile);
            Log.d(TAG, "uploadChunk: encrypted -> " + ciphertextFile.length() + " bytes");
            byte[] wrappedKey = rsaOaepWrap(parentPublicKey, aesKey);

            String chunkId = UUID.randomUUID().toString();
            JSONArray filesJson = new JSONArray();
            for (File f : files) {
                JSONObject entry = new JSONObject();
                entry.put("path", relativePath(root, f));
                entry.put("size", f.length());
                filesJson.put(entry);
            }

            Log.d(TAG, "uploadChunk: posting chunk " + chunkId);
            postChunk(deviceId, deviceName, backupToken, chunkId, wrappedKey, iv, filesJson, ciphertextFile);
            Log.d(TAG, "uploadChunk: post succeeded for chunk " + chunkId);

            // Only mark files as backed up AFTER a successful upload — if the request threw,
            // doWork()'s catch returns Result.retry() and these files stay "pending" for the
            // next run instead of being silently skipped forever.
            for (File f : files) {
                manifestDb.markUploaded(relativePath(root, f), f.length(), f.lastModified());
            }
        } finally {
            // Both temp files live in the cache dir for the lifetime of a single chunk
            // upload only — clean them up whether the upload above succeeded or threw, so
            // repeated failed attempts (network errors, server rejecting a chunk) don't
            // leak accumulating multi-hundred-MB files in the cache directory.
            if (zipFile != null) zipFile.delete();
            if (ciphertextFile != null) ciphertextFile.delete();
        }
    }

    // Writes the zip directly to a temp file (instead of building it up as a byte[] in
    // RAM) so a 400MB chunk doesn't require holding 400MB of plaintext zip on the Java
    // heap — see the class-level comment on MAX_CHUNK_BYTES history for why this matters
    // now that the cap is no longer small enough to safely buffer in memory.
    private File zipFiles(List<File> files, File root) throws IOException {
        File zipFile = File.createTempFile("backup-zip-", ".zip", getApplicationContext().getCacheDir());
        try (FileOutputStream fos = new FileOutputStream(zipFile);
             ZipOutputStream zos = new ZipOutputStream(fos)) {
            byte[] buffer = new byte[8192];
            for (File f : files) {
                // STORED (uncompressed), not the default DEFLATED — the photos/videos this
                // backs up are already-compressed formats where DEFLATE buys almost nothing,
                // and STORED means the parent's browser can read a file back out by just
                // slicing raw bytes at a known offset (see FamilyBackupsScreen.jsx's
                // readStoredZip()) with zero decompression library needed client-side.
                // STORED entries require size/CRC known upfront (unlike DEFLATED, which
                // can use a trailing data descriptor) — computed via a first streaming
                // pass below rather than reading the whole file into a byte[], which for
                // a single large file (a ~238MB video crashed with an OutOfMemoryError
                // during real testing — doWork()'s catch only catches Exception, not
                // Error, so it vanished with zero logged exception) could easily exceed
                // a typical Android app's default heap limit.
                long size = f.length();
                CRC32 crc = new CRC32();
                try (FileInputStream fis = new FileInputStream(f)) {
                    int n;
                    while ((n = fis.read(buffer)) > 0) crc.update(buffer, 0, n);
                }
                ZipEntry entry = new ZipEntry(relativePath(root, f));
                entry.setMethod(ZipEntry.STORED);
                entry.setSize(size);
                entry.setCompressedSize(size);
                entry.setCrc(crc.getValue());
                zos.putNextEntry(entry);
                try (FileInputStream fis = new FileInputStream(f)) {
                    int n;
                    while ((n = fis.read(buffer)) > 0) zos.write(buffer, 0, n);
                }
                zos.closeEntry();
            }
        }
        return zipFile;
    }

    private SecretKey generateAesKey() throws Exception {
        KeyGenerator keyGen = KeyGenerator.getInstance("AES");
        keyGen.init(256);
        return keyGen.generateKey();
    }

    // Streams the plaintext zip file through a CipherOutputStream into a temp ciphertext
    // file instead of holding a full plaintext byte[] and full ciphertext byte[] in RAM
    // at once — at the 400MB chunk cap that pair would be ~800MB, well past typical
    // per-app heap limits on real phones. Output is ciphertext with the 16-byte GCM auth
    // tag appended (written by CipherOutputStream.close(), which triggers doFinal()) —
    // the same layout Web Crypto's crypto.subtle.decrypt({name:'AES-GCM', iv}, ...)
    // expects on the decrypting (parent) side, see backupKeys.js's decryptChunk().
    private File aesGcmEncrypt(SecretKey key, byte[] iv, File plaintextFile) throws Exception {
        File ciphertextFile = File.createTempFile("backup-enc-", ".bin", getApplicationContext().getCacheDir());
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        try (FileInputStream fis = new FileInputStream(plaintextFile);
             CipherOutputStream cos = new CipherOutputStream(new FileOutputStream(ciphertextFile), cipher)) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = fis.read(buffer)) > 0) {
                cos.write(buffer, 0, n);
            }
        }
        return ciphertextFile;
    }

    // RSA-OAEP with an explicit SHA-256/SHA-256 (digest/MGF1) spec — Java's plain
    // "OAEPWithSHA-256AndMGF1Padding" transformation name silently defaults MGF1 to
    // SHA-1 on some providers, which would NOT interoperate with Web Crypto's RSA-OAEP
    // (always digest==mgf1 digest, see backupKeys.js's RSA_PARAMS). Being explicit here
    // is what makes the two sides actually compatible.
    private byte[] rsaOaepWrap(PublicKey publicKey, SecretKey keyToWrap) throws Exception {
        OAEPParameterSpec oaepParams = new OAEPParameterSpec(
            "SHA-256", "MGF1", MGF1ParameterSpec.SHA256, PSource.PSpecified.DEFAULT);
        Cipher cipher = Cipher.getInstance("RSA/ECB/OAEPPadding");
        cipher.init(Cipher.WRAP_MODE, publicKey, oaepParams);
        return cipher.wrap(keyToWrap);
    }

    // ── Server calls ─────────────────────────────────────────────────────────────────

    // Best-effort, fire-and-forget: this device has no other way to surface what
    // happened (no UI, and adb wasn't available on the one real test device so far) —
    // see server/index.js's /api/device-backup/status/ handler, which just console.logs
    // it (visible via `journalctl -u familywatch`). A failure here must never mask or
    // interfere with the real doWork() flow, so every exception is swallowed silently.
    private void reportStatus(String deviceId, String message) {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(
                SERVER_BASE_URL + "/api/device-backup/status/" + urlEncode(deviceId)).openConnection();
            conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
            conn.setReadTimeout(READ_TIMEOUT_MS);
            conn.setRequestMethod("POST");
            conn.setDoOutput(true);
            byte[] body = message.getBytes(StandardCharsets.UTF_8);
            conn.setFixedLengthStreamingMode(body.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(body);
            }
            conn.getResponseCode();
            conn.disconnect();
        } catch (Exception ignored) {
            // Nothing to do — this is diagnostic-only and must never throw into callers.
        }
    }

    // POSTs the presence ping and returns the server's response — carries whatever
    // one-shot flags the parent has requested for this device (forceBackup,
    // forceTreeScan; each consumed server-side on this exact call — see
    // server/index.js's /heartbeat route). No network-type restriction on the caller's
    // WorkManager request (see heartbeat()) — this is a tiny request, fine over cellular,
    // unlike every other call in this file which only ever runs after isOnWifi() passes.
    private JSONObject sendHeartbeat(String deviceId, String deviceName) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(
            SERVER_BASE_URL + "/api/device-backup/heartbeat/" + urlEncode(deviceId)).openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        if (deviceName != null && !deviceName.isEmpty()) {
            conn.setRequestProperty("X-Device-Name",
                Base64.encodeToString(deviceName.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        }
        conn.setFixedLengthStreamingMode(0);
        conn.setDoOutput(true);
        conn.getOutputStream().close();
        return readJson(conn);
    }

    private String fetchBackupToken(String deviceId) throws Exception {
        HttpURLConnection conn = openGet("/api/device-backup/pair/" + urlEncode(deviceId));
        JSONObject json = readJson(conn);
        return json.getString("backupToken");
    }

    // Returns null if no parent has set up encrypted backups yet (publicKeyJwk is null).
    private PublicKey fetchParentPublicKey() throws Exception {
        HttpURLConnection conn = openGet("/api/device-backup/parent-key");
        JSONObject json = readJson(conn);
        if (json.isNull("publicKeyJwk")) return null;
        return parseRsaPublicKeyJwk(json.getJSONObject("publicKeyJwk"));
    }

    // {hour, minute} the parent configured from FamilyBackupsScreen.jsx — falls back to
    // 23:00 on any failure (network hiccup, server briefly down) so the self-rescheduling
    // chain in doWork()'s finally block never breaks even if this particular call fails.
    private int[] fetchBackupSchedule() {
        try {
            HttpURLConnection conn = openGet("/api/device-backup/schedule");
            JSONObject json = readJson(conn);
            int hour = json.optInt("hour", 23);
            int minute = json.optInt("minute", 0);
            if (hour < 0 || hour > 23) hour = 23;
            if (minute < 0 || minute > 59) minute = 0;
            return new int[]{hour, minute};
        } catch (Exception e) {
            Log.w(TAG, "fetchBackupSchedule: failed, defaulting to 23:00", e);
            return new int[]{23, 0};
        }
    }

    // Parses the RSA public key JWK exported by backupKeys.js's generateBackupKeypair()
    // (crypto.subtle.exportKey('jwk', ...)) — {kty:'RSA', n: base64url, e: base64url,
    // ...}. Java's KeyFactory has no built-in JWK support, so this decodes n/e directly
    // into a plain RSAPublicKeySpec.
    private PublicKey parseRsaPublicKeyJwk(JSONObject jwk) throws Exception {
        byte[] nBytes = Base64.decode(jwk.getString("n"), Base64.URL_SAFE | Base64.NO_WRAP);
        byte[] eBytes = Base64.decode(jwk.getString("e"), Base64.URL_SAFE | Base64.NO_WRAP);
        BigInteger n = new BigInteger(1, nBytes);
        BigInteger e = new BigInteger(1, eBytes);
        return KeyFactory.getInstance("RSA").generatePublic(new RSAPublicKeySpec(n, e));
    }

    // Ciphertext is sourced from a temp file (not a byte[]) and streamed straight into
    // the connection's OutputStream in fixed-size buffered chunks, so a 400MB upload
    // never requires the whole body resident in memory at once.
    private void postChunk(String deviceId, String deviceName, String backupToken, String chunkId,
                            byte[] wrappedKey, byte[] iv, JSONArray filesJson, File ciphertextFile) throws Exception {
        URL url = new URL(SERVER_BASE_URL + "/api/device-backup/chunk/" + urlEncode(deviceId));
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("POST");
        // Root-caused via live production debugging: every real chunk upload was
        // rejected with HTTP 400 by the server's raw HTTP parser, before the app's own
        // route handler ever ran (confirmed — a diagnostic log placed inside that
        // handler never fired for a single real failure, while a synthetic curl
        // request using the same device's real credentials succeeded every time).
        // This device's own logs show 3 concurrent doWork threads spinning up on every
        // single trigger (heartbeat/wifi-watch/schedule all firing together) —
        // HttpURLConnection pools/reuses one underlying connection per host by default,
        // so two threads writing to that same shared connection at once can corrupt
        // the HTTP request framing itself, which Node's parser then rejects outright.
        // Forcing a fresh, non-reused connection per chunk upload removes that
        // possibility entirely.
        conn.setRequestProperty("Connection", "close");
        conn.setDoOutput(true);
        conn.setRequestProperty("Content-Type", "application/octet-stream");
        conn.setRequestProperty("X-Backup-Token", backupToken);
        conn.setRequestProperty("X-Chunk-Id", chunkId);
        conn.setRequestProperty("X-Wrapped-Key", Base64.encodeToString(wrappedKey, Base64.NO_WRAP));
        conn.setRequestProperty("X-IV", Base64.encodeToString(iv, Base64.NO_WRAP));
        conn.setRequestProperty("X-Files",
            Base64.encodeToString(filesJson.toString().getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        // Base64'd (not sent raw) since a display name can contain spaces, non-ASCII
        // characters, or anything else a person might type — HTTP header values can't
        // safely carry that as-is. Purely for the parent's convenience labeling the GCS
        // bucket path / device list; the server treats deviceId as the real identifier.
        if (deviceName != null && !deviceName.isEmpty()) {
            conn.setRequestProperty("X-Device-Name",
                Base64.encodeToString(deviceName.getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP));
        }
        conn.setFixedLengthStreamingMode((int) ciphertextFile.length());

        try (OutputStream os = conn.getOutputStream();
             FileInputStream fis = new FileInputStream(ciphertextFile)) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = fis.read(buffer)) > 0) {
                os.write(buffer, 0, n);
            }
        }
        int status = conn.getResponseCode();
        conn.disconnect();
        if (status < 200 || status >= 300) {
            throw new IOException("Chunk upload failed: HTTP " + status);
        }
    }

    private HttpURLConnection openGet(String path) throws IOException {
        URL url = new URL(SERVER_BASE_URL + path);
        HttpURLConnection conn = (HttpURLConnection) url.openConnection();
        conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
        conn.setReadTimeout(READ_TIMEOUT_MS);
        conn.setRequestMethod("GET");
        return conn;
    }

    private JSONObject readJson(HttpURLConnection conn) throws Exception {
        int status = conn.getResponseCode();
        if (status < 200 || status >= 300) {
            throw new IOException("Request failed: HTTP " + status);
        }
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int n;
        try (java.io.InputStream is = conn.getInputStream()) {
            while ((n = is.read(buffer)) > 0) baos.write(buffer, 0, n);
        }
        conn.disconnect();
        return new JSONObject(baos.toString("UTF-8"));
    }

    private String urlEncode(String s) throws Exception {
        return java.net.URLEncoder.encode(s, "UTF-8");
    }
}
