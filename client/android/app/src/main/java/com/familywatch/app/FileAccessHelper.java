package com.familywatch.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.webkit.MimeTypeMap;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.util.Arrays;

// Shared safe file-access logic, extracted from KeepAliveService so both it (legacy
// WebSocket-triggered ls/read_file — still present, but no longer invoked by the server,
// see server/index.js's quick_pull_ls/quick_pull_read_file) and the new stateless
// FamilyWatchMessagingService quick-pull handlers use the exact same tested
// path-safety and image-compression logic instead of duplicating it.
public class FileAccessHelper {

    public static class CompressedImage {
        public final byte[] data;
        public final String mimeType;
        CompressedImage(byte[] data, String mimeType) { this.data = data; this.mimeType = mimeType; }
    }

    // Rejects any path whose canonical form falls outside the intended root — e.g. a
    // crafted `path` array containing ".." segments that would otherwise let the remote
    // file browser escape external storage.
    public static File resolvePath(JSONArray pathArr) throws Exception {
        File root = Environment.getExternalStorageDirectory();
        File f = root;
        if (pathArr != null) {
            for (int i = 0; i < pathArr.length(); i++) f = new File(f, pathArr.getString(i));
        }
        String rootCanonical = root.getCanonicalPath();
        String candidateCanonical = f.getCanonicalPath();
        if (!candidateCanonical.equals(rootCanonical)
            && !candidateCanonical.startsWith(rootCanonical + File.separator)) {
            throw new SecurityException("Path escapes root directory");
        }
        return new File(candidateCanonical);
    }

    public static String getMimeType(String name) {
        String ext = MimeTypeMap.getFileExtensionFromUrl(Uri.fromFile(new File(name)).toString());
        if (ext == null || ext.isEmpty()) return "application/octet-stream";
        String mime = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.toLowerCase());
        return mime != null ? mime : "application/octet-stream";
    }

    public static JSONArray listDirectory(File dir) throws Exception {
        JSONArray entries = new JSONArray();
        File[] files = dir.listFiles();
        if (files != null) {
            Arrays.sort(files, (a, b) -> {
                if (a.isDirectory() != b.isDirectory()) return a.isDirectory() ? -1 : 1;
                return a.getName().compareToIgnoreCase(b.getName());
            });
            for (File f : files) {
                JSONObject entry = new JSONObject();
                entry.put("name", f.getName());
                entry.put("kind", f.isDirectory() ? "directory" : "file");
                if (f.isFile()) {
                    entry.put("size", f.length());
                    entry.put("mimeType", getMimeType(f.getName()));
                }
                entries.put(entry);
            }
        }
        return entries;
    }

    // Recompresses an image to WebP for a smaller upload — same quality/size rules the
    // file-transfer path has always used. Returns null (caller should upload the
    // original file as-is) if it's not a compressible image, or if compression fails
    // for any reason.
    public static CompressedImage compressImageIfPossible(File file, String mimeType, boolean isPreview) {
        if (!mimeType.startsWith("image/") || mimeType.equals("image/gif")) return null;
        try {
            int maxPx   = isPreview ? 800  : 1920;
            int quality = isPreview ? 70   : 82;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
            int maxDim = Math.max(opts.outWidth, opts.outHeight);
            opts.inJustDecodeBounds = false;
            opts.inSampleSize = 1;
            // Keep doubling until decoded size fits within maxPx
            while (maxDim / opts.inSampleSize > maxPx) opts.inSampleSize *= 2;
            Bitmap bmp = BitmapFactory.decodeFile(file.getAbsolutePath(), opts);
            if (bmp == null) return null;
            // Scale down precisely if still over maxPx (inSampleSize is power-of-2 only)
            int w = bmp.getWidth(), h = bmp.getHeight();
            int longest = Math.max(w, h);
            if (longest > maxPx) {
                float s = (float) maxPx / longest;
                bmp = Bitmap.createScaledBitmap(bmp, Math.round(w * s), Math.round(h * s), true);
            }
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            // WebP lossy: API 30+ uses WEBP_LOSSY, older uses WEBP (lossy when quality<100)
            Bitmap.CompressFormat fmt = (Build.VERSION.SDK_INT >= 30)
                ? Bitmap.CompressFormat.WEBP_LOSSY
                : Bitmap.CompressFormat.WEBP;
            bmp.compress(fmt, quality, baos);
            bmp.recycle();
            return new CompressedImage(baos.toByteArray(), "image/webp");
        } catch (Exception e) {
            return null;
        }
    }
}
