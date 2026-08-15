import { useState, useEffect, useMemo } from 'react'
import { getCategoryMeta } from '../utils/txnMeta'

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

// Resolves the [start, end] bound for a period preset, or for the "Custom range"
// option using the user-picked from/to dates (open-ended on either side if unset).
function periodBounds(period, customFrom, customTo) {
  if (period === 'custom') {
    const start = customFrom ? new Date(customFrom).setHours(0, 0, 0, 0) : 0
    const end = customTo ? new Date(customTo).setHours(23, 59, 59, 999) : Date.now()
    return { start, end }
  }
  const opt = ANALYTICS_RANGES.find(o => o.key === period)
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (!opt || !opt.days) return { start: 0, end: Date.now() }
  d.setDate(d.getDate() - (opt.days - 1))
  return { start: d.getTime(), end: Date.now() }
}

export default function AdminTransactionView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers]           = useState(initialUsers || [])
  const [txnsByUser, setTxnsByUser] = useState({})
  const [activeUser, setActiveUser] = useState('all')
  const [period, setPeriod]         = useState('week')
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo]     = useState('')
  const [showAnalytics, setShowAnalytics] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const [filters, setFilters]       = useState(EMPTY_FILTERS)
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

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
  }

  const activeFilterCount =
    (filters.types.length ? 1 : 0) + (filters.categories.length ? 1 : 0) +
    (filters.sources.length ? 1 : 0) + (filters.banks.length ? 1 : 0)

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
  const displayed  = applyTxnFilters(periodUserTxns, filters)
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
          <div className="txn-donut-title">Spending Categories</div>
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
                {categoryStats.categories.slice(0, 5).map(c => (
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
              {/* Quick-glance stat tiles */}
              <div className="txn-stat-grid">
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Avg Daily Spend</span>
                  <span className="txn-stat-value">{formatINRShort(trendData.avgDailySpend)}</span>
                </div>
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Biggest Expense</span>
                  {trendData.biggestExpense ? (
                    <>
                      <span className="txn-stat-value">{formatINRShort(trendData.biggestExpense.amount)}</span>
                      <span className="txn-stat-sub">{trendData.biggestExpense.merchant}</span>
                    </>
                  ) : <span className="txn-stat-value">—</span>}
                </div>
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Savings Rate</span>
                  <span className={`txn-stat-value${trendData.savingsRate == null ? '' : trendData.savingsRate >= 0 ? ' good' : ' bad'}`}>
                    {trendData.savingsRate == null ? '—' : `${trendData.savingsRate}%`}
                  </span>
                </div>
                <div className="txn-stat-card">
                  <span className="txn-stat-label">Transactions</span>
                  <span className="txn-stat-value">{displayed.length}</span>
                </div>
              </div>

              <h3 className="txn-analytics-title">Spending vs Income trend</h3>
              <div className="txn-trend-chart">
                {trendData.buckets.map(b => (
                  <div key={b.key} className="txn-trend-bar-wrap" title={`Spent ${formatINR(b.debit)}, Received ${formatINR(b.credit)}`}>
                    <div className="txn-trend-bar">
                      <span className="txn-trend-seg--debit" style={{ height: `${(b.debit / trendData.bucketMax) * 100}%` }} />
                      <span className="txn-trend-seg--credit" style={{ height: `${(b.credit / trendData.bucketMax) * 100}%` }} />
                    </div>
                  </div>
                ))}
              </div>
              <div className="txn-trend-legend">
                <span><span className="txn-trend-legend-dot" style={{ background: 'var(--txn-rose)' }} />Spent</span>
                <span><span className="txn-trend-legend-dot" style={{ background: 'var(--txn-green)' }} />Received</span>
              </div>

              <h3 className="txn-analytics-title">By bank / account</h3>
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
                return (
                  <div key={t.id} className="txn-row">
                    <div className="txn-cat-icon" style={{ background: `${meta.color}22` }}>
                      <span className="material-symbols-outlined" style={{ color: meta.color }}>{meta.icon}</span>
                    </div>
                    <div className="txn-row-info">
                      <span className="txn-merchant">{t.merchant}</span>
                      <span className="txn-meta">
                        {activeUser === 'all' && <span className="txn-user-tag">{t.userName}</span>}
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
    </div>
  )
}
