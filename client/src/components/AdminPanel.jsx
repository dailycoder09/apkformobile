import { useState, useEffect, useRef } from 'react'
import RemoteFileBrowser from './RemoteFileBrowser'
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
            <div key={i} className={`msg-row${own ? ' own' : ''}`}>
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
          disabled={wsStatus !== 'open'}
        />
        <button className="send-btn" onClick={send} disabled={wsStatus !== 'open' || !text.trim()}>➤</button>
      </div>
    </div>
  )
}

export default function AdminPanel({ session, sendMsg, addListener, wsStatus, onLogout }) {
  const [users, setUsers]           = useState(session.initialUsers || [])
  const [selectedUser, setSelectedUser] = useState(null)
  const [view, setView]             = useState('files') // 'files' | 'dm'
  const [dmUnread, setDmUnread]     = useState({})

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
    })
  }, [addListener])

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
                <li key={user.id} className={`user-item ${selectedUser?.id === user.id ? 'selected' : ''}`}>
                  <span className="user-avatar" onClick={() => selectUser(user)}>
                    {user.name[0].toUpperCase()}
                  </span>
                  <span className="user-item-name" onClick={() => selectUser(user)}>
                    {user.name}
                  </span>
                  <span className="user-item-actions">
                    <button
                      className="dm-icon-btn"
                      title={`Message ${user.name}`}
                      onClick={() => openDM(user)}
                    >
                      💬{dmUnread[user.id] > 0 && <sup>{dmUnread[user.id]}</sup>}
                    </button>
                    <span className="online-dot" />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </aside>

        <main className="admin-main">
          {!selectedUser && (
            <div className="admin-placeholder">
              <span className="placeholder-icon">📱</span>
              <p>Select a user to browse files or send a message</p>
            </div>
          )}

          {selectedUser && view === 'files' && (
            <div className="admin-main-with-actions">
              <div className="admin-view-tabs">
                <button className="view-tab active">📁 Files</button>
                <button className="view-tab" onClick={() => openDM(selectedUser)}>
                  💬 Message {dmUnread[selectedUser.id] > 0 && `(${dmUnread[selectedUser.id]})`}
                </button>
              </div>
              <RemoteFileBrowser
                key={selectedUser.id}
                targetUser={selectedUser}
                adminId={session.userId}
                sendMsg={sendMsg}
                addListener={addListener}
              />
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
