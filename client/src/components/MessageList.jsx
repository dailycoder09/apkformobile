import { useEffect, useRef } from 'react'

function formatBytes(b) {
  if (!b) return ''
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Message({ msg, own }) {
  if (msg.type === 'system') {
    return <div className="msg-system">{msg.text}</div>
  }

  return (
    <div className={`msg-row${own ? ' own' : ''}`}>
      {!own && <div className="msg-avatar">{msg.from?.[0]?.toUpperCase()}</div>}
      <div className="msg-bubble-wrap">
        {!own && <div className="msg-from">{msg.from}</div>}
        <div className={`msg-bubble${own ? ' own' : ''}`}>
          {msg.type === 'text' && <p>{msg.text}</p>}
          {msg.type === 'image' && (
            <img src={msg.data} alt={msg.name} className="msg-image" />
          )}
          {msg.type === 'file' && (
            <div className="msg-file">
              <span>📄</span>
              <span className="file-name">{msg.name}</span>
              <span className="file-size">{formatBytes(msg.size)}</span>
            </div>
          )}
        </div>
        <div className="msg-time">{formatTime(msg.ts)}</div>
      </div>
    </div>
  )
}

export default function MessageList({ messages, currentUserId }) {
  const bottomRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  return (
    <div className="message-list">
      {messages.length === 0 && (
        <div className="empty-state">No messages yet — say hi! 👋</div>
      )}
      {messages.map((msg, i) => (
        <Message
          key={msg.id ?? i}
          msg={msg}
          own={msg.own === true || msg.fromId === currentUserId}
        />
      ))}
      <div ref={bottomRef} />
    </div>
  )
}
