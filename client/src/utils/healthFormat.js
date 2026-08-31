// Shared display formatters for the Health Tracker module (panel + its split episodes/
// analytics sections) — a fresh copy rather than importing khataFormat.js, matching this
// app's existing convention of each module keeping its own small formatting/date-utility
// file instead of sharing one across unrelated features.
const IST_TZ = 'Asia/Kolkata'

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatShortDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
}

// "12 Jan – 19 Jan" for a resolved episode, "12 Jan – ongoing" while still recovering.
export function formatDateRange(startMs, recoveryMs) {
  return `${formatShortDate(startMs)} – ${recoveryMs == null ? 'ongoing' : formatShortDate(recoveryMs)}`
}

// "Due today" / "Overdue by Nd" / "Due in Nd" for a reminder's dueDate, falling back to a
// plain short date once it's more than a month out (a bare day-count stops being useful at
// that range). IST-calendar-day diff, not raw ms/24h, so "tomorrow at 11pm" doesn't read as
// "in 0 days".
export function formatDueLabel(ms) {
  const dayMs = 86400000
  const toMidnight = (t) => new Date(new Date(t).toLocaleDateString('en-CA', { timeZone: IST_TZ })).getTime()
  const diffDays = Math.round((toMidnight(ms) - toMidnight(Date.now())) / dayMs)
  if (diffDays === 0) return 'Due today'
  if (diffDays < 0) return `Overdue by ${-diffDays}d`
  if (diffDays <= 30) return `Due in ${diffDays}d`
  return `Due ${formatShortDate(ms)}`
}
