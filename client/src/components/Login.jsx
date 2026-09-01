import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { FirebaseAuthentication } from '@capacitor-firebase/authentication'

// Capacitor's native WebView serves the bundled app at hostname "localhost" by
// default (a standard Capacitor convention, unrelated to actual local web dev) — so
// `window.location.hostname === 'localhost'` alone is TRUE both for a real browser
// dev server AND for the production APK running on a real phone. Every check below
// must exclude the native case explicitly, or the shipped app silently behaves like
// a local dev build: skipping real phone/OTP auth and pointing at a dead local
// WebView origin instead of the real production server. Native always means "real
// build talking to production," regardless of what the WebView's own hostname says.
const isRealLocalDev = window.location.hostname === 'localhost' && !Capacitor.isNativePlatform()

// Server URL baked in at build time — child just enters their name. Falls back to
// the current origin only for real local web dev; the native app always targets
// production regardless of its internal WebView hostname.
const SERVER_URL = isRealLocalDev
  ? window.location.origin
  : 'https://familywatch.duckdns.org'

const PHONE_RE = /^\+[1-9]\d{6,14}$/ // E.164: + country code + number

// Multi-step registration for the `role: 'user'` (child) path:
//   1. phone  — enter phone number, trigger Firebase phone sign-in
//   2. otp    — enter the SMS code sent by Firebase
//   3. name   — cosmetic display name (same field as before, just moved after verification)
// On real local web dev only, skip straight to the name step — no real phone/OTP
// round-trip, paired with the matching DEV_AUTH_BYPASS=true server-side flag for
// local testing only. Never true for the native app, even though its WebView also
// happens to report hostname "localhost" — see isRealLocalDev above.
const isLocalDev = isRealLocalDev

// Admin login lives at a separate path (/admin) rather than a link on the shared
// page, so a regular family member never even sees that an admin mode exists —
// previously an in-page "Log in as admin instead" toggle, which is more discoverable
// than this needs to be. The path itself carries no secret (unlike the old ?pin= URL
// param) — it's just which form renders; the PIN is still only ever typed into that
// form and sent over the authenticated WebSocket. server/index.js's static handler
// already falls back to index.html for any unmatched path, so /admin works in
// production with no server/nginx changes.
const isAdminPath = window.location.pathname === '/admin'
const initialStep = () => (isAdminPath ? 'adminPin' : isLocalDev ? 'name' : 'phone')

export default function Login({ onLogin, status, error: connectError }) {
  const [step, setStep] = useState(initialStep)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [pin, setPin] = useState('')
  const [verificationId, setVerificationId] = useState('')
  const [busy, setBusy] = useState(false)
  const [stepError, setStepError] = useState('')

  const busyConnecting = status === 'connecting'
  const error = stepError || connectError

  // Firebase delivers the verification id (and any failure) asynchronously via listeners
  // rather than as a return value from signInWithPhoneNumber.
  useEffect(() => {
    const sentHandle = FirebaseAuthentication.addListener('phoneCodeSent', (event) => {
      setVerificationId(event.verificationId)
      setBusy(false)
      setStep('otp')
    })
    const failedHandle = FirebaseAuthentication.addListener('phoneVerificationFailed', (event) => {
      setBusy(false)
      setStepError(event.message || 'Could not verify that phone number')
    })
    return () => {
      sentHandle.then((h) => h.remove())
      failedHandle.then((h) => h.remove())
    }
  }, [])

  const handleSendCode = async (e) => {
    e.preventDefault()
    const trimmed = phone.trim()
    if (!PHONE_RE.test(trimmed)) {
      setStepError('Enter your number as +<country code><number>, e.g. +16505550101')
      return
    }
    setStepError('')
    setBusy(true)
    try {
      await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: trimmed })
      // phoneCodeSent listener above moves us to the 'otp' step
    } catch (err) {
      setBusy(false)
      setStepError(err?.message || 'Could not send verification code')
    }
  }

  const handleResendCode = async () => {
    setStepError('')
    setBusy(true)
    try {
      await FirebaseAuthentication.signInWithPhoneNumber({ phoneNumber: phone.trim(), resendCode: true })
    } catch (err) {
      setBusy(false)
      setStepError(err?.message || 'Could not resend code')
    }
  }

  const handleVerifyCode = async (e) => {
    e.preventDefault()
    if (code.trim().length < 4) return
    setStepError('')
    setBusy(true)
    try {
      await FirebaseAuthentication.confirmVerificationCode({
        verificationId,
        verificationCode: code.trim(),
      })
      setBusy(false)
      setStep('name')
    } catch (err) {
      setBusy(false)
      setStepError(err?.message || 'That code didn’t match — try again')
    }
  }

  const handleFinish = (e) => {
    e.preventDefault()
    if (!name.trim()) return
    localStorage.setItem('meeee_server', SERVER_URL)
    localStorage.setItem('meeee_name', name.trim())
    // The fresh Firebase ID token is fetched by App.jsx right before it opens the
    // WebSocket — no need to plumb it through here.
    onLogin('user', name.trim(), '', SERVER_URL)
  }

  // Same auth payload the old ?pin= URL param used to trigger automatically
  // (App.jsx's login('admin', '', pin, '')) — only the entry point changed, not the
  // underlying auth: the PIN still only ever travels over the authenticated WebSocket
  // connection, never as part of a URL, so it can't end up in browser history, a
  // shared link, or a server access log.
  const handleAdminLogin = (e) => {
    e.preventDefault()
    if (!pin.trim()) return
    onLogin('admin', '', pin.trim(), '')
  }

  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card-inner">
          <div className="login-logo" />
          <h1 className="login-title">meeee</h1>
          <p className="login-subtitle">Stay connected</p>

          {step === 'phone' && (
            <form className="login-form" onSubmit={handleSendCode}>
              <div className="login-field">
                <input
                  id="login-phone"
                  className="login-input"
                  type="tel"
                  placeholder=" "
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  maxLength={16}
                  autoFocus
                  required
                />
                <label htmlFor="login-phone" className="login-label">Phone number (+countrycode)</label>
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="login-btn" disabled={busy || !phone.trim()}>
                {busy ? 'Sending code…' : 'Send code'}
              </button>
            </form>
          )}

          {step === 'otp' && (
            <form className="login-form" onSubmit={handleVerifyCode}>
              <p className="login-step-hint">Enter the code sent to {phone.trim()}</p>
              <div className="login-field">
                <input
                  id="login-otp"
                  className="login-input"
                  type="text"
                  inputMode="numeric"
                  placeholder=" "
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  maxLength={8}
                  autoFocus
                  required
                />
                <label htmlFor="login-otp" className="login-label">Verification code</label>
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="login-btn" disabled={busy || code.trim().length < 4}>
                {busy ? 'Verifying…' : 'Verify'}
              </button>
              <button type="button" className="login-link-btn" onClick={handleResendCode} disabled={busy}>
                Resend code
              </button>
              <button
                type="button"
                className="login-link-btn"
                onClick={() => { setStep('phone'); setStepError(''); setCode('') }}
                disabled={busy}
              >
                Use a different number
              </button>
            </form>
          )}

          {step === 'name' && (
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

              {error && <div className="login-error">{error}</div>}

              <button
                type="submit"
                className="login-btn"
                disabled={busyConnecting || !name.trim()}
              >
                {busyConnecting ? 'Connecting…' : 'Get Started'}
              </button>
            </form>
          )}

          {step === 'adminPin' && (
            <form className="login-form" onSubmit={handleAdminLogin}>
              <div className="login-field">
                <input
                  id="login-pin"
                  className="login-input"
                  type="password"
                  inputMode="numeric"
                  placeholder=" "
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  maxLength={12}
                  autoFocus
                  required
                />
                <label htmlFor="login-pin" className="login-label">Admin PIN</label>
              </div>

              {error && <div className="login-error">{error}</div>}

              <button type="submit" className="login-btn" disabled={busyConnecting || !pin.trim()}>
                {busyConnecting ? 'Connecting…' : 'Log in'}
              </button>
              {/* Navigates to the actual path, not just a step change — this page is
                  reached via the separate /admin path, so "back" means leaving that
                  path entirely, not switching to a step that isAdminPath would just
                  re-render as 'adminPin' again. */}
              <a href="/" className="login-link-btn">Back</a>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}
