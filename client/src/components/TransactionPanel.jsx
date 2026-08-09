import { useState, useEffect, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { parseSms, isKnownSender } from '../utils/smsParser'

const IS_NATIVE = Capacitor.isNativePlatform()

const CATEGORIES = [
  { id: 'upi',       label: 'UPI',       emoji: '📱' },
  { id: 'bank',      label: 'Bank',      emoji: '🏦' },
  { id: 'food',      label: 'Food',      emoji: '🍕' },
  { id: 'shopping',  label: 'Shopping',  emoji: '🛒' },
  { id: 'transport', label: 'Transport', emoji: '🚗' },
  { id: 'utilities', label: 'Utilities', emoji: '⚡' },
  { id: 'manual',    label: 'Other',     emoji: '📝' },
]

function catEmoji(cat) {
  return CATEGORIES.find(c => c.id === cat)?.emoji || '💳'
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

function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const EMPTY_FORM = { amount: '', type: 'debit', category: 'manual', merchant: '', note: '', date: '' }

export default function TransactionPanel({ session, sendMsg, addListener, onHome }) {
  const [txns, setTxns]       = useState([])
  const [tab, setTab]         = useState('all')
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm]       = useState(EMPTY_FORM)
  const [syncing, setSyncing] = useState(false)

  // Listen for incoming transaction confirmations (own) and new ones from server
  useEffect(() => {
    return addListener((msg) => {
      // Server echos back transaction_new even for the user who sent it
      if (msg.type === 'transaction_new' && msg.fromUserId === session.userId) {
        setTxns(prev => {
          const exists = prev.find(t => t.id === msg.transaction.id)
          return exists ? prev : [msg.transaction, ...prev]
        })
      }
    })
  }, [addListener, session.userId])

  // On native: request SMS sync from KeepAliveService
  useEffect(() => {
    if (!IS_NATIVE) return
    setSyncing(true)
    sendMsg({ type: 'sms_sync_request' })
    const t = setTimeout(() => setSyncing(false), 5000)
    return () => clearTimeout(t)
  }, [sendMsg])

  const submitTxn = useCallback(() => {
    const amount = parseFloat(form.amount)
    if (!amount || amount <= 0) return
    const txn = {
      id:          Math.random().toString(36).slice(2),
      userId:      session.userId,
      userName:    session.name,
      amount,
      type:        form.type,
      category:    form.category,
      merchant:    form.merchant.trim() || form.category,
      description: form.note.trim(),
      date:        form.date ? new Date(form.date).getTime() : Date.now(),
      source:      'manual',
      bank:        'Manual',
      balance:     null,
    }
    sendMsg({ type: 'transaction_add', transaction: txn })
    setTxns(prev => [txn, ...prev])
    setForm(EMPTY_FORM)
    setShowAdd(false)
  }, [form, session, sendMsg])

  const filtered = txns.filter(t => tab === 'all' || t.type === tab)
  const groups   = groupByDate(filtered)

  const totalDebit  = txns.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
  const totalCredit = txns.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)

  return (
    <div className="txn-screen">
      {/* Header */}
      <div className="txn-header">
        <button className="txn-home-btn" onClick={onHome} aria-label="Home">🏠</button>
        <span className="txn-title">My Transactions</span>
        {syncing && <span className="txn-syncing">↻ Syncing SMS…</span>}
        <button className="txn-add-btn" onClick={() => setShowAdd(true)} aria-label="Add transaction">＋</button>
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

      {/* Tab strip */}
      <div className="txn-tabs">
        {['all','debit','credit'].map(t => (
          <button key={t} className={`txn-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
            {t === 'all' ? 'All' : t === 'debit' ? '↑ Spent' : '↓ Received'}
          </button>
        ))}
      </div>

      {/* Transaction list */}
      <div className="txn-list">
        {txns.length === 0 && (
          <div className="txn-empty">
            <div className="txn-empty-icon">💳</div>
            <p>No transactions yet</p>
            <p className="txn-empty-sub">{IS_NATIVE ? 'Bank SMS will auto-import, or tap ＋ to add manually' : 'Tap ＋ to add a transaction'}</p>
          </div>
        )}
        {groups.map(([dateLabel, items]) => (
          <div key={dateLabel} className="txn-group">
            <div className="txn-group-header">{dateLabel}</div>
            {items.map(t => (
              <div key={t.id} className="txn-row">
                <div className="txn-cat-icon">{catEmoji(t.category)}</div>
                <div className="txn-row-info">
                  <span className="txn-merchant">{t.merchant}</span>
                  <span className="txn-meta">
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

      {/* Manual add bottom-sheet */}
      {showAdd && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setShowAdd(false)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>Add Transaction</span>
              <button className="add-txn-close" onClick={() => setShowAdd(false)}>✕</button>
            </div>

            {/* Amount */}
            <div className="add-field">
              <label className="add-label">Amount (₹)</label>
              <input className="add-input" type="number" inputMode="decimal" placeholder="0.00"
                value={form.amount} onChange={e => setForm(f => ({...f, amount: e.target.value}))} />
            </div>

            {/* Type toggle */}
            <div className="add-field">
              <label className="add-label">Type</label>
              <div className="type-toggle">
                <button className={`type-btn${form.type === 'debit' ? ' active debit' : ''}`}
                  onClick={() => setForm(f => ({...f, type: 'debit'}))}>↑ Spent / Debit</button>
                <button className={`type-btn${form.type === 'credit' ? ' active credit' : ''}`}
                  onClick={() => setForm(f => ({...f, type: 'credit'}))}>↓ Received / Credit</button>
              </div>
            </div>

            {/* Category picker */}
            <div className="add-field">
              <label className="add-label">Category</label>
              <div className="category-grid">
                {CATEGORIES.map(c => (
                  <button key={c.id}
                    className={`cat-chip${form.category === c.id ? ' active' : ''}`}
                    onClick={() => setForm(f => ({...f, category: c.id}))}>
                    {c.emoji} {c.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Merchant */}
            <div className="add-field">
              <label className="add-label">Merchant / Paid to</label>
              <input className="add-input" type="text" placeholder="e.g. Swiggy, Amazon"
                value={form.merchant} onChange={e => setForm(f => ({...f, merchant: e.target.value}))} />
            </div>

            {/* Note */}
            <div className="add-field">
              <label className="add-label">Note (optional)</label>
              <input className="add-input" type="text" placeholder="Add a note…"
                value={form.note} onChange={e => setForm(f => ({...f, note: e.target.value}))} />
            </div>

            {/* Date */}
            <div className="add-field">
              <label className="add-label">Date</label>
              <input className="add-input" type="date"
                value={form.date || new Date().toISOString().slice(0,10)}
                onChange={e => setForm(f => ({...f, date: e.target.value}))} />
            </div>

            <button className="add-txn-submit" onClick={submitTxn}
              disabled={!form.amount || parseFloat(form.amount) <= 0}>
              Add Transaction
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
