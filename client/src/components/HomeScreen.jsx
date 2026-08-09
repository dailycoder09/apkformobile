export default function HomeScreen({ session, onSelect }) {
  const isAdmin = session?.role === 'admin'

  return (
    <div className="home-screen">
      <div className="home-header">
        <div className="home-avatar">{(session?.name || 'U')[0].toUpperCase()}</div>
        <div className="home-greeting">
          <span className="home-hi">Welcome back</span>
          <span className="home-name">{session?.name || 'User'}</span>
        </div>
        {isAdmin && <span className="home-role-badge">Admin</span>}
      </div>

      <div className="home-tiles">
        <button className="home-tile" onClick={() => onSelect('messages')}>
          <span className="home-tile-icon">💬</span>
          <span className="home-tile-label">Messages</span>
          <span className="home-tile-desc">Family chat &amp; files</span>
        </button>

        <button className="home-tile" onClick={() => onSelect('transactions')}>
          <span className="home-tile-icon">💰</span>
          <span className="home-tile-label">Transactions</span>
          <span className="home-tile-desc">{isAdmin ? 'Monitor family spending' : 'Track your spending'}</span>
        </button>
      </div>
    </div>
  )
}
