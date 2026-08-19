import { useEffect, useRef, useState } from 'react'
import { RoomEvent, Track } from 'livekit-client'

// Full-screen call UI shown during 'outgoing-ringing' and 'active' — remote video/avatar,
// local preview PiP, and the mic/camera/flip/hang-up controls. Mirrors the track.attach()
// pattern LiveMonitorPanel.jsx already uses for the one-way monitoring feature.
export default function ActiveCallScreen({ call }) {
  const { room, peer, video, callState, startedAt, micEnabled, camEnabled, hangUp, toggleMic, toggleCamera, flipCamera } = call
  const remoteVideoRef = useRef(null)
  const remoteAudioRef = useRef(null)
  const localVideoRef = useRef(null)
  const [remoteVideoOn, setRemoteVideoOn] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!room) return
    function handleSubscribed(track) {
      if (track.kind === Track.Kind.Video && remoteVideoRef.current) {
        track.attach(remoteVideoRef.current)
        setRemoteVideoOn(true)
      } else if (track.kind === Track.Kind.Audio && remoteAudioRef.current) {
        track.attach(remoteAudioRef.current)
      }
    }
    function handleUnsubscribed(track) {
      track.detach()
      if (track.kind === Track.Kind.Video) setRemoteVideoOn(false)
    }
    room.on(RoomEvent.TrackSubscribed, handleSubscribed)
    room.on(RoomEvent.TrackUnsubscribed, handleUnsubscribed)
    // Tracks published before this effect ran (race with connect) need picking up too.
    room.remoteParticipants.forEach((p) => {
      p.videoTrackPublications.forEach((pub) => { if (pub.track) handleSubscribed(pub.track) })
      p.audioTrackPublications.forEach((pub) => { if (pub.track) handleSubscribed(pub.track) })
    })
    return () => {
      room.off(RoomEvent.TrackSubscribed, handleSubscribed)
      room.off(RoomEvent.TrackUnsubscribed, handleUnsubscribed)
    }
  }, [room])

  useEffect(() => {
    if (!room || !camEnabled || !localVideoRef.current) return
    const pub = [...room.localParticipant.videoTrackPublications.values()][0]
    if (pub?.track) pub.track.attach(localVideoRef.current)
  }, [room, camEnabled])

  useEffect(() => {
    if (callState !== 'active' || !startedAt) return
    setElapsed(Math.floor((Date.now() - startedAt) / 1000))
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
    return () => clearInterval(t)
  }, [callState, startedAt])

  const mins = String(Math.floor(elapsed / 60)).padStart(2, '0')
  const secs = String(elapsed % 60).padStart(2, '0')

  return (
    <div className="call-screen">
      {video && remoteVideoOn ? (
        <video ref={remoteVideoRef} className="call-remote-video" autoPlay playsInline />
      ) : (
        <div className="call-avatar-fill">
          <div className="call-avatar call-avatar--xl">{peer?.name?.[0]?.toUpperCase() || '?'}</div>
        </div>
      )}
      <audio ref={remoteAudioRef} autoPlay />

      {video && camEnabled && (
        <video ref={localVideoRef} className="call-local-preview" autoPlay playsInline muted />
      )}

      <div className="call-topbar">
        <span className="call-peer-name">{peer?.name}</span>
        <span className="call-status">
          {callState === 'active' ? `${mins}:${secs}` : callState === 'outgoing-ringing' ? 'Ringing…' : ''}
        </span>
      </div>

      <div className="call-controls">
        <button type="button" className={`call-round-btn${micEnabled ? '' : ' off'}`} onClick={toggleMic} aria-label={micEnabled ? 'Mute' : 'Unmute'}>
          <span className="material-symbols-outlined">{micEnabled ? 'mic' : 'mic_off'}</span>
        </button>
        {video && (
          <button type="button" className={`call-round-btn${camEnabled ? '' : ' off'}`} onClick={toggleCamera} aria-label={camEnabled ? 'Turn camera off' : 'Turn camera on'}>
            <span className="material-symbols-outlined">{camEnabled ? 'videocam' : 'videocam_off'}</span>
          </button>
        )}
        {video && camEnabled && (
          <button type="button" className="call-round-btn" onClick={flipCamera} aria-label="Flip camera">
            <span className="material-symbols-outlined">cameraswitch</span>
          </button>
        )}
        <button type="button" className="call-round-btn call-round-btn--decline" onClick={hangUp} aria-label="Hang up">
          <span className="material-symbols-outlined">call_end</span>
        </button>
      </div>
    </div>
  )
}
