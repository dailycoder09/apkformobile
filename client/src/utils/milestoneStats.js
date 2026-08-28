// Shared with Dashboard.jsx's home-hub Milestones tile, so the same streak/completion
// math backs both the full Milestones screen and the quick summary shown on the landing
// page — one computation, not two copies that could quietly drift apart.

const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istMidnight(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS
}

// Icons are real Material Symbols names (same free icon font used everywhere else in
// this app), not emoji — one consistent icon language across the whole app rather than a
// second visual dialect for badges.
const BADGE_DEFS = [
  { id: 'first_step',   label: 'First Step',      icon: 'celebration',      check: s => s.completedTasks >= 1 },
  { id: 'streak_3',     label: '3-Day Streak',    icon: 'local_fire_department', check: s => s.longestStreak >= 3 },
  { id: 'streak_7',     label: '7-Day Streak',    icon: 'local_fire_department', check: s => s.longestStreak >= 7 },
  { id: 'halfway',      label: 'Halfway There',   icon: 'military_tech',    check: s => s.completionPct >= 50 },
  { id: 'goal_crusher', label: 'Goal Crusher',    icon: 'emoji_events',     check: s => s.completionPct >= 100 },
]

// Derives progress/streaks/badges from the raw goal + its tasks — nothing here is
// persisted (same philosophy as TransactionPanel.jsx's recurring-payment detection).
// A day only counts as "done" once every task planned for that day is checked off; a day
// with no tasks planned at all doesn't count toward or against the streak.
export function computeGoalStats(goal, allTasks) {
  const tasks = allTasks.filter(t => t.goalId === goal.id)
  const byDay = {}
  tasks.forEach(t => {
    const key = istDateKey(t.date)
    if (!byDay[key]) byDay[key] = []
    byDay[key].push(t)
  })

  const totalDays = goal.durationDays
  const startMid = istMidnight(goal.startDate)
  const todayMid = istMidnight(Date.now())
  const daysElapsed = Math.max(0, Math.min(totalDays, Math.floor((todayMid - startMid) / 86400000) + 1))

  // Streak freeze — a small forgiveness mechanic (the single most-cited retention lever
  // in habit-tracker research: a hard reset on one bad day is what makes people abandon
  // a streak entirely, whereas a limited "grace" preserves motivation). A frozen day
  // counts toward the streak even though its tasks weren't actually completed — it does
  // NOT count toward completionPct, which still reflects real task completion.
  const frozenDays = new Set(goal.freezesUsed || [])
  const freezesRemaining = Math.max(0, (goal.freezesTotal ?? 0) - frozenDays.size)

  const days = []
  for (let i = 0; i < totalDays; i++) {
    const dayMs = startMid + i * 86400000
    const key = istDateKey(dayMs)
    const dayTasks = byDay[key] || []
    const allDone = dayTasks.length > 0 && dayTasks.every(t => t.done)
    days.push({ key, date: dayMs, tasks: dayTasks, allDone, frozen: frozenDays.has(key), isFuture: dayMs > todayMid, isToday: dayMs === todayMid })
  }

  const totalTasks = tasks.length
  const completedTasks = tasks.filter(t => t.done).length
  const completionPct = totalTasks ? Math.min(100, Math.round((completedTasks / totalTasks) * 100)) : 0

  // Walk back from today, skipping days with nothing planned (they neither break nor
  // extend a streak) — stop at the first planned, non-frozen day that wasn't completed.
  let currentStreak = 0
  for (let i = Math.min(daysElapsed, totalDays) - 1; i >= 0; i--) {
    const d = days[i]
    if (d.isToday && d.tasks.length === 0) continue // today not planned/started yet
    if (d.tasks.length === 0) continue
    if (d.allDone || frozenDays.has(d.key)) currentStreak++
    else break
  }

  let longestStreak = 0, run = 0
  for (let i = 0; i < daysElapsed; i++) {
    const d = days[i]
    if (d.tasks.length === 0) continue
    if (d.allDone || frozenDays.has(d.key)) { run++; longestStreak = Math.max(longestStreak, run) } else run = 0
  }

  // Per-day completion % for the trend chart — only elapsed, planned days (future days
  // have nothing to show yet, unplanned days would just be a flat 0 that isn't
  // meaningful).
  const dailyCompletion = days
    .filter(d => !d.isFuture && d.tasks.length > 0)
    .map(d => ({ key: d.key, date: d.date, pct: Math.round((d.tasks.filter(t => t.done).length / d.tasks.length) * 100) }))

  // Day-of-week performance — averages completion % across every elapsed, planned day
  // that fell on each weekday, surfacing which days of the week tend to go best/worst.
  const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, count: 0 }))
  dailyCompletion.forEach(d => {
    const wd = new Date(`${d.key}T00:00:00Z`).getUTCDay()
    buckets[wd].sum += d.pct
    buckets[wd].count++
  })
  const weekdayStats = buckets.map((b, i) => ({ day: WEEKDAY_NAMES[i], avgPct: b.count ? Math.round(b.sum / b.count) : null }))

  const stats = { days, totalDays, daysElapsed, totalTasks, completedTasks, completionPct, currentStreak, longestStreak, dailyCompletion, weekdayStats, freezesRemaining }
  stats.badges = BADGE_DEFS.filter(b => b.check(stats))
  stats.isComplete = totalTasks > 0 && completionPct >= 100
  // Illustrative, not scientific — blends overall completion with current momentum so a
  // hot streak visibly nudges the number even before the whole goal is done.
  stats.motivationScore = Math.min(100, Math.round(stats.completionPct * 0.7 + stats.currentStreak * 5))
  return stats
}

// Thin stat strip shared by the Milestones screen's own header and the home-hub tile:
// longest active streak across all goals + how many are "on track" today (today's tasks
// are either not due yet or already all done, i.e. the goal isn't currently behind).
export function computeHomeStats(visibleGoals, tasks) {
  if (visibleGoals.length === 0) return null
  let longestActiveStreak = 0, onTrack = 0
  visibleGoals.forEach(g => {
    const s = computeGoalStats(g, tasks)
    longestActiveStreak = Math.max(longestActiveStreak, s.currentStreak)
    const today = s.days.find(d => d.isToday)
    if (!today || today.tasks.length === 0 || today.allDone) onTrack++
  })
  return { longestActiveStreak, onTrack, total: visibleGoals.length }
}

// Four top-of-page stat tiles (Best streak / Tasks done / Goals achieved / Today's
// tasks) — a superset of computeHomeStats aimed at the redesigned dashboard-style
// header rather than the one-line strip. "Best streak" is the longest streak ever
// reached by any goal (not the current one), matching how a habit app usually brags
// about its record rather than today's live count.
export function computeOverallStats(visibleGoals, tasks) {
  let bestStreak = 0, tasksDone = 0, goalsAchieved = 0, todayDone = 0, todayTotal = 0
  visibleGoals.forEach(g => {
    const s = computeGoalStats(g, tasks)
    bestStreak = Math.max(bestStreak, s.longestStreak)
    tasksDone += s.completedTasks
    if (s.isComplete) goalsAchieved++
    const today = s.days.find(d => d.isToday)
    if (today) { todayTotal += today.tasks.length; todayDone += today.tasks.filter(t => t.done).length }
  })
  return { bestStreak, tasksDone, goalsAchieved, todayDone, todayTotal }
}

// A Milestone has its own independent start/duration ring, sitting above its child
// Goals — same day-counting approach as computeGoalStats, applied to the milestone's own
// range, with completion/streak numbers rolled up from whichever goals belong to it.
export function computeMilestoneStats(milestone, goals, tasks) {
  const childGoals = goals.filter(g => g.milestoneId === milestone.id)

  const totalDays = milestone.durationDays
  const startMid = istMidnight(milestone.startDate)
  const todayMid = istMidnight(Date.now())
  const daysElapsed = Math.max(0, Math.min(totalDays, Math.floor((todayMid - startMid) / 86400000) + 1))

  let tasksTotal = 0, tasksCompleted = 0, goalsCompleted = 0, bestStreak = 0, todayDone = 0, todayTotal = 0
  childGoals.forEach(g => {
    const s = computeGoalStats(g, tasks)
    tasksTotal += s.totalTasks
    tasksCompleted += s.completedTasks
    if (s.isComplete) goalsCompleted++
    bestStreak = Math.max(bestStreak, s.longestStreak)
    const today = s.days.find(d => d.isToday)
    if (today) { todayTotal += today.tasks.length; todayDone += today.tasks.filter(t => t.done).length }
  })

  const completionPct = tasksTotal ? Math.round((tasksCompleted / tasksTotal) * 100) : 0

  return {
    childGoals,
    goalsCount: childGoals.length,
    goalsCompleted,
    tasksTotal,
    tasksCompleted,
    completionPct,
    daysElapsed,
    totalDays,
    bestStreak,
    motivationScore: Math.min(100, Math.round(completionPct * 0.7 + bestStreak * 5)),
    todayDone,
    todayTotal,
    isComplete: tasksTotal > 0 && completionPct >= 100,
  }
}

// App-wide achievement badges — unlike BADGE_DEFS above (per-goal), these are evaluated
// across every milestone/goal/task in the app at once, so `check` takes the full three
// collections rather than one goal's stats object.
export const GLOBAL_BADGE_DEFS = [
  { id: 'starter', label: 'Starter', icon: 'flag', hint: 'Create your first milestone', check: (milestones) => milestones.length >= 1 },
  { id: 'task_slayer', label: 'Task slayer', icon: 'check_circle', hint: 'Tick 5 daily tasks', check: (milestones, goals, tasks) => tasks.filter(t => t.done).length >= 5 },
  { id: 'goal_getter', label: 'Goal getter', icon: 'flag_circle', hint: 'Complete a full goal', check: (milestones, goals, tasks) => goals.some(g => computeGoalStats(g, tasks).isComplete) },
  {
    id: 'perfect_day',
    label: 'Perfect day',
    icon: 'celebration',
    hint: 'Finish every task in this milestone',
    check: (milestones, goals, tasks) => {
      const byDay = {}
      tasks.forEach(t => {
        const key = istDateKey(t.date)
        if (!byDay[key]) byDay[key] = []
        byDay[key].push(t)
      })
      return Object.values(byDay).some(dayTasks => dayTasks.length > 0 && dayTasks.every(t => t.done))
    },
  },
  { id: 'milestone_master', label: 'Milestone master', icon: 'military_tech', hint: 'Complete an entire milestone', check: (milestones, goals, tasks) => milestones.some(m => computeMilestoneStats(m, goals, tasks).isComplete) },
  { id: 'consistency_king', label: 'Consistency king', icon: 'emoji_events', hint: '80%+ overall task completion', check: (milestones, goals, tasks) => tasks.length > 0 && tasks.filter(t => t.done).length / tasks.length >= 0.8 },
]

export function computeGlobalBadges(milestones, goals, tasks) {
  return GLOBAL_BADGE_DEFS.map(b => ({ ...b, earned: b.check(milestones, goals, tasks) }))
}
