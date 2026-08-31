import { Tile, TileLabel, Stat } from './PageShell'
import { formatDate, moodEmoji, moodLabel } from '../utils/journalFormat'

// Page 1 of the mobile split: stat row + the reverse-chronological entry list. Pure
// presentational — all state/handlers live in JournalPanel.jsx and are passed down as props,
// matching KhatabookEntriesSection.jsx's split. Mobile and desktop are two distinct
// top-level branches (rather than mixing `sm:` variants into shared markup): mobile renders
// a flat, card-free page, desktop keeps the boxed-Tile treatment.
export default function JournalEntriesSection(props) {
  return (
    <div className="px-1">
      <MobileFlat {...props} />
      <DesktopCards {...props} />
    </div>
  )
}

// One row in the entry list. No edit/delete icons — the whole row IS the tap target that
// opens the edit sheet (Delete lives inside that sheet), per this app's icon-free row
// convention established this session (Khatabook/Health).
function EntryRow({ e, onSelect }) {
  const inner = (
    <>
      <span className="grid size-11 shrink-0 place-items-center rounded-full bg-gold-soft text-xl">
        {moodEmoji(e.mood)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold text-foreground">{formatDate(e.date)}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {moodLabel(e.mood)} · energy {e.energy}/5 · {e.sleepHours || 0}h sleep
        </span>
        {e.tags?.length > 0 && (
          <span className="mt-1.5 flex flex-wrap gap-1">
            {e.tags.map(t => (
              <span key={t} className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                {t}
              </span>
            ))}
          </span>
        )}
        {e.notes && (
          <span className="mt-1 block truncate text-xs italic text-muted-foreground/80">{e.notes}</span>
        )}
      </span>
    </>
  )
  return (
    <button type="button" onClick={onSelect} className="flex w-full items-start gap-3 py-3.5 text-left">
      {inner}
    </button>
  )
}

function StatFlat({ label, value }) {
  return (
    <div>
      <p className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="num mt-1 truncate text-lg font-extrabold text-foreground">{value}</p>
    </div>
  )
}

// ── Mobile: flat page, no card panels — sections separated by dividers/spacing only. ──
function MobileFlat({ entries, avgMood30d, streak, avgSleep, topTheme, openEditEntry }) {
  return (
    <div className="sm:hidden">
      <div className="grid grid-cols-2 gap-x-2 gap-y-3 border-b border-foreground/12 pb-4">
        <StatFlat label="Avg Mood (30d)" value={avgMood30d != null ? `${avgMood30d.toFixed(1)}/5` : '—'} />
        <StatFlat label="Journal Streak" value={`${streak}d`} />
        <StatFlat label="Avg Sleep" value={avgSleep != null ? `${avgSleep.toFixed(1)}h` : '—'} />
        <StatFlat label="Top Theme" value={topTheme || '—'} />
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-1.5">
          <span className="material-symbols-outlined text-sm text-gold">edit_note</span>
          <TileLabel>Entries</TileLabel>
        </div>

        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center">
            <span className="material-symbols-outlined text-4xl text-muted-foreground">edit_note</span>
            <p className="font-semibold text-foreground">No entries yet</p>
            <p className="text-sm text-muted-foreground">Tap the + button to log how today went</p>
          </div>
        ) : (
          <div className="mt-2 flex flex-col divide-y divide-foreground/12">
            {entries.map(e => (
              <EntryRow key={e.id} e={e} onSelect={() => openEditEntry(e)} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Desktop: boxed Tile treatment, matching Khatabook/Health desktop conventions. ──
function DesktopCards({ entries, avgMood30d, streak, avgSleep, topTheme, openAddEntry, openEditEntry }) {
  return (
    <div className="hidden sm:block">
      <div className="stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Avg Mood (30d)"
          value={avgMood30d != null ? `${avgMood30d.toFixed(1)}/5` : '—'}
          tone="gold"
          icon={<span className="material-symbols-outlined text-base">mood</span>}
        />
        <Stat
          label="Journal Streak"
          value={`${streak}d`}
          hint={streak > 0 ? 'keep it going' : 'log today to start one'}
          tone="success"
          icon={<span className="material-symbols-outlined text-base">local_fire_department</span>}
        />
        <Stat
          label="Avg Sleep"
          value={avgSleep != null ? `${avgSleep.toFixed(1)}h` : '—'}
          icon={<span className="material-symbols-outlined text-base">bedtime</span>}
        />
        <Stat
          label="Top Theme"
          value={topTheme || '—'}
          icon={<span className="material-symbols-outlined text-base">sell</span>}
        />
      </div>

      <Tile className="mt-4">
        <div className="flex items-center justify-between gap-3">
          <TileLabel>Entries</TileLabel>
          <button
            type="button"
            onClick={openAddEntry}
            className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-[image:var(--gradient-gold)] px-3 text-xs font-semibold text-white transition-opacity hover:opacity-90"
          >
            <span className="material-symbols-outlined text-base">add</span> Add entry
          </button>
        </div>

        <div className="mt-3 flex flex-col divide-y divide-border">
          {entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="material-symbols-outlined text-4xl text-muted-foreground">edit_note</span>
              <p className="font-semibold text-foreground">No entries yet</p>
              <p className="text-sm text-muted-foreground">Add an entry to start your journal</p>
            </div>
          ) : entries.map(e => (
            <EntryRow key={e.id} e={e} onSelect={() => openEditEntry(e)} />
          ))}
        </div>
      </Tile>
    </div>
  )
}
