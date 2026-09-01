import { useState } from 'react'
import { computeGoalStats, computeMilestoneStats } from '../utils/milestoneStats'
import { Tile, TileLabel, Stat, Bar } from './PageShell'
import MilestoneCalendarAgenda, { useCalendarAgenda, CalendarGrid, DailyAgendaCard } from './MilestoneCalendarAgenda'

// Page 1 of the mobile split: everything the user actively acts on day to day — the
// milestone selector, the hero progress card, the calendar/agenda, and the Goals &
// Today's Tasks management UI. Pure presentational — all state/handlers live in
// MilestonePanel.jsx and are passed down as props, matching KhatabookEntriesSection.jsx's
// pattern exactly. Mobile and desktop are two distinct top-level branches here (rather
// than mixing `md:` variants into shared markup): mobile renders a flat, card-free page
// per the user's request, desktop keeps the original boxed-Tile treatment untouched.

const QUOTES = [
  'Consistency is what transforms average into excellence.',
  "The secret of getting ahead is getting started.",
  'Small daily improvements are the key to staggering long-term results.',
  "Discipline is choosing between what you want now and what you want most.",
  "You don't have to be great to start, but you have to start to be great.",
  'Progress, not perfection.',
]
// Stable per-milestone (not re-randomized on every render) — a cheap string hash picks a
// consistent index for a given id. Duplicated from MilestonePanel.jsx rather than shared,
// since it's only ever used by the hero card that now lives entirely in this file.
function quoteFor(id) {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return QUOTES[h % QUOTES.length]
}

export default function MilestoneAgendaSection(props) {
  return (
    <div className="px-1">
      <MobileFlat {...props} />
      <DesktopCards {...props} />
    </div>
  )
}

// Hero progress ring — called from BOTH branches with identical markup (per explicit
// instruction: mobile shows this exactly as it already looks, ring visuals untouched).
// Extracted into its own function rather than duplicated inline, so there is exactly one
// copy of this markup even though it renders in two places.
function HeroCard({ activeMilestone, activeMilestoneStats, animatedRingPct, milestoneCount }) {
  if (!activeMilestone || !activeMilestoneStats) return null
  return (
    <div className="tile grain flex flex-col items-center justify-center p-8 text-center">
      <div
        className="relative grid size-44 shrink-0 place-items-center rounded-full"
        style={{ background: `conic-gradient(var(--color-gold) ${animatedRingPct * 3.6}deg, var(--color-secondary) 0deg)` }}
      >
        <div className="grid size-36 place-items-center rounded-full bg-card">
          <p className="num text-5xl font-extrabold text-gradient-gold">{animatedRingPct}%</p>
          <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.2em] text-muted-foreground">
            {activeMilestoneStats.goalsCompleted}/{activeMilestoneStats.goalsCount} goals
          </p>
        </div>
      </div>
      <span className="mt-5 inline-flex items-center gap-1.5 rounded-full bg-gold-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
        <span className="material-symbols-outlined text-sm">auto_awesome</span> Active Milestone
        {milestoneCount != null && <span className="opacity-70">· {milestoneCount} total</span>}
      </span>
      <h2 className="font-display mt-3 text-2xl font-extrabold">{activeMilestone.title}</h2>
      {activeMilestone.description && <p className="mt-2 max-w-md text-sm text-muted-foreground">{activeMilestone.description}</p>}
      <p className="mt-4 flex items-start gap-2 text-xs italic text-muted-foreground">
        <span className="material-symbols-outlined mt-0.5 shrink-0 text-sm text-gold">format_quote</span>
        {quoteFor(activeMilestone.id)}
      </p>
    </div>
  )
}

// Button toggle between the hero progress card and the calendar grid — mobile only. A tap
// control rather than a swipe: this block sits inside a page that's itself one page of the
// outer page-1/page-2 SwipeCarousel, and a nested swipe gesture here was confusing against
// that outer swipe (tried and rejected earlier tonight).
function HeroOrCalendar({ activeMilestone, activeMilestoneStats, animatedRingPct, calState }) {
  const [view, setView] = useState('progress')
  if (!activeMilestone || !activeMilestoneStats) return null
  return (
    // No top margin here — this is the first thing on the page now, right after
    // PageShell's own header spacing (mb-2 on mobile), so an extra mt-4 on top of that
    // just compounded into more gap than needed between the title and this toggle.
    <div className="border-b border-foreground/12 pb-4">
      <div className="flex gap-1 rounded-full bg-secondary/60 p-1">
        <button
          type="button"
          onClick={() => setView('progress')}
          aria-pressed={view === 'progress'}
          className={`flex-1 rounded-full py-1.5 text-xs font-semibold transition-colors ${view === 'progress' ? 'bg-card text-gold shadow-sm' : 'text-muted-foreground'}`}
        >
          Progress
        </button>
        <button
          type="button"
          onClick={() => setView('calendar')}
          aria-pressed={view === 'calendar'}
          className={`flex-1 rounded-full py-1.5 text-xs font-semibold transition-colors ${view === 'calendar' ? 'bg-card text-gold shadow-sm' : 'text-muted-foreground'}`}
        >
          Calendar
        </button>
      </div>
      <div className="mt-3">
        {view === 'progress' ? (
          <HeroCard activeMilestone={activeMilestone} activeMilestoneStats={activeMilestoneStats} animatedRingPct={animatedRingPct} />
        ) : (
          <CalendarGrid state={calState} />
        )}
      </div>
    </div>
  )
}

// ── Mobile: flat page, no card panels — sections separated by dividers/spacing only. ──
function MobileFlat({
  overall,
  combinedMilestones,
  activeMilestone,
  activeMilestoneStats,
  animatedRingPct,
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
  openEditMilestone,
  deleteMilestone,
  openAddGoal,
  duplicateGoal,
  archiveGoal,
  unarchiveGoal,
  deleteGoal,
  toggleTask,
  openEditTaskSheet,
  deleteTask,
  openAddTaskFor,
}) {
  const calState = useCalendarAgenda(goals, tasks)
  return (
    <div className="md:hidden">
      {/* Hero progress ring / Calendar — now the first thing on the page, ahead of the
          stat row and milestone list, per explicit request. Button toggle, calendar
          positioned right next to the hero card instead of stacking full-width below it.
          Daily Agenda lives in its own section further down, not bundled into this block. */}
      <HeroOrCalendar
        activeMilestone={activeMilestone}
        activeMilestoneStats={activeMilestoneStats}
        animatedRingPct={animatedRingPct}
        goals={goals}
        tasks={tasks}
        calState={calState}
      />

      {/* Top-line numbers — plain 2x2 grid, no card background. Dividers use
          foreground/opacity rather than the --color-border token: that token is
          calibrated for card-on-card contrast and all but disappears laid directly over
          this page's sand gradient. */}
      <div className="mt-4 grid grid-cols-2 gap-x-3 gap-y-3 border-b border-foreground/12 pb-4">
        <div>
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Best streak</p>
          <p className="num mt-1 truncate text-lg font-extrabold text-warning">{overall.bestStreak}d</p>
        </div>
        <div>
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Tasks done</p>
          <p className="num mt-1 truncate text-lg font-extrabold text-success">{overall.totalDoneAll}</p>
        </div>
        <div>
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Goals achieved</p>
          <p className="num mt-1 truncate text-lg font-extrabold text-gold">{overall.totalGoalsAchieved}</p>
        </div>
        <div>
          <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">Today's tasks</p>
          <p className="num mt-1 truncate text-lg font-extrabold text-gold">{activeMilestoneStats?.todayDone ?? 0}/{activeMilestoneStats?.todayTotal ?? 0}</p>
        </div>
      </div>

      {/* Milestone selector — plain list, rows separated by a hairline divider instead of
          a boxed panel. Selected row: text color change only, no bordered/tinted pill. */}
      <div className="mt-4 border-b border-foreground/12 pb-4">
        <TileLabel>Milestones</TileLabel>

        {combinedMilestones.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No milestones yet — start your first one.</p>
        ) : (
          <div className="mt-2 flex flex-col divide-y divide-foreground/12">
            {combinedMilestones.map(m => {
              const selected = m.id === activeMilestone?.id
              const gfs = m.synthetic ? orphanGoals.map(g => ({ ...g, milestoneId: m.id })) : goals
              const s = computeMilestoneStats(m, gfs, tasks)
              return (
                <div key={m.id} className={`flex items-center gap-2 py-3 ${selected ? 'text-gold' : ''}`}>
                  <button type="button" onClick={() => setActiveMilestoneId(m.id)} className="min-w-0 flex-1 text-left">
                    <p className="flex items-center gap-1.5 truncate text-sm font-semibold">
                      <span className="truncate">{m.title}</span>
                      {s.isComplete && <span className="material-symbols-outlined shrink-0 text-sm text-gold">emoji_events</span>}
                    </p>
                    <p className="num mt-0.5 truncate text-xs text-muted-foreground">
                      Day {s.daysElapsed} of {s.totalDays} · {s.completionPct}% · {s.goalsCount} goals
                    </p>
                    <div className="mt-2">
                      <Bar value={s.completionPct} tone="gold" />
                    </div>
                  </button>
                  {/* Edit/delete only surface for the selected row — tapping a milestone
                      both activates it and reveals its actions, instead of every row
                      showing icons all the time. Omitted entirely (not disabled) when
                      openEditMilestone/deleteMilestone aren't passed — AdminMilestoneView.jsx's
                      read-only reuse doesn't pass either, same "no callback = no control"
                      convention as HealthEpisodesSection.jsx's EpisodeRow. */}
                  {!m.synthetic && selected && (openEditMilestone || deleteMilestone) && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {openEditMilestone && (
                        <button
                          type="button"
                          aria-label={`Edit ${m.title}`}
                          onClick={() => openEditMilestone(m)}
                          className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        >
                          <span className="material-symbols-outlined text-sm">edit</span>
                        </button>
                      )}
                      {deleteMilestone && (
                        <button
                          type="button"
                          aria-label={`Delete ${m.title}`}
                          onClick={() => deleteMilestone(m.id)}
                          className="grid size-6 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive"
                        >
                          <span className="material-symbols-outlined text-sm">delete</span>
                        </button>
                      )}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>

      {/* Daily Agenda — its own section, outside the hero/calendar block above. */}
      <div className="mt-4 border-b border-foreground/12 pb-4">
        <DailyAgendaCard
          state={calState}
          onToggleTask={toggleTask}
          onEditTask={openEditTaskSheet}
          onDeleteTask={deleteTask}
          onQuickAdd={openAddTaskFor ? (dateMs) => openAddTaskFor(dateMs) : undefined}
        />
      </div>

      {/* Goals & Today's Tasks — plain list, no boxed goal cards. "Add goal" moved to a
          compact icon button here (the floating action button on this page is reserved
          for "Add task", the more frequent day-to-day action). */}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="material-symbols-outlined text-base text-gold">flag</span>
            <TileLabel>Goals &amp; Today's Tasks</TileLabel>
          </div>
          {openAddGoal && (
            <button
              type="button"
              aria-label="Add goal"
              disabled={!activeMilestone}
              onClick={openAddGoal}
              className="grid size-8 shrink-0 place-items-center rounded-full bg-secondary text-foreground transition-colors hover:bg-secondary/70 disabled:opacity-40"
            >
              <span className="material-symbols-outlined text-lg">add</span>
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-col divide-y divide-foreground/12">
          {activeGoals.map(g => {
            // Collapsed by default — expanding a goal is now also what reveals its
            // duplicate/archive/delete icons, instead of every goal showing them always.
            const open = openGoals[g.id] ?? false
            const stats = computeGoalStats(g, tasks)
            const today = stats.days.find(d => d.isToday)
            const todayTasks = today?.tasks ?? []
            return (
              <div key={g.id} className="py-3">
                <div className="flex items-start gap-2">
                  <button onClick={() => setOpenGoals(o => ({ ...o, [g.id]: !open }))} className="min-w-0 flex-1 text-left">
                    <p className={`flex items-center gap-1.5 text-sm font-bold ${stats.isComplete ? 'text-success' : 'text-foreground'}`}>
                      <span className={`material-symbols-outlined shrink-0 text-base transition-transform ${open ? '' : '-rotate-90'}`}>expand_more</span>
                      <span className="truncate">{g.title}</span>
                      {stats.isComplete && <span className="material-symbols-outlined shrink-0 text-base text-gold">emoji_events</span>}
                      {stats.freezesRemaining > 0 && (
                        <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-foreground/12 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground" title="Streak freezes protect your streak on a missed day">
                          <span className="material-symbols-outlined text-xs">ac_unit</span>{stats.freezesRemaining}
                        </span>
                      )}
                    </p>
                    <p className="num mt-0.5 pl-5 text-xs text-muted-foreground">
                      Day {stats.daysElapsed}/{stats.totalDays} · {stats.completionPct}% · {todayTasks.filter(t => t.done).length}/{todayTasks.length} tasks today
                    </p>
                    <div className="ml-5 mt-2">
                      <Bar value={stats.completionPct} tone="gold" />
                    </div>
                  </button>
                  {open && (duplicateGoal || archiveGoal || unarchiveGoal || deleteGoal) && (
                    <span className="flex shrink-0 items-center gap-0.5">
                      {duplicateGoal && (
                        <button onClick={() => duplicateGoal(g)} aria-label="Duplicate goal" title="Start again from today"
                          className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground">
                          <span className="material-symbols-outlined text-xs">content_copy</span>
                        </button>
                      )}
                      {g.status === 'archived' ? (
                        unarchiveGoal && (
                          <button onClick={() => unarchiveGoal(g)} aria-label="Unarchive goal" title="Unarchive"
                            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground">
                            <span className="material-symbols-outlined text-xs">unarchive</span>
                          </button>
                        )
                      ) : (
                        archiveGoal && (
                          <button onClick={() => archiveGoal(g)} aria-label="Archive goal" title="Archive"
                            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground">
                            <span className="material-symbols-outlined text-xs">archive</span>
                          </button>
                        )
                      )}
                      {deleteGoal && (
                        <button onClick={() => deleteGoal(g.id)} aria-label={`Delete ${g.title}`}
                          className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive">
                          <span className="material-symbols-outlined text-xs">delete</span>
                        </button>
                      )}
                    </span>
                  )}
                </div>

                {open && (
                  <div className="mt-3 animate-fade-in flex flex-col gap-2 pl-5">
                    {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                    {todayTasks.map(t => {
                      const taskBody = (
                        <>
                          <span className={`grid size-6 shrink-0 place-items-center rounded-full border transition-colors ${t.done ? 'border-success bg-success text-white' : 'border-foreground/25'}`}>
                            {t.done && <span className="material-symbols-outlined text-sm">check</span>}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-sm font-semibold ${t.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{t.title}</span>
                            {t.description && <span className="block truncate text-xs text-muted-foreground">{t.description}</span>}
                          </span>
                        </>
                      )
                      return (
                        <div key={t.id} className="flex items-center gap-2 border-b border-foreground/12 pb-2 last:border-0 last:pb-0">
                          {toggleTask ? (
                            <button onClick={() => toggleTask(t)} className="flex min-w-0 flex-1 items-center gap-2 text-left">{taskBody}</button>
                          ) : (
                            <span className="flex min-w-0 flex-1 items-center gap-2">{taskBody}</span>
                          )}
                          {openEditTaskSheet && (
                            <button aria-label="Edit task" onClick={() => openEditTaskSheet(t)}
                              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground">
                              <span className="material-symbols-outlined text-xs">edit</span>
                            </button>
                          )}
                          {deleteTask && (
                            <button aria-label="Delete task" onClick={() => deleteTask(t.id)}
                              className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive">
                              <span className="material-symbols-outlined text-xs">delete</span>
                            </button>
                          )}
                        </div>
                      )
                    })}
                    {todayTasks.length === 0 && (
                      <p className="py-3 text-center text-xs text-muted-foreground">No daily tasks for today yet.</p>
                    )}
                    {openAddTaskFor && (
                      <button
                        type="button"
                        onClick={() => openAddTaskFor(Date.now(), g.id)}
                        className="flex h-7 w-fit items-center gap-1 rounded-full bg-secondary px-3 text-xs font-semibold text-foreground transition-colors hover:bg-secondary/70"
                      >
                        <span className="material-symbols-outlined text-xs">add</span> Add daily task
                      </button>
                    )}
                  </div>
                )}
              </div>
            )
          })}
          {activeMilestone && activeGoals.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">No goals yet — add the first goal for this milestone.</p>
          )}
        </div>

        {activeArchivedGoals.length > 0 && (
          <div className="mt-4 border-t border-foreground/12 pt-4">
            <button type="button" onClick={() => setShowArchived(v => !v)} className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
              <span className="material-symbols-outlined text-base">{showArchived ? 'expand_less' : 'expand_more'}</span>
              {showArchived ? 'Hide' : 'Show'} archived ({activeArchivedGoals.length})
            </button>
            {showArchived && (
              <div className="mt-2 flex flex-col divide-y divide-foreground/12">
                {activeArchivedGoals.map(g => {
                  const stats = computeGoalStats(g, tasks)
                  return (
                    <div key={g.id} className="flex items-center gap-2 py-2.5 opacity-70">
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{g.title} <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Archived</span></p>
                        <p className="text-xs text-muted-foreground">Day {stats.daysElapsed}/{stats.totalDays} · {stats.completionPct}%</p>
                      </div>
                      {unarchiveGoal && (
                        <button onClick={() => unarchiveGoal(g)} aria-label="Unarchive goal"
                          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-foreground">
                          <span className="material-symbols-outlined text-xs">unarchive</span>
                        </button>
                      )}
                      {deleteGoal && (
                        <button onClick={() => deleteGoal(g.id)} aria-label="Delete goal"
                          className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors hover:text-destructive">
                          <span className="material-symbols-outlined text-xs">delete</span>
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Desktop: original boxed-Tile treatment, unchanged. ──
function DesktopCards({
  overall,
  combinedMilestones,
  activeMilestone,
  activeMilestoneStats,
  animatedRingPct,
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
  openAddMilestone,
  openEditMilestone,
  deleteMilestone,
  openAddGoal,
  duplicateGoal,
  archiveGoal,
  unarchiveGoal,
  deleteGoal,
  toggleTask,
  openEditTaskSheet,
  deleteTask,
  openAddTaskFor,
}) {
  return (
    <div className="hidden md:block">
      <div className="grid grid-cols-1 gap-4 stagger md:grid-cols-6">
        <div className="col-span-1 grid grid-cols-1 gap-4 self-start sm:grid-cols-2 md:col-span-2">
          <Stat label="Best streak" value={`${overall.bestStreak}d`} tone="warning" icon={<span className="material-symbols-outlined text-base">local_fire_department</span>} hint="Longest running goal" />
          <Stat label="Tasks done" value={`${overall.totalDoneAll}`} tone="success" icon={<span className="material-symbols-outlined text-base">task_alt</span>} hint={`${overall.completionRate}% completion`} />
          <Stat label="Goals achieved" value={`${overall.totalGoalsAchieved}`} tone="gold" icon={<span className="material-symbols-outlined text-base">emoji_events</span>} hint={`${activeMilestoneStats?.goalsCompleted ?? 0}/${activeMilestoneStats?.goalsCount ?? 0} in this milestone`} />
          <Stat label="Today's tasks" value={`${activeMilestoneStats?.todayDone ?? 0}/${activeMilestoneStats?.todayTotal ?? 0}`} tone="gold" icon={<span className="material-symbols-outlined text-base">checklist</span>} hint={activeMilestone?.title ?? '—'} />
        </div>

        <Tile className="col-span-1 md:col-span-4">
          <div className="flex items-center justify-between gap-3">
            <TileLabel>Milestones</TileLabel>
            {openAddMilestone && (
              <button
                type="button"
                onClick={openAddMilestone}
                className="flex h-8 items-center gap-1 rounded-full bg-[image:var(--gradient-gold)] px-3.5 text-xs font-semibold text-accent-foreground transition-opacity hover:opacity-90"
              >
                <span className="material-symbols-outlined text-sm">add</span> New milestone
              </button>
            )}
          </div>
          <ul className="mt-4 space-y-2">
            {combinedMilestones.map(m => {
              const selected = m.id === activeMilestone?.id
              const gfs = m.synthetic ? orphanGoals.map(g => ({ ...g, milestoneId: m.id })) : goals
              const s = computeMilestoneStats(m, gfs, tasks)
              return (
                <li key={m.id}>
                  <div className={`flex w-full items-start gap-3 rounded-2xl border p-4 text-left transition-all duration-300 hover:-translate-y-0.5 ${
                    selected ? 'border-gold/40 bg-gold-soft shadow-[var(--shadow-glow)]' : 'border-border bg-secondary/40'
                  }`}>
                    <button onClick={() => setActiveMilestoneId(m.id)} className="min-w-0 flex-1 text-left">
                      <p className="flex items-center gap-1.5 truncate text-sm font-bold">
                        <span className="truncate">{m.title}</span>
                        {s.isComplete && <span className="material-symbols-outlined shrink-0 text-base text-gold">emoji_events</span>}
                      </p>
                      <p className="num mt-0.5 text-xs text-muted-foreground">
                        Day {s.daysElapsed} of {s.totalDays} · {s.completionPct}% · {s.goalsCount} goals · {s.tasksCompleted}/{s.tasksTotal} tasks
                      </p>
                      <div className="mt-2.5">
                        <Bar value={s.completionPct} tone="gold" />
                      </div>
                    </button>
                    {!m.synthetic && (openEditMilestone || deleteMilestone) && (
                      <span className="flex shrink-0 items-center gap-1">
                        {openEditMilestone && (
                          <button
                            aria-label={`Edit ${m.title}`}
                            onClick={() => openEditMilestone(m)}
                            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground"
                          >
                            <span className="material-symbols-outlined text-lg">edit</span>
                          </button>
                        )}
                        {deleteMilestone && (
                          <button
                            aria-label={`Delete ${m.title}`}
                            onClick={() => deleteMilestone(m.id)}
                            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive"
                          >
                            <span className="material-symbols-outlined text-lg">delete</span>
                          </button>
                        )}
                      </span>
                    )}
                  </div>
                </li>
              )
            })}
            {combinedMilestones.length === 0 && (
              <li className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No milestones yet — start your first one.
              </li>
            )}
          </ul>
        </Tile>

        {activeMilestone && activeMilestoneStats && (
          <div className="col-span-1 md:col-span-6">
            <HeroCard activeMilestone={activeMilestone} activeMilestoneStats={activeMilestoneStats} animatedRingPct={animatedRingPct} />
          </div>
        )}

        <div className="col-span-1 md:col-span-6">
          <MilestoneCalendarAgenda
            goals={goals}
            tasks={tasks}
            onToggleTask={toggleTask}
            onEditTask={openEditTaskSheet}
            onDeleteTask={deleteTask}
            onQuickAdd={openAddTaskFor ? (dateMs) => openAddTaskFor(dateMs) : undefined}
          />
        </div>

        <Tile className="col-span-1 md:col-span-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <span className="material-symbols-outlined text-lg text-gold">flag</span>
              <TileLabel>Goals &amp; Today's Tasks</TileLabel>
            </div>
            {openAddGoal && (
              <button
                type="button"
                disabled={!activeMilestone}
                onClick={openAddGoal}
                className="flex h-8 items-center gap-1 rounded-full bg-[image:var(--gradient-gold)] px-3.5 text-xs font-semibold text-accent-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
              >
                <span className="material-symbols-outlined text-sm">add</span> Add goal
              </button>
            )}
          </div>

          <div className="mt-4 space-y-3">
            {activeGoals.map(g => {
              const open = openGoals[g.id] ?? true
              const stats = computeGoalStats(g, tasks)
              const today = stats.days.find(d => d.isToday)
              const todayTasks = today?.tasks ?? []
              return (
                <div key={g.id} className={`rounded-2xl border p-4 transition-all duration-300 ${stats.isComplete ? 'border-success/40 bg-success-soft' : 'border-border bg-secondary/40'}`}>
                  <div className="flex items-start gap-3">
                    <button onClick={() => setOpenGoals(o => ({ ...o, [g.id]: !open }))} className="min-w-0 flex-1 text-left">
                      <p className="flex items-center gap-1.5 text-sm font-bold">
                        <span className={`material-symbols-outlined shrink-0 text-base transition-transform ${open ? '' : '-rotate-90'}`}>expand_more</span>
                        <span className="truncate">{g.title}</span>
                        {stats.isComplete && <span className="material-symbols-outlined shrink-0 text-base text-gold">emoji_events</span>}
                        {stats.freezesRemaining > 0 && (
                          <span className="flex shrink-0 items-center gap-0.5 rounded-full border border-border bg-card px-1.5 py-0.5 text-[10px] font-semibold text-foreground" title="Streak freezes protect your streak on a missed day">
                            <span className="material-symbols-outlined text-xs">ac_unit</span>{stats.freezesRemaining}
                          </span>
                        )}
                      </p>
                      <p className="num mt-0.5 pl-5 text-xs text-muted-foreground">
                        Day {stats.daysElapsed}/{stats.totalDays} · {stats.completionPct}% · {todayTasks.filter(t => t.done).length}/{todayTasks.length} tasks today
                      </p>
                      <div className="ml-5 mt-2.5">
                        <Bar value={stats.completionPct} tone="gold" />
                      </div>
                    </button>
                    {(duplicateGoal || archiveGoal || unarchiveGoal || deleteGoal) && (
                      <span className="flex shrink-0 items-center gap-1">
                        {duplicateGoal && (
                          <button onClick={() => duplicateGoal(g)} aria-label="Duplicate goal" title="Start again from today"
                            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground">
                            <span className="material-symbols-outlined text-base">content_copy</span>
                          </button>
                        )}
                        {g.status === 'archived' ? (
                          unarchiveGoal && (
                            <button onClick={() => unarchiveGoal(g)} aria-label="Unarchive goal" title="Unarchive"
                              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground">
                              <span className="material-symbols-outlined text-base">unarchive</span>
                            </button>
                          )
                        ) : (
                          archiveGoal && (
                            <button onClick={() => archiveGoal(g)} aria-label="Archive goal" title="Archive"
                              className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground">
                              <span className="material-symbols-outlined text-base">archive</span>
                            </button>
                          )
                        )}
                        {deleteGoal && (
                          <button onClick={() => deleteGoal(g.id)} aria-label={`Delete ${g.title}`}
                            className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive">
                            <span className="material-symbols-outlined text-base">delete</span>
                          </button>
                        )}
                      </span>
                    )}
                  </div>

                  {open && (
                    <div className="mt-3 animate-fade-in space-y-2 border-t border-border pt-3">
                      {g.description && <p className="text-xs text-muted-foreground">{g.description}</p>}
                      {todayTasks.map(t => {
                        const taskBody = (
                          <>
                            <span className={`grid size-6 shrink-0 place-items-center rounded-full border transition-colors ${t.done ? 'border-success bg-success text-white' : 'border-clay'}`}>
                              {t.done && <span className="material-symbols-outlined text-sm">check</span>}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className={`block truncate text-sm font-semibold ${t.done ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{t.title}</span>
                              {t.description && <span className="block truncate text-xs text-muted-foreground">{t.description}</span>}
                            </span>
                          </>
                        )
                        return (
                          <div key={t.id} className={`relative flex items-center gap-3 rounded-xl border p-3 transition-all duration-300 hover:-translate-y-0.5 ${t.done ? 'border-success/30 bg-success-soft' : 'border-border bg-card'}`}>
                            {toggleTask ? (
                              <button onClick={() => toggleTask(t)} className="flex min-w-0 flex-1 items-center gap-3 text-left">{taskBody}</button>
                            ) : (
                              <span className="flex min-w-0 flex-1 items-center gap-3">{taskBody}</span>
                            )}
                            {(openEditTaskSheet || deleteTask) && (
                              <span className="flex shrink-0 items-center gap-1">
                                {openEditTaskSheet && (
                                  <button aria-label="Edit task" onClick={() => openEditTaskSheet(t)}
                                    className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground">
                                    <span className="material-symbols-outlined text-base">edit</span>
                                  </button>
                                )}
                                {deleteTask && (
                                  <button aria-label="Delete task" onClick={() => deleteTask(t.id)}
                                    className="grid size-7 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive">
                                    <span className="material-symbols-outlined text-base">delete</span>
                                  </button>
                                )}
                              </span>
                            )}
                          </div>
                        )
                      })}
                      {todayTasks.length === 0 && (
                        <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">No daily tasks for today yet.</p>
                      )}
                      {openAddTaskFor && (
                        <button
                          type="button"
                          onClick={() => openAddTaskFor(Date.now(), g.id)}
                          className="flex h-8 items-center gap-1 rounded-full bg-secondary px-3.5 text-xs font-semibold text-foreground transition-colors hover:bg-border"
                        >
                          <span className="material-symbols-outlined text-sm">add</span> Add daily task
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {activeMilestone && activeGoals.length === 0 && (
              <p className="rounded-2xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
                No goals yet — add the first goal for this milestone.
              </p>
            )}
          </div>

          {activeArchivedGoals.length > 0 && (
            <div className="mt-4 border-t border-border pt-4">
              <button type="button" onClick={() => setShowArchived(v => !v)} className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <span className="material-symbols-outlined text-base">{showArchived ? 'expand_less' : 'expand_more'}</span>
                {showArchived ? 'Hide' : 'Show'} archived ({activeArchivedGoals.length})
              </button>
              {showArchived && (
                <div className="mt-2 flex flex-col gap-2">
                  {activeArchivedGoals.map(g => {
                    const stats = computeGoalStats(g, tasks)
                    return (
                      <div key={g.id} className="flex items-center gap-3 rounded-2xl border border-border bg-secondary/40 p-3 opacity-70">
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-foreground">{g.title} <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">Archived</span></p>
                          <p className="text-xs text-muted-foreground">Day {stats.daysElapsed}/{stats.totalDays} · {stats.completionPct}%</p>
                        </div>
                        {unarchiveGoal && (
                          <button onClick={() => unarchiveGoal(g)} aria-label="Unarchive goal"
                            className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-card hover:text-foreground">
                            <span className="material-symbols-outlined text-base">unarchive</span>
                          </button>
                        )}
                        {deleteGoal && (
                          <button onClick={() => deleteGoal(g.id)} aria-label="Delete goal"
                            className="grid size-7 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-destructive-soft hover:text-destructive">
                            <span className="material-symbols-outlined text-base">delete</span>
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )}
        </Tile>
      </div>
    </div>
  )
}
