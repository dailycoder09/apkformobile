import { useState, useEffect } from 'react'

const CATEGORY_EMOJI = {
  upi: '📱', bank: '🏦', food: '🍕', shopping: '🛒',
  transport: '🚗', utilities: '⚡', manual: '📝', other: '💳',
}

function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
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

function groupByDate(txns) {
  const groups = {}
  txns.forEach(t => {
    const label = formatDateLabel(t.date)
    if (!groups[label]) groups[label] = []
    groups[label].push(t)
  })
  return Object.entries(groups)
}

function periodStart(period) {
  const d = new Date(); d.setHours(0,0,0,0)
  if (period === 'today') return d.getTime()
  if (period === 'week')  { d.setDate(d.getDate() - 6); return d.getTime() }
  if (period === 'month') { d.setDate(1); return d.getTime() }
  return 0
}

export default function AdminTransactionView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers]           = useState(initialUsers || [])
  const [txnsByUser, setTxnsByUser] = useState({})
  const [activeUser, setActiveUser] = useState('all')
  const [period, setPeriod]         = useState('week')

  // Request existing transactions for each connected user at mount
  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'transactions_get', userId: u.id }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for incoming transactions + user join/leave
  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'transactions_list') {
        setTxnsByUser(prev => ({ ...prev, [msg.userId]: msg.transactions || [] }))
      }
      if (msg.type === 'transaction_new') {
        const t = msg.transaction
        setTxnsByUser(prev => {
          const existing = prev[t.userId] || []
          const deduped  = existing.find(x => x.id === t.id) ? existing : [t, ...existing]
          return { ...prev, [t.userId]: deduped }
        })
      }
      if (msg.type === 'user_joined') {
        setUsers(prev => prev.find(u => u.id === msg.user.id) ? prev : [...prev, msg.user])
        sendMsg({ type: 'transactions_get', userId: msg.user.id })
      }
      if (msg.type === 'user_left') {
        setUsers(prev => prev.filter(u => u.id !== msg.userId))
      }
    })
  }, [addListener, sendMsg])

  // All transactions merged (across users), filtered by period
  const start = periodStart(period)
  const allTxns = Object.values(txnsByUser).flat()
    .filter(t => t.date >= start)
    .sort((a, b) => b.date - a.date)

  const userTxns = activeUser === 'all'
    ? allTxns
    : (txnsByUser[activeUser] || []).filter(t => t.date >= start).sort((a, b) => b.date - a.date)

  const displayed = userTxns
  const totalDebit  = displayed.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
  const totalCredit = displayed.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
  const groups = groupByDate(displayed)

  return (
    <div className="txn-screen">
      {/* Header */}
      <div className="txn-header">
        <button className="txn-home-btn" onClick={onHome} aria-label="Home">🏠</button>
        <span className="txn-title">Family Transactions</span>
      </div>

      {/* User filter tabs */}
      <div className="txn-user-tabs">
        <button className={`txn-user-tab${activeUser === 'all' ? ' active' : ''}`}
          onClick={() => setActiveUser('all')}>All</button>
        {users.map(u => (
          <button key={u.id}
            className={`txn-user-tab${activeUser === u.id ? ' active' : ''}`}
            onClick={() => setActiveUser(u.id)}>
            {u.name}
          </button>
        ))}
      </div>

      {/* Period selector */}
      <div className="txn-period">
        {[['today','Today'],['week','This Week'],['month','This Month']].map(([v,l]) => (
          <button key={v} className={`period-btn${period === v ? ' active' : ''}`}
            onClick={() => setPeriod(v)}>{l}</button>
        ))}
      </div>

      {/* Summary bar */}
      <div className="txn-summary">
        <div className="txn-summary-item debit">
          <span className="txn-summary-label">Spent</span>
          <span className="txn-summary-val">{formatINR(totalDebit)}</span>
        </div>
        <div className="txn-summary-divider" />
        <div className="txn-summary-item credit">
          <span className="txn-summary-label">Received</span>
          <span className="txn-summary-val">{formatINR(totalCredit)}</span>
        </div>
        <div className="txn-summary-divider" />
        <div className={`txn-summary-item ${totalCredit - totalDebit >= 0 ? 'credit' : 'debit'}`}>
          <span className="txn-summary-label">Net</span>
          <span className="txn-summary-val">{formatINR(Math.abs(totalCredit - totalDebit))}</span>
        </div>
      </div>

      {/* Transaction list */}
      <div className="txn-list">
        {displayed.length === 0 && (
          <div className="txn-empty">
            <div className="txn-empty-icon">📊</div>
            <p>No transactions for this period</p>
            <p className="txn-empty-sub">Transactions will appear here as family members add them or bank SMS arrives</p>
          </div>
        )}
        {groups.map(([dateLabel, items]) => (
          <div key={dateLabel} className="txn-group">
            <div className="txn-group-header">{dateLabel}</div>
            {items.map(t => (
              <div key={t.id} className="txn-row">
                <div className="txn-cat-icon">{CATEGORY_EMOJI[t.category] || '💳'}</div>
                <div className="txn-row-info">
                  <span className="txn-merchant">{t.merchant}</span>
                  <span className="txn-meta">
                    {activeUser === 'all' && <span className="txn-user-tag">{t.userName}</span>}
                    <span className="txn-bank-tag">{t.bank}</span>
                    {t.source === 'sms' && <span className="txn-sms-tag">SMS</span>}
                    <span className="txn-time">{formatTime(t.date)}</span>
                  </span>
                </div>
                <span className={`txn-amount ${t.type}`}>
                  {t.type === 'debit' ? '−' : '+'}{formatINR(t.amount)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
