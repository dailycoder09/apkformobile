import { useEffect, useMemo, useState } from 'react'

const CATEGORY_EMOJI = {
  upi: '📱', bank: '🏦', food: '🍕', shopping: '🛒',
  transport: '🚗', utilities: '⚡', manual: '📝',
}

const WORKOUT_GOAL_MIN = 30

function todayKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function relativeTime(ms) {
  const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function readNamazCount() {
  try {
    const all = JSON.parse(localStorage.getItem('meeee_namaz') || '{}')
    const today = all[todayKey()] || {}
    return Object.values(today).filter(Boolean).length
  } catch {
    return 0
  }
}

function readWorkoutMinutes() {
  try {
    const all = JSON.parse(localStorage.getItem('meeee_workout') || '{}')
    const sessions = all[todayKey()] || []
    return sessions.reduce((sum, s) => sum + (s.minutes || 0), 0)
  } catch {
    return 0
  }
}

export default function Dashboard({ session, onSelect, sendMsg, addListener }) {
  const [txns, setTxns] = useState([])
  const namazCount = readNamazCount()
  const workoutMinutes = readWorkoutMinutes()

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'transactions_list' && msg.userId === session.userId) {
        setTxns(msg.transactions || [])
      }
      if (msg.type === 'transaction_new' && msg.fromUserId === session.userId) {
        setTxns(prev => (prev.find(t => t.id === msg.transaction.id) ? prev : [msg.transaction, ...prev]))
      }
    })
  }, [addListener, session.userId])

  useEffect(() => {
    sendMsg({ type: 'transactions_get' })
  }, [sendMsg])

  const todayTxns = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    return txns
      .filter(t => t.date >= todayStart.getTime())
      .sort((a, b) => b.date - a.date)
  }, [txns])

  const netToday = useMemo(() => {
    const debit = todayTxns.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
    const credit = todayTxns.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
    return credit - debit
  }, [todayTxns])

  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="dashboard">
      <div className="dash-header">
        <span className="dash-greeting">Welcome back</span>
        <h1 className="dash-name">{session.name}</h1>
        <span className="dash-date">{dateLabel}</span>
      </div>

      <div className="dash-stats">
        <button className="dash-stat dash-stat--gold" onClick={() => onSelect('namaz')}>
          <span className="dash-stat-icon">🕌</span>
          <span className="dash-stat-value">{namazCount}/5</span>
          <span className="dash-stat-label">Namaz</span>
          <span className="dash-stat-bar">
            <span className="dash-stat-bar-fill" style={{ width: `${Math.min(namazCount / 5, 1) * 100}%` }} />
          </span>
        </button>

        <button className="dash-stat dash-stat--emerald" onClick={() => onSelect('workout')}>
          <span className="dash-stat-icon">💪</span>
          <span className="dash-stat-value">{workoutMinutes}m</span>
          <span className="dash-stat-label">Workout</span>
          <span className="dash-stat-bar">
            <span className="dash-stat-bar-fill" style={{ width: `${Math.min(workoutMinutes / WORKOUT_GOAL_MIN, 1) * 100}%` }} />
          </span>
        </button>

        <button className="dash-stat dash-stat--rose" onClick={() => onSelect('transactions')}>
          <span className="dash-stat-icon">💰</span>
          <span className={`dash-stat-value ${netToday >= 0 ? 'dash-stat-value--pos' : 'dash-stat-value--neg'}`}>
            {formatINR(Math.abs(netToday))}
          </span>
          <span className="dash-stat-label">Finance</span>
        </button>
      </div>

      <div className="dash-activity">
        <h2 className="dash-section-title">Today's activity</h2>
        {todayTxns.length === 0 ? (
          <p className="dash-empty">No activity yet today.</p>
        ) : (
          <div className="dash-activity-list">
            {todayTxns.slice(0, 5).map(t => (
              <div key={t.id} className="dash-activity-row">
                <span className="dash-activity-icon">{CATEGORY_EMOJI[t.category] || '💳'}</span>
                <span className="dash-activity-merchant">{t.merchant}</span>
                <span className={`dash-activity-amount ${t.type === 'credit' ? 'dash-activity-amount--pos' : 'dash-activity-amount--neg'}`}>
                  {t.type === 'credit' ? '+' : '-'}{formatINR(t.amount)}
                </span>
                <span className="dash-activity-time">{relativeTime(t.date)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
