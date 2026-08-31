// Shared display + mood helpers for the Journal module (panel + its split entries/analytics
// sections) — a fresh copy rather than importing khataFormat.js/healthFormat.js, matching
// this app's existing convention of each module keeping its own small formatting-utils file
// instead of sharing one across unrelated features.
const IST_TZ = 'Asia/Kolkata'

export function formatDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short', year: 'numeric' })
}

export function formatShortDate(ms) {
  return new Date(ms).toLocaleDateString('en-IN', { timeZone: IST_TZ, day: 'numeric', month: 'short' })
}

// Fixed multi-select palette for the Add/Edit sheet's tag chips — deliberately not
// user-extensible (no "add custom tag" input), matching the spec's closed set.
export const TAG_PALETTE = ['Work', 'Family', 'Health', 'Deen', 'Money', 'Rest', 'Social', 'Learning']

// Mood metadata keyed by the raw `mood` string stored on each entry. `score` (1-5, worst to
// best) is what every average-mood calculation across the module reads from — the stat row,
// the 14-day trend, the mood split donut and the mood-hints correlation all go through
// moodScore() below rather than re-deriving their own numeric mapping.
export const MOOD_META = {
  rough: { label: 'Rough', emoji: '😞', score: 1 },
  low:   { label: 'Low',   emoji: '😕', score: 2 },
  okay:  { label: 'Okay',  emoji: '😐', score: 3 },
  good:  { label: 'Good',  emoji: '🙂', score: 4 },
  great: { label: 'Great', emoji: '😄', score: 5 },
}

// Best-to-worst — the order the 5-button mood picker renders in.
export const MOOD_ORDER = ['great', 'good', 'okay', 'low', 'rough']

export function moodEmoji(mood) { return MOOD_META[mood]?.emoji || MOOD_META.okay.emoji }
export function moodLabel(mood) { return MOOD_META[mood]?.label || MOOD_META.okay.label }
export function moodScore(mood) { return MOOD_META[mood]?.score ?? MOOD_META.okay.score }
