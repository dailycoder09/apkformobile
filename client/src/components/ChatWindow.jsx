import { useChat } from '../hooks/useChat'
import MessageList from './MessageList'
import MessageInput from './MessageInput'

const STATUS_LABEL = {
  open: 'Connected',
  connecting: 'Connecting…',
  closed: 'Reconnecting…',
}

export default function ChatWindow() {
  const { messages, status, user, userCount, sendText, sendImage, sendFile } = useChat()

  return (
    <div className="chat-window">
      <header className="chat-header">
        <div className="chat-header-left">
          <span className="app-name">meeee</span>
          <span className={`status-dot status-${status}`} />
          <span className="status-text">{STATUS_LABEL[status]}</span>
        </div>
        <div className="chat-header-right">
          {user && <span className="username">{user.name}</span>}
          <span className="user-count">{userCount} online</span>
        </div>
      </header>

      <MessageList messages={messages} currentUserId={user?.id} />

      <MessageInput
        onSendText={sendText}
        onSendImage={sendImage}
        onSendFile={sendFile}
        disabled={status !== 'open'}
      />
    </div>
  )
}
