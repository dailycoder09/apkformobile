import { useState, useEffect, useMemo } from 'react'
import { PageShell } from './PageShell'
import SwipeCarousel from './SwipeCarousel'
import JournalEntriesSection from './JournalEntriesSection'
import JournalAnalyticsSection from './JournalAnalyticsSection'
import { TAG_PALETTE, MOOD_ORDER, moodEmoji, moodLabel, moodScore } from '../utils/journalFormat'
import { getCache, setCache } from '../lib/offlineCache'

// Same "don't trust the browser's own timezone" pattern duplicated across this app's other
// screens (KhatabookPanel.jsx, HealthTrackerPanel.jsx, MilestonePanel.jsx) — kept as its own
// local copy here rather than shared, matching the established convention.
const IST_TZ = 'Asia/Kolkata'
function istDateKey(ms) {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: IST_TZ }) // YYYY-MM-DD
}
function istDateInputToMs(dateStr) {
  return new Date(`${dateStr}T00:00:00+05:30`).getTime()
}

const DAY_MS = 24 * 60 * 60 * 1000

// --color-success / --color-warning / --color-destructive are static tokens straight from
// tailwind.css's @theme block — applyTheme() (utils/theme.js) never rewrites these, only
// --color-gold, the --chart-1..5 scale, and the light/dark neutrals. Hardcoding their known
// oklch values here matches KhatabookPanel.jsx's/HealthTrackerPanel.jsx's identical convention.
const SUCCESS_COLOR = 'oklch(0.55 0.115 158)'
const WARNING_COLOR = 'oklch(0.68 0.13 62)'
const DESTRUCTIVE_COLOR = 'oklch(0.556 0.185 25)'

const EMPTY_FORM = { id: null, date: '', mood: 'okay', energy: 3, sleepHours: '', tags: [], notes: '' }

// Daily mood/notes check-in — a private self-only journal (mood, energy, sleep hours, tags,
// free text), one entry per day by convention but not enforced server-side (same "just a
// flat list" approach as every other module's table). Follows KhatabookPanel.jsx's shape
// closely: this Panel owns all state/WS wiring/derived stats and hands them down as props to
// two "pure presentational" section components (entries list, then analytics), matching the
// "who owns what" split already established there. No admin view exists for this module at
// all (unlike Milestones/Health) — never broadcast, never surfaced to a parent.
export default function JournalPanel({ session, sendMsg, addListener, onHome, onProfileOpen }) {
  // Seeded from cache so something real renders even offline, before the live replies
  // (or lack thereof) arrive. namaz_data's cache entry is shared with NamazTracker.jsx —
  // same raw shape, either screen can populate or refresh it.
  const [entries, setEntries] = useState(() => getCache('journal_data', session.userId)?.entries || [])
  const [sheetMode, setSheetMode] = useState(null) // null | 'add' | 'edit'
  const [form, setForm] = useState(EMPTY_FORM)
  // Read-only cross-reference against Namaz's per-day prayer log (namaz_days, see
  // NamazTracker.jsx) — fetched here purely to compute the "Mood & Prayer" correlation tile
  // below. Journal never writes to this data, only reads it.
  const [namazDays, setNamazDays] = useState(() => getCache('namaz_data', session.userId)?.days || [])

  useEffect(() => {
    return addListener((msg) => {
      if (msg.type === 'journal_data') {
        setEntries(msg.entries || [])
        setCache('journal_data', session.userId, { entries: msg.entries || [] })
      }
      if (msg.type === 'namaz_data') {
        setNamazDays(msg.days || [])
        setCache('namaz_data', session.userId, { days: msg.days || [], qada: msg.qada })
      }
    })
  }, [addListener])

  useEffect(() => {
    sendMsg({ type: 'journal_data_get' })
    sendMsg({ type: 'namaz_data_get' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sortedEntries = useMemo(
    () => [...entries].sort((a, b) => b.date - a.date),
    [entries]
  )

  // ── Stat row (Page 1) ──
  const avgMood30d = useMemo(() => {
    const cutoff = Date.now() - 30 * DAY_MS
    const recent = entries.filter(e => e.date >= cutoff)
    if (recent.length === 0) return null
    return recent.reduce((s, e) => s + moodScore(e.mood), 0) / recent.length
  }, [entries])

  // Consecutive IST calendar days with at least one entry, ending today or yesterday — a
  // streak that already has today logged keeps counting from today; one that doesn't but
  // still has yesterday logged is still "alive" (hasn't broken yet, just not logged today).
  const streak = useMemo(() => {
    const dateKeys = new Set(entries.map(e => istDateKey(e.date)))
    let cursor = Date.now()
    if (!dateKeys.has(istDateKey(cursor))) {
      cursor -= DAY_MS
      if (!dateKeys.has(istDateKey(cursor))) return 0
    }
    let count = 0
    while (dateKeys.has(istDateKey(cursor))) {
      count++
      cursor -= DAY_MS
    }
    return count
  }, [entries])

  const avgSleep = useMemo(() => {
    if (entries.length === 0) return null
    return entries.reduce((s, e) => s + (e.sleepHours || 0), 0) / entries.length
  }, [entries])

  const topTheme = useMemo(() => {
    const counts = {}
    entries.forEach(e => (e.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1 }))
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
    return sorted.length ? sorted[0][0] : null
  }, [entries])

  // ── Analytics (Page 2) ──

  // Last 14 IST calendar days, one point per day. Days with no entry stay null (not 0) so
  // the AreaChart shows a genuine gap rather than a false dip to zero; days with more than
  // one entry (uniqueness isn't enforced) average across them.
  const moodEnergyTrend = useMemo(() => {
    const byDay = {}
    entries.forEach(e => {
      const key = istDateKey(e.date)
      if (!byDay[key]) byDay[key] = []
      byDay[key].push(e)
    })
    const days = []
    for (let i = 13; i >= 0; i--) {
      const ms = Date.now() - i * DAY_MS
      const key = istDateKey(ms)
      const dayEntries = byDay[key] || []
      const mood = dayEntries.length ? dayEntries.reduce((s, e) => s + moodScore(e.mood), 0) / dayEntries.length : null
      const energy = dayEntries.length ? dayEntries.reduce((s, e) => s + (e.energy || 0), 0) / dayEntries.length : null
      days.push({ label: new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' }), mood, energy })
    }
    return days
  }, [entries])

  // 3-slice donut: great+good / okay / low+rough. A small floor value keeps a slice from
  // collapsing to nothing when its count is exactly zero, same trick as Khatabook's pieData
  // — `count` is kept alongside for the tooltip/legend so it shows the real 0, not 0.01.
  const moodSplit = useMemo(() => {
    let positive = 0, neutral = 0, tough = 0
    entries.forEach(e => {
      if (e.mood === 'great' || e.mood === 'good') positive++
      else if (e.mood === 'okay') neutral++
      else tough++
    })
    return [
      { id: 0, label: 'Positive', count: positive, value: Math.max(positive, 0.01), color: SUCCESS_COLOR },
      { id: 1, label: 'Neutral', count: neutral, value: Math.max(neutral, 0.01), color: WARNING_COLOR },
      { id: 2, label: 'Tough', count: tough, value: Math.max(tough, 0.01), color: DESTRUCTIVE_COLOR },
    ]
  }, [entries])

  // Rolling last-7-days digest — count, averages, top themes, and the single best/worst day
  // by mood score. Null when nothing was logged this week so the tile can render its own
  // empty state instead of dividing by zero.
  const weeklyDigest = useMemo(() => {
    const cutoff = Date.now() - 7 * DAY_MS
    const weekEntries = entries.filter(e => e.date >= cutoff)
    if (weekEntries.length === 0) return null
    const avgMoodScore = weekEntries.reduce((s, e) => s + moodScore(e.mood), 0) / weekEntries.length
    const avgEnergy = weekEntries.reduce((s, e) => s + (e.energy || 0), 0) / weekEntries.length
    const avgSleepWeek = weekEntries.reduce((s, e) => s + (e.sleepHours || 0), 0) / weekEntries.length
    const tagCounts = {}
    weekEntries.forEach(e => (e.tags || []).forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1 }))
    const topThemes = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t)
    const best = weekEntries.reduce((b, e) => (!b || moodScore(e.mood) > moodScore(b.mood)) ? e : b, null)
    const worst = weekEntries.reduce((w, e) => (!w || moodScore(e.mood) < moodScore(w.mood)) ? e : w, null)
    return {
      count: weekEntries.length,
      avgMoodScore,
      avgEnergy,
      avgSleep: avgSleepWeek,
      topThemes,
      bestDate: best?.date ?? null,
      worstDate: worst?.date ?? null,
    }
  }, [entries])

  // Avg mood-score per tag across ALL entries, surfacing whichever tag correlates most
  // negatively with mood — only once it has at least 5 tagged entries behind it, so a single
  // bad day tagged "Money" doesn't read as a confident pattern.
  const moodHint = useMemo(() => {
    const byTag = {}
    entries.forEach(e => {
      (e.tags || []).forEach(t => {
        if (!byTag[t]) byTag[t] = []
        byTag[t].push(moodScore(e.mood))
      })
    })
    const qualifying = Object.entries(byTag)
      .filter(([, scores]) => scores.length >= 5)
      .map(([tag, scores]) => ({ tag, avg: scores.reduce((s, v) => s + v, 0) / scores.length }))
    if (qualifying.length === 0) return null
    const lowest = qualifying.reduce((min, c) => c.avg < min.avg ? c : min, qualifying[0])
    return `${lowest.tag} days tend to be your lowest — avg mood ${lowest.avg.toFixed(1)}`
  }, [entries])

  const NAMAZ_PRAYER_KEYS = ['fajr', 'dhuhr', 'asr', 'maghrib', 'isha']

  // Cross-references Journal entries against Namaz's per-day prayer log for the same
  // calendar date (matched via istDateKey on both sides, same IST-day convention this whole
  // app already assumes elsewhere) — a read-only lens on two modules' data, not a new fact
  // either module stores. "Completed" means all 5 prayers logged 'ontime' that day; a day
  // with any 'kaza'/unmarked prayer counts as "missed one or more", even if that Qada was
  // later paid off — this is about how the day itself went, not the backlog. Requires at
  // least 5 overlapping days with data on BOTH sides, and at least one day in each bucket, so
  // a single day doesn't read as a confident pattern (same floor as moodHint above).
  const namazMoodCorrelation = useMemo(() => {
    const namazByDay = {}
    namazDays.forEach((d) => { namazByDay[d.id] = d })
    const fullDayScores = []
    const partialDayScores = []
    entries.forEach((e) => {
      const day = namazByDay[istDateKey(e.date)]
      if (!day) return
      const allOnTime = NAMAZ_PRAYER_KEYS.every((k) => day[k] && day[k].status === 'ontime')
      ;(allOnTime ? fullDayScores : partialDayScores).push(moodScore(e.mood))
    })
    const overlap = fullDayScores.length + partialDayScores.length
    if (overlap < 5 || fullDayScores.length === 0 || partialDayScores.length === 0) return null
    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length
    return { fullAvg: avg(fullDayScores), partialAvg: avg(partialDayScores), overlap }
  }, [entries, namazDays])

  const tagFrequency = useMemo(() => {
    const counts = {}
    entries.forEach(e => (e.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1 }))
    return Object.entries(counts)
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
  }, [entries])

  function openAddEntry() {
    setForm({ ...EMPTY_FORM, date: istDateKey(Date.now()) })
    setSheetMode('add')
  }

  function openEditEntry(entry) {
    setForm({
      id: entry.id,
      date: istDateKey(entry.date),
      mood: entry.mood || 'okay',
      energy: entry.energy || 3,
      sleepHours: entry.sleepHours != null ? String(entry.sleepHours) : '',
      tags: entry.tags || [],
      notes: entry.notes || '',
    })
    setSheetMode('edit')
  }

  function toggleTag(tag) {
    setForm(f => ({ ...f, tags: f.tags.includes(tag) ? f.tags.filter(t => t !== tag) : [...f.tags, tag] }))
  }

  function submitEntry() {
    const dateMs = form.date ? istDateInputToMs(form.date) : Date.now()
    const sleepHours = parseFloat(form.sleepHours) || 0
    if (sheetMode === 'edit') {
      const existing = entries.find(e => e.id === form.id)
      const updated = {
        id: form.id,
        date: dateMs,
        mood: form.mood,
        energy: Number(form.energy),
        sleepHours,
        tags: form.tags,
        notes: form.notes.trim(),
        createdAt: existing?.createdAt || Date.now(),
      }
      setEntries(prev => prev.map(e => e.id === updated.id ? updated : e))
      sendMsg({ type: 'journal_entry_update', entry: updated })
    } else {
      const entry = {
        id: Math.random().toString(36).slice(2),
        date: dateMs,
        mood: form.mood,
        energy: Number(form.energy),
        sleepHours,
        tags: form.tags,
        notes: form.notes.trim(),
        createdAt: Date.now(),
      }
      setEntries(prev => [entry, ...prev])
      sendMsg({ type: 'journal_entry_add', entry })
    }
    setSheetMode(null)
  }

  function deleteEntry(id) {
    setEntries(prev => prev.filter(e => e.id !== id))
    sendMsg({ type: 'journal_entry_delete', id })
    setSheetMode(null)
  }

  return (
    // `journal-screen` is kept on this outer wrapper (rather than merged into PageShell's own
    // root div) purely as a CSS targeting hook — index.css's global margin/padding reset and
    // the add-txn-sheet color overrides both key off `.journal-screen` / `.journal-screen *`.
    // PageShell itself renders the actual `surface-sand` scroll container inside.
    <div className="journal-screen font-sans">
      <PageShell
        eyebrow="Module 06"
        title="Journal"
        lead="A daily mood and notes check-in — log how the day went, build a streak, and see what your days are really about."
        onHome={onHome}
        back={true}
        session={session}
        sendMsg={sendMsg}
        addListener={addListener}
        showProfile
        onProfileOpen={onProfileOpen}
      >
        {/* 140px — NOT the 184px KhatabookPanel.jsx/HealthTrackerPanel.jsx/MilestonePanel.jsx
            use for the same style of carousel; measured directly for this page with
            Playwright (carousel wrapper's getBoundingClientRect().bottom vs BottomNav's
            <nav> top, until the two match exactly) rather than assumed. Re-measure the same
            way if this page's header content ever changes. */}
        <div className="md:hidden" style={{ height: 'calc(100dvh - 140px)' }}>
          <SwipeCarousel hintNext="Swipe left for analytics →" hintPrev="Swipe right for entries →">
            <JournalEntriesSection
              entries={sortedEntries}
              avgMood30d={avgMood30d}
              streak={streak}
              avgSleep={avgSleep}
              topTheme={topTheme}
              openAddEntry={openAddEntry}
              openEditEntry={openEditEntry}
            />
            <JournalAnalyticsSection
              entries={entries}
              moodEnergyTrend={moodEnergyTrend}
              moodSplit={moodSplit}
              weeklyDigest={weeklyDigest}
              moodHint={moodHint}
              tagFrequency={tagFrequency}
              namazMoodCorrelation={namazMoodCorrelation}
            />
          </SwipeCarousel>
        </div>

        {/* Floating "Add today" — mobile only, matching Khatabook's/Health's exact FAB
            geometry. Placed as a sibling of the carousel rather than inside it: a
            fixed-position element inside SwipeCarousel's translateX(...) container would
            anchor to that transformed ancestor instead of the viewport. */}
        <button
          type="button"
          aria-label="Add today"
          onClick={openAddEntry}
          className="fixed right-5 bottom-[90px] z-40 grid size-14 place-items-center rounded-full bg-[image:var(--gradient-gold)] text-white shadow-[var(--shadow-glow)] transition-transform active:scale-95 md:hidden"
        >
          <span className="material-symbols-outlined text-2xl">add</span>
        </button>

        <div className="hidden md:flex md:flex-col md:gap-4">
          <JournalEntriesSection
            entries={sortedEntries}
            avgMood30d={avgMood30d}
            streak={streak}
            avgSleep={avgSleep}
            topTheme={topTheme}
            openAddEntry={openAddEntry}
            openEditEntry={openEditEntry}
          />
          <JournalAnalyticsSection
            entries={entries}
            moodEnergyTrend={moodEnergyTrend}
            moodSplit={moodSplit}
            weeklyDigest={weeklyDigest}
            moodHint={moodHint}
            tagFrequency={tagFrequency}
            namazMoodCorrelation={namazMoodCorrelation}
          />
        </div>
      </PageShell>

      {sheetMode && (
        <div className="add-txn-overlay" onClick={e => e.target === e.currentTarget && setSheetMode(null)}>
          <div className="add-txn-sheet">
            <div className="add-txn-header">
              <span>{sheetMode === 'edit' ? 'Edit Entry' : 'Add Entry'}</span>
              <button className="add-txn-close" onClick={() => setSheetMode(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className="add-field">
              <label className="add-label">Date</label>
              <input className="add-input" type="date"
                value={form.date || istDateKey(Date.now())}
                onChange={e => setForm(f => ({ ...f, date: e.target.value }))} />
            </div>

            <div className="add-field">
              <label className="add-label">Mood</label>
              <div className="mood-toggle">
                {MOOD_ORDER.map(m => (
                  <button
                    key={m}
                    type="button"
                    className={`mood-btn${form.mood === m ? ` active mood-${m}` : ''}`}
                    onClick={() => setForm(f => ({ ...f, mood: m }))}
                  >
                    <span className="mood-btn-emoji">{moodEmoji(m)}</span>
                    <span>{moodLabel(m)}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="add-field">
              <label className="add-label">Energy — {form.energy}/5</label>
              <input
                type="range" min="1" max="5" step="1"
                className="h-2 w-full accent-gold"
                value={form.energy}
                onChange={e => setForm(f => ({ ...f, energy: Number(e.target.value) }))}
              />
            </div>

            <div className="add-field">
              <label className="add-label">Sleep Hours</label>
              <input className="add-input" type="number" inputMode="decimal" step="0.5" min="0" placeholder="e.g. 7"
                value={form.sleepHours} onChange={e => setForm(f => ({ ...f, sleepHours: e.target.value }))} />
            </div>

            <div className="add-field">
              <label className="add-label">Tags</label>
              <div className="category-grid">
                {TAG_PALETTE.map(tag => (
                  <button
                    key={tag}
                    type="button"
                    className={`cat-chip${form.tags.includes(tag) ? ' active' : ''}`}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="add-field">
              <label className="add-label">Notes (optional)</label>
              <textarea className="add-input" rows={3} placeholder="How did today go?"
                value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </div>

            <button className="add-txn-submit" onClick={submitEntry}>
              {sheetMode === 'edit' ? 'Save Changes' : 'Add Entry'}
            </button>
            {sheetMode === 'edit' && (
              <button className="add-txn-delete" onClick={() => deleteEntry(form.id)}>
                Delete Entry
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
