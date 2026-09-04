package com.familywatch.app;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import java.io.File;
import java.util.HashMap;
import java.util.Map;

// Tracks which files under the backup target folders (see DeviceBackupWorker) have
// already been uploaded, keyed by their path relative to external storage, so each
// daily run only chunks/encrypts/uploads what's new or changed since the last
// successful run — not the whole folder tree again. A file counts as "changed" if
// either its size or last-modified time differs from what's recorded here; either one
// changing is enough to treat it as new, since a legitimate edit could change one
// without the other in unusual cases (e.g. touch-only or in-place same-size overwrite).
class BackupManifestDb extends SQLiteOpenHelper {
    private static final String DB_NAME = "device_backup_manifest.db";
    private static final int DB_VERSION = 1;

    static class Entry {
        final long size;
        final long lastModified;
        Entry(long size, long lastModified) {
            this.size = size;
            this.lastModified = lastModified;
        }
    }

    BackupManifestDb(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL(
            "CREATE TABLE manifest (" +
                "relative_path TEXT PRIMARY KEY, " +
                "size INTEGER NOT NULL, " +
                "last_modified INTEGER NOT NULL, " +
                "uploaded_at INTEGER NOT NULL)"
        );
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        db.execSQL("DROP TABLE IF EXISTS manifest");
        onCreate(db);
    }

    // Loads every already-backed-up file's (size, lastModified) in one pass, so the
    // Worker can diff the whole target-folder walk against it in memory rather than
    // querying per-file.
    Map<String, Entry> loadAll() {
        Map<String, Entry> map = new HashMap<>();
        try (SQLiteDatabase db = getReadableDatabase();
             Cursor c = db.query("manifest", new String[]{"relative_path", "size", "last_modified"},
                 null, null, null, null, null)) {
            while (c.moveToNext()) {
                map.put(c.getString(0), new Entry(c.getLong(1), c.getLong(2)));
            }
        }
        return map;
    }

    // True if this file's current (size, lastModified) already matches the manifest —
    // i.e. it was already uploaded and hasn't changed since.
    static boolean isUnchanged(Map<String, Entry> manifest, String relativePath, File file) {
        Entry existing = manifest.get(relativePath);
        if (existing == null) return false;
        return existing.size == file.length() && existing.lastModified == file.lastModified();
    }

    void markUploaded(String relativePath, long size, long lastModified) {
        try (SQLiteDatabase db = getWritableDatabase()) {
            ContentValues values = new ContentValues();
            values.put("relative_path", relativePath);
            values.put("size", size);
            values.put("last_modified", lastModified);
            values.put("uploaded_at", System.currentTimeMillis());
            db.insertWithOnConflict("manifest", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        }
    }
}
