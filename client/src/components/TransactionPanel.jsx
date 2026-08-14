import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CATEGORIES, getCategoryMeta, loadCustomCategories, addCustomCategory, loadBanks, addBank } from '../utils/txnMeta'
import { parsePhonePeStatementCsv } from '../utils/phonePeStatement'

const PAGE_SIZE = 15

const ANALYTICS_RANGES = [
  { key: 'week', label: 'This week', days: 7 },
  { key: 'month', label: 'This month', days: 30 },
  { key: '3m', label: 'Last 3 months', days: 90 },
  { key: 'year', label: 'This year', days: 365 },
  { key: 'all', label: 'All time', days: null },
]

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

function formatINRShort(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

function rangeStart(key) {
  const opt = ANALYTICS_RANGES.find(o => o.key === key)
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (!opt.days) return 0
  d.setDate(d.getDate() - (opt.days - 1))
  return d.getTime()
}

const EMPTY_FORM = { id: null, amount: '', type: 'debit', category: 'manual', merchant: '', note: '', date: '', bank: '', fromBank: '', toBank: '' }

export default function TransactionPanel({ session, sendMsg, addListener, onHome }) {
  const [txns, setTxns]       = useState([])
  const [tab, setTab]         = useState('all')
  const [sheetMode, setSheetMode] = useState(null) // null | 'add' | 'edit'
  const [form, setForm]       = useState(EMPTY_FORM)
  const [budget, setBudget] = useState(() => Number(localStorage.getItem('meeee_txn_budget') || 20000))
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [analyticsRange, setAnalyticsRange] = useState('month')
  const [customCategories, setCustomCategories] = useState(() => loadCustomCategories(session.userId))
  const [banks, setBanks] = useState(() => loadBanks(session.userId, []))
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const statementInputRef = useRef(null)

  // Listen for incoming transaction confirmations (own), new ones from server, edits, deletes, and history
  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'transaction_new' && msg.fromUserId === session.userId) {
        setTxns(prev => {
          const exists = prev.find(t => t.id === msg.transaction.id)
          return exists ? prev : [msg.transaction, ...prev]
        })
      }
      if (msg.type === 'transaction_updated' && msg.fromUserId === session.userId) {
        setTxns(prev => prev.map(t => t.id === msg.transaction.id ? msg.transaction : t))
      }
      if (msg.type === 'transaction_deleted' && msg.fromUserId === session.userId) {
        setTxns(prev => prev.filter(t => t.id !== msg.id))
      }
      if (msg.type === 'transactions_list' && msg.userId === session.userId) {
        setTxns(prev => {
          const ids = new Set(prev.map(t => t.id))
          const merged = [...prev, ...(msg.transactions || []).filter(t => !ids.has(t.id))]
          return merged.sort((a, b) => b.date - a.date)
        })
      }
    })
  }, [addListener, session.userId])

  // Fetch own transaction history on mount
  useEffect(() => {
    sendMsg({ type: 'transactions_get' })
  }, [sendMsg])

  useEffect(() => { localStorage.setItem('meeee_txn_budget', String(budget)) }, [budget])

  // Refresh the observed-bank list whenever the transaction set changes (e.g. new SMS-derived banks)
  useEffect(() => { setBanks(loadBanks(session.userId, txns)) }, [session.userId, txns.length])

  // Reset pagination whenever the visible tab changes
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [tab])

  function openAdd() {
    setForm(EMPTY_FORM)
    setSheetMode('add')
  }

  function openEdit(txn) {
    setForm({
      id: txn.id,
      amount: String(txn.amount),
      type: txn.type,
      category: txn.category || 'manual',
      merchant: txn.merchant || '',
      note: txn.description || '',
      date: new Date(txn.date).toISOString().slice(0, 10),
      bank: txn.type === 'transfer' ? '' : (txn.bank || ''),
      fromBank: txn.type === 'transfer' ? (txn.fromBank || '') : '',
      toBank: txn.type === 'transfer' ? (txn.toBank || '') : '',
    })
    setSheetMode('edit')
  }

  function addCustomCategoryPrompt() {
    const name = window.prompt('New category name')
    if (!name) return
    const cat = addCustomCategory(session.userId, name)
    if (cat) {
      setCustomCategories(loadCustomCategories(session.userId))
      setForm(f => ({ ...f, category: cat.id }))
    }
  }

  function handleBankSelect(field, value) {
    if (value === '__add__') {
      const name = window.prompt('Bank / account name (e.g. HDFC Savings)')
      if (!name) return
      const added = addBank(session.userId, name)
      if (added) {
        setBanks(loadBanks(session.userId, txns))
        setForm(f => ({ ...f, [field]: added }))
      }
      return
    }
    setForm(f => ({ ...f, [field]: value }))
  }

  const submitTxn = useCallback(() => {
    const amount = parseFloat(form.amount)
    if (!amount || amount <= 0) return
    if (form.type === 'transfer' && (!form.fromBank || !form.toBank || form.fromBank === form.toBank)) return

    let base
    if (form.type === 'transfer') {
      base = {
        amount,
        type: 'transfer',
        category: 'transfer',
        merchant: `${form.fromBank} → ${form.toBank}`,
        description: form.note.trim(),
        date: form.date ? new Date(form.date).getTime() : Date.now(),
        fromBank: form.fromBank,
        toBank: form.toBank,
        bank: form.fromBank,
      }
    } else {
      const meta = [...CATEGORIES, ...customCategories].find(c => c.id === form.category)
      base = {
        amount,
        type: form.type,
        category: form.category,
        ...(meta && String(meta.id).startsWith('custom:')
          ? { categoryLabel: meta.label, categoryIcon: meta.icon, categoryColor: meta.color }
          : {}),
        merchant: form.merchant.trim() || (meta ? meta.label : form.category),
        description: form.note.trim(),
        date: form.date ? new Date(form.date).getTime() : Date.now(),
        bank: form.bank || 'Manual',
      }
    }

    if (sheetMode === 'edit') {
      const updated = { id: form.id, ...base }
      sendMsg({ type: 'transaction_update', transaction: updated })
      setTxns(prev => prev.map(t => t.id === form.id ? { ...t, ...updated } : t))
    } else {
      const txn = { id: Math.random().toString(36).slice(2), userId: session.userId, userName: session.name, source: 'manual', balance: null, ...base }
      sendMsg({ type: 'transaction_add', transaction: txn })
      setTxns(prev => [txn, ...prev])
    }
    setForm(EMPTY_FORM)
    setSheetMode(null)
  }, [form, sheetMode, session, sendMsg, customCategories])

  function deleteTxn(id) {
    if (!window.confirm('Delete this transaction?')) return
    sendMsg({ type: 'transaction_delete', id })
    setTxns(prev => prev.filter(t => t.id !== id))
    if (form.id === id) { setSheetMode(null); setForm(EMPTY_FORM) }
  }

  function editBudget() {
    const next = window.prompt('Set your monthly budget (₹)', String(budget))
    if (next == null) return
    const num = parseFloat(next)
    if (!isNaN(num) && num > 0) setBudget(num)
  }

  async function handleStatementUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    try {
      const text = await file.text()
      const parsed = parsePhonePeStatementCsv(text)
      if (parsed.length === 0) {
        window.alert('No transactions found in that file — is it a PhonePe statement CSV?')
        return
      }
      parsed.forEach(txn => sendMsg({ type: 'transaction_add', transaction: txn }))
      // Optimistic local update — server-side exact-id dedup means re-uploading an
      // overlapping statement won't create visible duplicates once transactions_list refreshes.
      setTxns(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        return [...parsed.filter(t => !existingIds.has(t.id)), ...prev].sort((a, b) => b.date - a.date)
      })
      window.alert(`Imported ${parsed.length} transactions from the statement.`)
    } catch (err) {
      window.alert('Could not read that file — make sure it\'s an unmodified PhonePe statement CSV export.')
    }
  }

  const filtered    = txns.filter(t => tab === 'all' || t.type === tab)
  const visibleTxns = filtered.slice(0, visibleCount)
  const groups      = groupByDate(visibleTxns)

  const totalDebit  = txns.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
  const totalCredit = txns.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)

  // Current calendar month spend, for the budget card + category donut
  const monthStats = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const monthTxns = txns.filter(t => t.date >= monthStart && t.type === 'debit')
    const spent = monthTxns.reduce((s, t) => s + t.amount, 0)
    const byCategory = {}
    monthTxns.forEach(t => {
      const meta = getCategoryMeta(t)
      if (!byCategory[meta.id]) byCategory[meta.id] = { ...meta, amount: 0 }
      byCategory[meta.id].amount += t.amount
    })
    const categories = Object.values(byCategory)
      .map(c => ({ ...c, pct: spent ? Math.round((c.amount / spent) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)
    return { spent, categories, label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) }
  }, [txns])

  const donutGradient = useMemo(() => {
    if (!monthStats.categories.length) return null
    let cumulative = 0
    const stops = monthStats.categories.map(c => {
      const from = cumulative
      cumulative += c.pct
      return `${c.color} ${from}% ${cumulative}%`
    })
    return `conic-gradient(${stops.join(', ')})`
  }, [monthStats.categories])

  // Month-over-month spend change — always compares full calendar months, independent of the analytics range filter
  const momChange = useMemo(() => {
    const now = new Date()
    const thisStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime()
    const thisSpend = txns.filter(t => t.type === 'debit' && t.date >= thisStart).reduce((s, t) => s + t.amount, 0)
    const lastSpend = txns.filter(t => t.type === 'debit' && t.date >= lastStart && t.date < thisStart).reduce((s, t) => s + t.amount, 0)
    if (lastSpend === 0) return null
    return Math.round(((thisSpend - lastSpend) / lastSpend) * 100)
  }, [txns])

  // Period-filtered analytics: trend, category/bank breakdowns, and quick-glance stats
  const analyticsData = useMemo(() => {
    const start = rangeStart(analyticsRange)
    const inRange = txns.filter(t => t.date >= start)
    const dayMap = {}
    inRange.forEach(t => {
      if (t.type === 'transfer') return
      const key = new Date(t.date).toISOString().slice(0, 10)
      if (!dayMap[key]) dayMap[key] = { debit: 0, credit: 0 }
      dayMap[key][t.type] += t.amount
    })
    const days = Object.keys(dayMap).sort()
    const bucketSize = Math.max(1, Math.ceil(days.length / 30))
    const buckets = []
    for (let i = 0; i < days.length; i += bucketSize) {
      const slice = days.slice(i, i + bucketSize)
      const debit = slice.reduce((s, k) => s + dayMap[k].debit, 0)
      const credit = slice.reduce((s, k) => s + dayMap[k].credit, 0)
      buckets.push({ key: slice[0], debit, credit })
    }
    const bucketMax = Math.max(1, ...buckets.map(b => b.debit + b.credit))

    const byCategory = {}
    inRange.filter(t => t.type === 'debit').forEach(t => {
      const meta = getCategoryMeta(t)
      if (!byCategory[meta.id]) byCategory[meta.id] = { ...meta, amount: 0 }
      byCategory[meta.id].amount += t.amount
    })
    const topCategories = Object.values(byCategory).sort((a, b) => b.amount - a.amount).slice(0, 6)
    const topMax = Math.max(1, ...topCategories.map(c => c.amount))

    const byBank = {}
    inRange.filter(t => t.type === 'debit').forEach(t => {
      const key = t.bank || 'Manual'
      byBank[key] = (byBank[key] || 0) + t.amount
    })
    const bankBreakdown = Object.entries(byBank).map(([bank, amount]) => ({ bank, amount })).sort((a, b) => b.amount - a.amount).slice(0, 6)
    const bankMax = Math.max(1, ...bankBreakdown.map(b => b.amount))

    const totalDebitInRange  = inRange.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
    const totalCreditInRange = inRange.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)

    const rangeOpt = ANALYTICS_RANGES.find(o => o.key === analyticsRange)
    let periodDays
    if (rangeOpt.days) {
      periodDays = rangeOpt.days
    } else {
      const earliest = inRange.length ? Math.min(...inRange.map(t => t.date)) : Date.now()
      periodDays = Math.max(1, Math.ceil((Date.now() - earliest) / 86400000) + 1)
    }
    const avgDailySpend = totalDebitInRange / periodDays

    const biggestExpense = inRange.filter(t => t.type === 'debit').sort((a, b) => b.amount - a.amount)[0] || null

    const savingsRate = totalCreditInRange > 0
      ? Math.round(((totalCreditInRange - totalDebitInRange) / totalCreditInRange) * 100)
      : null

    return { buckets, bucketMax, topCategories, topMax, bankBreakdown, bankMax, avgDailySpend, biggestExpense, savingsRate }
  }, [txns, analyticsRange])

  const budgetPct = budget ? Math.min(100, Math.round((monthStats.spent / budget) * 100)) : 0
  const budgetOver = monthStats.spent > budget

  return (
    <div className="txn-screen">
      <div className="txn-header">
        <button className="txn-home-btn" onClick={onHome} aria-label="Home">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="txn-title">Finance</span>
        <button className="txn-header-icon-btn" onClick={() => statementInputRef.current?.click()} aria-label="Upload PhonePe statement">
          <span className="material-symbols-outlined">upload_file</span>
        </button>
        <input
          ref={statementInputRef}
          type="file"
          accept=".csv,text/csv"
          style={{ display: 'none' }}
          onChange={handleStatementUpload}
        />
      </div>

      <div className="txn-body">

        {/* Budget overview */}
        <div className="txn-budget-card">
          <div className="txn-budget-top">
            <div>
              <div className="txn-budget-label">Monthly Budget</div>
              <div className="txn-budget-period">{monthStats.label}</div>
            </div>
            <div className="txn-budget-amounts">
              <div>
                <span className="txn-budget-spent">{formatINRShort(monthStats.spent)}</span>
                <span className="txn-budget-of"> / {formatINRShort(budget)}</span>
              </div>
              <button className="txn-budget-edit" onClick={editBudget} aria-label="Edit budget">
                <span className="material-symbols-outlined">edit</span>
              </button>
            </div>
          </div>
          <div className="txn-budget-row">
            <span className="txn-budget-pct">{budgetPct}% Spent</span>
            <span className="txn-budget-remaining">{formatINRShort(Math.max(0, budget - monthStats.spent))} Remaining</span>
          </div>
          <div className="txn-budget-bar">
            <span className={`txn-budget-bar-fill${budgetOver ? ' over' : ''}`} style={{ width: `${budgetPct}%` }} />
          </div>
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

        {/* Spending categories donut */}
        <div className="txn-donut-card">
          <div className="txn-donut-title">Spending Categories — {monthStats.label}</div>
          {monthStats.categories.length === 0 ? (
            <p className="txn-donut-empty">No spending recorded yet this month.</p>
          ) : (
            <div className="txn-donut-body">
              <div className="txn-donut-ring" style={{ background: donutGradient }}>
                <div className="txn-donut-hole">
                  <span className="material-symbols-outlined">pie_chart</span>
                </div>
              </div>
              <div className="txn-donut-legend">
                {monthStats.categories.slice(0, 5).map(c => (
                  <div key={c.id} className="txn-donut-legend-item">
                    <span className="txn-donut-dot" style={{ background: c.color }} />
                    <span className="txn-donut-legend-name">{c.label}</span>
                    <span className="txn-donut-legend-pct">{c.pct}%</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Detailed analytics */}
        <div>
          <button className="txn-analytics-toggle" onClick={() => setShowAnalytics(v => !v)}>
            <span className="txn-analytics-toggle-icon"><span className="material-symbols-outlined">bar_chart</span></span>
            Detailed Analytics
            <span className={`material-symbols-outlined txn-analytics-chevron${showAnalytics ? ' open' : ''}`}>expand_more</span>
          </button>

          {showAnalytics && (
            <div className="txn-analytics" style={{ marginTop: 12 }}>
              <label className="txn-analytics-filter">
                <span className="material-symbols-outlined">calendar_month</span>
                <select value={analyticsRange} onChange={e => setAnalyticsRange(e.target.value)}>
                  {ANALYTICS_RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
                </select>
              </label>

              {/* Quick-glance stat tiles */}
              <div className="txn-stat-grid">
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Avg Daily Spend</span>
                  <span className="txn-stat-value">{formatINRShort(analyticsData.avgDailySpend)}</span>
                </div>
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Biggest Expense</span>
                  {analyticsData.biggestExpense ? (
                    <>
                      <span className="txn-stat-value">{formatINRShort(analyticsData.biggestExpense.amount)}</span>
                      <span className="txn-stat-sub">{analyticsData.biggestExpense.merchant}</span>
                    </>
                  ) : <span className="txn-stat-value">—</span>}
                </div>
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Vs Last Month</span>
                  <span className={`txn-stat-value${momChange == null ? '' : momChange > 0 ? ' bad' : ' good'}`}>
                    {momChange == null ? '—' : `${momChange > 0 ? '+' : ''}${momChange}%`}
                  </span>
                </div>
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Savings Rate</span>
                  <span className={`txn-stat-value${analyticsData.savingsRate == null ? '' : analyticsData.savingsRate >= 0 ? ' good' : ' bad'}`}>
                    {analyticsData.savingsRate == null ? '—' : `${analyticsData.savingsRate}%`}
                  </span>
                </div>
              </div>

              <div>
                <h3 className="txn-analytics-title">Spending vs Income trend</h3>
                <div className="txn-trend-chart">
                  {analyticsData.buckets.map(b => (
                    <div key={b.key} className="txn-trend-bar-wrap" title={`Spent ${formatINR(b.debit)}, Received ${formatINR(b.credit)}`}>
                      <div className="txn-trend-bar">
                        <span className="txn-trend-seg--debit" style={{ height: `${(b.debit / analyticsData.bucketMax) * 100}%` }} />
                        <span className="txn-trend-seg--credit" style={{ height: `${(b.credit / analyticsData.bucketMax) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
                <div className="txn-trend-legend">
                  <span><span className="txn-trend-legend-dot" style={{ background: 'var(--txn-rose)' }} />Spent</span>
                  <span><span className="txn-trend-legend-dot" style={{ background: 'var(--txn-green)' }} />Received</span>
                </div>
              </div>

              <div>
                <h3 className="txn-analytics-title">Top categories</h3>
                {analyticsData.topCategories.length === 0 ? (
                  <p className="txn-donut-empty">Nothing in this period.</p>
                ) : analyticsData.topCategories.map(c => (
                  <div key={c.id} className="txn-breakdown-row">
                    <span className="txn-breakdown-label">{c.label}</span>
                    <div className="txn-breakdown-bar">
                      <span className="txn-breakdown-fill" style={{ width: `${(c.amount / analyticsData.topMax) * 100}%`, background: c.color }} />
                    </div>
                    <span className="txn-breakdown-val">{formatINRShort(c.amount)}</span>
                  </div>
                ))}
              </div>

              <div>
                <h3 className="txn-analytics-title">By bank / account</h3>
                {analyticsData.bankBreakdown.length === 0 ? (
                  <p className="txn-donut-empty">Nothing in this period.</p>
                ) : analyticsData.bankBreakdown.map(b => (
                  <div key={b.bank} className="txn-breakdown-row">
                    <span className="txn-breakdown-label">{b.bank}</span>
                    <div className="txn-breakdown-bar">
                      <span className="txn-breakdown-fill" style={{ width: `${(b.amount / analyticsData.bankMax) * 100}%` }} />
                    </div>
                    <span className="txn-breakdown-val">{formatINRShort(b.amount)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Tab strip */}
        <div className="txn-tabs">
          {['all','debit','credit'].map(t => (
            <button key={t} className={`txn-tab${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
              {t === 'all' ? 'All' : t === 'debit' ? 'Spent' : 'Received'}
            </button>
          ))}
        </div>

        {/* Transaction list */}
        <div className="txn-list-card">
          {txns.length === 0 && (
            <div className="txn-empty">
              <span className="material-symbols-outlined txn-empty-icon">credit_card_off</span>
              <p>No transactions yet</p>
              <p className="txn-empty-sub">Tap + to add a transaction</p>
            </div>
          )}
          {groups.map(([dateLabel, items]) => (
            <div key={dateLabel} className="txn-group">
              <div className="txn-group-header">{dateLabel}</div>
              {items.map(t => {
                const meta = getCategoryMeta(t)
                return (
                  <div key={t.id} className="txn-row" onClick={() => openEdit(t)}>
                    <div className="txn-cat-icon" style={{ background: `${meta.color}22` }}>
                      <span className="material-symbols-outlined" style={{ color: meta.color }}>{meta.icon}</span>
                    </div>
                    <div className="txn-row-info">
                      <span className="txn-merchant">{t.merchant}</span>
                      <span className="txn-meta">
                        {t.type === 'transfer'
                          ? <span className="txn-bank-tag">Self Transfer</span>
                          : <span className="txn-bank-tag">{t.bank}</span>}
                        {t.source === 'statement' && <span className="txn-sms-tag">Statement</span>}
                        <span className="txn-time">{formatTime(t.date)}</span>
                      </span>
                    </div>
                    <span className={`txn-amount ${t.type}`}>
                      {t.type === 'debit' ? '−' : t.type === 'credit' ? '+' : ''}{formatINR(t.amount)}
                    </span>
                    <button
                      className="txn-row-delete"
                      onClick={(e) => { e.stopPropagation(); deleteTxn(t.id) }}
                      aria-label="Delete transaction"
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                )
              })}
            </div>
          ))}
          {filtered.length > visibleCount && (
            <button className="txn-load-more" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
              Load 15 more ({filtered.length - visibleCount} remaining)
            </button>
          )}
        </div>
      </div>

      <button className="txn-fab" onClick={openAdd} aria-label="Add transaction">
        <span className="material-symbols-outlined">add</span>
      </button>

      {/* Add/edit bottom-sheet */}
      {sheetMode && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setSheetMode(null)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{sheetMode === 'edit' ? 'Edit Transaction' : 'Add Transaction'}</span>
              <button className="add-txn-close" onClick={() => setSheetMode(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Amount (₹)</label>
              <input className="add-input" type="number" inputMode="decimal" placeholder="0.00"
                value={form.amount} onChange={e => setForm(f => ({...f, amount: e.target.value}))} />
            </div>

            <div className="add-field">
              <label className="add-label">Type</label>
              <div className="type-toggle">
                <button className={`type-btn${form.type === 'debit' ? ' active debit' : ''}`}
                  onClick={() => setForm(f => ({...f, type: 'debit'}))}>Spent</button>
                <button className={`type-btn${form.type === 'credit' ? ' active credit' : ''}`}
                  onClick={() => setForm(f => ({...f, type: 'credit'}))}>Received</button>
                <button className={`type-btn${form.type === 'transfer' ? ' active transfer' : ''}`}
                  onClick={() => setForm(f => ({...f, type: 'transfer'}))}>Transfer</button>
              </div>
            </div>

            {form.type === 'transfer' ? (
              <>
                <div className="add-field">
                  <label className="add-label">From Bank</label>
                  <select className="add-input" value={form.fromBank} onChange={e => handleBankSelect('fromBank', e.target.value)}>
                    <option value="">Select account</option>
                    {banks.map(b => <option key={b} value={b}>{b}</option>)}
                    <option value="__add__">+ Add new bank / account…</option>
                  </select>
                </div>
                <div className="add-field">
                  <label className="add-label">To Bank</label>
                  <select className="add-input" value={form.toBank} onChange={e => handleBankSelect('toBank', e.target.value)}>
                    <option value="">Select account</option>
                    {banks.filter(b => b !== form.fromBank).map(b => <option key={b} value={b}>{b}</option>)}
                    <option value="__add__">+ Add new bank / account…</option>
                  </select>
                </div>
              </>
            ) : (
              <>
                <div className="add-field">
                  <label className="add-label">Category</label>
                  <div className="category-grid">
                    {[...CATEGORIES, ...customCategories].map(c => (
                      <button key={c.id}
                        className={`cat-chip${form.category === c.id ? ' active' : ''}`}
                        onClick={() => setForm(f => ({...f, category: c.id}))}>
                        <span className="material-symbols-outlined" style={{ fontSize: 15 }}>{c.icon}</span> {c.label}
                      </button>
                    ))}
                    <button className="cat-chip cat-chip-add" onClick={addCustomCategoryPrompt}>
                      <span className="material-symbols-outlined" style={{ fontSize: 15 }}>add</span> Custom
                    </button>
                  </div>
                </div>

                <div className="add-field">
                  <label className="add-label">Merchant / Paid to</label>
                  <input className="add-input" type="text" placeholder="e.g. Swiggy, Amazon"
                    value={form.merchant} onChange={e => setForm(f => ({...f, merchant: e.target.value}))} />
                </div>

                <div className="add-field">
                  <label className="add-label">Bank / Account</label>
                  <select className="add-input" value={form.bank} onChange={e => handleBankSelect('bank', e.target.value)}>
                    <option value="">Select account (optional)</option>
                    {banks.map(b => <option key={b} value={b}>{b}</option>)}
                    <option value="__add__">+ Add new bank / account…</option>
                  </select>
                </div>
              </>
            )}

            <div className="add-field">
              <label className="add-label">Note (optional)</label>
              <input className="add-input" type="text" placeholder="Add a note…"
                value={form.note} onChange={e => setForm(f => ({...f, note: e.target.value}))} />
            </div>

            <div className="add-field">
              <label className="add-label">Date</label>
              <input className="add-input" type="date"
                value={form.date || new Date().toISOString().slice(0,10)}
                onChange={e => setForm(f => ({...f, date: e.target.value}))} />
            </div>

            <button className="add-txn-submit" onClick={submitTxn}
              disabled={!form.amount || parseFloat(form.amount) <= 0 ||
                (form.type === 'transfer' && (!form.fromBank || !form.toBank || form.fromBank === form.toBank))}>
              {sheetMode === 'edit' ? 'Save Changes' : 'Add Transaction'}
            </button>
            {sheetMode === 'edit' && (
              <button className="add-txn-delete" onClick={() => deleteTxn(form.id)}>
                Delete Transaction
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
