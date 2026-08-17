import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { CATEGORIES, getCategoryMeta, loadCustomCategories, addCustomCategory, loadBanks, addBank, OVERALL_BUDGET_CATEGORY, hasRealTime } from '../utils/txnMeta'
import { parsePhonePeStatementCsv } from '../utils/phonePeStatement'
import { parseHdfcStatementCsv } from '../utils/hdfcStatement'
import { detectRecurring } from '../utils/recurringDetection'

// Supported statement formats, tried in order — auto-detected from file content so the
// upload flow stays a single tap (no "pick your bank" dropdown). Adding a new bank later is
// just one more { name, detect, parse } entry here.
const STATEMENT_FORMATS = [
  {
    name: 'PhonePe',
    detect: text => text.includes('Date,Time,Transaction Details,Transaction ID,UTR,Transaction Type,Credit/debit instrument,Amount'),
    parse: parsePhonePeStatementCsv,
  },
  {
    name: 'HDFC Bank',
    detect: text => text.includes('Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance')
      || text.slice(0, 2000).toUpperCase().includes('HDFC BANK'),
    parse: parseHdfcStatementCsv,
  },
]

const PAGE_SIZE = 15

// Fallback shown until the user (or their parent) has ever set an overall budget on the
// server — matches the previous localStorage-only default so first-run behavior is unchanged.
const DEFAULT_BUDGET = 20000

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

// True abbreviation (K/L/Cr) rather than just dropping decimals — for the tight 3-column
// Spent/Received/Net rows (hero card, budget stats), where an "All time" total across
// hundreds of transactions can run into 7+ digits and formatINRShort's full digit-grouped
// form (e.g. "₹11,49,258") is still too wide to fit a third of a phone-width card without
// wrapping mid-number.
function formatINRCompact(n) {
  const abs = Math.abs(n)
  const trim = (v) => v.toFixed(2).replace(/\.?0+$/, '')
  if (abs >= 1e7) return '₹' + trim(n / 1e7) + 'Cr'
  if (abs >= 1e5) return '₹' + trim(n / 1e5) + 'L'
  if (abs >= 1e3) return '₹' + trim(n / 1e3) + 'K'
  return '₹' + Math.round(n)
}

function rangeStart(key) {
  // "This month" specifically means the calendar month (1st through today) — same
  // definition monthStats/the Monthly Budget card already use. It used to be a rolling
  // 30-day window instead, so with a category filter active the Monthly Budget card and
  // the "This month" hero card could show two different totals for what looked like the
  // same period (e.g. Milk spend Aug 1–17 vs. spend across the last 30 days), which read
  // as the filter being broken rather than two different windows quietly disagreeing.
  if (key === 'month') {
    const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0)
    return d.getTime()
  }
  const opt = ANALYTICS_RANGES.find(o => o.key === key)
  const d = new Date(); d.setHours(0, 0, 0, 0)
  if (!opt.days) return 0
  d.setDate(d.getDate() - (opt.days - 1))
  return d.getTime()
}

const EMPTY_FORM = { id: null, amount: '', type: 'debit', category: 'manual', merchant: '', note: '', date: '', bank: '', fromBank: '', toBank: '' }

const SOURCE_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'statement', label: 'Statement' },
]

// Type (Spent/Received/Transfer) used to be BOTH a Tabs quick-toggle above the list AND its
// own multi-select "Type" group inside the Filters panel — two independent controls doing
// the same job, out of sync with each other (picking the "Spent" tab didn't touch
// filters.types and vice versa). Consolidated into just the Tabs, extended to include
// Transfer so nothing the old Type filter could do is lost.
const EMPTY_FILTERS = {
  categories: [], categoriesExclude: false,
  sources: [], sourcesExclude: false,
  banks: [], banksExclude: false,
}

// Applies the multi-select "include only" / "exclude these" filter groups plus an
// optional date-range bound. Every dimension combines with AND; within a dimension,
// an empty selection means "no filter" regardless of the include/exclude toggle.
function applyTxnFilters(list, filters, dateFromMs, dateToMs) {
  return list.filter(t => {
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
    if (dateFromMs != null && t.date < dateFromMs) return false
    if (dateToMs != null && t.date > dateToMs) return false
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

export default function TransactionPanel({ session, sendMsg, addListener, onHome }) {
  const [txns, setTxns]       = useState([])
  const [tab, setTab]         = useState('all')
  const [sheetMode, setSheetMode] = useState(null) // null | 'add' | 'edit'
  const [form, setForm]       = useState(EMPTY_FORM)
  // Server-synced budgets: { [category]: monthlyLimit }, overall budget keyed by the
  // reserved OVERALL_BUDGET_CATEGORY. Both this user and their parent can set entries.
  const [budgets, setBudgets] = useState({})
  const [budgetSheet, setBudgetSheet] = useState(null) // null | { category, label }
  const [budgetInput, setBudgetInput] = useState('')
  const [analyticsRange, setAnalyticsRange] = useState('month')
  const [customCategories, setCustomCategories] = useState(() => loadCustomCategories(session.userId))
  const [banks, setBanks] = useState(() => loadBanks(session.userId, []))
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [showFilters, setShowFilters] = useState(false)
  const [showStats, setShowStats] = useState(false)
  const [showCharts, setShowCharts] = useState(false)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
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
      if (msg.type === 'transactions_cleared' && msg.userId === session.userId) {
        setTxns([])
      }
      if (msg.type === 'budgets' && msg.userId === session.userId) {
        setBudgets(msg.budgets || {})
      }
    })
  }, [addListener, session.userId])

  // Fetch own transaction history + budgets on mount
  useEffect(() => {
    sendMsg({ type: 'transactions_get' })
    sendMsg({ type: 'budget_get' })
  }, [sendMsg])

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

  function clearAllTxns() {
    if (txns.length === 0) return
    const ok = window.confirm(`This will permanently delete all ${txns.length} transactions for ${session.name}. This cannot be undone. Continue?`)
    if (!ok) return
    sendMsg({ type: 'transaction_delete_all' })
    setTxns([])
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
    setDateFrom('')
    setDateTo('')
  }

  // Opens the shared add-txn-sheet-style modal, pre-filled with the current limit for
  // this category (blank if none is set yet) — used for both the overall budget and
  // each individual per-category budget.
  function openBudgetSheet(category, label) {
    const current = budgets[category]
    setBudgetInput(current != null ? String(current) : '')
    setBudgetSheet({ category, label })
  }

  function submitBudget() {
    if (!budgetSheet) return
    const num = parseFloat(budgetInput)
    if (isNaN(num) || num <= 0) return
    sendMsg({ type: 'budget_set', category: budgetSheet.category, monthlyLimit: num })
    setBudgets(prev => ({ ...prev, [budgetSheet.category]: num })) // optimistic
    setBudgetSheet(null)
  }

  async function handleStatementUpload(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-selecting the same file later
    if (!file) return
    try {
      const isExcel = /\.xlsx?$/i.test(file.name) || /excel|spreadsheetml/i.test(file.type)
      // Excel workbooks aren't plain text — convert the first sheet to the same CSV
      // shape the format parsers below already expect, so PhonePe/HDFC detection and
      // parsing logic stays identical regardless of which file type came in.
      const text = isExcel
        ? await (async () => {
            const { read, utils } = await import('xlsx')
            const buf = await file.arrayBuffer()
            const workbook = read(buf, { type: 'array' })
            const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
            return utils.sheet_to_csv(firstSheet)
          })()
        : await file.text()
      const format = STATEMENT_FORMATS.find(f => f.detect(text))
      if (!format) {
        window.alert('Couldn\'t recognize this statement format — supported: PhonePe, HDFC Bank')
        return
      }
      const parsed = format.parse(text)
      if (parsed.length === 0) {
        window.alert(`No transactions found in that ${format.name} statement.`)
        return
      }
      parsed.forEach(txn => sendMsg({ type: 'transaction_add', transaction: txn }))
      // Optimistic local update — server-side exact-id dedup means re-uploading an
      // overlapping statement won't create visible duplicates once transactions_list refreshes.
      setTxns(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        return [...parsed.filter(t => !existingIds.has(t.id)), ...prev].sort((a, b) => b.date - a.date)
      })
      window.alert(`Imported ${parsed.length} transactions from the ${format.name} statement.`)
    } catch (err) {
      window.alert('Could not read that file — make sure it\'s an unmodified statement CSV or Excel export.')
    }
  }

  // Deep filters (type/category/source/bank + include-vs-exclude per group, plus the
  // custom date range) apply across the board — the list below AND every analytics/
  // summary calculation derive from this same filtered set, per the family's request
  // that e.g. excluding "Transfer" recompute spending totals without transfers.
  //
  // The "This week/month/3 months/year/all time" range dropdown above the charts used to
  // ONLY scope the charts/hero card — the list below stayed unfiltered by it, so e.g.
  // picking "This month" made the hero card show 3 transactions while the full list below
  // kept showing months of history. Folded in here as an additional lower bound (combined
  // with the custom date range via the later of the two starts) so the range dropdown now
  // consistently scopes everything on the page, not just the charts.
  const dateFromMs = dateFrom ? new Date(dateFrom).setHours(0, 0, 0, 0) : null
  const dateToMs   = dateTo ? new Date(dateTo).setHours(23, 59, 59, 999) : null
  const rangeStartMs = rangeStart(analyticsRange)
  const effectiveFromMs = rangeStartMs > 0 ? Math.max(dateFromMs ?? 0, rangeStartMs) : dateFromMs
  // The All/Spent/Received/Transfer tab now feeds this same pipeline (see EMPTY_FILTERS
  // note above) so the hero card and charts stay in sync with it too, not just the list.
  const filteredTxns = useMemo(
    () => applyTxnFilters(txns, filters, effectiveFromMs, dateToMs).filter(t => tab === 'all' || t.type === tab),
    [txns, filters, effectiveFromMs, dateToMs, tab]
  )
  const activeFilterCount =
    (filters.categories.length ? 1 : 0) +
    (filters.sources.length ? 1 : 0) + (filters.banks.length ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0)

  const visibleTxns = filteredTxns.slice(0, visibleCount)
  const groups      = groupByDate(visibleTxns)

  // Real account balance, straight from the bank — the latest "Closing Balance" seen per
  // bank across ALL imported transactions (not the active filter, since your actual balance
  // doesn't change just because you're looking at a filtered view). Only statement imports
  // carry a balance (manual entries and PhonePe never do), so this is only as fresh as the
  // last statement you uploaded — not a live figure.
  const accountBalances = useMemo(() => {
    const latestByBank = {}
    txns.forEach(t => {
      if (t.balance == null || !t.bank) return
      if (!latestByBank[t.bank] || t.date > latestByBank[t.bank].date) {
        latestByBank[t.bank] = { date: t.date, balance: t.balance }
      }
    })
    return Object.entries(latestByBank).map(([bank, v]) => ({ bank, balance: v.balance, date: v.date }))
  }, [txns])

  // Distinct bank/account names actually present, for the Bank filter chips
  const filterBankOptions = useMemo(
    () => [...new Set(txns.map(t => t.type === 'transfer' ? t.fromBank : (t.bank || 'Manual')).filter(Boolean))],
    [txns]
  )
  const filterCategoryOptions = useMemo(
    () => [...CATEGORIES, ...customCategories].map(c => ({ value: c.id, label: c.label })),
    [customCategories]
  )

  // Current calendar month spend/income, for the budget card + category donut + this-month tiles
  const monthStats = useMemo(() => {
    const now = new Date()
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime()
    const monthTxns = filteredTxns.filter(t => t.date >= monthStart)
    const debitTxns = monthTxns.filter(t => t.type === 'debit')
    const spent = debitTxns.reduce((s, t) => s + t.amount, 0)
    const income = monthTxns.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
    const byCategory = {}
    debitTxns.forEach(t => {
      const meta = getCategoryMeta(t)
      if (!byCategory[meta.id]) byCategory[meta.id] = { ...meta, amount: 0 }
      byCategory[meta.id].amount += t.amount
    })
    const categories = Object.values(byCategory)
      .map(c => ({ ...c, pct: spent ? Math.round((c.amount / spent) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)
    return { spent, income, net: income - spent, categories, label: now.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' }) }
  }, [filteredTxns])

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

  // Period-filtered analytics: trend, category/bank breakdowns, and quick-glance stats.
  // filteredTxns already has the analyticsRange lower bound baked in (see above), so this
  // is just an alias — kept for readability inside this block, not a second filter pass.
  const analyticsData = useMemo(() => {
    const inRange = filteredTxns
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
    const rangeSpend = Object.values(byCategory).reduce((s, c) => s + c.amount, 0)
    const categories = Object.values(byCategory)
      .map(c => ({ ...c, pct: rangeSpend ? Math.round((c.amount / rangeSpend) * 100) : 0 }))
      .sort((a, b) => b.amount - a.amount)

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

    return { buckets, bucketMax, topCategories, topMax, categories, bankBreakdown, bankMax, avgDailySpend, biggestExpense, savingsRate, totalDebitInRange, totalCreditInRange, count: inRange.length }
  }, [filteredTxns, analyticsRange])

  // The donut used to be pinned to monthStats (always "this calendar month") even though
  // it sits right next to range-scoped cards sharing the same range selector above —
  // picking "All time" changed the trend/top-categories/bank cards but not this one,
  // which read as the filter being broken. Now driven by the same analyticsData.categories.
  const donutGradient = useMemo(() => {
    if (!analyticsData.categories.length) return null
    let cumulative = 0
    const stops = analyticsData.categories.map(c => {
      const from = cumulative
      cumulative += c.pct
      return `${c.color} ${from}% ${cumulative}%`
    })
    return `conic-gradient(${stops.join(', ')})`
  }, [analyticsData.categories])

  // SVG polyline points for the spending-trend line chart — a 0..100 x 4..36 y viewBox,
  // padded off the top/bottom edges so the line's stroke never clips.
  const trendLine = useMemo(() => {
    const { buckets, bucketMax } = analyticsData
    if (buckets.length < 2) return null
    const stepX = 100 / (buckets.length - 1)
    const toY = (v) => 36 - (v / bucketMax) * 32
    const toPoints = (key) => buckets.map((b, i) => `${(i * stepX).toFixed(2)},${toY(b[key]).toFixed(2)}`).join(' ')
    return { debit: toPoints('debit'), credit: toPoints('credit') }
  }, [analyticsData])

  const overallBudget = budgets[OVERALL_BUDGET_CATEGORY] ?? DEFAULT_BUDGET
  const budgetPct = overallBudget ? Math.min(100, Math.round((monthStats.spent / overallBudget) * 100)) : 0
  const budgetOver = monthStats.spent > overallBudget

  // Per-category budget rows: every category with spend this month, plus any category
  // that has a limit set but no spend yet (so a newly-set budget shows immediately),
  // sorted by spend so the categories most worth watching float to the top.
  const budgetCategories = useMemo(() => {
    const spentMap = {}
    monthStats.categories.forEach(c => { spentMap[c.id] = c })
    const allCatMeta = [...CATEGORIES, ...customCategories]
    const ids = new Set([
      ...Object.keys(spentMap),
      ...Object.keys(budgets).filter(id => id !== OVERALL_BUDGET_CATEGORY),
    ])
    return [...ids]
      .map(id => {
        const meta = spentMap[id] || allCatMeta.find(c => c.id === id) || getCategoryMeta({ category: id })
        return { ...meta, id, amount: spentMap[id]?.amount || 0, limit: budgets[id] }
      })
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 6)
  }, [monthStats.categories, budgets, customCategories])

  // Recurring-payment detection runs over the full loaded history (not the deep-filtered
  // list) — month-over-month regularity needs to see every month, regardless of whatever
  // tab/date-range filter is currently applied to the visible list.
  const recurring = useMemo(() => detectRecurring(txns), [txns])

  return (
    <div className="txn-screen">
      <div className="txn-header">
        <button className="txn-home-btn" onClick={onHome} aria-label="Home">
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        <span className="txn-title">Finance</span>
        <label className="txn-header-range">
          <span className="material-symbols-outlined">calendar_month</span>
          <select value={analyticsRange} onChange={e => setAnalyticsRange(e.target.value)}>
            {ANALYTICS_RANGES.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
        </label>
        <button className="txn-header-icon-btn" onClick={() => statementInputRef.current?.click()} aria-label="Upload bank statement">
          <span className="material-symbols-outlined">upload_file</span>
        </button>
        <button className="txn-header-icon-btn" onClick={clearAllTxns} disabled={txns.length === 0} aria-label="Clear all transactions">
          <span className="material-symbols-outlined">delete_sweep</span>
        </button>
        <input
          ref={statementInputRef}
          type="file"
          accept=".csv,text/csv,.xls,.xlsx,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
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
            <button
              type="button"
              className="txn-budget-amounts"
              onClick={() => openBudgetSheet(OVERALL_BUDGET_CATEGORY, 'Overall Monthly Budget')}
              aria-label="Edit monthly budget"
            >
              <span className="txn-budget-spent">{formatINRShort(monthStats.spent)}</span>
              <span className="txn-budget-of"> / {formatINRShort(overallBudget)}</span>
            </button>
          </div>
          <div className="txn-budget-row">
            <span className="txn-budget-pct">{budgetPct}% Spent</span>
            <span className="txn-budget-remaining">{formatINRShort(Math.max(0, overallBudget - monthStats.spent))} Remaining</span>
          </div>
          <div className="txn-budget-bar">
            <span className={`txn-budget-bar-fill${budgetOver ? ' over' : ''}`} style={{ width: `${budgetPct}%` }} />
          </div>

          {/* Spent/Received/Net used to also live in a separate "Summary bar" card right
              below this one, showing near-identical numbers — folded into one card here
              instead of two that said the same thing twice. */}
          <div className="txn-budget-stats">
            <div className="txn-budget-stat debit">
              <span className="txn-budget-stat-label">Spent</span>
              <span className="txn-budget-stat-val">{formatINRCompact(monthStats.spent)}</span>
            </div>
            <div className="txn-budget-stat credit">
              <span className="txn-budget-stat-label">Received</span>
              <span className="txn-budget-stat-val">{formatINRCompact(monthStats.income)}</span>
            </div>
            <div className={`txn-budget-stat ${monthStats.net >= 0 ? 'credit' : 'debit'}`}>
              <span className="txn-budget-stat-label">Net</span>
              <span className="txn-budget-stat-val">{formatINRCompact(Math.abs(monthStats.net))}</span>
            </div>
          </div>
        </div>

        {/* Analytics — always visible now (no expand step needed to see charts). The range
            picker now lives in the header (see txn-header-range) instead of a full-width
            row here, since it's the same analyticsRange state either way. */}
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
              <span className="txn-stat-value">{formatINRShort(analyticsData.avgDailySpend)}</span>
            </div>
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-rose-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-rose-dark)' }}>receipt_long</span>
                </span>
                <span className="txn-stat-label">Biggest Expense</span>
              </div>
              {analyticsData.biggestExpense ? (
                <>
                  <span className="txn-stat-value">{formatINRShort(analyticsData.biggestExpense.amount)}</span>
                  <span className="txn-stat-sub">{analyticsData.biggestExpense.merchant}</span>
                </>
              ) : <span className="txn-stat-value">—</span>}
            </div>
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-rose-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-rose-dark)' }}>show_chart</span>
                </span>
                <span className="txn-stat-label">Vs Last Month</span>
              </div>
              <span className={`txn-stat-value${momChange == null ? '' : momChange > 0 ? ' bad' : ' good'}`}>
                {momChange == null ? '—' : `${momChange > 0 ? '+' : ''}${momChange}%`}
              </span>
            </div>
            {recurring.groups.length > 0 && (
              <div className="txn-stat-card">
                <div className="txn-stat-top">
                  <span className="txn-stat-icon" style={{ background: 'var(--txn-gold-pastel)' }}>
                    <span className="material-symbols-outlined" style={{ color: '#8a6d00' }}>autorenew</span>
                  </span>
                  <span className="txn-stat-label">Recurring</span>
                </div>
                <span className="txn-stat-value">{formatINRShort(recurring.totalMonthly)}/mo</span>
                <span className="txn-stat-sub">{recurring.groups.length} payment{recurring.groups.length !== 1 ? 's' : ''}</span>
              </div>
            )}
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-green-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-green-dark)' }}>savings</span>
                </span>
                <span className="txn-stat-label">Savings Rate</span>
              </div>
              <span className={`txn-stat-value${analyticsData.savingsRate == null ? '' : analyticsData.savingsRate >= 0 ? ' good' : ' bad'}`}>
                {analyticsData.savingsRate == null ? '—' : `${analyticsData.savingsRate}%`}
              </span>
            </div>
            {/* Real account balance — straight from the bank's own statement, not computed
                by us, so it matches your banking app exactly (as of your last upload). */}
            {accountBalances.map(b => (
              <div key={b.bank} className="txn-stat-card">
                <div className="txn-stat-top">
                  <span className="txn-stat-icon" style={{ background: 'var(--txn-rose-pastel)' }}>
                    <span className="material-symbols-outlined" style={{ color: 'var(--txn-rose-dark)' }}>account_balance</span>
                  </span>
                  <span className="txn-stat-label">{b.bank}</span>
                </div>
                <span className="txn-stat-value">{formatINR(b.balance)}</span>
              </div>
            ))}
            {/* Net cash flow for whatever range is currently selected in the header —
                placed right after the bank balance tile so "real balance" and "period
                net" sit side by side. */}
            <div className="txn-stat-card">
              <div className="txn-stat-top">
                <span className="txn-stat-icon" style={{ background: 'var(--txn-green-pastel)' }}>
                  <span className="material-symbols-outlined" style={{ color: 'var(--txn-green-dark)' }}>account_balance_wallet</span>
                </span>
                <span className="txn-stat-label">{ANALYTICS_RANGES.find(o => o.key === analyticsRange)?.label} Net</span>
              </div>
              <span className={`txn-stat-value${analyticsData.totalCreditInRange - analyticsData.totalDebitInRange >= 0 ? ' good' : ' bad'}`}>
                {formatINRCompact(Math.abs(analyticsData.totalCreditInRange - analyticsData.totalDebitInRange))}
              </span>
              <span className="txn-stat-sub">{analyticsData.count} transaction{analyticsData.count !== 1 ? 's' : ''}</span>
            </div>
          </div>
          )}

          {/* Multiple chart cards, side by side on wider screens — collapsed by default */}
          {showCharts && (
          <div className="txn-charts-grid">
            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Spending Categories — {ANALYTICS_RANGES.find(o => o.key === analyticsRange)?.label}</h3>
              {analyticsData.categories.length === 0 ? (
                <p className="txn-donut-empty">No spending recorded in this period.</p>
              ) : (
                <div className="txn-donut-body">
                  <div className="txn-donut-ring" style={{ background: donutGradient }}>
                    <div className="txn-donut-hole">
                      <span className="material-symbols-outlined">pie_chart</span>
                    </div>
                  </div>
                  <div className="txn-donut-legend">
                    {analyticsData.categories.map(c => (
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
              <h3 className="txn-analytics-title">Top Categories</h3>
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

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">By Bank / Account</h3>
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

            {budgetCategories.length > 0 && (
              <div className="txn-chart-card">
                <h3 className="txn-analytics-title">Category Budgets — {monthStats.label}</h3>
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

        {/* Type tabs (compact, inline with the Filters toggle) + filters — type/category/
            source/bank multi-select + date range, all AND-combined and feeding both the
            list below and every analytics/summary figure above */}
        <div className="txn-controls-row">
          <div className="txn-tabs-inline">
            {['all','debit','credit','transfer'].map(t => (
              <button key={t} className={`txn-tab-inline${tab === t ? ' active' : ''}`} onClick={() => setTab(t)}>
                {t === 'all' ? 'All' : t === 'debit' ? 'Spent' : t === 'credit' ? 'Received' : 'Transfer'}
              </button>
            ))}
          </div>
          <button className="txn-filters-toggle" onClick={() => setShowFilters(v => !v)}>
            <span className="material-symbols-outlined">filter_list</span>
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
            <span className={`material-symbols-outlined txn-analytics-chevron${showFilters ? ' open' : ''}`}>expand_more</span>
          </button>
        </div>

        <div>
          {showFilters && (
            <div className="txn-filter-panel">
              <FilterGroup label="Category" options={filterCategoryOptions}
                selected={filters.categories} exclude={filters.categoriesExclude}
                onToggleOption={v => toggleFilterOption('categories', v)}
                onToggleMode={() => toggleFilterMode('categoriesExclude')} />

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

              <div className="txn-filter-group">
                <div className="txn-filter-group-head">
                  <span className="txn-filter-group-label">Date range</span>
                </div>
                <div className="txn-filter-daterange">
                  <input className="add-input" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
                  <span className="txn-filter-daterange-sep">to</span>
                  <input className="add-input" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} />
                </div>
              </div>

              {activeFilterCount > 0 && (
                <button className="txn-filter-reset" onClick={resetFilters}>Reset filters</button>
              )}
            </div>
          )}
        </div>

        {/* Hero card — live totals reflecting BOTH the Filters panel AND the analytics range
            dropdown above the charts carousel (previously only tracked the Filters panel,
            which read as "broken" since changing the range dropdown visibly changes the
            charts but silently did nothing here). Shown whenever either one departs from
            its default, and uses the exact same analyticsData the charts above already use
            so the numbers always agree. */}
        {(activeFilterCount > 0 || analyticsRange !== 'month') && (
          <div className="txn-hero-card">
            <div className="txn-hero-top">
              <span className="txn-hero-label">{ANALYTICS_RANGES.find(o => o.key === analyticsRange)?.label} Results</span>
              <span className="txn-hero-count">{analyticsData.count} transaction{analyticsData.count !== 1 ? 's' : ''}</span>
            </div>
            <div className="txn-hero-stats">
              <div className="txn-hero-stat debit">
                <span className="txn-hero-stat-label">Spent</span>
                <span className="txn-hero-stat-val">{formatINRCompact(analyticsData.totalDebitInRange)}</span>
              </div>
              <div className="txn-hero-stat credit">
                <span className="txn-hero-stat-label">Received</span>
                <span className="txn-hero-stat-val">{formatINRCompact(analyticsData.totalCreditInRange)}</span>
              </div>
              <div className={`txn-hero-stat ${analyticsData.totalCreditInRange - analyticsData.totalDebitInRange >= 0 ? 'credit' : 'debit'}`}>
                <span className="txn-hero-stat-label">Net</span>
                <span className="txn-hero-stat-val">{formatINRCompact(Math.abs(analyticsData.totalCreditInRange - analyticsData.totalDebitInRange))}</span>
              </div>
            </div>
          </div>
        )}

        {/* Transaction list */}
        <div className="txn-list-card">
          {txns.length === 0 && (
            <div className="txn-empty">
              <span className="material-symbols-outlined txn-empty-icon">credit_card_off</span>
              <p>No transactions yet</p>
              <p className="txn-empty-sub">Tap + to add a transaction</p>
            </div>
          )}
          {txns.length > 0 && filteredTxns.length === 0 && (
            <div className="txn-empty">
              <span className="material-symbols-outlined txn-empty-icon">filter_alt_off</span>
              <p>No transactions match your filters</p>
              <p className="txn-empty-sub">Try adjusting the filters above</p>
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
                  <div key={t.id} className="txn-row" onClick={() => openEdit(t)}>
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
                        <button
                          className="txn-row-delete"
                          onClick={(e) => { e.stopPropagation(); deleteTxn(t.id) }}
                          aria-label="Delete transaction"
                        >
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    </div>

                    {hasDesc && <p className="txn-desc">{t.description}</p>}

                    <div className="txn-card-bottom">
                      <span className="txn-meta">
                        <span className="txn-cat-chip" style={{ background: `${meta.color}18`, color: meta.color }}>{meta.label}</span>
                        {t.type === 'transfer'
                          ? <span className="txn-bank-tag">Self Transfer</span>
                          : <span className="txn-bank-tag">{t.bank}</span>}
                        {t.source === 'statement' && <span className="txn-sms-tag">Statement</span>}
                        {recurring.byTxnId.has(t.id) && (
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
          {filteredTxns.length > visibleCount && (
            <button className="txn-load-more" onClick={() => setVisibleCount(v => v + PAGE_SIZE)}>
              Load 15 more ({filteredTxns.length - visibleCount} remaining)
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

      {/* Budget edit sheet — same interaction pattern as the add/edit transaction sheet
          above, reused for both the overall budget and every per-category budget */}
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
