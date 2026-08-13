import { useState, useEffect, useCallback, useRef } from 'react'

function formatTs(ts) {
  const d = new Date(ts)
  const today = new Date()
  const isToday = d.toDateString() === today.toDateString()
  const time = d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  return isToday ? `Today ${time}` : `${d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })} ${time}`
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// Admin access is exclusively via the ?pin= URL param (see App.jsx's getPinFromUrl) — no
// separate admin session/token exists, so screenshot requests reuse that same PIN, both as
// a fetch() header and (for plain <img> tags, which can't carry headers) a query param.
function getPin() {
  return new URLSearchParams(window.location.search).get('pin') || ''
}

export default function ScreenshotsPanel({ targetUser }) {
  const [shots, setShots]       = useState([])
  const [expanded, setExpanded] = useState(null)  // { id, url }
  const [loading, setLoading]   = useState(false)
  const blobUrls                = useRef([])

  const fetchList = useCallback(async () => {
    if (!targetUser?.id) return
    setLoading(true)
    try {
      const res  = await fetch(`/api/screenshots/${targetUser.id}`, { headers: { 'X-Admin-Pin': getPin() } })
      const data = await res.json()
      setShots(data.screenshots || [])
    } catch { /* server may not have any */ }
    setLoading(false)
  }, [targetUser?.id])

  useEffect(() => {
    fetchList()
    const t = setInterval(fetchList, 30_000)
    return () => {
      clearInterval(t)
      // Revoke all blob URLs on unmount
      blobUrls.current.forEach(URL.revokeObjectURL)
    }
  }, [fetchList])

  const openFull = async (id) => {
    try {
      const res  = await fetch(`/api/screenshot/${id}`, { headers: { 'X-Admin-Pin': getPin() } })
      const blob = await res.blob()
      const url  = URL.createObjectURL(blob)
      blobUrls.current.push(url)
      setExpanded({ id, url })
    } catch { /* expired */ }
  }

  return (
    <div className="ss-panel">
      <div className="ss-header">
        <span className="ss-title">📸 Screenshots — {targetUser.name}</span>
        <button className="ss-refresh-btn" onClick={fetchList} disabled={loading}>
          {loading ? '↻' : '↺'} Refresh
        </button>
      </div>

      {shots.length === 0 && !loading && (
        <div className="ss-empty">
          <span>📵</span>
          <p>No screenshots yet — child's device will capture every 30s while active</p>
        </div>
      )}

      <div className="ss-grid">
        {shots.map(s => (
          <div key={s.id} className="ss-thumb-wrap" onClick={() => openFull(s.id)}>
            <img
              className="ss-thumb"
              src={`/api/screenshot/${s.id}?pin=${encodeURIComponent(getPin())}`}
              alt={formatTs(s.ts)}
              loading="lazy"
            />
            <div className="ss-thumb-label">
              <span className="ss-time">{formatTs(s.ts)}</span>
              <span className="ss-size">{formatSize(s.size)}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Full-size overlay */}
      {expanded && (
        <div className="ss-overlay" onClick={() => setExpanded(null)}>
          <div className="ss-overlay-inner" onClick={e => e.stopPropagation()}>
            <button className="ss-close-btn" onClick={() => setExpanded(null)}>✕</button>
            <img className="ss-full-img" src={expanded.url} alt="Screenshot" />
          </div>
        </div>
      )}
    </div>
  )
}
