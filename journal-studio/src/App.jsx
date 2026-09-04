import { useState } from 'react'
import HubScreen from './pages/HubScreen'
import JournalListScreen from './pages/JournalListScreen'
import JournalComposeScreen from './pages/JournalComposeScreen'

const LOREM = 'Maecenas sit amet consectetur arcu, quis semper orci. Donec hendrerit tellus dictum mi tincidunt luctus. Pellentesque in lorem cursu...'

// crypto.randomUUID only exists in a secure context (HTTPS, or literally "localhost") —
// this gets tested over plain http://<lan-ip>:5174 on a phone, which isn't one, so a
// direct crypto.randomUUID() call would throw there (hit this exact bug in the main
// chat-pwa app already this session).
function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

const SEED_ENTRIES = [
  { id: 'e1', date: '25 Nov, 2024', day: 'Monday', notes: LOREM, highlighted: false },
  { id: 'e2', date: '25 Nov, 2024', day: 'Wednesday', notes: LOREM, highlighted: true },
  { id: 'e3', date: '25 Nov, 2024', day: 'Monday', notes: LOREM, highlighted: false },
  { id: 'e4', date: '25 Nov, 2024', day: 'Wednesday', notes: 'Maecenas sit amet consectetur arcu, quis...', highlighted: true },
]

// Plain useState screen router — small enough scope (3 screens so far) that a real
// router would be premature; add one if/when this grows past the journal flow.
export default function App() {
  const [screen, setScreen] = useState('hub') // 'hub' | 'journal' | 'compose'
  const [entries, setEntries] = useState(SEED_ENTRIES)
  const [draft, setDraft] = useState(null)

  function openNewEntry() {
    const now = new Date()
    setDraft({
      id: null,
      date: now.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }),
      day: now.toLocaleDateString('en-US', { weekday: 'long' }),
      notes: '',
    })
    setScreen('compose')
  }

  function openExistingEntry(entry) {
    setDraft(entry)
    setScreen('compose')
  }

  function commitDraft(notes) {
    if (draft.id) {
      setEntries((prev) => prev.map((e) => (e.id === draft.id ? { ...e, notes } : e)))
    } else {
      setEntries((prev) => [{ id: makeId(), date: draft.date, day: draft.day, notes, highlighted: false }, ...prev])
    }
    setScreen('journal')
  }

  if (screen === 'journal') {
    return (
      <JournalListScreen
        entries={entries}
        onBack={() => setScreen('hub')}
        onOpenEntry={openExistingEntry}
        onNewEntry={openNewEntry}
      />
    )
  }

  if (screen === 'compose') {
    return <JournalComposeScreen draft={draft} onBack={() => setScreen('journal')} onCommit={commitDraft} />
  }

  return <HubScreen onOpenJournal={() => setScreen('journal')} />
}
