import { useState, useEffect, useRef } from 'react'
import RemoteFileBrowser from './RemoteFileBrowser'
import LiveMonitorPanel from './LiveMonitorPanel'
import { notify } from '../App'

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Mini DM panel for admin → specific user
function AdminDMView({ targetUser, session, sendMsg, addListener, wsStatus, onBack }) {
  const [messages, setMessages] = useState([])
  const [text, setText] = useState('')
  const bottomRef = useRef(null)

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'dm') {
        const peerId = msg.own ? msg.toId : msg.fromId
        if (peerId === targetUser.id) setMessages(prev => [...prev, msg])
      }
    })
  }, [addListener, targetUser.id])

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])

  const send = () => {
    const t = text.trim(); if (!t || wsStatus !== 'open') return
    sendMsg({ type: 'dm', toId: targetUser.id, text: t })
    setText('')
  }

  return (
    <div className="admin-dm-view">
      <div className="admin-dm-header">
        <button className="back-btn" onClick={onBack}>← Files</button>
        <span>💬 {targetUser.name}</span>
      </div>
      <div className="message-list">
        {messages.length === 0 && <div className="empty-state">Send a message to {targetUser.name}</div>}
        {messages.map((msg, i) => {
          const own = msg.own === true
          return (
            <div key={`${msg.ts}-${msg.fromId || 'own'}-${i}`} className={`msg-row${own ? ' own' : ''}`}>
              {!own && <div className="msg-avatar">{msg.from?.[0]?.toUpperCase()}</div>}
              <div className="msg-bubble-wrap">
                <div className={`msg-bubble${own ? ' own' : ''}`}><p>{msg.text}</p></div>
                <div className="msg-time">{formatTime(msg.ts)}</div>
              </div>
            </div>
          )
        })}
        <div ref={bottomRef} />
      </div>
      <div className="message-input">
        <textarea
          className="text-input"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
          placeholder={`Message ${targetUser.name}…`}
          rows={1}
          enterKeyHint="send"
          disabled={wsStatus !== 'open'}
        />
        <button className="send-btn" onClick={send} disabled={wsStatus !== 'open' || !text.trim()}>➤</button>
      </div>
    </div>
  )
}

export default function AdminPanel({ session, sendMsg, addListener, wsStatus, onLogout, onHome }) {
  const [users, setUsers]           = useState(session.initialUsers || [])
  const [selectedUser, setSelectedUser] = useState(null)
  const [view, setView]             = useState('files') // 'files' | 'dm' | 'live'
  const [dmUnread, setDmUnread]     = useState({})
  // Durable roster (device_tokens table) — unlike `users` above, this includes family
  // members whose app is currently killed/offline, which is exactly who "Wake up" exists
  // for. `wakeStatus` is transient per-userId UI feedback for that action, not persisted.
  const [allDevices, setAllDevices] = useState([])
  const [wakeStatus, setWakeStatus] = useState({})

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'user_joined') {
        setUsers(prev => [...prev.filter(u => u.id !== msg.user.id), msg.user])
        notify('meeee', `${msg.user.name} is now online`)
      }
      if (msg.type === 'user_left') {
        setUsers(prev => prev.filter(u => u.id !== msg.userId))
        setSelectedUser(sel => sel?.id === msg.userId ? null : sel)
      }
      if (msg.type === 'dm' && !msg.own) {
        setDmUnread(u => ({ ...u, [msg.fromId]: (u[msg.fromId] || 0) + 1 }))
        notify(msg.from, msg.text)
      }
      if (msg.type === 'device_list') {
        setAllDevices(msg.devices || [])
      }
      if (msg.type === 'wake_result') {
        setWakeStatus(s => ({ ...s, [msg.userId]: msg.ok ? 'Sent' : (msg.reason || 'Failed') }))
        setTimeout(() => setWakeStatus(s => { const { [msg.userId]: _, ...rest } = s; return rest }), 4000)
      }
    })
  }, [addListener])

  useEffect(() => {
    sendMsg({ type: 'device_list_get' })
  }, [sendMsg])

  const wakeUser = (userId) => {
    setWakeStatus(s => ({ ...s, [userId]: 'Waking…' }))
    sendMsg({ type: 'wake_user', userId })
  }

  // Offline-only view of the durable roster — anyone currently connected already has a
  // row (with richer actions) in the "Online" list above, so this avoids showing the
  // same person twice.
  const onlineIds = new Set(users.map(u => u.id))
  const offlineDevices = allDevices.filter(d => !onlineIds.has(d.userId))

  const selectUser = (user) => {
    setSelectedUser(user)
    setView('files')
  }

  const openDM = (user) => {
    setSelectedUser(user)
    setView('dm')
    setDmUnread(u => ({ ...u, [user.id]: 0 }))
  }

  return (
    <div className="admin-panel">
      <header className="panel-header">
        <div className="panel-header-left">
          <span className="app-name">meeee</span>
          <span className="admin-badge">Admin</span>
          <span className={`status-dot status-${wsStatus}`} />
        </div>
        <button className="home-nav-btn" onClick={onHome} aria-label="Home">🏠</button>
        <button className="logout-btn" onClick={onLogout}>Logout</button>
      </header>

      <div className="admin-body">
        <aside className="user-sidebar">
          <div className="sidebar-title">
            Online
            <span className="count-badge">{users.length}</span>
          </div>

          {users.length === 0 ? (
            <p className="no-users">No users connected yet</p>
          ) : (
            <ul className="user-list">
              {users.map((user) => (
                <li key={user.id}
                  className={`user-item ${selectedUser?.id === user.id ? 'selected' : ''}`}
                  onClick={() => selectUser(user)}
                >
                  <span className="user-avatar">{user.name[0].toUpperCase()}</span>
                  <span className="user-item-name">{user.name}</span>
                  <span className="user-item-actions">
                    <button
                      className="dm-icon-btn"
                      title={`Message ${user.name}`}
                      aria-label={`Message ${user.name}`}
                      onClick={(e) => { e.stopPropagation(); openDM(user) }}
                    >
                      💬{dmUnread[user.id] > 0 && <sup>{dmUnread[user.id]}</sup>}
                    </button>
                    <button
                      className="dm-icon-btn"
                      title={`Live monitor ${user.name}`}
                      aria-label={`Live monitor ${user.name}`}
                      onClick={(e) => { e.stopPropagation(); setSelectedUser(user); setView('live') }}
                    >
                      📡
                    </button>
                    <span className="online-dot" />
                  </span>
                </li>
              ))}
            </ul>
          )}

          {offlineDevices.length > 0 && (
            <>
              <div className="sidebar-title">
                Offline
                <span className="count-badge">{offlineDevices.length}</span>
              </div>
              <ul className="user-list">
                {offlineDevices.map((d) => (
                  <li key={d.userId} className="user-item">
                    <span className="user-avatar">{(d.name || '?')[0].toUpperCase()}</span>
                    <span className="user-item-name">{d.name || 'Unknown'}</span>
                    <span className="user-item-actions">
                      {wakeStatus[d.userId] ? (
                        <span className="wake-status" title={wakeStatus[d.userId]}>{wakeStatus[d.userId]}</span>
                      ) : (
                        <button
                          className="dm-icon-btn"
                          title={`Wake up ${d.name || 'this device'}`}
                          aria-label={`Wake up ${d.name || 'this device'}`}
                          onClick={(e) => { e.stopPropagation(); wakeUser(d.userId) }}
                        >
                          🔔
                        </button>
                      )}
                      <span className="online-dot offline" />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </aside>

        <main className="admin-main">
          {!selectedUser && (
            <div className="admin-placeholder">
              <span className="placeholder-icon">📱</span>
              <p>Select a user to browse files or send a message</p>
            </div>
          )}

          {selectedUser && (view === 'files' || view === 'live') && (
            <div className="admin-main-with-actions">
              <div className="admin-view-tabs">
                <button className={`view-tab${view === 'files' ? ' active' : ''}`} onClick={() => setView('files')}>📁 Files</button>
                <button className="view-tab" onClick={() => openDM(selectedUser)}>
                  💬 Message {dmUnread[selectedUser.id] > 0 && `(${dmUnread[selectedUser.id]})`}
                </button>
                <button className={`view-tab${view === 'live' ? ' active' : ''}`} onClick={() => setView('live')}>📡 Live</button>
              </div>
              {view === 'files' && (
                <RemoteFileBrowser
                  key={selectedUser.id}
                  targetUser={selectedUser}
                  adminId={session.userId}
                  sendMsg={sendMsg}
                  addListener={addListener}
                />
              )}
              {view === 'live' && (
                <LiveMonitorPanel
                  key={selectedUser.id}
                  targetUser={selectedUser}
                  adminId={session.userId}
                  sendMsg={sendMsg}
                  addListener={addListener}
                />
              )}
            </div>
          )}

          {selectedUser && view === 'dm' && (
            <AdminDMView
              targetUser={selectedUser}
              session={session}
              sendMsg={sendMsg}
              addListener={addListener}
              wsStatus={wsStatus}
              onBack={() => setView('files')}
            />
          )}
        </main>
      </div>
    </div>
  )
}
