import CornerMenu from './CornerMenu'

const TILES = [
  { key: 'messages', icon: 'chat', label: 'Messages', desc: 'Family chat & files', iconBg: 'bg-secondary', iconFg: 'text-foreground' },
  { key: 'transactions', icon: 'payments', label: 'Transactions', desc: 'Monitor family spending', iconBg: 'bg-destructive-soft', iconFg: 'text-destructive' },
  { key: 'khatabook', icon: 'account_balance_wallet', label: 'Khatabook', desc: 'Family lend & borrow ledger', iconBg: 'bg-destructive-soft', iconFg: 'text-destructive' },
  { key: 'browsing', icon: 'travel_explore', label: 'Browsing Activity', desc: 'Sites visited in Chrome', iconBg: 'bg-secondary', iconFg: 'text-foreground' },
  { key: 'calllog', icon: 'call', label: 'Call Log', desc: 'Recent calls on the device', iconBg: 'bg-secondary', iconFg: 'text-foreground' },
  { key: 'milestone', icon: 'flag', label: 'Milestones', desc: 'Goals, streaks & progress', iconBg: 'bg-gold-soft', iconFg: 'text-gold' },
  { key: 'health', icon: 'medical_services', label: 'Health', desc: 'Illnesses, treatments & recovery', iconBg: 'bg-success-soft', iconFg: 'text-success' },
]

export default function HomeScreen({ session, onSelect, sendMsg, addListener, showProfile, onProfileOpen }) {
  return (
    <div className="home-screen relative h-full overflow-y-auto overflow-x-hidden surface-sand font-sans">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-32 right-0 size-[220px] rounded-full bg-[image:var(--gradient-gold)] opacity-25 blur-3xl animate-float sm:-top-40 sm:-right-24 sm:size-[420px]"
      />

      <main className="relative mx-auto w-full max-w-xl px-4 pt-10 pb-10">
        <div className="mb-8 flex animate-fade-up items-center gap-3.5">
          <div className="grid size-[52px] shrink-0 place-items-center rounded-full bg-[image:var(--gradient-gold)] text-lg font-bold text-white shadow-[var(--shadow-glow)]">
            {(session?.name || 'U')[0].toUpperCase()}
          </div>
          <div className="flex flex-col">
            <span className="text-[13px] text-muted-foreground">Welcome back</span>
            <span className="font-display text-xl font-extrabold text-foreground">{session?.name || 'User'}</span>
          </div>
          <span className="ml-auto shrink-0 rounded-full bg-[image:var(--gradient-gold)] px-3 py-1 text-[11px] font-bold text-white shadow-[var(--shadow-glow)]">
            Admin
          </span>
          <CornerMenu
            session={session}
            sendMsg={sendMsg}
            addListener={addListener}
            showProfile={showProfile}
            onProfileOpen={onProfileOpen}
          />
        </div>

        <div className="grid grid-cols-2 gap-4 stagger">
          {TILES.map(t => (
            <button
              key={t.key}
              type="button"
              onClick={() => onSelect(t.key)}
              className="tile grain flex min-h-[152px] flex-col items-center gap-2.5 p-5 text-center"
            >
              <span className={`grid size-12 shrink-0 place-items-center rounded-2xl ${t.iconBg} ${t.iconFg}`}>
                <span className="material-symbols-outlined text-2xl">{t.icon}</span>
              </span>
              <span className="text-[15px] font-bold text-foreground">{t.label}</span>
              <span className="text-[11.5px] text-muted-foreground">{t.desc}</span>
            </button>
          ))}
        </div>
      </main>
    </div>
  )
}
