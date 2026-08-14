const path     = require('path')
const Database = require('better-sqlite3')

const db = new Database(path.join(__dirname, 'data.sqlite'))
db.pragma('journal_mode = WAL') // survives concurrent reads without blocking the single writer

const TABLES = {
  TRANSACTIONS: 'transactions',
  BROWSING_HISTORY: 'browsing_history',
  CALL_LOGS: 'call_logs',
}

for (const table of Object.values(TABLES)) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${table} (
      id TEXT NOT NULL,
      owner_name TEXT NOT NULL,
      ts INTEGER NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (id, owner_name)
    )
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_${table}_owner_ts ON ${table} (owner_name, ts DESC)`)
}

db.exec(`
  CREATE TABLE IF NOT EXISTS known_users (
    name TEXT PRIMARY KEY,
    user_id TEXT UNIQUE,
    created_at INTEGER
  )
`)

const stmts = {}
for (const table of Object.values(TABLES)) {
  stmts[table] = {
    getList: db.prepare(`SELECT data FROM ${table} WHERE owner_name = ? ORDER BY ts DESC`),
    getOne: db.prepare(`SELECT data FROM ${table} WHERE id = ? AND owner_name = ?`),
    insert: db.prepare(`INSERT OR IGNORE INTO ${table} (id, owner_name, ts, data) VALUES (?, ?, ?, ?)`),
    update: db.prepare(`UPDATE ${table} SET ts = ?, data = ? WHERE id = ? AND owner_name = ?`),
    delete: db.prepare(`DELETE FROM ${table} WHERE id = ? AND owner_name = ?`),
  }
}

const getUserStmt    = db.prepare('SELECT user_id FROM known_users WHERE name = ?')
const insertUserStmt = db.prepare('INSERT OR IGNORE INTO known_users (name, user_id, created_at) VALUES (?, ?, ?)')
const nameByIdStmt   = db.prepare('SELECT name FROM known_users WHERE user_id = ?')

let idSeq = 0
function makeId() { return `${++idSeq}-${Math.random().toString(36).slice(2, 6)}` }

function itemTs(item) {
  return item.date ?? item.timestamp ?? Date.now()
}

// Same id shape as index.js's own makeId() — kept independent so store.js has no
// dependency on index.js's module-scoped counter.
function getOrAssignUserId(name) {
  const existing = getUserStmt.get(name)
  if (existing) return existing.user_id
  const userId = makeId()
  insertUserStmt.run(name, userId, Date.now())
  return userId
}

function getNameForUserId(userId) {
  const row = nameByIdStmt.get(userId)
  return row ? row.name : null
}

function getList(table, ownerName) {
  return stmts[table].getList.all(ownerName).map(row => JSON.parse(row.data))
}

function appendItem(table, ownerName, item) {
  const id = item.id ?? makeId()
  const info = stmts[table].insert.run(id, ownerName, itemTs(item), JSON.stringify(item))
  return info.changes > 0
}

function updateItem(table, ownerName, id, patch) {
  const row = stmts[table].getOne.get(id, ownerName)
  if (!row) return null
  const merged = { ...JSON.parse(row.data), ...patch }
  stmts[table].update.run(itemTs(merged), JSON.stringify(merged), id, ownerName)
  return merged
}

function deleteItem(table, ownerName, id) {
  const info = stmts[table].delete.run(id, ownerName)
  return info.changes > 0
}

module.exports = {
  TABLES,
  getOrAssignUserId,
  getNameForUserId,
  getList,
  appendItem,
  updateItem,
  deleteItem,
}
