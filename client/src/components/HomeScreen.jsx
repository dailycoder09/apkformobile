const TILES = [
  { key: 'messages', icon: 'chat', label: 'Messages', desc: 'Family chat & files', accent: 'var(--browse-indigo)' },
  { key: 'transactions', icon: 'payments', label: 'Transactions', desc: 'Monitor family spending', accent: 'var(--txn-rose)' },
  { key: 'khatabook', icon: 'account_balance_wallet', label: 'Khatabook', desc: 'Family lend & borrow ledger', accent: 'var(--txn-rose)' },
  { key: 'browsing', icon: 'travel_explore', label: 'Browsing Activity', desc: 'Sites visited in Chrome', accent: 'var(--browse-indigo)' },
  { key: 'calllog', icon: 'call', label: 'Call Log', desc: 'Recent calls on the device', accent: 'var(--ink-muted)' },
  { key: 'milestone', icon: 'flag', label: 'Milestones', desc: 'Goals, streaks & progress', accent: 'var(--hub-accent)' },
]

export default function HomeScreen({ session, onSelect }) {
  return (
    <div className="home-screen">
      <span className="hub-meteors" aria-hidden="true">
        <i className="hub-meteor" style={{ left: '20%', animationDelay: '0s' }} />
        <i className="hub-meteor" style={{ left: '60%', animationDelay: '3.4s' }} />
        <i className="hub-meteor" style={{ left: '85%', animationDelay: '6.1s' }} />
      </span>

      <div className="home-header">
        <div className="home-avatar">{(session?.name || 'U')[0].toUpperCase()}</div>
        <div className="home-greeting">
          <span className="home-hi">Welcome back</span>
          <span className="home-name">{session?.name || 'User'}</span>
        </div>
        <span className="home-role-badge">Admin</span>
      </div>

      <div className="home-tiles">
        {TILES.map(t => (
          <button key={t.key} className="home-tile" onClick={() => onSelect(t.key)}>
            <span className="home-tile-icon-wrap" style={{ '--tile-accent': t.accent }}>
              <span className="material-symbols-outlined home-tile-icon">{t.icon}</span>
            </span>
            <span className="home-tile-label">{t.label}</span>
            <span className="home-tile-desc">{t.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
