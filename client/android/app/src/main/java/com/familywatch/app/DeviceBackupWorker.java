package com.familywatch.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Environment;
import android.util.Base64;
import androidx.annotation.NonNull;
import androidx.work.BackoffPolicy;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.OneTimeWorkRequest;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
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
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.zip.CRC32;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.OAEPParameterSpec;
import javax.crypto.spec.PSource;
import org.json.JSONArray;
import org.json.JSONObject;

// Daily background job (see scheduleDaily/onCreate in MainActivity) that backs up new/
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

    private static final String UNIQUE_WORK_NAME = "device-backup-daily";
    private static final String UNIQUE_WORK_NAME_NOW = "device-backup-run-now";
    private static final String SERVER_BASE_URL = "https://familywatch.duckdns.org";
    private static final long MAX_CHUNK_BYTES = 15L * 1024 * 1024;
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

    // Called once from MainActivity.onCreate() — enqueueUniquePeriodicWork with KEEP
    // means later app launches don't reset/duplicate an already-scheduled job.
    static void scheduleDaily(Context context) {
        Constraints constraints = new Constraints.Builder()
            .setRequiredNetworkType(NetworkType.UNMETERED)
            .setRequiresBatteryNotLow(true)
            .build();
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                DeviceBackupWorker.class, 24, TimeUnit.HOURS)
            .setConstraints(constraints)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, PeriodicWorkRequest.MIN_BACKOFF_MILLIS, TimeUnit.MILLISECONDS)
            .build();
        WorkManager.getInstance(context)
            .enqueueUniquePeriodicWork(UNIQUE_WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, request);
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

    @NonNull
    @Override
    public Result doWork() {
        try {
            if (!Environment.isExternalStorageManager()) {
                // Permission not granted yet — nothing readable. Not worth aggressive
                // retry; WorkManager tries again next period regardless.
                return Result.success();
            }

            String deviceId = getDeviceId();
            String backupToken = fetchBackupToken(deviceId);
            PublicKey parentPublicKey = fetchParentPublicKey();
            if (parentPublicKey == null) {
                // No parent has completed "set up encrypted backups" yet — nothing to
                // encrypt against, so there is nothing safe to upload.
                return Result.success();
            }

            BackupManifestDb manifestDb = new BackupManifestDb(getApplicationContext());
            Map<String, BackupManifestDb.Entry> manifest = manifestDb.loadAll();

            File root = Environment.getExternalStorageDirectory();
            List<File> pending = new ArrayList<>();
            for (String folder : TARGET_FOLDERS) {
                collectPendingFiles(new File(root, folder), root, manifest, pending);
            }

            for (List<File> chunkFiles : groupIntoChunks(pending)) {
                uploadChunk(chunkFiles, root, deviceId, backupToken, parentPublicKey, manifestDb);
            }

            return Result.success();
        } catch (Exception e) {
            return Result.retry();
        }
    }

    private String getDeviceId() {
        SharedPreferences prefs = getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String id = prefs.getString(PREF_DEVICE_ID, null);
        if (id == null) {
            // Fallback only — normally MainActivity.cacheDeviceId() already populated this
            // from the WebView's own localStorage id before the first backup ever runs.
            id = UUID.randomUUID().toString();
            prefs.edit().putString(PREF_DEVICE_ID, id).apply();
        }
        return id;
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

    private void uploadChunk(List<File> files, File root, String deviceId, String backupToken,
                              PublicKey parentPublicKey, BackupManifestDb manifestDb) throws Exception {
        byte[] zipBytes = zipFiles(files, root);

        SecretKey aesKey = generateAesKey();
        byte[] iv = new byte[12];
        new SecureRandom().nextBytes(iv);
        byte[] ciphertext = aesGcmEncrypt(aesKey, iv, zipBytes);
        byte[] wrappedKey = rsaOaepWrap(parentPublicKey, aesKey);

        String chunkId = UUID.randomUUID().toString();
        JSONArray filesJson = new JSONArray();
        for (File f : files) {
            JSONObject entry = new JSONObject();
            entry.put("path", relativePath(root, f));
            entry.put("size", f.length());
            filesJson.put(entry);
        }

        postChunk(deviceId, backupToken, chunkId, wrappedKey, iv, filesJson, ciphertext);

        // Only mark files as backed up AFTER a successful upload — if the request threw,
        // doWork()'s catch returns Result.retry() and these files stay "pending" for the
        // next run instead of being silently skipped forever.
        for (File f : files) {
            manifestDb.markUploaded(relativePath(root, f), f.length(), f.lastModified());
        }
    }

    private byte[] zipFiles(List<File> files, File root) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (ZipOutputStream zos = new ZipOutputStream(baos)) {
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
        return baos.toByteArray();
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

    // Output is ciphertext with the 16-byte GCM auth tag appended — the same layout
    // Web Crypto's crypto.subtle.decrypt({name:'AES-GCM', iv}, ...) expects on the
    // decrypting (parent) side, see backupKeys.js's decryptChunk().
    private byte[] aesGcmEncrypt(SecretKey key, byte[] iv, byte[] plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key, new GCMParameterSpec(128, iv));
        return cipher.doFinal(plaintext);
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

    private void postChunk(String deviceId, String backupToken, String chunkId, byte[] wrappedKey,
                            byte[] iv, JSONArray filesJson, byte[] ciphertext) throws Exception {
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
        conn.setFixedLengthStreamingMode(ciphertext.length);

        try (OutputStream os = conn.getOutputStream()) {
            os.write(ciphertext);
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
