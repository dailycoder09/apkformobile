// Small icon set shared by the generic attachment components (PhotoStrip, FileStrip,
// AttachmentMenu) — extracted out of JournalEntriesScreen.jsx so Health's episode/
// reminder cards can reuse the exact same attachment UI instead of duplicating it.

export function CameraIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={`${className} stroke-current`} fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M4 8.5A1.5 1.5 0 0 1 5.5 7h2l1-2h7l1 2h2A1.5 1.5 0 0 1 20 8.5v9A1.5 1.5 0 0 1 18.5 19h-13A1.5 1.5 0 0 1 4 17.5v-9Z" strokeLinejoin="round" />
      <circle cx="12" cy="13" r="3.3" />
    </svg>
  )
}
export function XIcon() {
  return (
    <svg className="h-3.5 w-3.5 stroke-white stroke-[2.6]" fill="none" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}
export function GalleryIcon() {
  return (
    <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="4" y="4" width="16" height="16" rx="2" strokeLinejoin="round" />
      <path d="m5 16 4.5-5 3.5 4 2-2.5L19 16" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="9" cy="9" r="1.3" />
    </svg>
  )
}
export function MicIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={`${className} stroke-current`} fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" strokeLinecap="round" />
    </svg>
  )
}
export function VideoCameraIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={`${className} stroke-current`} fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <rect x="3" y="6" width="12" height="12" rx="1.5" strokeLinejoin="round" />
      <path d="m15 10 5-3v10l-5-3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
export function PaperclipIcon({ className = 'h-4 w-4' }) {
  return (
    <svg className={`${className} stroke-current`} fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M8 12.5 15 5.5a3 3 0 0 1 4.2 4.2l-8.5 8.5a5 5 0 0 1-7-7l7.7-7.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
