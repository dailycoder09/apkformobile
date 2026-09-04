export const JOURNAL_TAGS = ['Family', 'Health', 'Work', 'Finance', 'Personal', 'Travel', 'Faith', 'Friends']

// Controlled, stateless multi-select chip row for tagging a journal entry with
// zero or more categories. Mirrors MoodBadge/PhotoStrip in JournalEntriesScreen.jsx:
// the parent owns the selection state, this component only renders it and reports
// taps via onToggle. Lives as a shrink-0 row in the ComposeScreen footer, alongside
// PhotoStrip.
export default function JournalTagPicker({ selectedTags = [], onToggle }) {
  return (
    <div className="flex flex-wrap gap-2 px-6 pb-3 pt-1">
      {JOURNAL_TAGS.map((tag) => {
        const selected = selectedTags.includes(tag)
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            aria-pressed={selected}
            className={`rounded-full px-3 py-1.5 text-xs font-semibold transition-colors ${
              selected ? 'bg-[#1e2229] text-white' : 'border border-black/[0.06] bg-white text-slate-600'
            }`}
          >
            {tag}
          </button>
        )
      })}
    </div>
  )
}
