import { useState, useMemo } from 'react'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's
// other screens (MilestonePanel.jsx, milestoneStats.js) — kept as its own local copy
// here rather than imported, matching the established convention of each file owning a
// small date-utility copy instead of sharing one.
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istMidnight(ms) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()) - IST_OFFSET_MS
}

const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
function pad(n) { return String(n).padStart(2, '0') }

// Single default export containing BOTH the month calendar and the daily agenda, with the
// `grid grid-cols-1 gap-4 lg:grid-cols-2` wrapper owned internally — callers just drop in
// <MilestoneCalendarAgenda ... /> without needing to know how the two halves lay out.
export default function MilestoneCalendarAgenda({ goals, tasks, onToggleTask, onEditTask, onDeleteTask, onQuickAdd }) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  const [selectedDate, setSelectedDate] = useState(() => istMidnight(Date.now()))

  // Bucket every task by its IST day-key once — reused by both the calendar dots and the
  // daily agenda list below.
  const tasksByDay = useMemo(() => {
    const map = {}
    tasks.forEach(t => {
      const key = istDateKey(t.date)
      if (!map[key]) map[key] = []
      map[key].push(t)
    })
    return map
  }, [tasks])

  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const monthLabel = viewMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  // Built from calendar components directly (not through a Date->ms->IST-key round trip)
  // — same approach MilestonePanel.jsx's own calendar grid uses, since y/m/d here are
  // already civil dates and don't need timezone conversion.
  const calendarCells = useMemo(() => {
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstWeekday; i++) cells.push(null)
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`
      cells.push({ date: new Date(year, month, day), key, dayTasks: tasksByDay[key] || [] })
    }
    return cells
  }, [year, month, tasksByDay])

  function goToMonth(delta) {
    setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }
  function goToToday() {
    const d = new Date()
    setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1))
    setSelectedDate(istMidnight(Date.now()))
  }

  const selectedKey = istDateKey(selectedDate)
  const todayKey = istDateKey(Date.now())

  const selectedDayTasks = tasksByDay[selectedKey] || []
  const doneCount = selectedDayTasks.filter(t => t.done).length
  const goalIdsToday = useMemo(
    () => [...new Set(selectedDayTasks.map(t => t.goalId))],
    [selectedDayTasks]
  )

  // Group the selected day's tasks by their parent goal, matching each task to its
  // goal's title.
  const groupedByGoal = useMemo(
    () => goalIdsToday.map(goalId => ({
      goalId,
      goalTitle: goals.find(g => g.id === goalId)?.title || 'Untitled goal',
      tasks: selectedDayTasks.filter(t => t.goalId === goalId),
    })),
    [goalIdsToday, goals, selectedDayTasks]
  )

  const selectedWeekday = new Date(selectedDate).toLocaleDateString('en-IN', { timeZone: IST_TZ, weekday: 'long' })
  const selectedDayMonth = new Date(selectedDate).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'long' })

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Section 1 — month calendar */}
      <div className="tile p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-gold">calendar_month</span>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
              Calendar — Goals &amp; Tasks by Day
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button" onClick={() => goToMonth(-1)} aria-label="Previous month"
              className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <span className="material-symbols-outlined text-lg">chevron_left</span>
            </button>
            <span className="num min-w-[120px] text-center text-sm font-bold text-foreground">{monthLabel}</span>
            <button
              type="button" onClick={() => goToMonth(1)} aria-label="Next month"
              className="grid size-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
            >
              <span className="material-symbols-outlined text-lg">chevron_right</span>
            </button>
            <button
              type="button" onClick={goToToday}
              className="h-8 shrink-0 rounded-full border border-border bg-secondary px-3 text-xs font-semibold text-foreground transition-colors hover:bg-accent"
            >
              Today
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold text-muted-foreground">
          {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
        </div>
        <div className="mt-1.5 grid grid-cols-7 gap-1.5">
          {calendarCells.map((cell, i) => {
            if (!cell) return <span key={`blank${i}`} />
            const { date, key, dayTasks } = cell
            const total = dayTasks.length
            const done = dayTasks.filter(t => t.done).length
            const isSelected = key === selectedKey
            const isToday = key === todayKey
            const dotClass = done === total ? 'bg-success' : done > 0 ? 'bg-gold' : 'bg-border'
            return (
              <button
                key={key}
                type="button"
                onClick={() => setSelectedDate(istMidnight(date.getTime()))}
                aria-label={`${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}${total ? `: ${done}/${total} tasks done` : ''}`}
                className={`relative flex aspect-square flex-col items-center justify-center gap-1 rounded-xl text-xs transition-colors ${
                  isSelected ? 'bg-gold-soft ring-2 ring-gold' : isToday ? 'font-bold ring-1 ring-border' : 'hover:bg-secondary'
                }`}
              >
                <span className="num font-semibold text-foreground">{date.getDate()}</span>
                {total > 0 && <span className={`size-1.5 rounded-full ${dotClass}`} />}
              </button>
            )
          })}
        </div>
      </div>

      {/* Section 2 — daily agenda */}
      <div className="tile flex flex-col p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-gold">today</span>
            <p className="text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">Daily Agenda</p>
          </div>
          <button
            type="button"
            onClick={() => onQuickAdd(selectedDate)}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[image:var(--gradient-gold)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            <span className="material-symbols-outlined text-sm">add</span> Quick add
          </button>
        </div>

        <div className="mt-3">
          <p className="text-sm font-bold text-foreground">{selectedWeekday}, {selectedDayMonth}</p>
          <p className="num text-xs text-muted-foreground">
            {doneCount}/{selectedDayTasks.length} tasks done · {groupedByGoal.length} goals
          </p>
        </div>

        <div className="mt-3 flex flex-col gap-4">
          {groupedByGoal.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-14 text-center">
              <span className="material-symbols-outlined text-4xl text-muted-foreground">event_available</span>
              <p className="text-sm text-muted-foreground">No tasks scheduled for this day</p>
            </div>
          ) : groupedByGoal.map(group => (
            <div key={group.goalId} className="min-w-0">
              <p className="mb-1.5 truncate text-[11px] font-semibold uppercase tracking-[0.15em] text-muted-foreground">
                {group.goalTitle}
              </p>
              <div className="flex flex-col gap-2">
                {group.tasks.map(t => (
                  <div
                    key={t.id}
                    className={`flex items-center gap-3 rounded-2xl border border-border p-3 ${t.done ? 'bg-success-soft' : 'bg-card'}`}
                  >
                    <button
                      type="button"
                      onClick={() => onToggleTask(t)}
                      aria-label={t.done ? 'Mark task incomplete' : 'Mark task complete'}
                      className={`grid size-8 shrink-0 place-items-center rounded-full transition-colors ${
                        t.done ? 'bg-success-soft text-success' : 'text-muted-foreground hover:bg-secondary'
                      }`}
                    >
                      <span className="material-symbols-outlined text-xl">{t.done ? 'check_circle' : 'radio_button_unchecked'}</span>
                    </button>
                    <div className="min-w-0 flex-1">
                      <p className={`truncate text-sm font-semibold ${t.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>
                        {t.title}
                      </p>
                      {t.description && <p className="truncate text-xs text-muted-foreground">{t.description}</p>}
                    </div>
                    <button
                      type="button" onClick={() => onEditTask(t)} aria-label="Edit task"
                      className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                    >
                      <span className="material-symbols-outlined text-lg">edit</span>
                    </button>
                    <button
                      type="button" onClick={() => onDeleteTask(t.id)} aria-label="Delete task"
                      className="grid size-8 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive"
                    >
                      <span className="material-symbols-outlined text-lg">delete</span>
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
