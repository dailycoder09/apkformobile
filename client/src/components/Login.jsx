import { useState } from 'react'

// One-time onboarding for this fully-offline, single-user app: no phone/OTP, no
// server-verified identity — just a display name, stored locally (see App.jsx's
// NAME_KEY) alongside the persisted device id (client/src/lib/localData.js's
// getDeviceId()) that everything else is keyed by.
export default function Login({ onLogin }) {
  const [name, setName] = useState('')

  const handleFinish = (e) => {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    onLogin(trimmed)
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card-inner">
          <div className="login-logo" />
          <h1 className="login-title">meeee</h1>
          <p className="login-subtitle">Prayers, money, ledgers and milestones — all on this device.</p>

          <form className="login-form" onSubmit={handleFinish}>
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

            <button type="submit" className="login-btn" disabled={!name.trim()}>
              Get Started
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
