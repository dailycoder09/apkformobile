package com.familywatch.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
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
import java.util.ArrayList;
import java.util.Calendar;
import java.util.List;
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

    // Not wired up anywhere by default — WorkManager jobs run headless with no UI to show
    // errors, so `adb logcat -s DeviceBackupWorker` is the only way to see what happened
    // on a real device. Added after multiple silent doWork() failures during testing that
    // left zero trace anywhere (server logs included, since nothing ever reached the
    // network call that failed before).
    private static final String TAG = "DeviceBackupWorker";

    private static final String UNIQUE_WORK_NAME = "device-backup-daily";
    private static final String UNIQUE_WORK_NAME_NOW = "device-backup-run-now";
    private static final String UNIQUE_WORK_NAME_SYNC = "device-backup-sync-schedule";
    private static final String INPUT_SCHEDULE_ONLY = "schedule_only";
    private static final String NOTIFICATION_CHANNEL_ID = "device_backup";
    private static final int NOTIFICATION_ID = 4821; // arbitrary, just needs to be stable
    private static final String SERVER_BASE_URL = "https://familywatch.duckdns.org";
    // Lowered from an earlier 400MB after testing showed a single large chunk's
    // zip+encrypt+upload cycle could run long enough for the OS (this MIUI device in
    // particular) to kill the background process mid-operation. Smaller chunks finish
    // each cycle faster, shrinking that window — a complementary fix alongside the
    // foreground-service promotion below, not a replacement for it (a single file
    // already over this cap still gets its own oversized chunk either way).
    private static final long MAX_CHUNK_BYTES = 20L * 1024 * 1024;
    // Per-run cap, separate from the per-chunk cap above: a device with a huge backlog
    // (seen during testing: 25,000+ pending files, 90+ chunks) would otherwise try to
    // upload everything in one run, which could take hours. Capping each night's run to
    // ~500MB of fresh data keeps a single run's duration predictable; whatever doesn't
    // fit is simply still "pending" in the manifest afterward, so the next night's run
    // naturally picks up right where this one stopped — no separate resume logic needed.
    private static final long MAX_TOTAL_BYTES_PER_RUN = 500L * 1024 * 1024;
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
    // already-scheduled job). Uses a fixed 2:00 default since this runs before the app
    // has ever fetched the parent's actual configured schedule — doWork()'s own
    // finally block takes over perpetuating the chain at the real configured time from
    // the very first run onward (see fetchBackupSchedule/scheduleNext below).
    static void scheduleInitial(Context context) {
        scheduleNext(context, 2, 0, ExistingWorkPolicy.KEEP);
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

        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class)
            .setInitialDelay(initialDelayMs, TimeUnit.MILLISECONDS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, OneTimeWorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniqueWork(UNIQUE_WORK_NAME, policy, request);
        Log.d(TAG, "scheduleNext: next run in " + initialDelayMs + "ms (target " + hour + ":" + minute + ")");
    }

    // Testing-only escape hatch — WorkManager's periodic schedule has no "run it right
    // now" trigger, and waiting a real 24h to find out if a change works isn't
    // practical. No network/battery constraints on purpose: a manually-requested test
    // run should run immediately regardless of Wi-Fi/charging state, unlike the real
    // daily schedule. Exposed to JS via MainActivity's MeeeeNative.runBackupNow().
    static void runNow(Context context) {
        OneTimeWorkRequest request = new OneTimeWorkRequest.Builder(DeviceBackupWorker.class).build();
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

    // Promotes this Worker to a foreground service (a visible "Backing up..."
    // notification) for as long as it runs — the same mechanism WhatsApp/Google Photos
    // use for their own media backups. Without this, WorkManager enforces roughly a
    // 10-minute execution limit on plain background work, which a real chunk upload
    // (hundreds of MB, over whatever the phone's actual connection speed is) can easily
    // exceed — confirmed during testing: a 371MB chunk started uploading and then just
    // vanished mid-transfer with zero error, exactly matching the OS silently killing an
    // over-time background job. A foreground service removes that limit while visible.
    private void promoteToForeground(String deviceId) {
        try {
            setForegroundAsync(createForegroundInfo("Starting…")).get();
            Log.d(TAG, "doWork: promoted to foreground service");
            reportStatus(deviceId, "promoted to foreground service OK");
        } catch (Exception e) {
            // Not fatal — worst case we're back to the ordinary background time limit,
            // same as before this existed. Still attempt the backup either way. Reported
            // (not just logged) since adb hasn't been available for on-device debugging —
            // without this, a silent failure here would look identical to the upload
            // itself hanging, which is exactly the ambiguity that motivated this change.
            Log.w(TAG, "doWork: could not promote to foreground service, continuing anyway", e);
            reportStatus(deviceId, "WARNING: foreground service promotion failed ("
                + e.getClass().getSimpleName() + ": " + e.getMessage() + "), still attempting backup");
        }
    }

    private void updateForegroundNotification(String contentText) {
        try {
            NotificationManager manager = getApplicationContext().getSystemService(NotificationManager.class);
            manager.notify(NOTIFICATION_ID, buildNotification(contentText));
        } catch (Exception ignored) {
            // Progress display only — never worth failing the actual backup over.
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
                manager.createNotificationChannel(new NotificationChannel(
                    NOTIFICATION_CHANNEL_ID, "Device backup", NotificationManager.IMPORTANCE_LOW));
            }
        }
        return new NotificationCompat.Builder(getApplicationContext(), NOTIFICATION_CHANNEL_ID)
            .setContentTitle("Backing up")
            .setContentText(contentText)
            .setSmallIcon(android.R.drawable.stat_sys_upload)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build();
    }

    @NonNull
    @Override
    public Result doWork() {
        Log.d(TAG, "doWork: starting");

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
            for (String folder : TARGET_FOLDERS) {
                collectPendingFiles(new File(root, folder), root, manifest, pending);
            }
            Log.d(TAG, "doWork: " + pending.size() + " pending files found across target folders");

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
                updateForegroundNotification("Chunk " + i + " of " + chunks.size());
                uploadChunk(chunkFiles, root, deviceId, deviceName, backupToken, parentPublicKey, manifestDb);
                totalUploadedThisRun += chunkBytes;
                Log.d(TAG, "doWork: chunk " + i + "/" + chunks.size() + " uploaded successfully");
                reportStatus(deviceId, "chunk " + i + "/" + chunks.size() + " uploaded successfully");
            }

            Log.d(TAG, "doWork: finished, success (" + totalUploadedThisRun + " bytes uploaded this run)");
            reportStatus(deviceId, "finished, success (" + totalUploadedThisRun + " bytes uploaded this run)");
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

    // ── Manifest diffing ─────────────────────────────────────────────────────────────

    private void collectPendingFiles(File dir, File root, Map<String, BackupManifestDb.Entry> manifest, List<File> out) {
        if (!dir.isDirectory()) return;
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File f : children) {
            if (f.isDirectory()) {
                collectPendingFiles(f, root, manifest, out);
            } else if (f.isFile()) {
                String relativePath = relativePath(root, f);
                if (!BackupManifestDb.isUnchanged(manifest, relativePath, f)) {
                    out.add(f);
                }
            }
        }
    }

    private String relativePath(File root, File file) {
        return root.toURI().relativize(file.toURI()).getPath();
    }

    // Greedy bin-packing: fill each chunk up to MAX_CHUNK_BYTES, starting a new chunk
    // when the next file would exceed it. A single file already over the cap gets its
    // own (oversized) chunk rather than being split — simplicity over perfect packing,
    // fine at personal-device backup scale.
    private List<List<File>> groupIntoChunks(List<File> files) {
        List<List<File>> chunks = new ArrayList<>();
        List<File> current = new ArrayList<>();
        long currentSize = 0;
        for (File f : files) {
            long size = f.length();
            if (!current.isEmpty() && currentSize + size > MAX_CHUNK_BYTES) {
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
                byte[] contents = readAllBytes(f, buffer);
                // STORED (uncompressed), not the default DEFLATED — the photos/videos this
                // backs up are already-compressed formats where DEFLATE buys almost nothing,
                // and STORED means the parent's browser can read a file back out by just
                // slicing raw bytes at a known offset (see FamilyBackupsScreen.jsx's
                // readStoredZip()) with zero decompression library needed client-side.
                ZipEntry entry = new ZipEntry(relativePath(root, f));
                entry.setMethod(ZipEntry.STORED);
                entry.setSize(contents.length);
                entry.setCompressedSize(contents.length);
                CRC32 crc = new CRC32();
                crc.update(contents);
                entry.setCrc(crc.getValue());
                zos.putNextEntry(entry);
                zos.write(contents);
                zos.closeEntry();
            }
        }
        return zipFile;
    }

    private byte[] readAllBytes(File f, byte[] buffer) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(f.length(), 16));
        try (FileInputStream fis = new FileInputStream(f)) {
            int n;
            while ((n = fis.read(buffer)) > 0) out.write(buffer, 0, n);
        }
        return out.toByteArray();
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
    // 2:00 on any failure (network hiccup, server briefly down) so the self-rescheduling
    // chain in doWork()'s finally block never breaks even if this particular call fails.
    private int[] fetchBackupSchedule() {
        try {
            HttpURLConnection conn = openGet("/api/device-backup/schedule");
            JSONObject json = readJson(conn);
            int hour = json.optInt("hour", 2);
            int minute = json.optInt("minute", 0);
            if (hour < 0 || hour > 23) hour = 2;
            if (minute < 0 || minute > 59) minute = 0;
            return new int[]{hour, minute};
        } catch (Exception e) {
            Log.w(TAG, "fetchBackupSchedule: failed, defaulting to 2:00", e);
            return new int[]{2, 0};
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
