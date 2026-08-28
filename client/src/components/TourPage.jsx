import { useState } from 'react'

// Ported from the Lovable reference app's /welcome pages (src/routes/welcome*.tsx +
// components/app/LandingShell.tsx), consolidated into one component with local view state
// since this app has no router for separate pages. Stats describe real capabilities of
// each module rather than fabricated personal numbers (a tour page showing a fake "12-day
// streak" would read as real user data) - copy adapted from the reference's own wording.

const OVERVIEW_MODULES = [
  { key: 'namaz', icon: 'mosque', label: 'Prayer', body: 'Five daily prayers, on-time streaks and qada recovery.' },
  { key: 'transactions', icon: 'payments', label: 'Finance', body: 'Budgets, category splits and cashflow at a glance.' },
  { key: 'khatabook', icon: 'account_balance_wallet', label: 'Khata Book', body: 'Person-wise udhaar with a running balance you trust.' },
  { key: 'milestone', icon: 'flag', label: 'Milestones', body: 'Challenges, daily focus tasks and a motivation score.' },
  { key: 'workout', icon: 'fitness_center', label: 'Workout', body: 'Log sessions and track minutes against a daily goal.' },
]

const OVERVIEW_STATS = [
  { value: '5', label: 'Modules in one app' },
  { value: '7d', label: 'History shown on your home tiles' },
  { value: '3', label: 'Live charts on your dashboard' },
  { value: '0', label: 'Setup steps to start' },
]

const OVERVIEW_FEATURES = [
  { icon: 'grid_view', title: 'Bento home', body: 'Every module summarised as a live tile — prayer streak, budget burn, khata balance and your top milestone.' },
  { icon: 'monitoring', title: 'Charts that answer questions', body: 'Trends, donuts and weekday bars sized for a phone, built from your real data as it happens.' },
  { icon: 'wb_twilight', title: 'Built around the day', body: 'Today’s prayers, today’s spend and today’s tasks sit above everything else.' },
]

// Per-module detail pages, one per key in OVERVIEW_MODULES (workout has no reference
// counterpart - a short original page instead of a port). Exported so a module's own
// entry point (e.g. KhatabookPanel's slot in App.jsx) can gate straight into its landing
// page via <ModuleTourDetail> below, without going through the Tour's own overview first.
export const MODULE_TOURS = {
  namaz: {
    eyebrow: 'Module 01 · Prayer',
    title: 'Never guess when the next salah is, or how last month really went.',
    lead: 'A next-prayer countdown, a month calendar with a mark per prayer, streaks, and an honest qada tracker you can actually clear.',
    ctaLabel: 'Open prayer tracker',
    stats: [
      { value: '5', label: 'Prayers logged daily' },
      { value: '4', label: 'Statuses: on time, late, qada, missed' },
      { value: '35d', label: 'Rolling history kept' },
      { value: '1', label: 'Tap to mark a prayer' },
    ],
    features: [
      { icon: 'calendar_clock', title: 'Next prayer countdown', body: 'A gold progress ring counts down to the next salah with the Hijri date beside it.' },
      { icon: 'calendar_month', title: 'Month calendar', body: 'Marks per day — done, kaza or missed. A whole month reads in one glance.' },
      { icon: 'local_fire_department', title: 'Streaks that motivate', body: 'Current and best streak sit up top, so a good run is the thing you protect.' },
      { icon: 'schedule', title: 'Qada tracker', body: 'Count what you owe, log missed prayers across a date range, and tick them off per salah.' },
      { icon: 'pie_chart', title: 'Detailed analytics', body: 'On-time rate, weekday consistency, and a daily heatmap of your prayer history.' },
      { icon: 'menu_book', title: 'A gentle reminder', body: 'Each visit closes with a short ayah or hadith — the point is consistency, not the numbers.' },
    ],
  },
  transactions: {
    eyebrow: 'Module 02 · Finance',
    title: 'Know exactly where the month went, before the month ends.',
    lead: 'A budget meter that warns early, category splits that explain the damage, and a transaction feed you can actually skim.',
    ctaLabel: 'Open finance',
    stats: [
      { value: '1', label: 'Monthly budget meter' },
      { value: '10+', label: 'Spending categories' },
      { value: '6mo', label: 'Trend history' },
      { value: '₹', label: 'Indian rupee formatting throughout' },
    ],
    features: [
      { icon: 'target', title: 'Budget burn', body: 'A single bar tells you how much of the month budget is gone and whether you are ahead of pace.' },
      { icon: 'pie_chart', title: 'Category donut', body: 'Food, shopping, transport, bills — see the split instantly instead of scrolling a list.' },
      { icon: 'trending_up', title: 'Spending vs income', body: 'An area chart of income against spend shows whether the gap is widening or closing.' },
      { icon: 'receipt_long', title: 'Transaction feed', body: 'Every entry with amount, category and date, colour-coded for money in and out.' },
      { icon: 'filter_alt', title: 'Quick filters and search', body: 'Narrow the feed by category, bank or date range in a couple of taps.' },
      { icon: 'account_balance_wallet', title: 'Ties into Khata', body: 'Personal spending stays separate from money you have lent — no mixed-up totals.' },
    ],
  },
  khatabook: {
    eyebrow: 'Module 03 · Khata Book',
    title: 'Udhaar without arguments. Every rupee, per person, in order.',
    lead: 'Open an account for each person, log what you gave and got, and the balance updates itself — plus a net position across everyone.',
    ctaLabel: 'Open khata book',
    stats: [
      { value: '∞', label: 'Parties you can track' },
      { value: '2', label: 'Entry types: gave and got' },
      { value: '1', label: 'Net position across all accounts' },
      { value: '0', label: 'Manual math required' },
    ],
    features: [
      { icon: 'group', title: 'Person-wise accounts', body: 'Each party gets a card with last activity, entry count and the current balance.' },
      { icon: 'balance', title: 'Running balance', body: 'Gave and got net out automatically, so the number on screen is the number to settle.' },
      { icon: 'call_received', title: 'Receivables at a glance', body: 'See exactly how much is owed to you and by how many people.' },
      { icon: 'call_made', title: 'Payables too', body: 'What you owe is tracked the same way, so nothing gets forgotten.' },
      { icon: 'bar_chart', title: 'Given vs got history', body: 'A monthly chart of lending activity to spot the months you overextended.' },
      { icon: 'menu_book', title: 'Settled stays visible', body: 'Closed accounts are marked settled rather than deleted, so the history survives.' },
    ],
  },
  milestone: {
    eyebrow: 'Module 04 · Milestones',
    title: 'Small daily improvements, stacked until they are obvious.',
    lead: 'Pick a challenge, tick a couple of tasks a day, and let the progress ring, streak and motivation score carry you through the boring middle.',
    ctaLabel: 'Open milestones',
    stats: [
      { value: '6', label: 'Ready-made challenge templates' },
      { value: '∞', label: 'Custom challenge lengths' },
      { value: '1', label: 'Streak freeze per goal' },
      { value: '100', label: 'Point motivation score' },
    ],
    features: [
      { icon: 'flag', title: 'Multi-day challenges', body: 'Any length you choose, with a day count and a percentage that only moves when you show up.' },
      { icon: 'checklist', title: 'Today’s focus tasks', body: 'A handful of concrete tasks per day, planned upfront for the whole challenge.' },
      { icon: 'speed', title: 'Motivation score', body: 'Blends streak length and task completion into one honest number.' },
      { icon: 'local_fire_department', title: 'Streaks with a safety net', body: 'Current and best streak stay visible, with one streak freeze per goal for a bad day.' },
      { icon: 'calendar_view_month', title: 'Completion trend', body: 'A rolling chart of how much of each day you actually finished.' },
      { icon: 'emoji_events', title: 'Badges and history', body: 'Completed and archived challenges stay in the list as proof, ready to run again.' },
    ],
  },
  workout: {
    eyebrow: 'Module 05 · Workout',
    title: 'A minute logged is a minute that counts.',
    lead: 'Log a session, watch it stack up against a daily goal, and see it reflected on your home dashboard right away.',
    ctaLabel: 'Open workout',
    stats: [
      { value: '1', label: 'Tap to log a session' },
      { value: '30m', label: 'Default daily goal' },
      { value: '1', label: 'Live tile on your dashboard' },
    ],
    features: [
      { icon: 'fitness_center', title: 'Quick logging', body: 'Log minutes for a session without filling out a whole workout plan.' },
      { icon: 'speed', title: 'Daily goal tracking', body: 'See how today stacks up against your target, right on the home dashboard.' },
    ],
  },
}

function ModuleGrid({ onSelect, onOpenTour }) {
  return (
    <section className="grid grid-cols-1 gap-4 stagger sm:grid-cols-2">
      {OVERVIEW_MODULES.map(m => (
        <button
          key={m.key}
          type="button"
          onClick={() => (onOpenTour ? onOpenTour(m.key) : onSelect(m.key))}
          className="tile flex min-w-0 items-center gap-4 p-5 text-left transition-transform hover:-translate-y-1"
        >
          <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold">
            <span className="material-symbols-outlined text-xl">{m.icon}</span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-bold text-foreground">{m.label}</span>
            <span className="block text-sm text-muted-foreground">{m.body}</span>
          </span>
          <span className="material-symbols-outlined shrink-0 text-lg text-muted-foreground">arrow_forward</span>
        </button>
      ))}
    </section>
  )
}

function TourNavPills({ active, onOverview, onModule }) {
  return (
    <nav className="mt-6 flex flex-wrap gap-2">
      <button
        type="button"
        onClick={onOverview}
        className={`rounded-full border border-border px-4 py-2 text-xs font-semibold transition-colors ${
          active === null ? 'bg-gold-soft text-gold' : 'bg-card text-foreground hover:bg-secondary'
        }`}
      >
        Overview
      </button>
      {OVERVIEW_MODULES.map(m => (
        <button
          key={m.key}
          type="button"
          onClick={() => onModule(m.key)}
          className={`rounded-full border border-border px-4 py-2 text-xs font-semibold transition-colors ${
            active === m.key ? 'bg-gold-soft text-gold' : 'bg-card text-foreground hover:bg-secondary'
          }`}
        >
          {m.label}
        </button>
      ))}
    </nav>
  )
}

// A single module's landing/intro page — ported from the reference's LandingShell.tsx +
// welcome.*.tsx pages, extracted as its own standalone component (rather than only living
// inside TourPage's internal state machine) so a module's own entry point can gate straight
// into its landing page - see KhatabookPanel's slot in App.jsx, which shows this before the
// real KhatabookPanel the first time a session opens Khatabook. `children` (optional) lets
// a caller append extra content below the closing CTA, e.g. TourPage appends its cross-tour
// nav pills; the standalone gate use case renders none.
export function ModuleTourDetail({ tour, onBack, backLabel = 'Back', onOpen, children }) {
  return (
    <div className="dashboard relative h-full overflow-y-auto overflow-x-hidden surface-sand font-sans">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-44 right-0 size-[220px] rounded-full bg-[image:var(--gradient-gold)] opacity-25 blur-3xl animate-float sm:-right-32 sm:size-[560px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-[26rem] left-0 size-[180px] rounded-full bg-clay opacity-20 blur-3xl animate-float sm:-left-40 sm:top-[34rem] sm:size-[440px]"
        style={{ animationDelay: '1.6s' }}
      />

      <main className="relative mx-auto w-full max-w-6xl px-4 pt-8 pb-28 sm:px-6">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          {backLabel}
        </button>

        <section className="mt-6 animate-fade-up">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-gold-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
            <span className="material-symbols-outlined text-sm">auto_awesome</span>
            {tour.eyebrow}
          </span>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-extrabold leading-[1.05] text-foreground sm:text-6xl">
            {tour.title}
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg">{tour.lead}</p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onOpen}
              className="inline-flex items-center gap-2 rounded-2xl bg-[image:var(--gradient-gold)] px-5 py-3 text-sm font-semibold text-white shadow-[var(--shadow-glow)] transition-transform hover:scale-[1.03]"
            >
              {tour.ctaLabel}
              <span className="material-symbols-outlined text-lg">arrow_forward</span>
            </button>
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 rounded-2xl border border-border bg-card px-5 py-3 text-sm font-semibold text-foreground transition-colors hover:bg-secondary"
            >
              Explore all modules
            </button>
          </div>
        </section>

        <section className="mt-10 grid grid-cols-2 gap-4 stagger sm:grid-cols-4">
          {tour.stats.map(s => (
            <div key={s.label} className="tile grain min-w-0 p-5">
              <p className="num text-3xl font-extrabold text-gold">{s.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </section>

        <section className="mt-6 grid grid-cols-1 gap-4 stagger sm:grid-cols-2 lg:grid-cols-3">
          {tour.features.map(f => (
            <article key={f.title} className="tile flex min-w-0 flex-col gap-3 p-5 transition-transform hover:-translate-y-1">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold">
                <span className="material-symbols-outlined text-xl">{f.icon}</span>
              </span>
              <h2 className="text-lg font-bold text-foreground">{f.title}</h2>
              <p className="text-sm text-muted-foreground">{f.body}</p>
            </article>
          ))}
        </section>

        <section className="tile grain mt-6 flex min-w-0 flex-col items-start gap-4 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl font-extrabold text-foreground">Ready when you are.</h2>
            <p className="mt-1 text-sm text-muted-foreground">Everything above is your own real data, updating as you go.</p>
          </div>
          <button
            type="button"
            onClick={onOpen}
            className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-foreground px-5 py-3 text-sm font-semibold text-background transition-transform hover:scale-[1.03]"
          >
            {tour.ctaLabel}
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
          </button>
        </section>

        {children}
      </main>
    </div>
  )
}

export default function TourPage({ onHome, onSelect }) {
  const [detail, setDetail] = useState(null) // null = overview, or a module key from MODULE_TOURS

  const tour = detail ? MODULE_TOURS[detail] : null

  if (detail) {
    return (
      <ModuleTourDetail
        tour={tour}
        onBack={() => setDetail(null)}
        backLabel="Tour overview"
        onOpen={() => onSelect(detail === 'khatabook' ? 'khatabook-app' : detail)}
      >
        <TourNavPills active={detail} onOverview={() => setDetail(null)} onModule={setDetail} />
      </ModuleTourDetail>
    )
  }

  return (
    <div className="dashboard relative h-full overflow-y-auto overflow-x-hidden surface-sand font-sans">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-44 right-0 size-[220px] rounded-full bg-[image:var(--gradient-gold)] opacity-25 blur-3xl animate-float sm:-right-32 sm:size-[560px]"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute top-[26rem] left-0 size-[180px] rounded-full bg-clay opacity-20 blur-3xl animate-float sm:-left-40 sm:top-[34rem] sm:size-[440px]"
        style={{ animationDelay: '1.6s' }}
      />

      <main className="relative mx-auto w-full max-w-6xl px-4 pt-8 pb-28 sm:px-6">
        <button
          type="button"
          onClick={onHome}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        >
          <span className="material-symbols-outlined text-sm">arrow_back</span>
          Home
        </button>

        <section className="mt-6 animate-fade-up">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-gold-soft px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-gold">
            <span className="material-symbols-outlined text-sm">auto_awesome</span>
            The Tour
          </span>
          <h1 className="mt-4 max-w-3xl font-display text-4xl font-extrabold leading-[1.05] text-foreground sm:text-6xl">
            Your prayers, your money and your habits &mdash; one quiet dashboard.
          </h1>
          <p className="mt-4 max-w-2xl text-base text-muted-foreground sm:text-lg">
            Modules that usually live in separate apps, stitched into a single bento home
            with charts, streaks and gentle nudges built from your real data.
          </p>
          <div className="mt-7 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={onHome}
              className="inline-flex items-center gap-2 rounded-2xl bg-[image:var(--gradient-gold)] px-5 py-3 text-sm font-semibold text-white shadow-[var(--shadow-glow)] transition-transform hover:scale-[1.03]"
            >
              Open dashboard
              <span className="material-symbols-outlined text-lg">arrow_forward</span>
            </button>
          </div>
        </section>

        <section className="mt-10 grid grid-cols-2 gap-4 stagger sm:grid-cols-4">
          {OVERVIEW_STATS.map(s => (
            <div key={s.label} className="tile grain min-w-0 p-5">
              <p className="num text-3xl font-extrabold text-gold">{s.value}</p>
              <p className="mt-1 text-xs text-muted-foreground">{s.label}</p>
            </div>
          ))}
        </section>

        <section className="mt-6 grid grid-cols-1 gap-4 stagger sm:grid-cols-2 lg:grid-cols-3">
          {OVERVIEW_FEATURES.map(f => (
            <article key={f.title} className="tile flex min-w-0 flex-col gap-3 p-5 transition-transform hover:-translate-y-1">
              <span className="grid size-10 shrink-0 place-items-center rounded-2xl bg-gold-soft text-gold">
                <span className="material-symbols-outlined text-xl">{f.icon}</span>
              </span>
              <h2 className="text-lg font-bold text-foreground">{f.title}</h2>
              <p className="text-sm text-muted-foreground">{f.body}</p>
            </article>
          ))}
        </section>

        <h2 className="mb-4 mt-10 font-display text-xl font-bold text-foreground">Explore the modules</h2>
        <ModuleGrid onOpenTour={setDetail} />

        <section className="tile grain mt-6 flex min-w-0 flex-col items-start gap-4 p-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h2 className="text-2xl font-extrabold text-foreground">Ready when you are.</h2>
            <p className="mt-1 text-sm text-muted-foreground">Everything above is your own real data, updating as you go.</p>
          </div>
          <button
            type="button"
            onClick={onHome}
            className="inline-flex shrink-0 items-center gap-2 rounded-2xl bg-foreground px-5 py-3 text-sm font-semibold text-background transition-transform hover:scale-[1.03]"
          >
            Open dashboard
            <span className="material-symbols-outlined text-lg">arrow_forward</span>
          </button>
        </section>

        <TourNavPills active={null} onOverview={() => setDetail(null)} onModule={setDetail} />
      </main>
    </div>
  )
}
