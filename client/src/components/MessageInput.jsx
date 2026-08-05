import { useState, useRef } from 'react'
import FolderBrowser from './FolderBrowser'

export default function MessageInput({ onSendText, onSendImage, onSendFile, disabled }) {
  const [text, setText] = useState('')
  const [folderOpen, setFolderOpen] = useState(false)
  const photoRef = useRef(null)
  const textareaRef = useRef(null)

  const handleSend = () => {
    const trimmed = text.trim()
    if (!trimmed) return
    onSendText(trimmed)
    setText('')
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto'
    }
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleInput = (e) => {
    setText(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = `${Math.min(e.target.scrollHeight, 120)}px`
  }

  const handlePhotoChange = (e) => {
    Array.from(e.target.files).forEach((file) => {
      const reader = new FileReader()
      reader.onload = () => onSendImage(reader.result, file.name)
      reader.readAsDataURL(file)
    })
    e.target.value = ''
  }

  return (
    <>
      {folderOpen && (
        <FolderBrowser
          onShareFile={(name, size) => { onSendFile(name, size); setFolderOpen(false) }}
          onClose={() => setFolderOpen(false)}
        />
      )}

      <div className="message-input">
        <button
          className="icon-btn"
          title="Share photo"
          onClick={() => photoRef.current?.click()}
          disabled={disabled}
        >
          📷
        </button>
        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={handlePhotoChange}
        />

        <button
          className="icon-btn"
          title="Browse folder"
          onClick={() => setFolderOpen(true)}
          disabled={disabled}
        >
          📁
        </button>

        <textarea
          ref={textareaRef}
          className="text-input"
          value={text}
          onInput={handleInput}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Type a message…"
          rows={1}
          disabled={disabled}
        />

        <button
          className="send-btn"
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          aria-label="Send"
        >
          ➤
        </button>
      </div>
    </>
  )
}
