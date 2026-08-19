import { useEffect } from 'react'

// Full-screen overlay for an incoming call, rendered from App.jsx whenever
// call.callState === 'incoming-ringing' — visible no matter what screen is open.
export default function IncomingCallModal({ call }) {
  const { peer, video, acceptCall, declineCall } = call

  useEffect(() => {
    if (!navigator.vibrate) return
    const pattern = [400, 200, 400, 1000]
    navigator.vibrate(pattern)
    const t = setInterval(() => navigator.vibrate(pattern), pattern.reduce((a, b) => a + b, 0))
    return () => { clearInterval(t); navigator.vibrate(0) }
  }, [])

  return (
    <div className="call-incoming-overlay">
      <div className="call-incoming-card">
        <div className="call-avatar call-avatar--lg">{peer?.name?.[0]?.toUpperCase() || '?'}</div>
        <h2 className="call-incoming-name">{peer?.name}</h2>
        <p className="call-incoming-sub">{video ? 'Incoming video call…' : 'Incoming voice call…'}</p>
        <div className="call-incoming-actions">
          <button type="button" className="call-round-btn call-round-btn--decline" onClick={declineCall} aria-label="Decline">
            <span className="material-symbols-outlined">call_end</span>
          </button>
          <button type="button" className="call-round-btn call-round-btn--accept" onClick={acceptCall} aria-label="Accept">
            <span className="material-symbols-outlined">call</span>
          </button>
        </div>
      </div>
    </div>
  )
}
