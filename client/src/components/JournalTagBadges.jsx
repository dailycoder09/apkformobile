// Read-only, compact inline display of an entry's tags for the journal list view
// (EntryCard in JournalEntriesScreen.jsx). Purely presentational — no interaction,
// no toggle state — kept deliberately quiet so it doesn't compete with the date,
// mood, or notes preview on the card.
export default function JournalTagBadges({ tags }) {
  if (!tags || tags.length === 0) return null

  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <span key={tag} className="rounded-full bg-black/5 px-2 py-0.5 text-[10px] font-medium text-slate-500">
          {tag}
        </span>
      ))}
    </div>
  )
}
