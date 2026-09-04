import { useEffect, useState } from 'react'
import * as localData from '../lib/localData'
import JournalVoiceStrip from './JournalVoiceStrip'
import JournalVideoStrip from './JournalVideoStrip'
import JournalTagPicker from './JournalTagPicker'
import JournalTagBadges from './JournalTagBadges'
import PhotoStrip from './PhotoStrip'
import FileStrip from './FileStrip'
import AttachmentMenu from './AttachmentMenu'
import useAttachmentState from '../hooks/useAttachmentState'
import { CameraIcon, MicIcon, VideoCameraIcon, PaperclipIcon } from './attachmentIcons'

const MOODS = [
  { key: 'great', emoji: '😄', label: 'Great' },
  { key: 'good', emoji: '🙂', label: 'Good' },
  { key: 'okay', emoji: '😐', label: 'Okay' },
  { key: 'low', emoji: '😕', label: 'Low' },
  { key: 'rough', emoji: '😢', label: 'Rough' },
]
function moodEmoji(key) {
  return MOODS.find((m) => m.key === key)?.emoji || null
}
// Soft pastel card tint per mood, in the same muted-pastel family as the Journal
// Hub's own card colors. 'okay' is intentionally left untinted — a neutral day
// shouldn't visually compete with actually-expressive moods.
const MOOD_CARD_BG = {
  great: '#e3f5df',
  good: '#e6f0fb',
  low: '#fbe9d7',
  rough: '#fbe0e0',
}

function BackArrow() {
  return (
    <svg className="h-6 w-6 stroke-[2.2] stroke-current text-slate-900" fill="none" viewBox="0 0 24 24">
      <path d="M15 19l-7-7 7-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function PlusIcon() {
  return (
    <svg className="h-5 w-5 stroke-[2.4] stroke-current" fill="none" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
}
function SortIcon() {
  return (
    <svg className="h-5 w-5 stroke-[2] stroke-current text-slate-800" fill="none" viewBox="0 0 24 24">
      <path d="M3 7.5L7.5 3m0 0L12 7.5M7.5 3v13.5m13.5 0L16.5 21m0 0L12 16.5m4.5 4.5V7.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function LightbulbIcon() {
  return (
    <svg className="h-5 w-5 fill-slate-950" viewBox="0 0 24 24">
      <path d="M12 2C8.13 2 5 5.13 5 9c0 2.38 1.19 4.47 3 5.74V17c0 .55.45 1 1 1h6c.55 0 1-.45 1-1v-2.26c1.81-1.27 3-3.36 3-5.74 0-3.87-3.13-7-7-7zm-3 18h6v1c0 .55-.45 1-1 1h-4c-.55 0-1-.45-1-1v-1z" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.7 12.1a2 2 0 0 1-2 1.9H9.7a2 2 0 0 1-2-1.9L7 7h10Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
// Small tappable mood badge in the card's top-left corner, next to the date. Shows
// a neutral placeholder until a mood is set. Mood is assigned from here, on the
// list, AFTER the note is saved — not inside the compose screen — so tapping opens
// a compact popover of mood chips right where the badge sits, rather than editing
// re-opening the whole entry.
function MoodBadge({ mood, onSetMood }) {
  const [open, setOpen] = useState(false)
  const emoji = moodEmoji(mood)

  return (
    <div className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        aria-label="Set mood"
        className="grid size-7 shrink-0 place-items-center rounded-full text-lg leading-none"
      >
        <span className="journal-emoji-animated">{emoji || '🙂'}</span>
      </button>
      {open && (
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute left-0 top-full z-10 mt-2 flex gap-1.5 rounded-full bg-white p-1.5 shadow-[0_8px_24px_-4px_rgba(0,0,0,0.15)]"
        >
          {MOODS.map((m) => (
            <button
              key={m.key}
              type="button"
              onClick={() => {
                onSetMood(m.key)
                setOpen(false)
              }}
              aria-label={m.label}
              className={`grid size-9 shrink-0 place-items-center rounded-full text-lg leading-none transition-colors ${
                mood === m.key ? 'bg-[#1e2229]' : 'bg-transparent'
              }`}
            >
              <span className="journal-emoji-animated">{m.emoji}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function EntryCard({ entry, onOpen, onSetMood }) {
  const photoCount = entry.photoCount || 0
  const voiceCount = entry.voiceCount || 0
  const videoCount = entry.videoCount || 0
  const fileCount = entry.fileCount || 0
  const moodBg = entry.mood ? MOOD_CARD_BG[entry.mood] : null
  const tinted = Boolean(moodBg) || entry.highlighted
  const mutedTone = tinted ? 'text-slate-700' : 'text-slate-400'
  return (
    <article
      onClick={onOpen}
      style={moodBg ? { background: moodBg } : undefined}
      className={`relative w-full cursor-pointer rounded-3xl p-5 text-left shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform active:scale-[0.985] ${
        moodBg ? '' : entry.highlighted ? 'bg-[#e1ff3b]' : 'border border-black/[0.03] bg-white'
      }`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <MoodBadge mood={entry.mood} onSetMood={onSetMood} />
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold text-slate-900">{entry.date}</span>
            <span className={`text-xs font-medium ${mutedTone}`}>{entry.day}</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {photoCount > 0 && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold ${mutedTone}`}>
              <CameraIcon className="h-4 w-4" />
              {photoCount}
            </span>
          )}
          {videoCount > 0 && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold ${mutedTone}`}>
              <VideoCameraIcon className="h-4 w-4" />
              {videoCount}
            </span>
          )}
          {voiceCount > 0 && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold ${mutedTone}`}>
              <MicIcon className="h-4 w-4" />
              {voiceCount}
            </span>
          )}
          {fileCount > 0 && (
            <span className={`flex items-center gap-0.5 text-xs font-semibold ${mutedTone}`}>
              <PaperclipIcon className="h-4 w-4" />
              {fileCount}
            </span>
          )}
          {entry.highlighted && <LightbulbIcon />}
        </div>
      </div>
      <p className={`mt-2.5 line-clamp-3 text-xs leading-relaxed ${entry.highlighted ? 'text-slate-700' : 'text-slate-600'}`}>
        {entry.notes}
      </p>
      {entry.tags?.length > 0 && (
        <div className="mt-2.5">
          <JournalTagBadges tags={entry.tags} />
        </div>
      )}
    </article>
  )
}

function TagIcon({ className = 'h-5 w-5' }) {
  return (
    <svg className={`${className} stroke-current`} fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M4 4h7l9 9-7 7-9-9V4Z" strokeLinejoin="round" />
      <circle cx="8.5" cy="8.5" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  )
}

// Single small icon that opens the tag picker in a popover, instead of always
// showing the full chip row inline — keeps the compose footer quiet by default.
function TagMenu({ selectedTags, onToggle }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="Tags"
        className="relative grid size-11 shrink-0 place-items-center rounded-full bg-black/5 text-slate-500"
      >
        <TagIcon />
        {selectedTags.length > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid size-4 place-items-center rounded-full bg-[#1e2229] text-[9px] font-bold text-white">
            {selectedTags.length}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute bottom-full left-0 z-10 mb-2 max-w-[280px] rounded-2xl bg-white shadow-[0_8px_24px_-4px_rgba(0,0,0,0.15)]">
          <JournalTagPicker selectedTags={selectedTags} onToggle={onToggle} />
        </div>
      )}
    </div>
  )
}

function ComposeScreen({ draft, onBack, onCommit, onDelete }) {
  const [notes, setNotes] = useState(draft.notes || '')
  const [tags, setTags] = useState(draft.tags || [])
  const photos = useAttachmentState()
  const videos = useAttachmentState()
  const voices = useAttachmentState()
  const files = useAttachmentState()
  const isNew = !draft.id

  useEffect(() => {
    if (!draft.id) return
    let cancelled = false
    localData.getJournalMediaForEntry(draft.id).then((rows) => {
      if (cancelled) return
      photos.setExisting(rows.filter((r) => r.kind === 'photo').map((r) => ({ id: r.id, url: URL.createObjectURL(r.blob) })))
      videos.setExisting(rows.filter((r) => r.kind === 'video').map((r) => ({ id: r.id, url: URL.createObjectURL(r.blob) })))
      voices.setExisting(rows.filter((r) => r.kind === 'voice').map((r) => ({ id: r.id, url: URL.createObjectURL(r.blob) })))
      files.setExisting(
        rows.filter((r) => r.kind === 'file').map((r) => ({ id: r.id, url: URL.createObjectURL(r.blob), name: r.name }))
      )
    })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.id])

  useEffect(() => {
    return () => {
      for (const strip of [photos, videos, voices, files]) {
        strip.existing.forEach((item) => URL.revokeObjectURL(item.url))
        strip.added.forEach((item) => URL.revokeObjectURL(item.url))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function addPhotoFiles(fileList) {
    photos.addBlobs(fileList.map((file) => ({ file, url: URL.createObjectURL(file) })))
  }
  function addVideoFiles(fileList) {
    videos.addBlobs(fileList.map((file) => ({ file, url: URL.createObjectURL(file) })))
  }
  function addDocFiles(fileList) {
    files.addBlobs(fileList.map((file) => ({ file, url: URL.createObjectURL(file), name: file.name })))
  }
  function addVoiceRecording(blob) {
    voices.addBlobs([{ file: blob, url: URL.createObjectURL(blob) }])
  }
  function toggleTag(tag) {
    setTags((prev) => (prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag]))
  }

  function handleCommit() {
    onCommit({
      notes,
      tags,
      newPhotoFiles: photos.added.map((p) => p.file),
      removedPhotoIds: photos.removedIds,
      newVideoFiles: videos.added.map((v) => v.file),
      removedVideoIds: videos.removedIds,
      newVoiceBlobs: voices.added.map((v) => v.file),
      removedVoiceIds: voices.removedIds,
      newDocFiles: files.added.map((f) => ({ file: f.file, name: f.name })),
      removedFileIds: files.removedIds,
    })
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between bg-[#e1ff3b] px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-sm font-bold text-slate-900">{draft.date}</p>
          <p className="text-xs font-medium text-slate-700">{draft.day}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {!isNew && (
            <button type="button" onClick={onDelete} aria-label="Delete entry" className="grid size-9 shrink-0 place-items-center text-slate-900">
              <TrashIcon />
            </button>
          )}
          <button
            type="button"
            onClick={handleCommit}
            className="rounded-full bg-[#1e2229] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90"
          >
            {isNew ? 'Publish' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-1" style={{ paddingBottom: '0.5rem' }}>
        <textarea
          autoFocus
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Write about your day…"
          className="h-full w-full resize-none border-none bg-transparent text-[15px] leading-relaxed text-slate-800 outline-none placeholder:text-slate-400"
        />
      </div>

      <div
        className="shrink-0 border-t border-black/5 px-6 pt-2.5"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {(photos.existing.length + photos.added.length > 0 ||
          videos.existing.length + videos.added.length > 0 ||
          voices.existing.length + voices.added.length > 0 ||
          files.existing.length + files.added.length > 0) && (
          <div className="mb-2.5 flex max-h-32 flex-col gap-2 overflow-y-auto">
            {photos.existing.length + photos.added.length > 0 && (
              <PhotoStrip
                existingPhotos={photos.existing}
                newFiles={photos.added}
                onRemoveExisting={photos.removeExisting}
                onRemoveNew={photos.removeAdded}
                hideAddTile
              />
            )}
            {videos.existing.length + videos.added.length > 0 && (
              <JournalVideoStrip
                existingVideos={videos.existing}
                newFiles={videos.added}
                onRemoveExisting={videos.removeExisting}
                onRemoveNew={videos.removeAdded}
                hideAddTile
              />
            )}
            {voices.existing.length + voices.added.length > 0 && (
              <JournalVoiceStrip
                existingVoices={voices.existing}
                newRecordings={voices.added}
                onRemoveExisting={voices.removeExisting}
                onRemoveNew={voices.removeAdded}
                hideTrigger
              />
            )}
            {files.existing.length + files.added.length > 0 && (
              <FileStrip
                existingFiles={files.existing}
                newDocs={files.added}
                onRemoveExisting={files.removeExisting}
                onRemoveNew={files.removeAdded}
                hideAddTile
              />
            )}
          </div>
        )}

        <div className="flex items-center gap-2">
          <TagMenu selectedTags={tags} onToggle={toggleTag} />
          <AttachmentMenu
            onAddPhotoFiles={addPhotoFiles}
            onAddVideoFiles={addVideoFiles}
            onAddDocFiles={addDocFiles}
            voiceProps={{
              existingVoices: voices.existing,
              newRecordings: voices.added,
              onRemoveExisting: voices.removeExisting,
              onRemoveNew: voices.removeAdded,
              onAddRecording: addVoiceRecording,
            }}
            attachedCount={
              photos.existing.length +
              photos.added.length +
              videos.existing.length +
              videos.added.length +
              voices.existing.length +
              voices.added.length +
              files.existing.length +
              files.added.length
            }
          />
        </div>
      </div>
    </div>
  )
}

// Journal entries list + full-screen compose — ported directly from journal-studio's
// working reference implementation, persisted to IndexedDB (localData.js's
// journal_notes_v2 table). Mood is set from the list, after a note is saved (see
// MoodBadge above), not inside compose — it's the first "one by one" feature added
// back on top of the scoped-down rebuild; photo/voice/video attachments are next.
export default function JournalEntriesScreen({ onBack }) {
  const [entries, setEntries] = useState([])
  const [draft, setDraft] = useState(null)

  useEffect(() => {
    localData.getJournalNotesSeeded().then(setEntries)
  }, [])

  function openNewEntry() {
    const now = new Date()
    setDraft({
      id: null,
      date: now.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }),
      day: now.toLocaleDateString('en-US', { weekday: 'long' }),
      notes: '',
    })
  }
  function openExistingEntry(entry) {
    setDraft(entry)
  }
  async function commitDraft({
    notes,
    tags = [],
    newPhotoFiles = [],
    removedPhotoIds = [],
    newVideoFiles = [],
    removedVideoIds = [],
    newVoiceBlobs = [],
    removedVoiceIds = [],
    newDocFiles = [],
    removedFileIds = [],
  }) {
    const entryId = draft.id || (await localData.addJournalNote({ date: draft.date, day: draft.day, notes })).id

    for (const id of [...removedPhotoIds, ...removedVideoIds, ...removedVoiceIds, ...removedFileIds]) {
      await localData.deleteJournalMedia(id)
    }
    for (const file of newPhotoFiles) {
      await localData.addJournalMedia({ entryId, kind: 'photo', blob: file })
    }
    for (const file of newVideoFiles) {
      await localData.addJournalMedia({ entryId, kind: 'video', blob: file })
    }
    for (const blob of newVoiceBlobs) {
      await localData.addJournalMedia({ entryId, kind: 'voice', blob })
    }
    for (const doc of newDocFiles) {
      await localData.addJournalMedia({ entryId, kind: 'file', blob: doc.file, name: doc.name })
    }

    const remainingMedia = await localData.getJournalMediaForEntry(entryId)
    const photoCount = remainingMedia.filter((m) => m.kind === 'photo').length
    const videoCount = remainingMedia.filter((m) => m.kind === 'video').length
    const voiceCount = remainingMedia.filter((m) => m.kind === 'voice').length
    const fileCount = remainingMedia.filter((m) => m.kind === 'file').length

    const updated = await localData.updateJournalNote(entryId, { notes, tags, photoCount, videoCount, voiceCount, fileCount })
    setEntries((prev) => {
      const exists = prev.some((e) => e.id === entryId)
      return exists ? prev.map((e) => (e.id === entryId ? updated : e)) : [updated, ...prev]
    })
    setDraft(null)
  }
  async function setEntryMood(id, mood) {
    const updated = await localData.updateJournalNote(id, { mood })
    setEntries((prev) => prev.map((e) => (e.id === id ? updated : e)))
  }
  async function deleteEntry(id) {
    await localData.deleteJournalNote(id)
    setEntries((prev) => prev.filter((e) => e.id !== id))
    setDraft(null)
  }

  if (draft) {
    return (
      <ComposeScreen
        draft={draft}
        onBack={() => setDraft(null)}
        onCommit={commitDraft}
        onDelete={draft.id ? () => deleteEntry(draft.id) : undefined}
      />
    )
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <h1 className="text-[19px] font-bold tracking-tight text-slate-900">Journal</h1>
        <button type="button" aria-label="Sort" className="grid size-9 shrink-0 place-items-center">
          <SortIcon />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 pt-2">
        <div className="flex flex-col gap-3.5">
          {entries.map((e) => (
            <EntryCard
              key={e.id}
              entry={e}
              onOpen={() => openExistingEntry(e)}
              onSetMood={(mood) => setEntryMood(e.id, mood)}
            />
          ))}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-6 pt-2">
        <button
          type="button"
          onClick={openNewEntry}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[#1e2229] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_24px_-4px_rgba(30,34,41,0.28)] transition-all hover:opacity-90 active:scale-[0.985]"
        >
          <PlusIcon />
          Start a new entry
        </button>
      </div>
    </div>
  )
}
