import { useCallback, useEffect, useRef, useState } from 'react'
import { Room } from 'livekit-client'

const RING_TIMEOUT_MS = 45000

function makeCallId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// Global two-way calling: ringing, accept/decline, active call with LiveKit media.
// Mounted once at App.jsx root so an incoming call rings regardless of the current
// screen. Separate from the app's one-way parent-monitoring camera/mic feature — a
// different LiveKit room-naming scheme (`call-{id}` vs a child's userId) and a
// symmetric publish grant (mode=call on /api/lk-token) so both sides can publish.
// Scoped to regular users only — admin↔user calling is a future follow-up (see plan).
export default function useCallManager({ session, sendMsg, addListener }) {
  const [callState, setCallState] = useState('idle') // idle | outgoing-ringing | incoming-ringing | active
  const [peer, setPeer] = useState(null) // { id, name }
  const [video, setVideo] = useState(false)
  const [callId, setCallId] = useState(null)
  const [room, setRoom] = useState(null)
  const [startedAt, setStartedAt] = useState(null)
  const [micEnabled, setMicEnabled] = useState(true)
  const [camEnabled, setCamEnabled] = useState(false)
  const [facingMode, setFacingMode] = useState('user')
  const [endReason, setEndReason] = useState(null)

  const ringTimerRef = useRef(null)
  const roomRef = useRef(null)
  const callIdRef = useRef(null)
  const callStateRef = useRef('idle')
  const videoRef = useRef(false)
  callIdRef.current = callId
  callStateRef.current = callState
  videoRef.current = video

  const resetCall = useCallback(() => {
    clearTimeout(ringTimerRef.current)
    ringTimerRef.current = null
    if (roomRef.current) {
      roomRef.current.disconnect()
      roomRef.current = null
    }
    setRoom(null)
    setCallState('idle')
    setPeer(null)
    setCallId(null)
    setStartedAt(null)
    setMicEnabled(true)
    setCamEnabled(false)
    setFacingMode('user')
  }, [])

  const connectToCall = useCallback(async (id, withVideo) => {
    const r = await fetch(`/api/lk-token?room=${encodeURIComponent('call-' + id)}&identity=${encodeURIComponent(session.userId)}&mode=call`)
    if (!r.ok) throw new Error('token fetch failed')
    const { token, url } = await r.json()
    const lkRoom = new Room()
    roomRef.current = lkRoom
    await lkRoom.connect(url, token)
    await lkRoom.localParticipant.setMicrophoneEnabled(true)
    setMicEnabled(true)
    if (withVideo) {
      try {
        await lkRoom.localParticipant.setCameraEnabled(true, { facingMode: 'user' })
        setCamEnabled(true)
      } catch { /* camera denied — continue audio-only */ }
    }
    setRoom(lkRoom)
    setStartedAt(Date.now())
    setCallState('active')
  }, [session])

  const startCall = useCallback((peerId, peerName, withVideo) => {
    if (callStateRef.current !== 'idle') return
    const id = makeCallId()
    setCallId(id)
    setPeer({ id: peerId, name: peerName })
    setVideo(withVideo)
    setCallState('outgoing-ringing')
    setEndReason(null)
    sendMsg({ type: 'call_invite', toId: peerId, callId: id, video: withVideo })
    ringTimerRef.current = setTimeout(() => {
      sendMsg({ type: 'call_cancel', callId: id, reason: 'timeout' })
      setEndReason('timeout')
      resetCall()
    }, RING_TIMEOUT_MS)
  }, [sendMsg, resetCall])

  const acceptCall = useCallback(async () => {
    if (callStateRef.current !== 'incoming-ringing' || !callIdRef.current) return
    const id = callIdRef.current
    sendMsg({ type: 'call_accept', callId: id })
    try {
      await connectToCall(id, videoRef.current)
    } catch {
      sendMsg({ type: 'call_end', callId: id, reason: 'media-error' })
      resetCall()
    }
  }, [sendMsg, connectToCall, resetCall])

  const declineCall = useCallback(() => {
    if (callStateRef.current !== 'incoming-ringing' || !callIdRef.current) return
    sendMsg({ type: 'call_decline', callId: callIdRef.current })
    setEndReason('declined')
    resetCall()
  }, [sendMsg, resetCall])

  const hangUp = useCallback(() => {
    if (!callIdRef.current) return
    if (callStateRef.current === 'outgoing-ringing') sendMsg({ type: 'call_cancel', callId: callIdRef.current })
    else if (callStateRef.current === 'active') sendMsg({ type: 'call_end', callId: callIdRef.current, reason: 'hangup' })
    resetCall()
  }, [sendMsg, resetCall])

  const toggleMic = useCallback(() => {
    if (!roomRef.current) return
    setMicEnabled((prev) => { roomRef.current.localParticipant.setMicrophoneEnabled(!prev); return !prev })
  }, [])

  const toggleCamera = useCallback(() => {
    if (!roomRef.current) return
    setCamEnabled((prev) => {
      const next = !prev
      roomRef.current.localParticipant.setCameraEnabled(next, next ? { facingMode } : undefined)
      return next
    })
  }, [facingMode])

  const flipCamera = useCallback(async () => {
    if (!roomRef.current || !camEnabled) return
    const next = facingMode === 'user' ? 'environment' : 'user'
    setFacingMode(next)
    await roomRef.current.localParticipant.setCameraEnabled(true, { facingMode: next })
  }, [camEnabled, facingMode])

  // Listen for incoming signaling regardless of which screen is mounted. Guarded to
  // regular-user sessions only — see file header.
  useEffect(() => {
    if (!session || session.role === 'admin') return
    return addListener((msg) => {
      if (msg.type === 'call_invite') {
        // Server already guards the caller's side against ringing a busy callee; this
        // covers the race where an invite arrives just as we start our own call.
        if (callStateRef.current !== 'idle') {
          sendMsg({ type: 'call_busy', callId: msg.callId })
          return
        }
        setCallId(msg.callId)
        setPeer({ id: msg.fromId, name: msg.fromName })
        setVideo(!!msg.video)
        setCallState('incoming-ringing')
        setEndReason(null)
        return
      }
      if (msg.type === 'call_accept' && msg.callId === callIdRef.current && callStateRef.current === 'outgoing-ringing') {
        clearTimeout(ringTimerRef.current)
        connectToCall(msg.callId, videoRef.current).catch(() => {
          sendMsg({ type: 'call_end', callId: msg.callId, reason: 'media-error' })
          resetCall()
        })
        return
      }
      if (
        (msg.type === 'call_decline' || msg.type === 'call_cancel' || msg.type === 'call_end' || msg.type === 'call_busy') &&
        msg.callId === callIdRef.current
      ) {
        setEndReason(msg.type === 'call_busy' ? 'busy' : (msg.reason || msg.type))
        resetCall()
      }
    })
  }, [session, addListener, sendMsg, connectToCall, resetCall])

  // Logging out mid-call: drop the call locally (peer learns via the server's own
  // disconnect handling once this session's socket closes).
  useEffect(() => {
    if (!session) resetCall()
  }, [session, resetCall])

  useEffect(() => () => { if (roomRef.current) roomRef.current.disconnect() }, [])

  return {
    callState, peer, video, room, startedAt, micEnabled, camEnabled, endReason,
    startCall, acceptCall, declineCall, hangUp, toggleMic, toggleCamera, flipCamera,
  }
}
