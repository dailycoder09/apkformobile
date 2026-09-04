// iOS-style status bar (time + signal/wifi/battery glyphs), ported from the reference
// mockup — purely decorative chrome so the screen reads as a real device screenshot.
export default function StatusBar() {
  return (
    <header className="flex w-full shrink-0 items-center justify-between px-7 pb-1.5 pt-3 text-slate-900">
      <div className="text-[15px] font-bold tracking-tight">9:41</div>
      <div className="flex items-center space-x-2">
        <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
          <path d="M2 17h3v4H2v-4zm5-4h3v8H7v-8zm5-5h3v13h-3V8zm5-5h3v18h-3V3z" />
        </svg>
        <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
          <path d="M12 4C7.31 4 3.07 5.9 0 8.98L12 21 24 8.98C20.93 5.9 16.69 4 12 4zm0 3.5c3.5 0 6.69 1.41 9 3.69L12 18.5 3 11.19c2.31-2.28 5.5-3.69 9-3.69z" />
        </svg>
        <div className="relative flex h-3 w-6 items-center rounded-sm border-2 border-slate-900 p-[1px]">
          <div className="h-full w-4 rounded-2xs bg-slate-900" />
          <div className="absolute -right-[4px] top-[2px] h-[4px] w-[2px] rounded-r-xs bg-slate-900" />
        </div>
      </div>
    </header>
  )
}
