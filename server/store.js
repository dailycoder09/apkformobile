const path     = require('path')
const crypto   = require('crypto')
const Database = require('better-sqlite3')

const db = new Database(path.join(__dirname, 'data.sqlite'))
db.pragma('journal_mode = WAL') // survives concurrent reads without blocking the single writer

const TABLES = {
  TRANSACTIONS: 'transactions',
  BROWSING_HISTORY: 'browsing_history',
  CALL_LOGS: 'call_logs',
  LEDGER_CONTACTS: 'ledger_contacts',
  LEDGER_ENTRIES: 'ledger_entries',
  MILESTONE_MILESTONES: 'milestone_milestones',
  MILESTONE_GOALS: 'milestone_goals',
  MILESTONE_TASKS: 'milestone_tasks',
}

// Mechanical schema fixup for DBs created before the name→phone-number identity
// rewrite: if a table still has the old column, rename it in place so existing
// code doesn't crash with "no such column". This is NOT a data migration — old
// rows keep whatever value they had (an old display name, for pre-existing
// tables), which simply won't match any real userId/phone going forward and are
// effectively orphaned, per the clean-break decision for this rework. SQLite
// (3.25+, bundled by better-sqlite3) updates indexes/views that reference the
// column automatically as part of RENAME COLUMN.
function renameColumnIfPresent(table, oldCol, newCol) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
  if (cols.includes(oldCol) && !cols.includes(newCol)) {
    db.exec(`ALTER TABLE ${table} RENAME COLUMN ${oldCol} TO ${newCol}`)
  }
}

for (const table of Object.values(TABLES)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT NOT NULL,
      owner_user_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (id, owner_user_id)
    )
  `)
  renameColumnIfPresent(table, 'owner_name', 'owner_user_id')
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner_ts ON ${table} (owner_user_id, ts DESC)`)
}

// Identity is now keyed by phone number (E.164, verified via Firebase Phone Auth),
// not by the freely-editable display `name` — this closes the session-hijack hole
// where registering with someone else's name used to steal their session. `name`
// is no longer part of identity at all; it lives only in the live session meta and
// in user_joined/users_list broadcasts.
db.exec(`
  CREATE TABLE IF NOT EXISTS known_users (
    phone_number TEXT PRIMARY KEY,
    user_id TEXT UNIQUE,
    created_at INTEGER
  )
`)
renameColumnIfPresent('known_users', 'name', 'phone_number')

// Small durable key/value table for server-generated secrets (e.g. the screenshot
// encryption key) that must survive a process restart — see getOrCreateSecret().
db.exec(`
  CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at INTEGER
  )
`)

// User profile — first/last name, email, and a photo (photo stored as a file on
// disk under server/uploads/profiles/, path recorded here; see setProfilePhotoPath).
// Keyed by the same stable userId as everything else, so it's independent of both
// the display name and the phone number.
db.exec(`
  CREATE TABLE IF NOT EXISTS profiles (
    user_id TEXT PRIMARY KEY,
    first_name TEXT,
    last_name TEXT,
    email TEXT,
    photo_path TEXT,
    updated_at INTEGER
  )
`)

// Per-category monthly budgets — both the child (self-management) and the parent
// (guidance/override) can set these, mirroring how transactions themselves already work:
// each user manages their own data, but the admin has broader visibility/control. The
// Phase-1 overall (non-category) budget lives in this same table under a reserved
// category value the client uses (OVERALL_BUDGET_CATEGORY = '__overall__' in
// txnMeta.js), rather than being tracked by a separate mechanism.
db.exec(`
  CREATE TABLE IF NOT EXISTS budgets (
    owner_user_id TEXT NOT NULL,
    category TEXT NOT NULL,
    monthly_limit REAL NOT NULL,
    updated_at INTEGER,
    PRIMARY KEY (owner_user_id, category)
  )
`)

const stmts = {}
for (const table of Object.values(TABLES)) {
  stmts[table] = {
    getList: db.prepare(`SELECT data FROM ${table} WHERE owner_user_id = ? ORDER BY ts DESC`),
    getOne: db.prepare(`SELECT data FROM ${table} WHERE id = ? AND owner_user_id = ?`),
    insert: db.prepare(`INSERT OR IGNORE INTO ${table} (id, owner_user_id, ts, data) VALUES (?, ?, ?, ?)`),
    update: db.prepare(`UPDATE ${table} SET ts = ?, data = ? WHERE id = ? AND owner_user_id = ?`),
    delete: db.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_user_id = ?`),
    deleteAll: db.prepare(`DELETE FROM ${table} WHERE owner_user_id = ?`),
  }
}

const getUserStmt    = db.prepare('SELECT user_id FROM known_users WHERE phone_number = ?')
const insertUserStmt = db.prepare('INSERT OR IGNORE INTO known_users (phone_number, user_id, created_at) VALUES (?, ?, ?)')

const getSecretStmt    = db.prepare('SELECT value FROM secrets WHERE name = ?')
const insertSecretStmt = db.prepare('INSERT OR IGNORE INTO secrets (name, value, created_at) VALUES (?, ?, ?)')

const getBudgetsStmt = db.prepare('SELECT category, monthly_limit FROM budgets WHERE owner_user_id = ?')
const upsertBudgetStmt = db.prepare(`
  INSERT INTO budgets (owner_user_id, category, monthly_limit, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(owner_user_id, category) DO UPDATE SET
    monthly_limit = excluded.monthly_limit,
    updated_at    = excluded.updated_at
`)

const getProfileStmt = db.prepare('SELECT * FROM profiles WHERE user_id = ?')
const upsertProfileStmt = db.prepare(`
  INSERT INTO profiles (user_id, first_name, last_name, email, photo_path, updated_at)
  VALUES (@userId, @firstName, @lastName, @email, NULL, @updatedAt)
  ON CONFLICT(user_id) DO UPDATE SET
    first_name = excluded.first_name,
    last_name  = excluded.last_name,
    email      = excluded.email,
    updated_at = excluded.updated_at
`)
const setPhotoPathStmt = db.prepare(`
  INSERT INTO profiles (user_id, photo_path, updated_at)
  VALUES (?, ?, ?)
  ON CONFLICT(user_id) DO UPDATE SET photo_path = excluded.photo_path, updated_at = excluded.updated_at
`)

let idSeq = 0
function makeId() { return `${++idSeq}-${Math.random().toString(36).slice(2, 6)}` }

function itemTs(item) {
  return item.date ?? item.timestamp ?? Date.now()
}

// Same id shape as index.js's own makeId() — kept independent so store.js has no
// dependency on index.js's module-scoped counter. Keyed by verified E.164 phone
// number rather than the display name — a given phone always maps to the same
// stable userId, regardless of what name is presented alongside it.
function getOrAssignUserId(phoneNumber) {
  const existing = getUserStmt.get(phoneNumber)
  if (existing) return existing.user_id
  const userId = makeId()
  insertUserStmt.run(phoneNumber, userId, Date.now())
  return userId
}

function getList(table, ownerUserId) {
  return stmts[table].getList.all(ownerUserId).map(row => JSON.parse(row.data))
}

function appendItem(table, ownerUserId, item) {
  const id = item.id ?? makeId()
  const info = stmts[table].insert.run(id, ownerUserId, itemTs(item), JSON.stringify(item))
  return info.changes > 0
}

function updateItem(table, ownerUserId, id, patch) {
  const row = stmts[table].getOne.get(id, ownerUserId)
  if (!row) return null
  const merged = { ...JSON.parse(row.data), ...patch }
  stmts[table].update.run(itemTs(merged), JSON.stringify(merged), id, ownerUserId)
  return merged
}

function deleteItem(table, ownerUserId, id) {
  const info = stmts[table].delete.run(id, ownerUserId)
  return info.changes > 0
}

// Wipes every row for a given owner in the given table — e.g. "delete all browsing
// history" / "delete all call logs" for a child, requested by the admin.
function deleteAllForOwner(table, ownerUserId) {
  const info = stmts[table].deleteAll.run(ownerUserId)
  return info.changes
}

// Returns a persisted secret value, generating and storing one on first use.
// Survives process restarts (unlike a random in-memory Buffer), so data encrypted
// with it stays decryptable across deploys/restarts.
function getOrCreateSecret(name) {
  const existing = getSecretStmt.get(name)
  if (existing) return existing.value
  const value = crypto.randomBytes(32).toString('hex')
  insertSecretStmt.run(name, value, Date.now())
  // Re-read in case of a concurrent-insert race (INSERT OR IGNORE) — ensures every
  // caller converges on the single stored value rather than each keeping its own.
  return getSecretStmt.get(name).value
}

function rowToProfile(row) {
  if (!row) return null
  return {
    userId: row.user_id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    photoPath: row.photo_path,
    updatedAt: row.updated_at,
  }
}

// Returns null if the user has never set up a profile.
function getProfile(userId) {
  return rowToProfile(getProfileStmt.get(userId))
}

// Self-service profile fields only — photo is set separately via
// setProfilePhotoPath() once the file has actually been written to disk, and is
// never touched by this call (existing photo_path is preserved on update).
function upsertProfile(userId, { firstName, lastName, email }) {
  upsertProfileStmt.run({
    userId,
    firstName: firstName ?? null,
    lastName: lastName ?? null,
    email: email ?? null,
    updatedAt: Date.now(),
  })
  return getProfile(userId)
}

// Records where a user's uploaded photo lives on disk (server/uploads/profiles/…).
// Creates a bare profile row if one doesn't exist yet (e.g. photo uploaded before
// first/last name were ever set).
function setProfilePhotoPath(userId, photoPath) {
  setPhotoPathStmt.run(userId, photoPath, Date.now())
  return getProfile(userId)
}

// Returns { category: monthlyLimit, ... } for every budget the owner has set (including
// the reserved overall-budget category, if set) — empty object if none set yet.
function getBudgets(ownerUserId) {
  const rows = getBudgetsStmt.all(ownerUserId)
  const map = {}
  rows.forEach(r => { map[r.category] = r.monthly_limit })
  return map
}

// Upserts a single category's monthly limit and returns the owner's full updated budget
// map, so callers can broadcast one consistent snapshot rather than a single delta.
function setBudget(ownerUserId, category, monthlyLimit) {
  upsertBudgetStmt.run(ownerUserId, category, monthlyLimit, Date.now())
  return getBudgets(ownerUserId)
}

module.exports = {
  db,
  TABLES,
  getOrAssignUserId,
  getList,
  appendItem,
  updateItem,
  deleteItem,
  deleteAllForOwner,
  getOrCreateSecret,
  getProfile,
  upsertProfile,
  setProfilePhotoPath,
  getBudgets,
  setBudget,
}
