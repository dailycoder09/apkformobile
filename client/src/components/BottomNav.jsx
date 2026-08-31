const NAV_ITEMS = [
  {
    value: null,
    key: 'home',
    label: 'Home',
    icon: (
      <path d="M4 11.5 12 4l8 7.5M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" />
    ),
  },
  {
    value: 'namaz',
    key: 'namaz',
    label: 'Namaz',
    icon: (
      <path d="M15.5 4.5A7.5 7.5 0 1 0 19.5 17a8.5 8.5 0 0 1-4-12.5Z" />
    ),
  },
  {
    value: 'workout',
    key: 'workout',
    label: 'Workout',
    icon: (
      <path d="M6.5 8.5v7M4 10v4M17.5 8.5v7M20 10v4M8 12h8" />
    ),
  },
  {
    value: 'messages',
    key: 'chat',
    label: 'Chat',
    icon: (
      <path d="M4 5h16v10H8l-4 4V5Z" />
    ),
  },
  {
    value: 'transactions',
    key: 'finance',
    label: 'Finance',
    icon: (
      <path d="M3 7a2 2 0 0 1 2-2h13a1 1 0 0 1 1 1v2H5m-2-1v11a2 2 0 0 0 2 2h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5a2 2 0 0 1-2-2Zm13 7h2" />
    ),
  },
  {
    value: 'khatabook',
    key: 'khatabook',
    label: 'Khatabook',
    icon: (
      <path d="M4 5.5c2-1 5-1 7.5 1.2v10.8c-2.5-2-5.5-2-7.5-1V5.5ZM19.5 5.5c-2-1-5-1-7.5 1.2v10.8c2.5-2 5.5-2 7.5-1V5.5Z" />
    ),
  },
  {
    value: 'milestone',
    key: 'milestone',
    label: 'Milestones',
    icon: (
      <path d="M6 4v16M6 4h11l-2.5 4L17 12H6" />
    ),
  },
  {
    value: 'health',
    key: 'health',
    label: 'Health',
    icon: (
      <path d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z" />
    ),
  },
  {
    value: 'journal',
    key: 'journal',
    label: 'Journal',
    icon: (
      <path d="M6 4h10a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm0 0v16M9 8.5h5M9 12h5M9 15.5h3" />
    ),
  },
  // Profile intentionally lives outside the bottom nav — it's a persistent top-corner
  // avatar button (see ProfileTrigger.jsx, mounted at the App root) instead, matching
  // the account-access placement convention of most dashboard-style apps.
]

export default function BottomNav({ active, onNavigate }) {
  return (
    <nav className="bottom-nav-shell flex shrink-0 justify-center px-4 py-2.5" style={{ paddingBottom: 'max(10px, env(safe-area-inset-bottom))' }}>
      <div className="flex items-center gap-1 rounded-full border border-border/70 bg-popover/85 p-1.5 shadow-[var(--shadow-lift)] backdrop-blur-xl">
        {NAV_ITEMS.map((item) => {
          const isActive = item.value === active || (item.value === 'khatabook' && active === 'khatabook-app')
          return (
            <button
              key={item.key}
              type="button"
              onClick={() => onNavigate(item.value)}
              aria-label={item.label}
              title={item.label}
              className={`flex size-[38px] items-center justify-center rounded-full transition-colors duration-150 active:scale-90 ${
                isActive ? 'bg-[image:var(--gradient-gold)] text-accent-foreground' : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              <svg
                className="size-5 shrink-0"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {item.icon}
              </svg>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
