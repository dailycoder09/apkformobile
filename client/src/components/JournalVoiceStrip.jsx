import { useEffect, useRef, useState } from 'react'

// Small circular remove "X" — visually identical to PhotoStrip's remove button
// in the sibling component (JournalEntriesScreen.jsx). Duplicated here since
// this file must stay self-contained (no cross-component imports).
function XIcon() {
  return (
    <svg className="h-3.5 w-3.5 stroke-white stroke-[2.6]" fill="none" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

// Filled circle — classic "record" affordance for the idle record tile.
function RecordIcon() {
  return (
    <svg className="h-6 w-6 fill-red-500" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

// Filled square — "stop" affordance shown on the same tile while recording.
function StopIcon() {
  return (
    <svg className="h-5 w-5 fill-red-500" viewBox="0 0 24 24">
      <rect x="6" y="6" width="12" height="12" rx="2" />
    </svg>
  )
}

function formatElapsed(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// One playable voice-memo tile — shared markup for both existing (saved) and
// new (unsaved) recordings. Same rounded-xl / bg-black/5 language as
// PhotoStrip's photo tiles, just wider than the square size-12 tile so the
// native <audio controls> UI has room to render.
function VoiceTile({ url, onRemove }) {
  return (
    <div className="relative flex h-16 w-44 shrink-0 items-center overflow-hidden rounded-xl bg-black/5 py-1.5 pl-2 pr-6">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio controls src={url} className="h-8 w-full" />
      <button
        type="button"
        onClick={onRemove}
        aria-label="Remove voice memo"
        className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/60"
      >
        <XIcon />
      </button>
    </div>
  )
}

export default function JournalVoiceStrip({
  existingVoices,
  newRecordings,
  onRemoveExisting,
  onRemoveNew,
  onAddRecording,
  hideTrigger = false,
  hideTiles = false,
}) {
  const [isRecording, setIsRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [micBlocked, setMicBlocked] = useState(false)

  const streamRef = useRef(null)
  const recorderRef = useRef(null)
  const chunksRef = useRef([])
  const timerRef = useRef(null)
  const blockedTimeoutRef = useRef(null)

  function releaseStream() {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }

  function clearTimer() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      clearTimer()
      if (blockedTimeoutRef.current) clearTimeout(blockedTimeoutRef.current)
      if (recorderRef.current && recorderRef.current.state !== 'inactive') {
        recorderRef.current.onstop = null
        recorderRef.current.stop()
      }
      releaseStream()
    }
  }, [])

  async function startRecording() {
    setMicBlocked(false)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      chunksRef.current = []

      const preferredType = 'audio/webm'
      const options =
        typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported(preferredType)
          ? { mimeType: preferredType }
          : undefined
      const recorder = new MediaRecorder(stream, options)

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' })
        chunksRef.current = []
        releaseStream()
        onAddRecording(blob)
      }

      recorderRef.current = recorder
      recorder.start()
      setIsRecording(true)
      setElapsed(0)
      timerRef.current = setInterval(() => setElapsed((s) => s + 1), 1000)
    } catch (err) {
      console.error('Microphone unavailable', err)
      releaseStream()
      setIsRecording(false)
      setMicBlocked(true)
      blockedTimeoutRef.current = setTimeout(() => setMicBlocked(false), 2200)
    }
  }

  function stopRecording() {
    clearTimer()
    setIsRecording(false)
    if (recorderRef.current && recorderRef.current.state !== 'inactive') {
      recorderRef.current.stop()
    } else {
      releaseStream()
    }
    recorderRef.current = null
  }

  function handleRecordTap() {
    if (isRecording) stopRecording()
    else startRecording()
  }

  return (
    <div className="flex shrink-0 items-center gap-2.5 overflow-x-auto">
      {!hideTiles &&
        existingVoices.map((v) => <VoiceTile key={v.id} url={v.url} onRemove={() => onRemoveExisting(v.id)} />)}
      {!hideTiles &&
        newRecordings.map((r, i) => <VoiceTile key={r.url} url={r.url} onRemove={() => onRemoveNew(i)} />)}

      {!hideTrigger && (
        <div className="flex shrink-0 items-center gap-1.5">
          <button
            type="button"
            onClick={handleRecordTap}
            aria-label={isRecording ? 'Stop recording' : 'Record voice memo'}
            className={`grid size-11 shrink-0 place-items-center rounded-full text-slate-500 transition-colors ${
              isRecording ? 'bg-red-50' : 'bg-black/5'
            }`}
          >
            {micBlocked ? (
              <span className="px-1 text-center text-[9px] font-medium leading-tight text-red-500">Mic blocked</span>
            ) : isRecording ? (
              <StopIcon />
            ) : (
              <RecordIcon />
            )}
          </button>

          {isRecording && (
            <div className="flex shrink-0 flex-col items-center gap-1">
              <span className="relative flex size-2.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex size-2.5 rounded-full bg-red-500" />
              </span>
              <span className="text-[11px] font-semibold tabular-nums text-red-500">{formatElapsed(elapsed)}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
