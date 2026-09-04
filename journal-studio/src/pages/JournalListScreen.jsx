import PhoneFrame from '../components/PhoneFrame'
import StatusBar from '../components/StatusBar'
import ScreenHeader from '../components/ScreenHeader'
import DarkPillButton from '../components/DarkPillButton'

function SortIcon() {
  return (
    <svg className="h-5 w-5 stroke-[2] stroke-current text-slate-800" fill="none" viewBox="0 0 24 24">
      <path d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LightbulbIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={`${className} fill-slate-950`} viewBox="0 0 24 24">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm-3 18h6v1c0 .55-.45 1-1 1h-4c-.55 0-1-.45-1-1v-1z" />
    </svg>
  )
}

// A day entry is "highlighted" when it carries a prompted insight (the lightbulb badge)
// — a full lime card instead of the plain white one, same signal the compose screen's
// own lime header uses for "this entry has a prompt attached to it".
function EntryCard({ entry, onOpen, faded = false }) {
  const isHighlighted = entry.highlighted
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full rounded-[1.35rem] p-5 text-left shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform active:scale-[0.985] ${
        isHighlighted ? 'bg-app-neon-lime' : 'border border-black/[0.03] bg-white'
      } ${faded ? 'opacity-60' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-bold text-slate-900">{entry.date}</span>
          <span className={`text-xs font-medium ${isHighlighted ? 'text-slate-700' : 'text-slate-400'}`}>{entry.day}</span>
        </div>
        {isHighlighted && <LightbulbIcon />}
      </div>
      <p className={`mt-2.5 text-xs leading-relaxed ${isHighlighted ? 'text-slate-700' : 'text-slate-600'} ${faded ? 'line-clamp-1' : 'line-clamp-3'}`}>
        {entry.notes}
      </p>
    </button>
  )
}

export default function JournalListScreen({ entries, onBack, onOpenEntry, onNewEntry }) {
  return (
    <PhoneFrame>
      <StatusBar />
      <ScreenHeader title="Journal" onBack={onBack} action={<button type="button" aria-label="Sort"><SortIcon /></button>} />

      <main className="no-scrollbar relative flex-1 overflow-y-auto px-6 pb-4 pt-2">
        <div className="space-y-3.5">
          {entries.map((entry, i) => (
            <EntryCard
              key={entry.id}
              entry={entry}
              faded={i === entries.length - 1 && entries.length > 3}
              onOpen={() => onOpenEntry(entry)}
            />
          ))}
        </div>
      </main>

      <footer className="shrink-0 px-6 pb-6 pt-2">
        <DarkPillButton className="w-full" onClick={onNewEntry}>
          Start a new entry
        </DarkPillButton>
      </footer>
    </PhoneFrame>
  )
}
