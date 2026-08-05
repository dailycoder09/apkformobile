import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import Login from './components/Login'
import AdminPanel from './components/AdminPanel'
import UserPanel from './components/UserPanel'
import InstallPrompt from './components/InstallPrompt'

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

export default function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [wsStatus, setWsStatus]   = useState('idle')
  const [session, setSession]     = useState(null)
  const [updateInfo, setUpdateInfo] = useState(null) // { apkUrl } if update available
  const wsRef          = useRef(null)
  const reconnectRef   = useRef(null)
  const authPayloadRef = useRef(null)
  const serverUrlRef   = useRef('')
  const listenersRef   = useRef([])

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

    const ws = new WebSocket(buildWsUrl(serverUrl || serverUrlRef.current))
    wsRef.current = ws

    ws.onopen = () => {
      setWsStatus('open')
      ws.send(JSON.stringify(payload))
    }

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'auth_ok') {
        setSession({ role: msg.role, userId: msg.userId, name: msg.name || 'Admin', initialUsers: msg.users || [] })
      } else if (msg.type === 'auth_fail') {
        alert(msg.reason || 'Authentication failed')
        ws.close()
        setWsStatus('idle')
        return
      }
      listenersRef.current.forEach((fn) => fn(msg))
    }

    ws.onclose = () => {
      setWsStatus('closed')
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
  }, [])

  const sendMsg = useCallback((msg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg))
    }
  }, [])

  const addListener = useCallback((fn) => {
    listenersRef.current.push(fn)
    return () => { listenersRef.current = listenersRef.current.filter((f) => f !== fn) }
  }, [])

  const handleInstall = () => {
    deferredPrompt.prompt()
    deferredPrompt.userChoice.then(() => setDeferredPrompt(null))
  }

  // If ?pin= in URL, show nothing while auto-connecting
  const autoPin = getPinFromUrl()

  return (
    <div className="app">
      {updateInfo && (
        <UpdateBanner apkUrl={updateInfo.apkUrl} onDismiss={() => setUpdateInfo(null)} />
      )}
      {deferredPrompt && (
        <InstallPrompt onInstall={handleInstall} onDismiss={() => setDeferredPrompt(null)} />
      )}
      {!session ? (
        autoPin
          ? <div className="auto-login-screen"><div className="auto-login-spinner">◌</div></div>
          : <Login onLogin={login} status={wsStatus} />
      ) : session.role === 'admin' ? (
        <AdminPanel session={session} sendMsg={sendMsg} addListener={addListener} wsStatus={wsStatus} onLogout={logout} />
      ) : (
        <UserPanel session={session} sendMsg={sendMsg} addListener={addListener} wsStatus={wsStatus} onLogout={logout} />
      )}
    </div>
  )
}
