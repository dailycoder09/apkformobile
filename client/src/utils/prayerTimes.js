// Prayer time calculation using the standard low-precision solar-position
// algorithm (Julian date -> solar mean anomaly/longitude -> declination +
// equation of time -> hour-angle per sun-altitude angle), MWL angles
// (Fajr -18°, Isha -17°), Asr via the Shafi shadow-factor-1 formula.
//
// This is a reasonable approximation for a personal tracker — not a
// substitute for a local mosque's authoritative timetable. No leap-second
// or atmospheric-refraction fine-tuning beyond the standard 0.833°
// sunrise/sunset correction.

const dsin = (d) => Math.sin((d * Math.PI) / 180)
const dcos = (d) => Math.cos((d * Math.PI) / 180)
const dtan = (d) => Math.tan((d * Math.PI) / 180)
const darcsin = (x) => (Math.asin(x) * 180) / Math.PI
const darccos = (x) => (Math.acos(x) * 180) / Math.PI
const darctan2 = (y, x) => (Math.atan2(y, x) * 180) / Math.PI
const darccot = (x) => (Math.atan(1 / x) * 180) / Math.PI
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x))

function fixAngle(a) {
  a = a - 360 * Math.floor(a / 360)
  return a < 0 ? a + 360 : a
}
function fixHour(h) {
  h = h - 24 * Math.floor(h / 24)
  return h < 0 ? h + 24 : h
}

function julianDate(year, month, day) {
  if (month <= 2) { year -= 1; month += 12 }
  const A = Math.floor(year / 100)
  const B = 2 - A + Math.floor(A / 4)
  return Math.floor(365.25 * (year + 4716)) + Math.floor(30.6001 * (month + 1)) + day + B - 1524.5
}

function sunPosition(jd) {
  const D = jd - 2451545.0
  const g = fixAngle(357.529 + 0.98560028 * D)
  const q = fixAngle(280.459 + 0.98564736 * D)
  const L = fixAngle(q + 1.915 * dsin(g) + 0.02 * dsin(2 * g))
  const e = 23.439 - 0.00000036 * D
  const RA = darctan2(dcos(e) * dsin(L), dcos(L)) / 15
  const eqt = q / 15 - fixHour(RA)
  const decl = darcsin(dsin(e) * dsin(L))
  return { declination: decl, equation: eqt }
}

// angle = degrees below horizon (positive). Returns hour-angle in hours.
function sunAngleTime(angle, lat, decl) {
  const term = (-dsin(angle) - dsin(lat) * dsin(decl)) / (dcos(lat) * dcos(decl))
  return darccos(clamp(term, -1, 1)) / 15
}

// Shafi Asr altitude angle (degrees above horizon).
function asrAltitude(lat, decl) {
  return darccot(1 + dtan(Math.abs(lat - decl)))
}

function hourToDate(date, decimalHours) {
  const dayOffset = Math.floor(decimalHours / 24)
  const h = decimalHours - dayOffset * 24
  const hours = Math.floor(h)
  const minutes = Math.round((h - hours) * 60)
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + dayOffset, hours, minutes)
}

export function getPrayerTimes(date, lat, lng, tzOffsetHours) {
  const jd = julianDate(date.getFullYear(), date.getMonth() + 1, date.getDate())
  const { declination: decl, equation: eqt } = sunPosition(jd)

  const dhuhrHour = 12 + tzOffsetHours - lng / 15 - eqt
  const fajrT = sunAngleTime(18, lat, decl)
  const sunriseT = sunAngleTime(0.833, lat, decl)
  const ishaT = sunAngleTime(17, lat, decl)
  const asrT = sunAngleTime(-asrAltitude(lat, decl), lat, decl)

  return {
    fajr: hourToDate(date, dhuhrHour - fajrT),
    sunrise: hourToDate(date, dhuhrHour - sunriseT),
    dhuhr: hourToDate(date, dhuhrHour),
    asr: hourToDate(date, dhuhrHour + asrT),
    sunset: hourToDate(date, dhuhrHour + sunriseT),
    maghrib: hourToDate(date, dhuhrHour + sunriseT),
    isha: hourToDate(date, dhuhrHour + ishaT),
  }
}

export const CITY_PRESETS = [
  { city: 'Mumbai', lat: 19.076, lng: 72.8777, tz: 'Asia/Kolkata' },
  { city: 'Delhi', lat: 28.7041, lng: 77.1025, tz: 'Asia/Kolkata' },
  { city: 'Hyderabad', lat: 17.385, lng: 78.4867, tz: 'Asia/Kolkata' },
  { city: 'Karachi', lat: 24.8607, lng: 67.0011, tz: 'Asia/Karachi' },
  { city: 'Lahore', lat: 31.5497, lng: 74.3436, tz: 'Asia/Karachi' },
  { city: 'Dubai', lat: 25.2048, lng: 55.2708, tz: 'Asia/Dubai' },
  { city: 'London', lat: 51.5072, lng: -0.1276, tz: 'Europe/London' },
  { city: 'New York', lat: 40.7128, lng: -74.006, tz: 'America/New_York' },
  { city: 'Toronto', lat: 43.6532, lng: -79.3832, tz: 'America/Toronto' },
]

// UTC offset (in hours, DST-aware) for an IANA timezone name at a given date,
// using the browser's built-in Intl API — no timezone database dependency.
export function tzOffsetHoursFromZone(timeZone, date = new Date()) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = dtf.formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc }, {})
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour === '24' ? 0 : parts.hour, parts.minute, parts.second)
  return (asUTC - date.getTime()) / 3600000
}
