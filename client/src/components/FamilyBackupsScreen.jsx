import { useEffect, useMemo, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { PageShell, Tile, TileLabel } from './PageShell'
import { getDeviceId } from '../lib/localData'
import * as backupKeys from '../lib/backupKeys'
import { readStoredZipEntries } from '../lib/zipReader'

const IS_NATIVE = Capacitor.isNativePlatform()

// Same-origin in the browser, absolute host in the native app — same convention
// ProfilePage.jsx/CornerMenu.jsx each define locally rather than sharing a module.
function httpBase() {
  return (localStorage.getItem('meeee_server') || '').trim().replace(/\/$/, '')
}

function formatBytes(n) {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let val = n
  while (val >= 1024 && i < units.length - 1) {
    val /= 1024
    i++
  }
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

// "online now" within a few minutes of last check-in (the child pairs/reports status
// on every doWork() run, including the lightweight schedule-only/wifi-watch ones, so a
// genuinely active device check-in cadence is frequent) — otherwise a relative time.
function formatLastSeen(lastSeenAt) {
  if (!lastSeenAt) return 'never seen'
  const ms = Date.now() - lastSeenAt
  if (ms < 5 * 60 * 1000) return 'online now'
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Groups the flat {path,size,mtime} inventory list (see server's /file-report route)
// into the immediate children of one breadcrumb level — folders (aggregated size +
// file count across everything beneath them) and files, both alphabetical, folders
// first. Pure client-side grouping over the already-fetched flat list; no per-folder
// fetch needed, since the whole inventory was already retrieved in one call.
function computeTreeLevel(entries, pathSegments) {
  const prefix = pathSegments.length ? pathSegments.join('/') + '/' : ''
  const folderMap = new Map()
  const files = []
  for (const entry of entries) {
    if (prefix && !entry.path.startsWith(prefix)) continue
    const rest = entry.path.slice(prefix.length)
    if (!rest) continue
    const slashIdx = rest.indexOf('/')
    if (slashIdx === -1) {
      files.push({ name: rest, size: entry.size || 0, mtime: entry.mtime })
    } else {
      const folderName = rest.slice(0, slashIdx)
      const agg = folderMap.get(folderName) || { size: 0, count: 0 }
      agg.size += entry.size || 0
      agg.count += 1
      folderMap.set(folderName, agg)
    }
  }
  const folders = Array.from(folderMap.entries())
    .map(([name, agg]) => ({ name, ...agg }))
    .sort((a, b) => a.name.localeCompare(b.name))
  files.sort((a, b) => a.name.localeCompare(b.name))
  return { folders, files }
}

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', opus: 'audio/opus',
  pdf: 'application/pdf',
}
function guessMime(name) {
  const ext = name.split('.').pop()?.toLowerCase()
  return EXT_MIME[ext] || 'application/octet-stream'
}
function fileKind(mime) {
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('video/')) return 'video'
  if (mime.startsWith('audio/')) return 'audio'
  return 'other'
}

// Parent-facing screen for the encrypted device-backup feature: one-time key setup
// (generate or restore the RSA keypair backupKeys.js manages), then browsing/decrypting/
// viewing whatever child devices have uploaded. See server/index.js's
// /api/device-backup/* routes and DeviceBackupWorker.java (native) for the other
// two-thirds of this feature.
// `parentToken`/`onTokenInvalid` are only passed when this screen is reached via
// ParentGate.jsx (the dedicated /parent link) — undefined when reached the old way,
// via the normal app's corner menu, in which case the now-gated requests below will
// 403 (expected; the corner-menu path is being phased out in favor of /parent, see
// App.jsx). `parentToken` gates the four routes server/index.js actually enforces it
// on: POST parent-key, POST schedule, GET devices, GET index/:deviceId — every other
// call here (chunk download, pairing) uses its own separate, pre-existing auth.
export default function FamilyBackupsScreen({ onHome, parentToken, onTokenInvalid }) {
  const [hasKey, setHasKey] = useState(null) // null = still checking
  const [settingUp, setSettingUp] = useState(false)
  const [recoveryFile, setRecoveryFile] = useState(null) // set once, right after generating a key
  const [error, setError] = useState('')
  const [runningNow, setRunningNow] = useState(false)

  const [devices, setDevices] = useState([])
  const [selectedDevice, setSelectedDevice] = useState(null)
  const [chunks, setChunks] = useState([])
  const [loadingChunks, setLoadingChunks] = useState(false)
  const [openingId, setOpeningId] = useState(null)
  const [failedChunk, setFailedChunk] = useState(null) // the chunk whose last View attempt failed to decrypt
  const [gallery, setGallery] = useState(null) // { chunkId, items: [{name, url, kind}], zipUrl }
  const [activeIndex, setActiveIndex] = useState(null) // index into gallery.items for the lightbox

  // "HH:MM" for the <input type="time">, and separate saving/saved UI state — this is
  // a global setting (one schedule for every child device, same as the parent key),
  // polled once per day by DeviceBackupWorker.java's doWork() rather than pushed live
  // (this app has no live channel to a child device — see localTransport.js).
  const [scheduleTime, setScheduleTime] = useState('23:00')
  const [savingSchedule, setSavingSchedule] = useState(false)
  const [scheduleSaved, setScheduleSaved] = useState(false)

  // Days of silence before a device's backup history is auto-removed — no app can
  // detect its own uninstallation (a deliberate OS privacy protection on every
  // platform, not a gap here), so this inactivity window is the closest real proxy.
  const [removalDays, setRemovalDays] = useState(3)
  const [savingRemovalDays, setSavingRemovalDays] = useState(false)
  const [removalDaysSaved, setRemovalDaysSaved] = useState(false)
  const [removingId, setRemovingId] = useState(null)
  const [triggeringId, setTriggeringId] = useState(null)
  const [triggeredId, setTriggeredId] = useState(null)
  const [scanningId, setScanningId] = useState(null)
  const [scannedId, setScannedId] = useState(null)
  const [fileReport, setFileReport] = useState(null) // { entries, scannedAt, truncated } for the selected device
  const [loadingFileReport, setLoadingFileReport] = useState(false)
  const [treePath, setTreePath] = useState([]) // breadcrumb: array of folder-name segments currently drilled into
  // Parent's on-demand backup picks, keyed by full relative path (folder or file) ->
  // { size, isFolder }. A selected folder's descendants are pruned from this map (see
  // toggleSelectedPath) so it always holds a disjoint set — no path counted twice when
  // computing the summary or when the device walks these paths server-side.
  const [selectedPaths, setSelectedPaths] = useState(new Map())
  const [requestingBackup, setRequestingBackup] = useState(false)
  const [backupRequested, setBackupRequested] = useState(false)
  const [history, setHistory] = useState([])
  const [loadingHistory, setLoadingHistory] = useState(false)

  useEffect(() => {
    backupKeys.hasBackupPrivateKey().then(setHasKey)
  }, [])

  useEffect(() => {
    fetch(`${httpBase()}/api/device-backup/schedule`)
      .then((r) => r.json())
      .then((d) => {
        const hh = String(d.hour ?? 23).padStart(2, '0')
        const mm = String(d.minute ?? 0).padStart(2, '0')
        setScheduleTime(`${hh}:${mm}`)
      })
      .catch(() => {})
  }, [])

  async function handleSaveSchedule() {
    const [hh, mm] = scheduleTime.split(':').map(Number)
    setSavingSchedule(true)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Parent-Token': parentToken || '' },
        body: JSON.stringify({ hour: hh, minute: mm }),
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not save the backup schedule.')
      setScheduleSaved(true)
      setTimeout(() => setScheduleSaved(false), 2000)
    } catch (e) {
      setError(e.message || 'Could not save the backup schedule.')
    } finally {
      setSavingSchedule(false)
    }
  }

  useEffect(() => {
    fetch(`${httpBase()}/api/device-backup/removal-policy`)
      .then((r) => r.json())
      .then((d) => setRemovalDays(d.days ?? 3))
      .catch(() => {})
  }, [])

  async function handleSaveRemovalDays() {
    setSavingRemovalDays(true)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/removal-policy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Parent-Token': parentToken || '' },
        body: JSON.stringify({ days: removalDays }),
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not save the removal setting.')
      setRemovalDaysSaved(true)
      setTimeout(() => setRemovalDaysSaved(false), 2000)
    } catch (e) {
      setError(e.message || 'Could not save the removal setting.')
    } finally {
      setSavingRemovalDays(false)
    }
  }

  async function handleRemoveDevice(deviceId, name) {
    if (!window.confirm(`Remove ${name || deviceId}? This permanently deletes its entire backup history.`)) return
    setRemovingId(deviceId)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/devices/${encodeURIComponent(deviceId)}`, {
        method: 'DELETE',
        headers: { 'X-Parent-Token': parentToken || '' },
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not remove this device.')
      setDevices((prev) => prev.filter((d) => d.deviceId !== deviceId))
      if (selectedDevice === deviceId) { setSelectedDevice(null); setChunks([]) }
    } catch (e) {
      setError(e.message || 'Could not remove this device.')
    } finally {
      setRemovingId(null)
    }
  }

  useEffect(() => {
    fetch(`${httpBase()}/api/device-backup/devices`, { headers: { 'X-Parent-Token': parentToken || '' } })
      .then((r) => {
        if (r.status === 403 && onTokenInvalid) { onTokenInvalid(); return null }
        return r.json()
      })
      // `devices` (added alongside the older `deviceIds`) carries each device's
      // most-recently-reported display name — falls back to the bare id for any
      // device that backed up before this existed, or hasn't reported a name yet.
      .then((d) => d && setDevices(d.devices || (d.deviceIds || []).map((id) => ({ deviceId: id, name: '' }))))
      .catch(() => {})
  }, [])

  // Revoke every object URL created for the currently-open gallery once it's replaced
  // or the screen unmounts, so decrypted image/video data isn't left pinned in memory.
  useEffect(() => {
    return () => {
      if (!gallery) return
      gallery.items.forEach((it) => URL.revokeObjectURL(it.url))
      if (gallery.zipUrl) URL.revokeObjectURL(gallery.zipUrl)
    }
  }, [gallery])

  async function loadChunks(deviceId) {
    setSelectedDevice(deviceId)
    setLoadingChunks(true)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/index/${encodeURIComponent(deviceId)}`, {
        headers: { 'X-Parent-Token': parentToken || '' },
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not load backups for this device.')
      const data = await res.json()
      setChunks((data.chunks || []).slice().sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0)))
    } catch (e) {
      setError(e.message || 'Could not load backups for this device.')
    } finally {
      setLoadingChunks(false)
    }
    loadHistory(deviceId)
    loadFileReport(deviceId)
  }

  // The full check-in log for a device (every heartbeat/pair/status/chunk-upload event),
  // not just the single latest lastSeenAt shown on its chip — lets the parent actually
  // see the online pattern, e.g. confirm a device really has gone quiet before a ghost
  // entry gets removed, rather than trusting one frozen timestamp.
  async function loadHistory(deviceId) {
    setLoadingHistory(true)
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/devices/${encodeURIComponent(deviceId)}/history`, {
        headers: { 'X-Parent-Token': parentToken || '' },
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      const data = await res.json()
      setHistory(data?.history || [])
    } catch {
      setHistory([])
    } finally {
      setLoadingHistory(false)
    }
  }

  // Forces a backup on this device even though today's already ran — the device picks
  // this up on its next heartbeat (fires on its next app open, or already-armed Wi-Fi
  // watch) and still waits for Wi-Fi before actually uploading anything.
  async function handleTriggerBackup(deviceId) {
    setTriggeringId(deviceId)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/devices/${encodeURIComponent(deviceId)}/trigger-backup`, {
        method: 'POST',
        headers: { 'X-Parent-Token': parentToken || '' },
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not request a backup for this device.')
      setTriggeredId(deviceId)
      setTimeout(() => setTriggeredId((prev) => (prev === deviceId ? null : prev)), 3000)
    } catch (e) {
      setError(e.message || 'Could not request a backup for this device.')
    } finally {
      setTriggeringId(null)
    }
  }

  // Requests a fresh full-storage inventory (filenames/sizes/dates only, not a real
  // backup) — same one-shot-flag-via-heartbeat mechanism as handleTriggerBackup above,
  // just a sibling flag so the two can be requested independently.
  async function handleTriggerScan(deviceId) {
    setScanningId(deviceId)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/devices/${encodeURIComponent(deviceId)}/trigger-scan`, {
        method: 'POST',
        headers: { 'X-Parent-Token': parentToken || '' },
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not request a folder scan for this device.')
      setScannedId(deviceId)
      setTimeout(() => setScannedId((prev) => (prev === deviceId ? null : prev)), 3000)
    } catch (e) {
      setError(e.message || 'Could not request a folder scan for this device.')
    } finally {
      setScanningId(null)
    }
  }

  async function loadFileReport(deviceId) {
    setLoadingFileReport(true)
    setTreePath([])
    setSelectedPaths(new Map())
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/file-report/${encodeURIComponent(deviceId)}`, {
        headers: { 'X-Parent-Token': parentToken || '' },
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      const data = await res.json()
      setFileReport(data)
    } catch {
      setFileReport(null)
    } finally {
      setLoadingFileReport(false)
    }
  }

  const treeLevel = useMemo(
    () => computeTreeLevel(fileReport?.entries || [], treePath),
    [fileReport, treePath]
  )

  // True if fullPath is either picked directly, or falls under a folder that's picked
  // (folder selections implicitly cover everything beneath them, same as the device's
  // own collectOnDemandFiles walk does).
  function isPathSelected(fullPath) {
    if (selectedPaths.has(fullPath)) return true
    const segments = fullPath.split('/')
    for (let i = 1; i < segments.length; i++) {
      const ancestor = selectedPaths.get(segments.slice(0, i).join('/'))
      if (ancestor?.isFolder) return true
    }
    return false
  }

  function toggleSelectedPath(fullPath, size, isFolder) {
    setSelectedPaths((prev) => {
      const next = new Map(prev)
      if (next.has(fullPath)) {
        next.delete(fullPath)
      } else {
        if (isFolder) {
          // Selecting a folder already covers everything under it — drop any
          // now-redundant descendant picks so the device isn't asked to walk (and
          // upload) the same files twice.
          for (const key of next.keys()) {
            if (key.startsWith(`${fullPath}/`)) next.delete(key)
          }
        }
        next.set(fullPath, { size, isFolder })
      }
      return next
    })
  }

  const selectedSummary = useMemo(() => {
    let bytes = 0
    for (const { size } of selectedPaths.values()) bytes += size || 0
    return { count: selectedPaths.size, bytes }
  }, [selectedPaths])

  // Sends the parent's picks to the device via the same one-shot-flag-via-heartbeat
  // mechanism as handleTriggerBackup/handleTriggerScan above — the device picks this up
  // on its next check-in and still waits for Wi-Fi before uploading anything.
  async function handleBackupSelected() {
    if (selectedPaths.size === 0 || !selectedDevice) return
    setRequestingBackup(true)
    setError('')
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/devices/${encodeURIComponent(selectedDevice)}/backup-paths`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Parent-Token': parentToken || '' },
        body: JSON.stringify({ paths: Array.from(selectedPaths.keys()) }),
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Could not request a backup of the selected items.')
      setSelectedPaths(new Map())
      setBackupRequested(true)
      setTimeout(() => setBackupRequested(false), 3000)
    } catch (e) {
      setError(e.message || 'Could not request a backup of the selected items.')
    } finally {
      setRequestingBackup(false)
    }
  }

  async function handleSetup() {
    setSettingUp(true)
    setError('')
    try {
      // hasKey only reflects whether THIS BROWSER has a private key locally — the
      // server (whichever one httpBase() currently points at: production, or a local
      // server used for testing) may already have a DIFFERENT public key registered,
      // e.g. set up from another browser, or from this same browser while pointed at a
      // different server. Generating a fresh keypair unconditionally would silently
      // overwrite that key and PERMANENTLY orphan every backup already encrypted
      // against it, on every device — confirmed as the real cause of a real
      // "Decryption failed" report (a key generated during local testing overwrote
      // what was live, with no warning at all). Checking first, and requiring an
      // explicit confirmation to overwrite, is the fix.
      const existing = await fetch(`${httpBase()}/api/device-backup/parent-key`).then((r) => r.json()).catch(() => null)
      if (existing?.publicKeyJwk) {
        const proceed = window.confirm(
          'A backup encryption key already exists on this server. Generating a new one here ' +
          'will PERMANENTLY make every backup already uploaded unreadable, on every device — ' +
          'there is no way to reverse this. If you have the existing recovery file, cancel and ' +
          'restore it below instead. Continue and overwrite the existing key anyway?'
        )
        if (!proceed) { setSettingUp(false); return }
      }
      const { publicKeyJwk } = await backupKeys.generateBackupKeypair()
      const res = await fetch(`${httpBase()}/api/device-backup/parent-key`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Parent-Token': parentToken || '' },
        body: JSON.stringify({ publicKeyJwk }),
      })
      if (res.status === 403 && onTokenInvalid) { onTokenInvalid(); return }
      if (!res.ok) throw new Error('Failed to register the encryption key with the server.')
      setRecoveryFile(await backupKeys.exportRecoveryFile())
      setHasKey(true)
    } catch (e) {
      setError(e.message || 'Setup failed.')
    } finally {
      setSettingUp(false)
    }
  }

  function downloadRecoveryFile() {
    const blob = new Blob([recoveryFile], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'meeee-backup-recovery-key.json'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function handleImportRecovery(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setError('')
    // Only ask for confirmation when this REPLACES a key already active on this
    // device — importing onto a fresh device (no key yet) has nothing to lose, so no
    // extra friction there.
    if (hasKey) {
      const proceed = window.confirm(
        'This replaces the recovery key currently active on this device. Backups made ' +
        'under the current key will stop showing as decryptable here until you import it ' +
        'again. Continue?'
      )
      if (!proceed) { e.target.value = ''; return }
    }
    try {
      await backupKeys.importRecoveryFile(JSON.parse(await file.text()))
      setHasKey(true)
    } catch (err) {
      setError(err.message || 'Could not import this recovery file.')
    } finally {
      e.target.value = ''
    }
  }

  function handleRunBackupNow() {
    if (!window.MeeeeNative?.runBackupNow) return
    setRunningNow(true)
    try {
      window.MeeeeNative.runBackupNow()
    } finally {
      // Fire-and-forget — the native side has no callback, this just gives the button
      // a brief, honest "something happened" state instead of looking unresponsive.
      setTimeout(() => setRunningNow(false), 1500)
    }
  }

  // overrideKeyJwk lets a chunk be decrypted with a recovery-file key picked ad hoc
  // (see handleRetryWithFile below) instead of whatever is currently stored in this
  // browser — used when a backup was made under an older key than the one currently
  // set up, without overwriting that current key just to look at one old backup.
  async function handleOpenChunk(chunk, overrideKeyJwk) {
    setOpeningId(chunk.id)
    setError('')
    if (!overrideKeyJwk) setFailedChunk(null)
    try {
      const ownDeviceId = await getDeviceId()
      const pairRes = await fetch(`${httpBase()}/api/device-backup/pair/${encodeURIComponent(ownDeviceId)}`)
      if (!pairRes.ok) throw new Error('Could not authenticate this device.')
      const { backupToken } = await pairRes.json()

      const res = await fetch(
        `${httpBase()}/api/device-backup/chunk/${encodeURIComponent(selectedDevice)}/${encodeURIComponent(chunk.id)}`,
        { headers: { 'X-Requester-Id': ownDeviceId, 'X-Backup-Token': backupToken } }
      )
      if (!res.ok) throw new Error('Could not fetch this backup from cloud storage.')
      const ciphertext = await res.arrayBuffer()

      const aesKey = overrideKeyJwk
        ? await backupKeys.unwrapChunkKeyWithJwk(overrideKeyJwk, chunk.wrappedKey)
        : await backupKeys.unwrapChunkKey(chunk.wrappedKey)
      const plaintext = await backupKeys.decryptChunk({ ciphertext, ivBase64: chunk.iv, aesKey })

      const entries = readStoredZipEntries(plaintext)
      const items = entries.map((entry) => {
        const mime = guessMime(entry.name)
        const blob = new Blob([plaintext.slice(entry.offset, entry.offset + entry.size)], { type: mime })
        return { name: entry.name, url: URL.createObjectURL(blob), kind: fileKind(mime) }
      })
      const zipUrl = URL.createObjectURL(new Blob([plaintext], { type: 'application/zip' }))

      setGallery({ chunkId: chunk.id, items, zipUrl })
      setActiveIndex(null)
      setFailedChunk(null)
    } catch (e) {
      setError(e.message || 'Decryption failed — wrong recovery key, or the chunk is missing.')
      // Offer the "try a different recovery file" option right on this chunk, rather
      // than only in the global Encryption key section — the whole point is to check
      // one specific backup against a different key without disturbing the one
      // currently set up for everything else.
      setFailedChunk(chunk)
    } finally {
      setOpeningId(null)
    }
  }

  // Reads a recovery-file JSON picked from disk and retries decrypting the SAME chunk
  // with just that key, in memory only — never written to IndexedDB, so the browser
  // own day-to-day key (used for every other backup) is left untouched.
  async function handleRetryWithFile(e) {
    const file = e.target.files?.[0]
    const chunk = failedChunk
    e.target.value = ''
    if (!file || !chunk) return
    try {
      const parsed = JSON.parse(await file.text())
      if (parsed?.kind !== 'meeee-backup-recovery-key' || !parsed.privateKeyJwk) {
        throw new Error('This file is not a valid backup recovery key.')
      }
      await handleOpenChunk(chunk, parsed.privateKeyJwk)
    } catch (err) {
      setError(err.message || 'Could not use this recovery file.')
      setFailedChunk(chunk)
    }
  }

  return (
    // `family-backups-screen` is a pure CSS targeting hook, same convention as
    // `.health-screen`/`.khata-screen`/etc. — index.css's unlayered `margin:0;padding:0`
    // reset excludes these specific classes so Tailwind spacing utilities (mx-auto, p-5,
    // px-6, ...) actually take effect inside PageShell here. Without this wrapper, every
    // margin/padding utility in this screen (and inside PageShell's own layout) silently
    // computes to 0 — that's the exact bug that made this screen render unreadably
    // cramped, text clipped against tile edges, before this wrapper was added.
    <div className="family-backups-screen">
      <PageShell
        eyebrow="Family"
        title="Family Backups"
        lead="Daily encrypted backups from your family's devices — only this key can decrypt them."
        onHome={onHome}
      >
      {error && (
        <p className="mb-4 rounded-2xl bg-destructive-soft px-4 py-3 text-sm font-medium text-destructive">{error}</p>
      )}

      {IS_NATIVE && (
        <Tile className="mb-4">
          <TileLabel>Testing</TileLabel>
          <p className="mt-2 text-sm text-muted-foreground">
            The real backup runs automatically once a day. For testing, trigger one right now instead
            of waiting.
          </p>
          <button
            type="button"
            disabled={runningNow}
            onClick={handleRunBackupNow}
            className="mt-3 rounded-full bg-secondary px-4 py-2 text-sm font-semibold text-secondary-foreground disabled:opacity-50"
          >
            {runningNow ? 'Requested…' : 'Run backup now'}
          </button>
          <p className="mt-2 text-xs text-muted-foreground">
            Runs in the background; check here again in a minute for a new entry below.
          </p>
        </Tile>
      )}

      <Tile className="mb-4">
        <TileLabel>Backup schedule</TileLabel>
        <p className="mt-2 rounded-lg bg-secondary px-3 py-2 text-xs font-medium text-secondary-foreground">
          Automatic backups are paused for now. Devices will not back up on a schedule,
          on app open, or on Wi-Fi connect — use the folder browser below to request
          specific files, or the ⟳ button above to force a full backup on demand.
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          What time every device would run its nightly backup, once resumed. Applies to
          all family devices; a change here takes effect starting from each device's
          next scheduled run (up to a day to reach a device that isn't opened in the
          meantime).
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="time"
            value={scheduleTime}
            onChange={(e) => setScheduleTime(e.target.value)}
            className="rounded-full bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground"
          />
          <button
            type="button"
            disabled={savingSchedule}
            onClick={handleSaveSchedule}
            className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
          >
            {savingSchedule ? 'Saving…' : scheduleSaved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </Tile>

      <Tile className="mb-4">
        <TileLabel>Remove inactive devices</TileLabel>
        <p className="mt-2 text-sm text-muted-foreground">
          No app can detect its own uninstallation, so this is a "gone quiet for this
          long" guess rather than an instant signal — a device that stays offline (no
          Wi-Fi, powered off) for a while won't be removed early by mistake, but genuinely
          uninstalled devices are only cleaned up after this many days of silence.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="number"
            min="0"
            max="365"
            value={removalDays}
            onChange={(e) => setRemovalDays(Number(e.target.value))}
            className="w-20 rounded-full bg-secondary px-4 py-2 text-sm font-medium text-secondary-foreground"
          />
          <span className="text-sm text-muted-foreground">days of silence</span>
          <button
            type="button"
            disabled={savingRemovalDays}
            onClick={handleSaveRemovalDays}
            className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
          >
            {savingRemovalDays ? 'Saving…' : removalDaysSaved ? 'Saved ✓' : 'Save'}
          </button>
        </div>
      </Tile>

      <Tile className="mb-4">
        <TileLabel>Encryption key</TileLabel>
        {hasKey === null ? (
          <p className="mt-3 text-sm text-muted-foreground">Checking this device…</p>
        ) : recoveryFile ? (
          <div className="mt-3">
            <p className="text-sm font-semibold text-destructive">
              Save your recovery key now — this is the only time it's shown.
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Every backup, from every device, is encrypted so only this key can open it. If it's
              lost, backups already made can never be decrypted again — there's no reset and no
              support recovery, by design.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={downloadRecoveryFile}
                className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background"
              >
                Download recovery key
              </button>
              <button
                type="button"
                onClick={() => setRecoveryFile(null)}
                className="text-sm font-medium text-muted-foreground underline"
              >
                I've saved it
              </button>
            </div>
          </div>
        ) : hasKey ? (
          <div className="mt-3">
            <p className="text-sm font-medium text-success">This device can decrypt family backups.</p>
            <p className="mt-2 text-xs text-muted-foreground">
              Have a different recovery-key file (e.g. from an older setup) and need this device
              to use that one instead?
            </p>
            <label className="mt-1 inline-block cursor-pointer text-sm font-medium text-foreground underline">
              Use a different recovery file
              <input type="file" accept="application/json" className="hidden" onChange={handleImportRecovery} />
            </label>
          </div>
        ) : (
          <div className="mt-3">
            <p className="text-sm text-muted-foreground">
              Set this device up as the one that can read encrypted backups, or restore a
              previously-saved recovery key on a new device.
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={settingUp}
                onClick={handleSetup}
                className="rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
              >
                {settingUp ? 'Setting up…' : 'Set up encrypted backups'}
              </button>
              <label className="cursor-pointer text-sm font-medium text-muted-foreground underline">
                Restore from a recovery file
                <input type="file" accept="application/json" className="hidden" onChange={handleImportRecovery} />
              </label>
            </div>
          </div>
        )}
      </Tile>

      <Tile className="mb-4">
        <TileLabel>Devices</TileLabel>
        {devices.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No device has backed up yet.</p>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            {devices.map(({ deviceId, name, lastSeenAt }) => (
              <div
                key={deviceId}
                className={`flex items-center gap-2 rounded-full py-1.5 pl-3 pr-2 text-sm font-medium ${
                  selectedDevice === deviceId ? 'bg-foreground text-background' : 'bg-secondary text-secondary-foreground'
                }`}
              >
                <button type="button" onClick={() => loadChunks(deviceId)} className="text-left">
                  <span>{name || deviceId}</span>
                  <span className="ml-1.5 text-xs opacity-70">· {formatLastSeen(lastSeenAt)}</span>
                </button>
                <button
                  type="button"
                  disabled={triggeringId === deviceId}
                  onClick={() => handleTriggerBackup(deviceId)}
                  aria-label={`Back up ${name || deviceId} now`}
                  title="Back up now, even if today's backup already ran"
                  className="shrink-0 text-xs opacity-70 hover:opacity-100 disabled:opacity-40"
                >
                  {triggeringId === deviceId ? '…' : triggeredId === deviceId ? 'Requested ✓' : '⟳'}
                </button>
                <button
                  type="button"
                  disabled={scanningId === deviceId}
                  onClick={() => handleTriggerScan(deviceId)}
                  aria-label={`Scan folders on ${name || deviceId}`}
                  title="Scan the whole device for a folder/file inventory (names and sizes only, not a backup)"
                  className="shrink-0 text-xs opacity-70 hover:opacity-100 disabled:opacity-40"
                >
                  {scanningId === deviceId ? '…' : scannedId === deviceId ? 'Requested ✓' : '🗂'}
                </button>
                <button
                  type="button"
                  disabled={removingId === deviceId}
                  onClick={() => handleRemoveDevice(deviceId, name)}
                  aria-label={`Remove ${name || deviceId}`}
                  className="shrink-0 text-xs opacity-70 hover:opacity-100 disabled:opacity-40"
                >
                  {removingId === deviceId ? '…' : '✕'}
                </button>
              </div>
            ))}
          </div>
        )}
      </Tile>

      {selectedDevice && (
        <Tile className="mb-4">
          <TileLabel>Recent activity</TileLabel>
          {loadingHistory ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          ) : history.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No check-ins recorded yet.</p>
          ) : (
            <ul className="mt-3 max-h-48 overflow-y-auto divide-y divide-border">
              {history.map((h) => (
                <li key={h.id} className="flex items-center justify-between gap-3 py-1.5 text-xs text-muted-foreground">
                  <span className="capitalize">{h.event}</span>
                  <span>{h.at ? new Date(h.at).toLocaleString() : ''}</span>
                </li>
              ))}
            </ul>
          )}
        </Tile>
      )}

      {selectedDevice && (
        <Tile className="mb-4">
          <div className="flex items-center justify-between gap-2">
            <TileLabel>Device folders</TileLabel>
            <button
              type="button"
              onClick={() => loadFileReport(selectedDevice)}
              disabled={loadingFileReport}
              className="shrink-0 text-xs font-medium text-muted-foreground underline disabled:opacity-40"
            >
              {loadingFileReport ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            A full inventory of what is on the device — file names, sizes, and dates only.
            This is not a backup; nothing here has been copied off the device.
          </p>
          {loadingFileReport ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          ) : !fileReport?.scannedAt ? (
            <p className="mt-3 text-sm text-muted-foreground">
              No folder scan yet — tap 🗂 next to this device above to request one, then Refresh
              here once it has had a moment to finish (it needs Wi-Fi and can take a little
              while on a device with a lot of files).
            </p>
          ) : (
            <div className="mt-3">
              <p className="text-xs text-muted-foreground">
                Scanned {new Date(fileReport.scannedAt).toLocaleString()}
                {fileReport.truncated ? ' · stopped early (device has an unusually large number of files)' : ''}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-1 text-sm">
                <button
                  type="button"
                  onClick={() => setTreePath([])}
                  className={`rounded-full px-2 py-1 ${treePath.length === 0 ? 'bg-foreground text-background' : 'text-muted-foreground underline'}`}
                >
                  Home
                </button>
                {treePath.map((segment, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <span className="text-muted-foreground">/</span>
                    <button
                      type="button"
                      onClick={() => setTreePath(treePath.slice(0, i + 1))}
                      className={`rounded-full px-2 py-1 ${i === treePath.length - 1 ? 'bg-foreground text-background' : 'text-muted-foreground underline'}`}
                    >
                      {segment}
                    </button>
                  </span>
                ))}
              </div>
              {treeLevel.folders.length === 0 && treeLevel.files.length === 0 ? (
                <p className="mt-3 text-sm text-muted-foreground">This folder is empty.</p>
              ) : (
                <ul className="mt-3 max-h-64 overflow-y-auto divide-y divide-border">
                  {treeLevel.folders.map((f) => {
                    const fullPath = [...treePath, f.name].join('/')
                    const explicitlySelected = selectedPaths.has(fullPath)
                    const selected = explicitlySelected || isPathSelected(fullPath)
                    return (
                      <li key={f.name} className="flex items-center gap-2 py-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={selected && !explicitlySelected}
                          onChange={() => toggleSelectedPath(fullPath, f.size, true)}
                          title={selected && !explicitlySelected ? 'Included via a selected parent folder' : 'Back up this folder'}
                          className="shrink-0"
                        />
                        <button
                          type="button"
                          onClick={() => setTreePath([...treePath, f.name])}
                          className="flex min-w-0 flex-1 items-center justify-between gap-3 text-left text-sm"
                        >
                          <span className="min-w-0 truncate">📁 {f.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {f.count} file{f.count === 1 ? '' : 's'} · {formatBytes(f.size)}
                          </span>
                        </button>
                      </li>
                    )
                  })}
                  {treeLevel.files.map((f) => {
                    const fullPath = [...treePath, f.name].join('/')
                    const explicitlySelected = selectedPaths.has(fullPath)
                    const selected = explicitlySelected || isPathSelected(fullPath)
                    return (
                      <li key={f.name} className="flex items-center gap-2 py-2">
                        <input
                          type="checkbox"
                          checked={selected}
                          disabled={selected && !explicitlySelected}
                          onChange={() => toggleSelectedPath(fullPath, f.size, false)}
                          title={selected && !explicitlySelected ? 'Included via a selected parent folder' : 'Back up this file'}
                          className="shrink-0"
                        />
                        <div className="flex min-w-0 flex-1 items-center justify-between gap-3 text-sm">
                          <span className="min-w-0 truncate">📄 {f.name}</span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatBytes(f.size)}{f.mtime ? ` · ${new Date(f.mtime).toLocaleDateString()}` : ''}
                          </span>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
              {selectedSummary.count > 0 && (
                <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border p-2">
                  <span className="text-xs text-muted-foreground">
                    {selectedSummary.count} item{selectedSummary.count === 1 ? '' : 's'} selected,
                    {' '}~{formatBytes(selectedSummary.bytes)}
                  </span>
                  <button
                    type="button"
                    onClick={handleBackupSelected}
                    disabled={requestingBackup}
                    className="shrink-0 rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background disabled:opacity-50"
                  >
                    {requestingBackup ? 'Requesting…' : backupRequested ? 'Requested ✓' : 'Back up selected'}
                  </button>
                </div>
              )}
            </div>
          )}
        </Tile>
      )}

      {selectedDevice && (
        <Tile>
          <TileLabel>
            Backups for {devices.find((d) => d.deviceId === selectedDevice)?.name || selectedDevice}
          </TileLabel>
          {loadingChunks ? (
            <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
          ) : chunks.length === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">No backups yet from this device.</p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {chunks.map((c) => {
                const totalBytes = (c.files || []).reduce((s, f) => s + (f.size || 0), 0)
                return (
                  <li key={c.id} className="py-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold">
                          {c.uploadedAt ? new Date(c.uploadedAt).toLocaleString() : 'Unknown time'}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {(c.files || []).length} file{(c.files || []).length === 1 ? '' : 's'} · {formatBytes(totalBytes)}
                        </p>
                      </div>
                      <button
                        type="button"
                        disabled={!hasKey || openingId === c.id}
                        onClick={() => handleOpenChunk(c)}
                        className="shrink-0 rounded-full bg-secondary px-3 py-1.5 text-xs font-semibold text-secondary-foreground disabled:opacity-50"
                      >
                        {openingId === c.id ? 'Decrypting…' : 'View'}
                      </button>
                    </div>
                    {failedChunk?.id === c.id && (
                      <div className="mt-2 flex items-center gap-2 text-xs">
                        <span className="text-muted-foreground">Made with a different key?</span>
                        <label className="cursor-pointer font-semibold text-foreground underline">
                          Try another recovery file
                          <input
                            type="file"
                            accept="application/json"
                            onChange={handleRetryWithFile}
                            className="hidden"
                          />
                        </label>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </Tile>
      )}

      {gallery && (
        <div
          onClick={() => { setGallery(null); setActiveIndex(null) }}
          className="fixed inset-0 z-50 flex flex-col bg-black/90 p-4"
        >
          <div onClick={(e) => e.stopPropagation()} className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 items-center justify-between pb-3">
              <p className="text-sm font-semibold text-white">
                {gallery.items.length} file{gallery.items.length === 1 ? '' : 's'} — decrypted locally, never uploaded plain
              </p>
              <div className="flex items-center gap-3">
                <a
                  href={gallery.zipUrl}
                  download={`backup-${selectedDevice}-${gallery.chunkId}.zip`}
                  className="text-xs font-semibold text-white underline"
                >
                  Save all as .zip
                </a>
                <button
                  type="button"
                  onClick={() => { setGallery(null); setActiveIndex(null) }}
                  className="text-sm font-semibold text-white"
                >
                  Close
                </button>
              </div>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-3 overflow-y-auto sm:grid-cols-4">
              {gallery.items.map((item, index) => (
                <button
                  key={item.name}
                  type="button"
                  onClick={() => setActiveIndex(index)}
                  className="flex flex-col overflow-hidden rounded-2xl bg-white/5 text-left"
                >
                  {item.kind === 'image' ? (
                    <img src={item.url} alt="" className="aspect-square w-full object-cover" />
                  ) : item.kind === 'video' ? (
                    <video src={item.url} className="aspect-square w-full object-cover" muted />
                  ) : item.kind === 'audio' ? (
                    <div className="flex aspect-square w-full items-center justify-center text-3xl">🎙</div>
                  ) : (
                    <div className="flex aspect-square w-full items-center justify-center text-3xl">📄</div>
                  )}
                  <span className="truncate px-2 py-1.5 text-[11px] text-white/80">{item.name.split('/').pop()}</span>
                </button>
              ))}
            </div>
          </div>

          {activeIndex !== null && (() => {
            const item = gallery.items[activeIndex]
            const atStart = activeIndex === 0
            const atEnd = activeIndex === gallery.items.length - 1
            return (
              <div
                onClick={(e) => e.stopPropagation()}
                className="fixed inset-0 z-[60] flex flex-col bg-black p-4"
              >
                <div className="flex shrink-0 items-center justify-between pb-3">
                  <p className="min-w-0 truncate pr-3 text-xs text-white/70">{item.name}</p>
                  <div className="flex shrink-0 items-center gap-4">
                    <a href={item.url} download={item.name.split('/').pop()} className="text-sm font-semibold text-white underline">
                      Download
                    </a>
                    <button type="button" onClick={() => setActiveIndex(null)} className="text-sm font-semibold text-white">
                      Close
                    </button>
                  </div>
                </div>
                <div className="relative flex min-h-0 flex-1 items-center justify-center">
                  {!atStart && (
                    <button
                      type="button"
                      onClick={() => setActiveIndex(activeIndex - 1)}
                      className="absolute left-0 z-10 flex h-12 w-12 items-center justify-center text-3xl text-white/80"
                      aria-label="Previous"
                    >
                      ‹
                    </button>
                  )}
                  {item.kind === 'image' ? (
                    <img src={item.url} alt="" className="max-h-full max-w-full object-contain" />
                  ) : item.kind === 'video' ? (
                    <video src={item.url} controls autoPlay className="max-h-full max-w-full" />
                  ) : item.kind === 'audio' ? (
                    <div className="flex w-full max-w-sm flex-col items-center gap-4 text-white">
                      <span className="text-5xl">🎙</span>
                      <audio src={item.url} controls autoPlay className="w-full" />
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-3 text-white">
                      <span className="text-5xl">📄</span>
                      <p className="text-sm text-white/70">This file type can't be previewed here.</p>
                      <a
                        href={item.url}
                        download={item.name.split('/').pop()}
                        className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black"
                      >
                        Download this file
                      </a>
                    </div>
                  )}
                  {!atEnd && (
                    <button
                      type="button"
                      onClick={() => setActiveIndex(activeIndex + 1)}
                      className="absolute right-0 z-10 flex h-12 w-12 items-center justify-center text-3xl text-white/80"
                      aria-label="Next"
                    >
                      ›
                    </button>
                  )}
                </div>
              </div>
            )
          })()}
        </div>
      )}
      </PageShell>
    </div>
  )
}
