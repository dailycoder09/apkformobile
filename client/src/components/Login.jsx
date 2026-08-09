import { useState } from 'react'

// Server URL baked in at build time — child just enters their name
const SERVER_URL = 'https://familywatch.duckdns.org'

export default function Login({ onLogin, status, error }) {
  const [name, setName] = useState('')

  const busy = status === 'connecting'

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    localStorage.setItem('meeee_server', SERVER_URL)
    onLogin('user', name.trim(), '', SERVER_URL)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-logo">💬</div>
        <h1 className="login-title">meeee</h1>
        <p className="login-subtitle">Stay connected</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <input
            className="login-input"
            type="text"
            placeholder="Your name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={30}
            autoFocus
            required
          />

          {error && <div className="login-error">{error}</div>}

          <button
            type="submit"
            className="login-btn"
            disabled={busy || !name.trim()}
          >
            {busy ? 'Connecting…' : 'Get Started'}
          </button>
        </form>
      </div>
    </div>
  )
}
