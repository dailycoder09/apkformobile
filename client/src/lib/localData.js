// Client-side IndexedDB data layer for the offline, single-user rework of the personal-
// tracking features (Transactions/Finance, Khatabook, Milestones, Health, Namaz/
// Qada, Budgets, Profile). Replaces the WebSocket round-trips to the server for all of
// these — see server/store.js (generic `(id, owner_user_id, ts, data)` CRUD tables plus
// the two small dedicated `budgets`/`profiles` tables) and the matching message handlers
// in server/index.js, which this file mirrors behaviourally (dedup-by-id on transactions,
// the ledger/milestone delete cascades, the namaz upsert-by-id pattern, budget/profile
// field validation). The app is now single-user, so unlike the server there is no
// owner_user_id partitioning here — one browser = one IndexedDB database = one person's
// data.
//
// Plain browser-native IndexedDB (no wrapper library) so this works identically in a
// plain PWA context and inside a Capacitor WebView.

const DB_NAME = 'meeee-local'
// v4 was meant to add journal_notes_v2/quick_notes for the rebuilt, scoped-down
// Journal (see TABLES below), but browsers that had already opened the DB at
// version 4 (from earlier in this dev cycle, before those two stores existed)
// never re-ran onupgradeneeded — indexedDB only upgrades when the requested
// version is HIGHER than what's stored, so those installs were stuck missing
// the new stores ("NotFoundError: object store not found" on every journal
// save). v5 forces the upgrade to actually run everywhere.
// Deliberately NOT reusing the old 'journal_entries' store name — it's still
// sitting in already-created installs' databases from before the whole feature
// was removed, holding the OLD shape (mood/energy/tags/gratitude fields, raw ms-
// timestamp dates). Reusing that name would silently mix incompatible-shaped rows
// into the new, much simpler {date, day, notes, highlighted} shape. The old store is
// orphaned and harmless — nothing reads or writes it anymore.
// v6 was meant to add journal_media_v2 (photo/voice/video attachment blobs, see
// TABLES below), but the two edits that added it (bumping this number, then adding
// the TABLES entry) landed as separate saves — a dev-server hot-reload in the gap
// between them could open the DB at version 6 before the new store existed in
// ALL_STORE_NAMES, permanently stamping the on-disk DB at v6 without it (same
// "requesting an already-current version never re-runs onupgradeneeded" trap as
// the v4→v5 bug above). v7 forces it through again, now that both edits are in.
// v8 adds health_media_v1 (see TABLES below) — this time the version bump and the
// TABLES entry land in the exact same edit, specifically to avoid a repeat of the
// v6 incident above.
const DB_VERSION = 8

// One object store per server table, all keyed by `id` — mirrors the server's generic
// per-table shape. `budgets` and `profiles` each hold a single fixed-id row (the whole
// category→limit map / the whole profile object) rather than one row per item, matching
// how the server already hands both of these back as one flat object rather than a list.
const TABLES = {
  TRANSACTIONS: 'transactions',
  LEDGER_CONTACTS: 'ledger_contacts',
  LEDGER_ENTRIES: 'ledger_entries',
  MILESTONE_MILESTONES: 'milestone_milestones',
  MILESTONE_GOALS: 'milestone_goals',
  MILESTONE_TASKS: 'milestone_tasks',
  HEALTH_EPISODES: 'health_episodes',
  HEALTH_REMINDERS: 'health_reminders',
  NAMAZ_DAYS: 'namaz_days',
  NAMAZ_QADA: 'namaz_qada',
  PROFILES: 'profiles',
  BUDGETS: 'budgets',
  // Rebuilt, scoped-down Journal (JournalEntriesScreen.jsx) and Quick Notes
  // (QuickNotesScreen.jsx) — see the DB_VERSION comment above for why this isn't
  // named 'journal_entries'.
  JOURNAL_NOTES: 'journal_notes_v2',
  QUICK_NOTES: 'quick_notes',
  // Attachment blobs (photo/voice/video) for journal_notes_v2 entries — one row per
  // attachment, keyed by its own id and tagged with the owning entry's id. No index on
  // entryId (queried via getAll + filter — fine at personal-journal scale) to keep the
  // schema simple.
  JOURNAL_MEDIA: 'journal_media_v2',
  // Same shape as JOURNAL_MEDIA, one shared table for both health_episodes and
  // health_reminders attachments — rows carry an entryType ('episode'|'reminder')
  // alongside entryId since both owner tables share one id space only by convention,
  // not by a real foreign key, and could otherwise collide.
  HEALTH_MEDIA: 'health_media_v1',
}

const ALL_STORE_NAMES = Object.values(TABLES)

// Fixed keys for the two single-row stores.
const PROFILE_ROW_ID = 'profile'
const BUDGETS_ROW_ID = 'budgets'

// ── DB connection (opened once, cached) ─────────────────────────────────────────────
// Every exported function awaits this before touching the DB, so callers never need to
// worry about call order/timing relative to the DB being ready.
let dbPromise = null
function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of ALL_STORE_NAMES) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'id' })
        }
      }
    }
    req.onsuccess = () => {
      const db = req.result
      // A tab that's been open since before a DB_VERSION bump (dev-server HMR
      // often patches JS without a real navigation) can be left holding a
      // connection whose schema view predates a later upgrade done elsewhere —
      // it never picks up new stores and throws NotFoundError forever. Drop
      // this connection the moment another connection needs to upgrade, so
      // the next call reopens fresh at the current version.
      db.onversionchange = () => {
        db.close()
        dbPromise = null
      }
      resolve(db)
    }
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

async function getObjectStore(table, mode, _retried = false) {
  const db = await openDb()
  if (!db.objectStoreNames.contains(table)) {
    // Self-heal: this connection predates a schema change (stale tab/HMR-
    // reload race, same class of bug as the onversionchange handler above
    // covers) — drop it and reopen once instead of throwing.
    if (_retried) throw new Error(`Object store "${table}" not found after reopening the database`)
    dbPromise = null
    return getObjectStore(table, mode, true)
  }
  const tx = db.transaction(table, mode)
  return { store: tx.objectStore(table), tx }
}

function makeId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for an environment without crypto.randomUUID (old WebView) — same rough
  // shape as the server's own makeId(), just not relied upon in practice.
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

// ── Generic per-table CRUD helpers (mirror server/store.js's getList/appendItem/
// updateItem/deleteItem/deleteAllForOwner, minus the owner_user_id partitioning) ───────

async function getAll(table) {
  const { store } = await getObjectStore(table, 'readonly')
  return reqToPromise(store.getAll())
}

async function getOne(table, id) {
  const { store } = await getObjectStore(table, 'readonly')
  const row = await reqToPromise(store.get(id))
  return row ?? null
}

async function putRow(table, row) {
  const { store, tx } = await getObjectStore(table, 'readwrite')
  store.put(row)
  await txDone(tx)
  return row
}

// item.id defaults via makeId() if absent, same as server's appendItem.
async function appendItem(table, item) {
  const row = item && item.id != null ? item : { ...item, id: makeId() }
  return putRow(table, row)
}

// Merge-patch by id; returns null if the row doesn't exist yet (same as server's
// updateItem, which is how namaz's upsert-by-id decides whether to fall back to insert).
async function updateItem(table, id, patch) {
  const existing = await getOne(table, id)
  if (!existing) return null
  const merged = { ...existing, ...patch, id }
  await putRow(table, merged)
  return merged
}

async function deleteItem(table, id) {
  const { store, tx } = await getObjectStore(table, 'readwrite')
  store.delete(id)
  await txDone(tx)
}

async function clearTable(table) {
  const { store, tx } = await getObjectStore(table, 'readwrite')
  store.clear()
  await txDone(tx)
}

// ── Device id (stands in for the old server-assigned userId) ───────────────────────

const DEVICE_ID_KEY = 'meeee_device_id'
let cachedDeviceId = null

// crypto.randomUUID only exists in a secure context (HTTPS, or literally "localhost") —
// loading this app over plain HTTP via a LAN IP (e.g. http://192.168.x.x:5173, the normal
// way to test on a phone during dev) is NOT a secure context, so crypto.randomUUID is
// undefined there and calling it throws. Same feature-detected fallback shape as makeId()
// above, reused here so device-id generation can't crash on that exact path.
function makeDeviceId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

export async function getDeviceId() {
  if (cachedDeviceId) return cachedDeviceId
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY)
    if (!id) {
      id = makeDeviceId()
      localStorage.setItem(DEVICE_ID_KEY, id)
    }
    cachedDeviceId = id
    // Mirrors this same id into native SharedPreferences so DeviceBackupWorker.java's
    // background job — which runs independently of this WebView, via WorkManager, and
    // so can't read localStorage — files its backups under the exact device id the rest
    // of the app (and the parent's restore screen) already knows this device by, rather
    // than minting a second, unrelated one purely native-side. No-op outside the
    // Android app (window.MeeeeNative doesn't exist in a plain browser).
    try { window.MeeeeNative?.cacheDeviceId?.(id) } catch {}
    return id
  } catch {
    // localStorage unavailable — fall back to an in-memory id for this session only.
    if (!cachedDeviceId) cachedDeviceId = makeDeviceId()
    return cachedDeviceId
  }
}

// ── Transactions ─────────────────────────────────────────────────────────────────────

export async function getTransactions() {
  return getAll(TABLES.TRANSACTIONS)
}

// Dedup by exact id, same as the server's transaction_add handler — re-importing the
// same or an overlapping bank statement CSV is a no-op. Returns the existing stored item
// on a duplicate hit, or the newly-stored item otherwise.
export async function addTransaction(txn) {
  const existing = await getAll(TABLES.TRANSACTIONS)
  const dup = existing.find(t => t.id === txn.id)
  if (dup) return dup
  return appendItem(TABLES.TRANSACTIONS, txn)
}

export async function updateTransaction(id, patch) {
  return updateItem(TABLES.TRANSACTIONS, id, patch)
}

export async function deleteTransaction(id) {
  return deleteItem(TABLES.TRANSACTIONS, id)
}

export async function deleteAllTransactions() {
  return clearTable(TABLES.TRANSACTIONS)
}

// ── Khatabook / ledger ───────────────────────────────────────────────────────────────

export async function getLedgerData() {
  const [contacts, entries] = await Promise.all([
    getAll(TABLES.LEDGER_CONTACTS),
    getAll(TABLES.LEDGER_ENTRIES),
  ])
  return { contacts, entries }
}

export async function addLedgerContact(contact) {
  return appendItem(TABLES.LEDGER_CONTACTS, contact)
}

export async function updateLedgerContact(contact) {
  return updateItem(TABLES.LEDGER_CONTACTS, contact.id, contact)
}

// Cascades to every ledger entry belonging to this contact, same as the server's
// ledger_contact_delete handler.
export async function deleteLedgerContact(id) {
  await deleteItem(TABLES.LEDGER_CONTACTS, id)
  const entries = await getAll(TABLES.LEDGER_ENTRIES)
  for (const e of entries.filter(e => e.contactId === id)) {
    await deleteItem(TABLES.LEDGER_ENTRIES, e.id)
  }
}

export async function addLedgerEntry(entry) {
  return appendItem(TABLES.LEDGER_ENTRIES, entry)
}

export async function updateLedgerEntry(entry) {
  return updateItem(TABLES.LEDGER_ENTRIES, entry.id, entry)
}

export async function deleteLedgerEntry(id) {
  return deleteItem(TABLES.LEDGER_ENTRIES, id)
}

// ── Milestones ───────────────────────────────────────────────────────────────────────

export async function getMilestoneData() {
  const [milestones, goals, tasks] = await Promise.all([
    getAll(TABLES.MILESTONE_MILESTONES),
    getAll(TABLES.MILESTONE_GOALS),
    getAll(TABLES.MILESTONE_TASKS),
  ])
  return { milestones, goals, tasks }
}

export async function addMilestone(milestone) {
  return appendItem(TABLES.MILESTONE_MILESTONES, milestone)
}

export async function updateMilestone(milestone) {
  return updateItem(TABLES.MILESTONE_MILESTONES, milestone.id, milestone)
}

// Two-level cascade, same as the server's milestone_milestone_delete handler: delete the
// milestone, then every goal with goal.milestoneId matching, then every task belonging to
// each of those goals.
export async function deleteMilestone(id) {
  await deleteItem(TABLES.MILESTONE_MILESTONES, id)
  const [goals, tasks] = await Promise.all([
    getAll(TABLES.MILESTONE_GOALS),
    getAll(TABLES.MILESTONE_TASKS),
  ])
  for (const g of goals.filter(g => g.milestoneId === id)) {
    await deleteItem(TABLES.MILESTONE_GOALS, g.id)
    for (const t of tasks.filter(t => t.goalId === g.id)) {
      await deleteItem(TABLES.MILESTONE_TASKS, t.id)
    }
  }
}

export async function addGoal(goal) {
  return appendItem(TABLES.MILESTONE_GOALS, goal)
}

export async function updateGoal(goal) {
  return updateItem(TABLES.MILESTONE_GOALS, goal.id, goal)
}

// One-level cascade, same as the server's milestone_goal_delete handler: delete the goal,
// then every task with task.goalId matching.
export async function deleteGoal(id) {
  await deleteItem(TABLES.MILESTONE_GOALS, id)
  const tasks = await getAll(TABLES.MILESTONE_TASKS)
  for (const t of tasks.filter(t => t.goalId === id)) {
    await deleteItem(TABLES.MILESTONE_TASKS, t.id)
  }
}

export async function addTask(task) {
  return appendItem(TABLES.MILESTONE_TASKS, task)
}

export async function updateTask(task) {
  return updateItem(TABLES.MILESTONE_TASKS, task.id, task)
}

export async function deleteTask(id) {
  return deleteItem(TABLES.MILESTONE_TASKS, id)
}

// Loops addTask-equivalent per item, same as the server's milestone_tasks_bulk_add.
export async function addTasksBulk(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const results = []
  for (const t of list) {
    results.push(await appendItem(TABLES.MILESTONE_TASKS, t))
  }
  return results
}

// ── Health tracker ───────────────────────────────────────────────────────────────────

export async function getHealthData() {
  const [episodes, reminders] = await Promise.all([
    getAll(TABLES.HEALTH_EPISODES),
    getAll(TABLES.HEALTH_REMINDERS),
  ])
  return { episodes, reminders }
}

export async function addHealthEpisode(episode) {
  return appendItem(TABLES.HEALTH_EPISODES, episode)
}

export async function updateHealthEpisode(episode) {
  return updateItem(TABLES.HEALTH_EPISODES, episode.id, episode)
}

export async function deleteHealthEpisode(id) {
  const media = await getHealthMediaForEntry(id, 'episode')
  for (const m of media) {
    await deleteHealthMedia(m.id)
  }
  return deleteItem(TABLES.HEALTH_EPISODES, id)
}

export async function addHealthReminder(reminder) {
  return appendItem(TABLES.HEALTH_REMINDERS, reminder)
}

export async function updateHealthReminder(reminder) {
  return updateItem(TABLES.HEALTH_REMINDERS, reminder.id, reminder)
}

export async function deleteHealthReminder(id) {
  const media = await getHealthMediaForEntry(id, 'reminder')
  for (const m of media) {
    await deleteHealthMedia(m.id)
  }
  return deleteItem(TABLES.HEALTH_REMINDERS, id)
}

// ── Health media (photo/voice/video/file attachments on episodes/reminders) ─────────
// Mirrors addJournalMedia/getJournalMediaForEntry/deleteJournalMedia exactly, plus an
// entryType so one shared table can serve both owner tables — see HEALTH_MEDIA's own
// comment in TABLES above.

export async function addHealthMedia({ entryId, entryType, kind, blob, name = null }) {
  return appendItem(TABLES.HEALTH_MEDIA, { entryId, entryType, kind, blob, name, createdAt: Date.now() })
}

export async function getHealthMediaForEntry(entryId, entryType) {
  const all = await getAll(TABLES.HEALTH_MEDIA)
  return all.filter((m) => m.entryId === entryId && m.entryType === entryType)
}

export async function deleteHealthMedia(id) {
  return deleteItem(TABLES.HEALTH_MEDIA, id)
}

// ── Journal (rebuilt, scoped-down: date/day/notes/highlighted only) ────────────────
// Seeds itself with a few demo entries on first-ever read (same "don't start from a
// dead-empty screen" reasoning as the old Life Hub's life-categories seeding, and the
// same duplicate-seed guard — see seedingPromise below).

const DEFAULT_JOURNAL_NOTES = [
  { date: '25 Nov, 2024', day: 'Monday', notes: 'Maecenas sit amet consectetur arcu, quis semper orci. Donec hendrerit tellus dictum mi tincidunt luctus. Pellentesque in lorem cursu...', highlighted: false },
  { date: '25 Nov, 2024', day: 'Wednesday', notes: 'Maecenas sit amet consectetur arcu, quis semper orci. Donec hendrerit tellus dictum mi tincidunt luctus. Pellentesque in lorem cursu...', highlighted: true },
  { date: '25 Nov, 2024', day: 'Monday', notes: 'Maecenas sit amet consectetur arcu, quis semper orci. Donec hendrerit tellus dictum mi tincidunt luctus. Pellentesque in lorem cursu...', highlighted: false },
  { date: '25 Nov, 2024', day: 'Wednesday', notes: 'Maecenas sit amet consectetur arcu, quis...', highlighted: true },
]

// Guards against double-seeding only — NOT a data cache. Earlier this used the
// seeding promise's own resolved value as the return value for every call, which
// meant any screen calling getJournalNotesSeeded() after the first ever call (e.g.
// JournalInsightsScreen, mounted separately from JournalEntriesScreen) got back the
// original seed snapshot forever, never seeing entries added/edited since. Fixed by
// always re-querying getAll() after the one-time seed guard resolves.
let journalSeedingPromise = null
export async function getJournalNotesSeeded() {
  if (!journalSeedingPromise) {
    journalSeedingPromise = (async () => {
      const existing = await getAll(TABLES.JOURNAL_NOTES)
      if (existing.length > 0) return
      for (const entry of DEFAULT_JOURNAL_NOTES) {
        await appendItem(TABLES.JOURNAL_NOTES, { ...entry, createdAt: Date.now() })
      }
    })()
  }
  await journalSeedingPromise
  return getAll(TABLES.JOURNAL_NOTES)
}

export async function addJournalNote({ date, day, notes, mood = null, highlighted = false }) {
  return appendItem(TABLES.JOURNAL_NOTES, { date, day, notes, mood, highlighted, createdAt: Date.now() })
}

export async function updateJournalNote(id, patch) {
  return updateItem(TABLES.JOURNAL_NOTES, id, patch)
}

export async function deleteJournalNote(id) {
  const media = await getJournalMediaForEntry(id)
  for (const m of media) {
    await deleteJournalMedia(m.id)
  }
  return deleteItem(TABLES.JOURNAL_NOTES, id)
}

// ── Journal media (photo/voice/video attachments) ───────────────────────────────────

export async function addJournalMedia({ entryId, kind, blob, name = null }) {
  return appendItem(TABLES.JOURNAL_MEDIA, { entryId, kind, blob, name, createdAt: Date.now() })
}

export async function getJournalMediaForEntry(entryId) {
  const all = await getAll(TABLES.JOURNAL_MEDIA)
  return all.filter((m) => m.entryId === entryId)
}

export async function deleteJournalMedia(id) {
  return deleteItem(TABLES.JOURNAL_MEDIA, id)
}

// ── Quick Notes (rebuilt: title/body only, no folders/tags) ─────────────────────────

const DEFAULT_QUICK_NOTES = [
  { title: 'Grocery list', body: 'Milk, eggs, bread, spinach, coffee beans.' },
  { title: 'Book recommendations', body: 'Atomic Habits, Deep Work, The Almanack of Naval Ravikant.' },
]

let quickNotesSeedingPromise = null
export async function getQuickNotesSeeded() {
  if (!quickNotesSeedingPromise) {
    quickNotesSeedingPromise = (async () => {
      const existing = await getAll(TABLES.QUICK_NOTES)
      if (existing.length > 0) return existing
      const seeded = []
      for (const note of DEFAULT_QUICK_NOTES) {
        seeded.push(await appendItem(TABLES.QUICK_NOTES, { ...note, updatedAt: Date.now() }))
      }
      return seeded
    })()
  }
  return quickNotesSeedingPromise
}

export async function addQuickNote({ title, body }) {
  return appendItem(TABLES.QUICK_NOTES, { title, body, updatedAt: Date.now() })
}

export async function updateQuickNote(id, patch) {
  return updateItem(TABLES.QUICK_NOTES, id, { ...patch, updatedAt: Date.now() })
}

// ── Namaz (prayer) + Qada ────────────────────────────────────────────────────────────

export async function getNamazData() {
  const [days, qadaRows] = await Promise.all([
    getAll(TABLES.NAMAZ_DAYS),
    getAll(TABLES.NAMAZ_QADA),
  ])
  return { days, qada: qadaRows[0] || null }
}

// Upsert-by-id, same as the server's namaz_day_set: try update first, only insert if the
// row doesn't exist yet. day.id is "YYYY-MM-DD".
export async function setNamazDay(day) {
  const updated = await updateItem(TABLES.NAMAZ_DAYS, day.id, day)
  if (updated) return updated
  return appendItem(TABLES.NAMAZ_DAYS, day)
}

// Same upsert-by-id pattern; qada.id is always the literal string 'totals' (only one row
// ever exists), same as the server's namaz_qada_set.
export async function setNamazQada(qada) {
  const updated = await updateItem(TABLES.NAMAZ_QADA, qada.id, qada)
  if (updated) return updated
  return appendItem(TABLES.NAMAZ_QADA, qada)
}

// ── Budgets ──────────────────────────────────────────────────────────────────────────
// Single row holding the whole category→limit map (see TABLES comment above) — simplest
// given it's always fetched/replaced as one whole object, matching how the server's
// getBudgets already returns one flat map. The overall (non-per-category) budget lives
// under the reserved category key '__overall__' (OVERALL_BUDGET_CATEGORY in
// client/src/utils/txnMeta.js), same as on the server — this file has no dependency on
// that constant, it just treats every category string identically.

export async function getBudgets() {
  const row = await getOne(TABLES.BUDGETS, BUDGETS_ROW_ID)
  return row ? { ...row.categories } : {}
}

// Validates category (string, trimmed, 1-100 chars) and monthlyLimit (finite, >= 0)
// before upserting, same constraints as the server's budget_set handler — but throws a
// clear Error on invalid input instead of silently truncating/coercing and no-op'ing,
// since a thrown error is more useful to a local, synchronous-call-site caller than a
// server handler that just silently `return`s on bad input from the wire.
export async function setBudget(category, monthlyLimit) {
  if (typeof category !== 'string') {
    throw new Error('setBudget: category must be a string')
  }
  const trimmed = category.trim()
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new Error('setBudget: category must be 1-100 characters after trimming')
  }
  if (typeof monthlyLimit !== 'number' || !Number.isFinite(monthlyLimit) || monthlyLimit < 0) {
    throw new Error('setBudget: monthlyLimit must be a finite number >= 0')
  }
  const existing = await getOne(TABLES.BUDGETS, BUDGETS_ROW_ID)
  const categories = { ...(existing ? existing.categories : {}), [trimmed]: monthlyLimit }
  await putRow(TABLES.BUDGETS, { id: BUDGETS_ROW_ID, categories })
  return categories
}

// ── Profile ──────────────────────────────────────────────────────────────────────────

export async function getProfile() {
  const row = await getOne(TABLES.PROFILES, PROFILE_ROW_ID)
  if (!row) return null
  const { id, ...profile } = row
  return profile
}

// Trims/truncates firstName/lastName (<=60 chars) and email (<=254 chars), same as the
// server's profile_update handler. Merge-patch: any other field passed through as-is
// (e.g. photoPath — there's no server-side photo upload endpoint anymore, a separate
// piece of work handles the photo file itself, this just stores/returns whatever profile
// fields it's given), and fields not mentioned in this call are left untouched.
export async function updateProfile({ firstName, lastName, email, ...rest } = {}) {
  const existing = await getOne(TABLES.PROFILES, PROFILE_ROW_ID)
  const merged = { ...(existing || {}), ...rest, id: PROFILE_ROW_ID }
  if (firstName !== undefined) merged.firstName = String(firstName || '').trim().slice(0, 60) || null
  if (lastName !== undefined) merged.lastName = String(lastName || '').trim().slice(0, 60) || null
  if (email !== undefined) merged.email = String(email || '').trim().slice(0, 254) || null
  await putRow(TABLES.PROFILES, merged)
  const { id, ...profile } = merged
  return profile
}

// ── Backup / restore (full raw dump of every store) ─────────────────────────────────

export async function getAllTablesForBackup() {
  const result = {}
  for (const table of ALL_STORE_NAMES) {
    result[table] = await getAll(table)
  }
  return result
}

// Replaces (clears then repopulates) every object store from the given raw table dump —
// used for reinstall-recovery restore. Takes the exact same shape getAllTablesForBackup
// returns.
export async function restoreAllTables(tables) {
  for (const table of ALL_STORE_NAMES) {
    const rows = Array.isArray(tables?.[table]) ? tables[table] : []
    await clearTable(table)
    for (const row of rows) {
      await putRow(table, row)
    }
  }
}
