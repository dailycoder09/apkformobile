import { useEffect, useState } from 'react'
import { FirebaseAuthentication } from '@capacitor-firebase/authentication'

// Server URL baked in at build time — child just enters their name. Falls back to
// the current origin when served from localhost, so local dev/testing talks to the
// local server instead of production.
const SERVER_URL = window.location.hostname === 'localhost'
  ? window.location.origin
  : 'https://familywatch.duckdns.org'

const PHONE_RE = /^\+[1-9]\d{6,14}$/ // E.164: + country code + number

// Multi-step registration for the `role: 'user'` (child) path:
//   1. phone  — enter phone number, trigger Firebase phone sign-in
//   2. otp    — enter the SMS code sent by Firebase
//   3. name   — cosmetic display name (same field as before, just moved after verification)
// The admin PIN path never touches this component — it's handled entirely via the
// `?pin=` URL param in App.jsx.
// On localhost, skip straight to the name step — no real phone/OTP round-trip, paired
// with the matching DEV_AUTH_BYPASS=true server-side flag for local testing only.
const isLocalDev = window.location.hostname === 'localhost'

export default function Login({ onLogin, status, error: connectError }) {
  const [step, setStep] = useState(isLocalDev ? 'name' : 'phone')
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
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
        </div>
      </div>
    </div>
  )
}
