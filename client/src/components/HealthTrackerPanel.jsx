import { useState, useEffect, useMemo } from 'react'
import { PageShell } from './PageShell'
import SwipeCarousel from './SwipeCarousel'
import HealthEpisodesSection from './HealthEpisodesSection'
import HealthAnalyticsSection from './HealthAnalyticsSection'
import { getCache, setCache } from '../lib/offlineCache'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's other
// screens (KhatabookPanel.jsx, MilestonePanel.jsx, TransactionPanel.jsx) — kept as its own
// local copy here rather than shared, matching the established convention.
const IST_TZ = 'Asia/Kolkata'
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}
// Start of the IST calendar month `n` months before the one containing `ms` — same helper
// as KhatabookPanel.jsx's/TransactionPanel.jsx's sixMonthTrend, reused here for the
// episodes-per-month chart.
function istMonthStartMinus(ms, n) {
  const s = new Date(ms + IST_OFFSET_MS)
  return Date.UTC(s.getUTCFullYear(), s.getUTCMonth() - n, 1) - IST_OFFSET_MS
}
// --color-success / --color-warning / --color-destructive are static tokens straight from
// tailwind.css's @theme block — applyTheme() (utils/theme.js) never rewrites these, only
// --color-gold, the --chart-1..5 scale, and the light/dark neutrals. Hardcoding their known
// oklch values here matches KhatabookPanel.jsx's identical convention.
const SUCCESS_COLOR = 'oklch(0.55 0.115 158)'
const WARNING_COLOR = 'oklch(0.68 0.13 62)'
const DESTRUCTIVE_COLOR = 'oklch(0.556 0.185 25)'

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

// Family health/illness tracker — self-service only, one episode per illness/injury with
// symptoms, treatments, severity, doctor visit info and a start/recovery date range. Follows
// KhatabookPanel.jsx's shape closely: this Panel owns all state/WS wiring/derived stats and
// hands them down as props to two "pure presentational" section components (episodes list +
// calendar, then analytics), matching the "who owns what" split already established there.
const EMPTY_REMINDER_FORM = { id: null, title: '', dueDate: '', repeats: false, repeatDays: '30', notes: '' }

export default function HealthTrackerPanel({ session, sendMsg, addListener, onHome, onProfileOpen }) {
  // Seeded from cache so something real renders even offline, before health_data_get's
  // reply (or lack thereof) arrives.
  const cachedHealthData = getCache('health_data', session.userId)
  const [episodes, setEpisodes] = useState(() => cachedHealthData?.episodes || [])
  const [sheetMode, setSheetMode] = useState(null) // null | 'add' | 'edit'
  const [form, setForm] = useState(EMPTY_EPISODE_FORM)
  const [reminders, setReminders] = useState(() => cachedHealthData?.reminders || [])
  const [reminderSheetMode, setReminderSheetMode] = useState(null) // null | 'add' | 'edit'
  const [reminderForm, setReminderForm] = useState(EMPTY_REMINDER_FORM)

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'health_data') {
        setEpisodes(msg.episodes || [])
        setReminders(msg.reminders || [])
        setCache('health_data', session.userId, {
          episodes: msg.episodes || [], reminders: msg.reminders || [],
        })
      }
    })
  }, [addListener])

  useEffect(() => {
    sendMsg({ type: 'health_data_get' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sortedEpisodes = useMemo(
    () => [...episodes].sort((a, b) => (b.startDate || 0) - (a.startDate || 0)),
    [episodes]
  )

  // ── Stat row (episodes-per-month/active/avg-recovery) ──────────────────────
  const activeCount = useMemo(() => episodes.filter(e => e.recoveryDate == null).length, [episodes])
  const totalCount = episodes.length
  const avgRecoveryDays = useMemo(() => {
    const resolved = episodes.filter(e => e.recoveryDate != null)
    if (resolved.length === 0) return 0
    const total = resolved.reduce((s, e) => s + Math.max(0, (e.recoveryDate - e.startDate) / 86400000), 0)
    return Math.round((total / resolved.length) * 10) / 10
  }, [episodes])
  const thisMonthCount = useMemo(() => {
    const now = new Date(Date.now() + IST_OFFSET_MS)
    const y = now.getUTCFullYear(), m = now.getUTCMonth()
    return episodes.filter(e => {
      const d = new Date(e.startDate + IST_OFFSET_MS)
      return d.getUTCFullYear() === y && d.getUTCMonth() === m
    }).length
  }, [episodes])

  // Real 6-month episodes-per-month trend, aggregated from actual episode start dates —
  // same full-calendar-month bucketing as KhatabookPanel.jsx's sixMonthTrend.
  const episodesPerMonth = useMemo(() => {
    const months = []
    for (let i = 5; i >= 0; i--) {
      const start = istMonthStartMinus(Date.now(), i)
      const end = istMonthStartMinus(Date.now(), i - 1)
      const count = episodes.filter(e => e.startDate >= start && e.startDate < end).length
      const label = new Date(start).toLocaleDateString('en-IN', { timeZone: IST_TZ, month: 'short' })
      months.push({ label, count })
    }
    return months
  }, [episodes])

  // Top 5 most common symptoms across every logged episode.
  const topSymptoms = useMemo(() => {
    const counts = {}
    episodes.forEach(e => (e.symptoms || []).forEach(s => { counts[s] = (counts[s] || 0) + 1 }))
    return Object.entries(counts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
  }, [episodes])

  // Severity breakdown donut — a small floor value on each slice keeps the pie from
  // collapsing to a sliver when a severity has zero episodes, same trick as Khatabook's
  // receivable/payable pieData (Math.max(value, 0.01)).
  const severityBreakdown = useMemo(() => {
    const counts = { mild: 0, moderate: 0, severe: 0 }
    episodes.forEach(e => { if (counts[e.severity] != null) counts[e.severity]++ })
    return [
      { id: 0, label: 'Mild', value: Math.max(counts.mild, 0.01), count: counts.mild, color: SUCCESS_COLOR },
      { id: 1, label: 'Moderate', value: Math.max(counts.moderate, 0.01), count: counts.moderate, color: WARNING_COLOR },
      { id: 2, label: 'Severe', value: Math.max(counts.severe, 0.01), count: counts.severe, color: DESTRUCTIVE_COLOR },
    ]
  }, [episodes])

  // Average recovery duration per severity, resolved episodes only — a simple companion to
  // the overall avgRecoveryDays stat above, one bar per severity level.
  const recoveryBySeverity = useMemo(() => {
    return ['mild', 'moderate', 'severe'].map(level => {
      const resolved = episodes.filter(e => e.severity === level && e.recoveryDate != null)
      const days = resolved.length
        ? Math.round((resolved.reduce((s, e) => s + (e.recoveryDate - e.startDate) / 86400000, 0) / resolved.length) * 10) / 10
        : 0
      return { name: level.charAt(0).toUpperCase() + level.slice(1), days }
    })
  }, [episodes])

  function openAddEpisode() {
    setForm({ ...EMPTY_EPISODE_FORM, startDate: istDateKey(Date.now()) })
    setSheetMode('add')
  }

  function openEditEpisode(episode) {
    setForm({
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
    setSheetMode('edit')
  }

  function closeSheet() {
    setSheetMode(null)
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

  function submitEpisode() {
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
    if (form.id) {
      const updated = { ...payload, id: form.id }
      setEpisodes(prev => prev.map(e => e.id === updated.id ? updated : e))
      sendMsg({ type: 'health_episode_update', episode: updated })
    } else {
      const episode = { ...payload, id: Math.random().toString(36).slice(2) }
      setEpisodes(prev => [episode, ...prev])
      sendMsg({ type: 'health_episode_add', episode })
    }
    setSheetMode(null)
  }

  function deleteEpisode(id) {
    setEpisodes(prev => prev.filter(e => e.id !== id))
    sendMsg({ type: 'health_episode_delete', id })
    setSheetMode(null)
  }

  // Non-completed reminders, soonest due first — one-time reminders that were marked done
  // (completed: true) drop out here but stay in the table for history; recurring ones never
  // get a completed flag, their dueDate just advances (see markReminderDone below).
  const upcomingReminders = useMemo(
    () => reminders.filter(r => !r.completed).sort((a, b) => a.dueDate - b.dueDate),
    [reminders]
  )

  function openAddReminder() {
    setReminderForm({ ...EMPTY_REMINDER_FORM, dueDate: istDateKey(Date.now()) })
    setReminderSheetMode('add')
  }

  function openEditReminder(reminder) {
    setReminderForm({
      id: reminder.id,
      title: reminder.title || '',
      dueDate: istDateKey(reminder.dueDate),
      repeats: reminder.repeatDays != null,
      repeatDays: reminder.repeatDays != null ? String(reminder.repeatDays) : '30',
      notes: reminder.notes || '',
    })
    setReminderSheetMode('edit')
  }

  function closeReminderSheet() {
    setReminderSheetMode(null)
  }

  function submitReminder() {
    const title = reminderForm.title.trim()
    if (!title) return
    const payload = {
      title,
      dueDate: istDateInputToMs(reminderForm.dueDate || istDateKey(Date.now())),
      repeatDays: reminderForm.repeats ? (parseInt(reminderForm.repeatDays, 10) || 30) : null,
      notes: reminderForm.notes.trim(),
      completed: false,
    }
    if (reminderForm.id) {
      const updated = { ...payload, id: reminderForm.id }
      setReminders(prev => prev.map(r => r.id === updated.id ? updated : r))
      sendMsg({ type: 'health_reminder_update', reminder: updated })
    } else {
      const reminder = { ...payload, id: Math.random().toString(36).slice(2) }
      setReminders(prev => [reminder, ...prev])
      sendMsg({ type: 'health_reminder_add', reminder })
    }
    setReminderSheetMode(null)
  }

  function deleteReminder(id) {
    setReminders(prev => prev.filter(r => r.id !== id))
    sendMsg({ type: 'health_reminder_delete', id })
    setReminderSheetMode(null)
  }

  // A recurring reminder just rolls its dueDate forward by repeatDays and stays active; a
  // one-time reminder gets completed:true and disappears from upcomingReminders for good.
  function markReminderDone(reminder) {
    const updated = reminder.repeatDays
      ? { ...reminder, dueDate: reminder.dueDate + reminder.repeatDays * 86400000 }
      : { ...reminder, completed: true }
    setReminders(prev => prev.map(r => r.id === updated.id ? updated : r))
    sendMsg({ type: 'health_reminder_update', reminder: updated })
  }

  const sectionProps = {
    episodes,
    sortedEpisodes,
    activeCount,
    totalCount,
    avgRecoveryDays,
    thisMonthCount,
    onOpenEpisode: openEditEpisode,
    onAddEpisode: openAddEpisode,
    upcomingReminders,
    onAddReminder: openAddReminder,
    onOpenReminder: openEditReminder,
    onMarkReminderDone: markReminderDone,
  }
  const analyticsProps = {
    episodes,
    episodesPerMonth,
    topSymptoms,
    severityBreakdown,
    avgRecoveryDays,
    recoveryBySeverity,
  }

  return (
    // `health-screen` is kept on this outer wrapper purely as a CSS targeting hook, the same
    // way KhatabookPanel.jsx uses `khata-screen` — index.css's shared add-txn-sheet gold-theme
    // overrides and material-symbols font-face both key off it. PageShell itself renders the
    // actual `surface-sand` scroll container inside.
    <div className="health-screen font-sans">
      <PageShell
        eyebrow="Module 05"
        title="Health"
        lead="Track illnesses and recoveries for the family — symptoms, treatments and doctor visits, with a calendar and trends."
        onHome={onHome}
        session={session}
        sendMsg={sendMsg}
        addListener={addListener}
        showProfile
        onProfileOpen={onProfileOpen}
        action={
          <div className="tile-static hidden shrink-0 px-5 py-3 text-right sm:block">
            <p className="num text-2xl font-extrabold text-foreground">{activeCount}</p>
            <p className="text-[11px] text-muted-foreground">active illness{activeCount !== 1 ? 'es' : ''}</p>
          </div>
        }
      >
        {/* Mobile: two swipeable pages (episodes + calendar, then analytics), matching
            Khatabook/Milestones' split. Desktop: both sections stacked.
            140px = PageShell's mobile header through BottomNav, measured with Playwright
            (getBoundingClientRect on this div vs BottomNav's <nav> — carousel bottom must
            equal nav top). Re-measured after CornerMenu moved from a floating fixed trigger
            to mounting inline in PageShell's header row, which shrank the header from pt-16
            to pt-6 — that migration should have dropped this from 184 to 140 but was missed at
            the time, leaving a 44px dead gap above BottomNav until caught during the Journal
            module build. Re-measure if PageShell's header height or this page's action-pill
            content ever changes. */}
        <div className="md:hidden" style={{ height: 'calc(100dvh - 140px)' }}>
          <SwipeCarousel hintNext="Swipe left for analytics →" hintPrev="Swipe right for episodes →">
            <HealthEpisodesSection {...sectionProps} />
            <HealthAnalyticsSection {...analyticsProps} />
          </SwipeCarousel>
        </div>

        {/* Floating "Add episode" — mobile only, matching Khatabook's exact FAB geometry.
            Placed as a sibling of the carousel, not inside it — a fixed-position element
            inside SwipeCarousel's translateX(...) container would anchor to that transformed
            ancestor instead of the viewport. */}
        <button
          type="button"
          aria-label="Add episode"
          onClick={openAddEpisode}
          className="fixed right-5 bottom-[90px] z-40 grid size-14 place-items-center rounded-full bg-[image:var(--gradient-gold)] text-white shadow-[var(--shadow-glow)] transition-transform active:scale-95 md:hidden"
        >
          <span className="material-symbols-outlined text-2xl">add</span>
        </button>

        <div className="hidden md:flex md:flex-col md:gap-4">
          <HealthEpisodesSection {...sectionProps} />
          <HealthAnalyticsSection {...analyticsProps} />
        </div>
      </PageShell>

      {sheetMode && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && closeSheet()}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{sheetMode === 'edit' ? 'Edit Episode' : 'Add Episode'}</span>
              <button className="add-txn-close" onClick={closeSheet}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

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
                  className="shrink-0 rounded-xl bg-secondary px-4 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70">
                  Add
                </button>
              </div>
              {form.symptoms.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {form.symptoms.map((s, i) => (
                    <span key={i} className="flex items-center gap-1 rounded-full bg-gold-soft py-1 pl-2.5 pr-1.5 text-xs font-semibold text-gold">
                      {s}
                      <button type="button" onClick={() => removeSymptom(i)} aria-label={`Remove ${s}`}
                        className="grid size-4 shrink-0 place-items-center rounded-full text-gold/70 hover:text-gold">
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
                  className="shrink-0 rounded-xl bg-secondary px-4 text-sm font-semibold text-foreground transition-colors hover:bg-secondary/70">
                  Add
                </button>
              </div>
              {form.treatments.length > 0 && (
                <div className="mt-2 flex flex-col gap-1.5">
                  {form.treatments.map((t, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-xl bg-secondary/60 px-3 py-2 text-xs">
                      <span className="min-w-0 flex-1 truncate text-foreground">
                        <span className="font-semibold">{t.name}</span>
                        {t.dosage ? ` · ${t.dosage}` : ''}
                        {t.notes ? <span className="text-muted-foreground"> · {t.notes}</span> : null}
                      </span>
                      <button type="button" onClick={() => removeTreatment(i)} aria-label={`Remove ${t.name}`}
                        className="shrink-0 text-muted-foreground transition-colors hover:text-destructive">
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
              <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <input type="checkbox" className="size-4 accent-gold" checked={form.doctorVisited}
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
              <label className="mt-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <input type="checkbox" className="size-4 accent-gold" checked={form.stillRecovering}
                  onChange={e => setForm(f => ({ ...f, stillRecovering: e.target.checked, recoveryDate: e.target.checked ? '' : f.recoveryDate }))} />
                Still recovering
              </label>
            </div>

            <div className="add-field">
              <label className="add-label">Notes (optional)</label>
              <textarea className="add-input" rows={3} placeholder="Anything else worth remembering"
                value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitEpisode} disabled={!form.title.trim()}>
              {sheetMode === 'edit' ? 'Save Changes' : 'Add Episode'}
            </button>
            {sheetMode === 'edit' && (
              <button className="add-txn-delete" onClick={() => deleteEpisode(form.id)}>
                Delete Episode
              </button>
            )}
          </div>
        </div>
      )}

      {reminderSheetMode && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && closeReminderSheet()}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{reminderSheetMode === 'edit' ? 'Edit Reminder' : 'Add Reminder'}</span>
              <button className="add-txn-close" onClick={closeReminderSheet}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Title</label>
              <input className="add-input" type="text" placeholder="e.g. Multivitamin refill"
                value={reminderForm.title} onChange={e => setReminderForm(f => ({ ...f, title: e.target.value }))} autoFocus />
            </div>

            <div className="add-field">
              <label className="add-label">Due Date</label>
              <input className="add-input" type="date"
                value={reminderForm.dueDate || istDateKey(Date.now())}
                onChange={e => setReminderForm(f => ({ ...f, dueDate: e.target.value }))} />
            </div>

            <div className="add-field">
              <label className="flex items-center gap-2 text-sm font-semibold text-foreground">
                <input type="checkbox" className="size-4 accent-gold" checked={reminderForm.repeats}
                  onChange={e => setReminderForm(f => ({ ...f, repeats: e.target.checked }))} />
                Repeats
              </label>
              {reminderForm.repeats && (
                <div className="mt-2 flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Every</span>
                  <input className="add-input w-20" type="number" min="1" inputMode="numeric"
                    value={reminderForm.repeatDays}
                    onChange={e => setReminderForm(f => ({ ...f, repeatDays: e.target.value }))} />
                  <span className="text-sm text-muted-foreground">days</span>
                </div>
              )}
            </div>

            <div className="add-field">
              <label className="add-label">Notes (optional)</label>
              <textarea className="add-input" rows={2} placeholder="Pharmacy, doctor's name, anything else"
                value={reminderForm.notes} onChange={e => setReminderForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitReminder} disabled={!reminderForm.title.trim()}>
              {reminderSheetMode === 'edit' ? 'Save Changes' : 'Add Reminder'}
            </button>
            {reminderSheetMode === 'edit' && (
              <button className="add-txn-delete" onClick={() => deleteReminder(reminderForm.id)}>
                Delete Reminder
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
