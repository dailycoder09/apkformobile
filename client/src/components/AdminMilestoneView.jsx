import { useState, useEffect, useMemo } from 'react'
import { LineChart } from '@mui/x-charts/LineChart'
import { PieChart } from '@mui/x-charts/PieChart'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import { computeGoalStats } from '../utils/milestoneStats'

// Duplicated from MilestonePanel.jsx rather than shared — matches this app's existing
// convention of each screen keeping its own copy of small IST/derivation helpers
// (TransactionPanel.jsx / AdminTransactionView.jsx do the same).
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ })
}
function istMidnight(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS
}
function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
}

// Same per-goal identity-color hash as MilestonePanel.jsx's accentFor — duplicated per
// this file's existing convention of not sharing helpers across the two screens.
const GOAL_ACCENTS = ['#c9a227', '#2a8f7f', '#c15b3c', '#5b6fc9', '#a34a8f']
function accentFor(goalId) {
  let h = 0
  for (let i = 0; i < goalId.length; i++) h = (h * 31 + goalId.charCodeAt(i) * 7) >>> 0
  return GOAL_ACCENTS[h % GOAL_ACCENTS.length]
}

// Read-only parent view of a child's milestones — mirrors AdminTransactionView.jsx's
// per-user fetch loop and user_joined/user_left handling exactly, scoped to
// milestone_data_get/milestone_data instead of transactions_get/transactions_list. No
// add/edit/delete/toggle controls: a parent can see progress, not change it.
export default function AdminMilestoneView({ initialUsers, sendMsg, addListener, onHome }) {
  const [users, setUsers] = useState(initialUsers || [])
  const [dataByUser, setDataByUser] = useState({}) // { [userId]: { goals, tasks } }
  const [activeUser, setActiveUser] = useState(initialUsers?.[0]?.id || null)
  const [selectedGoalId, setSelectedGoalId] = useState(null)
  const [selectedDayKey, setSelectedDayKey] = useState(null)
  const [showAnalytics, setShowAnalytics] = useState(false)

  useEffect(() => {
    users.forEach(u => sendMsg({ type: 'milestone_data_get', userId: u.id }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'milestone_data') {
        setDataByUser(prev => ({ ...prev, [msg.userId]: { goals: msg.goals || [], tasks: msg.tasks || [] } }))
      }
      if (msg.type === 'milestone_goal_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
          const exists = cur.goals.find(g => g.id === msg.goal.id)
          return { ...prev, [msg.fromUserId]: { ...cur, goals: exists ? cur.goals : [msg.goal, ...cur.goals] } }
        })
      }
      if (msg.type === 'milestone_goal_updated') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, goals: cur.goals.map(g => g.id === msg.goal.id ? msg.goal : g) } }
        })
      }
      if (msg.type === 'milestone_goal_deleted') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { goals: cur.goals.filter(g => g.id !== msg.id), tasks: cur.tasks.filter(t => t.goalId !== msg.id) } }
        })
      }
      if (msg.type === 'milestone_task_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
          const exists = cur.tasks.find(t => t.id === msg.task.id)
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: exists ? cur.tasks : [msg.task, ...cur.tasks] } }
        })
      }
      if (msg.type === 'milestone_tasks_bulk_new') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
          const ids = new Set(cur.tasks.map(t => t.id))
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: [...cur.tasks, ...(msg.tasks || []).filter(t => !ids.has(t.id))] } }
        })
      }
      if (msg.type === 'milestone_task_updated') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
          return { ...prev, [msg.fromUserId]: { ...cur, tasks: cur.tasks.map(t => t.id === msg.task.id ? msg.task : t) } }
        })
      }
      if (msg.type === 'milestone_task_deleted') {
        setDataByUser(prev => {
          const cur = prev[msg.fromUserId] || { goals: [], tasks: [] }
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

  const activeData = dataByUser[activeUser] || { goals: [], tasks: [] }
  const sortedGoals = useMemo(
    () => [...activeData.goals].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0)),
    [activeData.goals]
  )
  const selectedGoal = activeData.goals.find(g => g.id === selectedGoalId) || null
  const selectedStats = useMemo(
    () => selectedGoal ? computeGoalStats(selectedGoal, activeData.tasks) : null,
    [selectedGoal, activeData.tasks]
  )
  const selectedDay = selectedStats?.days.find(d => d.key === selectedDayKey) || null
  const heroAccent = selectedGoal ? accentFor(selectedGoal.id) : null
  const meteors = useMemo(() => {
    const count = Math.min(selectedStats?.currentStreak || 0, 4)
    return Array.from({ length: count }, () => ({ left: 10 + Math.random() * 70, delay: Math.random() * 4.5 }))
  }, [selectedGoal?.id, selectedStats?.currentStreak])

  // Same MUI X Charts LineChart data-reshape as MilestonePanel.jsx — see that file.
  const trendData = useMemo(() => {
    const pts = selectedStats?.dailyCompletion || []
    if (pts.length < 2) return null
    return { x: pts.map((_, i) => i), y: pts.map(p => p.pct) }
  }, [selectedStats?.dailyCompletion])

  const completionPieData = useMemo(() => {
    if (!selectedStats || selectedStats.totalTasks === 0) return null
    const remaining = selectedStats.totalTasks - selectedStats.completedTasks
    return [
      { id: 0, label: 'Done', value: selectedStats.completedTasks, color: heroAccent },
      { id: 1, label: 'Remaining', value: remaining, color: '#e5ddc8' },
    ]
  }, [selectedStats, heroAccent])

  // Same >14-day calendar-grid threshold and cell logic as MilestonePanel.jsx (read-only
  // here — no day-tap-to-select-and-edit, just navigation between months).
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
      const key = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      cells.push({ date: new Date(year, month, day), key, day: dayMap[key] || null })
    }
    return cells
  }, [calendarMonth, selectedStats])
  function goToCalMonth(delta) {
    setCalendarMonth(prev => { const d = new Date(prev); d.setMonth(d.getMonth() + delta); return d })
  }
  const calAtGoalStart = selectedGoal && calendarMonth
    && calendarMonth.getFullYear() === new Date(selectedGoal.startDate).getFullYear()
    && calendarMonth.getMonth() === new Date(selectedGoal.startDate).getMonth()
  const calAtGoalEnd = selectedGoal && calendarMonth && (() => {
    const end = new Date(selectedGoal.startDate + (selectedGoal.durationDays - 1) * 86400000)
    return calendarMonth.getFullYear() === end.getFullYear() && calendarMonth.getMonth() === end.getMonth()
  })()

  function openGoalDetail(id) {
    setSelectedGoalId(id)
    setSelectedDayKey(istDateKey(Date.now()))
    setShowAnalytics(false)
    const goal = activeData.goals.find(g => g.id === id)
    if (goal) {
      const todayMid = istMidnight(Date.now())
      const startMid = istMidnight(goal.startDate)
      const endMid = startMid + (goal.durationDays - 1) * 86400000
      setCalendarMonth(new Date(todayMid >= startMid && todayMid <= endMid ? todayMid : startMid))
    }
  }

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
        <span className="mile-title">Family Milestones</span>
      </div>

      <div className="mile-body">
        {!selectedGoal && (
          <div className="txn-user-tabs">
            {users.map(u => (
              <button key={u.id}
                className={`txn-user-tab${activeUser === u.id ? ' active' : ''}`}
                onClick={() => setActiveUser(u.id)}>
                {u.name}
              </button>
            ))}
          </div>
        )}

        {!activeUser ? (
          <div className="mile-empty">
            <span className="material-symbols-outlined mile-empty-icon">group_off</span>
            <p>No family members connected yet</p>
          </div>
        ) : !selectedGoal ? (
          <div className="mile-list-card">
            {sortedGoals.length === 0 ? (
              <div className="mile-empty">
                <span className="material-symbols-outlined mile-empty-icon">flag</span>
                <p>No milestones set yet</p>
              </div>
            ) : sortedGoals.map((g, idx) => {
              const stats = computeGoalStats(g, activeData.tasks)
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
                </div>
              )
            })}
          </div>
        ) : (
          <>
            <div className="mile-summary-card">
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
                  <div className="mile-ring mile-ring-lg" style={{ background: `conic-gradient(var(--txn-gold) ${selectedStats.daysElapsed / selectedStats.totalDays * 360}deg, rgba(58,42,46,0.08) 0deg)` }}>
                    <div className="mile-ring-hole mile-ring-hole-lg">
                      <span className="mile-ring-day">{selectedStats.daysElapsed}</span>
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

              <h2 className="mile-summary-title">{selectedGoal.title}</h2>

              <div className="mile-motivation-box">
                <span className="mile-motivation-box-icon"><span className="material-symbols-outlined">local_fire_department</span></span>
                <div>
                  <span className="mile-motivation-label">Motivation Score</span>
                  <span className="mile-motivation-val">{selectedStats.motivationScore}<span className="mile-motivation-max">/100</span></span>
                </div>
                <span className="mile-freeze-chip"><span className="material-symbols-outlined mile-inline-icon">ac_unit</span> {selectedStats.freezesRemaining}</span>
              </div>

              {selectedGoal.description && <p className="mile-summary-desc">{selectedGoal.description}</p>}
              {selectedStats.badges.length > 0 && (
                <>
                  <div className="mile-card-divider" />
                  <div className="mile-badge-row">
                    {selectedStats.badges.map(b => <span key={b.id} className="mile-badge-chip lg"><span className="material-symbols-outlined mile-inline-icon">{b.icon}</span> {b.label}</span>)}
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
                      className={`mile-heatmap-cell${d.allDone ? ' done' : ''}${d.isFuture ? ' future' : ''}${d.key === selectedDayKey ? ' selected' : ''}${d.isToday ? ' today' : ''}`}
                      onClick={() => !d.isFuture && setSelectedDayKey(d.key)}
                      disabled={d.isFuture}
                      aria-label={`${formatDate(d.date)}: ${d.tasks.length} task(s)`}
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
                        <span
                          key={key}
                          className={`mile-cal-cell${isToday ? ' mile-cal-cell--today' : ''}${day.isFuture ? ' mile-cal-cell--future' : ''}`}
                          style={fillStyle}
                          title={`${formatDate(date.getTime())}: ${total ? `${done}/${total} tasks done` : 'nothing planned'}`}
                        >
                          <span className="mile-cal-daynum" style={day.allDone ? { color: '#fff' } : {}}>{date.getDate()}</span>
                          {day.frozen && <span className="material-symbols-outlined mile-cal-freeze">ac_unit</span>}
                        </span>
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
                          <p className="mile-empty-sub mile-focus-empty">Check back tomorrow to see the trend.</p>
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
                <h3 className="mile-section-title">{formatDate(selectedDay.date)}{selectedDay.isToday ? ' (Today)' : ''}</h3>
                {selectedDay.tasks.length === 0 ? (
                  <p className="mile-empty-sub mile-focus-empty">Nothing planned for this day.</p>
                ) : selectedDay.tasks.map(t => (
                  <div key={t.id} className={`mile-task-card${t.done ? ' done' : ''}`}>
                    <div className={`mile-task-icon${t.done ? ' done' : ''}`}>
                      <span className="material-symbols-outlined">{t.done ? 'task_alt' : 'radio_button_unchecked'}</span>
                    </div>
                    <div className="mile-task-body">
                      <span className={`mile-task-title${t.done ? ' done' : ''}`}>{t.title}</span>
                      {t.description && <span className="mile-task-desc">{t.description}</span>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
