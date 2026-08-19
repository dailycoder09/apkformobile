import { useEffect, useMemo, useRef, useState } from 'react'
import {
  getPrayerTimes, CITY_PRESETS, tzOffsetHoursFromZone,
  CALC_METHODS, ASR_MADHABS, getQiblaBearing, getHijriDate,
} from '../utils/prayerTimes'
import { notify, requestNotificationPermission } from '../App'
import DuasPage from './DuasPage'

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search'
const STREAK_MILESTONES = [7, 30, 100]
const CONFETTI_COLORS = ['#1f4d43', '#d97706', '#7c9a8e', '#f4c95d']

const ANALYTICS_RANGES = [
  { key: 'week', label: 'This week', days: 7 },
  { key: 'month', label: 'This month', days: 30 },
  { key: '3m', label: 'Last 3 months', days: 90 },
  { key: 'year', label: 'This year', days: 365 },
  { key: 'all', label: 'All time', days: null },
]

const WEEKDAY_LABELS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WEEKDAY_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
const HERO_RING_R = 52
const HERO_RING_CIRC = 2 * Math.PI * HERO_RING_R
const REASON_DONUT_R = 16
const REASON_DONUT_CIRC = 2 * Math.PI * REASON_DONUT_R
const COMPASS_LABELS = ['North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest']

function compassLabel(bearing) {
  return COMPASS_LABELS[Math.round(bearing / 45) % 8]
}

// Point at `angleDeg` clockwise from North (12 o'clock), `radius` from center.
function compassPoint(angleDeg, radius, cx = 60, cy = 60) {
  const rad = (angleDeg * Math.PI) / 180
  return { x: cx + radius * Math.sin(rad), y: cy - radius * Math.cos(rad) }
}

const COMPASS_TICKS = Array.from({ length: 12 }, (_, i) => i * 30)
const COMPASS_CARDINALS = [
  { label: 'N', angle: 0 },
  { label: 'E', angle: 90 },
  { label: 'S', angle: 180 },
  { label: 'W', angle: 270 },
]

function heatLevel(day) {
  if (!day) return -1
  const ratio = day.ontime / PRAYERS.length
  if (ratio <= 0) return 0
  if (ratio <= 0.2) return 1
  if (ratio <= 0.4) return 2
  if (ratio <= 0.6) return 3
  if (ratio <= 0.8) return 4
  return 5
}

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

function readQada() {
  try { return JSON.parse(localStorage.getItem('meeee_namaz_qada') || '{}') } catch { return {} }
}

function readSetting(key, fallback) {
  return localStorage.getItem(key) || fallback
}

function readBoolSetting(key) {
  return localStorage.getItem(key) === '1'
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
  const [analyticsRange, setAnalyticsRange] = useState('month')
  const [showQada, setShowQada] = useState(false)
  const [qada, setQada] = useState(readQada)
  const [showQadaCalc, setShowQadaCalc] = useState(false)
  const [showDuas, setShowDuas] = useState(false)
  const [qadaCalcFrom, setQadaCalcFrom] = useState('')
  const [qadaCalcTo, setQadaCalcTo] = useState(() => todayKey())
  const [qadaCalcPrayers, setQadaCalcPrayers] = useState(() => {
    const all = {}
    PRAYERS.forEach((p) => { all[p.key] = true })
    return all
  })
  const [showSettings, setShowSettings] = useState(false)
  const [heroPage, setHeroPage] = useState(0)
  const heroCarouselRef = useRef(null)

  function handleHeroScroll() {
    const el = heroCarouselRef.current
    if (!el || !el.clientWidth) return
    setHeroPage(Math.round(el.scrollLeft / el.clientWidth))
  }
  const [calcMethod, setCalcMethod] = useState(() => readSetting('meeee_namaz_method', 'mwl'))
  const [asrMadhab, setAsrMadhab] = useState(() => readSetting('meeee_namaz_madhab', 'shafi'))
  const [remindersEnabled, setRemindersEnabled] = useState(() => readBoolSetting('meeee_namaz_reminders'))
  const [customReminderTimes, setCustomReminderTimes] = useState(() => {
    try { return JSON.parse(localStorage.getItem('meeee_namaz_reminder_times') || '{}') } catch { return {} }
  })
  const [enabledPrayerReminders, setEnabledPrayerReminders] = useState(() => {
    try { return JSON.parse(localStorage.getItem('meeee_namaz_reminder_prayers') || '{}') } catch { return {} }
  })
  const remindedRef = useRef(new Set())
  const alarmCtxRef = useRef(null)

  function ensureAlarmContext() {
    if (!alarmCtxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext
      if (Ctx) alarmCtxRef.current = new Ctx()
    }
    if (alarmCtxRef.current?.state === 'suspended') alarmCtxRef.current.resume()
  }

  // Classic 4-beep alarm pattern, synthesized so no audio asset is needed.
  function playAlarmSound() {
    const ctx = alarmCtxRef.current
    if (!ctx) return
    const startAt = ctx.currentTime
    for (let i = 0; i < 4; i++) {
      const beepStart = startAt + i * 0.5
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.0001, beepStart)
      gain.gain.exponentialRampToValueAtTime(0.3, beepStart + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.0001, beepStart + 0.3)
      osc.connect(gain).connect(ctx.destination)
      osc.start(beepStart)
      osc.stop(beepStart + 0.35)
    }
  }

  function toTimeInputValue(d) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  function setPrayerReminderTime(key, value) {
    setCustomReminderTimes((prev) => ({ ...prev, [key]: value }))
  }

  function togglePrayerReminder(key) {
    setEnabledPrayerReminders((prev) => ({ ...prev, [key]: !prev[key] }))
  }

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

  useEffect(() => { localStorage.setItem('meeee_namaz_method', calcMethod) }, [calcMethod])
  useEffect(() => { localStorage.setItem('meeee_namaz_madhab', asrMadhab) }, [asrMadhab])
  useEffect(() => { localStorage.setItem('meeee_namaz_reminders', remindersEnabled ? '1' : '0') }, [remindersEnabled])
  useEffect(() => { localStorage.setItem('meeee_namaz_reminder_times', JSON.stringify(customReminderTimes)) }, [customReminderTimes])
  useEffect(() => { localStorage.setItem('meeee_namaz_reminder_prayers', JSON.stringify(enabledPrayerReminders)) }, [enabledPrayerReminders])

  const prayerOptions = useMemo(() => {
    const method = CALC_METHODS.find((m) => m.key === calcMethod) || CALC_METHODS[0]
    const madhab = ASR_MADHABS.find((m) => m.key === asrMadhab) || ASR_MADHABS[0]
    return {
      fajrAngle: method.fajrAngle,
      ishaAngle: method.ishaAngle,
      ishaIntervalMinutes: method.ishaIntervalMinutes,
      asrShadowFactor: madhab.shadowFactor,
    }
  }, [calcMethod, asrMadhab])

  const times = useMemo(() => {
    if (!location) return null
    const tzOffsetHours = location.tz ? tzOffsetHoursFromZone(location.tz) : (location.tzOffsetHours ?? 0)
    return getPrayerTimes(new Date(), location.lat, location.lng, tzOffsetHours, prayerOptions)
  }, [location, prayerOptions])

  const nextPrayer = useMemo(() => {
    if (!times || !location) return null
    for (const p of PRAYERS) {
      if (times[p.key] > now) return { key: p.key, en: p.en, time: times[p.key] }
    }
    const tomorrow = new Date(now)
    tomorrow.setDate(tomorrow.getDate() + 1)
    const tzOffsetHours = location.tz ? tzOffsetHoursFromZone(location.tz) : (location.tzOffsetHours ?? 0)
    const tomorrowTimes = getPrayerTimes(tomorrow, location.lat, location.lng, tzOffsetHours, prayerOptions)
    return { key: 'fajr', en: 'Fajr', time: tomorrowTimes.fajr }
  }, [times, location, now, prayerOptions])

  const prevPrayerTime = useMemo(() => {
    if (!times || !location) return null
    let prev = null
    for (const p of PRAYERS) {
      if (times[p.key] <= now) prev = times[p.key]
    }
    if (prev) return prev
    const yesterday = new Date(now)
    yesterday.setDate(yesterday.getDate() - 1)
    const tzOffsetHours = location.tz ? tzOffsetHoursFromZone(location.tz) : (location.tzOffsetHours ?? 0)
    const yTimes = getPrayerTimes(yesterday, location.lat, location.lng, tzOffsetHours, prayerOptions)
    return yTimes.isha
  }, [times, location, now, prayerOptions])

  useEffect(() => {
    if (!remindersEnabled || !times) return
    PRAYERS.forEach((p) => {
      if (!enabledPrayerReminders[p.key]) return
      const custom = customReminderTimes[p.key]
      let target = times[p.key]
      if (custom) {
        const [h, m] = custom.split(':').map(Number)
        target = new Date(times[p.key])
        target.setHours(h, m, 0, 0)
      }
      const msUntil = target - now
      if (msUntil > 1000 || msUntil < -1000) return
      const fireKey = `${todayKey(target)}-${p.key}`
      if (remindedRef.current.has(fireKey)) return
      remindedRef.current.add(fireKey)
      notify(`${p.en} reminder`, `It's time for ${p.en} prayer.`)
      playAlarmSound()
    })
  }, [now, times, remindersEnabled, customReminderTimes, enabledPrayerReminders])

  function toggleReminders() {
    setRemindersEnabled((prev) => {
      const next = !prev
      if (next) {
        requestNotificationPermission()
        ensureAlarmContext()
      }
      return next
    })
  }

  const qibla = useMemo(() => {
    if (!location) return null
    const bearing = getQiblaBearing(location.lat, location.lng)
    const tip = compassPoint(bearing, 52)
    return { bearing, label: compassLabel(bearing), tip }
  }, [location])

  const hijriLabel = useMemo(() => getHijriDate(new Date()), [])

  const qadaTotals = useMemo(() => {
    let owed = 0
    let completed = 0
    PRAYERS.forEach((p) => {
      const entry = qada[p.key]
      if (!entry) return
      owed += entry.owed
      completed += entry.completed
    })
    return { owed, completed }
  }, [qada])

  const qadaCalcPreview = useMemo(() => {
    if (!qadaCalcFrom || !qadaCalcTo) return null
    const from = new Date(`${qadaCalcFrom}T00:00:00`)
    const to = new Date(`${qadaCalcTo}T00:00:00`)
    if (isNaN(from) || isNaN(to) || to < from) return null
    const days = Math.round((to - from) / 86400000) + 1
    const prayerCount = PRAYERS.filter((p) => qadaCalcPrayers[p.key]).length
    if (!prayerCount) return null
    return { days, prayerCount, total: days * prayerCount }
  }, [qadaCalcFrom, qadaCalcTo, qadaCalcPrayers])

  const heroRingFraction = useMemo(() => {
    if (!nextPrayer || !prevPrayerTime) return 0
    const total = nextPrayer.time - prevPrayerTime
    if (total <= 0) return 0
    return Math.min(1, Math.max(0, (now - prevPrayerTime) / total))
  }, [nextPrayer, prevPrayerTime, now])

  const heroRingTip = useMemo(() => {
    const angle = heroRingFraction * 2 * Math.PI
    return {
      x: 60 + HERO_RING_R * Math.cos(angle),
      y: 60 + HERO_RING_R * Math.sin(angle),
    }
  }, [heroRingFraction])

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

  function addQadaOwed(prayerKey) {
    setQada((prev) => {
      const entry = prev[prayerKey] || { owed: 0, completed: 0 }
      const next = { ...prev, [prayerKey]: { ...entry, owed: entry.owed + 1 } }
      localStorage.setItem('meeee_namaz_qada', JSON.stringify(next))
      return next
    })
  }

  function completeQada(prayerKey) {
    setQada((prev) => {
      const entry = prev[prayerKey] || { owed: 0, completed: 0 }
      if (entry.owed <= 0) return prev
      const next = { ...prev, [prayerKey]: { owed: entry.owed - 1, completed: entry.completed + 1 } }
      localStorage.setItem('meeee_namaz_qada', JSON.stringify(next))
      return next
    })
  }

  function toggleQadaCalcPrayer(key) {
    setQadaCalcPrayers((prev) => ({ ...prev, [key]: !prev[key] }))
  }

  function applyQadaCalc() {
    if (!qadaCalcPreview) return
    const selected = PRAYERS.filter((p) => qadaCalcPrayers[p.key])
    setQada((prev) => {
      const next = { ...prev }
      selected.forEach((p) => {
        const entry = next[p.key] || { owed: 0, completed: 0 }
        next[p.key] = { ...entry, owed: entry.owed + qadaCalcPreview.days }
      })
      localStorage.setItem('meeee_namaz_qada', JSON.stringify(next))
      return next
    })
    setShowQadaCalc(false)
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

  const rangeBounds = useMemo(() => {
    const end = new Date(); end.setHours(0, 0, 0, 0)
    const opt = ANALYTICS_RANGES.find((o) => o.key === analyticsRange)
    if (opt.days) {
      const start = new Date(end)
      start.setDate(start.getDate() - (opt.days - 1))
      return { start, end }
    }
    const keys = Object.keys(namazData).sort()
    const start = keys.length ? new Date(`${keys[0]}T00:00:00`) : new Date(end)
    return { start, end }
  }, [analyticsRange, namazData])

  const rangeDays = useMemo(() => {
    const days = []
    const cursor = new Date(rangeBounds.start)
    while (cursor <= rangeBounds.end) {
      const key = todayKey(cursor)
      const { ontime, kaza, total } = summarize(namazData[key] || {})
      days.push({ key, date: new Date(cursor), ontime, kaza, total })
      cursor.setDate(cursor.getDate() + 1)
    }
    return days
  }, [rangeBounds, namazData])

  const rangeStats = useMemo(() => {
    let ontime = 0
    let kaza = 0
    rangeDays.forEach((d) => { ontime += d.ontime; kaza += d.kaza })
    const total = rangeDays.length * PRAYERS.length
    const missed = Math.max(0, total - ontime - kaza)
    return { ontime, kaza, missed, percent: total ? Math.round((ontime / total) * 100) : 0 }
  }, [rangeDays])

  const heatmapCells = useMemo(() => {
    const cells = Array.from({ length: rangeBounds.start.getDay() }, () => null)
    rangeDays.forEach((d) => cells.push(d))
    while (cells.length % 7 !== 0) cells.push(null)
    return cells
  }, [rangeDays, rangeBounds])

  const prayerBreakdown = useMemo(() => {
    return PRAYERS.map((p) => {
      let ontime = 0
      let kaza = 0
      rangeDays.forEach((d) => {
        const s = getStatus(namazData[d.key] || {}, p.key)
        if (s === 'ontime') ontime++
        else if (s === 'kaza') kaza++
      })
      const total = ontime + kaza
      return { key: p.key, en: p.en, percent: total ? Math.round((ontime / total) * 100) : 0, total }
    })
  }, [rangeDays, namazData])

  const weekdayStats = useMemo(() => {
    const buckets = Array.from({ length: 7 }, () => ({ ontime: 0, total: 0 }))
    rangeDays.forEach((d) => {
      const wd = d.date.getDay()
      buckets[wd].ontime += d.ontime
      buckets[wd].total += d.ontime + d.kaza
    })
    return WEEKDAY_ORDER.map((wd, i) => {
      const b = buckets[wd]
      return {
        label: WEEKDAY_SHORT[i],
        fullLabel: WEEKDAY_LABELS[wd],
        percent: b.total ? Math.round((b.ontime / b.total) * 100) : 0,
        total: b.total,
      }
    })
  }, [rangeDays])

  const bestWeekday = useMemo(() => {
    let best = null
    weekdayStats.forEach((w) => {
      if (w.total === 0) return
      if (!best || w.percent > best.percent) best = { label: w.fullLabel, percent: w.percent }
    })
    return best
  }, [weekdayStats])

  const trendBuckets = useMemo(() => {
    if (rangeDays.length === 0) return []
    const bucketSize = Math.max(1, Math.ceil(rangeDays.length / 30))
    const buckets = []
    for (let i = 0; i < rangeDays.length; i += bucketSize) {
      const slice = rangeDays.slice(i, i + bucketSize)
      const ontime = slice.reduce((s, d) => s + d.ontime, 0)
      const kaza = slice.reduce((s, d) => s + d.kaza, 0)
      const total = slice.length * PRAYERS.length
      const last = slice[slice.length - 1]
      buckets.push({
        key: last.key,
        label: bucketSize === 1 ? String(last.date.getDate()) : `${slice[0].date.getDate()}–${last.date.getDate()}`,
        ontimePct: total ? ontime / total : 0,
        kazaPct: total ? kaza / total : 0,
        ontime,
        kaza,
      })
    }
    return buckets
  }, [rangeDays])

  const comparisonStats = useMemo(() => {
    if (analyticsRange === 'all' || rangeDays.length === 0) return null
    const lengthDays = rangeDays.length
    const prevEnd = new Date(rangeBounds.start)
    prevEnd.setDate(prevEnd.getDate() - 1)
    const prevStart = new Date(prevEnd)
    prevStart.setDate(prevStart.getDate() - (lengthDays - 1))
    let ontime = 0
    let total = 0
    const cursor = new Date(prevStart)
    while (cursor <= prevEnd) {
      ontime += summarize(namazData[todayKey(cursor)] || {}).ontime
      total += PRAYERS.length
      cursor.setDate(cursor.getDate() + 1)
    }
    return {
      currentPercent: rangeStats.percent,
      previousPercent: total ? Math.round((ontime / total) * 100) : 0,
    }
  }, [analyticsRange, rangeBounds, rangeDays.length, namazData, rangeStats.percent])

  const reasonBreakdown = useMemo(() => {
    const counts = {}
    let namedCount = 0
    let blankCount = 0
    rangeDays.forEach((d) => {
      const dayData = namazData[d.key] || {}
      PRAYERS.forEach((p) => {
        const entry = getEntry(dayData, p.key)
        if (entry.status !== 'kaza') return
        const norm = entry.reason.trim()
        if (!norm) { blankCount++; return }
        const lower = norm.toLowerCase()
        if (!counts[lower]) counts[lower] = { text: norm, count: 0 }
        counts[lower].count++
        namedCount++
      })
    })
    const sorted = Object.values(counts).sort((a, b) => b.count - a.count)
    const top = sorted.slice(0, 2)
    const topCount = top.reduce((s, r) => s + r.count, 0)
    const otherCount = namedCount - topCount + blankCount
    const total = namedCount + blankCount
    if (total === 0) return null
    const items = top.map((r) => ({ label: r.text, count: r.count, percent: Math.round((r.count / total) * 100) }))
    if (otherCount > 0) items.push({ label: 'Other', count: otherCount, percent: Math.round((otherCount / total) * 100) })
    return { items, total }
  }, [rangeDays, namazData])

  const todayQuote = QUOTES[dayOfYear(new Date()) % QUOTES.length]
  const dateLabel = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long' })
  const expandedEntry = expandedPrayer ? getEntry(todayData, expandedPrayer) : null
  const expandedMeta = expandedPrayer ? PRAYERS.find((p) => p.key === expandedPrayer) : null

  if (showDuas) return <DuasPage onBack={() => setShowDuas(false)} />

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
          {hijriLabel && <p className="namaz-hijri">{hijriLabel} AH</p>}
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
        <>
          <div className="namaz-hero-carousel" ref={heroCarouselRef} onScroll={handleHeroScroll}>
            <div className="namaz-hero-page">
              <div className="namaz-hero">
                <div className="namaz-hero-aura" aria-hidden="true" />
                <div className="namaz-hero-top">
                  <span className="namaz-hero-date-group">
                    <span className="namaz-hero-date">{dateLabel}</span>
                    {hijriLabel && <span className="namaz-hero-hijri">{hijriLabel} AH</span>}
                  </span>
                  <span className="namaz-hero-top-actions">
                    <button className="namaz-hero-loc" onClick={() => setShowPicker((v) => !v)}>
                      <span className="material-symbols-outlined namaz-hero-loc-icon">location_on</span>
                      {location?.city || 'Current location'}
                    </button>
                    <button className="namaz-hero-gear" onClick={() => setShowDuas(true)} aria-label="Duas">
                      <span className="material-symbols-outlined">menu_book</span>
                    </button>
                    <button className="namaz-hero-gear" onClick={() => setShowSettings((v) => !v)} aria-label="Prayer settings">
                      <span className="material-symbols-outlined">settings</span>
                    </button>
                  </span>
                </div>
                <h2 className="namaz-hero-heading">Next Prayer: {nextPrayer.en}</h2>
                <p className="namaz-hero-sub">Time remaining</p>
                <div className="namaz-ring-wrap">
                  <svg className="namaz-ring" viewBox="0 0 120 120">
                    <circle className="namaz-ring-bg" cx="60" cy="60" r={HERO_RING_R} />
                    <circle
                      className="namaz-ring-fill"
                      cx="60" cy="60" r={HERO_RING_R}
                      strokeDasharray={HERO_RING_CIRC}
                      strokeDashoffset={HERO_RING_CIRC * (1 - heroRingFraction)}
                    />
                    <circle className="namaz-ring-tip-ping" cx={heroRingTip.x} cy={heroRingTip.y} r="5" />
                    <circle className="namaz-ring-tip-dot" cx={heroRingTip.x} cy={heroRingTip.y} r="4.5" />
                  </svg>
                  <div className="namaz-ring-center">
                    <span className="namaz-ring-time">{formatTime(nextPrayer.time)}</span>
                    <span className="namaz-ring-countdown">{formatCountdown(nextPrayer.time - now)}</span>
                  </div>
                </div>
              </div>
            </div>

            {qibla && (
              <div className="namaz-hero-page">
                <div className="namaz-hero namaz-hero--qibla">
                  <div className="namaz-hero-aura" aria-hidden="true" />
                  <div className="namaz-hero-top">
                    <span className="namaz-hero-date-group">
                      <span className="namaz-hero-date">Qibla Direction</span>
                      <span className="namaz-hero-hijri">Face the Kaaba</span>
                    </span>
                    <span className="namaz-hero-top-actions">
                      <button className="namaz-hero-loc" onClick={() => setShowPicker((v) => !v)}>
                        <span className="material-symbols-outlined namaz-hero-loc-icon">location_on</span>
                        {location?.city || 'Current location'}
                      </button>
                    </span>
                  </div>
                  <h2 className="namaz-hero-heading">{Math.round(qibla.bearing)}° {qibla.label}</h2>
                  <p className="namaz-hero-sub">Direction from true North</p>
                  <div className="namaz-ring-wrap">
                    <svg className="namaz-compass" viewBox="0 0 120 120">
                      <circle className="namaz-ring-bg" cx="60" cy="60" r={HERO_RING_R} />
                      {COMPASS_TICKS.map((angle) => {
                        const major = angle % 90 === 0
                        const p1 = compassPoint(angle, major ? 40 : 44)
                        const p2 = compassPoint(angle, 48)
                        return (
                          <line
                            key={angle}
                            x1={p1.x} y1={p1.y} x2={p2.x} y2={p2.y}
                            className={`namaz-compass-tick${major ? ' namaz-compass-tick--major' : ''}`}
                          />
                        )
                      })}
                      {COMPASS_CARDINALS.map((c) => {
                        const p = compassPoint(c.angle, 30)
                        return (
                          <text key={c.label} x={p.x} y={p.y + 4} textAnchor="middle" className="namaz-compass-label">
                            {c.label}
                          </text>
                        )
                      })}
                      <g style={{ transform: `rotate(${qibla.bearing}deg)`, transformOrigin: '60px 60px' }}>
                        <line x1="60" y1="60" x2="60" y2="16" className="namaz-compass-needle-shadow" />
                        <line x1="60" y1="60" x2="60" y2="16" className="namaz-compass-needle" />
                      </g>
                      <circle cx="60" cy="60" r="5" className="namaz-compass-hub" />
                    </svg>
                    <div
                      className="namaz-compass-kaaba"
                      style={{ left: `${(qibla.tip.x / 120) * 100}%`, top: `${(qibla.tip.y / 120) * 100}%` }}
                    >
                      <span className="material-symbols-outlined">mosque</span>
                    </div>
                  </div>
                  <p className="namaz-compass-caption">🕋 The gold arrow points toward the Kaaba</p>
                </div>
              </div>
            )}
          </div>

          {qibla && (
            <div className="namaz-hero-dots">
              <span className={`namaz-hero-dot${heroPage === 0 ? ' active' : ''}`} />
              <span className={`namaz-hero-dot${heroPage === 1 ? ' active' : ''}`} />
            </div>
          )}
        </>
      )}

      {showSettings && (
        <div className="namaz-settings-panel">
          <div className="namaz-settings-row">
            <label className="namaz-settings-label">Calculation method</label>
            <select value={calcMethod} onChange={(e) => setCalcMethod(e.target.value)}>
              {CALC_METHODS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="namaz-settings-row">
            <label className="namaz-settings-label">Asr calculation</label>
            <select value={asrMadhab} onChange={(e) => setAsrMadhab(e.target.value)}>
              {ASR_MADHABS.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </div>
          <div className="namaz-settings-row namaz-settings-row--toggle">
            <label className="namaz-settings-label">Prayer time reminders</label>
            <button
              className={`namaz-toggle-switch${remindersEnabled ? ' on' : ''}`}
              onClick={toggleReminders}
              role="switch"
              aria-checked={remindersEnabled}
            >
              <span className="namaz-toggle-knob" />
            </button>
          </div>
          {remindersEnabled && times && (
            <div className="namaz-reminder-times">
              <p className="namaz-settings-hint">Choose which prayers to be reminded for, and when.</p>
              {PRAYERS.map((p) => {
                const isOn = !!enabledPrayerReminders[p.key]
                return (
                  <div key={p.key} className={`namaz-settings-row namaz-reminder-row${isOn ? ' active' : ''}`}>
                    <label className="namaz-reminder-check">
                      <input
                        type="checkbox"
                        checked={isOn}
                        onChange={() => togglePrayerReminder(p.key)}
                      />
                      <span className="namaz-settings-label">{p.en}</span>
                    </label>
                    <input
                      type="time"
                      className="namaz-time-input"
                      disabled={!isOn}
                      value={customReminderTimes[p.key] || toTimeInputValue(times[p.key])}
                      onChange={(e) => setPrayerReminderTime(p.key, e.target.value)}
                    />
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {nextPrayer && (
        <div className="namaz-section">
          <h2 className="namaz-section-title">
            {calendarMonth.getMonth() === new Date().getMonth() && calendarMonth.getFullYear() === new Date().getFullYear()
              ? 'This month'
              : calendarMonth.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' })}
          </h2>
          <div className="namaz-stat-strip">
            <div className="namaz-stat-chip">
              <span className="material-symbols-outlined namaz-stat-chip-icon namaz-stat-chip--ontime">check_circle</span>
              <span className="namaz-stat-chip-val namaz-stat-chip--ontime">{monthStats.ontime}</span>
              <span className="namaz-stat-chip-label">On time</span>
            </div>
            <div className="namaz-stat-chip">
              <span className="material-symbols-outlined namaz-stat-chip-icon namaz-stat-chip--kaza">schedule</span>
              <span className="namaz-stat-chip-val namaz-stat-chip--kaza">{monthStats.kaza}</span>
              <span className="namaz-stat-chip-label">Kaza</span>
            </div>
            <div className="namaz-stat-chip">
              <span className="material-symbols-outlined namaz-stat-chip-icon namaz-stat-chip--missed">cancel</span>
              <span className="namaz-stat-chip-val namaz-stat-chip--missed">{monthStats.missed}</span>
              <span className="namaz-stat-chip-label">Missed</span>
            </div>
            <div className="namaz-stat-chip">
              <span className="material-symbols-outlined namaz-stat-chip-icon namaz-stat-chip--rate">trending_up</span>
              <span className="namaz-stat-chip-val namaz-stat-chip--rate">{monthStats.percent}%</span>
              <span className="namaz-stat-chip-label">On-time rate</span>
            </div>
            <div className="namaz-stat-chip">
              <span className="material-symbols-outlined namaz-stat-chip-icon namaz-stat-chip--streak">local_fire_department</span>
              <span className="namaz-stat-chip-val namaz-stat-chip--streak">{streak}</span>
              <span className="namaz-stat-chip-label">Streak</span>
            </div>
            <div className="namaz-stat-chip">
              <span className="material-symbols-outlined namaz-stat-chip-icon namaz-stat-chip--streak">trophy</span>
              <span className="namaz-stat-chip-val namaz-stat-chip--streak">{longestStreak}</span>
              <span className="namaz-stat-chip-label">Best</span>
            </div>
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
                  <span className="material-symbols-outlined">check_circle</span> On time
                </button>
                <button
                  className={`namaz-status-btn namaz-status-btn--kaza${expandedEntry.status === 'kaza' ? ' active' : ''}`}
                  onClick={() => setStatus(expandedPrayer, 'kaza')}
                >
                  <span className="material-symbols-outlined">schedule</span> Kaza
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

      <div className="namaz-toggle-row">
        <button className="namaz-analytics-toggle" onClick={() => setShowQada((v) => !v)}>
          <span className="namaz-analytics-toggle-label">
            <span className="namaz-analytics-toggle-icon"><span className="material-symbols-outlined">event_repeat</span></span>
            Qada Tracker
            {qadaTotals.owed > 0 && <span className="namaz-qada-badge">{qadaTotals.owed}</span>}
          </span>
          <span className={`namaz-analytics-chevron${showQada ? ' open' : ''}`}>
            <span className="material-symbols-outlined">expand_more</span>
          </span>
        </button>

        <button className="namaz-analytics-toggle" onClick={() => setShowAnalytics((v) => !v)}>
          <span className="namaz-analytics-toggle-label">
            <span className="namaz-analytics-toggle-icon"><span className="material-symbols-outlined">bar_chart</span></span>
            Detailed Analytics
          </span>
          <span className={`namaz-analytics-chevron${showAnalytics ? ' open' : ''}`}>
            <span className="material-symbols-outlined">expand_more</span>
          </span>
        </button>
      </div>

      {showQada && (
        <div className="namaz-section">
          <div className="namaz-analytics">
            <p className="namaz-settings-hint">Track prayers you owe as makeup, and log them off as you complete them.</p>
            <div className="namaz-stat-grid">
              <div className="namaz-stat-card namaz-stat-card--missed">
                <span className="namaz-stat-icon"><span className="material-symbols-outlined">event_busy</span></span>
                <span className="namaz-stat-val">{qadaTotals.owed}</span>
                <span className="namaz-stat-label">Total owed</span>
              </div>
              <div className="namaz-stat-card namaz-stat-card--ontime">
                <span className="namaz-stat-icon"><span className="material-symbols-outlined">task_alt</span></span>
                <span className="namaz-stat-val">{qadaTotals.completed}</span>
                <span className="namaz-stat-label">Made up</span>
              </div>
            </div>

            <div className="namaz-analytics-block">
              <button className="namaz-qada-calc-toggle" onClick={() => setShowQadaCalc((v) => !v)}>
                <span className="material-symbols-outlined">calculate</span>
                Calculate missed prayers from a date range
                <span className={`material-symbols-outlined namaz-analytics-chevron${showQadaCalc ? ' open' : ''}`}>expand_more</span>
              </button>

              {showQadaCalc && (
                <div className="namaz-qada-calc">
                  <div className="namaz-qada-calc-dates">
                    <label className="namaz-qada-calc-date-field">
                      <span className="namaz-settings-label">From</span>
                      <input type="date" value={qadaCalcFrom} onChange={(e) => setQadaCalcFrom(e.target.value)} className="namaz-time-input" />
                    </label>
                    <label className="namaz-qada-calc-date-field">
                      <span className="namaz-settings-label">To</span>
                      <input type="date" value={qadaCalcTo} onChange={(e) => setQadaCalcTo(e.target.value)} className="namaz-time-input" />
                    </label>
                  </div>
                  <p className="namaz-settings-hint">Which prayers were missed every day in that range?</p>
                  <div className="namaz-prayer-chips">
                    {PRAYERS.map((p) => (
                      <button
                        key={p.key}
                        className={`namaz-prayer-chip${qadaCalcPrayers[p.key] ? ' active' : ''}`}
                        onClick={() => toggleQadaCalcPrayer(p.key)}
                      >
                        {p.en}
                      </button>
                    ))}
                  </div>
                  {qadaCalcPreview ? (
                    <p className="namaz-qada-calc-preview">
                      {qadaCalcPreview.days.toLocaleString()} days × {qadaCalcPreview.prayerCount} prayer{qadaCalcPreview.prayerCount > 1 ? 's' : ''}
                      {' '}= <strong>{qadaCalcPreview.total.toLocaleString()}</strong> qada prayers
                    </p>
                  ) : (
                    <p className="namaz-qada-calc-preview namaz-qada-calc-preview--empty">Pick a valid date range and at least one prayer.</p>
                  )}
                  <button className="namaz-qada-calc-apply" onClick={applyQadaCalc} disabled={!qadaCalcPreview}>
                    Add to Qada
                  </button>
                </div>
              )}
            </div>

            <div className="namaz-analytics-block">
              <h3 className="namaz-analytics-title">By prayer</h3>
              {PRAYERS.map((p) => {
                const entry = qada[p.key] || { owed: 0, completed: 0 }
                return (
                  <div key={p.key} className="namaz-qada-row">
                    <span className="namaz-qada-name">{p.en}</span>
                    <span className="namaz-qada-owed">{entry.owed} owed</span>
                    <button className="namaz-qada-btn namaz-qada-btn--add" onClick={() => addQadaOwed(p.key)} aria-label={`Add missed ${p.en}`}>
                      <span className="material-symbols-outlined">add</span>
                    </button>
                    <button
                      className="namaz-qada-btn namaz-qada-btn--done"
                      onClick={() => completeQada(p.key)}
                      disabled={entry.owed === 0}
                      aria-label={`Mark one ${p.en} qada as made up`}
                    >
                      <span className="material-symbols-outlined">check</span>
                    </button>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {showAnalytics && (
        <div className="namaz-section">
          <div className="namaz-analytics namaz-analytics--flat">
            <label className="namaz-analytics-filter">
              <span className="material-symbols-outlined namaz-analytics-filter-icon">calendar_month</span>
              <select
                value={analyticsRange}
                onChange={(e) => setAnalyticsRange(e.target.value)}
                aria-label="Analytics time range"
              >
                {ANALYTICS_RANGES.map((r) => (
                  <option key={r.key} value={r.key}>{r.label}</option>
                ))}
              </select>
              <span className="material-symbols-outlined namaz-analytics-filter-chevron">expand_more</span>
            </label>

            <div className="namaz-analytics-carousel">
              <div className="namaz-chart-slide">
                <h3 className="namaz-analytics-title">Daily heatmap</h3>
                <div className="namaz-heatmap-wrap">
                  <div className="namaz-heatmap-grid">
                    {heatmapCells.map((d, i) => (
                      <span
                        key={d ? d.key : `pad-${i}`}
                        className={`namaz-heat-cell${d ? ` namaz-heat-${heatLevel(d)}` : ' namaz-heat-pad'}${d?.kaza ? ' namaz-heat-haskaza' : ''}`}
                        title={d ? `${d.date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} — ${d.ontime} on time, ${d.kaza} kaza` : undefined}
                      />
                    ))}
                  </div>
                </div>
                <div className="namaz-heat-legend">
                  <span>Less</span>
                  {[0, 1, 2, 3, 4, 5].map((l) => <span key={l} className={`namaz-heat-cell namaz-heat-${l}`} />)}
                  <span>More</span>
                </div>
              </div>

              <div className="namaz-chart-slide">
                <h3 className="namaz-analytics-title">By prayer</h3>
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

              {trendBuckets.length > 0 && (
                <div className="namaz-chart-slide">
                  <h3 className="namaz-analytics-title">On-time vs. Kaza trend</h3>
                  <div className="namaz-trend-chart">
                    {trendBuckets.map((b) => (
                      <div key={b.key} className="namaz-trend-bar-wrap" title={`${b.label}: ${b.ontime} on time, ${b.kaza} kaza`}>
                        <div className="namaz-trend-bar">
                          <span className="namaz-trend-seg namaz-trend-seg--kaza" style={{ height: `${b.kazaPct * 100}%` }} />
                          <span className="namaz-trend-seg namaz-trend-seg--ontime" style={{ height: `${b.ontimePct * 100}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="namaz-trend-footer">
                    <span>{trendBuckets[0].label}</span>
                    <span>Today</span>
                  </div>
                </div>
              )}

              {comparisonStats && (
                <div className="namaz-chart-slide">
                  <h3 className="namaz-analytics-title">This period vs. previous</h3>
                  <div className="namaz-compare-row">
                    <span className="namaz-compare-label">Current</span>
                    <div className="namaz-compare-bar"><span className="namaz-compare-fill namaz-compare-fill--current" style={{ width: `${comparisonStats.currentPercent}%` }} /></div>
                    <span className="namaz-compare-val">{comparisonStats.currentPercent}%</span>
                  </div>
                  <div className="namaz-compare-row">
                    <span className="namaz-compare-label">Previous</span>
                    <div className="namaz-compare-bar"><span className="namaz-compare-fill namaz-compare-fill--previous" style={{ width: `${comparisonStats.previousPercent}%` }} /></div>
                    <span className="namaz-compare-val">{comparisonStats.previousPercent}%</span>
                  </div>
                </div>
              )}

              <div className="namaz-chart-slide">
                <h3 className="namaz-analytics-title">Weekday performance</h3>
                <div className="namaz-weekday-chart">
                  {weekdayStats.map((w) => (
                    <div key={w.fullLabel} className="namaz-weekday-bar-wrap" title={`${w.fullLabel}: ${w.percent}%`}>
                      <div className="namaz-weekday-bar" style={{ height: `${Math.max(w.percent, w.total ? 4 : 2)}%` }} />
                    </div>
                  ))}
                </div>
                <div className="namaz-weekday-labels">
                  {weekdayStats.map((w, i) => <span key={i}>{w.label}</span>)}
                </div>
                {bestWeekday && (
                  <p className="namaz-block-footnote">
                    Most consistent: <strong>{bestWeekday.label}</strong> ({bestWeekday.percent}%)
                  </p>
                )}
              </div>

              {reasonBreakdown && (
                <div className="namaz-chart-slide namaz-reasons-block">
                  <h3 className="namaz-analytics-title">Missed reasons</h3>
                  <svg viewBox="0 0 36 36" className="namaz-reasons-donut">
                    <circle cx="18" cy="18" r={REASON_DONUT_R} fill="none" stroke="rgba(0,0,0,0.06)" strokeWidth="4" />
                    {(() => {
                      let cumulative = 0
                      return reasonBreakdown.items.map((item, i) => {
                        const dash = (item.percent / 100) * REASON_DONUT_CIRC
                        const color = item.label === 'Other' ? 'var(--namaz-muted)' : i === 0 ? 'var(--namaz-missed)' : 'var(--namaz-gold)'
                        const el = (
                          <circle
                            key={i}
                            cx="18" cy="18" r={REASON_DONUT_R}
                            fill="none" stroke={color} strokeWidth="4"
                            strokeDasharray={`${dash} ${REASON_DONUT_CIRC - dash}`}
                            strokeDashoffset={-cumulative}
                            transform="rotate(-90 18 18)"
                          />
                        )
                        cumulative += dash
                        return el
                      })
                    })()}
                  </svg>
                  <div className="namaz-reasons-legend">
                    {reasonBreakdown.items.map((item, i) => (
                      <div key={item.label} className="namaz-reasons-legend-item">
                        <span
                          className="namaz-reasons-dot"
                          style={{ background: item.label === 'Other' ? 'var(--namaz-muted)' : i === 0 ? 'var(--namaz-missed)' : 'var(--namaz-gold)' }}
                        />
                        <span>{item.label} ({item.percent}%)</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="namaz-hadith">
        <p className="namaz-hadith-text">"{todayQuote.text}"</p>
        <span className="namaz-hadith-ref">{todayQuote.ref}</span>
      </div>
    </div>
  )
}
