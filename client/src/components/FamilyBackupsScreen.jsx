import { useEffect, useState } from 'react'
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
  }

  async function handleSetup() {
    setSettingUp(true)
    setError('')
    try {
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

  async function handleOpenChunk(chunk) {
    setOpeningId(chunk.id)
    setError('')
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

      const aesKey = await backupKeys.unwrapChunkKey(chunk.wrappedKey)
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
    } catch (e) {
      setError(e.message || 'Decryption failed — wrong recovery key, or the chunk is missing.')
    } finally {
      setOpeningId(null)
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
        <p className="mt-2 text-sm text-muted-foreground">
          What time every device should run its nightly backup. Applies to all family
          devices; a change here takes effect starting from each device's next scheduled
          run (up to a day to reach a device that isn't opened in the meantime).
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
        <p className="mt-3 text-xs text-muted-foreground">
          Devices also back up automatically whenever they connect to Wi-Fi, not only at
          the scheduled time — this catches a backup sooner if Wi-Fi wasn't available
          right at the scheduled moment.
        </p>
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
          <p className="mt-3 text-sm font-medium text-success">This device can decrypt family backups.</p>
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
                  <li key={c.id} className="flex items-center justify-between gap-3 py-3">
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
