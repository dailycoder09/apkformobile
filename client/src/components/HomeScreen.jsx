const TILES = [
  { key: 'messages', icon: '💬', label: 'Messages', desc: 'Family chat & files' },
  { key: 'transactions', icon: '💰', label: 'Transactions', desc: 'Monitor family spending' },
  { key: 'browsing', icon: '🌐', label: 'Browsing Activity', desc: 'Sites visited in Chrome' },
  { key: 'calllog', icon: '📞', label: 'Call Log', desc: 'Recent calls on the device' },
]

export default function HomeScreen({ session, onSelect }) {
  return (
    <div className="home-screen">
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
            <span className="home-tile-icon-wrap">
              <span className="home-tile-icon">{t.icon}</span>
            </span>
            <span className="home-tile-label">{t.label}</span>
            <span className="home-tile-desc">{t.desc}</span>
          </button>
        ))}
      </div>
    </div>
  )
}
