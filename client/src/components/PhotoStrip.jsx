import { useState } from 'react'
import { CameraIcon, GalleryIcon, XIcon } from './attachmentIcons'

// Photo attachment strip — existing (already-saved) photos load from IndexedDB by
// entry id; newly picked files stay as in-memory File objects with object URLs until
// the caller's own commit step actually persists them. Extracted out of
// JournalEntriesScreen.jsx (originally Journal-only) so Health's episode/reminder
// compose forms can reuse the exact same strip.
export default function PhotoStrip({ existingPhotos, newFiles, onRemoveExisting, onRemoveNew, onAddFiles, hideAddTile = false }) {
  const [previewUrl, setPreviewUrl] = useState(null)
  return (
    <div className="flex shrink-0 items-center gap-2.5 overflow-x-auto">
      {previewUrl && (
        <div
          onClick={() => setPreviewUrl(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-6"
        >
          <img src={previewUrl} alt="" className="max-h-full max-w-full rounded-xl object-contain" />
          <button
            type="button"
            onClick={() => setPreviewUrl(null)}
            aria-label="Close preview"
            className="absolute right-4 top-4 grid size-9 place-items-center rounded-full bg-black/60"
          >
            <XIcon />
          </button>
        </div>
      )}
      {existingPhotos.map((p) => (
        <div key={p.id} className="relative size-12 shrink-0 overflow-hidden rounded-xl bg-black/5">
          <img
            src={p.url}
            alt=""
            onClick={() => setPreviewUrl(p.url)}
            className="h-full w-full cursor-pointer object-cover"
          />
          <button
            type="button"
            onClick={() => onRemoveExisting(p.id)}
            aria-label="Remove photo"
            className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60"
          >
            <XIcon />
          </button>
        </div>
      ))}
      {newFiles.map((f, i) => (
        <div key={f.url} className="relative size-12 shrink-0 overflow-hidden rounded-xl bg-black/5">
          <img
            src={f.url}
            alt=""
            onClick={() => setPreviewUrl(f.url)}
            className="h-full w-full cursor-pointer object-cover"
          />
          <button
            type="button"
            onClick={() => onRemoveNew(i)}
            aria-label="Remove photo"
            className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60"
          >
            <XIcon />
          </button>
        </div>
      ))}
      {!hideAddTile && (
        <>
          <label
            aria-label="Take photo"
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500"
          >
            <CameraIcon />
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => {
                onAddFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </label>
          <label
            aria-label="Choose from gallery"
            className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500"
          >
            <GalleryIcon />
            <input
              type="file"
              accept="image/*"
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
