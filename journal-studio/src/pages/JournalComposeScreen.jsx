import { useState } from 'react'
import PhoneFrame from '../components/PhoneFrame'
import StatusBar from '../components/StatusBar'

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current text-slate-900" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function LightbulbIcon() {
  return (
    <svg className="h-5 w-5 fill-slate-950" viewBox="0 0 24 24">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm-3 18h6v1c0 .55-.45 1-1 1h-4c-.55 0-1-.45-1-1v-1z" />
    </svg>
  )
}

// Writing surface for a single day — a lime header (matching the Journal list's own
// "highlighted" card treatment) carrying the date + a prompt-lightbulb + the commit
// action, and a plain text body below. `entry` being null means this is a fresh entry
// (button reads "Publish"); an existing entry being edited reads "Save" instead.
export default function JournalComposeScreen({ draft, onBack, onCommit }) {
  const [notes, setNotes] = useState(draft.notes || '')
  const isNew = !draft.id

  return (
    <PhoneFrame>
      <StatusBar />
      <div className="z-20 flex shrink-0 items-center justify-between bg-app-neon-lime px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-sm font-bold text-slate-900">{draft.date}</p>
          <p className="text-xs font-medium text-slate-700">{draft.day}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          <LightbulbIcon />
          <button
            type="button"
            onClick={() => onCommit(notes)}
            className="rounded-full bg-app-dark px-4 py-2 text-sm font-semibold text-white transition-all hover:bg-app-dark-hover active:scale-[0.97]"
          >
            {isNew ? 'Publish' : 'Save'}
          </button>
        </div>
      </div>

      <main className="no-scrollbar flex-1 overflow-y-auto px-6 py-5">
        <textarea
          autoFocus
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Write about your day…"
          className="h-full w-full resize-none border-none bg-transparent text-[15px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
        />
      </main>
    </PhoneFrame>
  )
}
