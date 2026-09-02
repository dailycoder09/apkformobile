import { useState, useEffect, useCallback, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import { App as CapApp } from '@capacitor/app'

const IS_NATIVE = Capacitor.isNativePlatform()

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska', 'video/x-matroska', 'video/3gpp', 'video/mpeg'])
const AUDIO_TYPES = new Set(['audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/wav', 'audio/webm', 'audio/flac', 'audio/x-m4a'])
const TEXT_TYPES  = new Set(['text/plain', 'text/html', 'text/css', 'text/javascript', 'application/json', 'application/xml', 'text/xml', 'text/csv', 'text/markdown'])

function previewType(mime) {
  if (!mime) return 'download'
  if (IMAGE_TYPES.has(mime)) return 'image'
  if (VIDEO_TYPES.has(mime)) return 'video'
  if (AUDIO_TYPES.has(mime)) return 'audio'
  if (mime === 'application/pdf') return 'pdf'
  if (TEXT_TYPES.has(mime) || mime.startsWith('text/')) return 'text'
  return 'download'
}

function formatBytes(b) {
  if (!b && b !== 0) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

function fileIcon(mime, kind) {
  if (kind === 'directory') return '📁'
  if (!mime) return '📄'
  if (mime.startsWith('image/')) return '🖼️'
  if (mime.startsWith('video/')) return '🎬'
  if (mime.startsWith('audio/')) return '🎵'
  if (mime === 'application/pdf') return '📋'
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('rar')) return '📦'
  if (mime.startsWith('text/')) return '📝'
  return '📄'
}

export default function RemoteFileBrowser({ targetUser, adminId, adminPin, sendMsg, addListener }) {
  const [path, setPath]       = useState([])
  const [entries, setEntries] = useState(null)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  // True only when this device has never registered an FCM token at all (never logged
  // in) — quick-pull doesn't need a live connection, so routine offline/dormant no
  // longer applies here the way it does for Live Monitor's camera/mic/location.
  const [offline, setOffline] = useState(false)
  const pendingRef            = useRef({}) // requestId → { name, mimeType, size, filePath }
  const timeoutRef            = useRef({}) // requestId → timer
  const lsRequestRef          = useRef(null) // latest outstanding ls requestId, to ignore a stale timeout
  const lsTimeoutRef          = useRef(null)

  // Stateless quick-pull — the server sends one FCM push containing the request, the
  // device does the work in a brief non-persistent handler and posts the result
  // straight back over HTTP. No persistent connection or "online" status needed for
  // this to work at all; see server/index.js's quick_pull_ls handling.
  const requestLs = useCallback((p) => {
    setLoading(true); setError(null); setEntries(null); setOffline(false)
    const requestId = Math.random().toString(36).slice(2)
    lsRequestRef.current = requestId
    sendMsg({ type: 'quick_pull_ls', targetId: targetUser.id, path: p, requestId })

    // The device round-trips over FCM + a separate HTTP callback — nothing here
    // guarantees either leg completes, so without this the UI can spin on "Fetching…"
    // forever if the push never reaches the device (see the NotRegistered/no-callback
    // cases hit while debugging this on real MIUI hardware).
    clearTimeout(lsTimeoutRef.current)
    lsTimeoutRef.current = setTimeout(() => {
      if (lsRequestRef.current === requestId) {
        setLoading(false)
        setError('No response from device. It may be offline or the push was not delivered.')
      }
    }, 30000)
  }, [sendMsg, targetUser.id])

  useEffect(() => { requestLs([]) }, [requestLs])

  useEffect(() => {
    return addListener((msg) => {
      // Not keyed by fromUserId like the rest of this listener — target_offline is a
      // synthesized reply for a target the server has no way to reach at all, so there's
      // no fromUserId to match on; the server includes the userId the admin actually
      // targeted instead. For quick_pull_ls specifically this means the device has never
      // registered an FCM token (never actually logged in on that device) — routine
      // offline/dormant no longer applies, since quick-pull doesn't need a live connection.
      if (msg.type === 'target_offline' && msg.userId === targetUser.id && msg.action === 'quick_pull_ls') {
        clearTimeout(lsTimeoutRef.current)
        setLoading(false)
        setOffline(true)
        return
      }

      if (msg.fromUserId !== targetUser.id) return

      // ── Directory listing ──────────────────────────────────────────────
      if (msg.type === 'ls_result') {
        clearTimeout(lsTimeoutRef.current)
        setLoading(false)
        if (msg.error) { setError(msg.error); return }
        setPath(msg.path || [])
        setEntries(
          (msg.entries || []).sort((a, b) => {
            if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
            return a.name.localeCompare(b.name)
          })
        )
      }

      // ── File ready — server notifies us with the download URL ──────────
      if (msg.type === 'file_ready') {
        // Defense in depth on top of the server's own upload-token check: ignore a
        // requestId this admin session never actually asked for, rather than trusting the
        // event just because fromUserId matched.
        if (!pendingRef.current[msg.requestId]) return
        const pending = pendingRef.current[msg.requestId]
        delete pendingRef.current[msg.requestId]
        clearTimeout(timeoutRef.current[msg.requestId])
        delete timeoutRef.current[msg.requestId]
        // The server's checkAdminAuth gates plain GETs here behind the admin PIN, since
        // an <img>/<video> tag can't carry the WebSocket session or a custom header.
        const fileUrl = `${location.origin}/api/file/${msg.requestId}?pin=${encodeURIComponent(adminPin || '')}`
        const name    = msg.name || pending?.name || 'file'
        const mime    = msg.mimeType || pending?.mimeType || ''
        const size    = msg.size || pending?.size || 0
        const ptype   = previewType(mime)

        // Direct download — skip preview modal
        if (pending?.forceDownload) {
          const a = document.createElement('a')
          a.href = fileUrl; a.download = name; a.click()
          setPreview(null)
          return
        }

        if (ptype === 'text') {
          // Fetch text content to display inline
          fetch(fileUrl).then(r => r.text()).then(text => {
            setPreview({ ready: true, ptype, name, mimeType: mime, size, url: fileUrl, text, requestId: msg.requestId })
          }).catch(() => {
            setPreview({ ready: true, ptype: 'download', name, mimeType: mime, size, url: fileUrl, requestId: msg.requestId })
          })
        } else {
          setPreview({ ready: true, ptype, name, mimeType: mime, size, url: fileUrl, requestId: msg.requestId })
        }
      }

      // ── File error from child ──────────────────────────────────────────
      if (msg.type === 'file_error') {
        const pending = pendingRef.current[msg.requestId]
        delete pendingRef.current[msg.requestId]
        clearTimeout(timeoutRef.current[msg.requestId])
        delete timeoutRef.current[msg.requestId]
        setPreview({ error: msg.error || 'Transfer failed', filePath: pending?.filePath, mimeType: pending?.mimeType })
      }
    })
  }, [addListener, targetUser.id])

  const enterDir  = (name) => requestLs([...path, name])
  const navigateTo = (index) => requestLs(path.slice(0, index))

  const openFile = (entry, forceDownload = false) => {
    const requestId = Math.random().toString(36).slice(2)
    const filePath  = [...path, entry.name]
    pendingRef.current[requestId] = { name: entry.name, mimeType: entry.mimeType, size: entry.size, filePath, forceDownload }
    setPreview({ loading: true, name: entry.name, mimeType: entry.mimeType, size: entry.size, requestId, filePath })
    sendMsg({ type: 'quick_pull_read_file', targetId: targetUser.id, path: filePath, requestId, preview: !forceDownload })

    // Auto-fail if no response within 30 seconds
    timeoutRef.current[requestId] = setTimeout(() => {
      if (pendingRef.current[requestId]) {
        delete pendingRef.current[requestId]
        setPreview({ error: 'Transfer timed out. Check device connection.', filePath, mimeType: entry.mimeType })
      }
    }, 30000)
  }

  const retryFile = () => {
    if (preview?.filePath) {
      const entry = { name: preview.filePath[preview.filePath.length - 1], mimeType: preview.mimeType, size: preview.size }
      // Navigate to parent path first, then request
      const requestId = Math.random().toString(36).slice(2)
      pendingRef.current[requestId] = { name: entry.name, mimeType: entry.mimeType, size: entry.size, filePath: preview.filePath }
      setPreview({ loading: true, name: entry.name, mimeType: entry.mimeType, size: entry.size, requestId, filePath: preview.filePath })
      sendMsg({ type: 'quick_pull_read_file', targetId: targetUser.id, path: preview.filePath, requestId })
    } else {
      setPreview(null)
    }
  }

  const closePreview = useCallback(() => setPreview(null), [])

  // Android hardware back button — close preview or navigate up
  useEffect(() => {
    if (!IS_NATIVE) return
    const handler = CapApp.addListener('backButton', () => {
      if (preview) { closePreview(); return }
      if (path.length > 0) requestLs(path.slice(0, -1))
    })
    return () => { handler.then(h => h.remove()) }
  }, [preview, path, closePreview, requestLs])

  return (
    <div className="remote-browser">
      <div className="rb-header">
        <h2 className="rb-title">📱 {targetUser.name}'s Device</h2>
        {loading && <span className="rb-spinner">↻</span>}
        <button className="rb-refresh" onClick={() => requestLs(path)} title="Refresh">⟳</button>
      </div>

      <nav className="breadcrumb">
        <button className="breadcrumb-btn" onClick={() => navigateTo(0)}>root</button>
        {path.map((seg, i) => (
          <span key={i}>
            <span className="breadcrumb-sep">/</span>
            <button className="breadcrumb-btn" onClick={() => navigateTo(i + 1)}>{seg}</button>
          </span>
        ))}
      </nav>

      {error && (
        <div className="browser-error">
          <span>{error}</span>
          <button className="browser-error-retry" onClick={() => { setError(null); requestLs(path) }}>Retry</button>
          <button className="browser-error-dismiss" aria-label="Dismiss error" onClick={() => setError(null)}>✕</button>
        </div>
      )}

      <div className="rb-list">
        {offline && !entries && !error && (
          <div className="rb-waiting rb-offline">
            {targetUser.name}'s device has never connected.
            <p className="rb-waiting-sub">
              Files only become reachable once meeee has been opened and logged into on
              their device at least once.
            </p>
          </div>
        )}
        {!offline && !entries && !error && (
          <div className="rb-waiting">
            Fetching {targetUser.name}'s files…
          </div>
        )}
        {entries?.length === 0 && <div className="no-files">This folder is empty</div>}

        {entries?.map((entry) => (
          <div key={entry.name} className="file-item"
            onClick={() => entry.kind === 'directory' ? enterDir(entry.name) : null}>
            <span className="file-item-icon">{fileIcon(entry.mimeType, entry.kind)}</span>
            <span className="file-item-info">
              <span className="file-item-name">{entry.name}</span>
              <span className="file-item-detail">
                {entry.kind === 'file' ? formatBytes(entry.size) : 'folder'}
              </span>
            </span>
            {entry.kind === 'file' && (
              <div className="file-item-actions">
                <button className="file-preview-btn" title="Preview"
                  onClick={(e) => { e.stopPropagation(); openFile(entry, false) }}>
                  👁
                </button>
                <button className="file-download-btn" title="Download"
                  onClick={(e) => { e.stopPropagation(); openFile(entry, true) }}>
                  ⬇
                </button>
              </div>
            )}
            {entry.kind === 'directory' && <span className="dir-arrow">›</span>}
          </div>
        ))}
      </div>

      {/* Preview modal */}
      {preview && (
        <div className="preview-overlay" onClick={(e) => e.target === e.currentTarget && closePreview()}>
          <div className="preview-card">
            <div className="preview-header">
              <span className="preview-name" title={preview.name}>{preview.name}</span>
              <button className="close-btn" onClick={closePreview}>✕</button>
            </div>

            {/* Loading spinner — no progress bar needed, server handles transfer */}
            {preview.loading && (
              <div className="preview-progress-wrap">
                <div className="http-transfer-spinner">↻</div>
                <p className="preview-progress-label">Transferring {preview.name}…</p>
              </div>
            )}

            {/* Error + retry */}
            {preview.error && (
              <div className="preview-error-wrap">
                <p className="preview-error">{preview.error}</p>
                <button className="retry-btn" onClick={retryFile}>↺ Retry</button>
              </div>
            )}

            {/* Image */}
            {preview.ready && preview.ptype === 'image' && (
              <img src={preview.url} alt={preview.name} className="preview-image" />
            )}

            {/* Video */}
            {preview.ready && preview.ptype === 'video' && (
              <video src={preview.url} className="preview-video" controls autoPlay playsInline />
            )}

            {/* Audio */}
            {preview.ready && preview.ptype === 'audio' && (
              <div className="preview-audio-wrap">
                <div className="preview-audio-icon">🎵</div>
                <div className="preview-audio-name">{preview.name}</div>
                <audio src={preview.url} controls className="preview-audio" />
              </div>
            )}

            {/* PDF */}
            {preview.ready && preview.ptype === 'pdf' && (
              <iframe
                src={preview.url}
                className="preview-pdf"
                title={preview.name}
              />
            )}

            {/* Text / code */}
            {preview.ready && preview.ptype === 'text' && (
              <pre className="preview-text">{preview.text}</pre>
            )}

            {/* Unknown — download only */}
            {preview.ready && preview.ptype === 'download' && (
              <div className="preview-unknown">
                <div className="preview-unknown-icon">{fileIcon(preview.mimeType, 'file')}</div>
                <div className="preview-unknown-name">{preview.name}</div>
                <div className="preview-unknown-mime">{preview.mimeType || 'Unknown type'}</div>
              </div>
            )}

            {/* Download + file info */}
            {preview.ready && (
              <div className="preview-footer">
                <span className="preview-size">{formatBytes(preview.size)}</span>
                <a href={preview.url} download={preview.name} className="download-btn">⬇ Download</a>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
