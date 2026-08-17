import { useState, useEffect, useMemo } from 'react'
import { getCategoryMeta, OVERALL_BUDGET_CATEGORY, hasRealTime } from '../utils/txnMeta'
import { detectRecurring } from '../utils/recurringDetection'

const PAGE_SIZE = 15

const ANALYTICS_RANGES = [
  { key: 'today', label: 'Today', days: 1 },
  { key: 'week', label: 'This week', days: 7 },
  { key: 'month', label: 'This month', days: 30 },
  { key: '3m', label: 'Last 3 months', days: 90 },
  { key: 'all', label: 'All time', days: null },
  { key: 'custom', label: 'Custom range', days: null },
]

const TYPE_OPTIONS = [
  { value: 'debit', label: 'Spent' },
  { value: 'credit', label: 'Received' },
  { value: 'transfer', label: 'Transfer' },
]

const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'statement', label: 'Statement' },
]

const EMPTY_FILTERS = {
  types: [], typesExclude: false,
  categories: [], categoriesExclude: false,
  sources: [], sourcesExclude: false,
  banks: [], banksExclude: false,
}

// Applies the multi-select "include only" / "exclude these" filter groups. Every
// dimension combines with AND; within a dimension, an empty selection means "no
// filter" regardless of the include/exclude toggle.
function applyTxnFilters(list, filters) {
  return list.filter(t => {
    if (filters.types.length) {
      const match = filters.types.includes(t.type)
      if (filters.typesExclude ? match : !match) return false
    }
    if (filters.categories.length) {
      const match = filters.categories.includes(getCategoryMeta(t).id)
      if (filters.categoriesExclude ? match : !match) return false
    }
    if (filters.sources.length) {
      const src = t.source === 'statement' ? 'statement' : 'manual'
      const match = filters.sources.includes(src)
      if (filters.sourcesExclude ? match : !match) return false
    }
    if (filters.banks.length) {
      const bankVal = t.type === 'transfer' ? t.fromBank : (t.bank || 'Manual')
      const match = filters.banks.includes(bankVal)
      if (filters.banksExclude ? match : !match) return false
    }
    return true
  })
}

// A single filter dimension: a "Show only" / "Hide these" mode toggle plus a row of
// multi-select chips. Kept generic so Type/Category/Source/Bank all reuse it.
function FilterGroup({ label, options, selected, exclude, onToggleOption, onToggleMode }) {
  return (
    <div className="txn-filter-group">
      <div className="txn-filter-group-head">
        <span className="txn-filter-group-label">{label}</span>
        <button type="button" className={`txn-filter-mode-btn${exclude ? ' exclude' : ''}`} onClick={onToggleMode}>
          {exclude ? 'Hide these' : 'Show only'}
        </button>
      </div>
      <div className="txn-filter-chips">
        {options.map(opt => (
          <button key={opt.value} type="button"
            className={`txn-filter-chip${selected.includes(opt.value) ? ' active' : ''}`}
            onClick={() => onToggleOption(opt.value)}>
            {opt.label}
          </button>
        ))}
      </div>
    </div>
  )
}

function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatINRShort(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })
}

// True abbreviation (K/L/Cr) for the tight 3-column Spent/Received/Net hero row — an
// "All time" total across many transactions can run into 7+ digits, and formatINRShort's
// full digit-grouped form is still too wide to fit a third of a phone-width card without
// wrapping mid-number.
function formatINRCompact(n) {
  const abs = Math.abs(n)
  const trim = (v) => v.toFixed(2).replace(/\.?0+$/, '')
  if (abs >= 1e7) return '₹' + trim(n / 1e7) + 'Cr'
  if (abs >= 1e5) return '₹' + trim(n / 1e5) + 'L'
  if (abs >= 1e3) return '₹' + trim(n / 1e3) + 'K'
  return '₹' + Math.round(n)
}

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Pinned to IST rather than the viewing device's own local timezone — see the identical
// note in TransactionPanel.jsx. Two transactions minted milliseconds apart on the same
// real IST calendar day could otherwise land in different date groups if the browser's
// timezone ever differs from IST.
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istMidnight(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS
}
function istMonthStart(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) - IST_OFFSET_MS
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}
function formatDateLabel(ms) {
  const key = istDateKey(ms)
  if (key === istDateKey(Date.now())) return 'Today'
  if (key === istDateKey(Date.now() - 86400000)) return 'Yesterday'
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' })
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

// Resolves the [start, end] bound for a period preset, or for the "Custom range"
// option using the user-picked from/to dates (open-ended on either side if unset).
//
// "This month" specifically means the calendar month (1st through today) — same
// definition adminMonthStats/the Budget card already use. It used to be a rolling 30-day
// window instead, so with a category filter active the Budget card and the "This month"
// hero card could show two different totals for what looked like the same period, which
// read as the filter being broken rather than two different windows quietly disagreeing.
function periodBounds(period, customFrom, customTo) {
  if (period === 'custom') {
    const start = customFrom ? istDateInputToMs(customFrom) : 0
    const end = customTo ? istDateInputToMs(customTo) + 86400000 - 1 : Date.now()
    return { start, end }
  }
  if (period === 'month') return { start: istMonthStart(Date.now()), end: Date.now() }
  const opt = ANALYTICS_RANGES.find(o => o.key === period)
  if (!opt || !opt.days) return { start: 0, end: Date.now() }
  return { start: istMidnight(Date.now()) - (opt.days - 1) * 86400000, end: Date.now() }
}

export default function AdminTransactionView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers]           = useState(initialUsers || [])
  const [txnsByUser, setTxnsByUser] = useState({})
  const [activeUser, setActiveUser] = useState('all')
  const [period, setPeriod]         = useState('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo]     = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showStats, setShowStats] = useState(false)
  const [showCharts, setShowCharts] = useState(false)
  const [filters, setFilters]       = useState(EMPTY_FILTERS)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  // Server-synced budgets per family member: { [userId]: { [category]: monthlyLimit } }
  const [budgetsByUser, setBudgetsByUser] = useState({})
  const [budgetSheet, setBudgetSheet] = useState(null) // null | { category, label }
  const [budgetInput, setBudgetInput] = useState('')

  // Request existing transactions for each connected user at mount
  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'transactions_get', userId: u.id }))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for incoming transactions, edits, deletes + user join/leave
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
      if (msg.type === 'transaction_updated') {
        const t = msg.transaction
        setTxnsByUser(prev => ({
          ...prev,
          [msg.fromUserId]: (prev[msg.fromUserId] || []).map(x => x.id === t.id ? t : x),
        }))
      }
      if (msg.type === 'transaction_deleted') {
        setTxnsByUser(prev => ({
          ...prev,
          [msg.fromUserId]: (prev[msg.fromUserId] || []).filter(x => x.id !== msg.id),
        }))
      }
      if (msg.type === 'transactions_cleared') {
        setTxnsByUser(prev => ({ ...prev, [msg.userId]: [] }))
      }
      if (msg.type === 'budgets') {
        setBudgetsByUser(prev => ({ ...prev, [msg.userId]: msg.budgets || {} }))
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

  // Reset pagination whenever the user/period/filter changes
  useEffect(() => { setVisibleCount(PAGE_SIZE) }, [activeUser, period, customFrom, customTo, filters])

  // Fetch budgets for whichever family member is selected — scoped the same way "Clear
  // All" is: a specific user, never "all" (there's no single "budgets for everyone" view).
  useEffect(() => {
    if (activeUser !== 'all') sendMsg({ type: 'budget_get', userId: activeUser })
  }, [activeUser]) // eslint-disable-line react-hooks/exhaustive-deps

  // Opens the shared add-txn-sheet-style modal (same one TransactionPanel.jsx uses for
  // its own budgets) to set/override a budget for the currently-selected family member.
  function openBudgetSheet(category, label) {
    const current = (budgetsByUser[activeUser] || {})[category]
    setBudgetInput(current != null ? String(current) : '')
    setBudgetSheet({ category, label })
  }

  function submitBudget() {
    if (!budgetSheet || activeUser === 'all') return
    const num = parseFloat(budgetInput)
    if (isNaN(num) || num <= 0) return
    sendMsg({ type: 'budget_set', userId: activeUser, category: budgetSheet.category, monthlyLimit: num })
    setBudgetsByUser(prev => ({
      ...prev,
      [activeUser]: { ...(prev[activeUser] || {}), [budgetSheet.category]: num },
    })) // optimistic
    setBudgetSheet(null)
  }

  function clearAllForUser() {
    if (activeUser === 'all') return
    const targetTxns = txnsByUser[activeUser] || []
    if (targetTxns.length === 0) return
    const target = users.find(u => u.id === activeUser)
    const ok = window.confirm(`This will permanently delete all ${targetTxns.length} transactions for ${target ? target.name : 'this user'}. This cannot be undone. Continue?`)
    if (!ok) return
    sendMsg({ type: 'transaction_delete_all', userId: activeUser })
    setTxnsByUser(prev => ({ ...prev, [activeUser]: [] }))
  }

  function toggleFilterOption(group, value) {
    setFilters(f => {
      const list = f[group]
      const next = list.includes(value) ? list.filter(v => v !== value) : [...list, value]
      return { ...f, [group]: next }
    })
  }

  function toggleFilterMode(modeKey) {
    setFilters(f => ({ ...f, [modeKey]: !f[modeKey] }))
  }

  function resetFilters() {
    setFilters(EMPTY_FILTERS)
    setSearchQuery('')
  }

  const activeFilterCount =
    (filters.types.length ? 1 : 0) + (filters.categories.length ? 1 : 0) +
    (filters.sources.length ? 1 : 0) + (filters.banks.length ? 1 : 0) +
    (searchQuery.trim() ? 1 : 0)

  // All transactions merged (across users), scoped to the selected period/custom range
  const { start, end } = periodBounds(period, customFrom, customTo)
  const allTxns = Object.values(txnsByUser).flat()
    .filter(t => t.date >= start && t.date <= end)
    .sort((a, b) => b.date - a.date)

  const periodUserTxns = activeUser === 'all'
    ? allTxns
    : (txnsByUser[activeUser] || []).filter(t => t.date >= start && t.date <= end).sort((a, b) => b.date - a.date)

  // Distinct bank/account names and categories actually present, for the filter chips
  const filterBankOptions = [...new Set(
    periodUserTxns.map(t => t.type === 'transfer' ? t.fromBank : (t.bank || 'Manual')).filter(Boolean)
  )]
  const filterCategoryMap = {}
  periodUserTxns.forEach(t => { const m = getCategoryMeta(t); filterCategoryMap[m.id] = m.label })
  const filterCategoryOptions = Object.entries(filterCategoryMap).map(([value, label]) => ({ value, label }))

  // Deep filters (type/category/source/bank + include-vs-exclude) apply on top of the
  // period/user scoping — AND-combined, and feeding both the list AND the analytics below
  const searchQ = searchQuery.trim().toLowerCase()
  const displayed  = applyTxnFilters(periodUserTxns, filters)
    .filter(t => !searchQ || `${t.description || ''} ${t.merchant || ''}`.toLowerCase().includes(searchQ))
  const visibleTxns = displayed.slice(0, visibleCount)
  const totalDebit  = displayed.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
  const totalCredit = displayed.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
  const groups = groupByDate(visibleTxns)

  // Spending-category donut for the currently selected user/period
  const categoryStats = useMemo(() => {
    const debitTxns = displayed.filter(t => t.type === 'debit')
    const spent = debitTxns.reduce((s, t) => s + t.amount, 0)
    const byCategory = {}
    debitTxns.forEach(t => {
      const meta = getCategoryMeta(t)
      if (!byCategory[meta.id]) byCategory[meta.id] = { ...meta, amount: 0 }
      byCategory[meta.id].amount += t.amount
    })
    const categories = Object.values(byCategory)
      .map(c => ({ ...c, pct: spent ? Math.round((c.amount / spent) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)
    return { spent, categories }
  }, [displayed])

  // Calendar-month-to-date spend for the selected family member — independent of the
  // period selector above (which can be "This week"/"Last 3 months"/etc.), same
  // semantics as TransactionPanel's own monthStats so the two budget cards agree.
  const adminMonthStats = useMemo(() => {
    if (activeUser === 'all') return { spent: 0, categories: [], label: '' }
    const monthStart = istMonthStart(Date.now())
    const monthTxns = (txnsByUser[activeUser] || []).filter(t => t.date >= monthStart)
    const debitTxns = monthTxns.filter(t => t.type === 'debit')
    const spent = debitTxns.reduce((s, t) => s + t.amount, 0)
    const byCategory = {}
    debitTxns.forEach(t => {
      const meta = getCategoryMeta(t)
      if (!byCategory[meta.id]) byCategory[meta.id] = { ...meta, amount: 0 }
      byCategory[meta.id].amount += t.amount
    })
    const categories = Object.values(byCategory).sort((a, b) => b.amount - a.amount)
    return { spent, categories, label: new Date(monthStart).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'long', year: 'numeric' }) }
  }, [txnsByUser, activeUser])

  const activeBudgets = budgetsByUser[activeUser] || {}
  const overallBudget = activeBudgets[OVERALL_BUDGET_CATEGORY]
  const overallBudgetPct = overallBudget ? Math.min(100, Math.round((adminMonthStats.spent / overallBudget) * 100)) : 0
  const overallBudgetOver = overallBudget != null && adminMonthStats.spent > overallBudget

  // Per-category budget rows for the selected family member — same shape as
  // TransactionPanel's own budgetCategories, minus that user's local custom-category
  // metadata (an admin has no access to a child's localStorage), so a category with a
  // limit set but no spend this month falls back to a generic label until it's spent.
  const budgetCategories = useMemo(() => {
    if (activeUser === 'all') return []
    const spentMap = {}
    adminMonthStats.categories.forEach(c => { spentMap[c.id] = c })
    const ids = new Set([
      ...Object.keys(spentMap),
      ...Object.keys(activeBudgets).filter(id => id !== OVERALL_BUDGET_CATEGORY),
    ])
    return [...ids]
      .map(id => {
        const meta = spentMap[id] || getCategoryMeta({ category: id })
        return { ...meta, id, amount: spentMap[id]?.amount || 0, limit: activeBudgets[id] }
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6)
  }, [adminMonthStats.categories, activeBudgets, activeUser])

  // Recurring-payment detection, computed per family member (a merchant pattern is
  // specific to one person's spending) — full history per user, not the period/filter-
  // scoped `displayed` list, since month-over-month regularity needs every month.
  const recurringByUser = useMemo(() => {
    const map = {}
    Object.entries(txnsByUser).forEach(([uid, list]) => { map[uid] = detectRecurring(list) })
    return map
  }, [txnsByUser])

  const recurringSummary = useMemo(() => {
    if (activeUser === 'all') {
      const allGroups = Object.values(recurringByUser).flatMap(r => r.groups)
      return { groups: allGroups, totalMonthly: allGroups.reduce((s, g) => s + g.amount, 0) }
    }
    return recurringByUser[activeUser] || { groups: [], totalMonthly: 0 }
  }, [recurringByUser, activeUser])

  const donutGradient = useMemo(() => {
    if (!categoryStats.categories.length) return null
    let cumulative = 0
    const stops = categoryStats.categories.map(c => {
      const from = cumulative
      cumulative += c.pct
      return `${c.color} ${from}% ${cumulative}%`
    })
    return `conic-gradient(${stops.join(', ')})`
  }, [categoryStats.categories])

  // Daily trend + quick-glance stats across the selected period
  const trendData = useMemo(() => {
    const dayMap = {}
    displayed.forEach(t => {
      if (t.type === 'transfer') return
      const key = istDateKey(t.date) // IST calendar day, not UTC (see formatDateLabel note)
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

    const byBank = {}
    displayed.filter(t => t.type === 'debit').forEach(t => {
      const key = t.bank || 'Manual'
      byBank[key] = (byBank[key] || 0) + t.amount
    })
    const bankBreakdown = Object.entries(byBank).map(([bank, amount]) => ({ bank, amount })).sort((a, b) => b.amount - a.amount).slice(0, 6)
    const bankMax = Math.max(1, ...bankBreakdown.map(b => b.amount))

    const rangeOpt = ANALYTICS_RANGES.find(o => o.key === period)
    let periodDays
    if (period === 'custom') {
      periodDays = Math.max(1, Math.round((end - start) / 86400000) + 1)
    } else if (rangeOpt.days) {
      periodDays = rangeOpt.days
    } else {
      const earliest = displayed.length ? Math.min(...displayed.map(t => t.date)) : Date.now()
      periodDays = Math.max(1, Math.ceil((Date.now() - earliest) / 86400000) + 1)
    }
    const avgDailySpend = totalDebit / periodDays
    const biggestExpense = displayed.filter(t => t.type === 'debit').sort((a, b) => b.amount - a.amount)[0] || null
    const savingsRate = totalCredit > 0 ? Math.round(((totalCredit - totalDebit) / totalCredit) * 100) : null

    return { buckets, bucketMax, bankBreakdown, bankMax, avgDailySpend, biggestExpense, savingsRate }
  }, [displayed, period, start, end, totalDebit, totalCredit])

  // SVG polyline points for the spending-trend line chart — same viewBox convention as
  // TransactionPanel's version, kept separate since the two screens' bucket data differ.
  const trendLine = useMemo(() => {
    const { buckets, bucketMax } = trendData
    if (buckets.length < 2) return null
    const stepX = 100 / (buckets.length - 1)
    const toY = (v) => 36 - (v / bucketMax) * 32
    const toPoints = (key) => buckets.map((b, i) => `${(i * stepX).toFixed(2)},${toY(b[key]).toFixed(2)}`).join(' ')
    return { debit: toPoints('debit'), credit: toPoints('credit') }
  }, [trendData])

  return (
    <div className="txn-screen">
      <div className="txn-header">
        <button className="txn-home-btn" onClick={onHome} aria-label="Home">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="txn-title">Family Finance</span>
      </div>

      <div className="txn-body">
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
          {ANALYTICS_RANGES.filter(r => r.key !== '3m').map(r => (
            <button key={r.key} className={`period-btn${period === r.key ? ' active' : ''}`}
              onClick={() => setPeriod(r.key)}>{r.label}</button>
          ))}
        </div>

        {period === 'custom' && (
          <div className="txn-filter-daterange">
            <input className="add-input" type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)} />
            <span className="txn-filter-daterange-sep">to</span>
            <input className="add-input" type="date" value={customTo} onChange={e => setCustomTo(e.target.value)} />
          </div>
        )}

        {/* Clear All — scoped to whichever family member is selected; clearing "all"
            family members at once is a much more dangerous action and isn't offered here */}
        {activeUser !== 'all' && (
          <button className="txn-clear-all-btn" onClick={clearAllForUser} disabled={(txnsByUser[activeUser] || []).length === 0}>
            <span className="material-symbols-outlined">delete_sweep</span>
            Clear All for {users.find(u => u.id === activeUser)?.name || 'this user'}
          </button>
        )}

        {/* Budgets — server-synced, scoped to whichever family member is selected (same
            scoping as "Clear All" above): a parent can view and set/override a child's
            overall and per-category monthly limits here. */}
        {activeUser !== 'all' && (
          <div className="txn-budget-card">
            <div className="txn-budget-top">
              <div>
                <div className="txn-budget-label">Budget — {users.find(u => u.id === activeUser)?.name || 'this user'}</div>
                <div className="txn-budget-period">{adminMonthStats.label}</div>
              </div>
              <div className="txn-budget-amounts">
                <div>
                  <span className="txn-budget-spent">{formatINRShort(adminMonthStats.spent)}</span>
                  <span className="txn-budget-of"> / {overallBudget != null ? formatINRShort(overallBudget) : 'Not set'}</span>
                </div>
                <button className="txn-budget-edit" onClick={() => openBudgetSheet(OVERALL_BUDGET_CATEGORY, 'Overall Monthly Budget')} aria-label="Set overall budget">
                  <span className="material-symbols-outlined">{overallBudget != null ? 'edit' : 'add'}</span>
                </button>
              </div>
            </div>
            {overallBudget != null && (
              <>
                <div className="txn-budget-row">
                  <span className="txn-budget-pct">{overallBudgetPct}% Spent</span>
                  <span className="txn-budget-remaining">{formatINRShort(Math.max(0, overallBudget - adminMonthStats.spent))} Remaining</span>
                </div>
                <div className="txn-budget-bar">
                  <span className={`txn-budget-bar-fill${overallBudgetOver ? ' over' : ''}`} style={{ width: `${overallBudgetPct}%` }} />
                </div>
              </>
            )}
          </div>
        )}

        {/* Filters — type/category/source/bank multi-select, AND-combined with the
            period/user scoping above, feeding both the list and the analytics below */}
        <div>
          <button className="txn-analytics-toggle" onClick={() => setShowFilters(v => !v)}>
            <span className="txn-analytics-toggle-icon"><span className="material-symbols-outlined">filter_list</span></span>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            <span className={`material-symbols-outlined txn-analytics-chevron${showFilters ? ' open' : ''}`}>expand_more</span>
          </button>

          {showFilters && (
            <div className="txn-filter-panel">
              <div className="txn-filter-group">
                <div className="txn-filter-group-head">
                  <span className="txn-filter-group-label">Search narration</span>
                </div>
                <input className="add-input" type="text" placeholder="e.g. FOOD CHOTU"
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              </div>

              <FilterGroup label="Type" options={TYPE_OPTIONS}
                selected={filters.types} exclude={filters.typesExclude}
                onToggleOption={v => toggleFilterOption('types', v)}
                onToggleMode={() => toggleFilterMode('typesExclude')} />

              {filterCategoryOptions.length > 0 && (
                <FilterGroup label="Category" options={filterCategoryOptions}
                  selected={filters.categories} exclude={filters.categoriesExclude}
                  onToggleOption={v => toggleFilterOption('categories', v)}
                  onToggleMode={() => toggleFilterMode('categoriesExclude')} />
              )}

              <FilterGroup label="Source" options={SOURCE_OPTIONS}
                selected={filters.sources} exclude={filters.sourcesExclude}
                onToggleOption={v => toggleFilterOption('sources', v)}
                onToggleMode={() => toggleFilterMode('sourcesExclude')} />

              {filterBankOptions.length > 0 && (
                <FilterGroup label="Bank" options={filterBankOptions.map(b => ({ value: b, label: b }))}
                  selected={filters.banks} exclude={filters.banksExclude}
                  onToggleOption={v => toggleFilterOption('banks', v)}
                  onToggleMode={() => toggleFilterMode('banksExclude')} />
              )}

              {activeFilterCount > 0 && (
                <button className="txn-filter-reset" onClick={resetFilters}>Reset filters</button>
              )}
            </div>
          )}
        </div>

        {/* Hero card — live totals for whatever's currently selected (period buttons AND
            the Filters panel — `displayed` already incorporates both), shown whenever
            either departs from its default (mirrors TransactionPanel's version) */}
        {(activeFilterCount > 0 || period !== 'week') && (
          <div className="txn-hero-card">
            <div className="txn-hero-top">
              <span className="txn-hero-label">Filtered Results</span>
              <span className="txn-hero-count">{displayed.length} transaction{displayed.length !== 1 ? 's' : ''}</span>
            </div>
            <div className="txn-hero-stats">
              <div className="txn-hero-stat debit">
                <span className="txn-hero-stat-label">Spent</span>
                <span className="txn-hero-stat-val">{formatINRCompact(totalDebit)}</span>
              </div>
              <div className="txn-hero-stat credit">
                <span className="txn-hero-stat-label">Received</span>
                <span className="txn-hero-stat-val">{formatINRCompact(totalCredit)}</span>
              </div>
              <div className={`txn-hero-stat ${totalCredit - totalDebit >= 0 ? 'credit' : 'debit'}`}>
                <span className="txn-hero-stat-label">Net</span>
                <span className="txn-hero-stat-val">{formatINRCompact(Math.abs(totalCredit - totalDebit))}</span>
              </div>
            </div>
          </div>
        )}

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

        {/* Analytics — always visible now (no expand step needed to see charts) */}
        <div className="txn-charts-section">
          {/* Quick Stats + Charts toggles share one row to save the vertical space of two
              stacked full-width buttons. */}
          <div className="txn-controls-row">
            <button className="txn-filters-toggle txn-section-toggle" onClick={() => setShowStats(v => !v)}>
              <span className="material-symbols-outlined">bar_chart</span>
              Quick Stats
              <span className={`material-symbols-outlined txn-analytics-chevron${showStats ? ' open' : ''}`}>expand_more</span>
            </button>
            <button className="txn-filters-toggle txn-section-toggle" onClick={() => setShowCharts(v => !v)}>
              <span className="material-symbols-outlined">insights</span>
              Charts
              <span className={`material-symbols-outlined txn-analytics-chevron${showCharts ? ' open' : ''}`}>expand_more</span>
            </button>
          </div>
          {showStats && (
          <div className="txn-stat-grid">
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-rose-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-rose-dark)' }}>calendar_today</span>
                </span>
                <span className="txn-stat-label">Avg Daily Spend</span>
              </div>
              <span className="txn-stat-value">{formatINRShort(trendData.avgDailySpend)}</span>
            </div>
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-rose-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-rose-dark)' }}>receipt_long</span>
                </span>
                <span className="txn-stat-label">Biggest Expense</span>
              </div>
              {trendData.biggestExpense ? (
                <>
                  <span className="txn-stat-value">{formatINRShort(trendData.biggestExpense.amount)}</span>
                  <span className="txn-stat-sub">{trendData.biggestExpense.merchant}</span>
                </>
              ) : <span className="txn-stat-value">—</span>}
            </div>
            {recurringSummary.groups.length > 0 && (
              <div className="txn-stat-card">
                <div className="txn-stat-top">
                  <span className="txn-stat-icon" style={{ background: 'var(--txn-gold-pastel)' }}>
                    <span className="material-symbols-outlined" style={{ color: '#8a6d00' }}>autorenew</span>
                  </span>
                  <span className="txn-stat-label">Recurring</span>
                </div>
                <span className="txn-stat-value">{formatINRShort(recurringSummary.totalMonthly)}/mo</span>
                <span className="txn-stat-sub">{recurringSummary.groups.length} payment{recurringSummary.groups.length !== 1 ? 's' : ''}</span>
              </div>
            )}
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-green-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-green-dark)' }}>savings</span>
                </span>
                <span className="txn-stat-label">Savings Rate</span>
              </div>
              <span className={`txn-stat-value${trendData.savingsRate == null ? '' : trendData.savingsRate >= 0 ? ' good' : ' bad'}`}>
                {trendData.savingsRate == null ? '—' : `${trendData.savingsRate}%`}
              </span>
            </div>
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-rose-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-rose-dark)' }}>list_alt</span>
                </span>
                <span className="txn-stat-label">Transactions</span>
              </div>
              <span className="txn-stat-value">{displayed.length}</span>
            </div>
          </div>
          )}

          {showCharts && (
          <div className="txn-charts-grid">
            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Spending Categories</h3>
              {categoryStats.categories.length === 0 ? (
                <p className="txn-donut-empty">No spending recorded for this period.</p>
              ) : (
                <div className="txn-donut-body">
                  <div className="txn-donut-ring" style={{ background: donutGradient }}>
                    <div className="txn-donut-hole">
                      <span className="material-symbols-outlined">pie_chart</span>
                    </div>
                  </div>
                  <div className="txn-donut-legend">
                    {categoryStats.categories.map(c => (
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

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Spending vs Income Trend</h3>
              {!trendLine ? (
                <p className="txn-donut-empty">Not enough data yet.</p>
              ) : (
                <>
                  <svg className="txn-line-chart" viewBox="0 0 100 40" preserveAspectRatio="none">
                    <polyline className="txn-line-chart-line txn-line-chart-line--credit" points={trendLine.credit} />
                    <polyline className="txn-line-chart-line txn-line-chart-line--debit" points={trendLine.debit} />
                  </svg>
                  <div className="txn-trend-legend">
                    <span><span className="txn-trend-legend-dot" style={{ background: 'var(--txn-rose)' }} />Spent</span>
                    <span><span className="txn-trend-legend-dot" style={{ background: 'var(--txn-green)' }} />Received</span>
                  </div>
                </>
              )}
            </div>

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">By Bank / Account</h3>
              {trendData.bankBreakdown.length === 0 ? (
                <p className="txn-donut-empty">Nothing in this period.</p>
              ) : trendData.bankBreakdown.map(b => (
                <div key={b.bank} className="txn-breakdown-row">
                  <span className="txn-breakdown-label">{b.bank}</span>
                  <div className="txn-breakdown-bar">
                    <span className="txn-breakdown-fill" style={{ width: `${(b.amount / trendData.bankMax) * 100}%` }} />
                  </div>
                  <span className="txn-breakdown-val">{formatINRShort(b.amount)}</span>
                </div>
              ))}
            </div>

            {activeUser !== 'all' && budgetCategories.length > 0 && (
              <div className="txn-chart-card">
                <h3 className="txn-analytics-title">Category Budgets — {adminMonthStats.label}</h3>
                <div className="txn-cat-budgets-list">
                  {budgetCategories.map(c => {
                    const hasLimit = c.limit != null
                    const pct = hasLimit ? Math.min(100, Math.round((c.amount / c.limit) * 100)) : 0
                    const over = hasLimit && c.amount > c.limit
                    return (
                      <div key={c.id} className="txn-cat-budget-row">
                        <div className="txn-cat-budget-icon" style={{ background: `${c.color}22` }}>
                          <span className="material-symbols-outlined" style={{ color: c.color }}>{c.icon}</span>
                        </div>
                        <div className="txn-cat-budget-info">
                          <div className="txn-cat-budget-top">
                            <span className="txn-cat-budget-name">{c.label}</span>
                            <span className="txn-cat-budget-amt">
                              {hasLimit ? `${formatINRShort(c.amount)} / ${formatINRShort(c.limit)}` : 'No budget set'}
                            </span>
                          </div>
                          <div className="txn-cat-budget-bar">
                            <span className={`txn-cat-budget-fill${over ? ' over' : ''}`} style={{ width: `${hasLimit ? pct : 0}%` }} />
                          </div>
                        </div>
                        <button className="txn-cat-budget-edit" onClick={() => openBudgetSheet(c.id, c.label)} aria-label={`Set ${c.label} budget`}>
                          <span className="material-symbols-outlined">{hasLimit ? 'edit' : 'add'}</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>
          )}
        </div>

        {/* Transaction list */}
        <div className="txn-list-card">
          {displayed.length === 0 && (
            <div className="txn-empty">
              <span className="material-symbols-outlined txn-empty-icon">credit_card_off</span>
              <p>No transactions for this period</p>
              <p className="txn-empty-sub">Transactions will appear here as family members add them or bank SMS arrives</p>
            </div>
          )}
          {groups.map(([dateLabel, items]) => (
            <div key={dateLabel} className="txn-group">
              <div className="txn-group-header">{dateLabel}</div>
              {items.map(t => {
                const meta = getCategoryMeta(t)
                // The fuller bank narration is only worth showing when it says something
                // the extracted merchant name doesn't already say (statement imports
                // duplicate it verbatim when extractMerchant() can't parse a known shape).
                const hasDesc = t.description && t.description.trim() && t.description.trim() !== (t.merchant || '').trim()
                return (
                  <div key={t.id} className="txn-row">
                    <div className="txn-card-top">
                      <div className="txn-cat-icon" style={{ background: `${meta.color}22` }}>
                        <span className="material-symbols-outlined" style={{ color: meta.color }}>{meta.icon}</span>
                      </div>
                      <div className="txn-row-info">
                        <span className="txn-merchant">{t.merchant}</span>
                      </div>
                      <div className="txn-card-right">
                        <span className={`txn-amount ${t.type}`}>
                          {t.type === 'debit' ? '−' : t.type === 'credit' ? '+' : ''}{formatINR(t.amount)}
                        </span>
                      </div>
                    </div>

                    {/* Rows here are inert (read-only, no edit sheet to reveal the rest),
                        so — unlike TransactionPanel — the narration is shown in full,
                        wrapping rather than clamping, so nothing is ever hidden. */}
                    {hasDesc && <p className="txn-desc">{t.description}</p>}

                    <div className="txn-card-bottom">
                      <span className="txn-meta">
                        {activeUser === 'all' && <span className="txn-user-tag">{t.userName}</span>}
                        <span className="txn-cat-chip" style={{ background: `${meta.color}18`, color: meta.color }}>{meta.label}</span>
                        {t.type === 'transfer'
                          ? <span className="txn-bank-tag">Self Transfer</span>
                          : <span className="txn-bank-tag">{t.bank}</span>}
                        {t.source === 'statement' && <span className="txn-sms-tag">Statement</span>}
                        {recurringByUser[t.userId]?.byTxnId.has(t.id) && (
                          <span className="txn-recurring-tag">
                            <span className="material-symbols-outlined">autorenew</span>Recurring
                          </span>
                        )}
                      </span>
                      <span className="txn-corner">
                        {t.balance != null && <span className="txn-balance">Bal {formatINRShort(t.balance)}</span>}
                        {hasRealTime(t) && <span className="txn-time">{formatTime(t.date)}</span>}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          ))}
          {displayed.length > visibleCount && (
            <button className="txn-load-more" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
              Load 15 more ({displayed.length - visibleCount} remaining)
            </button>
          )}
        </div>
      </div>

      {/* Budget edit sheet — same add-txn-sheet-style modal pattern TransactionPanel.jsx
          uses for its own budgets, reused here for the selected family member's budget */}
      {budgetSheet && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setBudgetSheet(null)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{budgetSheet.label} Budget</span>
              <button className="add-txn-close" onClick={() => setBudgetSheet(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="add-field">
              <label className="add-label">Monthly limit (₹)</label>
              <input className="add-input" type="number" inputMode="decimal" placeholder="0.00" autoFocus
                value={budgetInput} onChange={e => setBudgetInput(e.target.value)} />
            </div>
            <button className="add-txn-submit" onClick={submitBudget}
              disabled={!budgetInput || isNaN(parseFloat(budgetInput)) || parseFloat(budgetInput) <= 0}>
              Save Budget
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
