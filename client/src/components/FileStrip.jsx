import { PaperclipIcon, XIcon } from './attachmentIcons'

// Generic any-file-type attachment strip (documents, PDFs, anything not covered by the
// photo/voice/video strips). Files have no visual preview, so these render as small
// labeled chips (filename + remove) instead of thumbnail tiles. Extracted out of
// JournalEntriesScreen.jsx (originally Journal-only) so Health's episode/reminder
// compose forms can reuse the exact same strip.
export default function FileStrip({ existingFiles, newDocs, onRemoveExisting, onRemoveNew, onAddFiles, hideAddTile = false }) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2">
      {existingFiles.map((f) => (
        <div key={f.id} className="flex max-w-[10rem] shrink-0 items-center gap-1.5 rounded-xl bg-black/5 px-2.5 py-2">
          <button
            type="button"
            onClick={() => window.open(f.url, '_blank', 'noopener')}
            className="flex min-w-0 items-center gap-1.5"
          >
            <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span className="truncate text-xs font-medium text-slate-600">{f.name || 'File'}</span>
          </button>
          <button
            type="button"
            onClick={() => onRemoveExisting(f.id)}
            aria-label="Remove file"
            className="grid size-4 shrink-0 place-items-center rounded-full bg-black/60"
          >
            <XIcon />
          </button>
        </div>
      ))}
      {newDocs.map((d, i) => (
        <div key={d.url} className="flex max-w-[10rem] shrink-0 items-center gap-1.5 rounded-xl bg-black/5 px-2.5 py-2">
          <button
            type="button"
            onClick={() => window.open(d.url, '_blank', 'noopener')}
            className="flex min-w-0 items-center gap-1.5"
          >
            <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
            <span className="truncate text-xs font-medium text-slate-600">{d.name}</span>
          </button>
          <button
            type="button"
            onClick={() => onRemoveNew(i)}
            aria-label="Remove file"
            className="grid size-4 shrink-0 place-items-center rounded-full bg-black/60"
          >
            <XIcon />
          </button>
        </div>
      ))}
      {!hideAddTile && (
        <label
          aria-label="Attach file"
          className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500"
        >
          <PaperclipIcon className="h-4 w-4" />
          <input
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              onAddFiles(Array.from(e.target.files || []))
              e.target.value = ''
            }}
          />
        </label>
      )}
    </div>
  )
}
