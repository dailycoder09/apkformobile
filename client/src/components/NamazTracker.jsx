import { useEffect, useMemo, useRef, useState } from 'react'
import { getPrayerTimes, CITY_PRESETS, tzOffsetHoursFromZone } from '../utils/prayerTimes'

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const STREAK_MILESTONES = [7, 30, 100]
const CONFETTI_COLORS = ['#1f4d43', '#d97706', '#7c9a8e', '#f4c95d']

const PRAYERS = [
  { key: 'fajr', en: 'Fajr', ar: 'الفجر' },
  { key: 'dhuhr', en: 'Dhuhr', ar: 'الظهر' },
  { key: 'asr', en: 'Asr', ar: 'العصر' },
  { key: 'maghrib', en: 'Maghrib', ar: 'المغرب' },
  { key: 'isha', en: 'Isha', ar: 'العشاء' },
]

const QUOTES = [
  { text: 'Establish prayer, for prayer restrains from indecency and wrongdoing.', ref: 'Quran 29:45' },
  { text: 'The first matter that the slave will be brought to account for on the Day of Judgment is the prayer.', ref: 'Hadith — Tirmidhi' },
  { text: 'Verily, in the remembrance of Allah do hearts find rest.', ref: 'Quran 13:28' },
  { text: 'The key to Paradise is prayer.', ref: 'Hadith — Tirmidhi' },
  { text: 'Prayer is the pillar of religion.', ref: 'Hadith — Bayhaqi' },
  { text: 'So woe to those who pray, but who are heedless of their prayer.', ref: 'Quran 107:4-5' },
  { text: 'Seek help through patience and prayer.', ref: 'Quran 2:45' },
  { text: 'Guard strictly your prayers, especially the middle prayer.', ref: 'Quran 2:238' },
  { text: 'Prayer has been decreed upon the believers a decree of specified times.', ref: 'Quran 4:103' },
  { text: 'The closest a servant comes to his Lord is when he is prostrating, so make much supplication then.', ref: 'Hadith — Muslim' },
  { text: 'Whoever guards the prayers will have light, proof, and salvation on the Day of Resurrection.', ref: 'Hadith — Ahmad' },
  { text: 'The five daily prayers wipe out the sins committed in between, so long as major sins are avoided.', ref: 'Hadith — Muslim' },
  { text: 'Seek help through patience and prayer. Indeed, Allah is with the patient.', ref: 'Quran 2:153' },
  { text: 'Successful indeed are the believers, those who humble themselves in their prayers.', ref: 'Quran 23:1-2' },
  { text: 'Between a man and disbelief is the abandonment of prayer.', ref: 'Hadith — Muslim' },
]

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function readNamaz() {
  try { return JSON.parse(localStorage.getItem('meeee_namaz') || '{}') } catch { return {} }
}

function formatTime(d) {
  return d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })
}

function formatCountdown(ms) {
  if (ms <= 0) return '00:00:00'
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':')
}

function dayOfYear(d) {
  const start = new Date(d.getFullYear(), 0, 0)
  return Math.floor((d - start) / 86400000)
}

// Prayer entry per day is stored as { status: 'ontime'|'kaza', reason?: string } | false.
// (Older data may have stored a plain `true`/`'kaza'` — read as the equivalent status with no reason.)
function getEntry(dayData, key) {
  const v = dayData?.[key]
  if (v && typeof v === 'object') return { status: v.status || null, reason: v.reason || '' }
  if (v === 'kaza') return { status: 'kaza', reason: '' }
  if (v) return { status: 'ontime', reason: '' }
  return { status: null, reason: '' }
}
function getStatus(dayData, key) {
  return getEntry(dayData, key).status
}

function isFullDay(dayData) {
  return !!dayData && PRAYERS.every((p) => !!getStatus(dayData, p.key))
}

function summarize(dayData) {
  let ontime = 0
  let kaza = 0
  PRAYERS.forEach((p) => {
    const s = getStatus(dayData, p.key)
    if (s === 'ontime') ontime++
    else if (s === 'kaza') kaza++
  })
  return { ontime, kaza, total: ontime + kaza }
}

export default function NamazTracker() {
  const [namazData, setNamazData] = useState(readNamaz)
  const [location, setLocation] = useState(null)
  const [locStatus, setLocStatus] = useState('idle')
  const [showPicker, setShowPicker] = useState(false)
  const [calendarMonth, setCalendarMonth] = useState(() => { const d = new Date(); d.setDate(1); return d })
  const [citySearch, setCitySearch] = useState('')
  const [cityResults, setCityResults] = useState([])
  const [citySearchStatus, setCitySearchStatus] = useState('idle') // idle | loading | error
  const [expandedPrayer, setExpandedPrayer] = useState(null)
  const [now, setNow] = useState(() => new Date())
  const [showAnalytics, setShowAnalytics] = useState(false)

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    const cached = localStorage.getItem('meeee_namaz_location')
    if (cached) {
      try { setLocation(JSON.parse(cached)); setLocStatus('ready'); return } catch { /* fall through */ }
    }
    if (!navigator.geolocation) { setShowPicker(true); setLocStatus('error'); return }
    setLocStatus('loading')
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          city: null,
        }
        localStorage.setItem('meeee_namaz_location', JSON.stringify(loc))
        setLocation(loc)
        setLocStatus('ready')
      },
      () => { setShowPicker(true); setLocStatus('error') },
      { timeout: 10000 }
    )
  }, [])

  // Debounced city-name search via Open-Meteo's free geocoding API
  useEffect(() => {
    const query = citySearch.trim()
    if (query.length < 2) { setCityResults([]); setCitySearchStatus('idle'); return }
    setCitySearchStatus('loading')
    const t = setTimeout(() => {
      fetch(`${GEOCODE_URL}?name=${encodeURIComponent(query)}&count=5&language=en&format=json`)
        .then((r) => r.json())
        .then((data) => {
          setCityResults(data.results || [])
          setCitySearchStatus('idle')
        })
        .catch(() => { setCityResults([]); setCitySearchStatus('error') })
    }, 400)
    return () => clearTimeout(t)
  }, [citySearch])

  const times = useMemo(() => {
    if (!location) return null
    const tzOffsetHours = location.tz ? tzOffsetHoursFromZone(location.tz) : (location.tzOffsetHours ?? 0)
    return getPrayerTimes(new Date(), location.lat, location.lng, tzOffsetHours)
  }, [location])

  const nextPrayer = useMemo(() => {
    if (!times || !location) return null
    for (const p of PRAYERS) {
      if (times[p.key] > now) return { key: p.key, en: p.en, time: times[p.key] }
    }
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tzOffsetHours = location.tz ? tzOffsetHoursFromZone(location.tz) : (location.tzOffsetHours ?? 0)
    const tomorrowTimes = getPrayerTimes(tomorrow, location.lat, location.lng, tzOffsetHours)
    return { key: 'fajr', en: 'Fajr', time: tomorrowTimes.fajr }
  }, [times, location, now])

  const todayData = namazData[todayKey()] || {}

  function setStatus(prayerKey, status) {
    const key = todayKey()
    setNamazData((prev) => {
      const day = { ...(prev[key] || {}) }
      const entry = getEntry(day, prayerKey)
      const nextStatus = entry.status === status ? null : status
      day[prayerKey] = nextStatus ? { status: nextStatus, reason: entry.reason } : false
      const next = { ...prev, [key]: day }
      localStorage.setItem('meeee_namaz', JSON.stringify(next))
      return next
    })
  }

  function setReason(prayerKey, reason) {
    const key = todayKey()
    setNamazData((prev) => {
      const day = { ...(prev[key] || {}) }
      const entry = getEntry(day, prayerKey)
      if (!entry.status) return prev
      day[prayerKey] = { status: entry.status, reason }
      const next = { ...prev, [key]: day }
      localStorage.setItem('meeee_namaz', JSON.stringify(next))
      return next
    })
  }

  function pickCity(preset) {
    localStorage.setItem('meeee_namaz_location', JSON.stringify(preset))
    setLocation(preset)
    setShowPicker(false)
    setLocStatus('ready')
  }

  function pickSearchResult(result) {
    const loc = {
      lat: result.latitude,
      lng: result.longitude,
      tz: result.timezone,
      city: [result.name, result.admin1, result.country].filter(Boolean).join(', '),
    }
    localStorage.setItem('meeee_namaz_location', JSON.stringify(loc))
    setLocation(loc)
    setShowPicker(false)
    setCitySearch('')
    setCityResults([])
    setLocStatus('ready')
  }

  const streak = useMemo(() => {
    let count = 0
    const cursor = new Date()
    if (!isFullDay(namazData[todayKey(cursor)])) cursor.setDate(cursor.getDate() - 1)
    while (isFullDay(namazData[todayKey(cursor)])) {
      count++
      cursor.setDate(cursor.getDate() - 1)
    }
    return count
  }, [namazData])

  const prevStreakRef = useRef(streak)
  const [celebrate, setCelebrate] = useState(false)
  useEffect(() => {
    const changed = streak !== prevStreakRef.current
    prevStreakRef.current = streak
    if (changed && STREAK_MILESTONES.includes(streak)) {
      setCelebrate(true)
      const t = setTimeout(() => setCelebrate(false), 2200)
      return () => clearTimeout(t)
    }
  }, [streak])

  const longestStreak = useMemo(() => {
    const fullDayKeys = Object.keys(namazData).filter((k) => isFullDay(namazData[k])).sort()
    let longest = 0
    let run = 0
    let prevDate = null
    fullDayKeys.forEach((k) => {
      const d = new Date(`${k}T00:00:00`)
      run = prevDate && Math.round((d - prevDate) / 86400000) === 1 ? run + 1 : 1
      longest = Math.max(longest, run)
      prevDate = d
    })
    return Math.max(longest, streak)
  }, [namazData, streak])

  const calendarDays = useMemo(() => {
    const year = calendarMonth.getFullYear()
    const month = calendarMonth.getMonth()
    const firstWeekday = new Date(year, month, 1).getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = []
    for (let i = 0; i < firstWeekday; i++) cells.push(null)
    for (let day = 1; day <= daysInMonth; day++) {
      const date = new Date(year, month, day)
      cells.push({ date, key: todayKey(date) })
    }
    return cells
  }, [calendarMonth])

  function goToMonth(delta) {
    setCalendarMonth((prev) => {
      const d = new Date(prev)
      d.setMonth(d.getMonth() + delta)
      return d
    })
  }

  const monthStats = useMemo(() => {
    const nowDate = new Date()
    const isCurrentMonth = calendarMonth.getFullYear() === nowDate.getFullYear() && calendarMonth.getMonth() === nowDate.getMonth()
    const daysInMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 0).getDate()
    const daysToCount = isCurrentMonth ? nowDate.getDate() : daysInMonth
    let ontime = 0
    let kaza = 0
    for (let day = 1; day <= daysToCount; day++) {
      const d = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), day)
      const dayData = namazData[todayKey(d)] || {}
      PRAYERS.forEach((p) => {
        const s = getStatus(dayData, p.key)
        if (s === 'ontime') ontime++
        else if (s === 'kaza') kaza++
      })
    }
    const total = daysToCount * 5
    return {
      ontime,
      kaza,
      missed: total - ontime - kaza,
      percent: total ? Math.round((ontime / total) * 100) : 0,
    }
  }, [namazData, calendarMonth])

  const last14Days = useMemo(() => {
    const days = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setDate(d.getDate() - i)
      const dayData = namazData[todayKey(d)] || {}
      const { ontime, kaza } = summarize(dayData)
      days.push({ key: todayKey(d), label: String(d.getDate()), ontime, kaza })
    }
    return days
  }, [namazData])

  const prayerBreakdown = useMemo(() => {
    return PRAYERS.map((p) => {
      let ontime = 0
      let kaza = 0
      Object.values(namazData).forEach((dayData) => {
        const s = getStatus(dayData, p.key)
        if (s === 'ontime') ontime++
        else if (s === 'kaza') kaza++
      })
      const total = ontime + kaza
      return { key: p.key, en: p.en, percent: total ? Math.round((ontime / total) * 100) : 0, total }
    })
  }, [namazData])

  const topReasons = useMemo(() => {
    const counts = {}
    Object.values(namazData).forEach((dayData) => {
      PRAYERS.forEach((p) => {
        const entry = getEntry(dayData, p.key)
        if (entry.status === 'kaza' && entry.reason.trim()) {
          const norm = entry.reason.trim()
          const lower = norm.toLowerCase()
          if (!counts[lower]) counts[lower] = { text: norm, count: 0 }
          counts[lower].count++
        }
      })
    })
    return Object.values(counts).sort((a, b) => b.count - a.count).slice(0, 5)
  }, [namazData])

  const last6Months = useMemo(() => {
    const months = []
    const now = new Date()
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      const isCurrent = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth()
      const daysToCount = isCurrent ? now.getDate() : daysInMonth
      let ontime = 0
      for (let day = 1; day <= daysToCount; day++) {
        const dayData = namazData[todayKey(new Date(d.getFullYear(), d.getMonth(), day))] || {}
        ontime += summarize(dayData).ontime
      }
      const total = daysToCount * 5
      months.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        label: d.toLocaleDateString('en-IN', { month: 'short' }),
        percent: total ? Math.round((ontime / total) * 100) : 0,
      })
    }
    return months
  }, [namazData])

  const bestWeekday = useMemo(() => {
    const buckets = Array.from({ length: 7 }, () => ({ ontime: 0, total: 0 }))
    Object.entries(namazData).forEach(([key, dayData]) => {
      const wd = new Date(`${key}T00:00:00`).getDay()
      const s = summarize(dayData)
      buckets[wd].ontime += s.ontime
      buckets[wd].total += s.total
    })
    const labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    let best = null
    buckets.forEach((b, i) => {
      if (b.total === 0) return
      const percent = Math.round((b.ontime / b.total) * 100)
      if (!best || percent > best.percent) best = { label: labels[i], percent }
    })
    return best
  }, [namazData])

  const allTimeStats = useMemo(() => {
    const keys = Object.keys(namazData)
    if (keys.length === 0) return null
    const sorted = keys.slice().sort()
    const start = new Date(`${sorted[0]}T00:00:00`)
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const daysTracked = Math.round((today - start) / 86400000) + 1
    let ontime = 0
    let kaza = 0
    Object.values(namazData).forEach((dayData) => {
      const s = summarize(dayData)
      ontime += s.ontime
      kaza += s.kaza
    })
    const total = Math.max(daysTracked, 1) * 5
    const missed = Math.max(0, total - ontime - kaza)
    return { ontime, kaza, missed, total }
  }, [namazData])

  const todayQuote = QUOTES[dayOfYear(new Date()) % QUOTES.length]
  const circumference = 2 * Math.PI * 42
  const ringOffset = circumference * (1 - Math.min(streak / 30, 1))
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
  const expandedEntry = expandedPrayer ? getEntry(todayData, expandedPrayer) : null
  const expandedMeta = expandedPrayer ? PRAYERS.find((p) => p.key === expandedPrayer) : null

  return (
    <div className="namaz-screen">
      {celebrate && (
        <div className="namaz-confetti" aria-hidden="true">
          {Array.from({ length: 14 }).map((_, i) => (
            <span
              key={i}
              className="namaz-confetti-piece"
              style={{
                left: `${(i / 14) * 100}%`,
                animationDelay: `${(i % 5) * 0.12}s`,
                background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              }}
            />
          ))}
          <div className="namaz-confetti-msg">🎉 {streak}-day streak!</div>
        </div>
      )}

      {!nextPrayer && (
        <div className="namaz-header">
          <h1 className="namaz-title">{dateLabel}</h1>
          {locStatus === 'loading' && <p className="namaz-loc-status">Finding your location…</p>}
        </div>
      )}

      {showPicker && (
        <div className="namaz-city-picker">
          {CITY_PRESETS.map((c) => (
            <button key={c.city} className="namaz-city-btn" onClick={() => pickCity(c)}>{c.city}</button>
          ))}
        </div>
      )}

      {showPicker && (
        <div className="namaz-search-form">
          <input
            className="namaz-search-input"
            type="text"
            placeholder="Search for your city…"
            value={citySearch}
            onChange={(e) => setCitySearch(e.target.value)}
          />
          {citySearchStatus === 'loading' && <p className="namaz-loc-status">Searching…</p>}
          {citySearchStatus === 'error' && <p className="namaz-manual-error">Couldn't reach the search service — try again.</p>}
          {cityResults.length > 0 && (
            <div className="namaz-search-results">
              {cityResults.map((r) => (
                <button
                  key={`${r.latitude},${r.longitude}`}
                  className="namaz-search-result"
                  onClick={() => pickSearchResult(r)}
                >
                  {[r.name, r.admin1, r.country].filter(Boolean).join(', ')}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {nextPrayer && (
        <div className="namaz-hero">
          <svg className="namaz-hero-skyline" viewBox="0 0 300 80" preserveAspectRatio="none" aria-hidden="true">
            <rect x="10" y="50" width="14" height="30" />
            <polygon points="17,30 24,50 10,50" />
            <rect x="60" y="35" width="30" height="45" />
            <circle cx="75" cy="30" r="18" />
            <rect x="130" y="20" width="40" height="60" />
            <circle cx="150" cy="18" r="24" />
            <polygon points="150,-4 156,18 144,18" />
            <rect x="210" y="35" width="30" height="45" />
            <circle cx="225" cy="30" r="18" />
            <rect x="276" y="50" width="14" height="30" />
            <polygon points="283,30 290,50 276,50" />
          </svg>
          <div className="namaz-hero-top">
            <span className="namaz-hero-date">{dateLabel}</span>
            <button className="namaz-hero-loc" onClick={() => setShowPicker((v) => !v)}>
              📍 {location?.city || 'Current location'}
            </button>
          </div>
          <div className="namaz-hero-content">
            <span className="namaz-hero-label">{nextPrayer.en}</span>
            <span className="namaz-hero-time">{formatTime(nextPrayer.time)}</span>
            <span className="namaz-hero-sub">Time remaining</span>
            <span className="namaz-hero-countdown">{formatCountdown(nextPrayer.time - now)}</span>
          </div>
        </div>
      )}

      {times && (
        <>
          <div className="namaz-row">
            {PRAYERS.map((p) => {
              const entry = getEntry(todayData, p.key)
              const isActive = expandedPrayer === p.key
              return (
                <button
                  key={p.key}
                  className={`namaz-row-col${isActive ? ' active' : ''}${entry.status === 'ontime' ? ' namaz-row-col--ontime' : entry.status === 'kaza' ? ' namaz-row-col--kaza' : ''}`}
                  onClick={() => setExpandedPrayer(isActive ? null : p.key)}
                >
                  <span className="namaz-row-name">{p.en}</span>
                  <span className="namaz-row-time">{formatTime(times[p.key])}</span>
                  <span className={`namaz-row-dot${entry.status === 'ontime' ? ' namaz-row-dot--ontime' : entry.status === 'kaza' ? ' namaz-row-dot--kaza' : ''}`} />
                </button>
              )
            })}
          </div>

          {expandedMeta && (
            <div className={`namaz-expand${expandedEntry.status === 'ontime' ? ' namaz-expand--ontime' : expandedEntry.status === 'kaza' ? ' namaz-expand--kaza' : ''}`}>
              <div className="namaz-expand-title">
                {expandedMeta.en} <span className="namaz-expand-ar">{expandedMeta.ar}</span>
              </div>
              <div className="namaz-card-actions">
                <button
                  className={`namaz-status-btn namaz-status-btn--ontime${expandedEntry.status === 'ontime' ? ' active' : ''}`}
                  onClick={() => setStatus(expandedPrayer, 'ontime')}
                >
                  ✓ On time
                </button>
                <button
                  className={`namaz-status-btn namaz-status-btn--kaza${expandedEntry.status === 'kaza' ? ' active' : ''}`}
                  onClick={() => setStatus(expandedPrayer, 'kaza')}
                >
                  ⏰ Kaza
                </button>
              </div>
              {expandedEntry.status === 'kaza' && (
                <input
                  className="namaz-reason-input"
                  type="text"
                  placeholder="Reason (optional)"
                  value={expandedEntry.reason}
                  onChange={(e) => setReason(expandedPrayer, e.target.value)}
                />
              )}
            </div>
          )}
        </>
      )}

      <div className="namaz-section">
        <div className="namaz-cal-header">
          <button className="namaz-cal-nav" onClick={() => goToMonth(-1)} aria-label="Previous month">‹</button>
          <h2 className="namaz-section-title namaz-cal-title">
            {calendarMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </h2>
          <button className="namaz-cal-nav" onClick={() => goToMonth(1)} aria-label="Next month">›</button>
        </div>
        <div className="namaz-calendar">
          <div className="namaz-cal-weekdays">
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d, i) => (
              <span key={i} className="namaz-cal-weekday">{d}</span>
            ))}
          </div>
          <div className="namaz-cal-grid">
            {calendarDays.map((cell, i) => {
              if (!cell) return <span key={`blank-${i}`} className="namaz-cal-cell namaz-cal-cell--blank" />
              const isFuture = cell.date > new Date()
              const dayData = namazData[cell.key] || {}
              const { ontime, kaza, total } = summarize(dayData)
              const isToday = cell.key === todayKey()
              const tooltip = isFuture
                ? ''
                : `${cell.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} — ${ontime} on time, ${kaza} kaza, ${5 - total} missed`
              return (
                <span
                  key={cell.key}
                  className={`namaz-cal-cell${isToday ? ' namaz-cal-cell--today' : ''}`}
                  title={tooltip}
                >
                  <span className="namaz-cal-daynum">{cell.date.getDate()}</span>
                  {!isFuture && (
                    <span className="namaz-cal-dots">
                      {PRAYERS.map((p) => {
                        const s = getStatus(dayData, p.key)
                        return (
                          <span
                            key={p.key}
                            className={`namaz-cal-pdot${s === 'ontime' ? ' namaz-cal-pdot--ontime' : s === 'kaza' ? ' namaz-cal-pdot--kaza' : ''}`}
                          />
                        )
                      })}
                    </span>
                  )}
                </span>
              )
            })}
          </div>
          <div className="namaz-cal-legend">
            <span className="namaz-cal-legend-item"><span className="namaz-cal-pdot namaz-cal-pdot--ontime" /> On time</span>
            <span className="namaz-cal-legend-item"><span className="namaz-cal-pdot namaz-cal-pdot--kaza" /> Kaza</span>
            <span className="namaz-cal-legend-item"><span className="namaz-cal-pdot" /> Not marked</span>
          </div>
        </div>
      </div>

      <div className="namaz-section">
        <h2 className="namaz-section-title">
          {calendarMonth.getMonth() === new Date().getMonth() && calendarMonth.getFullYear() === new Date().getFullYear()
            ? 'This month'
            : calendarMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
        </h2>
        <div className="namaz-monthly">
          <div className="namaz-monthly-item">
            <span className="namaz-monthly-val namaz-monthly-val--ontime">{monthStats.ontime}</span>
            <span className="namaz-monthly-label">On time</span>
          </div>
          <div className="namaz-monthly-item">
            <span className="namaz-monthly-val namaz-monthly-val--kaza">{monthStats.kaza}</span>
            <span className="namaz-monthly-label">Kaza</span>
          </div>
          <div className="namaz-monthly-item">
            <span className="namaz-monthly-val">{monthStats.missed}</span>
            <span className="namaz-monthly-label">Missed</span>
          </div>
        </div>
      </div>

      <div className="namaz-section">
        <button className="namaz-analytics-toggle" onClick={() => setShowAnalytics((v) => !v)}>
          <span>📊 Analytics</span>
          <span className={`namaz-analytics-chevron${showAnalytics ? ' open' : ''}`}>▾</span>
        </button>

        {showAnalytics && (
          <div className="namaz-analytics">
            <div className="namaz-analytics-block">
              <h3 className="namaz-analytics-title">Streak</h3>
              <div className="namaz-streak">
                <svg viewBox="0 0 100 100" className="namaz-streak-ring">
                  <circle cx="50" cy="50" r="42" className="namaz-streak-bg" />
                  <circle
                    cx="50" cy="50" r="42"
                    className="namaz-streak-fill"
                    transform="rotate(-90 50 50)"
                    strokeDasharray={circumference}
                    strokeDashoffset={ringOffset}
                  />
                </svg>
                <div className="namaz-streak-center">
                  <span className="namaz-streak-count">🔥 {streak}</span>
                  <span className="namaz-streak-label">day streak</span>
                </div>
              </div>
              <div className="namaz-streak-compare">
                <div className="namaz-streak-compare-item">
                  <span className="namaz-streak-compare-val">🔥 {streak}</span>
                  <span className="namaz-streak-compare-label">Current</span>
                </div>
                <div className="namaz-streak-compare-item">
                  <span className="namaz-streak-compare-val">🏆 {longestStreak}</span>
                  <span className="namaz-streak-compare-label">Best ever</span>
                </div>
              </div>
            </div>

            {allTimeStats && (
              <div className="namaz-analytics-block">
                <h3 className="namaz-analytics-title">All-time totals</h3>
                <div className="namaz-donut-wrap">
                  <svg viewBox="0 0 100 100" className="namaz-donut">
                    <g transform="rotate(-90 50 50)">
                      {(() => {
                        const r = 40
                        const circumference = 2 * Math.PI * r
                        const segments = [
                          { value: allTimeStats.ontime, className: 'namaz-donut-seg--ontime' },
                          { value: allTimeStats.kaza, className: 'namaz-donut-seg--kaza' },
                          { value: allTimeStats.missed, className: 'namaz-donut-seg--missed' },
                        ]
                        let cumulative = 0
                        return segments.map((seg, i) => {
                          const fraction = allTimeStats.total ? seg.value / allTimeStats.total : 0
                          const dash = fraction * circumference
                          const circle = (
                            <circle
                              key={i}
                              cx="50" cy="50" r={r}
                              className={`namaz-donut-seg ${seg.className}`}
                              strokeDasharray={`${dash} ${circumference - dash}`}
                              strokeDashoffset={-cumulative}
                            />
                          )
                          cumulative += dash
                          return circle
                        })
                      })()}
                    </g>
                  </svg>
                  <div className="namaz-donut-center">
                    <span className="namaz-donut-total">{allTimeStats.ontime + allTimeStats.kaza}</span>
                    <span className="namaz-donut-total-label">logged</span>
                  </div>
                </div>
                <div className="namaz-cal-legend">
                  <span className="namaz-cal-legend-item"><span className="namaz-cal-pdot namaz-cal-pdot--ontime" /> On time ({allTimeStats.ontime})</span>
                  <span className="namaz-cal-legend-item"><span className="namaz-cal-pdot namaz-cal-pdot--kaza" /> Kaza ({allTimeStats.kaza})</span>
                  <span className="namaz-cal-legend-item"><span className="namaz-cal-pdot" /> Missed ({allTimeStats.missed})</span>
                </div>
              </div>
            )}

            <div className="namaz-analytics-block">
              <h3 className="namaz-analytics-title">Last 14 days</h3>
              <div className="namaz-trend-chart">
                {last14Days.map((d) => (
                  <div key={d.key} className="namaz-trend-bar-wrap" title={`${d.ontime} on time, ${d.kaza} kaza`}>
                    <div className="namaz-trend-bar">
                      <span className="namaz-trend-seg namaz-trend-seg--kaza" style={{ height: `${(d.kaza / 5) * 40}px` }} />
                      <span className="namaz-trend-seg namaz-trend-seg--ontime" style={{ height: `${(d.ontime / 5) * 40}px` }} />
                    </div>
                    <span className="namaz-trend-label">{d.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="namaz-analytics-block">
              <h3 className="namaz-analytics-title">Last 6 months</h3>
              <div className="namaz-trend-chart">
                {last6Months.map((m) => (
                  <div key={m.key} className="namaz-trend-bar-wrap" title={`${m.label}: ${m.percent}% on time`}>
                    <div className="namaz-trend-bar">
                      <span className="namaz-trend-seg namaz-trend-seg--ontime" style={{ height: `${(m.percent / 100) * 40}px` }} />
                    </div>
                    <span className="namaz-trend-label">{m.label}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="namaz-analytics-block">
              <h3 className="namaz-analytics-title">By prayer (all time)</h3>
              {prayerBreakdown.map((p) => (
                <div key={p.key} className="namaz-breakdown-row">
                  <span className="namaz-breakdown-label">{p.en}</span>
                  <div className="namaz-breakdown-bar">
                    <span className="namaz-breakdown-fill" style={{ width: `${p.percent}%` }} />
                  </div>
                  <span className="namaz-breakdown-val">{p.total ? `${p.percent}%` : '—'}</span>
                </div>
              ))}
            </div>

            {bestWeekday && (
              <div className="namaz-analytics-block">
                <h3 className="namaz-analytics-title">Best day of the week</h3>
                <p className="namaz-insight-text">
                  You're most consistent on <strong>{bestWeekday.label}</strong> — {bestWeekday.percent}% on time.
                </p>
              </div>
            )}

            {topReasons.length > 0 && (
              <div className="namaz-analytics-block">
                <h3 className="namaz-analytics-title">Common kaza reasons</h3>
                {topReasons.map((r) => (
                  <div key={r.text} className="namaz-reasons-row">
                    <span className="namaz-reasons-text">{r.text}</span>
                    <span className="namaz-reasons-count">{r.count}×</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="namaz-hadith">
        <p className="namaz-hadith-text">"{todayQuote.text}"</p>
        <span className="namaz-hadith-ref">{todayQuote.ref}</span>
      </div>
    </div>
  )
}
