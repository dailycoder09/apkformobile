import { useState, useEffect, useMemo, useRef } from 'react'
import confetti from 'canvas-confetti'
import { computeGoalStats, computeMilestoneStats, computeGlobalBadges } from '../utils/milestoneStats'
import { PageShell } from './PageShell'
import { Celebrate } from './Celebrate'
import SwipeCarousel from './SwipeCarousel'
import MilestoneAgendaSection from './MilestoneAgendaSection'
import MilestoneAnalyticsSection from './MilestoneAnalyticsSection'
import { getCache, setCache } from '../lib/offlineCache'

const prefersReducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

function vibrate(pattern) {
  navigator.vibrate?.(pattern)
}

// Animates a number from 0 to `target` on mount/change — used for the hero ring so the
// headline number "counts up" rather than snapping in. Skips straight to the target when
// the user has requested reduced motion (feedback stays, motion doesn't).
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
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}

const PERIOD_OPTIONS = [
  { key: 'week', label: '1 Week', days: 7 },
  { key: 'month', label: '1 Month', days: 30 },
  { key: 'year', label: '1 Year', days: 365 },
  { key: 'custom', label: 'Custom', days: null },
]

// Pre-built goal presets so a new goal doesn't have to start from a blank form —
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

const EMPTY_GOAL_FORM = { title: '', description: '', periodKey: 'week', customDays: '', templates: [{ title: '', description: '' }] }
const EMPTY_MILESTONE_FORM = { id: null, title: '', description: '', day: '1', total: '30' }
const EMPTY_TASK_FORM = { id: null, goalId: '', title: '', description: '', date: '' }

const UNCATEGORIZED_ID = '__uncategorized__'

export default function MilestonePanel({ session, sendMsg, addListener, onHome, onProfileOpen }) {
  // Seeded from cache so something real renders even offline, before milestone_data_get's
  // reply (or lack thereof) arrives.
  const cachedMilestoneData = getCache('milestone_data', session.userId)
  const [milestones, setMilestones] = useState(() => cachedMilestoneData?.milestones || [])
  const [goals, setGoals] = useState(() => cachedMilestoneData?.goals || [])
  const [tasks, setTasks] = useState(() => cachedMilestoneData?.tasks || [])
  const [activeMilestoneId, setActiveMilestoneId] = useState(null)
  const [openGoals, setOpenGoals] = useState({})
  const [showArchived, setShowArchived] = useState(false)

  const [goalSheetOpen, setGoalSheetOpen] = useState(false)
  const [goalForm, setGoalForm] = useState(EMPTY_GOAL_FORM)

  const [milestoneSheetOpen, setMilestoneSheetOpen] = useState(false)
  const [milestoneForm, setMilestoneForm] = useState(EMPTY_MILESTONE_FORM)

  const [taskSheetOpen, setTaskSheetOpen] = useState(null) // null | 'add' | 'edit'
  const [taskForm, setTaskForm] = useState(EMPTY_TASK_FORM)

  // Celebration state — a task id currently mid-micro-burst, and a "just unlocked" badge
  // toast. Both are ephemeral UI-only state, cleared on their own timers.
  const [burstTaskId, setBurstTaskId] = useState(null)
  const [badgeToast, setBadgeToast] = useState(null)
  const [cheer, setCheer] = useState({ n: 0, msg: '' })
  const seenGlobalBadgesRef = useRef(null)
  const seenCompletedGoalsRef = useRef(null)
  const seenCompletedMilestonesRef = useRef(null)

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'milestone_data') {
        setMilestones(msg.milestones || [])
        setGoals(msg.goals || [])
        setTasks(msg.tasks || [])
        setCache('milestone_data', session.userId, {
          milestones: msg.milestones || [], goals: msg.goals || [], tasks: msg.tasks || [],
        })
      }
    })
  }, [addListener])

  useEffect(() => {
    sendMsg({ type: 'milestone_data_get' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Goals created before Milestones existed have no milestoneId — grouped into a
  // client-only fallback "My Goals" bucket (never sent to the server) so old data stays
  // visible instead of silently disappearing.
  const orphanGoals = useMemo(() => goals.filter(g => !g.milestoneId), [goals])
  const syntheticMilestone = useMemo(() => {
    if (!orphanGoals.length) return null
    return {
      id: UNCATEGORIZED_ID, title: 'My Goals', description: 'Goals from before milestones existed.',
      startDate: Math.min(...orphanGoals.map(g => g.startDate || Date.now())), durationDays: 365,
      archived: false, synthetic: true,
    }
  }, [orphanGoals])
  const combinedMilestones = useMemo(
    () => [...milestones, ...(syntheticMilestone ? [syntheticMilestone] : [])],
    [milestones, syntheticMilestone]
  )

  useEffect(() => {
    if (activeMilestoneId == null && combinedMilestones.length) setActiveMilestoneId(combinedMilestones[0].id)
  }, [combinedMilestones, activeMilestoneId])

  const activeMilestone = combinedMilestones.find(m => m.id === activeMilestoneId) || combinedMilestones[0] || null

  // For the synthetic bucket, `goals` itself has no matching milestoneId — remap a copy
  // just for stats purposes so computeMilestoneStats' internal filter still finds them.
  const goalsForActiveStats = activeMilestone?.synthetic
    ? orphanGoals.map(g => ({ ...g, milestoneId: activeMilestone.id }))
    : goals

  const activeMilestoneStats = useMemo(
    () => activeMilestone ? computeMilestoneStats(activeMilestone, goalsForActiveStats, tasks) : null,
    [activeMilestone, goalsForActiveStats, tasks]
  )

  const activeGoals = useMemo(() => {
    const list = activeMilestone?.synthetic
      ? orphanGoals.filter(g => g.status !== 'archived')
      : goals.filter(g => g.milestoneId === activeMilestone?.id && g.status !== 'archived')
    return [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }, [goals, orphanGoals, activeMilestone])

  const activeArchivedGoals = useMemo(() => {
    const list = activeMilestone?.synthetic
      ? orphanGoals.filter(g => g.status === 'archived')
      : goals.filter(g => g.milestoneId === activeMilestone?.id && g.status === 'archived')
    return [...list].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  }, [goals, orphanGoals, activeMilestone])

  const animatedRingPct = useCountUp(activeMilestoneStats?.completionPct ?? 0)

  const globalBadges = useMemo(() => computeGlobalBadges(combinedMilestones, goals, tasks), [combinedMilestones, goals, tasks])

  // Overall numbers across every real goal (not just the active milestone's).
  const overall = useMemo(() => {
    let bestStreak = 0, totalTasksAll = 0, totalDoneAll = 0, totalGoalsAchieved = 0
    goals.forEach(g => {
      const s = computeGoalStats(g, tasks)
      bestStreak = Math.max(bestStreak, s.longestStreak)
      totalTasksAll += s.totalTasks
      totalDoneAll += s.completedTasks
      if (s.isComplete) totalGoalsAchieved++
    })
    const completionRate = totalTasksAll ? Math.round((totalDoneAll / totalTasksAll) * 100) : 0
    return { bestStreak, totalTasksAll, totalDoneAll, totalGoalsAchieved, completionRate }
  }, [goals, tasks])

  // Real daily-completion trend for the active milestone — merges every child goal's own
  // dailyCompletion series (from computeGoalStats) by date, averaging same-day points
  // across goals rather than the reference's static demo series.
  const trendData = useMemo(() => {
    if (!activeGoals.length) return null
    const byDate = {}
    activeGoals.forEach(g => {
      computeGoalStats(g, tasks).dailyCompletion.forEach(d => {
        if (!byDate[d.key]) byDate[d.key] = { sum: 0, count: 0, date: d.date }
        byDate[d.key].sum += d.pct
        byDate[d.key].count += 1
      })
    })
    const points = Object.values(byDate).sort((a, b) => a.date - b.date).map(d => Math.round(d.sum / d.count))
    if (points.length < 2) return null
    return points.map((pct, i) => ({ d: `Day ${i + 1}`, pct }))
  }, [activeGoals, tasks])

  const breakdownData = useMemo(() => {
    if (!activeMilestoneStats) return null
    const done = activeMilestoneStats.todayDone
    const remaining = Math.max(0, activeMilestoneStats.todayTotal - done)
    return [
      { id: 0, label: 'Done', value: Math.max(done, 0.001), color: 'var(--color-gold)' },
      { id: 1, label: 'Remaining', value: Math.max(remaining, 0.001), color: 'var(--color-secondary)' },
    ]
  }, [activeMilestoneStats])

  const goalChartData = useMemo(() => activeGoals.map(g => {
    const s = computeGoalStats(g, tasks)
    const today = s.days.find(d => d.isToday)
    const todayPct = today && today.tasks.length ? Math.round((today.tasks.filter(t => t.done).length / today.tasks.length) * 100) : 0
    return { name: g.title.length > 12 ? `${g.title.slice(0, 12)}…` : g.title, goal: s.completionPct, tasks: todayPct }
  }), [activeGoals, tasks])

  const perMilestoneChartData = useMemo(() => combinedMilestones.map(m => {
    const gfs = m.synthetic ? orphanGoals.map(g => ({ ...g, milestoneId: m.id })) : goals
    const s = computeMilestoneStats(m, gfs, tasks)
    return { name: m.title.split(' ')[0], progress: s.completionPct, motivation: s.motivationScore }
  }), [combinedMilestones, goals, orphanGoals, tasks])

  // Auto-flip a goal to 'completed' + celebrate the moment every planned task is checked
  // off — diffs against a "seen complete" ref so it only fires once per fresh completion,
  // not on every unrelated re-render (same pattern as the badge-toast watcher below).
  useEffect(() => {
    const completedNow = new Set(goals.filter(g => computeGoalStats(g, tasks).isComplete).map(g => g.id))
    if (seenCompletedGoalsRef.current === null) { seenCompletedGoalsRef.current = completedNow; return }
    const seen = seenCompletedGoalsRef.current
    const freshId = [...completedNow].find(id => !seen.has(id))
    if (freshId) {
      const goal = goals.find(g => g.id === freshId)
      if (goal && goal.status !== 'completed') {
        const updated = { ...goal, status: 'completed' }
        setGoals(prev => prev.map(g => g.id === updated.id ? updated : g))
        sendMsg({ type: 'milestone_goal_update', goal: updated })
      }
      if (!prefersReducedMotion()) {
        confetti({ particleCount: 140, spread: 90, origin: { y: 0.6 }, colors: ['#c9a227', '#8a6d1f', '#16a34a'] })
      }
      vibrate([15, 40, 15, 40, 30])
      setCheer({ n: Date.now(), msg: `Goal achieved — ${goal?.title ?? ''}! 🎯` })
    }
    seenCompletedGoalsRef.current = completedNow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goals, tasks])

  useEffect(() => {
    const completedNow = new Set(combinedMilestones.filter(m => {
      const gfs = m.synthetic ? orphanGoals.map(g => ({ ...g, milestoneId: m.id })) : goals
      return computeMilestoneStats(m, gfs, tasks).isComplete
    }).map(m => m.id))
    if (seenCompletedMilestonesRef.current === null) { seenCompletedMilestonesRef.current = completedNow; return }
    const seen = seenCompletedMilestonesRef.current
    const freshId = [...completedNow].find(id => !seen.has(id))
    if (freshId) {
      const m = combinedMilestones.find(x => x.id === freshId)
      setCheer({ n: Date.now(), msg: `Milestone complete — ${m?.title ?? ''}! 🏆` })
    }
    seenCompletedMilestonesRef.current = completedNow
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [combinedMilestones, goals, tasks])

  // Watches the 6 global badges and announces any newly-earned one with a toast — badges
  // already earned before this session don't re-announce (seeded on first data load).
  useEffect(() => {
    const earnedIds = new Set(globalBadges.filter(b => b.earned).map(b => b.id))
    if (seenGlobalBadgesRef.current === null) { seenGlobalBadgesRef.current = earnedIds; return }
    const seen = seenGlobalBadgesRef.current
    const fresh = globalBadges.find(b => b.earned && !seen.has(b.id))
    if (fresh) {
      setBadgeToast(fresh)
      vibrate([10, 30, 10])
      setTimeout(() => setBadgeToast(null), 2600)
    }
    seenGlobalBadgesRef.current = earnedIds
  }, [globalBadges])

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
      milestoneId: activeMilestone?.synthetic ? null : (activeMilestone?.id ?? null),
      // One streak-freeze "grace" per goal — see computeGoalStats.
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
    setOpenGoals(o => ({ ...o, [goal.id]: true }))
    setGoalSheetOpen(false)
  }

  function deleteGoal(id) {
    setGoals(prev => prev.filter(g => g.id !== id))
    setTasks(prev => prev.filter(t => t.goalId !== id))
    sendMsg({ type: 'milestone_goal_delete', id })
  }

  // Archiving (vs. deleting) keeps the goal + its full history around for reference —
  // just tucked out of the active list, rather than gone for good.
  function archiveGoal(goal) {
    const updated = { ...goal, status: 'archived' }
    setGoals(prev => prev.map(g => g.id === goal.id ? updated : g))
    sendMsg({ type: 'milestone_goal_update', goal: updated })
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
      createdAt: Date.now(), status: 'active', milestoneId: goal.milestoneId ?? null,
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

  function openAddMilestone() {
    setMilestoneForm(EMPTY_MILESTONE_FORM)
    setMilestoneSheetOpen(true)
  }

  function openEditMilestone(m) {
    const stats = computeMilestoneStats(m, goals, tasks)
    setMilestoneForm({ id: m.id, title: m.title, description: m.description || '', day: String(Math.max(1, stats.daysElapsed)), total: String(m.durationDays) })
    setMilestoneSheetOpen(true)
  }

  function submitMilestone() {
    const title = milestoneForm.title.trim()
    if (!title) return
    const day = Math.max(1, parseInt(milestoneForm.day, 10) || 1)
    const total = Math.max(day, parseInt(milestoneForm.total, 10) || day)
    const startDate = istMidnight(Date.now()) - (day - 1) * 86400000
    if (milestoneForm.id) {
      const updated = { id: milestoneForm.id, title, description: milestoneForm.description.trim(), startDate, durationDays: total, archived: false }
      setMilestones(prev => prev.map(m => m.id === updated.id ? { ...m, ...updated } : m))
      sendMsg({ type: 'milestone_milestone_update', milestone: updated })
    } else {
      const milestone = { id: Math.random().toString(36).slice(2), title, description: milestoneForm.description.trim(), startDate, durationDays: total, createdAt: Date.now(), archived: false }
      setMilestones(prev => [milestone, ...prev])
      sendMsg({ type: 'milestone_milestone_add', milestone })
      setActiveMilestoneId(milestone.id)
      setCheer({ n: Date.now(), msg: `Milestone "${title}" started!` })
    }
    setMilestoneSheetOpen(false)
  }

  function deleteMilestone(id) {
    if (id === UNCATEGORIZED_ID) return
    setMilestones(prev => prev.filter(m => m.id !== id))
    const childGoalIds = goals.filter(g => g.milestoneId === id).map(g => g.id)
    setGoals(prev => prev.filter(g => g.milestoneId !== id))
    setTasks(prev => prev.filter(t => !childGoalIds.includes(t.goalId)))
    sendMsg({ type: 'milestone_milestone_delete', id })
    if (activeMilestoneId === id) setActiveMilestoneId(null)
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
    setTaskSheetOpen(null)
  }

  function useFreeze(goal, dayKey) {
    const updated = { ...goal, freezesUsed: [...(goal.freezesUsed || []), dayKey] }
    setGoals(prev => prev.map(g => g.id === goal.id ? updated : g))
    sendMsg({ type: 'milestone_goal_update', goal: updated })
  }

  function openAddTaskFor(dateMs, goalId) {
    setTaskForm({ ...EMPTY_TASK_FORM, date: istDateKey(dateMs), goalId: goalId || activeGoals[0]?.id || '' })
    setTaskSheetOpen('add')
  }

  function openEditTaskSheet(task) {
    setTaskForm({ id: task.id, goalId: task.goalId, title: task.title, description: task.description || '', date: istDateKey(task.date) })
    setTaskSheetOpen('edit')
  }

  function submitTaskSheet() {
    const title = taskForm.title.trim()
    if (!title || !taskForm.goalId) return
    const dateMs = taskForm.date ? istMidnight(istDateInputToMs(taskForm.date)) : istMidnight(Date.now())
    if (taskForm.id) {
      const updated = { id: taskForm.id, goalId: taskForm.goalId, title, description: taskForm.description.trim(), date: dateMs, done: false }
      setTasks(prev => prev.map(t => t.id === updated.id ? { ...t, ...updated, done: t.done } : t))
      sendMsg({ type: 'milestone_task_update', task: { ...updated, done: tasks.find(t => t.id === updated.id)?.done ?? false } })
    } else {
      const task = { id: Math.random().toString(36).slice(2), goalId: taskForm.goalId, title, description: taskForm.description.trim(), date: dateMs, done: false, createdAt: Date.now() }
      setTasks(prev => [task, ...prev])
      sendMsg({ type: 'milestone_task_add', task })
    }
    setTaskSheetOpen(null)
  }

  return (
    <div className="mile-screen surface-sand relative h-full font-sans">
      <PageShell
        eyebrow="Module 04"
        title="Milestones"
        lead="Every milestone breaks into goals, and every goal gets its own daily tasks. Tick them off and celebrate each win."
        onHome={onHome}
        session={session}
        sendMsg={sendMsg}
        addListener={addListener}
        showProfile
        onProfileOpen={onProfileOpen}
        action={
          // Hidden on mobile — the count is folded into the Milestones list header
          // (MilestoneAgendaSection.jsx) instead of floating as its own boxed card,
          // matching Khatabook's net-position pill treatment.
          <div className="tile-static hidden shrink-0 px-5 py-3 text-right md:block">
            <p className="num text-2xl font-extrabold">{combinedMilestones.length}</p>
            <p className="text-[11px] text-muted-foreground">active milestones</p>
          </div>
        }
      >
        <Celebrate show={cheer.n > 0} message={cheer.msg} key={cheer.n} />

        {badgeToast && (
          // top-32 on mobile (not top-4/top-6, which the shared <Celebrate> banner above
          // already occupies) — a milestone/goal completion and a badge unlock often fire
          // in the same instant, and both toasts sharing one row rendered as illegible
          // overlapping text. Mobile-only bump from top-20: PageShell's mobile header still
          // starts lower than its desktop sm:pt-10 (pt-16, to clear the single fixed
          // CornerMenu trigger), so the "Milestones" <h1> occupies roughly the old top-20
          // band - top-20 would put this toast right on top of that title instead of below
          // it (re-verified with Playwright: title spans y 68-100px at 390px wide, top-32's
          // 128px clears it with margin). Desktop keeps the original sm:top-20 - its header
          // sits higher (sm:pt-10) and never moved, so it's unaffected.
          <div role="status" className="animate-fade-in fixed left-1/2 top-32 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-[image:var(--gradient-gold)] px-5 py-2.5 text-sm font-semibold text-white shadow-[var(--shadow-glow)] sm:top-20">
            <span className="material-symbols-outlined text-lg">{badgeToast.icon}</span>
            <span>{badgeToast.label} unlocked!</span>
          </div>
        )}

        {/* Mobile: two swipeable pages (agenda, then analytics) so the screen isn't one
            long scroll. Desktop: both sections stacked, unchanged from before the split —
            same two components either way, so there's nothing to fall out of sync. */}
        {/* 140px = PageShell's mobile header height through BottomNav. This is a real magic
            number tied to PageShell's current mobile header height — if that header's height
            changes again, re-measure with Playwright (carouselTop/navTop getBoundingClientRect)
            rather than guessing, both directions of this number being wrong are visible bugs
            (dead gap above the nav, or the carousel overlapping/hiding behind it). Re-measured
            after CornerMenu moved from a floating fixed trigger (pt-16 header, 184px) to
            mounting inline in PageShell's header row (pt-6 header) — that migration shrank the
            header by 44px but this value was missed at the time, leaving a 44px dead gap above
            BottomNav on this page until caught during the Journal module build. */}
        <div className="md:hidden" style={{ height: 'calc(100dvh - 120px)' }}>
          <SwipeCarousel hintNext="Swipe left for analytics →" hintPrev="Swipe right for agenda →">
            <MilestoneAgendaSection
              overall={overall}
              combinedMilestones={combinedMilestones}
              activeMilestone={activeMilestone}
              activeMilestoneStats={activeMilestoneStats}
              animatedRingPct={animatedRingPct}
              goals={goals}
              orphanGoals={orphanGoals}
              tasks={tasks}
              activeGoals={activeGoals}
              activeArchivedGoals={activeArchivedGoals}
              openGoals={openGoals}
              setOpenGoals={setOpenGoals}
              showArchived={showArchived}
              setShowArchived={setShowArchived}
              setActiveMilestoneId={setActiveMilestoneId}
              openAddMilestone={openAddMilestone}
              openEditMilestone={openEditMilestone}
              deleteMilestone={deleteMilestone}
              openAddGoal={openAddGoal}
              duplicateGoal={duplicateGoal}
              archiveGoal={archiveGoal}
              unarchiveGoal={unarchiveGoal}
              deleteGoal={deleteGoal}
              toggleTask={toggleTask}
              openEditTaskSheet={openEditTaskSheet}
              deleteTask={deleteTask}
              openAddTaskFor={openAddTaskFor}
            />
            <MilestoneAnalyticsSection
              activeMilestoneStats={activeMilestoneStats}
              trendData={trendData}
              breakdownData={breakdownData}
              goalChartData={goalChartData}
              perMilestoneChartData={perMilestoneChartData}
              globalBadges={globalBadges}
            />
          </SwipeCarousel>
        </div>

        {/* Floating "Add milestone" — mobile only, matching Khatabook/Finance's FAB
            geometry. Placed as a sibling of the carousel rather than inside it: a
            fixed-position element inside SwipeCarousel's translateX(...) container would
            anchor to that transformed ancestor instead of the viewport, per CSS's
            containing-block rules for transformed ancestors.
            Deliberately "Add milestone", not "Add task": the inline "New milestone"
            button (and milestone-count badge) was removed from the mobile Milestones list
            on the reasoning that this FAB already covers it. Adding a daily task stays
            reachable from the goal rows / calendar quick-add (openAddTaskFor), unchanged. */}
        <button
          type="button"
          aria-label="Add milestone"
          onClick={openAddMilestone}
          className="fixed right-5 bottom-[90px] z-40 grid size-14 place-items-center rounded-full bg-[image:var(--gradient-gold)] text-white shadow-[var(--shadow-glow)] transition-transform active:scale-95 md:hidden"
        >
          <span className="material-symbols-outlined text-2xl">add</span>
        </button>

        <div className="hidden md:flex md:flex-col md:gap-4">
          <MilestoneAgendaSection
            overall={overall}
            combinedMilestones={combinedMilestones}
            activeMilestone={activeMilestone}
            activeMilestoneStats={activeMilestoneStats}
            animatedRingPct={animatedRingPct}
            goals={goals}
            orphanGoals={orphanGoals}
            tasks={tasks}
            activeGoals={activeGoals}
            activeArchivedGoals={activeArchivedGoals}
            openGoals={openGoals}
            setOpenGoals={setOpenGoals}
            showArchived={showArchived}
            setShowArchived={setShowArchived}
            setActiveMilestoneId={setActiveMilestoneId}
            openAddMilestone={openAddMilestone}
            openEditMilestone={openEditMilestone}
            deleteMilestone={deleteMilestone}
            openAddGoal={openAddGoal}
            duplicateGoal={duplicateGoal}
            archiveGoal={archiveGoal}
            unarchiveGoal={unarchiveGoal}
            deleteGoal={deleteGoal}
            toggleTask={toggleTask}
            openEditTaskSheet={openEditTaskSheet}
            deleteTask={deleteTask}
            openAddTaskFor={openAddTaskFor}
          />
          <MilestoneAnalyticsSection
            activeMilestoneStats={activeMilestoneStats}
            trendData={trendData}
            breakdownData={breakdownData}
            goalChartData={goalChartData}
            perMilestoneChartData={perMilestoneChartData}
            globalBadges={globalBadges}
          />
        </div>
      </PageShell>

      {goalSheetOpen && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setGoalSheetOpen(false)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>Add Goal</span>
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
              Add Goal
            </button>
          </div>
        </div>
      )}

      {milestoneSheetOpen && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setMilestoneSheetOpen(false)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{milestoneForm.id ? 'Edit Milestone' : 'New Milestone'}</span>
              <button className="add-txn-close" onClick={() => setMilestoneSheetOpen(false)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Title</label>
              <input className="add-input" type="text" placeholder="e.g. Quran — One Page Daily"
                value={milestoneForm.title} onChange={e => setMilestoneForm(f => ({ ...f, title: e.target.value }))} autoFocus />
            </div>
            <div className="add-field">
              <label className="add-label">Description (optional)</label>
              <input className="add-input" type="text" placeholder="Why this matters"
                value={milestoneForm.description} onChange={e => setMilestoneForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="add-field">
              <label className="add-label">Current Day</label>
              <input className="add-input" type="number" inputMode="numeric"
                value={milestoneForm.day} onChange={e => setMilestoneForm(f => ({ ...f, day: e.target.value }))} />
            </div>
            <div className="add-field">
              <label className="add-label">Total Days</label>
              <input className="add-input" type="number" inputMode="numeric"
                value={milestoneForm.total} onChange={e => setMilestoneForm(f => ({ ...f, total: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitMilestone} disabled={!milestoneForm.title.trim()}>
              {milestoneForm.id ? 'Save Changes' : 'Start Milestone'}
            </button>
            {milestoneForm.id && (
              <button className="add-txn-delete" onClick={() => { deleteMilestone(milestoneForm.id); setMilestoneSheetOpen(false) }}>
                Delete Milestone
              </button>
            )}
          </div>
        </div>
      )}

      {taskSheetOpen && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setTaskSheetOpen(null)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{taskSheetOpen === 'edit' ? 'Edit Daily Task' : 'Add Daily Task'}</span>
              <button className="add-txn-close" onClick={() => setTaskSheetOpen(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Task</label>
              <input className="add-input" type="text" placeholder="e.g. Read one page" autoFocus
                value={taskForm.title} onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))} />
            </div>
            <div className="add-field">
              <label className="add-label">Description (optional)</label>
              <input className="add-input" type="text" placeholder="A short reminder"
                value={taskForm.description} onChange={e => setTaskForm(f => ({ ...f, description: e.target.value }))} />
            </div>
            <div className="add-field">
              <label className="add-label">Goal</label>
              <select className="add-input" value={taskForm.goalId} onChange={e => setTaskForm(f => ({ ...f, goalId: e.target.value }))}>
                <option value="">Select a goal…</option>
                {goals.map(g => <option key={g.id} value={g.id}>{g.title}</option>)}
              </select>
            </div>
            <div className="add-field">
              <label className="add-label">Date</label>
              <input className="add-input" type="date" value={taskForm.date} onChange={e => setTaskForm(f => ({ ...f, date: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitTaskSheet} disabled={!taskForm.title.trim() || !taskForm.goalId}>
              {taskSheetOpen === 'edit' ? 'Save Changes' : 'Add Task'}
            </button>
            {taskSheetOpen === 'edit' && (
              <button className="add-txn-delete" onClick={() => deleteTask(taskForm.id)}>
                Delete Task
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
