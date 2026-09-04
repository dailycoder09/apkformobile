// Last-known-data cache for offline viewing — a child reopening the app with no
// internet still sees their last-synced data instead of a blank/loading screen. Plain
// localStorage (not IndexedDB): this is personal per-user JSON, not media, and a
// synchronous read is what lets cached data render before any network round-trip even
// starts. `kind` is the WebSocket reply message type ('transactions', 'milestone_data',
// 'health_data', 'ledger_data', 'namaz_data', 'profile', 'budgets') so
// every screen that fetches the same data shares one cache entry — Dashboard.jsx fetches
// all of these itself and stays in sync with each screen's own panel automatically.
export function getCache(kind, userId) {
  try {
    const raw = localStorage.getItem(`meeee_cache_${kind}_${userId}`)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setCache(kind, userId, data) {
  try {
    localStorage.setItem(`meeee_cache_${kind}_${userId}`, JSON.stringify(data))
  } catch {
    // Storage full/unavailable — caching is a best-effort convenience, never fatal.
  }
}
