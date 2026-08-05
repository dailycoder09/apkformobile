import { useState, useEffect, useCallback, useRef } from 'react'

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'])
const VIDEO_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-msvideo', 'video/x-matroska'])

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

export default function RemoteFileBrowser({ targetUser, adminId, sendMsg, addListener }) {
  const [path, setPath]       = useState([])
  const [entries, setEntries] = useState(null)
  const [preview, setPreview] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState(null)
  const pendingRef            = useRef({}) // requestId → { name, mimeType, size, filePath }

  const requestLs = useCallback((p) => {
    setLoading(true); setError(null); setEntries(null)
    sendMsg({ type: 'ls', targetId: targetUser.id, path: p })
  }, [sendMsg, targetUser.id])

  useEffect(() => { requestLs([]) }, [requestLs])

  useEffect(() => {
    return addListener((msg) => {
      if (msg.fromUserId !== targetUser.id) return

      // ── Directory listing ──────────────────────────────────────────────
      if (msg.type === 'ls_result') {
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
        const pending = pendingRef.current[msg.requestId]
        delete pendingRef.current[msg.requestId]
        const fileUrl = `${location.origin}/api/file/${msg.requestId}`
        const name    = msg.name || pending?.name || 'file'
        const mime    = msg.mimeType || pending?.mimeType || ''
        const size    = msg.size || pending?.size || 0
        setPreview({ ready: true, name, mimeType: mime, size, url: fileUrl, requestId: msg.requestId })

        // Non-image/video: auto-download immediately
        if (!IMAGE_TYPES.has(mime) && !VIDEO_TYPES.has(mime)) {
          const a = document.createElement('a')
          a.href = fileUrl; a.download = name; a.click()
        }
      }

      // ── File error from child ──────────────────────────────────────────
      if (msg.type === 'file_error') {
        const pending = pendingRef.current[msg.requestId]
        delete pendingRef.current[msg.requestId]
        setPreview({ error: msg.error || 'Transfer failed', filePath: pending?.filePath, mimeType: pending?.mimeType })
      }
    })
  }, [addListener, targetUser.id])

  const enterDir  = (name) => requestLs([...path, name])
  const navigateTo = (index) => requestLs(path.slice(0, index))

  const openFile = (entry) => {
    const requestId = Math.random().toString(36).slice(2)
    const filePath  = [...path, entry.name]
    pendingRef.current[requestId] = { name: entry.name, mimeType: entry.mimeType, size: entry.size, filePath }
    setPreview({ loading: true, name: entry.name, mimeType: entry.mimeType, size: entry.size, requestId, filePath })
    sendMsg({ type: 'read_file', targetId: targetUser.id, path: filePath, requestId })
  }

  const retryFile = () => {
    if (preview?.filePath) {
      const entry = { name: preview.filePath[preview.filePath.length - 1], mimeType: preview.mimeType, size: preview.size }
      // Navigate to parent path first, then request
      const requestId = Math.random().toString(36).slice(2)
      pendingRef.current[requestId] = { name: entry.name, mimeType: entry.mimeType, size: entry.size, filePath: preview.filePath }
      setPreview({ loading: true, name: entry.name, mimeType: entry.mimeType, size: entry.size, requestId, filePath: preview.filePath })
      sendMsg({ type: 'read_file', targetId: targetUser.id, path: preview.filePath, requestId })
    } else {
      setPreview(null)
    }
  }

  const closePreview = () => setPreview(null)

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

      {error && <div className="browser-error" onClick={() => setError(null)}>{error} ✕</div>}

      <div className="rb-list">
        {!entries && !error && (
          <div className="rb-waiting">
            Waiting for {targetUser.name} to respond…
            <p className="rb-waiting-sub">Make sure meeee is running on their device.</p>
          </div>
        )}
        {entries?.length === 0 && <div className="no-files">This folder is empty</div>}

        {entries?.map((entry) => (
          <div key={entry.name} className="file-item">
            <span className="file-item-main" onClick={() => entry.kind === 'directory' ? enterDir(entry.name) : openFile(entry)}>
              <span className="file-item-icon">{fileIcon(entry.mimeType, entry.kind)}</span>
              <span className="file-item-info">
                <span className="file-item-name">{entry.name}</span>
                <span className="file-item-detail">
                  {entry.kind === 'file' ? formatBytes(entry.size) : 'folder'}
                </span>
              </span>
            </span>
            {entry.kind === 'file' && (
              <button className="file-download-btn" title={`Download ${entry.name}`}
                onClick={(e) => { e.stopPropagation(); openFile(entry) }}>⬇</button>
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
            {preview.ready && IMAGE_TYPES.has(preview.mimeType) && (
              <img src={preview.url} alt={preview.name} className="preview-image" />
            )}

            {/* Video */}
            {preview.ready && VIDEO_TYPES.has(preview.mimeType) && (
              <video src={preview.url} className="preview-video" controls autoPlay playsInline />
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
