import { useState } from 'react'
import { CameraIcon, PaperclipIcon, VideoCameraIcon } from './attachmentIcons'
import JournalVoiceStrip from './JournalVoiceStrip'

// Single small icon that opens every attachment action (photo/video/voice/file) in one
// popover — replaces four separate always-visible add-tile rows. Extracted out of
// JournalEntriesScreen.jsx (originally Journal-only) so Health's episode/reminder
// compose forms can reuse the exact same menu. JournalVoiceStrip.jsx is generic despite
// its name (no Journal-specific logic/props) — reused as-is rather than renamed, to
// avoid an unrelated churn of updating every existing reference.
export default function AttachmentMenu({ onAddPhotoFiles, onAddVideoFiles, onAddDocFiles, voiceProps, attachedCount }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Add attachment"
        className="relative grid size-11 shrink-0 place-items-center rounded-full bg-black/5 text-slate-500"
      >
        <PaperclipIcon className="h-5 w-5" />
        {attachedCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-[#1e2229] text-[9px] font-bold text-white">
            {attachedCount}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2 flex items-center gap-2 rounded-2xl bg-white p-2.5 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.15)]">
          <label aria-label="Add photo" className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500">
            <CameraIcon />
            <input
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={(e) => {
                onAddPhotoFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </label>
          <label aria-label="Add video" className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500">
            <VideoCameraIcon />
            <input
              type="file"
              accept="video/*"
              multiple
              className="hidden"
              onChange={(e) => {
                onAddVideoFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </label>
          <JournalVoiceStrip {...voiceProps} hideTiles />
          <label aria-label="Attach file" className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-full bg-black/5 text-slate-500">
            <PaperclipIcon className="h-4 w-4" />
            <input
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                onAddDocFiles(Array.from(e.target.files || []))
                e.target.value = ''
              }}
            />
          </label>
        </div>
      )}
    </div>
  )
}
