import { useState, useEffect, useMemo } from 'react'

const PAGE_SIZE = 15

const PERIODS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: 'This week', days: 7 },
  { key: 'month', label: 'This month', days: 30 },
  { key: 'all', label: 'All time', days: null },
]

function periodStart(period) {
  const opt = PERIODS.find(o => o.key === period)
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (!opt || !opt.days) return 0
  d.setDate(d.getDate() - (opt.days - 1))
  return d.getTime()
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function formatDateLabel(ms) {
  const d = new Date(ms)
  const today = new Date(); today.setHours(0,0,0,0)
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1)
  d.setHours(0,0,0,0)
  if (d.getTime() === today.getTime()) return 'Today'
  if (d.getTime() === yesterday.getTime()) return 'Yesterday'
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
}

function groupByDate(entries) {
  const groups = {}
  entries.forEach(e => {
    const label = formatDateLabel(e.timestamp)
    if (!groups[label]) groups[label] = []
    groups[label].push(e)
  })
  return Object.entries(groups)
}

export default function AdminBrowsingView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers] = useState(initialUsers || [])
  const [entriesByUser, setEntriesByUser] = useState({})
  const [activeUser, setActiveUser] = useState('all')
  const [period, setPeriod] = useState('week')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'browsing_get', userId: u.id }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'browsing_list') {
        setEntriesByUser(prev => ({ ...prev, [msg.userId]: msg.entries || [] }))
      }
      if (msg.type === 'browsing_new') {
        const e = msg.entry
        setEntriesByUser(prev => {
          const existing = prev[e.userId] || []
          const deduped = existing.find(x => x.id === e.id) ? existing : [e, ...existing]
          return { ...prev, [e.userId]: deduped }
        })
      }
      if (msg.type === 'browsing_cleared') {
        setEntriesByUser(prev => ({ ...prev, [msg.userId]: [] }))
      }
      if (msg.type === 'user_joined') {
        setUsers(prev => prev.find(u => u.id === msg.user.id) ? prev : [...prev, msg.user])
        sendMsg({ type: 'browsing_get', userId: msg.user.id })
      }
      if (msg.type === 'user_left') {
        setUsers(prev => prev.filter(u => u.id !== msg.userId))
      }
    })
  }, [addListener, sendMsg])

  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [activeUser, period])

  function clearHistoryForUser() {
    if (activeUser === 'all') return
    const targetEntries = entriesByUser[activeUser] || []
    if (targetEntries.length === 0) return
    const target = users.find(u => u.id === activeUser)
    const ok = window.confirm(`This will permanently delete all ${targetEntries.length} browsing history entries for ${target ? target.name : 'this user'}. This cannot be undone. Continue?`)
    if (!ok) return
    sendMsg({ type: 'browsing_delete_all', userId: activeUser })
    setEntriesByUser(prev => ({ ...prev, [activeUser]: [] }))
  }

  const start = periodStart(period)
  const allEntries = Object.values(entriesByUser).flat()
    .filter(e => e.timestamp >= start)
    .sort((a, b) => b.timestamp - a.timestamp)

  const displayed = activeUser === 'all'
    ? allEntries
    : (entriesByUser[activeUser] || []).filter(e => e.timestamp >= start).sort((a, b) => b.timestamp - a.timestamp)

  const visibleEntries = displayed.slice(0, visibleCount)
  const groups = groupByDate(visibleEntries)

  const topDomains = useMemo(() => {
    const counts = {}
    displayed.forEach(e => { counts[e.domain] = (counts[e.domain] || 0) + 1 })
    return Object.entries(counts)
      .map(([domain, count]) => ({ domain, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8)
  }, [displayed])
  const topMax = Math.max(1, ...topDomains.map(d => d.count))

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <button className="browse-home-btn" onClick={onHome} aria-label="Home">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="browse-title">Browsing Activity</span>
      </div>

      <div className="browse-body">
        <p className="browse-notice">
          Shows sites visited in Chrome on the child's device (other browsers aren't supported
          yet). Enable via Settings → Accessibility on the device. Usually shows the domain;
          full page addresses appear only when the address bar is actively tapped.
        </p>

        <div className="browse-user-tabs">
          <button className={`browse-user-tab${activeUser === 'all' ? ' active' : ''}`}
            onClick={() => setActiveUser('all')}>All</button>
          {users.map(u => (
            <button key={u.id}
              className={`browse-user-tab${activeUser === u.id ? ' active' : ''}`}
              onClick={() => setActiveUser(u.id)}>
              {u.name}
            </button>
          ))}
        </div>

        <div className="browse-period">
          {PERIODS.map(p => (
            <button key={p.key} className={`browse-period-btn${period === p.key ? ' active' : ''}`}
              onClick={() => setPeriod(p.key)}>{p.label}</button>
          ))}
        </div>

        {/* Delete history — scoped to whichever family member is selected; clearing "all"
            family members at once is a much more dangerous action and isn't offered here */}
        {activeUser !== 'all' && (
          <button className="browse-clear-all-btn" onClick={clearHistoryForUser} disabled={(entriesByUser[activeUser] || []).length === 0}>
            <span className="material-symbols-outlined">delete_sweep</span>
            Delete history for {users.find(u => u.id === activeUser)?.name || 'this user'}
          </button>
        )}

        <div className="browse-summary">
          <div className="browse-summary-item">
            <span className="browse-summary-label">Domains visited</span>
            <span className="browse-summary-val">{displayed.length}</span>
          </div>
          <div className="browse-summary-divider" />
          <div className="browse-summary-item">
            <span className="browse-summary-label">Unique sites</span>
            <span className="browse-summary-val">{new Set(displayed.map(e => e.domain)).size}</span>
          </div>
        </div>

        <div className="browse-top-card">
          <div className="browse-top-title">Most visited</div>
          {topDomains.length === 0 ? (
            <p className="browse-empty-sub">Nothing in this period.</p>
          ) : topDomains.map(d => (
            <div key={d.domain} className="txn-breakdown-row">
              <span className="txn-breakdown-label">{d.domain}</span>
              <div className="txn-breakdown-bar">
                <span className="txn-breakdown-fill" style={{
                  width: `${(d.count / topMax) * 100}%`,
                  background: 'linear-gradient(90deg, var(--browse-indigo), var(--browse-indigo-dark))',
                }} />
              </div>
              <span className="txn-breakdown-val">{d.count}</span>
            </div>
          ))}
        </div>

        <div className="browse-list-card">
          {displayed.length === 0 && (
            <div className="browse-empty">
              <span className="material-symbols-outlined browse-empty-icon">travel_explore</span>
              <p>No browsing activity for this period</p>
              <p className="browse-empty-sub">Domains will appear here once monitoring is enabled on the child's device</p>
            </div>
          )}
          {groups.map(([dateLabel, items]) => (
            <div key={dateLabel} className="browse-group">
              <div className="browse-group-header">{dateLabel}</div>
              {items.map(e => (
                <div key={e.id} className="browse-row">
                  <div className="browse-row-icon">
                    <span className="material-symbols-outlined">language</span>
                  </div>
                  <div className="browse-row-info">
                    <span className="browse-domain">{e.domain}</span>
                    <span className="browse-row-meta">
                      {activeUser === 'all' && <span className="browse-user-tag">{e.userName}</span>}
                      <span className="browse-time">{formatTime(e.timestamp)}</span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {displayed.length > visibleCount && (
            <button className="browse-load-more" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
              Load 15 more ({displayed.length - visibleCount} remaining)
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
