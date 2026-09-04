// ── Local backup: survives uninstall (native) + manual export/import ───────
//
// This app has no server-side copy of user data (fully-offline, single-user
// personal app). The only protection against data loss on an app uninstall
// or device reset is a backup file written OUTSIDE the app's private data
// directory (which Android/iOS wipe on uninstall).
//
//   - Native (Capacitor/Android): writes/reads a JSON file in the shared
//     Documents directory (`Directory.Documents`), which is NOT deleted
//     when the app is uninstalled. `scheduleAutoBackup()` keeps this file
//     fresh after every mutation, debounced.
//   - Browser/PWA: there is no persistent location a web page can write to
//     that survives anything (let alone an "uninstall"), so the browser
//     path is manual-only: `exportBackup()` triggers a normal file download,
//     and `importBackup()` accepts a `File` from an `<input type="file">`.
//
// Callers own all UI (settings screen "Export backup" button, first-launch
// "Restore from backup?" prompt, etc.) — this module only implements the
// mechanics.

import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { getAllTablesForBackup, restoreAllTables, getDeviceId } from './localData.js'

const IS_NATIVE = Capacitor.isNativePlatform()

const BACKUP_FILENAME = 'meeee-backup.json'
const BACKUP_VERSION = 1
const AUTO_BACKUP_DEBOUNCE_MS = 5000

// ── Permissions (native only) ───────────────────────────────────────────────
// The @capacitor/filesystem type definitions state permission checks are
// "Required on Android, only when using `Directory.Documents` or
// `Directory.ExternalStorage`" — so Documents is treated the same as the
// ExternalStorage flow already used elsewhere in this codebase (see
// UserPanel.jsx's checkPermissions/requestPermissions dance). On Android 11+
// scoped storage, writing to the app's own subfolder under Documents
// typically doesn't actually prompt the user, but we still go through the
// official check/request calls so behavior is correct on the OS versions
// where it does matter (Android 10 and older, or if the OS ever changes
// this). If checkPermissions itself throws (e.g. some odd device/webview
// combination), we don't block the backup on that — we optimistically
// attempt the write, since failing to back up silently is worse than a
// spurious permission dialog.
async function ensureNativeStoragePermission() {
  try {
    const status = await Filesystem.checkPermissions()
    if (status.publicStorage === 'granted') return true
    const requested = await Filesystem.requestPermissions()
    return requested.publicStorage === 'granted'
  } catch (e) {
    console.warn('[backup] permission check failed, attempting write anyway', e)
    return true
  }
}

// ── Shape validation ────────────────────────────────────────────────────────
// A corrupted/malformed backup must never be partially applied. Throw a
// clear, user-facing error instead.
function validateBackupPayload(parsed) {
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('This file is not a valid backup (not a JSON object).')
  }
  if (typeof parsed.version !== 'number') {
    throw new Error('This file is not a valid backup (missing version).')
  }
  if (!parsed.tables || typeof parsed.tables !== 'object' || Array.isArray(parsed.tables)) {
    throw new Error('This file is not a valid backup (missing table data).')
  }
  return parsed
}

// ── Export ───────────────────────────────────────────────────────────────────
/**
 * Builds a full backup of all local data and persists it:
 *   - native: to the shared Documents directory (survives app uninstall)
 *   - browser: as a user-initiated file download (manual export only)
 *
 * @returns {Promise<{success: boolean, method: 'native'|'browser', exportedAt?: number, uri?: string, error?: string}>}
 */
export async function exportBackup() {
  let json
  let exportedAt
  try {
    const [tables, deviceId] = await Promise.all([getAllTablesForBackup(), getDeviceId()])
    exportedAt = Date.now()
    json = JSON.stringify({ version: BACKUP_VERSION, exportedAt, deviceId, tables })
  } catch (e) {
    console.warn('[backup] failed to gather data for export', e)
    return { success: false, method: IS_NATIVE ? 'native' : 'browser', error: e?.message || String(e) }
  }

  if (IS_NATIVE) {
    try {
      const granted = await ensureNativeStoragePermission()
      if (!granted) {
        return { success: false, method: 'native', error: 'Storage permission denied' }
      }
      const result = await Filesystem.writeFile({
        path: BACKUP_FILENAME,
        data: json,
        directory: Directory.Documents,
        encoding: Encoding.UTF8,
        recursive: true,
      })
      return { success: true, method: 'native', exportedAt, uri: result?.uri }
    } catch (e) {
      console.warn('[backup] native export failed', e)
      return { success: false, method: 'native', error: e?.message || String(e) }
    }
  }

  // Browser/PWA fallback: trigger a normal download. This is always a
  // manual, user-initiated action — there is no browser equivalent of
  // "write somewhere that survives losing the site/app".
  try {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = BACKUP_FILENAME
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Give the download a moment to actually start before revoking the URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return { success: true, method: 'browser', exportedAt }
  } catch (e) {
    console.warn('[backup] browser export failed', e)
    return { success: false, method: 'browser', error: e?.message || String(e) }
  }
}

// ── Import ───────────────────────────────────────────────────────────────────
async function readBackupText(source) {
  if (typeof source === 'string') {
    // Native: a file path (e.g. from a native file picker, or the known
    // Documents backup path). Omitting `directory` tells the plugin to
    // treat `path` as an absolute/full path rather than relative to a
    // Capacitor-managed root.
    const result = await Filesystem.readFile({ path: source, encoding: Encoding.UTF8 })
    return typeof result.data === 'string' ? result.data : await result.data.text()
  }
  if (typeof File !== 'undefined' && source instanceof File) {
    return await source.text()
  }
  if (source && typeof source.text === 'function') {
    // Duck-typed Blob-like fallback.
    return await source.text()
  }
  throw new Error('Unsupported backup source: expected a file path string or a File object.')
}

/**
 * Restores all local data from a backup. Accepts either a native file path
 * (string) or a browser `File` object — detects which it got, so callers
 * don't need to branch on platform.
 *
 * Validates the backup shape before touching any data; throws a clear,
 * user-facing error on anything malformed rather than partially applying it.
 *
 * @param {string|File} source
 * @returns {Promise<{exportedAt?: number, deviceId?: string}>}
 */
export async function importBackup(source) {
  const text = await readBackupText(source)

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON and cannot be restored.')
  }

  validateBackupPayload(parsed)

  await restoreAllTables(parsed.tables)

  return { exportedAt: parsed.exportedAt, deviceId: parsed.deviceId }
}

// ── Reinstall recovery detection ────────────────────────────────────────────
/**
 * Native only. Checks whether a backup already sits in the shared Documents
 * directory (i.e. this looks like a reinstall onto a device that still has
 * a prior backup). Never throws — a missing or corrupt file simply means
 * "nothing to offer", not an error.
 *
 * @returns {Promise<{exportedAt?: number, deviceId?: string}|null>}
 */
export async function checkForExistingBackup() {
  if (!IS_NATIVE) return null
  try {
    const result = await Filesystem.readFile({
      path: BACKUP_FILENAME,
      directory: Directory.Documents,
      encoding: Encoding.UTF8,
    })
    const text = typeof result.data === 'string' ? result.data : await result.data.text()
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed.version !== 'number' || !parsed.tables) return null
    return { exportedAt: parsed.exportedAt, deviceId: parsed.deviceId }
  } catch {
    return null
  }
}

// Restores directly from the well-known native Documents backup location that
// checkForExistingBackup() just confirmed exists — importBackup()'s string-path
// branch treats its argument as an absolute path with no `directory` context, so it
// can't address this same Documents-relative file on its own; this is the one-step
// counterpart callers should use for the first-launch restore-prompt flow.
export async function restoreFromDocumentsBackup() {
  if (!IS_NATIVE) throw new Error('No on-device backup location on this platform.')
  const result = await Filesystem.readFile({
    path: BACKUP_FILENAME,
    directory: Directory.Documents,
    encoding: Encoding.UTF8,
  })
  const text = typeof result.data === 'string' ? result.data : await result.data.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('This file is not valid JSON and cannot be restored.')
  }
  validateBackupPayload(parsed)
  await restoreAllTables(parsed.tables)
  return { exportedAt: parsed.exportedAt, deviceId: parsed.deviceId }
}

// ── Debounced auto-backup ───────────────────────────────────────────────────
// Call this after every mutating localData.js operation. No-ops on browser
// (there's no "automatic" persistent write there — export is always an
// explicit user action). Native failures are swallowed (with a console
// warning) so a background backup attempt never surfaces as a user-facing
// crash in the middle of normal app usage.
let autoBackupTimer = null

export function scheduleAutoBackup() {
  if (!IS_NATIVE) return

  if (autoBackupTimer) clearTimeout(autoBackupTimer)
  autoBackupTimer = setTimeout(async () => {
    autoBackupTimer = null
    try {
      const result = await exportBackup()
      if (!result?.success) {
        console.warn('[backup] auto backup did not succeed:', result?.error)
      }
    } catch (e) {
      console.warn('[backup] auto backup threw', e)
    }
  }, AUTO_BACKUP_DEBOUNCE_MS)
}
