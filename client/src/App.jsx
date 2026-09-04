import { useState, useEffect, useRef, useCallback } from 'react'
import { Capacitor } from '@capacitor/core'
import Login from './components/Login'
import Dashboard from './components/Dashboard'
import TransactionPanel from './components/TransactionPanel'
import KhatabookPanel from './components/KhatabookPanel'
import MilestonePanel from './components/MilestonePanel'
import HealthHubScreen from './components/HealthHubScreen'
import JournalPanel from './components/JournalPanel'
import FamilyBackupsScreen from './components/FamilyBackupsScreen'
import InstallPrompt from './components/InstallPrompt'
import BottomNav from './components/BottomNav'
import NamazTracker from './components/NamazTracker'
import ProfilePage from './components/ProfilePage'
import TourPage from './components/TourPage'
import { getDeviceId, getProfile } from './lib/localData'
import { handleLocalMessage } from './lib/localTransport'
import { checkForExistingBackup, restoreFromDocumentsBackup, scheduleAutoBackup } from './lib/backup'

const CURRENT_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0'
const IS_NATIVE = Capacitor.isNativePlatform()
const NAME_KEY = 'meeee_name'

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

// Restore-from-backup offer, shown before onboarding only when a previous install's
// backup file is found on this device (see client/src/lib/backup.js) — the answer to
// "how do I get my data back after reinstalling" for a fully-offline app with no
// server copy.
function RestorePrompt({ backupInfo, onRestore, onSkip, busy }) {
  const dateLabel = backupInfo?.exportedAt
    ? new Date(backupInfo.exportedAt).toLocaleString()
    : 'an earlier install'
  return (
    <div className="login-screen">
      <div className="login-card">
        <div className="login-card-inner">
          <div className="login-logo" />
          <h1 className="login-title">Welcome back</h1>
          <p className="login-subtitle">Found a backup from {dateLabel} on this device.</p>
          <button type="button" className="login-btn" onClick={onRestore} disabled={busy}>
            {busy ? 'Restoring…' : 'Restore my data'}
          </button>
          <button type="button" className="login-link-btn" onClick={onSkip} disabled={busy}>
            Start fresh instead
          </button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const [deferredPrompt, setDeferredPrompt] = useState(null)
  const [session, setSession] = useState(null)
  const [module, setModule] = useState(null) // null=home | 'transactions' | 'namaz' | ...
  const [updateInfo, setUpdateInfo] = useState(null)
  const [booting, setBooting] = useState(true)
  const [backupInfo, setBackupInfo] = useState(null) // set only if a restorable backup was found on first launch
  const [restoring, setRestoring] = useState(false)
  const listenersRef = useRef([])

  useEffect(() => {
    const h = (e) => { e.preventDefault(); setDeferredPrompt(e) }
    window.addEventListener('beforeinstallprompt', h)
    return () => window.removeEventListener('beforeinstallprompt', h)
  }, [])

  useEffect(() => { requestNotificationPermission() }, [])

  // No login, no server round-trip to establish identity — a single persisted device
  // id (see localData.js) stands in for what used to be a Firebase-verified userId.
  // A saved display name means onboarding already happened; otherwise, before
  // showing the one-time name prompt, check whether a backup file from a previous
  // install exists on this device (native only) and offer to restore it first.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const deviceId = await getDeviceId()
      const name = localStorage.getItem(NAME_KEY)
      if (name) {
        if (!cancelled) { setSession({ userId: deviceId, name }); setBooting(false) }
        return
      }
      const found = await checkForExistingBackup()
      if (cancelled) return
      if (found) setBackupInfo(found)
      setBooting(false)
    })()
    return () => { cancelled = true }
  }, [])

  // Check for updates on native app startup — best-effort; silently does nothing if
  // there's no reachable server (this app no longer depends on one for anything else).
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
      .catch(() => {})
  }, [])

  const login = useCallback((name) => {
    localStorage.setItem(NAME_KEY, name)
    getDeviceId().then((deviceId) => setSession({ userId: deviceId, name }))
  }, [])

  const handleRestore = useCallback(async () => {
    setRestoring(true)
    try {
      await restoreFromDocumentsBackup()
      // The backup covers IndexedDB tables, not the separate `meeee_name` localStorage
      // key (wiped along with everything else on an uninstall) — fall back to the
      // restored profile's first name, since that's the closest thing to a saved
      // display name that actually made it into the backup.
      const profile = await getProfile()
      const name = profile?.firstName || 'You'
      localStorage.setItem(NAME_KEY, name)
      const deviceId = await getDeviceId()
      setSession({ userId: deviceId, name })
    } catch (e) {
      console.error('restore failed', e)
    } finally {
      setRestoring(false)
      setBackupInfo(null)
    }
  }, [])

  const logout = useCallback(() => {
    // "Logout" no longer means "sign out of a server session" — there isn't one.
    // Clearing the saved name just re-triggers onboarding; the actual data in
    // IndexedDB is untouched (this is not a data-wipe action).
    localStorage.removeItem(NAME_KEY)
    setSession(null)
  }, [])

  // Every mutating message also kicks a debounced local backup (see backup.js) so the
  // on-disk backup file stays current without the user needing to remember to export.
  const sendMsg = useCallback((msg) => {
    const emit = (reply) => listenersRef.current.forEach((fn) => fn(reply))
    handleLocalMessage(msg, emit).then(() => {
      if (msg.type.endsWith('_add') || msg.type.endsWith('_update') || msg.type.endsWith('_delete')
        || msg.type.endsWith('_set') || msg.type.endsWith('_delete_all') || msg.type.endsWith('_bulk_add')) {
        scheduleAutoBackup()
      }
    })
  }, [])

  const addListener = useCallback((fn) => {
    listenersRef.current.push(fn)
    return () => { listenersRef.current = listenersRef.current.filter((f) => f !== fn) }
  }, [])

  const handleInstall = () => {
    deferredPrompt.prompt()
    deferredPrompt.userChoice.then(() => setDeferredPrompt(null))
  }

  const onProfileOpen = () => setModule('profile')

  return (
    <div className="app">
      {updateInfo && (
        <UpdateBanner apkUrl={updateInfo.apkUrl} onDismiss={() => setUpdateInfo(null)} />
      )}
      {deferredPrompt && (
        <InstallPrompt onInstall={handleInstall} onDismiss={() => setDeferredPrompt(null)} />
      )}
      {booting ? (
        <div className="auto-login-screen"><div className="auto-login-spinner">◌</div></div>
      ) : !session ? (
        backupInfo ? (
          <RestorePrompt
            backupInfo={backupInfo}
            busy={restoring}
            onRestore={handleRestore}
            onSkip={() => setBackupInfo(null)}
          />
        ) : (
          <Login onLogin={login} />
        )
      ) : (
        <>
          {!module ? (
            <Dashboard session={session} onSelect={setModule} sendMsg={sendMsg} addListener={addListener} showProfile onProfileOpen={onProfileOpen} />
          ) : module === 'transactions' ? (
            <TransactionPanel session={session} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} onProfileOpen={onProfileOpen} />
          ) : module === 'namaz' ? (
            <NamazTracker session={session} sendMsg={sendMsg} addListener={addListener} onProfileOpen={onProfileOpen} />
          ) : module === 'khatabook' || module === 'khatabook-app' ? (
            <KhatabookPanel session={session} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} onProfileOpen={onProfileOpen} />
          ) : module === 'milestone' ? (
            <MilestonePanel session={session} sendMsg={sendMsg} addListener={addListener} onHome={() => setModule(null)} onProfileOpen={onProfileOpen} />
          ) : module === 'health' ? (
            <HealthHubScreen onHome={() => setModule(null)} />
          ) : module === 'journal' ? (
            <JournalPanel onHome={() => setModule(null)} />
          ) : module === 'family-backups' ? (
            <FamilyBackupsScreen onHome={() => setModule(null)} />
          ) : module === 'profile' ? (
            <ProfilePage session={session} sendMsg={sendMsg} addListener={addListener} onLogout={logout} />
          ) : module === 'workout' ? (
            <ComingSoon title="Workout" icon="💪" onHome={() => setModule(null)} />
          ) : module === 'tour' ? (
            <TourPage onHome={() => setModule(null)} onSelect={setModule} />
          ) : null}

          <BottomNav active={module} onNavigate={setModule} />
        </>
      )}
    </div>
  )
}
