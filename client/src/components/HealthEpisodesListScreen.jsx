import { useState, useEffect, useMemo } from 'react'
import * as localData from '../lib/localData'
import PhotoStrip from './PhotoStrip'
import FileStrip from './FileStrip'
import AttachmentMenu from './AttachmentMenu'
import JournalVideoStrip from './JournalVideoStrip'
import JournalVoiceStrip from './JournalVoiceStrip'
import useAttachmentState from '../hooks/useAttachmentState'
import { CameraIcon, MicIcon, VideoCameraIcon, PaperclipIcon } from './attachmentIcons'
import { formatDateRange } from '../utils/healthFormat'

// Health's own "don't trust the browser's own timezone" copy — same pattern duplicated
// across this app's other calendar/date logic (JournalEntriesScreen doesn't need one since
// entries are single-day; episodes span a date range so this screen keeps its own copy,
// ported from HealthEpisodesSection.jsx/HealthTrackerPanel.jsx verbatim).
const IST_TZ = 'Asia/Kolkata'
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}
const WEEKDAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
function pad(n) { return String(n).padStart(2, '0') }

const EMPTY_EPISODE_FORM = {
  id: null,
  title: '',
  symptoms: [],
  symptomInput: '',
  treatments: [],
  treatmentName: '',
  treatmentDosage: '',
  treatmentNotes: '',
  severity: 'mild',
  doctorVisited: false,
  doctorNotes: '',
  startDate: '',
  recoveryDate: '',
  stillRecovering: true,
  notes: '',
}

const SEVERITY_TONE = {
  mild: { chip: 'bg-success-soft text-success' },
  moderate: { chip: 'bg-warning-soft text-warning' },
  severe: { chip: 'bg-destructive-soft text-destructive' },
}
const SEVERITY_LABEL = { mild: 'Mild', moderate: 'Moderate', severe: 'Severe' }
// Soft pastel card tint per severity, in the same muted-pastel register as Journal's
// MOOD_CARD_BG (JournalEntriesScreen.jsx) — episodes always carry a severity, so unlike
// Journal's 'okay' mood, there's no untinted episode card state.
const SEVERITY_CARD_BG = {
  mild: '#e6f0fb',
  moderate: '#fbe9d7',
  severe: '#fbe0e0',
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
function TrashIcon() {
  return (
    <svg className="h-5 w-5 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8">
      <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m2 0-.7 12.1a2 2 0 0 1-2 1.9H9.7a2 2 0 0 1-2-1.9L7 7h10Z" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Small icon+count pairs for attached media, reusing Journal's exact icon set
// (attachmentIcons.jsx) — ported from HealthEpisodesSection.jsx as-is.
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

// One card in the episode list, styled after JournalEntriesScreen's EntryCard (rounded-3xl
// tinted panel, corner attachment badges) — ported from HealthEpisodesSection.jsx's
// EpisodeRow as-is. No edit/delete icons: the whole card is the tap target that opens the
// edit compose screen.
function EpisodeRow({ e, onSelect }) {
  const tone = SEVERITY_TONE[e.severity] || SEVERITY_TONE.mild
  const cardBg = SEVERITY_CARD_BG[e.severity] || SEVERITY_CARD_BG.mild
  const mutedTone = 'text-slate-700'
  return (
    <article
      onClick={onSelect}
      style={{ background: cardBg }}
      className="relative w-full cursor-pointer rounded-3xl p-5 text-left shadow-[0_2px_10px_rgba(0,0,0,0.03)] transition-transform active:scale-[0.985]"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-bold text-slate-900">{e.title}</p>
          <p className={`mt-0.5 truncate text-xs font-medium ${mutedTone}`}>
            {formatDateRange(e.startDate, e.recoveryDate)}
          </p>
        </div>
        <AttachmentBadges
          photoCount={e.photoCount}
          videoCount={e.videoCount}
          voiceCount={e.voiceCount}
          fileCount={e.fileCount}
          toneClass={mutedTone}
        />
      </div>
      <div className="mt-2.5">
        <span className={`inline-block rounded-full px-2.5 py-1 text-xs font-bold ${tone.chip}`}>
          {SEVERITY_LABEL[e.severity] || 'Mild'}
        </span>
      </div>
    </article>
  )
}

// Month grid + selected-day state — ported from HealthEpisodesSection.jsx's
// useHealthCalendar as-is. A day gets a marker whenever ANY episode's
// [startDate, recoveryDate ?? now] range includes it — episodes span a date range, not a
// single day.
function useHealthCalendar(episodes) {
  const [viewMonth, setViewMonth] = useState(() => {
    const d = new Date()
    return new Date(d.getFullYear(), d.getMonth(), 1)
  })
  // null = no day selected (list shows everything). Selecting the same day twice clears it.
  const [selectedDayKey, setSelectedDayKey] = useState(null)

  const year = viewMonth.getFullYear()
  const month = viewMonth.getMonth()
  const monthLabel = viewMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })

  const calendarCells = useMemo(() => {
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstWeekday; i++) cells.push(null)
    for (let day = 1; day <= daysInMonth; day++) {
      const key = `${year}-${pad(month + 1)}-${pad(day)}`
      const active = episodes.filter(e => {
        const startKey = istDateKey(e.startDate)
        const endKey = istDateKey(e.recoveryDate ?? Date.now())
        return key >= startKey && key <= endKey
      })
      cells.push({ date: new Date(year, month, day), key, active })
    }
    return cells
  }, [year, month, episodes])

  function goToMonth(delta) {
    setViewMonth(prev => new Date(prev.getFullYear(), prev.getMonth() + delta, 1))
  }
  function goToToday() {
    const d = new Date()
    setViewMonth(new Date(d.getFullYear(), d.getMonth(), 1))
    setSelectedDayKey(null)
  }
  function selectDay(key) {
    setSelectedDayKey(prev => prev === key ? null : key)
  }

  return { monthLabel, calendarCells, selectedDayKey, goToMonth, goToToday, selectDay }
}

// Compact calendar header — ported from HealthEpisodesSection.jsx's HealthCalendarHeader,
// restyled off Tile/TileLabel semantic wrappers onto plain Tailwind classes matching this
// screen's own header/typography (this module has no desktop layout, mobile-first only).
function HealthCalendarHeader({ state }) {
  const { monthLabel, goToMonth, goToToday } = state
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">Calendar</span>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => goToMonth(-1)} aria-label="Previous month"
          className="grid size-6 shrink-0 place-items-center rounded-full border border-black/10 text-slate-500">
          <span className="material-symbols-outlined text-sm">chevron_left</span>
        </button>
        <span className="min-w-[110px] text-center text-xs font-bold text-slate-800">{monthLabel}</span>
        <button type="button" onClick={() => goToMonth(1)} aria-label="Next month"
          className="grid size-6 shrink-0 place-items-center rounded-full border border-black/10 text-slate-500">
          <span className="material-symbols-outlined text-sm">chevron_right</span>
        </button>
        <button type="button" onClick={goToToday}
          className="h-6 shrink-0 rounded-full border border-black/10 px-2.5 text-[11px] font-semibold text-slate-800">
          Today
        </button>
      </div>
    </div>
  )
}

// Ported from HealthEpisodesSection.jsx's HealthCalendarGrid as-is (colors kept as the
// existing success/warning/destructive semantic tokens, selection ring restyled to the
// app's lime accent instead of gold to match this screen's own compose-page accent color).
function HealthCalendarGrid({ state }) {
  const { calendarCells, selectedDayKey, selectDay } = state
  const todayKey = istDateKey(Date.now())
  return (
    <>
      <div className="mt-4 grid grid-cols-7 gap-1.5 text-center text-[11px] font-semibold text-slate-400">
        {WEEKDAYS.map((d, i) => <span key={i}>{d}</span>)}
      </div>
      <div className="mt-1.5 grid grid-cols-7 gap-1.5">
        {calendarCells.map((cell, i) => {
          if (!cell) return <span key={`blank${i}`} />
          const { date, key, active } = cell
          const isSelected = key === selectedDayKey
          const isToday = key === todayKey
          const dotClass = active.some(e => e.severity === 'severe')
            ? 'bg-destructive'
            : active.some(e => e.severity === 'moderate')
            ? 'bg-warning'
            : active.length > 0
            ? 'bg-success'
            : null
          return (
            <button
              key={key}
              type="button"
              onClick={() => selectDay(key)}
              aria-label={`${date.toLocaleDateString('en-IN', { day: 'numeric', month: 'long' })}${active.length ? `: ${active.length} active` : ''}`}
              className={`relative flex aspect-square flex-col items-center justify-center gap-1 rounded-xl text-xs transition-colors ${
                isSelected ? 'bg-[#e1ff3b]/40 ring-2 ring-[#c8e400]' : isToday ? 'font-bold ring-1 ring-black/10' : 'hover:bg-black/[0.03]'
              }`}
            >
              <span className="font-semibold text-slate-800">{date.getDate()}</span>
              {dotClass && <span className={`size-1.5 rounded-full ${dotClass}`} />}
            </button>
          )
        })}
      </div>
    </>
  )
}

// Full-screen episode compose page — laid out after JournalEntriesScreen's ComposeScreen
// (lime header, scrollable body, attachment footer) but with the episode form fields from
// HealthTrackerPanel.jsx's EpisodeSheet dropped into the body instead of a bottom sheet.
// Mounted fresh per open (list only renders this while `draft` is non-null), so the four
// useAttachmentState() hooks below get a clean instance every time — same reasoning as
// EpisodeSheet's own comment in HealthTrackerPanel.jsx.
function ComposeScreen({ draft, onBack, onSubmit, onDelete }) {
  const [form, setForm] = useState(draft)
  const photos = useAttachmentState()
  const videos = useAttachmentState()
  const voices = useAttachmentState()
  const files = useAttachmentState()
  const isNew = !draft.id

  useEffect(() => {
    if (!draft.id) return
    let cancelled = false
    localData.getHealthMediaForEntry(draft.id, 'episode').then((rows) => {
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

  function addSymptom() {
    const s = form.symptomInput.trim()
    if (!s || form.symptoms.includes(s)) return
    setForm(f => ({ ...f, symptoms: [...f.symptoms, s], symptomInput: '' }))
  }
  function removeSymptom(idx) {
    setForm(f => ({ ...f, symptoms: f.symptoms.filter((_, i) => i !== idx) }))
  }
  function addTreatment() {
    const name = form.treatmentName.trim()
    if (!name) return
    setForm(f => ({
      ...f,
      treatments: [...f.treatments, { name, dosage: f.treatmentDosage.trim(), notes: f.treatmentNotes.trim() }],
      treatmentName: '',
      treatmentDosage: '',
      treatmentNotes: '',
    }))
  }
  function removeTreatment(idx) {
    setForm(f => ({ ...f, treatments: f.treatments.filter((_, i) => i !== idx) }))
  }

  function handleCommit() {
    onSubmit(form, {
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

  const hasAnyAttachment =
    photos.existing.length + photos.added.length > 0 ||
    videos.existing.length + videos.added.length > 0 ||
    voices.existing.length + voices.added.length > 0 ||
    files.existing.length + files.added.length > 0

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between bg-[#e1ff3b] px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <div className="min-w-0 flex-1 text-center">
          <p className="text-sm font-bold text-slate-900">{isNew ? 'New Episode' : 'Edit Episode'}</p>
          <p className="text-xs font-medium text-slate-700">{form.title || 'Untitled'}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2.5">
          {!isNew && (
            <button type="button" onClick={onDelete} aria-label="Delete episode" className="grid size-9 shrink-0 place-items-center text-slate-900">
              <TrashIcon />
            </button>
          )}
          <button
            type="button"
            onClick={handleCommit}
            disabled={!form.title.trim()}
            className="rounded-full bg-[#1e2229] px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            {isNew ? 'Publish' : 'Save'}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-4">
        <div className="add-field">
          <label className="add-label">Title</label>
          <input className="add-input" type="text" placeholder="e.g. Flu"
            value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} autoFocus />
        </div>

        <div className="add-field">
          <label className="add-label">Symptoms</label>
          <div className="flex gap-2">
            <input className="add-input" type="text" placeholder="e.g. Fever"
              value={form.symptomInput}
              onChange={e => setForm(f => ({ ...f, symptomInput: e.target.value }))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addSymptom() } }} />
            <button type="button" onClick={addSymptom}
              className="shrink-0 rounded-xl bg-black/5 px-4 text-sm font-semibold text-slate-800 transition-colors hover:bg-black/10">
              Add
            </button>
          </div>
          {form.symptoms.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {form.symptoms.map((s, i) => (
                <span key={i} className="flex items-center gap-1 rounded-full bg-[#e1ff3b]/40 py-1 pl-2.5 pr-1.5 text-xs font-semibold text-slate-800">
                  {s}
                  <button type="button" onClick={() => removeSymptom(i)} aria-label={`Remove ${s}`}
                    className="grid size-4 shrink-0 place-items-center rounded-full text-slate-500 hover:text-slate-800">
                    <span className="material-symbols-outlined text-[14px]">close</span>
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="add-field">
          <label className="add-label">Treatments</label>
          <div className="flex gap-2">
            <input className="add-input" type="text" placeholder="Medicine name"
              value={form.treatmentName} onChange={e => setForm(f => ({ ...f, treatmentName: e.target.value }))} />
            <input className="add-input" type="text" placeholder="Dosage (optional)"
              value={form.treatmentDosage} onChange={e => setForm(f => ({ ...f, treatmentDosage: e.target.value }))} />
          </div>
          <div className="mt-2 flex gap-2">
            <input className="add-input" type="text" placeholder="Notes (optional)"
              value={form.treatmentNotes} onChange={e => setForm(f => ({ ...f, treatmentNotes: e.target.value }))} />
            <button type="button" onClick={addTreatment}
              className="shrink-0 rounded-xl bg-black/5 px-4 text-sm font-semibold text-slate-800 transition-colors hover:bg-black/10">
              Add
            </button>
          </div>
          {form.treatments.length > 0 && (
            <div className="mt-2 flex flex-col gap-1.5">
              {form.treatments.map((t, i) => (
                <div key={i} className="flex items-center justify-between gap-2 rounded-xl bg-black/[0.03] px-3 py-2 text-xs">
                  <span className="min-w-0 flex-1 truncate text-slate-800">
                    <span className="font-semibold">{t.name}</span>
                    {t.dosage ? ` · ${t.dosage}` : ''}
                    {t.notes ? <span className="text-slate-500"> · {t.notes}</span> : null}
                  </span>
                  <button type="button" onClick={() => removeTreatment(i)} aria-label={`Remove ${t.name}`}
                    className="shrink-0 text-slate-400 transition-colors hover:text-destructive">
                    <span className="material-symbols-outlined text-base">close</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="add-field">
          <label className="add-label">Severity</label>
          <div className="type-toggle">
            <button type="button" className={`type-btn${form.severity === 'mild' ? ' active mild' : ''}`}
              onClick={() => setForm(f => ({ ...f, severity: 'mild' }))}>Mild</button>
            <button type="button" className={`type-btn${form.severity === 'moderate' ? ' active moderate' : ''}`}
              onClick={() => setForm(f => ({ ...f, severity: 'moderate' }))}>Moderate</button>
            <button type="button" className={`type-btn${form.severity === 'severe' ? ' active severe' : ''}`}
              onClick={() => setForm(f => ({ ...f, severity: 'severe' }))}>Severe</button>
          </div>
        </div>

        <div className="add-field">
          <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">
            <input type="checkbox" className="size-4 accent-[#1e2229]" checked={form.doctorVisited}
              onChange={e => setForm(f => ({ ...f, doctorVisited: e.target.checked }))} />
            Visited a doctor
          </label>
          {form.doctorVisited && (
            <textarea className="add-input mt-2" rows={2} placeholder="Doctor notes (optional)"
              value={form.doctorNotes} onChange={e => setForm(f => ({ ...f, doctorNotes: e.target.value }))} />
          )}
        </div>

        <div className="add-field">
          <label className="add-label">Start Date</label>
          <input className="add-input" type="date"
            value={form.startDate || istDateKey(Date.now())}
            onChange={e => setForm(f => ({ ...f, startDate: e.target.value }))} />
        </div>

        <div className="add-field">
          <label className="add-label">Recovery Date</label>
          <input className="add-input" type="date" disabled={form.stillRecovering}
            value={form.recoveryDate} onChange={e => setForm(f => ({ ...f, recoveryDate: e.target.value }))} />
          <label className="mt-2 flex items-center gap-2 text-xs font-medium text-slate-500">
            <input type="checkbox" className="size-4 accent-[#1e2229]" checked={form.stillRecovering}
              onChange={e => setForm(f => ({ ...f, stillRecovering: e.target.checked, recoveryDate: e.target.checked ? '' : f.recoveryDate }))} />
            Still recovering
          </label>
        </div>

        <div className="add-field">
          <label className="add-label">Notes (optional)</label>
          <textarea className="add-input" rows={3} placeholder="Anything else worth remembering"
            value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
        </div>
      </div>

      <div
        className="shrink-0 border-t border-black/5 px-6 pt-2.5"
        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
      >
        {hasAnyAttachment && (
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
  )
}

// Episodes list + calendar + full-screen compose — a self-contained screen following
// JournalEntriesScreen's default-export shape exactly (list state at the top, `draft`
// non-null switches to the compose view). Local-only, persisted straight to IndexedDB via
// localData.js's health-episode helpers — no sendMsg/session, matching this module's
// approved plan of dropping the WS-message-passing convention entirely.
export default function HealthEpisodesListScreen({ onBack }) {
  const [episodes, setEpisodes] = useState([])
  const [draft, setDraft] = useState(null)
  const calendarState = useHealthCalendar(episodes)

  useEffect(() => {
    localData.getHealthData().then((data) => setEpisodes(data.episodes || []))
  }, [])

  const sortedEpisodes = useMemo(
    () => [...episodes].sort((a, b) => (b.startDate || 0) - (a.startDate || 0)),
    [episodes]
  )
  const filteredEpisodes = useMemo(() => {
    if (!calendarState.selectedDayKey) return sortedEpisodes
    return sortedEpisodes.filter(e => {
      const startKey = istDateKey(e.startDate)
      const endKey = istDateKey(e.recoveryDate ?? Date.now())
      return calendarState.selectedDayKey >= startKey && calendarState.selectedDayKey <= endKey
    })
  }, [sortedEpisodes, calendarState.selectedDayKey])

  function openAddEpisode() {
    setDraft({ ...EMPTY_EPISODE_FORM, startDate: istDateKey(Date.now()) })
  }
  function openEditEpisode(episode) {
    setDraft({
      id: episode.id,
      title: episode.title || '',
      symptoms: episode.symptoms || [],
      symptomInput: '',
      treatments: episode.treatments || [],
      treatmentName: '',
      treatmentDosage: '',
      treatmentNotes: '',
      severity: episode.severity || 'mild',
      doctorVisited: !!episode.doctorVisited,
      doctorNotes: episode.doctorNotes || '',
      startDate: istDateKey(episode.startDate),
      recoveryDate: episode.recoveryDate != null ? istDateKey(episode.recoveryDate) : '',
      stillRecovering: episode.recoveryDate == null,
      notes: episode.notes || '',
    })
  }

  // Attachments (photos/videos/voices/files) are local-only, stored in IndexedDB via
  // localData's health-media helpers — independent of the episode record itself.
  async function submitEpisode(form, attachments = {}) {
    const title = form.title.trim()
    if (!title) return
    const startDate = istDateInputToMs(form.startDate || istDateKey(Date.now()))
    const recoveryDate = form.stillRecovering ? null : (form.recoveryDate ? istDateInputToMs(form.recoveryDate) : null)
    const payload = {
      title,
      symptoms: form.symptoms,
      treatments: form.treatments,
      severity: form.severity,
      doctorVisited: form.doctorVisited,
      doctorNotes: form.doctorVisited ? form.doctorNotes.trim() : '',
      startDate,
      recoveryDate,
      notes: form.notes.trim(),
    }
    const entryId = form.id || Math.random().toString(36).slice(2)

    const {
      newPhotoFiles = [], removedPhotoIds = [],
      newVideoFiles = [], removedVideoIds = [],
      newVoiceBlobs = [], removedVoiceIds = [],
      newDocFiles = [], removedFileIds = [],
    } = attachments

    for (const id of [...removedPhotoIds, ...removedVideoIds, ...removedVoiceIds, ...removedFileIds]) {
      await localData.deleteHealthMedia(id)
    }
    for (const file of newPhotoFiles) {
      await localData.addHealthMedia({ entryId, entryType: 'episode', kind: 'photo', blob: file })
    }
    for (const file of newVideoFiles) {
      await localData.addHealthMedia({ entryId, entryType: 'episode', kind: 'video', blob: file })
    }
    for (const blob of newVoiceBlobs) {
      await localData.addHealthMedia({ entryId, entryType: 'episode', kind: 'voice', blob })
    }
    for (const doc of newDocFiles) {
      await localData.addHealthMedia({ entryId, entryType: 'episode', kind: 'file', blob: doc.file, name: doc.name })
    }

    const remainingMedia = await localData.getHealthMediaForEntry(entryId, 'episode')
    const counts = {
      photoCount: remainingMedia.filter(m => m.kind === 'photo').length,
      videoCount: remainingMedia.filter(m => m.kind === 'video').length,
      voiceCount: remainingMedia.filter(m => m.kind === 'voice').length,
      fileCount: remainingMedia.filter(m => m.kind === 'file').length,
    }

    if (form.id) {
      const updated = await localData.updateHealthEpisode({ ...payload, id: entryId })
      setEpisodes(prev => prev.map(e => e.id === entryId ? { ...updated, ...counts } : e))
    } else {
      const created = await localData.addHealthEpisode({ ...payload, id: entryId })
      setEpisodes(prev => [{ ...created, ...counts }, ...prev])
    }
    setDraft(null)
  }

  async function deleteEpisode(id) {
    await localData.deleteHealthEpisode(id)
    setEpisodes(prev => prev.filter(e => e.id !== id))
    setDraft(null)
  }

  if (draft) {
    return (
      <ComposeScreen
        draft={draft}
        onBack={() => setDraft(null)}
        onSubmit={submitEpisode}
        onDelete={draft.id ? () => deleteEpisode(draft.id) : undefined}
      />
    )
  }

  return (
    <div className="journal-screen surface-sand flex-1 min-h-0 overflow-y-auto flex flex-col font-sans text-slate-800">
      <div className="flex shrink-0 items-center justify-between px-4 py-2.5">
        <button type="button" onClick={onBack} aria-label="Back" className="grid size-9 shrink-0 place-items-center">
          <BackArrow />
        </button>
        <h1 className="text-[19px] font-bold tracking-tight text-slate-900">Episodes</h1>
        <div className="size-9" />
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-4 pt-2">
        <div className="rounded-3xl border border-black/[0.03] bg-white p-4 shadow-[0_2px_10px_rgba(0,0,0,0.03)]">
          <HealthCalendarHeader state={calendarState} />
          <HealthCalendarGrid state={calendarState} />
        </div>

        <div className="mt-5 flex items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
            Episodes{calendarState.selectedDayKey ? ' · filtered' : ''}
          </span>
          {calendarState.selectedDayKey && (
            <button type="button" onClick={() => calendarState.selectDay(calendarState.selectedDayKey)} className="text-xs font-semibold text-slate-500">
              Clear filter
            </button>
          )}
        </div>

        <div className="mt-3 flex flex-col gap-3.5">
          {episodes.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <span className="material-symbols-outlined text-4xl text-slate-300">health_and_safety</span>
              <p className="font-semibold text-slate-700">No episodes yet</p>
              <p className="text-sm text-slate-400">Tap the button below to log an illness</p>
            </div>
          ) : filteredEpisodes.length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-400">No episodes active on this day.</p>
          ) : (
            filteredEpisodes.map(e => (
              <EpisodeRow key={e.id} e={e} onSelect={() => openEditEpisode(e)} />
            ))
          )}
        </div>
      </div>

      <div className="shrink-0 px-6 pb-6 pt-2">
        <button
          type="button"
          onClick={openAddEpisode}
          className="flex w-full items-center justify-center gap-1.5 rounded-full bg-[#1e2229] px-6 py-3.5 text-[15px] font-semibold text-white shadow-[0_8px_24px_-4px_rgba(30,34,41,0.28)] transition-all hover:opacity-90 active:scale-[0.985]"
        >
          <PlusIcon />
          Log an illness
        </button>
      </div>
    </div>
  )
}
