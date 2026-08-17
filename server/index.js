const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { WebSocketServer, WebSocket } = require('ws')
const { AccessToken } = require('livekit-server-sdk')
const { ProxyAgent, setGlobalDispatcher } = require('undici')
const store = require('./store')
const firebaseAdmin = require('./firebaseAdmin')

// Respect standard HTTP(S)_PROXY env vars for outbound fetch() calls (e.g.
// to Quran Foundation) — Node's built-in fetch doesn't honor these by
// default, unlike curl. No-op when no proxy is configured.
const outboundProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
if (outboundProxy) setGlobalDispatcher(new ProxyAgent(outboundProxy))

// Falls back to a well-known insecure dev PIN if ADMIN_PIN isn't set, so local dev
// keeps working with zero setup — but this is NEVER safe for production, hence the
// loud startup warning below (see server.listen callback).
const ADMIN_PIN   = process.env.ADMIN_PIN || '1234'
const CLIENT_DIR  = path.join(__dirname, '../client/dist')
const MAX_FILE_MB = 200

// Skips real Firebase phone verification entirely when set — lets local dev log in
// with any name, no SMS round-trip. Only ever set locally; production's systemd unit
// has no DEV_AUTH_BYPASS entry, so this branch is dead code there.
const DEV_AUTH_BYPASS = process.env.DEV_AUTH_BYPASS === 'true'
if (DEV_AUTH_BYPASS) {
  console.warn('⚠️  DEV_AUTH_BYPASS=true — phone/OTP verification is DISABLED. Local dev only, never set this in production.')
}
const verifyIdentity = DEV_AUTH_BYPASS
  ? (idToken, name) => Promise.resolve(`dev:${(name || 'anon').trim().toLowerCase() || 'anon'}`)
  : (idToken) => firebaseAdmin.verifyPhoneToken(idToken)

// Profile photos — persistent (no TTL, unlike the screenshot/file-transfer stores
// above), stored as plain files on the VM's disk. Small scale, no need for a DB
// blob or cloud storage.
const UPLOADS_DIR        = path.join(__dirname, 'uploads')
const PROFILE_PHOTOS_DIR = path.join(UPLOADS_DIR, 'profiles')
const MAX_PHOTO_MB       = 5
fs.mkdirSync(PROFILE_PHOTOS_DIR, { recursive: true })

// Stable userIds look like `${seq}-${4 random base36 chars}` (see makeId() below) —
// validate any userId taken from a URL path against that shape before touching the
// filesystem with it, so a hostile path segment can never escape PROFILE_PHOTOS_DIR.
const isValidUserId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)

// ── Simple in-memory PIN brute-force guard ──────────────────────────────────
// Per-source (IP for HTTP, remote address for WS) attempt tracking: 5 failed
// attempts within 5 minutes locks that source out for 15 minutes. Not meant to
// stop a distributed attacker — just closes the trivial single-IP brute-force
// case against a short numeric PIN.
const PIN_ATTEMPT_WINDOW_MS = 5 * 60 * 1000
const PIN_LOCKOUT_MS        = 15 * 60 * 1000
const PIN_MAX_ATTEMPTS      = 5
const pinAttempts = new Map() // source → { count, firstAttemptAt, lockedUntil }

// Returns { locked: true } if this source is currently locked out. Otherwise returns
// { locked: false }. Call recordPinFailure()/clearPinAttempts() based on the outcome
// of the PIN check that follows.
function checkPinLockout(source) {
  const rec = pinAttempts.get(source)
  if (!rec) return { locked: false }
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return { locked: true }
  // Lockout expired or window expired — reset
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) {
    pinAttempts.delete(source)
    return { locked: false }
  }
  if (Date.now() - rec.firstAttemptAt > PIN_ATTEMPT_WINDOW_MS) {
    pinAttempts.delete(source)
    return { locked: false }
  }
  return { locked: false }
}

function recordPinFailure(source) {
  const now = Date.now()
  let rec = pinAttempts.get(source)
  if (!rec || now - rec.firstAttemptAt > PIN_ATTEMPT_WINDOW_MS) {
    rec = { count: 0, firstAttemptAt: now, lockedUntil: 0 }
  }
  rec.count += 1
  if (rec.count >= PIN_MAX_ATTEMPTS) {
    rec.lockedUntil = now + PIN_LOCKOUT_MS
  }
  pinAttempts.set(source, rec)
}

function clearPinAttempts(source) {
  pinAttempts.delete(source)
}

// Gates plain HTTP GETs (e.g. <img src>, which can't carry a WebSocket session or custom
// auth headers) behind the same PIN already used for admin WebSocket auth. Returns a
// status so callers can tell a locked-out source (→ 429) apart from a bad PIN (→ 403).
function checkAdminAuth(req) {
  const ip = req.socket.remoteAddress
  if (checkPinLockout(ip).locked) return 'locked'
  const params = new URL(req.url, 'http://x').searchParams
  const pin = params.get('pin') || req.headers['x-admin-pin']
  const ok = pin === ADMIN_PIN
  if (ok) { clearPinAttempts(ip); return 'ok' }
  recordPinFailure(ip)
  return 'forbidden'
}

// Auto-update: the repo is private, so the client never gets a GitHub token — the server
// looks up the latest release and proxies the actual APK download itself.
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || ''
const GITHUB_REPO  = 'dailycoder09/apkformobile'
let releaseCache = { data: null, fetchedAt: 0 }
const RELEASE_CACHE_TTL = 5 * 60 * 1000

async function fetchLatestRelease() {
  if (releaseCache.data && Date.now() - releaseCache.fetchedAt < RELEASE_CACHE_TTL) return releaseCache.data
  const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/latest-build`, {
    headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' },
  })
  if (!res.ok) throw new Error(`GitHub API ${res.status}`)
  const data = await res.json()
  releaseCache = { data, fetchedAt: Date.now() }
  return data
}

// In-memory file store: requestId → { data, mime, name, adminId, fromUserId }
// Auto-expires after 10 minutes
const fileStore = new Map()

// Bounds how many uploads can be buffering into memory at once (each up to MAX_FILE_MB).
const MAX_CONCURRENT_UPLOADS = 5
let activeUploads = 0

// Screenshot store: id → { iv, authTag, ciphertext, userId, userName, ts }
// Keyed by userId for list lookup: screenshotIndex userId → [id, ...]
// Encrypted at rest (AES-256-GCM) — plaintext is never stored. Key is persisted via
// store.getOrCreateSecret so it survives process restarts (same durable-storage pattern
// already used for transactions/browsing/call-logs); SCREENSHOT_ENC_KEY still wins if
// explicitly set, for deployment flexibility.
const screenshotStore = new Map()
const screenshotIndex = new Map()  // userId → [id, ...]
const SCREENSHOT_TTL  = 24 * 60 * 60 * 1000  // 24 h
const SCREENSHOT_KEY  = process.env.SCREENSHOT_ENC_KEY
  ? Buffer.from(process.env.SCREENSHOT_ENC_KEY, 'base64')
  : Buffer.from(store.getOrCreateSecret('screenshot_key'), 'hex')

// Per-session upload token — proves "I am the live WS connection for this userId" to the
// HTTP profile-photo/screenshot POST endpoints below, which (being raw POSTs, not the WS
// itself) otherwise have no way to authenticate the caller. Same persisted-secret pattern
// as SCREENSHOT_KEY above, so the HMAC stays valid across process restarts.
const UPLOAD_TOKEN_SECRET = store.getOrCreateSecret('upload_token_secret')

function encryptScreenshot(data) {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', SCREENSHOT_KEY, iv)
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()])
  return { iv, authTag: cipher.getAuthTag(), ciphertext }
}

function decryptScreenshot(shot) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', SCREENSHOT_KEY, shot.iv)
  decipher.setAuthTag(shot.authTag)
  return Buffer.concat([decipher.update(shot.ciphertext), decipher.final()])
}

function storeScreenshot(userId, userName, data) {
  const id = `${userId}-${Date.now()}`
  const { iv, authTag, ciphertext } = encryptScreenshot(data)
  screenshotStore.set(id, { iv, authTag, ciphertext, userId, userName, ts: Date.now() })
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

// ── Quran Foundation OAuth2 (client_credentials) — token cached in memory ──
let qfToken = null
let qfTokenExpiresAt = 0

function qfOauthBase() {
  return process.env.QURAN_FOUNDATION_ENV === 'production'
    ? 'https://oauth2.quran.foundation'
    : 'https://prelive-oauth2.quran.foundation'
}
function qfApiBase() {
  return process.env.QURAN_FOUNDATION_ENV === 'production'
    ? 'https://apis.quran.foundation'
    : 'https://apis-prelive.quran.foundation'
}

async function getQuranFoundationToken(forceRefresh = false) {
  if (!forceRefresh && qfToken && Date.now() < qfTokenExpiresAt) return qfToken
  const clientId     = process.env.QURAN_FOUNDATION_CLIENT_ID
  const clientSecret = process.env.QURAN_FOUNDATION_CLIENT_SECRET
  const res = await fetch(`${qfOauthBase()}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: 'grant_type=client_credentials&scope=content',
  })
  if (!res.ok) throw new Error(`Quran Foundation token request failed: ${res.status}`)
  const json = await res.json()
  qfToken = json.access_token
  qfTokenExpiresAt = Date.now() + Math.max(0, (json.expires_in || 3600) - 60) * 1000
  return qfToken
}

async function fetchQuranIndopak(query) {
  const clientId = process.env.QURAN_FOUNDATION_CLIENT_ID
  const url = `${qfApiBase()}/content/api/v4/quran/verses/indopak?${query}`
  let token = await getQuranFoundationToken()
  let res = await fetch(url, { headers: { 'x-auth-token': token, 'x-client-id': clientId } })
  if (res.status === 401) {
    token = await getQuranFoundationToken(true)
    res = await fetch(url, { headers: { 'x-auth-token': token, 'x-client-id': clientId } })
  }
  if (!res.ok) throw new Error(`Quran Foundation API error: ${res.status}`)
  return res.json()
}

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

      // fromUserId is client-supplied and used to attribute the file_ready notification —
      // only trust it if it actually matches a currently-connected user session, otherwise
      // any device could impersonate another child's uploads.
      if (fromUserId && !users.has(fromUserId)) {
        res.writeHead(403); res.end('Unknown or disconnected user session'); return
      }

      // Cap total concurrent in-flight uploads — each one buffers up to MAX_FILE_MB in
      // memory, so unbounded concurrency is an easy way to OOM the process.
      if (activeUploads >= MAX_CONCURRENT_UPLOADS) {
        res.writeHead(503); res.end('Too many concurrent uploads — try again shortly'); return
      }
      activeUploads++
      let uploadCounted = true
      const releaseUpload = () => { if (uploadCounted) { uploadCounted = false; activeUploads-- } }

      const chunks = []
      let totalBytes = 0
      const maxBytes = MAX_FILE_MB * 1024 * 1024

      req.on('data', chunk => {
        totalBytes += chunk.length
        if (totalBytes > maxBytes) {
          req.destroy()
          releaseUpload()
          res.writeHead(413); res.end(`File exceeds ${MAX_FILE_MB}MB limit`)
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        releaseUpload()
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

      req.on('error', () => { releaseUpload(); res.writeHead(500); res.end('Upload error') })
      return
    }

    // ── File download for admin (supports Range for video streaming) ─────
    if (req.method === 'GET' && urlPath.startsWith('/api/file/')) {
      const authStatus = checkAdminAuth(req)
      if (authStatus === 'locked') { res.writeHead(429); res.end('Too many attempts — try again later'); return }
      if (authStatus !== 'ok') { res.writeHead(403); res.end('Forbidden'); return }
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
    // Gated by the per-session upload token (X-Upload-Token) issued at WS auth time — see
    // verifyUploadToken() above. Previously this endpoint trusted the bare :userId path
    // segment with NO check at all, and userId is broadcast in plaintext to every
    // connected client (auth_ok's own `users` field, and every users_list broadcast), so
    // any authenticated family member could learn a sibling's userId and inject a
    // fabricated screenshot attributed to them.
    if (req.method === 'POST' && urlPath.startsWith('/api/screenshot/')) {
      const userId   = urlPath.replace('/api/screenshot/', '')
      const presentedToken = req.headers['x-upload-token'] || ''
      if (!verifyUploadToken(userId, presentedToken)) {
        res.writeHead(403); res.end('Invalid or missing upload token'); return
      }
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
      const authStatus = checkAdminAuth(req)
      if (authStatus === 'locked') { res.writeHead(429); res.end('Too many attempts — try again later'); return }
      if (authStatus !== 'ok') { res.writeHead(403); res.end('Forbidden'); return }
      const userId = urlPath.replace('/api/screenshots/', '')
      const ids = screenshotIndex.get(userId) || []
      const list = ids.map(id => {
        const s = screenshotStore.get(id)
        return s ? { id, ts: s.ts, size: s.ciphertext.length } : null
      }).filter(Boolean).sort((a, b) => b.ts - a.ts)
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ screenshots: list }))
      return
    }

    // ── Single screenshot download ───────────────────────────────────────────
    if (req.method === 'GET' && urlPath.startsWith('/api/screenshot/')) {
      const authStatus = checkAdminAuth(req)
      if (authStatus === 'locked') { res.writeHead(429); res.end('Too many attempts — try again later'); return }
      if (authStatus !== 'ok') { res.writeHead(403); res.end('Forbidden'); return }
      const id = urlPath.replace('/api/screenshot/', '')
      const shot = screenshotStore.get(id)
      if (!shot) { res.writeHead(404); res.end('Not found or expired'); return }
      try {
        const data = decryptScreenshot(shot)
        res.writeHead(200, { ...CORS, 'Content-Type': 'image/webp', 'Content-Length': data.length })
        res.end(data)
      } catch (e) {
        res.writeHead(500, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Could not decrypt screenshot' }))
      }
      return
    }

    // ── Profile photo upload (self-service) ──────────────────────────────────
    // Gated by the per-session upload token (X-Upload-Token) issued at WS auth time — see
    // verifyUploadToken() above. Unlike the WS connection (which knows exactly who
    // authenticated via the Firebase-verified phone number), a plain HTTP POST doesn't
    // carry that session inherently, so the token is the proof of identity: it's minted
    // fresh per connection and sent only to that connection's own auth_ok response, never
    // broadcast. This replaces the previous, weaker check (merely "does :userId have SOME
    // live WS session" — trivially defeatable since userId itself is broadcast in
    // plaintext to every connected client via auth_ok's `users` field and users_list).
    if (req.method === 'POST' && urlPath.startsWith('/api/profile-photo/')) {
      const userId = decodeURIComponent(urlPath.replace('/api/profile-photo/', ''))
      if (!isValidUserId(userId)) { res.writeHead(400); res.end('Invalid userId'); return }
      const presentedToken = req.headers['x-upload-token'] || ''
      if (!verifyUploadToken(userId, presentedToken)) {
        res.writeHead(403); res.end('Invalid or missing upload token'); return
      }

      const chunks = []
      let total = 0
      let rejected = false
      const maxBytes = MAX_PHOTO_MB * 1024 * 1024

      req.on('data', (chunk) => {
        if (rejected) return
        total += chunk.length
        if (total > maxBytes) {
          rejected = true
          req.destroy()
          res.writeHead(413); res.end(`Photo exceeds ${MAX_PHOTO_MB}MB limit`)
          return
        }
        chunks.push(chunk)
      })

      req.on('end', () => {
        if (rejected) return
        const data = Buffer.concat(chunks)
        const destPath = path.join(PROFILE_PHOTOS_DIR, `${userId}.jpg`)
        fs.writeFile(destPath, data, (err) => {
          if (err) {
            console.error('Profile photo write error:', err.message)
            res.writeHead(500); res.end('Failed to save photo'); return
          }
          store.setProfilePhotoPath(userId, destPath)
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true, photoUrl: `/api/profile-photo/${userId}` }))
        })
      })

      req.on('error', () => { res.writeHead(500); res.end('Upload error') })
      return
    }

    // ── Profile photo download ────────────────────────────────────────────────
    // Ungated on purpose — it's just a family member's own display photo, not
    // sensitive monitoring data like screenshots/file transfers, so there's no
    // reason a child should need the admin PIN to see their own picture.
    if (req.method === 'GET' && urlPath.startsWith('/api/profile-photo/')) {
      const userId = decodeURIComponent(urlPath.replace('/api/profile-photo/', ''))
      if (!isValidUserId(userId)) { res.writeHead(400); res.end('Invalid userId'); return }
      const filePath = path.join(PROFILE_PHOTOS_DIR, `${userId}.jpg`)
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return }
        res.writeHead(200, { ...CORS, 'Content-Type': 'image/jpeg', 'Content-Length': data.length })
        res.end(data)
      })
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

    // Quran Foundation Indo-Pak script proxy — keeps client_secret server-side
    // per their docs (never call their OAuth2 API directly from browser JS).
    if (urlPath === '/api/quran-indopak' && req.method === 'GET') {
      const clientId     = process.env.QURAN_FOUNDATION_CLIENT_ID
      const clientSecret = process.env.QURAN_FOUNDATION_CLIENT_SECRET
      if (!clientId || !clientSecret) {
        res.writeHead(503, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Quran Foundation API not configured' }))
        return
      }
      const params  = new URL(req.url, 'http://x').searchParams
      const chapter = params.get('chapter')
      const verseKey = params.get('verse_key')
      if (!chapter && !verseKey) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Provide chapter or verse_key' }))
        return
      }
      const query = verseKey ? `verse_key=${encodeURIComponent(verseKey)}` : `chapter_number=${encodeURIComponent(chapter)}`
      try {
        const data = await fetchQuranIndopak(query)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify(data))
      } catch (e) {
        res.writeHead(502, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // Version check endpoint for auto-update — looks up the real latest GitHub release
    // (repo is private, so this can't just be a static env var or a public download link)
    if (urlPath === '/api/version') {
      try {
        const release = await fetchLatestRelease()
        const versionName = (release.body || '').match(/versionName:\s*(\S+)/)?.[1] || release.tag_name
        // Absolute URL — the native app's WebView serves its own bundled assets from a local
        // origin, so a relative path here would NOT resolve to this server.
        const apkUrl = `https://${req.headers.host}/api/app-download`
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' })
        res.end(JSON.stringify({ version: versionName, apkUrl }))
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
      return
    }

    // Streams the actual APK bytes through this server so the client never needs a
    // GitHub token or a private-repo URL.
    if (urlPath === '/api/app-download') {
      try {
        const release = await fetchLatestRelease()
        const asset = release.assets?.find(a => a.name === 'meeee.apk')
        if (!asset) { res.writeHead(404); res.end('APK asset not found'); return }
        const assetRes = await fetch(asset.url, {
          headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/octet-stream' },
        })
        if (!assetRes.ok || !assetRes.body) { res.writeHead(502); res.end('Failed to fetch APK'); return }
        res.writeHead(200, {
          'Content-Type': 'application/vnd.android.package-archive',
          'Content-Disposition': 'attachment; filename="meeee.apk"',
          ...(asset.size ? { 'Content-Length': asset.size } : {}),
        })
        Readable.fromWeb(assetRes.body).pipe(res)
      } catch (e) {
        res.writeHead(502, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
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

// Builds the WS-facing profile payload (see profile_get/profile_update) — photoUrl
// is a server-relative path the client fetches separately over plain HTTP, never
// inline bytes in the JSON message.
function toProfilePayload(userId, profile) {
  return {
    firstName: profile?.firstName ?? null,
    lastName: profile?.lastName ?? null,
    email: profile?.email ?? null,
    photoUrl: profile?.photoPath ? `/api/profile-photo/${userId}` : null,
  }
}

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

// Mints a fresh per-connection upload token, tied to this one WS session via a random
// nonce baked into the HMAC input — two connections for the same userId (e.g. primary +
// bg) never end up with the same token. Lives only in that connection's in-memory meta
// (see callers below); never persisted, never sent anywhere but that socket's own
// auth_ok, and never included in getUserList()/broadcastToAdmins/broadcastAll.
function issueUploadToken(stableId) {
  const nonce = crypto.randomBytes(8).toString('hex')
  const uploadToken = crypto.createHmac('sha256', UPLOAD_TOKEN_SECRET).update(`${stableId}:${nonce}`).digest('hex')
  return { uploadToken, nonce }
}

// Checks a token presented over HTTP (X-Upload-Token) against whatever live WS
// connection(s) currently exist for userId. A legitimate upload can come from either the
// primary browser/app session or its linked native background session (KeepAliveService),
// so both are checked — same primary↔bgWs linkage the admin command routing already uses
// (see target.bgWs || target.ws elsewhere in this file). Constant-time comparison so a
// byte-by-byte timing side channel can't help an attacker guess another session's token.
function verifyUploadToken(userId, presentedToken) {
  if (!presentedToken) return false
  const primary = users.get(userId)
  if (!primary) return false
  const candidates = [primary.uploadToken]
  if (primary.bgWs) {
    const bgMeta = byWs.get(primary.bgWs)
    if (bgMeta) candidates.push(bgMeta.uploadToken)
  }
  const presentedBuf = Buffer.from(presentedToken)
  return candidates.some((token) => {
    if (!token) return false
    const tokenBuf = Buffer.from(token)
    return tokenBuf.length === presentedBuf.length && crypto.timingSafeEqual(tokenBuf, presentedBuf)
  })
}

wss.on('connection', (ws, req) => {
  let meta = null
  let authPending = false // guards against a second 'auth' message racing in while
                           // the first one's Firebase verification is still in flight
  const remoteAddress = req.socket.remoteAddress

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw)

      // ── Authentication ─────────────────────────────
      if (msg.type === 'auth') {
        if (meta || authPending) return

        if (msg.role === 'admin') {
          if (checkPinLockout(remoteAddress).locked) {
            send(ws, { type: 'auth_fail', reason: 'Too many attempts — try again later' })
            return
          }
          if (msg.pin !== ADMIN_PIN) {
            recordPinFailure(remoteAddress)
            send(ws, { type: 'auth_fail', reason: 'Wrong PIN' })
            return
          }
          clearPinAttempts(remoteAddress)
          // Admins aren't monitored family members — they don't have a phone-verified
          // identity or a known_users/profiles row, just a fresh per-connection id.
          const userId = makeId()
          meta = { ws, role: 'admin', userId, name: 'Parent' }
          admins.set(userId, meta)
          byWs.set(ws, meta)
          send(ws, { type: 'auth_ok', role: 'admin', userId, users: getUserList() })
          return
        }

        if (msg.role === 'user') {
          // Identity now comes from a Firebase-verified phone number, never from the
          // freely-editable `name` field — this is the fix for the exact hijack hole
          // this rework exists to close (registering with someone else's name used
          // to force-disconnect and steal their session). `name` is purely cosmetic
          // from here on: a display label, never used to look anyone up.
          //
          // Wire contract (documented in full in the security-rework report):
          //   Primary: { type: 'auth', role: 'user', idToken, name }
          //   Background (KeepAliveService): { type: 'auth', role: 'user', idToken, name, isBg: true }
          // `isBg` is an explicit boolean now — replaces the old `name.endsWith('__bg__')`
          // string-suffix hack, which is no longer necessary once there's a real
          // verified identity (userId) to link bg↔primary against.
          const isBg = msg.isBg === true
          authPending = true

          verifyIdentity(msg.idToken, msg.name).then((phoneNumber) => {
            authPending = false
            if (meta) return // connection already authenticated by another message

            const stableId = store.getOrAssignUserId(phoneNumber)
            const name = (msg.name || '').trim().slice(0, 30) || `User-${stableId.split('-')[0]}`

            if (isBg) {
              // Background service: link to the existing primary session for this
              // same verified phone number — never by string-matching the name.
              const existing = users.get(stableId)
              if (!existing) {
                send(ws, { type: 'auth_fail', reason: 'No active primary session for this account' })
                return
              }
              // Store bg ws on the existing meta so file requests go to native
              existing.bgWs = ws
              // Bg gets its own independent upload token — it's a separate live connection
              // from the primary, with its own lifetime, even though both share a userId.
              const bgToken = issueUploadToken(stableId)
              meta = { ws, role: 'user', userId: stableId, name, isBg: true, primaryId: existing.userId, uploadToken: bgToken.uploadToken, uploadNonce: bgToken.nonce }
              byWs.set(ws, meta)
              // Give native service the same userId as the JS session. uploadToken here is
              // sent ONLY on this socket's own auth_ok — never broadcast (see getUserList()).
              send(ws, { type: 'auth_ok', role: 'user', userId: existing.userId, name, users: [], uploadToken: bgToken.uploadToken })
              return
            }

            // Reconnect to an existing session for the same verified phone number —
            // preserves userId (so admin panel's targetUser.id stays valid) across
            // screen-lock/app-relaunch reconnects. Two connections presenting valid
            // tokens for the SAME phone are legitimately the same person reconnecting;
            // two connections for DIFFERENT phones can never collide, regardless of
            // what `name` either one sends.
            const reconnecting = users.get(stableId)
            if (reconnecting) {
              byWs.delete(reconnecting.ws)
              try { reconnecting.ws.close() } catch {}
              reconnecting.ws = ws
              reconnecting.name = name
              // Fresh upload token on every (re)connect — the old one dies with the old socket.
              const { uploadToken, nonce } = issueUploadToken(stableId)
              reconnecting.uploadToken = uploadToken
              reconnecting.uploadNonce = nonce
              meta = reconnecting
              byWs.set(ws, meta)
              // uploadToken sent ONLY here, on this socket's own auth_ok — never in
              // getUserList()/users_list or any broadcastToAdmins/broadcastAll payload.
              send(ws, { type: 'auth_ok', role: 'user', userId: stableId, name, users: getUserList(), uploadToken })
              // No user_left / user_joined — seamless reconnect, same userId
              return
            }

            const { uploadToken, nonce } = issueUploadToken(stableId)
            meta = { ws, role: 'user', userId: stableId, name, isBg: false, uploadToken, uploadNonce: nonce }
            users.set(stableId, meta)
            byWs.set(ws, meta)
            send(ws, { type: 'auth_ok', role: 'user', userId: stableId, name, users: getUserList(), uploadToken })
            broadcastToAdmins({ type: 'user_joined', user: { id: stableId, name } })
            broadcastAll({ type: 'users_list', users: getUserList() })
          }).catch((err) => {
            authPending = false
            send(ws, { type: 'auth_fail', reason: `Phone verification failed: ${err.message}` })
          })
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
          return
        }
        // start_camera → both: browser ws (LiveKit publish) AND bgWs (JPEG fallback)
        if (msg.type === 'start_camera') {
          const target = users.get(msg.targetId)
          if (target) {
            send(target.ws, { ...msg, fromAdminId: meta.userId })
            if (target.bgWs) send(target.bgWs, { ...msg, fromAdminId: meta.userId })
          }
          return
        }
        // Admin DM to a specific user
        if (msg.type === 'dm') {
          const target = [...byWs.values()].find(m => m.userId === msg.toId)
          if (target) {
            const out = { type: 'dm', text: msg.text, from: meta.name, fromId: meta.userId, toId: msg.toId, ts: Date.now() }
            send(target.ws, out)
            send(ws, { ...out, own: true })
          }
          return
        }
        // Not one of the above — fall through to the admin handlers below
        // (transactions_get, browsing_get, etc.)
      }

      // ── Admin commands ── transactions ─────────────
      // Data tables are now keyed directly by the stable userId (not by name), so
      // admin handlers no longer need a userId→name resolution step beforehand —
      // this replaces the old resolveOwnerName() indirection entirely.
      if (meta.role === 'admin' && msg.type === 'transactions_get') {
        const list = store.getList(store.TABLES.TRANSACTIONS, msg.userId)
        send(ws, { type: 'transactions_list', userId: msg.userId, transactions: list })
        return
      }

      // Admin-only: wipe all transactions for a family member (e.g. "Clear All" scoped
      // to whichever user is selected in AdminTransactionView.jsx).
      if (meta.role === 'admin' && msg.type === 'transaction_delete_all') {
        store.deleteAllForOwner(store.TABLES.TRANSACTIONS, msg.userId)
        broadcastToAdmins({ type: 'transactions_cleared', userId: msg.userId })
        return
      }

      // ── Admin commands ── browsing activity ─────────
      if (meta.role === 'admin' && msg.type === 'browsing_get') {
        const list = store.getList(store.TABLES.BROWSING_HISTORY, msg.userId)
        send(ws, { type: 'browsing_list', userId: msg.userId, entries: list })
        return
      }

      // Admin-only: wipe all browsing history for a child. No client UI wired up to this
      // yet — a "Delete history" button in AdminBrowsingView.jsx is a follow-up.
      if (meta.role === 'admin' && msg.type === 'browsing_delete_all') {
        store.deleteAllForOwner(store.TABLES.BROWSING_HISTORY, msg.userId)
        broadcastToAdmins({ type: 'browsing_cleared', userId: msg.userId })
        return
      }

      // ── Admin commands ── call log ───────────────────
      if (meta.role === 'admin' && msg.type === 'call_log_get') {
        const list = store.getList(store.TABLES.CALL_LOGS, msg.userId)
        send(ws, { type: 'call_log_list', userId: msg.userId, entries: list })
        return
      }

      // Admin-only: wipe all call log entries for a child. No client UI wired up to this
      // yet — a "Delete history" button in AdminCallLogView.jsx is a follow-up.
      if (meta.role === 'admin' && msg.type === 'call_log_delete_all') {
        store.deleteAllForOwner(store.TABLES.CALL_LOGS, msg.userId)
        broadcastToAdmins({ type: 'call_log_cleared', userId: msg.userId })
        return
      }

      // ── Admin commands ── profile (view-only; editing is self-service) ──
      if (meta.role === 'admin' && msg.type === 'profile_get') {
        const profile = store.getProfile(msg.userId)
        send(ws, { type: 'profile', userId: msg.userId, profile: toProfilePayload(msg.userId, profile) })
        return
      }

      // ── Admin commands ── budgets (a parent can view/set budgets for a child, same
      // dual-role model as transactions: the child manages their own, the admin can
      // also set/override for guidance) ──
      if (meta.role === 'admin' && msg.type === 'budget_get') {
        const budgets = store.getBudgets(msg.userId)
        send(ws, { type: 'budgets', userId: msg.userId, budgets })
        return
      }
      if (meta.role === 'admin' && msg.type === 'budget_set') {
        const category = String(msg.category || '').trim().slice(0, 100)
        const monthlyLimit = Number(msg.monthlyLimit)
        if (!msg.userId || !category || !Number.isFinite(monthlyLimit) || monthlyLimit < 0) return
        const budgets = store.setBudget(msg.userId, category, monthlyLimit)
        broadcastToAdmins({ type: 'budgets', userId: msg.userId, budgets })
        // Push the same update to the child's own live session (if connected) so their
        // budget view updates in real time when a parent sets/overrides it.
        const target = users.get(msg.userId)
        if (target) send(target.bgWs || target.ws, { type: 'budgets', userId: msg.userId, budgets })
        return
      }

      // ── User messages ───────────────────────────────
      if (meta.role === 'user') {
        // Transaction added by user (manual or auto-captured) — store + broadcast to admins.
        // Native background connections (KeepAliveService) authenticate under their own
        // throwaway userId; attribute their transactions to the real (primary) session instead.
        if (msg.type === 'transaction_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const txn = { ...msg.transaction, userId: uid, userName: meta.name }
          // Dedup by exact id — e.g. re-uploading the same or an overlapping-date-range
          // PhonePe statement, whose ids are PhonePe's own unique transaction IDs. A fuzzy
          // amount/time-window check was considered instead, but real statement data shows
          // genuinely distinct transactions (different people, different ids) can share the
          // same type+amount within the same minute — that would falsely collapse them.
          const isDuplicate = store.getList(store.TABLES.TRANSACTIONS, uid).some(t => t.id === txn.id)
          if (!isDuplicate) {
            // INSERT OR IGNORE inside appendItem backstops this at the DB level too
            const inserted = store.appendItem(store.TABLES.TRANSACTIONS, uid, txn)
            if (inserted) broadcastToAdmins({ type: 'transaction_new', transaction: txn, fromUserId: uid, fromUserName: meta.name })
          }
          return
        }

        // Transaction edited by its owner — only the owner may edit their own entries
        if (msg.type === 'transaction_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const patch = { ...msg.transaction, userId: uid, userName: meta.name }
          const txn = store.updateItem(store.TABLES.TRANSACTIONS, uid, msg.transaction?.id, patch)
          if (!txn) return
          broadcastToAdmins({ type: 'transaction_updated', transaction: txn, fromUserId: uid })
          return
        }

        // Transaction deleted by its owner
        if (msg.type === 'transaction_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const deleted = store.deleteItem(store.TABLES.TRANSACTIONS, uid, msg.id)
          if (!deleted) return
          broadcastToAdmins({ type: 'transaction_deleted', id: msg.id, fromUserId: uid })
          return
        }

        // Self-fetch — user requesting their own transaction history
        if (msg.type === 'transactions_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const list = store.getList(store.TABLES.TRANSACTIONS, uid)
          send(ws, { type: 'transactions_list', userId: uid, transactions: list })
          return
        }

        // Self-clear — user wiping their own transaction history. Never trust a
        // client-supplied id for a self-action — resolve uid from the authenticated
        // session only, same principle as the self-fetch handler above.
        if (msg.type === 'transaction_delete_all') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.deleteAllForOwner(store.TABLES.TRANSACTIONS, uid)
          broadcastToAdmins({ type: 'transactions_cleared', userId: uid })
          send(ws, { type: 'transactions_cleared', userId: uid })
          return
        }

        // Self-fetch — user requesting their own budgets (overall + per-category, keyed
        // by the reserved OVERALL_BUDGET_CATEGORY / real category ids from the client).
        if (msg.type === 'budget_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const budgets = store.getBudgets(uid)
          send(ws, { type: 'budgets', userId: uid, budgets })
          return
        }

        // Self-service budget set — always applies to the authenticated session's own
        // userId, never a client-supplied target (same principle as the self-fetch/
        // self-clear handlers above). Broadcast to admins so a parent's view updates
        // live when the child sets/changes their own budget.
        if (msg.type === 'budget_set') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const category = String(msg.category || '').trim().slice(0, 100)
          const monthlyLimit = Number(msg.monthlyLimit)
          if (!category || !Number.isFinite(monthlyLimit) || monthlyLimit < 0) return
          const budgets = store.setBudget(uid, category, monthlyLimit)
          send(ws, { type: 'budgets', userId: uid, budgets })
          broadcastToAdmins({ type: 'budgets', userId: uid, budgets })
          return
        }

        // Browsing domain captured by the native DNS monitor — store + broadcast to admins.
        // Same bg-connection attribution as transactions: DnsMonitorVpnService talks to the
        // server via KeepAliveService's background socket, not the foreground session.
        if (msg.type === 'browsing_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const entry = { ...msg.entry, userId: uid, userName: meta.name }
          store.appendItem(store.TABLES.BROWSING_HISTORY, uid, entry)
          broadcastToAdmins({ type: 'browsing_new', entry, fromUserId: uid, fromUserName: meta.name })
          return
        }

        // Call log entry captured by the native ContentObserver — store + broadcast to admins.
        if (msg.type === 'call_log_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const entry = { ...msg.entry, userId: uid, userName: meta.name }
          store.appendItem(store.TABLES.CALL_LOGS, uid, entry)
          broadcastToAdmins({ type: 'call_log_new', entry, fromUserId: uid, fromUserName: meta.name })
          return
        }

        // Self-service profile — own view, e.g. to populate a "My Profile" screen.
        if (msg.type === 'profile_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const profile = store.getProfile(uid)
          send(ws, { type: 'profile', userId: uid, profile: toProfilePayload(uid, profile) })
          return
        }

        // Self-service profile update — always applies to the authenticated session's
        // own userId, never a client-supplied target (same principle as the
        // self-fetch/self-clear handlers above). Photo is handled separately via the
        // HTTP /api/profile-photo/:userId endpoints, not this message.
        if (msg.type === 'profile_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const profile = store.upsertProfile(uid, {
            firstName: (msg.firstName || '').trim().slice(0, 60) || null,
            lastName:  (msg.lastName  || '').trim().slice(0, 60) || null,
            email:     (msg.email     || '').trim().slice(0, 254) || null,
          })
          send(ws, { type: 'profile', userId: uid, profile: toProfilePayload(uid, profile) })
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
      const primary = users.get(meta.primaryId)
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
  if (process.env.ADMIN_PIN) {
    console.log('   Admin PIN: configured')
  } else {
    console.warn('   Admin PIN: NOT SET')
    console.warn('   ⚠️  ADMIN_PIN not set — using an insecure default. Set ADMIN_PIN in the environment before deploying.')
  }
  console.log(`   Dist:      ${fs.existsSync(CLIENT_DIR) ? '✓ found' : '✗ MISSING — run: npm --prefix client run build'}\n`)
})
