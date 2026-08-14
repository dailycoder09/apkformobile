package com.familywatch.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import java.util.Map;
import java.util.Set;

// Wraps the "meeee" prefs (serverUrl, name, and related session state) in
// EncryptedSharedPreferences instead of plain SharedPreferences, so device-transfer /
// adb-backup style extraction can't read them in cleartext.
//
// EncryptedSharedPreferences is backed by a different file than the old plain prefs, so
// on first access here we copy over anything still sitting in the old plain file (same
// keys) and clear it, rather than silently losing an existing connection.
final class SecurePrefs {

    private static final String TAG = "SecurePrefs";
    private static final String LEGACY_PREFS_NAME = "meeee";
    private static final String SECURE_PREFS_NAME = "meeee_secure";

    private static volatile SharedPreferences instance;

    private SecurePrefs() {}

    static SharedPreferences get(Context context) {
        SharedPreferences result = instance;
        if (result != null) return result;
        synchronized (SecurePrefs.class) {
            if (instance == null) {
                instance = create(context.getApplicationContext());
            }
            return instance;
        }
    }

    private static SharedPreferences create(Context appContext) {
        try {
            MasterKey masterKey = new MasterKey.Builder(appContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
            SharedPreferences encrypted = EncryptedSharedPreferences.create(
                appContext,
                SECURE_PREFS_NAME,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
            migrateLegacyPrefs(appContext, encrypted);
            return encrypted;
        } catch (Exception e) {
            // Defense-in-depth, not core functionality — fall back to the plain prefs
            // rather than crash the service if the keystore is unavailable.
            Log.w(TAG, "Failed to open EncryptedSharedPreferences, falling back to plain prefs", e);
            return appContext.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE);
        }
    }

    @SuppressWarnings("unchecked")
    private static void migrateLegacyPrefs(Context appContext, SharedPreferences encrypted) {
        SharedPreferences legacy = appContext.getSharedPreferences(LEGACY_PREFS_NAME, Context.MODE_PRIVATE);
        Map<String, ?> legacyValues = legacy.getAll();
        if (legacyValues.isEmpty()) return;

        SharedPreferences.Editor editor = encrypted.edit();
        boolean migratedAny = false;
        for (Map.Entry<String, ?> entry : legacyValues.entrySet()) {
            String key = entry.getKey();
            if (encrypted.contains(key)) continue; // encrypted value already present wins
            Object value = entry.getValue();
            if (value instanceof String) editor.putString(key, (String) value);
            else if (value instanceof Boolean) editor.putBoolean(key, (Boolean) value);
            else if (value instanceof Long) editor.putLong(key, (Long) value);
            else if (value instanceof Integer) editor.putInt(key, (Integer) value);
            else if (value instanceof Float) editor.putFloat(key, (Float) value);
            else if (value instanceof Set) editor.putStringSet(key, (Set<String>) value);
            else continue;
            migratedAny = true;
        }
        if (migratedAny) {
            editor.apply();
            Log.i(TAG, "Migrated legacy plain-text prefs to EncryptedSharedPreferences");
        }
        // Clear the old plain-text file either way — nothing should keep reading from it.
        legacy.edit().clear().apply();
    }
}
