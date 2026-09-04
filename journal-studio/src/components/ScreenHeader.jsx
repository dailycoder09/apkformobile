// Back/title/action header used by every screen EXCEPT the Hub — the Hub keeps its own
// centered "Mirello" script-logo nav (see HubScreen.jsx); every other screen swaps to
// this plain back-arrow + title + optional right-side action, matching the reference.
export default function ScreenHeader({ title, subtitle, onBack, action }) {
  return (
    <nav className="z-20 flex w-full shrink-0 items-center justify-between px-4 py-2.5">
      <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center text-slate-800">
        <svg className="h-6 w-6 stroke-[2.2] stroke-current" fill="none" viewBox="0 0 24 24">
          <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <div className="min-w-0 flex-1 text-center">
        <h1 className="truncate text-[19px] font-bold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="text-xs font-medium text-slate-500">{subtitle}</p>}
      </div>
      <div className="flex w-9 shrink-0 justify-end">{action}</div>
    </nav>
  )
}
