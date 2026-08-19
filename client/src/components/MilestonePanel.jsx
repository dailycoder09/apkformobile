import { useState, useEffect, useMemo, useRef } from 'react'
import confetti from 'canvas-confetti'
import { LineChart } from '@mui/x-charts/LineChart'
import { PieChart } from '@mui/x-charts/PieChart'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { computeGoalStats, computeHomeStats } from '../utils/milestoneStats'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function vibrate(pattern) {
  navigator.vibrate?.(pattern)
}

// Animates a number from 0 to `target` on mount/change — used for the hero ring and the
// home stat strip so key numbers "count up" rather than snapping in, a small satisfying
// touch used across well-reviewed habit apps. Skips straight to the target when the user
// has requested reduced motion (feedback stays, motion doesn't).
function useCountUp(target, duration = 600) {
  const [value, setValue] = useState(prefersReducedMotion() ? target : 0)
  useEffect(() => {
    if (prefersReducedMotion()) { setValue(target); return }
    let raf
    const start = performance.now()
    function tick(now) {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(target * eased))
      if (t < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, duration])
  return value
}

// Same "don't trust the browser's own timezone" pattern used throughout this app's other
// screens (TransactionPanel.jsx, KhatabookPanel.jsx) — duplicated rather than shared.
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istMidnight(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS
}
function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
}

const PERIOD_OPTIONS = [
  { key: 'week', label: '1 Week', days: 7 },
  { key: 'month', label: '1 Month', days: 30 },
  { key: 'year', label: '1 Year', days: 365 },
  { key: 'custom', label: 'Custom', days: null },
]

// Pre-built goal presets so a new milestone doesn't have to start from a blank form —
// onboarding research shows pre-built templates measurably lower time-to-value versus a
// blank canvas. Task text is modeled on real program structures (30-day bodyweight
// challenges, Duolingo's daily-quest sizing, spaced-repetition study plans,
// #100DaysOfCode's "code + build + log" convention), not generic placeholders.
const GOAL_TEMPLATES = [
  {
    icon: '📚', title: 'Study for an Exam', description: 'Spaced-repetition study plan: read+recall, flashcards, practice tests.',
    periodKey: 'custom', customDays: '14',
    templates: [
      { title: 'Active recall session', description: 'Read notes 15 min, then close them and write everything you remember for 10 min.' },
      { title: 'Flashcard review', description: '25 min spaced-repetition deck review (new + due cards).' },
      { title: 'Practice problems / past paper', description: '25 min of practice questions, no checking answers until time is up.' },
    ],
  },
  {
    icon: '💪', title: 'Get Fit (30-Day Challenge)', description: 'Progressive full-body bodyweight program, no equipment needed.',
    periodKey: 'custom', customDays: '30',
    templates: [
      { title: 'Squats', description: '3 sets of 12 reps, focus on depth and knee alignment.' },
      { title: 'Push-ups', description: '2 sets of 10-12 reps (knees down if needed).' },
      { title: 'Plank hold', description: '2-3 rounds of 20-30 sec, building toward 2 min by day 30.' },
    ],
  },
  {
    icon: '🗣️', title: 'Learn a Language', description: "Duolingo-style daily quest structure for steady vocabulary building.",
    periodKey: 'month', customDays: '',
    templates: [
      { title: 'Complete 2-3 lessons', description: 'Finish 2-3 app lessons or ~15-20 minutes of guided practice.' },
      { title: 'Spaced-repetition flashcards', description: 'Review due vocabulary cards for 5-10 minutes.' },
      { title: 'Speak or write one sentence', description: "Produce one new sentence out loud or in a notebook using today's words." },
    ],
  },
  {
    icon: '📖', title: 'Build a Reading Habit', description: 'Consistent daily reading targeting one book per month.',
    periodKey: 'month', customDays: '',
    templates: [
      { title: 'Read 20 pages', description: 'Roughly 20-30 min of focused reading, no phone nearby.' },
      { title: 'One-line takeaway', description: "Write a single sentence on what stood out from today's reading." },
    ],
  },
  {
    icon: '💻', title: 'Learn to Code', description: 'Daily coding habit following a structured curriculum (#100DaysOfCode style).',
    periodKey: 'custom', customDays: '30',
    templates: [
      { title: 'Code for 30-60 minutes', description: 'Work through the next module of your chosen curriculum.' },
      { title: 'Build or extend a mini project', description: "Apply today's concept in a small script or project file." },
      { title: 'Log progress', description: 'Write 1-2 sentences noting what you built or learned today.' },
    ],
  },
  {
    icon: '🌅', title: 'Morning Routine Reset', description: 'Short, stackable habits to anchor a consistent morning.',
    periodKey: 'week', customDays: '',
    templates: [
      { title: 'Hydrate first', description: 'Drink a full glass of water within 10 min of waking.' },
      { title: '5-minute stretch or walk', description: 'Light movement before checking your phone.' },
      { title: 'Plan top 3 tasks', description: 'Write the 3 most important things to do today.' },
    ],
  },
]

const QUOTES = [
  'Consistency is what transforms average into excellence.',
  "The secret of getting ahead is getting started.",
  'Small daily improvements are the key to staggering long-term results.',
  "Discipline is choosing between what you want now and what you want most.",
  "You don't have to be great to start, but you have to start to be great.",
  'Progress, not perfection.',
]
// Stable per-goal (not re-randomized on every render) — a cheap string hash picks a
// consistent index for a given goal id.
function quoteFor(goalId) {
  let h = 0
  for (let i = 0; i < goalId.length; i++) h = (h * 31 + goalId.charCodeAt(i)) >>> 0
  return QUOTES[h % QUOTES.length]
}

// A small curated palette (not per-category, just per-goal identity) so a list of
// several goals reads as distinct at a glance — list-card research recommendation:
// low-volume, high-identity lists (1-10 goals) justify a controlled per-item color
// signal, unlike a high-volume flat task list.
const GOAL_ACCENTS = ['#c9a227', '#2a8f7f', '#c15b3c', '#5b6fc9', '#a34a8f']
function accentFor(goalId) {
  let h = 0
  for (let i = 0; i < goalId.length; i++) h = (h * 31 + goalId.charCodeAt(i) * 7) >>> 0
  return GOAL_ACCENTS[h % GOAL_ACCENTS.length]
}

const EMPTY_GOAL_FORM = { title: '', description: '', periodKey: 'week', customDays: '', templates: [{ title: '', description: '' }] }

export default function MilestonePanel({ session, sendMsg, addListener, onHome }) {
  const [goals, setGoals] = useState([])
  const [tasks, setTasks] = useState([])
  const [selectedGoalId, setSelectedGoalId] = useState(null)
  const [selectedDayKey, setSelectedDayKey] = useState(null)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [editingTaskId, setEditingTaskId] = useState(null)
  const [editTaskForm, setEditTaskForm] = useState({ title: '', description: '' })
  const [showArchived, setShowArchived] = useState(false)
  const [showAnalytics, setShowAnalytics] = useState(false)

  const [goalSheetOpen, setGoalSheetOpen] = useState(false)
  const [goalForm, setGoalForm] = useState(EMPTY_GOAL_FORM)

  // Celebration state — a task id currently mid-micro-burst, and a "just unlocked" badge
  // toast. Both are ephemeral UI-only state, cleared on their own timers.
  const [burstTaskId, setBurstTaskId] = useState(null)
  const [badgeToast, setBadgeToast] = useState(null)
  // Badges already seen per goal, so opening a goal that already has "First Step" from a
  // past session doesn't re-announce it — only a badge newly crossed during this viewing
  // triggers the toast. Seeded when a goal is opened (see openGoalDetail).
  const seenBadgesRef = useRef({})

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'milestone_data') {
        setGoals(msg.goals || [])
        setTasks(msg.tasks || [])
      }
    })
  }, [addListener])

  useEffect(() => {
    sendMsg({ type: 'milestone_data_get' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Archived goals are kept (full history intact) but tucked out of the default list
  // and out of the home stat strip — a toggle reveals them without deleting anything.
  const visibleGoals = useMemo(() => goals.filter(g => g.status !== 'archived'), [goals])
  const archivedGoals = useMemo(() => goals.filter(g => g.status === 'archived'), [goals])
  const sortedGoals = useMemo(
    () => [...visibleGoals].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [visibleGoals]
  )
  const sortedArchivedGoals = useMemo(
    () => [...archivedGoals].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [archivedGoals]
  )

  // Thin stat strip shown above the goal list (home-screen research: lead with the
  // actionable list, not a heavy dashboard — a one-line strip is as far as a "hero"
  // element should go here). "On track" = today's tasks are either not due yet or
  // already all done, i.e. the goal isn't currently behind.
  const homeStats = useMemo(() => computeHomeStats(visibleGoals, tasks), [visibleGoals, tasks])

  const selectedGoal = goals.find(g => g.id === selectedGoalId) || null
  const selectedStats = useMemo(
    () => selectedGoal ? computeGoalStats(selectedGoal, tasks) : null,
    [selectedGoal, tasks]
  )
  const animatedDayCount = useCountUp(selectedStats?.daysElapsed ?? 0)
  const heroAccent = selectedGoal ? accentFor(selectedGoal.id) : null

  // "Meteors" celebratory accent — sparse, only while an active streak is running, and
  // memoized per-goal so positions don't reshuffle on every unrelated re-render.
  const meteors = useMemo(() => {
    const count = Math.min(selectedStats?.currentStreak || 0, 4)
    return Array.from({ length: count }, () => ({ left: 10 + Math.random() * 70, delay: Math.random() * 4.5 }))
  }, [selectedGoal?.id, selectedStats?.currentStreak])

  // Completion Trend uses MUI X Charts' LineChart (a real time-series chart component) —
  // everything else in this module stays hand-rolled CSS/SVG. `trendData` just reshapes
  // dailyCompletion into the two parallel arrays LineChart wants; MUI owns the actual
  // path/curve math (and, unlike the earlier hand-rolled version, correctly avoids
  // overshoot since it uses monotone interpolation internally, not a naive spline).
  const trendData = useMemo(() => {
    const pts = selectedStats?.dailyCompletion || []
    if (pts.length < 2) return null
    return { x: pts.map((_, i) => i), y: pts.map(p => p.pct) }
  }, [selectedStats?.dailyCompletion])

  // Overall task completion as a pie — a different lens than the trend/weekday charts
  // (those are over time; this is the single "how much is actually done" snapshot).
  const completionPieData = useMemo(() => {
    if (!selectedStats || selectedStats.totalTasks === 0) return null
    const remaining = selectedStats.totalTasks - selectedStats.completedTasks
    return [
      { id: 0, label: 'Done', value: selectedStats.completedTasks, color: heroAccent },
      { id: 1, label: 'Remaining', value: remaining, color: '#e5ddc8' },
    ]
  }, [selectedStats, heroAccent])

  // Real month-grid calendar for longer goals (>14 days) — a flat horizontal strip
  // works fine for a short goal (fits on one glance), but for month/year-length goals
  // users think in "did I do this in August vs September" terms, which only a proper
  // calendar with week rows and month boundaries can show (see research: GitHub-style
  // strips can't represent real month boundaries cleanly). Short goals keep the strip.
  const [calendarMonth, setCalendarMonth] = useState(null)
  const useCalendarGrid = (selectedStats?.totalDays ?? 0) > 14

  const calendarCells = useMemo(() => {
    if (!calendarMonth || !selectedStats) return []
    const year = calendarMonth.getFullYear()
    const month = calendarMonth.getMonth()
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const dayMap = {}
    selectedStats.days.forEach(d => { dayMap[d.key] = d })
    const cells = []
    for (let i = 0; i < firstWeekday; i++) cells.push(null)
    for (let day = 1; day <= daysInMonth; day++) {
      // Built from calendar components directly (not through a Date->ms->IST-key
      // round trip) — sidesteps the exact timezone-drift bug already fixed elsewhere
      // in this app (see istDateKey usage), since y/m/d here are already civil dates.
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      cells.push({ date: new Date(year, month, day), key, day: dayMap[key] || null })
    }
    return cells
  }, [calendarMonth, selectedStats])

  function goToCalMonth(delta) {
    setCalendarMonth(prev => {
      const d = new Date(prev)
      d.setMonth(d.getMonth() + delta)
      return d
    })
  }
  const calAtGoalStart = selectedGoal && calendarMonth
    && calendarMonth.getFullYear() === new Date(selectedGoal.startDate).getFullYear()
    && calendarMonth.getMonth() === new Date(selectedGoal.startDate).getMonth()
  const calAtGoalEnd = selectedGoal && calendarMonth && (() => {
    const end = new Date(selectedGoal.startDate + (selectedGoal.durationDays - 1) * 86400000)
    return calendarMonth.getFullYear() === end.getFullYear() && calendarMonth.getMonth() === end.getMonth()
  })()

  // Auto-flip a goal to 'completed' the moment every planned task is checked off — a
  // one-time transition, guarded so it only fires while the goal is still 'active'. Also
  // the trigger point for the full celebration moment (confetti + vibration) — the
  // biggest of the three celebration tiers, reserved for genuinely completing a goal.
  useEffect(() => {
    if (selectedGoal && selectedStats?.isComplete && selectedGoal.status === 'active') {
      const updated = { ...selectedGoal, status: 'completed' }
      setGoals(prev => prev.map(g => g.id === updated.id ? updated : g))
      sendMsg({ type: 'milestone_goal_update', goal: updated })
      if (!prefersReducedMotion()) {
        confetti({ particleCount: 140, spread: 90, origin: { y: 0.6 }, colors: ['#c9a227', '#8a6d1f', '#16a34a'] })
      }
      vibrate([15, 40, 15, 40, 30])
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedStats?.isComplete])

  // Watches the selected goal's badges and announces any newly crossed one with a toast
  // + micro-burst + vibration — badges already earned before this goal was opened don't
  // re-announce (seeded in openGoalDetail below).
  useEffect(() => {
    if (!selectedGoal || !selectedStats) return
    const seen = seenBadgesRef.current[selectedGoal.id] || new Set()
    const fresh = selectedStats.badges.find(b => !seen.has(b.id))
    if (fresh) {
      seenBadgesRef.current[selectedGoal.id] = new Set([...seen, ...selectedStats.badges.map(b => b.id)])
      setBadgeToast(fresh)
      vibrate([10, 30, 10])
      setTimeout(() => setBadgeToast(null), 2600)
    }
  }, [selectedGoal, selectedStats])

  function openGoalDetail(id) {
    setSelectedGoalId(id)
    setSelectedDayKey(istDateKey(Date.now()))
    setNewTaskTitle('')
    setShowAnalytics(false)
    const goal = goals.find(g => g.id === id)
    if (goal) {
      seenBadgesRef.current[id] = new Set(computeGoalStats(goal, tasks).badges.map(b => b.id))
      // Open the calendar on whichever month contains "today" if the goal is currently
      // active and today falls inside it, otherwise the goal's start month.
      const todayMid = istMidnight(Date.now())
      const startMid = istMidnight(goal.startDate)
      const endMid = startMid + (goal.durationDays - 1) * 86400000
      setCalendarMonth(new Date(todayMid >= startMid && todayMid <= endMid ? todayMid : startMid))
    }
  }

  function selectDay(day) {
    if (day.isFuture) return
    setSelectedDayKey(day.key)
    setNewTaskTitle('')
  }

  function openAddGoal() {
    setGoalForm(EMPTY_GOAL_FORM)
    setGoalSheetOpen(true)
  }

  function applyTemplate(t) {
    setGoalForm({
      title: t.title, description: t.description,
      periodKey: t.periodKey, customDays: t.customDays,
      templates: t.templates.map(tt => ({ ...tt })),
    })
  }

  function updateTemplate(i, field, value) {
    setGoalForm(f => ({ ...f, templates: f.templates.map((t, idx) => idx === i ? { ...t, [field]: value } : t) }))
  }
  function addTemplateRow() {
    setGoalForm(f => ({ ...f, templates: [...f.templates, { title: '', description: '' }] }))
  }
  function removeTemplateRow(i) {
    setGoalForm(f => ({ ...f, templates: f.templates.filter((_, idx) => idx !== i) }))
  }

  function submitGoal() {
    const title = goalForm.title.trim()
    const opt = PERIOD_OPTIONS.find(o => o.key === goalForm.periodKey)
    const durationDays = opt.days ?? parseInt(goalForm.customDays, 10)
    const templates = goalForm.templates
      .map(t => ({ title: t.title.trim(), description: t.description.trim() }))
      .filter(t => t.title)
    if (!title || !durationDays || durationDays <= 0) return
    const startDate = istMidnight(Date.now())
    const goal = {
      id: Math.random().toString(36).slice(2),
      title, description: goalForm.description.trim(),
      periodType: goalForm.periodKey, durationDays, startDate,
      createdAt: Date.now(), status: 'active',
      // One streak-freeze "grace" per goal — see computeGoalStats above.
      freezesTotal: 1, freezesUsed: [],
    }
    // Plan every day upfront: each task template gets its own row on every day of the
    // goal's period (a habit-style "do this every day" task), sent as one bulk message
    // rather than durationDays * templates.length individual round-trips.
    const newTasks = []
    if (templates.length) {
      for (let i = 0; i < durationDays; i++) {
        const dayMs = startDate + i * 86400000
        templates.forEach(({ title, description }) => {
          newTasks.push({ id: Math.random().toString(36).slice(2), goalId: goal.id, date: dayMs, title, description, done: false, createdAt: Date.now() })
        })
      }
    }
    setGoals(prev => [goal, ...prev])
    setTasks(prev => [...newTasks, ...prev])
    sendMsg({ type: 'milestone_goal_add', goal })
    if (newTasks.length) sendMsg({ type: 'milestone_tasks_bulk_add', tasks: newTasks })
    setGoalSheetOpen(false)
  }

  function deleteGoal(id) {
    setGoals(prev => prev.filter(g => g.id !== id))
    setTasks(prev => prev.filter(t => t.goalId !== id))
    sendMsg({ type: 'milestone_goal_delete', id })
    if (selectedGoalId === id) setSelectedGoalId(null)
  }

  // Archiving (vs. deleting) keeps the goal + its full history around for reference —
  // just tucked out of the default list view and out of the home stat strip's "on
  // track" count, rather than gone for good.
  function archiveGoal(goal) {
    const updated = { ...goal, status: 'archived' }
    setGoals(prev => prev.map(g => g.id === goal.id ? updated : g))
    sendMsg({ type: 'milestone_goal_update', goal: updated })
    setSelectedGoalId(null)
  }

  function unarchiveGoal(goal) {
    const updated = { ...goal, status: 'active' }
    setGoals(prev => prev.map(g => g.id === goal.id ? updated : g))
    sendMsg({ type: 'milestone_goal_update', goal: updated })
  }

  // Re-runs the same goal from today — reconstructs "templates" from day 1's task
  // titles/descriptions (the representative day for a template-generated goal) and
  // reapplies them across a fresh full period, exactly like creating it from scratch.
  function duplicateGoal(goal) {
    const firstDayKey = istDateKey(goal.startDate)
    const templateTasks = tasks.filter(t => t.goalId === goal.id && istDateKey(t.date) === firstDayKey)
    const startDate = istMidnight(Date.now())
    const newGoal = {
      id: Math.random().toString(36).slice(2),
      title: goal.title, description: goal.description,
      periodType: goal.periodType, durationDays: goal.durationDays, startDate,
      createdAt: Date.now(), status: 'active',
      freezesTotal: 1, freezesUsed: [],
    }
    const newTasks = []
    if (templateTasks.length) {
      for (let i = 0; i < goal.durationDays; i++) {
        const dayMs = startDate + i * 86400000
        templateTasks.forEach(t => {
          newTasks.push({ id: Math.random().toString(36).slice(2), goalId: newGoal.id, date: dayMs, title: t.title, description: t.description || '', done: false, createdAt: Date.now() })
        })
      }
    }
    setGoals(prev => [newGoal, ...prev])
    setTasks(prev => [...newTasks, ...prev])
    sendMsg({ type: 'milestone_goal_add', goal: newGoal })
    if (newTasks.length) sendMsg({ type: 'milestone_tasks_bulk_add', tasks: newTasks })
  }

  function toggleTask(task) {
    const updated = { ...task, done: !task.done }
    setTasks(prev => prev.map(t => t.id === task.id ? updated : t))
    sendMsg({ type: 'milestone_task_update', task: updated })
    // Smallest celebration tier — only on marking done (not un-checking), confined to
    // the row itself so it stays satisfying without demanding attention.
    if (updated.done) {
      vibrate(10)
      if (!prefersReducedMotion()) {
        setBurstTaskId(task.id)
        setTimeout(() => setBurstTaskId(null), 700)
      }
    }
  }

  function deleteTask(id) {
    setTasks(prev => prev.filter(t => t.id !== id))
    sendMsg({ type: 'milestone_task_delete', id })
  }

  function startEditTask(task) {
    setEditingTaskId(task.id)
    setEditTaskForm({ title: task.title, description: task.description || '' })
  }

  function saveEditTask(task) {
    const title = editTaskForm.title.trim()
    if (!title) return
    const updated = { ...task, title, description: editTaskForm.description.trim() }
    setTasks(prev => prev.map(t => t.id === task.id ? updated : t))
    sendMsg({ type: 'milestone_task_update', task: updated })
    setEditingTaskId(null)
  }

  function useFreeze(goal, dayKey) {
    const updated = { ...goal, freezesUsed: [...(goal.freezesUsed || []), dayKey] }
    setGoals(prev => prev.map(g => g.id === goal.id ? updated : g))
    sendMsg({ type: 'milestone_goal_update', goal: updated })
  }

  function addDayTask() {
    const title = newTaskTitle.trim()
    if (!title || !selectedGoal || !selectedDayKey) return
    const task = {
      id: Math.random().toString(36).slice(2),
      goalId: selectedGoal.id, date: istMidnight(new Date(`${selectedDayKey}T00:00:00+05:30`).getTime()),
      title, done: false, createdAt: Date.now(),
    }
    setTasks(prev => [task, ...prev])
    sendMsg({ type: 'milestone_task_add', task })
    setNewTaskTitle('')
  }

  const selectedDay = selectedStats?.days.find(d => d.key === selectedDayKey) || null

  return (
    <div className="mile-screen">
      <div className="mile-header">
        <button
          className="mile-home-btn"
          onClick={() => selectedGoalId ? setSelectedGoalId(null) : onHome()}
          aria-label={selectedGoalId ? 'Back to goals' : 'Home'}
        >
          <span className="material-symbols-outlined">arrow_back</span>
        </button>
        {/* The goal's own title is already the headline inside its hero card below —
            repeating it here too just duplicated the same line twice on screen. */}
        <span className="mile-title">Milestones</span>
      </div>

      {badgeToast && (
        <div className="mile-badge-toast" role="status">
          <span className="material-symbols-outlined mile-badge-toast-icon">{badgeToast.icon}</span>
          <span>{badgeToast.label} unlocked!</span>
        </div>
      )}

      <div className="mile-body">
        {!selectedGoal ? (
          <>
          {homeStats && (
            <div className="mile-stat-strip">
              <span><span className="material-symbols-outlined mile-inline-icon">local_fire_department</span> {homeStats.longestActiveStreak}-day best active streak</span>
              <span className="mile-stat-strip-dot">•</span>
              <span>{homeStats.onTrack}/{homeStats.total} goals on track today</span>
            </div>
          )}
          <div className="mile-list-card">
            {sortedGoals.length === 0 ? (
              <div className="mile-empty">
                <span className="material-symbols-outlined mile-empty-icon">flag</span>
                <p>No goals yet</p>
                <p className="mile-empty-sub">Tap + to set your first milestone</p>
              </div>
            ) : sortedGoals.map((g, idx) => {
              const stats = computeGoalStats(g, tasks)
              const accent = accentFor(g.id)
              const today = stats.days.find(d => d.isToday)
              const dueToday = today && today.tasks.length > 0 && !today.allDone
              return (
                <div key={g.id} className="mile-goal-row" style={{ '--i': idx, '--goal-accent': accent }} onClick={() => openGoalDetail(g.id)}>
                  <div className="mile-ring" style={{ background: `conic-gradient(${accent} ${stats.completionPct * 3.6}deg, rgba(58,42,46,0.08) 0deg)` }}>
                    <div className="mile-ring-hole">{stats.completionPct}%</div>
                  </div>
                  <div className="mile-goal-info">
                    <span className="mile-goal-title">
                      {g.title}
                      {g.status === 'completed' && <span className="material-symbols-outlined mile-inline-icon done">check_circle</span>}
                      {g.status === 'archived' && <span className="mile-archived-tag">Archived</span>}
                      {dueToday && <span className="mile-due-dot" title="Due today" />}
                    </span>
                    <span className="mile-goal-sub">
                      Day {stats.daysElapsed}/{stats.totalDays}
                      {stats.currentStreak > 0 && <> · <span className="material-symbols-outlined mile-inline-icon">local_fire_department</span>{stats.currentStreak}</>}
                    </span>
                  </div>
                  <div className="mile-goal-row-actions">
                    <button
                      className="mile-row-delete"
                      onClick={(e) => { e.stopPropagation(); duplicateGoal(g) }}
                      aria-label="Duplicate goal"
                      title="Start again from today"
                    >
                      <span className="material-symbols-outlined">content_copy</span>
                    </button>
                    <button
                      className="mile-row-delete"
                      onClick={(e) => { e.stopPropagation(); deleteGoal(g.id) }}
                      aria-label="Delete goal"
                    >
                      <span className="material-symbols-outlined">delete</span>
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {archivedGoals.length > 0 && (
            <div className="mile-archived-section">
              <button type="button" className="mile-archived-toggle" onClick={() => setShowArchived(v => !v)}>
                <span className="material-symbols-outlined">{showArchived ? 'expand_less' : 'expand_more'}</span>
                {showArchived ? 'Hide' : 'Show'} archived ({archivedGoals.length})
              </button>
              {showArchived && (
                <div className="mile-list-card">
                  {sortedArchivedGoals.map(g => {
                    const stats = computeGoalStats(g, tasks)
                    return (
                      <div key={g.id} className="mile-goal-row mile-goal-row--archived" onClick={() => openGoalDetail(g.id)}>
                        <div className="mile-ring" style={{ background: `conic-gradient(var(--mile-muted) ${stats.completionPct * 3.6}deg, rgba(58,42,46,0.06) 0deg)` }}>
                          <div className="mile-ring-hole">{stats.completionPct}%</div>
                        </div>
                        <div className="mile-goal-info">
                          <span className="mile-goal-title">{g.title} <span className="mile-archived-tag">Archived</span></span>
                          <span className="mile-goal-sub">Day {stats.daysElapsed}/{stats.totalDays}</span>
                        </div>
                        <button
                          className="mile-row-delete"
                          onClick={(e) => { e.stopPropagation(); deleteGoal(g.id) }}
                          aria-label="Delete goal"
                        >
                          <span className="material-symbols-outlined">delete</span>
                        </button>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
          </>
        ) : (
          <>
            <div className="mile-summary-card">
              <div className="mile-card-toolbar">
                <button type="button" className="mile-toolbar-btn" onClick={() => duplicateGoal(selectedGoal)} aria-label="Duplicate goal" title="Start again from today">
                  <span className="material-symbols-outlined">content_copy</span>
                </button>
                {selectedGoal.status === 'archived' ? (
                  <button type="button" className="mile-toolbar-btn" onClick={() => unarchiveGoal(selectedGoal)} aria-label="Unarchive goal" title="Unarchive">
                    <span className="material-symbols-outlined">unarchive</span>
                  </button>
                ) : (
                  <button type="button" className="mile-toolbar-btn" onClick={() => archiveGoal(selectedGoal)} aria-label="Archive goal" title="Archive">
                    <span className="material-symbols-outlined">archive</span>
                  </button>
                )}
                <button type="button" className="mile-toolbar-btn danger" onClick={() => deleteGoal(selectedGoal.id)} aria-label="Delete goal" title="Delete">
                  <span className="material-symbols-outlined">delete</span>
                </button>
              </div>
              <div className="mile-summary-hero">
                {meteors.length > 0 && (
                  <span className="mile-meteors" aria-hidden="true">
                    {meteors.map((m, i) => (
                      <i key={i} className="mile-meteor" style={{ left: `${m.left}%`, animationDelay: `${m.delay}s` }} />
                    ))}
                  </span>
                )}
                <div className="mile-ring-wrap">
                  <div className="mile-ring-glow" />
                  <div className="mile-ring mile-ring-lg" style={{ background: `conic-gradient(var(--txn-gold) ${animatedDayCount / selectedStats.totalDays * 360}deg, rgba(58,42,46,0.08) 0deg)` }}>
                    <div className="mile-ring-hole mile-ring-hole-lg">
                      <span className="mile-ring-day">{animatedDayCount}</span>
                      <span className="mile-ring-of">of {selectedStats.totalDays} days</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="mile-summary-status-row">
                <span className={`mile-status-pill${selectedGoal.status === 'completed' ? ' complete' : ''}`}>
                  {selectedGoal.status === 'archived' ? 'Archived' : selectedGoal.status === 'completed' ? 'Completed' : 'Active Challenge'}
                </span>
              </div>

              {/* The goal title as a real headline, not just the small page-header label —
                  this is the thing the whole card is about, it should read like it. */}
              <h2 className="mile-summary-title">{selectedGoal.title}</h2>

              <div className="mile-motivation-box">
                <span className="mile-motivation-box-icon"><span className="material-symbols-outlined">local_fire_department</span></span>
                <div>
                  <span className="mile-motivation-label">Motivation Score</span>
                  <span className="mile-motivation-val">{selectedStats.motivationScore}<span className="mile-motivation-max">/100</span></span>
                </div>
                <span className="mile-freeze-chip" title="Streak freezes protect your streak on a missed day">
                  <span className="material-symbols-outlined mile-inline-icon">ac_unit</span> {selectedStats.freezesRemaining}
                </span>
              </div>

              {selectedGoal.description && <p className="mile-summary-desc">{selectedGoal.description}</p>}
              <p className="mile-quote">"{quoteFor(selectedGoal.id)}"</p>
              {selectedStats.badges.length > 0 && (
                <>
                  <div className="mile-card-divider" />
                  <div className="mile-badge-row">
                    {selectedStats.badges.map(b => (
                      <span key={b.id} className="mile-badge-chip lg"><span className="material-symbols-outlined mile-inline-icon">{b.icon}</span> {b.label}</span>
                    ))}
                  </div>
                </>
              )}
            </div>

            <div className="mile-list-card mile-heatmap-card">
              <h3 className="mile-section-title">Progress Map</h3>
              {!useCalendarGrid ? (
                <div className="mile-heatmap-row">
                  {selectedStats.days.map(d => (
                    <button
                      key={d.key}
                      type="button"
                      className={`mile-heatmap-cell${d.allDone ? ' done' : ''}${d.frozen ? ' frozen' : ''}${d.isFuture ? ' future' : ''}${d.key === selectedDayKey ? ' selected' : ''}${d.isToday ? ' today' : ''}`}
                      onClick={() => selectDay(d)}
                      disabled={d.isFuture}
                      aria-label={`${formatDate(d.date)}: ${d.tasks.length} task(s), ${d.frozen ? 'streak frozen' : d.allDone ? 'all done' : 'in progress'}`}
                    />
                  ))}
                </div>
              ) : calendarMonth && (
                <div className="mile-cal">
                  <div className="mile-cal-header">
                    <button className="mile-cal-nav" onClick={() => goToCalMonth(-1)} disabled={calAtGoalStart} aria-label="Previous month">‹</button>
                    <span className="mile-cal-title">{calendarMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}</span>
                    <button className="mile-cal-nav" onClick={() => goToCalMonth(1)} disabled={calAtGoalEnd} aria-label="Next month">›</button>
                  </div>
                  <div className="mile-cal-weekdays">
                    {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => <span key={i} className="mile-cal-weekday">{d}</span>)}
                  </div>
                  <div className="mile-cal-grid">
                    {calendarCells.map((cell, i) => {
                      if (!cell) return <span key={`b${i}`} className="mile-cal-cell mile-cal-cell--blank" />
                      const { date, key, day } = cell
                      const isToday = key === istDateKey(Date.now())
                      if (!day) {
                        return (
                          <span key={key} className="mile-cal-cell mile-cal-cell--outside">
                            <span className="mile-cal-daynum">{date.getDate()}</span>
                          </span>
                        )
                      }
                      const total = day.tasks.length
                      const done = day.tasks.filter(t => t.done).length
                      const fillStyle = day.isFuture ? {} : day.allDone
                        ? { background: heroAccent }
                        : total > 0
                          ? { background: `conic-gradient(${heroAccent} ${(done / total) * 360}deg, rgba(138,109,31,0.1) 0deg)` }
                          : {}
                      return (
                        <button
                          key={key} type="button"
                          className={`mile-cal-cell${isToday ? ' mile-cal-cell--today' : ''}${day.isFuture ? ' mile-cal-cell--future' : ''}`}
                          style={fillStyle}
                          onClick={() => !day.isFuture && selectDay(day)}
                          disabled={day.isFuture}
                          aria-label={`${formatDate(date.getTime())}: ${total ? `${done}/${total} tasks done` : 'nothing planned'}`}
                        >
                          <span className="mile-cal-daynum" style={day.allDone ? { color: '#fff' } : {}}>{date.getDate()}</span>
                          {day.frozen && <span className="material-symbols-outlined mile-cal-freeze">ac_unit</span>}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}
            </div>

            {selectedStats.dailyCompletion.length > 0 && (
              <div className="mile-list-card mile-analytics-card">
                <button type="button" className="mile-analytics-toggle" onClick={() => setShowAnalytics(v => !v)}>
                  <span className="material-symbols-outlined">monitoring</span>
                  Milestone Analytics
                  <span className={`material-symbols-outlined mile-analytics-chevron${showAnalytics ? ' open' : ''}`}>expand_more</span>
                </button>
                {showAnalytics && (
                  <ThemeProvider theme={createTheme({ palette: { primary: { main: heroAccent } } })}>
                    <div className="mile-analytics-carousel">
                      <div className="mile-chart-slide">
                        <h3 className="mile-section-title">Completion Trend</h3>
                        {!trendData ? (
                          <p className="mile-empty-sub mile-focus-empty">Check back tomorrow to see your trend.</p>
                        ) : (
                          <LineChart
                            key={selectedGoal.id}
                            xAxis={[{ data: trendData.x, scaleType: 'point', valueFormatter: (i) => `Day ${i + 1}` }]}
                            yAxis={[{ min: 0, max: 100 }]}
                            series={[{ data: trendData.y, area: true, color: heroAccent, showMark: trendData.y.length <= 20, valueFormatter: (v) => `${v}%` }]}
                            height={160}
                            margin={{ top: 8, right: 8, bottom: 20, left: 28 }}
                            grid={{ horizontal: true }}
                          />
                        )}
                      </div>

                      <div className="mile-chart-slide">
                        <h3 className="mile-section-title">Completion Breakdown</h3>
                        {!completionPieData ? (
                          <p className="mile-empty-sub mile-focus-empty">No tasks planned yet.</p>
                        ) : (
                          <PieChart
                            key={selectedGoal.id}
                            series={[{ data: completionPieData, innerRadius: 45, paddingAngle: 2, cornerRadius: 4, arcLabel: (item) => `${item.value}` }]}
                            height={160}
                            slotProps={{ legend: { direction: 'horizontal', position: { vertical: 'bottom', horizontal: 'center' } } }}
                          />
                        )}
                      </div>

                      <div className="mile-chart-slide">
                        <h3 className="mile-section-title">Best Days of the Week</h3>
                        <div className="mile-bar-chart mile-bar-chart-week">
                          {selectedStats.weekdayStats.map((w, i) => (
                            <div key={w.day} className="mile-bar-col" title={`${w.day}: ${w.avgPct ?? 0}%`}>
                              <div
                                className={`mile-bar-fill${(w.avgPct ?? 0) >= 100 ? ' full' : ''}${w.avgPct != null && w.avgPct === Math.max(...selectedStats.weekdayStats.map(x => x.avgPct ?? 0)) && w.avgPct > 0 ? ' best' : ''}`}
                                style={{ height: `${Math.max(4, w.avgPct ?? 0)}%`, '--i': i }}
                              />
                              <span className="mile-bar-label">{w.day}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </ThemeProvider>
                )}
              </div>
            )}

            {selectedDay && (
              <div className="mile-list-card mile-focus-card">
                <h3 className="mile-section-title">
                  {selectedDay.isToday ? "Today's Focus" : `${formatDate(selectedDay.date)}'s Focus`}
                </h3>

                {selectedDay.frozen && (
                  <div className="mile-freeze-banner"><span className="material-symbols-outlined mile-inline-icon">ac_unit</span> Streak freeze used — this day still counts toward your streak.</div>
                )}
                {!selectedDay.isFuture && !selectedDay.isToday && !selectedDay.frozen && !selectedDay.allDone
                  && selectedDay.tasks.length > 0 && selectedStats.freezesRemaining > 0 && (
                  <button type="button" className="mile-freeze-btn" onClick={() => useFreeze(selectedGoal, selectedDay.key)}>
                    <span className="material-symbols-outlined mile-inline-icon">ac_unit</span> Use a Streak Freeze for this day
                  </button>
                )}

                {selectedDay.tasks.length === 0 ? (
                  <p className="mile-empty-sub mile-focus-empty">No tasks planned for this day yet.</p>
                ) : selectedDay.tasks.map(t => (
                  <div key={t.id} className={`mile-task-card${t.done ? ' done' : ''}`}>
                    {burstTaskId === t.id && (
                      <span className="mile-burst" aria-hidden="true">
                        {Array.from({ length: 8 }).map((_, i) => (
                          <i key={i} className="mile-burst-particle" style={{ '--i': i }} />
                        ))}
                      </span>
                    )}
                    {editingTaskId === t.id ? (
                      <div className="mile-task-edit-body">
                        <input
                          className="add-input" type="text" placeholder="Task title" autoFocus
                          value={editTaskForm.title}
                          onChange={e => setEditTaskForm(f => ({ ...f, title: e.target.value }))}
                        />
                        <input
                          className="add-input" type="text" placeholder="Description (optional)"
                          value={editTaskForm.description}
                          onChange={e => setEditTaskForm(f => ({ ...f, description: e.target.value }))}
                        />
                        <div className="mile-task-edit-actions">
                          <button type="button" className="mile-task-btn" onClick={() => saveEditTask(t)} disabled={!editTaskForm.title.trim()}>Save</button>
                          <button type="button" className="mile-template-remove" onClick={() => setEditingTaskId(null)} aria-label="Cancel">
                            <span className="material-symbols-outlined">close</span>
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className={`mile-task-icon${t.done ? ' done' : ''}`}>
                          <span className="material-symbols-outlined">{t.done ? 'task_alt' : 'radio_button_unchecked'}</span>
                        </div>
                        <div className="mile-task-body" onClick={() => !t.done && startEditTask(t)}>
                          <span className={`mile-task-title${t.done ? ' done' : ''}`}>{t.title}</span>
                          {t.description && <span className="mile-task-desc">{t.description}</span>}
                        </div>
                        <button
                          type="button"
                          className={`mile-task-btn${t.done ? ' done' : ''}`}
                          onClick={() => toggleTask(t)}
                        >
                          <span className="material-symbols-outlined">{t.done ? 'check_circle' : 'radio_button_unchecked'}</span>
                          {t.done ? 'Completed' : 'Mark as Done'}
                        </button>
                        <button className="mile-row-delete" onClick={() => deleteTask(t.id)} aria-label="Remove task">
                          <span className="material-symbols-outlined">close</span>
                        </button>
                      </>
                    )}
                  </div>
                ))}

                <div className="mile-add-task-row">
                  <input
                    className="add-input"
                    type="text"
                    placeholder="Add a task for this day…"
                    value={newTaskTitle}
                    onChange={e => setNewTaskTitle(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addDayTask()}
                  />
                  <button className="mile-add-task-btn" onClick={addDayTask} disabled={!newTaskTitle.trim()} aria-label="Add task">
                    <span className="material-symbols-outlined">add</span>
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {!selectedGoal && (
        <button className="mile-fab" onClick={openAddGoal} aria-label="Add goal">
          <span className="material-symbols-outlined">add</span>
        </button>
      )}

      {goalSheetOpen && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setGoalSheetOpen(false)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>New Milestone</span>
              <button className="add-txn-close" onClick={() => setGoalSheetOpen(false)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Quick Start (optional)</label>
              <div className="mile-template-picker">
                {GOAL_TEMPLATES.map(t => (
                  <button key={t.title} type="button" className="mile-template-card" onClick={() => applyTemplate(t)}>
                    <span className="mile-template-icon">{t.icon}</span>
                    <span className="mile-template-title">{t.title}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="add-field">
              <label className="add-label">Goal Title</label>
              <input className="add-input" type="text" placeholder="e.g. Complete study plan"
                value={goalForm.title} onChange={e => setGoalForm(f => ({ ...f, title: e.target.value }))} autoFocus />
            </div>

            <div className="add-field">
              <label className="add-label">Description (optional)</label>
              <input className="add-input" type="text" placeholder="e.g. Finish all chapters before the exam"
                value={goalForm.description} onChange={e => setGoalForm(f => ({ ...f, description: e.target.value }))} />
            </div>

            <div className="add-field">
              <label className="add-label">Time Frame</label>
              <div className="type-toggle">
                {PERIOD_OPTIONS.map(o => (
                  <button key={o.key} className={`type-btn${goalForm.periodKey === o.key ? ' active credit' : ''}`}
                    onClick={() => setGoalForm(f => ({ ...f, periodKey: o.key }))}>{o.label}</button>
                ))}
              </div>
            </div>

            {goalForm.periodKey === 'custom' && (
              <div className="add-field">
                <label className="add-label">Number of Days</label>
                <input className="add-input" type="number" inputMode="numeric" placeholder="e.g. 15"
                  value={goalForm.customDays} onChange={e => setGoalForm(f => ({ ...f, customDays: e.target.value }))} />
              </div>
            )}

            <div className="add-field">
              <label className="add-label">Daily Tasks (applied to every day)</label>
              {goalForm.templates.map((t, i) => (
                <div key={i} className="mile-template-row">
                  <div className="mile-template-inputs">
                    <input className="add-input" type="text" placeholder={`e.g. ${i === 0 ? 'Study 1 hour' : 'Practice exercises'}`}
                      value={t.title} onChange={e => updateTemplate(i, 'title', e.target.value)} />
                    <input className="add-input" type="text" placeholder="Description (optional)"
                      value={t.description} onChange={e => updateTemplate(i, 'description', e.target.value)} />
                  </div>
                  {goalForm.templates.length > 1 && (
                    <button type="button" className="mile-template-remove" onClick={() => removeTemplateRow(i)} aria-label="Remove">
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  )}
                </div>
              ))}
              <button type="button" className="mile-template-add" onClick={addTemplateRow}>
                <span className="material-symbols-outlined">add</span> Add another daily task
              </button>
            </div>

            <button className="add-txn-submit" onClick={submitGoal}
              disabled={!goalForm.title.trim() || (goalForm.periodKey === 'custom' && !(parseInt(goalForm.customDays, 10) > 0))}>
              Start Milestone
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
