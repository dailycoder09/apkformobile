import { useState, useEffect, useMemo } from 'react'
import { PageShell } from './PageShell'
import MilestoneAgendaSection from './MilestoneAgendaSection'
import MilestoneAnalyticsSection from './MilestoneAnalyticsSection'
import { computeGoalStats, computeMilestoneStats, computeGlobalBadges } from '../utils/milestoneStats'

const UNCATEGORIZED_ID = '__uncategorized__'

// Read-only parent view of a child's milestones — mirrors AdminHealthView.jsx's per-user
// fetch loop and user_joined/user_left handling, scoped to milestone_data_get/milestone_data.
// No add/edit/delete/toggle controls: a parent can see progress, not change it.
//
// Unlike the previous version of this file (bespoke .mile-*-styled JSX + @mui/x-charts, stuck
// on the old flat Goal>Task model), this reuses MilestoneAgendaSection.jsx and
// MilestoneAnalyticsSection.jsx exactly as the self-service MilestonePanel.jsx does — both
// already render read-only when their mutation-callback props are simply omitted (see the
// `onX &&` gating added throughout MilestoneAgendaSection.jsx/MilestoneCalendarAgenda.jsx),
// the same convention HealthEpisodesSection.jsx's EpisodeRow already used. That means Milestone
// tabs, per-Milestone progress ring, per-Goal progress, the calendar/daily-agenda, and all
// analytics charts stay automatically in sync with whatever the child sees — no bespoke JSX
// left here to drift out of date again.
export default function AdminMilestoneView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers] = useState(initialUsers || [])
  const [dataByUser, setDataByUser] = useState({}) // { [userId]: { milestones, goals, tasks } }
  const [activeUser, setActiveUser] = useState(initialUsers?.[0]?.id || null)
  const [activeMilestoneId, setActiveMilestoneId] = useState(null)
  const [openGoals, setOpenGoals] = useState({})
  const [showArchived, setShowArchived] = useState(false)

  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'milestone_data_get', userId: u.id }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'milestone_data') {
        setDataByUser(prev => ({ ...prev, [msg.userId]: { milestones: msg.milestones || [], goals: msg.goals || [], tasks: msg.tasks || [] } }))
      }
      if (msg.type === 'milestone_milestone_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          const exists = cur.milestones.find(m => m.id === msg.milestone.id)
          return { ...prev, [msg.fromUserId]: { ...cur, milestones: exists ? cur.milestones : [msg.milestone, ...cur.milestones] } }
        })
      }
      if (msg.type === 'milestone_milestone_updated') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, milestones: cur.milestones.map(m => m.id === msg.milestone.id ? msg.milestone : m) } }
        })
      }
      if (msg.type === 'milestone_milestone_deleted') {
        // Server only broadcasts the one milestone_milestone_deleted event for the whole
        // delete-a-milestone action — it doesn't also re-broadcast per-child goal_deleted/
        // task_deleted for the goals/tasks that cascaded (server/index.js's
        // milestone_milestone_delete handler deletes them directly via store.deleteItem
        // without a broadcast per row). Mirror that same cascade here, exactly like
        // MilestonePanel.jsx's own deleteMilestone does client-side for the acting user.
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          const childGoalIds = cur.goals.filter(g => g.milestoneId === msg.id).map(g => g.id)
          return {
            ...prev,
            [msg.fromUserId]: {
              milestones: cur.milestones.filter(m => m.id !== msg.id),
              goals: cur.goals.filter(g => g.milestoneId !== msg.id),
              tasks: cur.tasks.filter(t => !childGoalIds.includes(t.goalId)),
            },
          }
        })
      }
      if (msg.type === 'milestone_goal_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          const exists = cur.goals.find(g => g.id === msg.goal.id)
          return { ...prev, [msg.fromUserId]: { ...cur, goals: exists ? cur.goals : [msg.goal, ...cur.goals] } }
        })
      }
      if (msg.type === 'milestone_goal_updated') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, goals: cur.goals.map(g => g.id === msg.goal.id ? msg.goal : g) } }
        })
      }
      if (msg.type === 'milestone_goal_deleted') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, goals: cur.goals.filter(g => g.id !== msg.id), tasks: cur.tasks.filter(t => t.goalId !== msg.id) } }
        })
      }
      if (msg.type === 'milestone_task_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          const exists = cur.tasks.find(t => t.id === msg.task.id)
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: exists ? cur.tasks : [msg.task, ...cur.tasks] } }
        })
      }
      if (msg.type === 'milestone_tasks_bulk_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          const ids = new Set(cur.tasks.map(t => t.id))
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: [...cur.tasks, ...(msg.tasks || []).filter(t => !ids.has(t.id))] } }
        })
      }
      if (msg.type === 'milestone_task_updated') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: cur.tasks.map(t => t.id === msg.task.id ? msg.task : t) } }
        })
      }
      if (msg.type === 'milestone_task_deleted') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { milestones: [], goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: cur.tasks.filter(t => t.id !== msg.id) } }
        })
      }
      if (msg.type === 'user_joined') {
        setUsers(prev => prev.find(u => u.id === msg.user.id) ? prev : [...prev, msg.user])
        sendMsg({ type: 'milestone_data_get', userId: msg.user.id })
        setActiveUser(prev => prev || msg.user.id)
      }
      if (msg.type === 'user_left') {
        setUsers(prev => prev.filter(u => u.id !== msg.userId))
      }
    })
  }, [addListener, sendMsg])

  const activeData = dataByUser[activeUser] || { milestones: [], goals: [], tasks: [] }
  const { milestones, goals, tasks } = activeData

  // Same client-only fallback bucket for pre-Milestone goals as MilestonePanel.jsx's own
  // orphanGoals/syntheticMilestone/combinedMilestones — kept identical so a parent sees the
  // exact same "My Goals" grouping their child does, rather than those goals just vanishing.
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

  // Reset the selected milestone whenever the active family member changes, then default to
  // their first milestone — same effect MilestonePanel.jsx runs for the self-service screen.
  useEffect(() => {
    setActiveMilestoneId(null)
  }, [activeUser])
  useEffect(() => {
    if (activeMilestoneId == null && combinedMilestones.length) setActiveMilestoneId(combinedMilestones[0].id)
  }, [combinedMilestones, activeMilestoneId])

  const activeMilestone = combinedMilestones.find(m => m.id === activeMilestoneId) || combinedMilestones[0] || null

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

  const globalBadges = useMemo(() => computeGlobalBadges(combinedMilestones, goals, tasks), [combinedMilestones, goals, tasks])

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

  const sharedSectionProps = {
    overall,
    combinedMilestones,
    activeMilestone,
    activeMilestoneStats,
    animatedRingPct: activeMilestoneStats?.completionPct ?? 0, // read-only: no count-up animation, just the real number
    goals,
    orphanGoals,
    tasks,
    activeGoals,
    activeArchivedGoals,
    openGoals,
    setOpenGoals,
    showArchived,
    setShowArchived,
    setActiveMilestoneId,
    // Every mutation callback below is intentionally omitted (not passed as a no-op) —
    // MilestoneAgendaSection.jsx/MilestoneCalendarAgenda.jsx render each control read-only
    // when its handler prop is absent: openAddMilestone, openEditMilestone, deleteMilestone,
    // openAddGoal, duplicateGoal, archiveGoal, unarchiveGoal, deleteGoal, toggleTask,
    // openEditTaskSheet, deleteTask, openAddTaskFor.
  }

  return (
    <div className="mile-screen surface-sand relative h-full font-sans">
      <PageShell
        eyebrow="Module 04"
        title="Milestones"
        lead="Read-only view of a family member's milestones, goals and daily tasks."
        onHome={onHome}
        action={
          <div className="tile-static hidden shrink-0 px-5 py-3 text-right md:block">
            <p className="num text-2xl font-extrabold">{combinedMilestones.length}</p>
            <p className="text-[11px] text-muted-foreground">active milestones</p>
          </div>
        }
      >
        {users.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <span className="material-symbols-outlined text-4xl text-muted-foreground">group_off</span>
            <p className="font-semibold text-foreground">No family members connected yet</p>
          </div>
        ) : (
          <>
            <div className="txn-user-tabs">
              {users.map(u => (
                <button
                  key={u.id}
                  className={`txn-user-tab${activeUser === u.id ? ' active' : ''}`}
                  onClick={() => setActiveUser(u.id)}
                >
                  {u.name}
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <MilestoneAgendaSection {...sharedSectionProps} />
              <MilestoneAnalyticsSection
                activeMilestoneStats={activeMilestoneStats}
                trendData={trendData}
                breakdownData={breakdownData}
                goalChartData={goalChartData}
                perMilestoneChartData={perMilestoneChartData}
                globalBadges={globalBadges}
              />
            </div>
          </>
        )}
      </PageShell>
    </div>
  )
}
