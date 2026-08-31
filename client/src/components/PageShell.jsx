// Shared page chrome ported from the reference app's PageShell.tsx - every
// Tailwind-scoped module page (Khatabook, Milestones, and eventually Prayer/Finance)
// wraps its content in this exact shell so headers, spacing, and the two decorative
// glow orbs stay identical across pages instead of each screen hand-rolling its own.
// Drops the reference's own bottom Dock (this app already mounts one global BottomNav
// in App.jsx) and its <Link to="/"> (this app navigates module screens via an onHome
// callback prop, not a router).

import CornerMenu from './CornerMenu'

export function PageShell({
  eyebrow, title, lead, action, onHome, back = true, children,
  session, sendMsg, addListener, showProfile, onProfileOpen,
}) {
  return (
    <div className="relative min-h-full overflow-x-hidden overflow-y-auto surface-sand">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 -right-32 size-[520px] rounded-full bg-[image:var(--gradient-gold)] opacity-25 blur-3xl animate-float"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-[38rem] -left-40 size-[420px] rounded-full bg-clay opacity-25 blur-3xl animate-float"
        style={{ animationDelay: '1.6s' }}
      />

      {/* pt-6 on mobile / pt-10 from sm: up — back to the original compact top padding.
          CornerMenu used to float fixed over every screen, which forced this padding up
          (first to pt-14, then pt-16) just to keep the trigger's circle from painting over
          the header. CornerMenu now mounts INLINE in the header row below (top-right, next
          to the title) instead of floating, so there's no more overlay to reserve dead
          vertical space for. */}
      <main className="relative mx-auto w-full max-w-6xl px-4 pt-6 pb-36 sm:px-6 sm:pt-10">
        {/* flex-col by default (not the reference's own grid-cols-[1fr_auto]) - that grid
            forces the title and action area side by side even on a narrow phone, which
            squeezes the title column so tight it truncates ("Milestones" -> "Mile...").
            Side-by-side only kicks in at sm: and up, where there's room for both. */}
        <header className="mb-2 flex flex-col gap-3 animate-fade-up sm:mb-8 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          {/* Title block + CornerMenu share one always-row strip (unlike the flex-col/
              sm:flex-row split governing title-vs-action stacking below) so the corner
              trigger sits top-right, inline, right next to the title at every width — on a
              phone (where `action` stacks below the title) and on desktop (where `action`
              sits beside it) alike. */}
          <div className="flex min-w-0 flex-1 items-start justify-between gap-3">
            <div className="min-w-0">
              {/* Back link only from sm: up — on a phone BottomNav's own Home icon already
                  covers this, so the link is pure redundant header space there. */}
              {back && (
                <button
                  type="button"
                  onClick={onHome}
                  aria-label="Home"
                  className="mb-3 hidden items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground sm:inline-flex"
                >
                  <span className="material-symbols-outlined text-sm">arrow_back</span>
                  Home
                </button>
              )}
              {/* Eyebrow is decorative only — first thing to go on a cramped phone header. */}
              {eyebrow && (
                <p className="hidden text-[11px] font-semibold uppercase tracking-[0.22em] text-gold sm:block">{eyebrow}</p>
              )}
              <h1 className="mt-1 truncate text-2xl font-extrabold sm:text-4xl">{title}</h1>
              {/* Long description eats header space on a phone where every row counts — only
                  shown from sm: up, matching the space it was designed for. */}
              {lead && <p className="mt-2 hidden max-w-xl text-sm text-muted-foreground sm:block">{lead}</p>}
            </div>
            <CornerMenu
              session={session}
              sendMsg={sendMsg}
              addListener={addListener}
              showProfile={showProfile}
              onProfileOpen={onProfileOpen}
            />
          </div>
          {action}
        </header>

        {children}
      </main>
    </div>
  );
}

export function Tile({ className = '', children }) {
  return <section className={`tile p-5 ${className}`}>{children}</section>;
}

export function TileLabel({ children }) {
  return <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{children}</p>;
}

const STAT_TONE_CLASSES = {
  default: 'bg-secondary text-secondary-foreground',
  gold: 'bg-gold-soft text-gold',
  success: 'bg-success-soft text-success',
  danger: 'bg-destructive-soft text-destructive',
  warning: 'bg-warning-soft text-warning',
}

export function Stat({ label, value, hint, tone = 'default', icon }) {
  return (
    <div className="tile grain flex flex-col gap-3 p-5">
      <div className="flex items-center justify-between gap-3">
        <TileLabel>{label}</TileLabel>
        {icon && (
          <span className={`grid size-8 shrink-0 place-items-center rounded-xl ${STAT_TONE_CLASSES[tone]}`}>
            {icon}
          </span>
        )}
      </div>
      <p className="num text-3xl font-extrabold">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function Bar({ value, tone = 'gold' }) {
  const bg = tone === 'gold' ? 'bg-[image:var(--gradient-gold)]' : tone === 'success' ? 'bg-success' : 'bg-destructive'
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-secondary">
      <div className={`h-full rounded-full transition-[width] duration-700 ${bg}`} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  )
}
