// Device-frame simulator, ported from the reference mockup: full-bleed on an actual
// phone (below the sm: breakpoint), a framed device mockup on a wider screen so it's
// easy to review on a laptop too.
export default function PhoneFrame({ children }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-[#ecebe6] p-0 font-sans text-slate-800 antialiased sm:p-4">
      <div className="relative flex h-[915px] max-h-[100dvh] w-full max-w-[420px] flex-col overflow-hidden border border-neutral-300/60 bg-app-bg sm:max-h-[900px] sm:rounded-[52px] sm:shadow-2xl sm:ring-8 sm:ring-black/5">
        {children}
      </div>
    </div>
  )
}
