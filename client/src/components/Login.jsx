import { useState } from 'react'
import { Capacitor } from '@capacitor/core'

const IS_NATIVE = Capacitor.isNativePlatform()

export default function Login({ onLogin, status }) {
  const [name, setName]           = useState('')
  const [serverUrl, setServerUrl] = useState(() => localStorage.getItem('meeee_server') || '')

  const busy = status === 'connecting'

  const handleSubmit = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    if (IS_NATIVE && !serverUrl.trim()) return
    if (serverUrl.trim()) localStorage.setItem('meeee_server', serverUrl.trim())
    onLogin('user', name.trim(), '', serverUrl.trim())
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

          {/* Server URL only shown on native APK */}
          {IS_NATIVE && (
            <input
              className="login-input"
              type="url"
              placeholder="Server URL (wss://…)"
              value={serverUrl}
              onChange={(e) => setServerUrl(e.target.value)}
              required
            />
          )}

          <button
            type="submit"
            className="login-btn"
            disabled={busy || !name.trim() || (IS_NATIVE && !serverUrl.trim())}
          >
            {busy ? 'Connecting…' : 'Get Started'}
          </button>
        </form>
      </div>
    </div>
  )
}
