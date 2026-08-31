// Shared display formatters for Khatabook's panel + its split entries/analytics sections —
// kept together (rather than each file's own copy) since all three live inside the same
// feature and would otherwise triplicate the exact same ₹/date formatting.
const IST_TZ = 'Asia/Kolkata'

export function formatINR(n) {
  return '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatShortDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
}

export function formatINRCompact(n) {
  const v = Number(n)
  const abs = Math.abs(v)
  if (abs >= 100000) return '₹' + (v / 100000).toFixed(1) + 'L'
  if (abs >= 1000) return '₹' + (v / 1000).toFixed(1) + 'k'
  return '₹' + Math.round(v)
}
