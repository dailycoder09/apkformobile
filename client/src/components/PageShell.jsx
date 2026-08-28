// Shared page chrome ported from the reference app's PageShell.tsx - every
// Tailwind-scoped module page (Khatabook, Milestones, and eventually Prayer/Finance)
// wraps its content in this exact shell so headers, spacing, and the two decorative
// glow orbs stay identical across pages instead of each screen hand-rolling its own.
// Drops the reference's own bottom Dock (this app already mounts one global BottomNav
// in App.jsx) and its <Link to="/"> (this app navigates module screens via an onHome
// callback prop, not a router).

export function PageShell({ eyebrow, title, lead, action, onHome, back = true, children }) {
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

      <main className="relative mx-auto w-full max-w-6xl px-4 pt-10 pb-36 sm:px-6">
        {/* flex-col by default (not the reference's own grid-cols-[1fr_auto]) - that grid
            forces the title and action area side by side even on a narrow phone, which
            squeezes the title column so tight it truncates ("Milestones" -> "Mile...").
            Side-by-side only kicks in at sm: and up, where there's room for both. */}
        <header className="mb-8 flex flex-col gap-4 animate-fade-up sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            {back && (
              <button
                type="button"
                onClick={onHome}
                className="mb-3 inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <span className="material-symbols-outlined text-sm">arrow_back</span>
                Home
              </button>
            )}
            {eyebrow && (
              <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-gold">{eyebrow}</p>
            )}
            <h1 className="mt-1 truncate text-3xl font-extrabold sm:text-4xl">{title}</h1>
            {lead && <p className="mt-2 max-w-xl text-sm text-muted-foreground">{lead}</p>}
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
