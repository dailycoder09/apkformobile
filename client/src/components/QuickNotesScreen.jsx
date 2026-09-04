import { useEffect, useState } from 'react'
import * as localData from '../lib/localData'

function formatUpdatedAt(ms) {
  return new Date(ms).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
}

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current text-slate-900" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg className="h-5 w-5 stroke-[2.4] stroke-current" fill="none" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}

function NoteCard({ note, onOpen }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-3xl border border-black/[0.03] bg-white p-5 text-left shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform active:scale-[0.985]"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-sm font-bold text-slate-900">{note.title || 'Untitled note'}</span>
        <span className="shrink-0 text-xs font-medium text-slate-400">{formatUpdatedAt(note.updatedAt)}</span>
      </div>
      <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-slate-600">{note.body}</p>
    </button>
  )
}

function ComposeNote({ draft, onBack, onCommit }) {
  const [title, setTitle] = useState(draft.title || '')
  const [body, setBody] = useState(draft.body || '')

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between border-b border-black/5 bg-white px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <p className="text-sm font-bold text-slate-900">Quick Note</p>
        <button
          type="button"
          onClick={() => onCommit({ title, body })}
          className="rounded-full bg-[#1e2229] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
        >
          Save
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          className="w-full border-none bg-transparent text-xl font-bold text-slate-900 outline-none placeholder:text-slate-400"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Start typing…"
          className="mt-3 h-[calc(100%-3rem)] w-full resize-none border-none bg-transparent text-[15px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
        />
      </div>
    </div>
  )
}

// Simple standalone notes list, same visual language as JournalEntriesScreen (white
// rounded cards, dark pill CTA) but without Journal's date/day/highlight framing —
// these are freeform notes, not day-based entries. Persisted to IndexedDB
// (localData.js's quick_notes table), same as Journal.
export default function QuickNotesScreen({ onBack }) {
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState(null)

  useEffect(() => {
    localData.getQuickNotesSeeded().then(setNotes)
  }, [])

  function openNewNote() {
    setDraft({ id: null, title: '', body: '' })
  }
  function openExistingNote(note) {
    setDraft(note)
  }
  async function commitDraft({ title, body }) {
    if (draft.id) {
      const updated = await localData.updateQuickNote(draft.id, { title, body })
      setNotes((prev) => prev.map((n) => (n.id === draft.id ? updated : n)))
    } else {
      const created = await localData.addQuickNote({ title, body })
      setNotes((prev) => [created, ...prev])
    }
    setDraft(null)
  }

  if (draft) {
    return <ComposeNote draft={draft} onBack={() => setDraft(null)} onCommit={commitDraft} />
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <h1 className="text-[19px] font-bold tracking-tight text-slate-900">Quick Notes</h1>
        <div className="w-9" />
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 pt-2">
        {notes.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-16 text-center">
            <p className="font-semibold text-slate-900">No notes yet</p>
            <p className="text-sm text-slate-500">Tap below to jot something down</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {notes.map((n) => (
              <NoteCard key={n.id} note={n} onOpen={() => openExistingNote(n)} />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 px-6 pb-6 pt-2">
        <button
          type="button"
          onClick={openNewNote}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[#1e2229] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_24px_-4px_rgba(30,34,41,0.28)] transition-all hover:opacity-90 active:scale-[0.985]"
        >
          <PlusIcon />
          Add note
        </button>
      </div>
    </div>
  )
}
