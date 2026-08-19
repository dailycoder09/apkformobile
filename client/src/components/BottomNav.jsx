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
    value: 'profile',
    key: 'profile',
    label: 'Profile',
    icon: (
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0" />
    ),
  },
]

export default function BottomNav({ active, onNavigate }) {
  return (
    <nav className="bottom-nav">
      <div className="bottom-nav-pill">
        {NAV_ITEMS.map((item) => {
          const isActive = item.value === active
          return (
            <button
              key={item.key}
              type="button"
              className={`bottom-nav-btn${isActive ? ' active' : ''}`}
              onClick={() => onNavigate(item.value)}
              aria-label={item.label}
              title={item.label}
            >
              <svg
                className="bottom-nav-icon"
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
