import { useState } from 'react'

// Server URL baked in at build time — child just enters their name
const SERVER_URL = 'http://localhost:3001'

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
        <div className="login-card-inner">
          <div className="login-logo" />
          <h1 className="login-title">meeee</h1>
          <p className="login-subtitle">Stay connected</p>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
              <input
                id="login-name"
                className="login-input"
                type="text"
                placeholder=" "
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={30}
                autoFocus
                required
              />
              <label htmlFor="login-name" className="login-label">Your name</label>
            </div>

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
    </div>
  )
}
