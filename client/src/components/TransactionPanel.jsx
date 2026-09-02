import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Area, Bar, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ResponsiveContainer, XAxis, YAxis, Tooltip as RechartsTooltip } from 'recharts'
import { CATEGORIES, getCategoryMeta, loadCustomCategories, addCustomCategory, loadBanks, addBank, OVERALL_BUDGET_CATEGORY, hasRealTime, loadCategoryOverrides, addCategoryOverride, applyCategoryOverrides } from '../utils/txnMeta'
import { parsePhonePeStatementCsv } from '../utils/phonePeStatement'
import { parseHdfcStatementCsv } from '../utils/hdfcStatement'
import { detectRecurring } from '../utils/recurringDetection'
import { getCache, setCache } from '../lib/offlineCache'
import CornerMenu from './CornerMenu'

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
  { key: '3m', label: '3 months', days: 90 },
  { key: 'year', label: 'This year', days: 365 },
  { key: 'all', label: 'All time', days: null },
]

function formatTime(ms) {
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Best-effort starting point for "apply this category to every other transaction tagged
// like this one" — the account holder's own remark convention almost always puts the
// distinctive word last (e.g. "...-FOOD RAPIDO" → "RAPIDO"), so the last whitespace-
// separated token of the description is a reasonable default. Always user-editable before
// it's actually applied, since this is a guess, not a parse.
function guessKeyword(description) {
  const tokens = (description || '').trim().split(/\s+/)
  return tokens[tokens.length - 1] || ''
}

// Pinned to IST rather than the viewing device's own local timezone — this app deals
// exclusively in Indian bank statements, and computing "Today"/"Yesterday"/day-grouping
// off whatever timezone the browser happens to be set to (which can silently differ from
// IST — e.g. a device set to UTC, or a spoofed timezone) put two transactions minted
// milliseconds apart, on the same real IST calendar day, into different date groups even
// though the underlying stored timestamps were correct.
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
// Same "don't trust the browser's own timezone" fix as istDateKey, for calendar-boundary
// math (start of day / start of month) instead of just labeling. Works by doing the
// day/month arithmetic in UTC on a deliberately-shifted instant, so the result is the same
// regardless of what timezone this code happens to be running in.
function istMidnight(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS
}
function istMonthStart(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), 1) - IST_OFFSET_MS
}
// Start of the IST calendar month `n` months before the one containing `ms`.
function istMonthStartMinus(ms, n) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - n, 1) - IST_OFFSET_MS
}
// Parses a bare "YYYY-MM-DD" (from an <input type="date">) as IST midnight of that day,
// rather than letting `new Date(str)` treat it as UTC midnight and then silently drifting
// under browser-local re-interpretation.
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
  if (key === 'month') return istMonthStart(Date.now())
  const opt = ANALYTICS_RANGES.find(o => o.key === key)
  if (!opt.days) return 0
  return istMidnight(Date.now()) - (opt.days - 1) * 86400000
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

export default function TransactionPanel({ session, sendMsg, addListener, onHome, onProfileOpen }) {
  // Seeded from cache so something real renders even offline, before the live
  // transactions_get/budget_get replies below (or lack thereof) arrive.
  const [txns, setTxns]       = useState(() => getCache('transactions', session.userId) || [])
  const [tab, setTab]         = useState('all')
  const [sheetMode, setSheetMode] = useState(null) // null | 'add' | 'edit'
  const [form, setForm]       = useState(EMPTY_FORM)
  const [bulkKeyword, setBulkKeyword] = useState('')
  // Server-synced budgets: { [category]: monthlyLimit }, overall budget keyed by the
  // reserved OVERALL_BUDGET_CATEGORY. Both this user and their parent can set entries.
  const [budgets, setBudgets] = useState(() => getCache('budgets', session.userId) || {})
  const [budgetSheet, setBudgetSheet] = useState(null) // null | { category, label }
  const [budgetInput, setBudgetInput] = useState('')
  const [analyticsRange, setAnalyticsRange] = useState('month')
  const [customCategories, setCustomCategories] = useState(() => loadCustomCategories(session.userId))
  const [banks, setBanks] = useState(() => loadBanks(session.userId, []))
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)
  const [showFilters, setShowFilters] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [showStats, setShowStats] = useState(false)
  const [showCharts, setShowCharts] = useState(false)
  // Tapped heatmap day — `title` tooltips never fire on mobile touch (no hover state), so
  // the Spending Intensity heatmap needs its own tap-to-reveal instead.
  const [heatmapDay, setHeatmapDay] = useState(null)
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  // Quick-pick helper for the Date range filter below — jumping to "August 2026" used to
  // mean manually typing the same month into both the From and To date pickers. Purely a
  // convenience that fills dateFrom/dateTo; not itself part of the filter logic.
  const [monthPick, setMonthPick] = useState('')
  const statementInputRef = useRef(null)

  function handleMonthPick(monthStr) {
    setMonthPick(monthStr)
    if (!monthStr) return
    const [y, m] = monthStr.split('-').map(Number)
    const lastDay = new Date(y, m, 0).getDate() // day 0 of next month = last day of this one
    setDateFrom(`${monthStr}-01`)
    setDateTo(`${monthStr}-${String(lastDay).padStart(2, '0')}`)
    // The header's analytics-range dropdown combines with a custom date range as a floor
    // (see effectiveFromMs below — "This month" would otherwise force the combined range
    // to start in the CURRENT month, making a past month's pick collide with it into an
    // empty from-after-to range). "All time" has no floor, so the picked month always wins.
    setAnalyticsRange('all')
  }

  // Listen for incoming transaction confirmations (own), new ones from server, edits, deletes, and history
  useEffect(() => {
    return addListener((msg) => {
      // Every branch here is a server-confirmed state change (not an optimistic local
      // one), so it's also cached — keeps offline viewing fresh as of the last time this
      // screen was actually online, without a separate sync step.
      if (msg.type === 'transaction_new' && msg.fromUserId === session.userId) {
        setTxns(prev => {
          const exists = prev.find(t => t.id === msg.transaction.id)
          const next = exists ? prev : [msg.transaction, ...prev]
          setCache('transactions', session.userId, next)
          return next
        })
      }
      if (msg.type === 'transaction_updated' && msg.fromUserId === session.userId) {
        setTxns(prev => {
          const next = prev.map(t => t.id === msg.transaction.id ? msg.transaction : t)
          setCache('transactions', session.userId, next)
          return next
        })
      }
      if (msg.type === 'transaction_deleted' && msg.fromUserId === session.userId) {
        setTxns(prev => {
          const next = prev.filter(t => t.id !== msg.id)
          setCache('transactions', session.userId, next)
          return next
        })
      }
      if (msg.type === 'transactions_list' && msg.userId === session.userId) {
        setTxns(prev => {
          const ids = new Set(prev.map(t => t.id))
          const merged = [...prev, ...(msg.transactions || []).filter(t => !ids.has(t.id))]
          merged.sort((a, b) => b.date - a.date)
          setCache('transactions', session.userId, merged)
          return merged
        })
      }
      if (msg.type === 'transactions_cleared' && msg.userId === session.userId) {
        setTxns([])
        setCache('transactions', session.userId, [])
      }
      if (msg.type === 'budgets' && msg.userId === session.userId) {
        setBudgets(msg.budgets || {})
        setCache('budgets', session.userId, msg.budgets || {})
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
    setBulkKeyword('')
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
      // IST calendar day, not UTC — toISOString() is always UTC and would show the wrong
      // date in this picker for anything parsed at IST midnight (see istDateKey above).
      date: istDateKey(txn.date),
      bank: txn.type === 'transfer' ? '' : (txn.bank || ''),
      fromBank: txn.type === 'transfer' ? (txn.fromBank || '') : '',
      toBank: txn.type === 'transfer' ? (txn.toBank || '') : '',
    })
    // Left blank by default — bulk-recategorizing is opt-in, not something that fires
    // just because a keyword happens to be guessable from this transaction's narration.
    setBulkKeyword('')
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

  // Other transactions the bulk-recategorize keyword (edit sheet) would also move —
  // matched against description + merchant, same haystack applyCategoryOverrides checks.
  const bulkMatches = useMemo(() => {
    const kw = bulkKeyword.trim().toLowerCase()
    if (!kw || sheetMode !== 'edit') return []
    return txns.filter(t => t.id !== form.id && `${t.description || ''} ${t.merchant || ''}`.toLowerCase().includes(kw))
  }, [bulkKeyword, txns, form.id, sheetMode])

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
        date: form.date ? istDateInputToMs(form.date) : Date.now(),
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
        date: form.date ? istDateInputToMs(form.date) : Date.now(),
        bank: form.bank || 'Manual',
      }
    }

    if (sheetMode === 'edit') {
      const updated = { id: form.id, ...base }
      sendMsg({ type: 'transaction_update', transaction: updated })
      setTxns(prev => prev.map(t => t.id === form.id ? { ...t, ...updated } : t))

      // Bulk-recategorize every other transaction matching the same keyword, and persist
      // the correction so future statement imports auto-apply it too.
      const kw = bulkKeyword.trim()
      if (kw && form.type !== 'transfer' && bulkMatches.length > 0) {
        const catPatch = {
          category: form.category,
          ...(base.categoryLabel ? { categoryLabel: base.categoryLabel, categoryIcon: base.categoryIcon, categoryColor: base.categoryColor } : {}),
        }
        bulkMatches.forEach(t => {
          sendMsg({ type: 'transaction_update', transaction: { id: t.id, ...catPatch } })
        })
        const matchIds = new Set(bulkMatches.map(t => t.id))
        setTxns(prev => prev.map(t => matchIds.has(t.id) ? { ...t, ...catPatch } : t))
        const meta = [...CATEGORIES, ...customCategories].find(c => c.id === form.category)
        addCategoryOverride(session.userId, kw, meta || { id: form.category })
      }
    } else {
      const txn = { id: Math.random().toString(36).slice(2), userId: session.userId, userName: session.name, source: 'manual', balance: null, ...base }
      sendMsg({ type: 'transaction_add', transaction: txn })
      setTxns(prev => [txn, ...prev])
    }
    setForm(EMPTY_FORM)
    setBulkKeyword('')
    setSheetMode(null)
  }, [form, sheetMode, session, sendMsg, customCategories, bulkKeyword, bulkMatches])

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
    setMonthPick('')
    setSearchQuery('')
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
      const rawParsed = format.parse(text)
      if (rawParsed.length === 0) {
        window.alert(`No transactions found in that ${format.name} statement.`)
        return
      }
      // Apply any corrections the account holder has made before (edit sheet's "Also
      // recategorize matching transactions") so a fix made once keeps applying to every
      // future re-import, not just the transactions that existed at the time.
      const overrides = loadCategoryOverrides(session.userId)
      const parsed = overrides.length ? rawParsed.map(t => applyCategoryOverrides(t, overrides)) : rawParsed
      parsed.forEach(txn => sendMsg({ type: 'transaction_add', transaction: txn }))
      // Optimistic local update — server-side exact-id dedup means re-uploading an
      // overlapping statement won't create visible duplicates once transactions_list refreshes.
      setTxns(prev => {
        const existingIds = new Set(prev.map(t => t.id))
        return [...parsed.filter(t => !existingIds.has(t.id)), ...prev].sort((a, b) => b.date - a.date)
      })
      // A statement almost always covers a period that's already ended (last week/month),
      // and "This month" is scoped to the calendar month, not a rolling 30 days — so an
      // import done right after the month rolls over would otherwise land outside the
      // default view entirely, making a successful import look like it silently did
      // nothing. Widen to "All time" whenever anything imported falls before the
      // currently-selected range, so what was just imported is immediately visible.
      const earliestImported = Math.min(...parsed.map(t => t.date))
      if (earliestImported < rangeStart(analyticsRange)) {
        setAnalyticsRange('all')
      }
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
  const dateFromMs = dateFrom ? istDateInputToMs(dateFrom) : null
  const dateToMs   = dateTo ? istDateInputToMs(dateTo) + 86400000 - 1 : null
  const rangeStartMs = rangeStart(analyticsRange)
  const effectiveFromMs = rangeStartMs > 0 ? Math.max(dateFromMs ?? 0, rangeStartMs) : dateFromMs
  // The All/Spent/Received/Transfer tab and the narration search both feed this same
  // pipeline (see EMPTY_FILTERS note above) so the hero card and charts stay in sync with
  // them too, not just the list.
  const filteredTxns = useMemo(() => {
    let result = applyTxnFilters(txns, filters, effectiveFromMs, dateToMs).filter(t => tab === 'all' || t.type === tab)
    const q = searchQuery.trim().toLowerCase()
    if (q) {
      result = result.filter(t => `${t.description || ''} ${t.merchant || ''}`.toLowerCase().includes(q))
    }
    return result
  }, [txns, filters, effectiveFromMs, dateToMs, tab, searchQuery])
  const activeFilterCount =
    (filters.categories.length ? 1 : 0) +
    (filters.sources.length ? 1 : 0) + (filters.banks.length ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) + (searchQuery.trim() ? 1 : 0)

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
    const monthStart = istMonthStart(Date.now())
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
    return { spent, income, net: income - spent, categories, label: new Date(monthStart).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'long', year: 'numeric' }) }
  }, [filteredTxns])

  // Month-over-month spend change — always compares full calendar months, independent of the analytics range filter
  const momChange = useMemo(() => {
    const thisStart = istMonthStart(Date.now())
    const lastStart = istMonthStart(thisStart - 1)
    const thisSpend = txns.filter(t => t.type === 'debit' && t.date >= thisStart).reduce((s, t) => s + t.amount, 0)
    const lastSpend = txns.filter(t => t.type === 'debit' && t.date >= lastStart && t.date < thisStart).reduce((s, t) => s + t.amount, 0)
    if (lastSpend === 0) return null
    return Math.round(((thisSpend - lastSpend) / lastSpend) * 100)
  }, [txns])

  // Six full calendar months of spend (always the real last 6 months, independent of the
  // analytics range filter — same reasoning as momChange above), with a trailing 3-month
  // moving average as the smoothed trend line.
  const sixMonthTrend = useMemo(() => {
    const months = []
    for (let i = 5; i >= 0; i--) {
      const start = istMonthStartMinus(Date.now(), i)
      const end = istMonthStartMinus(Date.now(), i - 1)
      const spend = txns.filter(t => t.type === 'debit' && t.date >= start && t.date < end).reduce((s, t) => s + t.amount, 0)
      const label = new Date(start).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'short' })
      months.push({ label, spend })
    }
    return months.map((m, i) => {
      const window = months.slice(Math.max(0, i - 2), i + 1).map(x => x.spend)
      const trend = Math.round(window.reduce((s, v) => s + v, 0) / window.length)
      return { ...m, trend }
    })
  }, [txns])

  // Period-filtered analytics: trend, category/bank breakdowns, and quick-glance stats.
  // filteredTxns already has the analyticsRange lower bound baked in (see above), so this
  // is just an alias — kept for readability inside this block, not a second filter pass.
  const analyticsData = useMemo(() => {
    const inRange = filteredTxns
    const dayMap = {}
    inRange.forEach(t => {
      if (t.type === 'transfer') return
      // IST calendar day — toISOString() is UTC and would bucket an IST-midnight
      // transaction onto the previous day, silently shifting the whole trend chart.
      const key = istDateKey(t.date)
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
      .slice(0, 6)

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

  // Fixed last-30-calendar-days spend-per-day heatmap, independent of the analytics range
  // picker/Filters panel (mirrors reference "Spending Intensity" designs, which are always a
  // rolling 30-day window regardless of whatever period the rest of the page is scoped to).
  // Uses all of `txns`, not `filteredTxns`, for that reason.
  const spendingIntensity = useMemo(() => {
    const todayIst = istMidnight(Date.now())
    const days = []
    for (let i = 29; i >= 0; i--) {
      const dayStart = todayIst - i * 86400000
      days.push({ key: istDateKey(dayStart), amount: 0 })
    }
    const byKey = {}
    days.forEach(d => { byKey[d.key] = d })
    txns.forEach(t => {
      if (t.type !== 'debit') return
      const d = byKey[istDateKey(t.date)]
      if (d) d.amount += t.amount
    })
    const max = Math.max(1, ...days.map(d => d.amount))
    return days.map(d => ({ ...d, level: d.amount === 0 ? 0 : Math.min(4, Math.ceil((d.amount / max) * 4)) }))
  }, [txns])

  // Spending Categories is a Recharts PieChart — driven by the same
  // analyticsData.categories every other range-scoped card uses, so it can't drift out of
  // sync with the range/filter selection the way it once did when pinned to monthStats.
  const categoryPieData = useMemo(
    () => analyticsData.categories.map((c, i) => ({ id: i, label: `${c.label} · ${c.pct}%`, value: c.amount, color: c.color })),
    [analyticsData.categories]
  )

  // SVG polyline points for the spending-trend line chart — a 0..100 x 4..36 y viewBox,
  // padded off the top/bottom edges so the line's stroke never clips.
  const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  // bucket.key is already an IST YYYY-MM-DD string (see analyticsData above) — parsed
  // directly rather than round-tripped through another Date/timezone conversion.
  const shortDateLabel = (key) => {
    const [, mo, da] = key.split('-')
    return `${parseInt(da, 10)} ${MONTH_SHORT[parseInt(mo, 10) - 1]}`
  }

  // Spending vs Income Trend is a Recharts ComposedChart (Area + Line) — its own
  // monotone-interpolation curve rendering means no manual smoothing/overshoot math is
  // needed here anymore, unlike the hand-rolled version this replaces.
  const trendChartData = useMemo(() => {
    const { buckets } = analyticsData
    if (buckets.length < 2) return null
    return {
      labels: buckets.map(b => shortDateLabel(b.key)),
      debit: buckets.map(b => b.debit),
      credit: buckets.map(b => b.credit),
    }
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
        <CornerMenu
          session={session}
          sendMsg={sendMsg}
          addListener={addListener}
          showProfile
          onProfileOpen={onProfileOpen}
          extraItems={[
            { icon: 'upload_file', label: 'Upload statement', onClick: () => statementInputRef.current?.click() },
            { icon: 'delete_sweep', label: 'Clear all transactions', onClick: clearAllTxns, disabled: txns.length === 0 },
          ]}
        />
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
            <span className={`txn-budget-pct-badge${budgetOver ? ' over' : ''}`}>{budgetPct}% Spent</span>
            <span className="txn-budget-remaining">{formatINRShort(Math.max(0, overallBudget - monthStats.spent))} Remaining</span>
          </div>
          <div className="txn-budget-bar">
            <span className={`txn-budget-bar-fill${budgetOver ? ' over' : ''}`} style={{ width: `${budgetPct}%` }} />
          </div>

          {/* Hero section — the single place Spent/Received/Net live now, folded into the
              same card as the budget above instead of its own separate card (the two used
              to duplicate the same "period summary" idea as two stacked cards). Reflects
              BOTH the Filters panel AND the header's analytics range — uses the exact same
              analyticsData the charts below already use so the numbers always agree. */}
          <div className="txn-card-divider" />
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
              <div className="txn-chart-fill">
                {categoryPieData.length === 0 ? (
                  <p className="txn-donut-empty">No spending recorded in this period.</p>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 220 }}>
                    <ResponsiveContainer width="55%" height="100%">
                      <PieChart>
                        <Pie data={categoryPieData} dataKey="value" innerRadius={45} outerRadius={80} paddingAngle={2} stroke="none">
                          {categoryPieData.map((c) => <Cell key={c.id} fill={c.color} />)}
                        </Pie>
                        <RechartsTooltip formatter={(v, _n, entry) => [formatINRShort(v), entry.payload.label]} contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.12)' }} />
                      </PieChart>
                    </ResponsiveContainer>
                    <div className="txn-pie-legend">
                      {categoryPieData.map((c) => (
                        <span key={c.id} className="txn-pie-legend-item">
                          <span className="txn-pie-legend-dot" style={{ background: c.color }} />
                          {c.label}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Spending vs Income Trend</h3>
              <div className="txn-chart-fill">
                {!trendChartData ? (
                  <p className="txn-donut-empty">Not enough data yet.</p>
                ) : (
                  <ResponsiveContainer width="100%" height={220}>
                    <ComposedChart
                      data={trendChartData.labels.map((label, i) => ({ label, debit: trendChartData.debit[i], credit: trendChartData.credit[i] }))}
                      margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
                    >
                      <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="rgba(58,42,46,0.1)" />
                      <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'var(--txn-muted)' }} />
                      <YAxis axisLine={false} tickLine={false} width={40} tick={{ fontSize: 11, fill: 'var(--txn-muted)' }} tickFormatter={(v) => formatINRShort(v)} />
                      <RechartsTooltip formatter={(v) => formatINRShort(v)} contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.12)' }} />
                      <Legend wrapperStyle={{ fontSize: 12 }} />
                      <Area type="monotone" dataKey="debit" name="Spent" stroke="#e0345c" fill="#e0345c" fillOpacity={0.75} strokeWidth={2} />
                      <Line type="monotone" dataKey="credit" name="Received" stroke="#16a34a" strokeWidth={2.5} dot={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Six-Month Trend</h3>
              <div className="txn-chart-fill">
                <ResponsiveContainer width="100%" height={220}>
                  <ComposedChart data={sixMonthTrend} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                    <CartesianGrid vertical={false} strokeDasharray="3 3" stroke="rgba(58,42,46,0.1)" />
                    <XAxis dataKey="label" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'var(--txn-muted)' }} />
                    <YAxis axisLine={false} tickLine={false} width={48} tick={{ fontSize: 11, fill: 'var(--txn-muted)' }} tickFormatter={(v) => formatINRShort(v)} />
                    <RechartsTooltip formatter={(v) => formatINRShort(v)} contentStyle={{ borderRadius: 12, border: 'none', boxShadow: '0 4px 14px rgba(0,0,0,0.12)' }} />
                    <Bar dataKey="spend" name="Spent" fill="#c9a227" radius={[6, 6, 0, 0]} barSize={22} />
                    <Line type="monotone" dataKey="trend" name="Trend" stroke="#1f6b4d" strokeWidth={2.5} dot={false} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Spending Intensity — Last 30 Days</h3>
              <div className="txn-chart-fill">
                <div className="txn-heatmap-row">
                  {spendingIntensity.map(d => (
                    <button
                      key={d.key}
                      type="button"
                      className={`txn-heatmap-cell level-${d.level}${heatmapDay?.key === d.key ? ' selected' : ''}`}
                      title={`${d.key}: ${formatINRShort(d.amount)}`}
                      onClick={() => setHeatmapDay(d)}
                      aria-label={`${shortDateLabel(d.key)}: ${formatINRShort(d.amount)}`}
                    />
                  ))}
                </div>
                <div className="txn-heatmap-detail">
                  {heatmapDay
                    ? `${shortDateLabel(heatmapDay.key)} — ${formatINRShort(heatmapDay.amount)} spent`
                    : 'Tap a day to see the amount spent'}
                </div>
              </div>
            </div>

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">Top Categories</h3>
              <div className="txn-chart-fill">
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
            </div>

            <div className="txn-chart-card">
              <h3 className="txn-analytics-title">By Bank / Account</h3>
              <div className="txn-chart-fill">
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

            {budgetCategories.length > 0 && (
              <div className="txn-chart-card">
                <h3 className="txn-analytics-title">Category Budgets — {monthStats.label}</h3>
                <div className="txn-chart-fill txn-cat-budgets-list">
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
              <div className="txn-filter-group">
                <div className="txn-filter-group-head">
                  <span className="txn-filter-group-label">Search narration</span>
                </div>
                <input className="add-input txn-filter-search" type="text" placeholder="e.g. FOOD CHOTU"
                  value={searchQuery} onChange={e => setSearchQuery(e.target.value)} />
              </div>

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
                  <input className="add-input" type="month" value={monthPick} onChange={e => handleMonthPick(e.target.value)} aria-label="Jump to a specific month" />
                  <span className="txn-filter-daterange-sep">or pick dates</span>
                </div>
                <div className="txn-filter-daterange">
                  <input className="add-input" type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setMonthPick('') }} />
                  <span className="txn-filter-daterange-sep">to</span>
                  <input className="add-input" type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setMonthPick('') }} />
                </div>
              </div>

              {activeFilterCount > 0 && (
                <button className="txn-filter-reset" onClick={resetFilters}>Reset filters</button>
              )}
            </div>
          )}
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

                {/* Bulk-recategorize — for when the auto-categorization guessed wrong for
                    a whole tag/merchant, not just this one row (e.g. a personal "FOOD
                    RAPIDO" remark that's actually a Rapido ride, not food). Opt-in: blank
                    by default, only acts once a keyword is typed or suggested. */}
                {sheetMode === 'edit' && form.type !== 'transfer' && (
                  <div className="add-field">
                    <label className="add-label">Also recategorize matching transactions</label>
                    <div className="bulk-recat-row">
                      <input className="add-input" type="text" placeholder="e.g. RAPIDO"
                        value={bulkKeyword} onChange={e => setBulkKeyword(e.target.value)} />
                      {!bulkKeyword.trim() && guessKeyword(form.note) && (
                        <button type="button" className="bulk-recat-suggest" onClick={() => setBulkKeyword(guessKeyword(form.note))}>
                          Suggest "{guessKeyword(form.note)}"
                        </button>
                      )}
                    </div>
                    {bulkKeyword.trim() && (
                      <p className="bulk-recat-hint">
                        {bulkMatches.length === 0
                          ? `No other transactions contain "${bulkKeyword.trim()}".`
                          : `${bulkMatches.length} other transaction${bulkMatches.length !== 1 ? 's' : ''} will move to this category too — and future statement imports mentioning "${bulkKeyword.trim()}" will auto-categorize the same way.`}
                      </p>
                    )}
                  </div>
                )}

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
                value={form.date || istDateKey(Date.now())}
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
