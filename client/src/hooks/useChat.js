import { useState, useEffect, useRef, useCallback } from 'react'

function getWsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

export function useChat() {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState('connecting')
  const [user, setUser] = useState(null)
  const [userCount, setUserCount] = useState(0)
  const wsRef = useRef(null)
  const reconnectRef = useRef(null)

  const connect = useCallback(() => {
    const ws = new WebSocket(getWsUrl())
    wsRef.current = ws

    ws.onopen = () => setStatus('open')

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data)
      if (msg.type === 'welcome') {
        setUser({ id: msg.userId, name: msg.userName })
        setUserCount(msg.userCount)
        return
      }
      setMessages((prev) => [...prev, msg])
    }

    ws.onclose = () => {
      setStatus('closed')
      reconnectRef.current = setTimeout(connect, 3000)
    }

    ws.onerror = () => ws.close()
  }, [])

  useEffect(() => {
    connect()
    return () => {
      clearTimeout(reconnectRef.current)
      wsRef.current?.close()
    }
  }, [connect])

  const send = useCallback((payload) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(payload))
    }
  }, [])

  const sendText = useCallback((text) => send({ type: 'text', text }), [send])
  const sendImage = useCallback((data, name) => send({ type: 'image', data, name }), [send])
  const sendFile = useCallback((name, size) => send({ type: 'file', name, size }), [send])

  return { messages, status, user, userCount, sendText, sendImage, sendFile }
}
