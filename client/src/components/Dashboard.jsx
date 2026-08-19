import { useEffect, useMemo, useState } from 'react'
import { computeHomeStats } from '../utils/milestoneStats'

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

const CATEGORY_ICON = {
  upi: 'smartphone', bank: 'account_balance', food: 'restaurant', shopping: 'shopping_cart',
  transport: 'directions_car', utilities: 'bolt', manual: 'edit_note',
}

export default function Dashboard({ session, onSelect, sendMsg, addListener }) {
  const [txns, setTxns] = useState([])
  const [khataContacts, setKhataContacts] = useState([])
  const [khataEntries, setKhataEntries] = useState([])
  const [goals, setGoals] = useState([])
  const [tasks, setTasks] = useState([])
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
      if (msg.type === 'ledger_data') {
        setKhataContacts(msg.contacts || [])
        setKhataEntries(msg.entries || [])
      }
      if (msg.type === 'milestone_data') {
        setGoals(msg.goals || [])
        setTasks(msg.tasks || [])
      }
    })
  }, [addListener, session.userId])

  useEffect(() => {
    sendMsg({ type: 'transactions_get' })
    sendMsg({ type: 'ledger_data_get' })
    sendMsg({ type: 'milestone_data_get' })
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

  // Same net-balance math as KhatabookPanel.jsx's own `totals` — a contact who owes the
  // user shouldn't cancel out against a different contact the user owes, so the two sides
  // are summed separately before netting for this one-number tile.
  const khataNet = useMemo(() => {
    const balances = {}
    khataEntries.forEach(e => {
      const delta = e.type === 'gave' ? e.amount : -e.amount
      balances[e.contactId] = (balances[e.contactId] || 0) + delta
    })
    let youllGet = 0, youllPay = 0
    khataContacts.forEach(c => {
      const bal = balances[c.id] || 0
      if (bal > 0) youllGet += bal
      else youllPay += -bal
    })
    return youllGet - youllPay
  }, [khataContacts, khataEntries])

  const activeGoals = useMemo(() => goals.filter(g => g.status !== 'archived'), [goals])
  const milestoneStats = useMemo(() => computeHomeStats(activeGoals, tasks), [activeGoals, tasks])

  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="dashboard">
      <span className="hub-meteors" aria-hidden="true">
        <i className="hub-meteor" style={{ left: '15%', animationDelay: '0s' }} />
        <i className="hub-meteor" style={{ left: '55%', animationDelay: '2.6s' }} />
        <i className="hub-meteor" style={{ left: '80%', animationDelay: '5.2s' }} />
      </span>

      <div className="dash-header">
        <span className="dash-greeting">Welcome back</span>
        <h1 className="dash-name">{session.name}</h1>
        <span className="dash-date">{dateLabel}</span>
      </div>

      <div className="dash-stats">
        <button className="dash-stat dash-stat--gold" onClick={() => onSelect('namaz')}>
          <span className="dash-stat-icon-wrap"><span className="material-symbols-outlined">mosque</span></span>
          <span className="dash-stat-value">{namazCount}/5</span>
          <span className="dash-stat-label">Namaz</span>
          <span className="dash-stat-bar">
            <span className="dash-stat-bar-fill" style={{ width: `${Math.min(namazCount / 5, 1) * 100}%` }} />
          </span>
        </button>

        <button className="dash-stat dash-stat--emerald" onClick={() => onSelect('workout')}>
          <span className="dash-stat-icon-wrap"><span className="material-symbols-outlined">fitness_center</span></span>
          <span className="dash-stat-value">{workoutMinutes}m</span>
          <span className="dash-stat-label">Workout</span>
          <span className="dash-stat-bar">
            <span className="dash-stat-bar-fill" style={{ width: `${Math.min(workoutMinutes / WORKOUT_GOAL_MIN, 1) * 100}%` }} />
          </span>
        </button>

        <button className="dash-stat dash-stat--rose" onClick={() => onSelect('transactions')}>
          <span className="dash-stat-icon-wrap"><span className="material-symbols-outlined">payments</span></span>
          <span className={`dash-stat-value ${netToday >= 0 ? 'dash-stat-value--pos' : 'dash-stat-value--neg'}`}>
            {formatINR(Math.abs(netToday))}
          </span>
          <span className="dash-stat-label">Finance</span>
        </button>

        <button className="dash-stat dash-stat--khata" onClick={() => onSelect('khatabook')}>
          <span className="dash-stat-icon-wrap"><span className="material-symbols-outlined">account_balance_wallet</span></span>
          <span className={`dash-stat-value ${khataNet >= 0 ? 'dash-stat-value--pos' : 'dash-stat-value--neg'}`}>
            {formatINR(Math.abs(khataNet))}
          </span>
          <span className="dash-stat-label">{khataNet >= 0 ? "You'll Get" : "You'll Pay"}</span>
        </button>

        <button className="dash-stat dash-stat--milestone" onClick={() => onSelect('milestone')}>
          <span className="dash-stat-icon-wrap"><span className="material-symbols-outlined">flag</span></span>
          <span className="dash-stat-value">{milestoneStats ? `${milestoneStats.onTrack}/${milestoneStats.total}` : '—'}</span>
          <span className="dash-stat-label">On Track</span>
          {milestoneStats && (
            <span className="dash-stat-bar">
              <span className="dash-stat-bar-fill" style={{ width: `${(milestoneStats.onTrack / milestoneStats.total) * 100}%`, background: 'var(--hub-accent)' }} />
            </span>
          )}
        </button>
      </div>

      <div className="dash-activity">
        <h2 className="dash-section-title">Today's activity</h2>
        {todayTxns.length === 0 ? (
          <div className="dash-empty-state">
            <span className="material-symbols-outlined">history_toggle_off</span>
            <span className="dash-empty-text">No activity yet today — it'll show up here as it happens.</span>
          </div>
        ) : (
          <div className="dash-activity-list">
            {todayTxns.slice(0, 5).map(t => (
              <div key={t.id} className="dash-activity-row">
                <span className="material-symbols-outlined dash-activity-icon">{CATEGORY_ICON[t.category] || 'credit_card'}</span>
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
