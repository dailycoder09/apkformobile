import { useState } from 'react'

function formatBytes(b) {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

async function listDir(dirHandle) {
  const entries = []
  for await (const [name, handle] of dirHandle.entries()) {
    entries.push({ name, kind: handle.kind, handle })
  }
  return entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export default function FolderBrowser({ onShareFile, onClose }) {
  const [entries, setEntries] = useState(null)
  const [path, setPath] = useState([])
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const supportsAPI = 'showDirectoryPicker' in window

  const openRoot = async () => {
    try {
      setLoading(true)
      setError(null)
      const handle = await window.showDirectoryPicker({ mode: 'read' })
      const items = await listDir(handle)
      setEntries(items)
      setPath([{ name: handle.name, handle }])
    } catch (e) {
      if (e.name !== 'AbortError') setError('Could not open folder. Permission may have been denied.')
    } finally {
      setLoading(false)
    }
  }

  const enterDir = async (entry) => {
    try {
      setLoading(true)
      const items = await listDir(entry.handle)
      setEntries(items)
      setPath((p) => [...p, { name: entry.name, handle: entry.handle }])
    } catch {
      setError('Could not read directory.')
    } finally {
      setLoading(false)
    }
  }

  const navigateTo = async (index) => {
    try {
      setLoading(true)
      const target = path[index]
      const items = await listDir(target.handle)
      setEntries(items)
      setPath((p) => p.slice(0, index + 1))
    } finally {
      setLoading(false)
    }
  }

  const shareFile = async (entry) => {
    try {
      const file = await entry.handle.getFile()
      onShareFile(entry.name, file.size)
    } catch {
      setError('Could not read file info.')
    }
  }

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div className="modal-overlay" onClick={handleOverlayClick}>
      <div className="folder-browser">
        <div className="folder-header">
          <h2>Folder Browser</h2>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>

        {!supportsAPI && (
          <div className="browser-warning">
            File System Access API is not supported in this browser.
            Try Chrome on Android or Chrome desktop.
          </div>
        )}

        {error && (
          <div className="browser-error">{error}</div>
        )}

        {path.length > 0 && (
          <div className="breadcrumb">
            {path.map((p, i) => (
              <span key={i} className="breadcrumb-item">
                <button className="breadcrumb-btn" onClick={() => navigateTo(i)}>
                  {p.name}
                </button>
                {i < path.length - 1 && <span className="breadcrumb-sep">/</span>}
              </span>
            ))}
          </div>
        )}

        {entries === null ? (
          <div className="folder-pick-area">
            <p className="folder-hint">Pick a folder to browse its files</p>
            <button
              className="pick-btn"
              onClick={openRoot}
              disabled={!supportsAPI || loading}
            >
              {loading ? 'Loading…' : '📂 Pick Folder'}
            </button>
          </div>
        ) : (
          <div className="file-list">
            {loading && <div className="file-list-loading">Loading…</div>}
            {!loading && entries.length === 0 && (
              <div className="no-files">This folder is empty</div>
            )}
            {entries.map((entry) => (
              <div key={entry.name} className="file-item">
                <span className="file-item-icon">
                  {entry.kind === 'directory' ? '📁' : '📄'}
                </span>
                <span className="file-item-name">
                  {entry.kind === 'directory' ? (
                    <button className="dir-btn" onClick={() => enterDir(entry)}>
                      {entry.name}
                    </button>
                  ) : (
                    entry.name
                  )}
                </span>
                {entry.kind === 'file' && (
                  <button className="share-btn" onClick={() => shareFile(entry)}>
                    Share
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
