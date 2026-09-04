import { useEffect, useMemo, useState } from 'react'
import * as localData from '../lib/localData'
import JournalVoiceStrip from './JournalVoiceStrip'
import JournalVideoStrip from './JournalVideoStrip'
import PhotoStrip from './PhotoStrip'
import FileStrip from './FileStrip'
import AttachmentMenu from './AttachmentMenu'
import useAttachmentState from '../hooks/useAttachmentState'
import { CameraIcon, MicIcon, VideoCameraIcon, PaperclipIcon } from './attachmentIcons'
import { formatDueLabel, formatShortDate } from '../utils/healthFormat'

// Ported from HealthEpisodesSection.jsx's ReminderRow tint rule — reminders have no
// severity field, so the card tint is derived from due/completion state instead:
// overdue-and-not-done gets this urgent red, completed gets a quiet muted look,
// everything else is a plain white card (matching Journal's untinted 'okay' mood card).
const REMINDER_OVERDUE_BG = '#fbe0e0'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's
// other date-handling modules (HealthTrackerPanel.jsx, KhatabookPanel.jsx) — kept as its
// own local copy here rather than shared.
const IST_TZ = 'Asia/Kolkata'
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}

const EMPTY_REMINDER_FORM = { id: null, title: '', dueDate: '', repeats: false, repeatDays: '30', notes: '' }

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
function TrashIcon() {
  return (
    <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.7 12.1a2 2 0 0 1-2 1.9H9.7a2 2 0 0 1-2-1.9L7 7h10Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
// SVG stand-in for the material-symbols "check" glyph HealthEpisodesSection's ReminderRow
// used — that font-face is only loaded under the .health-screen wrapper (see index.css),
// which this screen doesn't use (it's styled after Journal's plain SVG-icon convention
// instead), so a real check glyph is drawn here rather than risk a missing-ligature blank.
function CheckIcon() {
  return (
    <svg className="h-[18px] w-[18px] stroke-current stroke-[2.6]" fill="none" viewBox="0 0 24 24">
      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Small icon+count pairs for attached media, reusing Journal's exact icon set — ported
// from HealthEpisodesSection.jsx's AttachmentBadges.
function AttachmentBadges({ photoCount = 0, videoCount = 0, voiceCount = 0, fileCount = 0, toneClass }) {
  if (!photoCount && !videoCount && !voiceCount && !fileCount) return null
  return (
    <div className={`flex shrink-0 items-center gap-2 text-xs font-semibold ${toneClass}`}>
      {photoCount > 0 && (
        <span className="flex items-center gap-0.5">
          <CameraIcon className="h-4 w-4" />
          {photoCount}
        </span>
      )}
      {videoCount > 0 && (
        <span className="flex items-center gap-0.5">
          <VideoCameraIcon className="h-4 w-4" />
          {videoCount}
        </span>
      )}
      {voiceCount > 0 && (
        <span className="flex items-center gap-0.5">
          <MicIcon className="h-4 w-4" />
          {voiceCount}
        </span>
      )}
      {fileCount > 0 && (
        <span className="flex items-center gap-0.5">
          <PaperclipIcon className="h-4 w-4" />
          {fileCount}
        </span>
      )}
    </div>
  )
}

// One card in the reminders list — ported from HealthEpisodesSection.jsx's ReminderRow,
// restyled to match JournalEntriesScreen's EntryCard shell exactly (rounded-3xl, tinted
// pastel when overdue, muted when completed, plain white otherwise). The "mark done"
// action stays a separate button inside the card (stopPropagation) rather than the whole
// card being nested buttons.
function ReminderRow({ r, onOpen, onMarkDone }) {
  const label = formatDueLabel(r.dueDate)
  const completed = Boolean(r.completed)
  const overdue = label.startsWith('Overdue') && !completed
  const cardBg = overdue ? REMINDER_OVERDUE_BG : null
  const tinted = Boolean(cardBg) || completed
  const mutedTone = tinted ? 'text-slate-700' : 'text-slate-400'
  return (
    <article
      onClick={() => onOpen(r)}
      style={cardBg ? { background: cardBg } : undefined}
      className={`relative w-full cursor-pointer rounded-3xl p-5 text-left shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform active:scale-[0.985] ${
        cardBg ? '' : completed ? 'bg-black/[0.03]' : 'border border-black/[0.03] bg-white'
      } ${completed ? 'opacity-70' : ''}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={`truncate text-sm font-bold ${completed ? 'text-slate-500' : 'text-slate-900'}`}>{r.title}</p>
          <p className={`mt-0.5 truncate text-xs font-medium ${mutedTone}`}>
            {label}{r.repeatDays ? ` · every ${r.repeatDays}d` : ''}
          </p>
          {r.notes && <p className={`mt-2.5 line-clamp-2 text-xs leading-relaxed ${tinted ? 'text-slate-700' : 'text-slate-600'}`}>{r.notes}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AttachmentBadges
            photoCount={r.photoCount}
            videoCount={r.videoCount}
            voiceCount={r.voiceCount}
            fileCount={r.fileCount}
            toneClass={mutedTone}
          />
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation()
              onMarkDone(r)
            }}
            aria-label={`Mark ${r.title} done`}
            className="grid size-8 shrink-0 place-items-center rounded-full bg-emerald-100 text-emerald-700 transition-transform active:scale-95"
          >
            <CheckIcon />
          </button>
        </div>
      </div>
    </article>
  )
}

// Full-screen compose page for adding/editing a reminder — structurally identical to
// JournalEntriesScreen.jsx's ComposeScreen (lime header, scrollable body, attachment
// footer), with the reminder-specific fields (title, due date, repeats + interval,
// notes) ported from HealthTrackerPanel.jsx's ReminderSheet in place of Journal's single
// notes textarea.
function ComposeScreen({ draft, onBack, onCommit, onDelete }) {
  const [title, setTitle] = useState(draft.title || '')
  const [dueDate, setDueDate] = useState(draft.dueDate || istDateKey(Date.now()))
  const [repeats, setRepeats] = useState(Boolean(draft.repeats))
  const [repeatDays, setRepeatDays] = useState(draft.repeatDays || '30')
  const [notes, setNotes] = useState(draft.notes || '')
  const photos = useAttachmentState()
  const videos = useAttachmentState()
  const voices = useAttachmentState()
  const files = useAttachmentState()
  const isNew = !draft.id

  useEffect(() => {
    if (!draft.id) return
    let cancelled = false
    localData.getHealthMediaForEntry(draft.id, 'reminder').then((rows) => {
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

  function handleCommit() {
    onCommit({
      title,
      dueDate,
      repeats,
      repeatDays,
      notes,
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

  const subtitleDate = dueDate ? formatShortDate(istDateInputToMs(dueDate)) : ''

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between bg-[#e1ff3b] px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-sm font-bold text-slate-900">{isNew ? 'New Reminder' : 'Edit Reminder'}</p>
          {subtitleDate && <p className="text-xs font-medium text-slate-700">Due {subtitleDate}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {!isNew && (
            <button type="button" onClick={onDelete} aria-label="Delete reminder" className="grid size-9 shrink-0 place-items-center text-slate-900">
              <TrashIcon />
            </button>
          )}
          <button
            type="button"
            onClick={handleCommit}
            disabled={!title.trim()}
            className="rounded-full bg-[#1e2229] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {isNew ? 'Publish' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-1">
        <div className="add-field !px-0">
          <label className="add-label">Title</label>
          <input
            autoFocus
            className="add-input"
            type="text"
            placeholder="e.g. Multivitamin refill"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="add-field !px-0">
          <label className="add-label">Due Date</label>
          <input className="add-input" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>

        <div className="add-field !px-0">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <input type="checkbox" className="size-4 accent-[#1e2229]" checked={repeats} onChange={(e) => setRepeats(e.target.checked)} />
            Repeats
          </label>
          {repeats && (
            <div className="mt-2 flex items-center gap-2">
              <span className="text-sm text-slate-500">Every</span>
              <input
                className="add-input w-20"
                type="number"
                min="1"
                inputMode="numeric"
                value={repeatDays}
                onChange={(e) => setRepeatDays(e.target.value)}
              />
              <span className="text-sm text-slate-500">days</span>
            </div>
          )}
        </div>

        <div className="add-field !px-0">
          <label className="add-label">Notes (optional)</label>
          <textarea
            className="add-input"
            rows={4}
            placeholder="Pharmacy, doctor's name, anything else"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
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

// Health reminders list + full-screen compose — standalone screen (not a section of
// HealthTrackerPanel) mounted by HealthHubScreen.jsx, persisted directly to IndexedDB via
// localData.js's health_reminders table (getHealthData/addHealthReminder/
// updateHealthReminder/deleteHealthReminder). Unlike the rest of this app's WS-backed
// panels, this module intentionally skips the sendMsg round trip entirely — see the
// handoff notes for why. Visual/structural shape ported from JournalEntriesScreen.jsx;
// reminder card look + form fields/logic ported from HealthEpisodesSection.jsx's
// ReminderRow and HealthTrackerPanel.jsx's ReminderSheet respectively.
export default function HealthRemindersListScreen({ onBack }) {
  const [reminders, setReminders] = useState([])
  const [draft, setDraft] = useState(null)

  useEffect(() => {
    localData.getHealthData().then((data) => setReminders(data.reminders || []))
  }, [])

  // Non-completed reminders, soonest due first — one-time reminders that were marked done
  // (completed: true) drop out here but stay in the table for history; recurring ones
  // never get a completed flag, their dueDate just advances (see markReminderDone below).
  const upcomingReminders = useMemo(
    () => reminders.filter((r) => !r.completed).sort((a, b) => a.dueDate - b.dueDate),
    [reminders]
  )

  function openAddReminder() {
    setDraft({ ...EMPTY_REMINDER_FORM, dueDate: istDateKey(Date.now()) })
  }
  function openEditReminder(reminder) {
    setDraft({
      id: reminder.id,
      title: reminder.title || '',
      dueDate: istDateKey(reminder.dueDate),
      repeats: reminder.repeatDays != null,
      repeatDays: reminder.repeatDays != null ? String(reminder.repeatDays) : '30',
      notes: reminder.notes || '',
    })
  }

  async function commitDraft({
    title,
    dueDate,
    repeats,
    repeatDays,
    notes,
    newPhotoFiles = [],
    removedPhotoIds = [],
    newVideoFiles = [],
    removedVideoIds = [],
    newVoiceBlobs = [],
    removedVoiceIds = [],
    newDocFiles = [],
    removedFileIds = [],
  }) {
    const trimmedTitle = title.trim()
    if (!trimmedTitle) return
    const payload = {
      title: trimmedTitle,
      dueDate: istDateInputToMs(dueDate || istDateKey(Date.now())),
      repeatDays: repeats ? parseInt(repeatDays, 10) || 30 : null,
      notes: notes.trim(),
      completed: false,
    }
    const entryId = draft.id || Math.random().toString(36).slice(2)
    const reminder = { ...payload, id: entryId }

    for (const id of [...removedPhotoIds, ...removedVideoIds, ...removedVoiceIds, ...removedFileIds]) {
      await localData.deleteHealthMedia(id)
    }
    for (const file of newPhotoFiles) {
      await localData.addHealthMedia({ entryId, entryType: 'reminder', kind: 'photo', blob: file })
    }
    for (const file of newVideoFiles) {
      await localData.addHealthMedia({ entryId, entryType: 'reminder', kind: 'video', blob: file })
    }
    for (const blob of newVoiceBlobs) {
      await localData.addHealthMedia({ entryId, entryType: 'reminder', kind: 'voice', blob })
    }
    for (const doc of newDocFiles) {
      await localData.addHealthMedia({ entryId, entryType: 'reminder', kind: 'file', blob: doc.file, name: doc.name })
    }

    const remainingMedia = await localData.getHealthMediaForEntry(entryId, 'reminder')
    const counts = {
      photoCount: remainingMedia.filter((m) => m.kind === 'photo').length,
      videoCount: remainingMedia.filter((m) => m.kind === 'video').length,
      voiceCount: remainingMedia.filter((m) => m.kind === 'voice').length,
      fileCount: remainingMedia.filter((m) => m.kind === 'file').length,
    }

    if (draft.id) {
      await localData.updateHealthReminder(reminder)
      setReminders((prev) => prev.map((r) => (r.id === reminder.id ? { ...reminder, ...counts } : r)))
    } else {
      await localData.addHealthReminder(reminder)
      setReminders((prev) => [{ ...reminder, ...counts }, ...prev])
    }
    setDraft(null)
  }

  async function deleteReminder(id) {
    await localData.deleteHealthReminder(id)
    setReminders((prev) => prev.filter((r) => r.id !== id))
    setDraft(null)
  }

  // A recurring reminder just rolls its dueDate forward by repeatDays and stays active; a
  // one-time reminder gets completed:true and disappears from upcomingReminders for good.
  async function markReminderDone(reminder) {
    const updated = reminder.repeatDays
      ? { ...reminder, dueDate: reminder.dueDate + reminder.repeatDays * 86400000 }
      : { ...reminder, completed: true }
    await localData.updateHealthReminder(updated)
    setReminders((prev) => prev.map((r) => (r.id === updated.id ? updated : r)))
  }

  if (draft) {
    return (
      <ComposeScreen
        draft={draft}
        onBack={() => setDraft(null)}
        onCommit={commitDraft}
        onDelete={draft.id ? () => deleteReminder(draft.id) : undefined}
      />
    )
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <h1 className="text-[19px] font-bold tracking-tight text-slate-900">Reminders</h1>
        <span className="size-9 shrink-0" />
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 pt-2">
        {upcomingReminders.length === 0 ? (
          <div className="flex flex-col items-center gap-1.5 py-16 text-center">
            <p className="text-sm font-semibold text-slate-600">No reminders set.</p>
            <p className="text-xs text-slate-400">Tap the + button to add one.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3.5">
            {upcomingReminders.map((r) => (
              <ReminderRow key={r.id} r={r} onOpen={openEditReminder} onMarkDone={markReminderDone} />
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0 px-6 pb-6 pt-2">
        <button
          type="button"
          onClick={openAddReminder}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[#1e2229] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_24px_-4px_rgba(30,34,41,0.28)] transition-all hover:opacity-90 active:scale-[0.985]"
        >
          <PlusIcon />
          Add a reminder
        </button>
      </div>
    </div>
  )
}
