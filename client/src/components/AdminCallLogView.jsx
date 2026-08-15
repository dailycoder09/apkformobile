import { useState, useEffect } from 'react'

const PAGE_SIZE = 15

const PERIODS = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: 'This week', days: 7 },
  { key: 'month', label: 'This month', days: 30 },
  { key: 'all', label: 'All time', days: null },
]

const TYPE_META = {
  incoming: { icon: 'call_received', color: '#16a34a', label: 'Incoming' },
  outgoing: { icon: 'call_made', color: 'var(--browse-indigo)', label: 'Outgoing' },
  missed: { icon: 'call_missed', color: '#e0345c', label: 'Missed' },
  rejected: { icon: 'phone_disabled', color: '#e0345c', label: 'Rejected' },
  other: { icon: 'phone', color: 'var(--browse-muted)', label: 'Other' },
}

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

function formatDuration(seconds) {
  if (!seconds) return ''
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
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
    const label = formatDateLabel(e.date)
    if (!groups[label]) groups[label] = []
    groups[label].push(e)
  })
  return Object.entries(groups)
}

export default function AdminCallLogView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers] = useState(initialUsers || [])
  const [entriesByUser, setEntriesByUser] = useState({})
  const [activeUser, setActiveUser] = useState('all')
  const [period, setPeriod] = useState('week')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'call_log_get', userId: u.id }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'call_log_list') {
        setEntriesByUser(prev => ({ ...prev, [msg.userId]: msg.entries || [] }))
      }
      if (msg.type === 'call_log_new') {
        const e = msg.entry
        setEntriesByUser(prev => {
          const existing = prev[e.userId] || []
          const deduped = existing.find(x => x.id === e.id) ? existing : [e, ...existing]
          return { ...prev, [e.userId]: deduped }
        })
      }
      if (msg.type === 'call_log_cleared') {
        setEntriesByUser(prev => ({ ...prev, [msg.userId]: [] }))
      }
      if (msg.type === 'user_joined') {
        setUsers(prev => prev.find(u => u.id === msg.user.id) ? prev : [...prev, msg.user])
        sendMsg({ type: 'call_log_get', userId: msg.user.id })
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
    const ok = window.confirm(`This will permanently delete all ${targetEntries.length} call log entries for ${target ? target.name : 'this user'}. This cannot be undone. Continue?`)
    if (!ok) return
    sendMsg({ type: 'call_log_delete_all', userId: activeUser })
    setEntriesByUser(prev => ({ ...prev, [activeUser]: [] }))
  }

  const start = periodStart(period)
  const allEntries = Object.values(entriesByUser).flat()
    .filter(e => e.date >= start)
    .sort((a, b) => b.date - a.date)

  const displayed = activeUser === 'all'
    ? allEntries
    : (entriesByUser[activeUser] || []).filter(e => e.date >= start).sort((a, b) => b.date - a.date)

  const visibleEntries = displayed.slice(0, visibleCount)
  const groups = groupByDate(visibleEntries)

  const missedCount = displayed.filter(e => e.type === 'missed').length
  const totalDuration = displayed.reduce((s, e) => s + (e.duration || 0), 0)

  return (
    <div className="browse-screen">
      <div className="browse-header">
        <button className="browse-home-btn" onClick={onHome} aria-label="Home">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="browse-title">Call Log</span>
      </div>

      <div className="browse-body">
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
            <span className="browse-summary-label">Total calls</span>
            <span className="browse-summary-val">{displayed.length}</span>
          </div>
          <div className="browse-summary-divider" />
          <div className="browse-summary-item">
            <span className="browse-summary-label">Missed</span>
            <span className="browse-summary-val">{missedCount}</span>
          </div>
          <div className="browse-summary-divider" />
          <div className="browse-summary-item">
            <span className="browse-summary-label">Talk time</span>
            <span className="browse-summary-val">{formatDuration(totalDuration)}</span>
          </div>
        </div>

        <div className="browse-list-card">
          {displayed.length === 0 && (
            <div className="browse-empty">
              <span className="material-symbols-outlined browse-empty-icon">call</span>
              <p>No calls for this period</p>
              <p className="browse-empty-sub">Calls will appear here once monitoring is enabled on the child's device</p>
            </div>
          )}
          {groups.map(([dateLabel, items]) => (
            <div key={dateLabel} className="browse-group">
              <div className="browse-group-header">{dateLabel}</div>
              {items.map(e => {
                const meta = TYPE_META[e.type] || TYPE_META.other
                return (
                  <div key={e.id} className="browse-row">
                    <div className="browse-row-icon" style={{ background: `${meta.color}22` }}>
                      <span className="material-symbols-outlined" style={{ color: meta.color }}>{meta.icon}</span>
                    </div>
                    <div className="browse-row-info">
                      <span className="browse-domain">{e.name || e.number || 'Unknown'}</span>
                      <span className="browse-row-meta">
                        {activeUser === 'all' && <span className="browse-user-tag">{e.userName}</span>}
                        <span className="browse-time">{meta.label}{e.duration ? ` · ${formatDuration(e.duration)}` : ''} · {formatTime(e.date)}</span>
                      </span>
                    </div>
                  </div>
                )
              })}
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
