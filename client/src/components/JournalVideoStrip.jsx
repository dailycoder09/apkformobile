import { useState } from 'react'

function XIcon() {
  return (
    <svg className="h-3.5 w-3.5 stroke-white stroke-[2.6]" fill="none" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}
function PlayIcon() {
  return (
    <svg className="h-6 w-6 fill-white drop-shadow" viewBox="0 0 24 24">
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}
function VideoCameraIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={`${className} stroke-current`} fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="3" y="6" width="12" height="12" rx="1.5" strokeLinejoin="round" />
      <path d="m15 10 5-3v10l-5-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function GalleryIcon() {
  return (
    <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="4" y="4" width="16" height="16" rx="2" strokeLinejoin="round" />
      <path d="m5 16 4.5-5 3.5 4 2-2.5L19 16" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="9" r="1.3" />
    </svg>
  )
}

// One video tile — collapsed state shows a muted, non-looping first-frame thumbnail
// with a centered play-triangle overlay so it reads as "video" rather than "silent
// photo". Tapping toggles an expanded state that swaps in native `controls` (and
// drops `muted`) so the user can actually play/pause/seek; tapping again collapses
// it back to the small thumbnail. Mirrors PhotoStrip's tile sizing/remove-button
// language exactly, just with a slightly larger footprint while expanded.
function VideoTile({ url, onRemove, removeLabel }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div
      className={`relative shrink-0 overflow-hidden rounded-xl bg-black/5 transition-all ${
        expanded ? 'size-32' : 'size-12'
      }`}
    >
      <video
        src={url}
        muted={!expanded}
        controls={expanded}
        playsInline
        onClick={() => setExpanded((prev) => !prev)}
        className="h-full w-full cursor-pointer object-cover"
      />
      {!expanded && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <PlayIcon />
        </div>
      )}
      <button
        type="button"
        onClick={onRemove}
        aria-label={removeLabel}
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60"
      >
        <XIcon />
      </button>
    </div>
  )
}

// Video attachment strip — same existing/new/removed pattern as JournalEntriesScreen's
// PhotoStrip. This component never touches localData itself: it only holds the
// already-resolved `{ id, url }` / `{ file, url }` shapes handed to it and reports
// add/remove intents upward via callbacks; the parent (ComposeScreen) is the one that
// owns persistence and calls addJournalMedia/deleteJournalMedia at Save/Publish time.
export default function JournalVideoStrip({
  existingVideos = [],
  newFiles = [],
  onRemoveExisting,
  onRemoveNew,
  onAddFiles,
  hideAddTile = false,
}) {
  return (
    <div className="flex shrink-0 items-center gap-2.5 overflow-x-auto">
      {existingVideos.map((v) => (
        <VideoTile key={v.id} url={v.url} onRemove={() => onRemoveExisting(v.id)} removeLabel="Remove video" />
      ))}
      {newFiles.map((f, i) => (
        <VideoTile key={f.url} url={f.url} onRemove={() => onRemoveNew(i)} removeLabel="Remove video" />
      ))}
      {!hideAddTile && (
        <>
          <label
            aria-label="Record video"
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500"
          >
            <VideoCameraIcon />
            <input
              type="file"
              accept="video/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                onAddFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </label>
          <label
            aria-label="Choose video from gallery"
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500"
          >
            <GalleryIcon />
            <input
              type="file"
              accept="video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                onAddFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </label>
        </>
      )}
    </div>
  )
}
