import { useEffect, useState } from 'react'
import { PageShell, Tile, TileLabel } from './PageShell'
import FamilyBackupsScreen from './FamilyBackupsScreen'

// Same-origin in the browser, absolute host in the native app — same convention
// FamilyBackupsScreen.jsx/ProfilePage.jsx/CornerMenu.jsx each define locally.
function httpBase() {
  return (localStorage.getItem('meeee_server') || '').trim().replace(/\/$/, '')
}

const TOKEN_KEY = 'meeee_parent_token'

// Dedicated entry point for /parent — completely separate from the normal app's name
// entry/Dashboard flow (see App.jsx's path check). Anyone with the regular app link
// still gets the no-login family app exactly as before; only this specific path, and
// the parent-only backup controls behind it, requires proving you know the PIN. The
// PIN itself is verified server-side (server/index.js's /api/device-backup/parent-auth
// routes) — this component only handles the UI and storing the resulting token, it is
// not itself what makes any of this secure.
export default function ParentGate() {
  const [checking, setChecking] = useState(true)
  const [isSet, setIsSet] = useState(null) // null = still checking, true/false once known
  const [pin, setPin] = useState('')
  const [confirmPin, setConfirmPin] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || '')

  useEffect(() => {
    if (token) { setChecking(false); return }
    fetch(`${httpBase()}/api/device-backup/parent-auth`)
      .then((r) => r.json())
      .then((d) => setIsSet(!!d.isSet))
      .catch(() => setError('Could not reach the server.'))
      .finally(() => setChecking(false))
  }, [token])

  function handleTokenInvalid() {
    // A gated request came back 403 — the token is stale/wrong, clear it and bounce
    // back to PIN entry rather than leaving FamilyBackupsScreen stuck on failed fetches.
    localStorage.removeItem(TOKEN_KEY)
    setToken('')
  }

  async function handleSetup(e) {
    e.preventDefault()
    setError('')
    if (pin.length < 4) { setError('PIN must be at least 4 characters.'); return }
    if (pin !== confirmPin) { setError('PINs do not match.'); return }
    setSubmitting(true)
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/parent-auth/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (!res.ok) throw new Error(await res.text() || 'Could not set up the PIN.')
      const { token: newToken } = await res.json()
      localStorage.setItem(TOKEN_KEY, newToken)
      setToken(newToken)
    } catch (err) {
      setError(err.message || 'Could not set up the PIN.')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleLogin(e) {
    e.preventDefault()
    setError('')
    setSubmitting(true)
    try {
      const res = await fetch(`${httpBase()}/api/device-backup/parent-auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      })
      if (!res.ok) throw new Error(res.status === 403 ? 'Incorrect PIN.' : 'Could not log in.')
      const { token: newToken } = await res.json()
      localStorage.setItem(TOKEN_KEY, newToken)
      setToken(newToken)
    } catch (err) {
      setError(err.message || 'Could not log in.')
      setPin('')
    } finally {
      setSubmitting(false)
    }
  }

  if (token) {
    return <FamilyBackupsScreen onHome={() => {}} parentToken={token} onTokenInvalid={handleTokenInvalid} />
  }

  return (
    <div className="parent-gate-screen">
      <PageShell eyebrow="Family" title="Parent Access" lead="This link is for the parent only.">
        {error && (
          <p className="mb-4 rounded-2xl bg-destructive-soft px-4 py-3 text-sm font-medium text-destructive">{error}</p>
        )}
        <Tile>
          {checking ? (
            <p className="text-sm text-muted-foreground">Checking…</p>
          ) : isSet ? (
            <form onSubmit={handleLogin}>
              <TileLabel>Enter PIN</TileLabel>
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="PIN"
                className="mt-3 w-full rounded-2xl bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground"
              />
              <button
                type="submit"
                disabled={submitting || !pin}
                className="mt-3 w-full rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
              >
                {submitting ? 'Checking…' : 'Enter'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleSetup}>
              <TileLabel>Set up a parent PIN</TileLabel>
              <p className="mt-2 text-sm text-muted-foreground">
                No PIN has been set up yet for this family. Whoever sets one first becomes
                the parent — do this now if you haven't already, since anyone who reaches
                this page before a PIN exists can set it.
              </p>
              <input
                type="password"
                inputMode="numeric"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                placeholder="Choose a PIN (4+ characters)"
                className="mt-3 w-full rounded-2xl bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground"
              />
              <input
                type="password"
                inputMode="numeric"
                value={confirmPin}
                onChange={(e) => setConfirmPin(e.target.value)}
                placeholder="Confirm PIN"
                className="mt-3 w-full rounded-2xl bg-secondary px-4 py-3 text-sm font-medium text-secondary-foreground"
              />
              <button
                type="submit"
                disabled={submitting || !pin || !confirmPin}
                className="mt-3 w-full rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background disabled:opacity-50"
              >
                {submitting ? 'Setting up…' : 'Set PIN'}
              </button>
            </form>
          )}
        </Tile>
      </PageShell>
    </div>
  )
}
