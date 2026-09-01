import { useEffect, useMemo, useState } from 'react'
import { Area, AreaChart, Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'
import { computeGoalStats, computeHomeStats } from '../utils/milestoneStats'
import { getCategoryMeta } from '../utils/txnMeta'
import { moodScore } from '../utils/journalFormat'
import { formatDueLabel } from '../utils/healthFormat'
import CornerMenu from './CornerMenu'

const PRAYER_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

// Compact K/L/Cr abbreviation for the large bento numbers — the full digit-grouped form
// (e.g. "₹3,01,562.00") is too wide for a headline number at 3xl+ and forces its grid item
// wider than the viewport (a grid item won't shrink below an unbroken token's width).
function formatINRCompact(n) {
  const abs = Math.abs(n)
  const trim = (v) => v.toFixed(2).replace(/\.?0+$/, '')
  if (abs >= 1e7) return '₹' + trim(n / 1e7) + 'Cr'
  if (abs >= 1e5) return '₹' + trim(n / 1e5) + 'L'
  if (abs >= 1e3) return '₹' + trim(n / 1e3) + 'K'
  return '₹' + Math.round(n)
}

function relativeTime(ms) {
  const diffMin = Math.max(0, Math.round((Date.now() - ms) / 60000))
  if (diffMin < 1) return 'Just now'
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  return new Date(ms).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })
}

function readNamazAll() {
  try {
    return JSON.parse(localStorage.getItem('meeee_namaz') || '{}')
  } catch {
    return {}
  }
}

function readNamazCount() {
  const today = readNamazAll()[todayKey()] || {}
  return Object.values(today).filter(Boolean).length
}

// Last 7 days' prayer count, for the weekday bar chart — real localStorage data, same
// shape NamazTracker.jsx itself reads, not sample data.
function readNamazWeekly() {
  const all = readNamazAll()
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const dayData = all[todayKey(d)] || {}
    days.push({ day: d.toLocaleDateString('en-US', { weekday: 'short' }), count: Object.values(dayData).filter(Boolean).length })
  }
  return days
}

function isFullPrayerDay(dayData) {
  return !!dayData && PRAYER_KEYS.every(k => !!dayData[k])
}

// Same current/longest streak definition as NamazTracker.jsx's own `streak`/`longestStreak`
// (a "full day" = all 5 prayers marked) — duplicated per this app's existing convention of
// each screen keeping its own copy of small derivations (TransactionPanel/AdminTransactionView
// do the same).
function readNamazStreaks() {
  const all = readNamazAll()
  let current = 0
  const cursor = new Date()
  if (!isFullPrayerDay(all[todayKey(cursor)])) cursor.setDate(cursor.getDate() - 1)
  while (isFullPrayerDay(all[todayKey(cursor)])) {
    current++
    cursor.setDate(cursor.getDate() - 1)
  }
  const fullDayKeys = Object.keys(all).filter(k => isFullPrayerDay(all[k])).sort()
  let longest = 0, run = 0, prevDate = null
  fullDayKeys.forEach(k => {
    const d = new Date(`${k}T00:00:00`)
    run = prevDate && Math.round((d - prevDate) / 86400000) === 1 ? run + 1 : 1
    longest = Math.max(longest, run)
    prevDate = d
  })
  return { current, longest: Math.max(longest, current) }
}

// Percentage of this-month days (so far) that were a full 5-prayer day - the same
// "on-time this month" style stat the reference app shows for its Prayer module.
function readNamazMonthRate() {
  const all = readNamazAll()
  const now = new Date()
  const daysElapsed = now.getDate()
  let fullDays = 0
  for (let d = 1; d <= daysElapsed; d++) {
    if (isFullPrayerDay(all[todayKey(new Date(now.getFullYear(), now.getMonth(), d))])) fullDays++
  }
  return daysElapsed > 0 ? Math.round((fullDays / daysElapsed) * 100) : 0
}

const CATEGORY_ICON = {
  upi: 'smartphone', bank: 'account_balance', food: 'restaurant', shopping: 'shopping_cart',
  transport: 'directions_car', utilities: 'bolt', manual: 'edit_note',
}

export default function Dashboard({ session, onSelect, sendMsg, addListener, showProfile, onProfileOpen }) {
  const [txns, setTxns] = useState([])
  const [khataContacts, setKhataContacts] = useState([])
  const [khataEntries, setKhataEntries] = useState([])
  const [goals, setGoals] = useState([])
  const [tasks, setTasks] = useState([])
  // Only fetched for the Streaks strip below — Journal's own streak/entries logic lives in
  // JournalPanel.jsx; this is a separate, minimal copy of just the streak math, same
  // "each screen keeps its own small derivation" convention as readNamazStreaks above.
  const [journalEntries, setJournalEntries] = useState([])
  // Fetched fresh here (Dashboard never loaded Health data before) purely for the Health
  // bento tile's sick-days/next-reminder stats — HealthTrackerPanel.jsx owns the real
  // add/edit/mark-done flows, this is a read-only summary same as Journal's above.
  const [healthEpisodes, setHealthEpisodes] = useState([])
  const [healthReminders, setHealthReminders] = useState([])
  // Bumped when a 'namaz_data' reply hydrates localStorage below, purely to force a
  // re-render — namazCount/namazWeekly/etc. are plain localStorage reads on every render
  // rather than state, so without this they'd only pick up the hydrated values on some
  // later unrelated re-render instead of as soon as the data arrives.
  const [namazTick, setNamazTick] = useState(0) // eslint-disable-line no-unused-vars
  const namazCount = readNamazCount()
  const namazWeekly = readNamazWeekly()
  const namazStreaks = readNamazStreaks()
  const namazMonthRate = readNamazMonthRate()

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
      if (msg.type === 'journal_data') {
        setJournalEntries(msg.entries || [])
      }
      if (msg.type === 'health_data') {
        setHealthEpisodes(msg.episodes || [])
        setHealthReminders(msg.reminders || [])
      }
      // Namaz/Qada now persist server-side (see NamazTracker.jsx), but this screen's own
      // stat helpers (readNamazAll/readNamazWeekly/readNamazStreaks/readNamazMonthRate,
      // above) still read straight out of localStorage — that logic is left untouched.
      // So on a second device that's never opened NamazTracker itself, hydrate those same
      // localStorage keys here, in the exact shape they already have, purely so this
      // screen's stats come out correct without duplicating any of its computation.
      //
      // Only write when the server actually HAS data (days.length > 0). An empty reply
      // just means nothing has migrated yet — NOT that local history should be erased.
      // Dashboard mounts (and fires this same namaz_data_get) before NamazTracker ever
      // gets a chance to run its own one-time migration, so unconditionally overwriting
      // localStorage here would wipe out a pre-existing device's local history the moment
      // Home renders, before NamazTracker could read and upload it.
      if (msg.type === 'namaz_data' && (msg.days || []).length > 0) {
        const days = {}
        msg.days.forEach((d) => {
          const { id, ...rest } = d
          days[id] = rest
        })
        localStorage.setItem('meeee_namaz', JSON.stringify(days))
        if (msg.qada) {
          const { id, ...qadaRest } = msg.qada
          localStorage.setItem('meeee_namaz_qada', JSON.stringify(qadaRest))
        }
        setNamazTick((t) => t + 1)
      }
    })
  }, [addListener, session.userId])

  useEffect(() => {
    sendMsg({ type: 'transactions_get' })
    sendMsg({ type: 'ledger_data_get' })
    sendMsg({ type: 'milestone_data_get' })
    sendMsg({ type: 'namaz_data_get' })
    sendMsg({ type: 'journal_data_get' })
    sendMsg({ type: 'health_data_get' })
  }, [sendMsg])

  const todayTxns = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    return txns
      .filter(t => t.date >= todayStart.getTime())
      .sort((a, b) => b.date - a.date)
  }, [txns])

  const monthTxns = useMemo(() => {
    const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0)
    return txns.filter(t => t.date >= monthStart.getTime())
  }, [txns])

  const netThisMonth = useMemo(() => {
    const debit = monthTxns.filter(t => t.type === 'debit').reduce((s, t) => s + t.amount, 0)
    const credit = monthTxns.filter(t => t.type === 'credit').reduce((s, t) => s + t.amount, 0)
    return credit - debit
  }, [monthTxns])

  // Real last-7-day debit total per day, feeding the Finance tile's mini trend chart —
  // not sample data, the same `txns` list the rest of this page already loads.
  const spendTrend = useMemo(() => {
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
    const days = []
    const byDay = {}
    for (let i = 6; i >= 0; i--) {
      const key = new Date(todayStart.getTime() - i * 86400000).toDateString()
      days.push(key)
      byDay[key] = 0
    }
    txns.forEach(t => {
      if (t.type !== 'debit') return
      const key = new Date(t.date).toDateString()
      if (key in byDay) byDay[key] += t.amount
    })
    return days.map(k => byDay[k])
  }, [txns])

  // Top spending categories this month, for the "Spend Mix" donut — same getCategoryMeta
  // helper TransactionPanel.jsx uses, so colors/labels agree with the Finance screen.
  const categoryBreakdown = useMemo(() => {
    const byCategory = {}
    monthTxns.filter(t => t.type === 'debit').forEach(t => {
      const meta = getCategoryMeta(t)
      if (!byCategory[meta.id]) byCategory[meta.id] = { ...meta, amount: 0 }
      byCategory[meta.id].amount += t.amount
    })
    return Object.values(byCategory).sort((a, b) => b.amount - a.amount).slice(0, 6)
  }, [monthTxns])

  // Same net-balance math as KhatabookPanel.jsx's own `totals` — a contact who owes the
  // user shouldn't cancel out against a different contact the user owes, so the two sides
  // are summed separately rather than netted.
  const khataTotals = useMemo(() => {
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
    return { youllGet, youllPay }
  }, [khataContacts, khataEntries])

  const activeGoals = useMemo(() => goals.filter(g => g.status !== 'archived'), [goals])
  const milestoneStats = useMemo(() => computeHomeStats(activeGoals, tasks), [activeGoals, tasks])
  // Up to 3 active goals, newest first, each paired with its own stats — the Milestone tile
  // below lists these individually (title + progress bar per goal) rather than just the one
  // newest goal, matching the reference design's "N active challenges" list.
  const topActiveGoals = useMemo(
    () => [...activeGoals]
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .slice(0, 3)
      .map(g => ({ goal: g, stats: computeGoalStats(g, tasks) })),
    [activeGoals, tasks]
  )

  // Whichever active Milestone currently has the longest live streak — a user can be running
  // several goals at once, and the Streaks strip below only has room for one number, so this
  // surfaces the one actually worth bragging about right now rather than always the newest.
  const bestMilestoneStreak = useMemo(() => {
    let best = null
    activeGoals.forEach((g) => {
      const stats = computeGoalStats(g, tasks)
      if (!best || stats.currentStreak > best.streak) best = { streak: stats.currentStreak, title: g.title }
    })
    return best
  }, [activeGoals, tasks])

  // Consecutive IST-ish calendar days with at least one Journal entry, ending today or
  // yesterday — same definition as JournalPanel.jsx's own `streak`, kept as a separate small
  // copy here (this screen's existing convention, see readNamazStreaks above) rather than
  // importing that component's internals.
  const journalStreak = useMemo(() => {
    const dateKeys = new Set(journalEntries.map((e) => todayKey(new Date(e.date))))
    const cursor = new Date()
    if (!dateKeys.has(todayKey(cursor))) {
      cursor.setDate(cursor.getDate() - 1)
      if (!dateKeys.has(todayKey(cursor))) return 0
    }
    let count = 0
    while (dateKeys.has(todayKey(cursor))) {
      count++
      cursor.setDate(cursor.getDate() - 1)
    }
    return count
  }, [journalEntries])

  // Last 7 IST-ish calendar days' mood, one point per day — same null-for-no-entry-day
  // approach as JournalPanel.jsx's own moodEnergyTrend, just condensed to 7 points instead
  // of 14 to fit this tile's smaller chart.
  const journalMoodTrend = useMemo(() => {
    const byDay = {}
    journalEntries.forEach((e) => {
      const key = todayKey(new Date(e.date))
      if (!byDay[key]) byDay[key] = []
      byDay[key].push(e)
    })
    const days = []
    for (let i = 6; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      const dayEntries = byDay[todayKey(d)] || []
      const mood = dayEntries.length ? dayEntries.reduce((s, e) => s + moodScore(e.mood), 0) / dayEntries.length : null
      days.push({ i, mood })
    }
    return days
  }, [journalEntries])

  const avgMood7d = useMemo(() => {
    const scored = journalMoodTrend.filter(d => d.mood != null)
    if (scored.length === 0) return null
    return scored.reduce((s, d) => s + d.mood, 0) / scored.length
  }, [journalMoodTrend])

  // Total days spent sick in the last 90 days — sums each episode's overlap with that
  // window (startDate through recoveryDate, or "now" while still active), not just an
  // episode count, so a single long illness weighs more than several short ones.
  const healthSickDays90d = useMemo(() => {
    const cutoff = Date.now() - 90 * 86400000
    return Math.round(healthEpisodes.reduce((sum, e) => {
      const start = Math.max(e.startDate, cutoff)
      const end = Math.min(e.recoveryDate ?? Date.now(), Date.now())
      return sum + Math.max(0, (end - start) / 86400000)
    }, 0))
  }, [healthEpisodes])

  const nextHealthReminder = useMemo(() => {
    const upcoming = healthReminders.filter(r => !r.completed).sort((a, b) => a.dueDate - b.dueDate)
    return upcoming[0] || null
  }, [healthReminders])

  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })

  return (
    <div className="dashboard relative h-full overflow-y-auto overflow-x-hidden surface-sand font-sans">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-48 left-1/2 size-[280px] -translate-x-1/2 rounded-full bg-[image:var(--gradient-gold)] opacity-25 blur-3xl animate-float sm:size-[440px] md:size-[640px]"
      />

      <main className="relative mx-auto w-full max-w-6xl px-4 pt-6 pb-28 sm:px-6 sm:pt-10 sm:pb-36">
        {/* Inline, top-right, in normal flow — replaces the old fixed CornerMenu that used
            to float over this hero (and everything else) instead of taking real header
            space. */}
        <div className="flex justify-end">
          <CornerMenu
            session={session}
            sendMsg={sendMsg}
            addListener={addListener}
            showProfile={showProfile}
            onProfileOpen={onProfileOpen}
          />
        </div>

        {/* Hero */}
        <section className="animate-fade-up text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3.5 py-1.5 text-[11px] font-semibold uppercase tracking-[0.2em] text-gold backdrop-blur">
            <span className="material-symbols-outlined text-sm">auto_awesome</span>
            {dateLabel}
          </span>
          <h1 className="mx-auto mt-6 max-w-3xl text-balance font-display text-4xl font-extrabold leading-[1.02] text-foreground sm:text-6xl">
            Welcome back,
            <span className="block text-gradient-gold">{session.name}.</span>
          </h1>
          <p className="mx-auto mt-5 max-w-xl text-sm leading-relaxed text-muted-foreground sm:text-base">
            Prayers, money, ledgers and milestones — tracked together, charted clearly, and designed
            to be opened every single morning.
          </p>
          <button
            type="button"
            onClick={() => onSelect('tour')}
            className="mt-6 inline-flex items-center gap-2 rounded-2xl border border-border bg-card px-5 py-3 text-sm font-semibold text-foreground transition-transform hover:scale-[1.03]"
          >
            Take the tour
          </button>
        </section>

        {/* Bento grid — each module gets exactly one card here (no separate streaks strip or
            "Explore the modules" section anymore, both of which used to repeat these same
            numbers a second/third time as you scrolled). */}
        <div className="mt-10 grid grid-cols-1 gap-4 stagger md:grid-cols-6">
            {/* Prayer big tile */}
            <button
              type="button"
              onClick={() => onSelect('namaz')}
              className="tile grain group col-span-1 flex min-w-0 flex-col justify-between p-6 text-left md:col-span-3 md:row-span-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Today &middot; Namaz</p>
                  <p className="num mt-3 text-5xl font-extrabold text-foreground">{namazCount}/5</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {namazCount === 5 ? 'All five prayed today' : `${5 - namazCount} prayer${5 - namazCount === 1 ? '' : 's'} left today`}
                  </p>
                </div>
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold transition-transform group-hover:rotate-12">
                  <span className="material-symbols-outlined text-xl">mosque</span>
                </span>
              </div>
              {namazWeekly.some(d => d.count > 0) && (
                <div className="mt-6 h-[132px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={namazWeekly} barCategoryGap={10}>
                      <XAxis
                        dataKey="day"
                        tickLine={false}
                        axisLine={false}
                        tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                      />
                      <Bar dataKey="count" radius={[6, 6, 6, 6]} fill="var(--chart-1)" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              {/* Streak + this-month rate folded into the hero tile's own footer, instead of
                  two more separate cards directly underneath repeating the same module. */}
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-foreground/10 pt-3">
                <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <span className="material-symbols-outlined text-sm text-warning">local_fire_department</span>
                  <span className="num text-foreground">{namazStreaks.current}d</span> streak
                  <span className="opacity-60">· best {namazStreaks.longest}</span>
                </span>
                <span className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                  <span className="num text-foreground">{namazMonthRate}%</span> this month
                </span>
              </div>
              <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-gold">
                Open prayer tracker
                <span className="material-symbols-outlined text-base">arrow_outward</span>
              </div>
            </button>

            {/* Cashflow */}
            <button type="button" onClick={() => onSelect('transactions')} className="tile col-span-1 min-w-0 p-6 text-left md:col-span-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Net this month</p>
                  <p className={`num mt-2 truncate text-3xl font-extrabold ${netThisMonth >= 0 ? 'text-success' : 'text-destructive'}`}>
                    {netThisMonth >= 0 ? '+' : '−'}{formatINRCompact(Math.abs(netThisMonth))}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{monthTxns.length} txns</span>
              </div>
              {spendTrend.some(v => v > 0) && (
                <div className="mt-4 h-[92px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={spendTrend.map((v, i) => ({ i, spent: v }))}>
                      <defs>
                        <linearGradient id="dashboardSpend" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-1)" stopOpacity={0.55} />
                          <stop offset="100%" stopColor="var(--chart-1)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey="spent" stroke="var(--chart-1)" strokeWidth={2.5} fill="url(#dashboardSpend)" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </button>

            {/* Category donut */}
            {categoryBreakdown.length > 0 && (
              <div className="tile col-span-1 min-w-0 p-6 md:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Spend mix</p>
                <div className="mt-2 h-[150px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={categoryBreakdown} dataKey="amount" innerRadius={40} outerRadius={62} paddingAngle={3} stroke="none">
                        {categoryBreakdown.map((c, i) => (
                          <Cell key={i} fill={c.color} />
                        ))}
                      </Pie>
                      <Tooltip
                        contentStyle={{ borderRadius: 12, border: '1px solid var(--chart-border)', background: 'var(--popover)', fontSize: 12 }}
                        formatter={(v) => formatINR(v)}
                      />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Khata */}
            <button type="button" onClick={() => onSelect('khatabook')} className="tile grain col-span-1 flex min-w-0 flex-col justify-between p-6 text-left md:col-span-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Khata book</p>
                <p className="num mt-2 truncate text-3xl font-extrabold text-success">{formatINRCompact(khataTotals.youllGet)}</p>
                <p className="text-xs text-muted-foreground">they owe you</p>
              </div>
              {(khataTotals.youllGet > 0 || khataTotals.youllPay > 0) && (
                <div className="mt-2.5 flex h-2 w-full overflow-hidden rounded-full bg-secondary">
                  <div
                    className="h-full bg-success"
                    style={{ width: `${(khataTotals.youllGet / (khataTotals.youllGet + khataTotals.youllPay)) * 100}%` }}
                  />
                  <div
                    className="h-full bg-destructive"
                    style={{ width: `${(khataTotals.youllPay / (khataTotals.youllGet + khataTotals.youllPay)) * 100}%` }}
                  />
                </div>
              )}
              <p className="num mt-2.5 truncate text-sm font-semibold text-destructive">
                {formatINRCompact(khataTotals.youllPay)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">you owe</span>
              </p>
            </button>

            {/* Milestones — up to 3 active goals listed with their own progress bar, instead
                of only ever showing the single newest one. bestMilestoneStreak folds the old
                separate Streaks-strip chip into this card's own header instead of a
                second/third place showing the same number. */}
            {topActiveGoals.length > 0 && (
              <button type="button" onClick={() => onSelect('milestone')} className="tile grain col-span-1 flex min-w-0 flex-col p-6 text-left md:col-span-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="min-w-0 truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {activeGoals.length} active challenge{activeGoals.length === 1 ? '' : 's'}
                  </p>
                  {bestMilestoneStreak ? (
                    <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-warning">
                      <span className="material-symbols-outlined text-sm">local_fire_department</span>
                      {bestMilestoneStreak.streak}d
                    </span>
                  ) : (
                    <span className="material-symbols-outlined shrink-0 text-base text-gold">flag</span>
                  )}
                </div>
                <div className="mt-2.5 flex min-w-0 flex-col gap-3">
                  {topActiveGoals.map(({ goal, stats }) => (
                    <div key={goal.id} className="min-w-0">
                      <p className="truncate text-sm font-bold text-foreground">{goal.title}</p>
                      <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-secondary">
                        <div
                          className="h-full rounded-full bg-[image:var(--gradient-gold)]"
                          style={{ width: `${stats.completionPct}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </button>
            )}

            {/* Journal */}
            <button type="button" onClick={() => onSelect('journal')} className="tile grain col-span-1 min-w-0 p-6 text-left md:col-span-3">
              <div className="flex items-baseline justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Journal</p>
                  <p className="num mt-2 truncate text-3xl font-extrabold text-foreground">
                    {avgMood7d != null ? avgMood7d.toFixed(1) : '—'}
                    <span className="ml-1 text-sm font-semibold text-muted-foreground">/5</span>
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{journalStreak}d streak · avg mood (7d)</span>
              </div>
              {journalMoodTrend.some(d => d.mood != null) && (
                <div className="mt-4 h-[92px] min-w-0">
                  <ResponsiveContainer width="100%" height="100%">
                    <AreaChart data={journalMoodTrend}>
                      <defs>
                        <linearGradient id="dashboardMood" x1="0" y1="0" x2="0" y2="1">
                          <stop offset="0%" stopColor="var(--chart-2)" stopOpacity={0.5} />
                          <stop offset="100%" stopColor="var(--chart-2)" stopOpacity={0} />
                        </linearGradient>
                      </defs>
                      <Area type="monotone" dataKey="mood" stroke="var(--chart-2)" strokeWidth={2.5} fill="url(#dashboardMood)" connectNulls />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
              )}
            </button>

            {/* Health */}
            <button type="button" onClick={() => onSelect('health')} className="tile grain col-span-1 flex min-w-0 flex-col justify-between p-6 text-left md:col-span-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Health</p>
                  <p className="num mt-2 text-3xl font-extrabold text-foreground">
                    {healthSickDays90d}
                    <span className="ml-1 text-sm font-semibold text-muted-foreground">sick days (90d)</span>
                  </p>
                </div>
                <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold">
                  <span className="material-symbols-outlined text-xl">health_and_safety</span>
                </span>
              </div>
              <p className="mt-2.5 text-sm text-muted-foreground">
                {nextHealthReminder
                  ? <>{nextHealthReminder.title} &middot; <span className="font-semibold text-foreground">{formatDueLabel(nextHealthReminder.dueDate)}</span></>
                  : 'No reminders due soon.'}
              </p>
            </button>
        </div>

        {/* Quick actions — one tap from Home straight into each module's most common action,
            instead of tile → module → find the add button. */}
        <div className="mt-4 grid grid-cols-4 gap-3">
          {[
            { key: 'namaz', icon: 'mosque', label: 'Log prayer' },
            { key: 'transactions', icon: 'add_card', label: 'Add expense' },
            { key: 'journal', icon: 'edit_note', label: 'Daily note' },
            { key: 'health', icon: 'health_and_safety', label: 'Log health' },
          ].map((a) => (
            <button
              key={a.key}
              type="button"
              onClick={() => onSelect(a.key)}
              className="tile flex flex-col items-center gap-2 p-4 text-center"
            >
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold">
                <span className="material-symbols-outlined text-lg">{a.icon}</span>
              </span>
              <p className="text-[11px] font-semibold text-foreground">{a.label}</p>
            </button>
          ))}
        </div>

        {/* Today's activity */}
        <h2 className="mb-5 mt-16 font-display text-xl font-bold text-foreground">Today's activity</h2>
        {todayTxns.length === 0 ? (
          <div className="tile flex flex-col items-center gap-2 p-10 text-center">
            <span className="material-symbols-outlined text-3xl text-gold opacity-60">history_toggle_off</span>
            <p className="text-sm text-muted-foreground">No activity yet today &mdash; it'll show up here as it happens.</p>
          </div>
        ) : (
          <div className="tile divide-y divide-border">
            {todayTxns.slice(0, 5).map(t => (
              <div key={t.id} className="flex min-w-0 items-center gap-3 p-4">
                <span
                  className={`grid size-9 shrink-0 place-items-center rounded-xl ${
                    t.type === 'credit' ? 'bg-success-soft text-success' : 'bg-destructive-soft text-destructive'
                  }`}
                >
                  <span className="material-symbols-outlined text-lg">{CATEGORY_ICON[t.category] || 'credit_card'}</span>
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{t.merchant}</p>
                  <p className="text-xs text-muted-foreground">{relativeTime(t.date)}</p>
                </div>
                <p className={`num shrink-0 text-sm font-bold ${t.type === 'credit' ? 'text-success' : 'text-destructive'}`}>
                  {t.type === 'credit' ? '+' : '−'}{formatINR(t.amount)}
                </p>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
