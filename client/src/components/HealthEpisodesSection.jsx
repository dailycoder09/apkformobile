import { useState, useMemo } from 'react'
import { Tile, TileLabel, Stat } from './PageShell'
import { formatDateRange, formatDueLabel } from '../utils/healthFormat'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's other
// calendar/date logic (KhatabookPanel.jsx, MilestoneCalendarAgenda.jsx) — kept as its own
// local copy rather than shared.
const IST_TZ = 'Asia/Kolkata'
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
function pad(n) { return String(n).padStart(2, '0') }

const SEVERITY_TONE = {
  mild: { avatar: 'bg-success-soft text-success', chip: 'bg-success-soft text-success' },
  moderate: { avatar: 'bg-warning-soft text-warning', chip: 'bg-warning-soft text-warning' },
  severe: { avatar: 'bg-destructive-soft text-destructive', chip: 'bg-destructive-soft text-destructive' },
}
const SEVERITY_LABEL = { mild: 'Mild', moderate: 'Moderate', severe: 'Severe' }

// Page 1 of the mobile split: stat row + a range-based calendar + the episode list. Pure
// presentational — all state/handlers besides the calendar's own month/day navigation live
// in HealthTrackerPanel.jsx, matching KhatabookEntriesSection.jsx's split. `onOpenEpisode`
// and `onAddEpisode` are optional: AdminHealthView.jsx reuses this same component read-only
// by simply not passing them (see EpisodeRow below — no callback means a plain non-
// interactive row/no add button, never a disabled-but-present control).
export default function HealthEpisodesSection(props) {
  const { episodes, sortedEpisodes } = props
  const calendarState = useHealthCalendar(episodes)

  const filteredEpisodes = useMemo(() => {
    if (!calendarState.selectedDayKey) return sortedEpisodes
    return sortedEpisodes.filter(e => {
      const startKey = istDateKey(e.startDate)
      const endKey = istDateKey(e.recoveryDate ?? Date.now())
      return calendarState.selectedDayKey >= startKey && calendarState.selectedDayKey <= endKey
    })
  }, [sortedEpisodes, calendarState.selectedDayKey])

  return (
    <div className="px-1">
      <MobileFlat {...props} calendarState={calendarState} filteredEpisodes={filteredEpisodes} />
      <DesktopCards {...props} calendarState={calendarState} filteredEpisodes={filteredEpisodes} />
    </div>
  )
}

// Month grid + selected-day state, shared by the mobile and desktop calendar renders below.
// Unlike MilestoneCalendarAgenda's useCalendarAgenda (exact-date task matching), a day here
// gets a marker whenever ANY episode's [startDate, recoveryDate ?? now] range includes it —
// episodes span a date range, not a single day.
function useHealthCalendar(episodes) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  // null = no day selected (list shows everything). Selecting the same day twice clears it —
  // see selectDay below.
  const [selectedDayKey, setSelectedDayKey] = useState(null)

  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const monthLabel = viewMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  // Built from calendar components directly (not through a Date->ms->IST-key round trip for
  // the cell dates themselves) — same approach MilestoneCalendarAgenda.jsx's CalendarGrid
  // uses, since these y/m/d are already civil dates. Range membership is then checked by
  // comparing YYYY-MM-DD strings, which sort identically to chronological order — no epoch
  // math needed, and it sidesteps timezone edge cases entirely.
  const calendarCells = useMemo(() => {
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstWeekday; i++) cells.push(null)
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`
      const active = episodes.filter(e => {
        const startKey = istDateKey(e.startDate)
        const endKey = istDateKey(e.recoveryDate ?? Date.now())
        return key >= startKey && key <= endKey
      })
      cells.push({ date: new Date(year, month, day), key, active })
    }
    return cells
  }, [year, month, episodes])

  function goToMonth(delta) {
    setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }
  function goToToday() {
    const d = new Date()
    setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1))
    setSelectedDayKey(null)
  }
  function selectDay(key) {
    setSelectedDayKey(prev => prev === key ? null : key)
  }

  return { monthLabel, calendarCells, selectedDayKey, goToMonth, goToToday, selectDay }
}

// `compact`: mobile's flat treatment gets size-6/text-sm nav controls per this module's
// compact-icon-button convention; desktop keeps CalendarGrid's original size-8/text-lg.
function HealthCalendarHeader({ state, compact = false }) {
  const { monthLabel, goToMonth, goToToday } = state
  const navClass = compact
    ? 'grid size-6 shrink-0 place-items-center rounded-full border border-foreground/12 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'
    : 'grid size-8 shrink-0 place-items-center rounded-full border border-border text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground'
  const iconClass = compact ? 'material-symbols-outlined text-sm' : 'material-symbols-outlined text-lg'
  const todayClass = compact
    ? 'h-6 shrink-0 rounded-full border border-foreground/12 px-2.5 text-[11px] font-semibold text-foreground'
    : 'h-8 shrink-0 rounded-full border border-border bg-secondary px-3 text-xs font-semibold text-foreground transition-colors hover:bg-accent'
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-1.5">
        <span className="material-symbols-outlined text-sm text-gold">calendar_month</span>
        <TileLabel>Calendar</TileLabel>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => goToMonth(-1)} aria-label="Previous month" className={navClass}>
          <span className={iconClass}>chevron_left</span>
        </button>
        <span className="num min-w-[110px] text-center text-xs font-bold text-foreground sm:text-sm">{monthLabel}</span>
        <button type="button" onClick={() => goToMonth(1)} aria-label="Next month" className={navClass}>
          <span className={iconClass}>chevron_right</span>
        </button>
        <button type="button" onClick={goToToday} className={todayClass}>Today</button>
      </div>
    </div>
  )
}

function HealthCalendarGrid({ state }) {
  const { calendarCells, selectedDayKey, selectDay } = state
  const todayKey = istDateKey(Date.now())
  return (
    <>
      <div className="mt-4 grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold text-muted-foreground">
        {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="mt-1.5 grid grid-cols-7 gap-1.5">
        {calendarCells.map((cell, i) => {
          if (!cell) return <span key={`blank${i}`} />
          const { date, key, active } = cell
          const isSelected = key === selectedDayKey
          const isToday = key === todayKey
          const dotClass = active.some(e => e.severity === 'severe')
            ? 'bg-destructive'
            : active.some(e => e.severity === 'moderate')
            ? 'bg-warning'
            : active.length > 0
            ? 'bg-success'
            : null
          return (
            <button
              key={key}
              type="button"
              onClick={() => selectDay(key)}
              aria-label={`${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}${active.length ? `: ${active.length} active` : ''}`}
              className={`relative flex aspect-square flex-col items-center justify-center gap-1 rounded-xl text-xs transition-colors ${
                isSelected ? 'bg-gold-soft ring-2 ring-gold' : isToday ? 'font-bold ring-1 ring-foreground/12' : 'hover:bg-secondary'
              }`}
            >
              <span className="num font-semibold text-foreground">{date.getDate()}</span>
              {dotClass && <span className={`size-1.5 rounded-full ${dotClass}`} />}
            </button>
          )
        })}
      </div>
    </>
  )
}

// One row in the episode list — a plain <div> (not a button) when `onSelect` is omitted, for
// AdminHealthView's read-only reuse. No edit/delete icons anywhere: the whole row IS the tap
// target that opens the edit sheet, per this module's icon-free interaction convention.
function EpisodeRow({ e, onSelect }) {
  const tone = SEVERITY_TONE[e.severity] || SEVERITY_TONE.mild
  const inner = (
    <>
      <span className={`grid size-10 shrink-0 place-items-center rounded-full ${tone.avatar}`}>
        <span className="material-symbols-outlined text-lg">medical_services</span>
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{e.title}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {formatDateRange(e.startDate, e.recoveryDate)}
        </span>
      </span>
      <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${tone.chip}`}>
        {SEVERITY_LABEL[e.severity] || 'Mild'}
      </span>
    </>
  )
  if (!onSelect) {
    return <div className="flex w-full items-center gap-3 py-3.5 text-left">{inner}</div>
  }
  return (
    <button type="button" onClick={onSelect} className="flex w-full items-center gap-3 py-3.5 text-left">
      {inner}
    </button>
  )
}

// One row in the reminders list. `onOpen`/`onMarkDone` are optional, same convention as
// EpisodeRow above (AdminHealthView's read-only reuse omits both — see HealthTrackerPanel.jsx).
// A plain <span>/<button> split (not a button wrapping a button) since the row itself is
// tappable to edit AND carries its own separate "mark done" action.
function ReminderRow({ r, onOpen, onMarkDone }) {
  const label = formatDueLabel(r.dueDate)
  const overdue = label.startsWith('Overdue')
  const toneClass = overdue ? 'bg-destructive-soft text-destructive' : 'bg-warning-soft text-warning'
  const textClass = overdue ? 'text-destructive' : 'text-muted-foreground'
  const body = (
    <>
      <span className="block truncate text-sm font-semibold text-foreground">{r.title}</span>
      <span className={`block truncate text-xs ${textClass}`}>
        {label}{r.repeatDays ? ` · every ${r.repeatDays}d` : ''}
      </span>
    </>
  )
  return (
    <div className="flex w-full items-center gap-3 py-3">
      <span className={`grid size-10 shrink-0 place-items-center rounded-full ${toneClass}`}>
        <span className="material-symbols-outlined text-lg">medication</span>
      </span>
      {onOpen ? (
        <button type="button" onClick={() => onOpen(r)} className="min-w-0 flex-1 text-left">{body}</button>
      ) : (
        <span className="min-w-0 flex-1">{body}</span>
      )}
      {onMarkDone && (
        <button
          type="button"
          onClick={() => onMarkDone(r)}
          aria-label={`Mark ${r.title} done`}
          className="grid size-8 shrink-0 place-items-center rounded-full bg-success-soft text-success transition-transform active:scale-95"
        >
          <span className="material-symbols-outlined text-lg">check</span>
        </button>
      )}
    </div>
  )
}

// Reminders section shared by mobile/desktop below — hidden entirely for AdminHealthView's
// read-only reuse when there's nothing to show (no onAddReminder AND no reminders), so an
// empty admin view doesn't grow a pointless "Reminders: none" block.
function RemindersBlock({ upcomingReminders = [], onAddReminder, onOpenReminder, onMarkReminderDone }) {
  if (upcomingReminders.length === 0 && !onAddReminder) return null
  return (
    <>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm text-gold">medication</span>
          <TileLabel>Reminders</TileLabel>
        </div>
        {onAddReminder && (
          <button type="button" onClick={onAddReminder} className="text-xs font-semibold text-gold">+ Add</button>
        )}
      </div>
      {upcomingReminders.length === 0 ? (
        <p className="mt-3 text-sm text-muted-foreground">No reminders set.</p>
      ) : (
        <div className="mt-1 flex flex-col divide-y divide-foreground/12">
          {upcomingReminders.map(r => (
            <ReminderRow key={r.id} r={r} onOpen={onOpenReminder} onMarkDone={onMarkReminderDone} />
          ))}
        </div>
      )}
    </>
  )
}

function StatFlat({ label, value }) {
  return (
    <div>
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="num mt-1 text-lg font-extrabold text-foreground">{value}</p>
    </div>
  )
}

// ── Mobile: flat page, no card panels — sections separated by dividers/spacing only. ──
function MobileFlat({
  episodes,
  activeCount,
  totalCount,
  avgRecoveryDays,
  thisMonthCount,
  onOpenEpisode,
  calendarState,
  filteredEpisodes,
  upcomingReminders,
  onAddReminder,
  onOpenReminder,
  onMarkReminderDone,
}) {
  return (
    <div className="sm:hidden">
      <div className="grid grid-cols-2 gap-x-2 gap-y-3 border-b border-foreground/12 pb-4">
        <StatFlat label="Active" value={activeCount} />
        <StatFlat label="Total Episodes" value={totalCount} />
        <StatFlat label="Avg Recovery" value={`${avgRecoveryDays}d`} />
        <StatFlat label="This Month" value={thisMonthCount} />
      </div>

      {(upcomingReminders?.length > 0 || onAddReminder) && (
        <div className="mt-4 border-b border-foreground/12 pb-4">
          <RemindersBlock
            upcomingReminders={upcomingReminders}
            onAddReminder={onAddReminder}
            onOpenReminder={onOpenReminder}
            onMarkReminderDone={onMarkReminderDone}
          />
        </div>
      )}

      <div className="mt-4 border-b border-foreground/12 pb-4">
        <HealthCalendarHeader state={calendarState} compact />
        <HealthCalendarGrid state={calendarState} />
      </div>

      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <span className="material-symbols-outlined text-sm text-gold">medical_services</span>
            <TileLabel>Episodes</TileLabel>
          </div>
          {calendarState.selectedDayKey && (
            <button type="button" onClick={() => calendarState.selectDay(calendarState.selectedDayKey)} className="text-xs font-semibold text-gold">
              Clear filter
            </button>
          )}
        </div>

        {episodes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="material-symbols-outlined text-4xl text-muted-foreground">health_and_safety</span>
            <p className="font-semibold text-foreground">No episodes yet</p>
            <p className="text-sm text-muted-foreground">Tap the + button to log an illness</p>
          </div>
        ) : filteredEpisodes.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No episodes active on this day.</p>
        ) : (
          <div className="mt-2 flex flex-col divide-y divide-foreground/12">
            {filteredEpisodes.map(e => (
              <EpisodeRow key={e.id} e={e} onSelect={onOpenEpisode ? () => onOpenEpisode(e) : undefined} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Desktop: boxed Tile treatment, matching Khatabook/Milestone desktop conventions. Rows
// stay icon-free/tap-to-edit here too — this module's hard "no per-row icons" rule applies
// throughout, not just on mobile (see HealthTrackerPanel.jsx). ──
function DesktopCards({
  episodes,
  activeCount,
  totalCount,
  avgRecoveryDays,
  thisMonthCount,
  onOpenEpisode,
  onAddEpisode,
  calendarState,
  filteredEpisodes,
  upcomingReminders,
  onAddReminder,
  onOpenReminder,
  onMarkReminderDone,
}) {
  return (
    <div className="hidden sm:block">
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Active" value={String(activeCount)} hint="ongoing" tone="warning" icon={<span className="material-symbols-outlined text-base">emergency</span>} />
        <Stat label="Total Episodes" value={String(totalCount)} tone="gold" icon={<span className="material-symbols-outlined text-base">medical_services</span>} />
        <Stat label="Avg Recovery" value={`${avgRecoveryDays}d`} tone="success" icon={<span className="material-symbols-outlined text-base">healing</span>} />
        <Stat label="This Month" value={String(thisMonthCount)} icon={<span className="material-symbols-outlined text-base">calendar_today</span>} />
      </div>

      {(upcomingReminders?.length > 0 || onAddReminder) && (
        <Tile className="mt-4">
          <RemindersBlock
            upcomingReminders={upcomingReminders}
            onAddReminder={onAddReminder}
            onOpenReminder={onOpenReminder}
            onMarkReminderDone={onMarkReminderDone}
          />
        </Tile>
      )}

      <Tile className="mt-4">
        <HealthCalendarHeader state={calendarState} />
        <HealthCalendarGrid state={calendarState} />
      </Tile>

      <Tile className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <TileLabel>Episodes{calendarState.selectedDayKey ? ' · filtered' : ''}</TileLabel>
          <span className="flex shrink-0 items-center gap-3">
            {calendarState.selectedDayKey && (
              <button type="button" onClick={() => calendarState.selectDay(calendarState.selectedDayKey)} className="text-xs font-semibold text-gold">
                Clear filter
              </button>
            )}
            {onAddEpisode && (
              <button
                type="button"
                onClick={onAddEpisode}
                className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[image:var(--gradient-gold)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
              >
                <span className="material-symbols-outlined text-base">add</span> Add episode
              </button>
            )}
          </span>
        </div>

        <div className="mt-3 flex flex-col divide-y divide-border">
          {episodes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="material-symbols-outlined text-4xl text-muted-foreground">health_and_safety</span>
              <p className="font-semibold text-foreground">No episodes yet</p>
              <p className="text-sm text-muted-foreground">Add an illness to start tracking</p>
            </div>
          ) : filteredEpisodes.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">No episodes active on this day.</p>
          ) : filteredEpisodes.map(e => (
            <EpisodeRow key={e.id} e={e} onSelect={onOpenEpisode ? () => onOpenEpisode(e) : undefined} />
          ))}
        </div>
      </Tile>
    </div>
  )
}
