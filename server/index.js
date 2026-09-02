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
const { initSeedData } = require('./seed-data')

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

// Profile photos — persistent (no TTL, unlike the file-transfer store below),
// stored as plain files on the VM's disk. Small scale, no need for a DB blob or
// cloud storage.
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

// Stateless quick-pull tracking: requestId → { userId, pullToken, forAdminId, createdAt }.
// Created when the admin requests a file/directory listing (see quick_pull_ls/
// quick_pull_read_file above), validated when the device's brief FCM-triggered handler
// posts the result back over plain HTTP (see /api/ls/:requestId and the pullToken
// check added to /api/file/:requestId below) — this is the credential that lets a
// stateless request authenticate without any live WS session at all.
const pendingPulls = new Map()
const PENDING_PULL_TTL_MS = 3 * 60 * 1000 // generous vs. the ~20-30s goAsync() window

// Bounds how many uploads can be buffering into memory at once (each up to MAX_FILE_MB).
const MAX_CONCURRENT_UPLOADS = 5
let activeUploads = 0

// Per-session upload token — proves "I am the live WS connection for this userId" to the
// HTTP profile-photo POST endpoint below, which (being a raw POST, not the WS itself)
// otherwise has no way to authenticate the caller. Persisted via store.getOrCreateSecret
// so the HMAC stays valid across process restarts.
const UPLOAD_TOKEN_SECRET = store.getOrCreateSecret('upload_token_secret')

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
      let   adminId    = req.headers['x-admin-id'] || ''
      let   fromUserId = req.headers['x-user-id']  || ''
      const name       = decodeURIComponent(req.headers['x-file-name'] || 'file')
      const mime       = req.headers['content-type'] || 'application/octet-stream'

      // Two independent ways to prove this upload is legitimate: a live WS session's
      // per-connection upload token (unchanged, below), or — for a stateless quick-pull
      // request, which has no live WS session at all — the one-shot pullToken minted
      // when the admin requested it (see quick_pull_read_file above). Checking the pull
      // token FIRST means adminId/fromUserId are re-derived from the server's own
      // pendingPulls record rather than trusted from client-supplied headers.
      const presentedPullToken = req.headers['x-pull-token'] || ''
      if (presentedPullToken) {
        const pending = pendingPulls.get(requestId)
        const pendingBuf = pending ? Buffer.from(pending.pullToken) : null
        const presentedBuf = Buffer.from(presentedPullToken)
        const pullOk = pending && pendingBuf.length === presentedBuf.length &&
          crypto.timingSafeEqual(pendingBuf, presentedBuf)
        if (!pullOk) { res.writeHead(403); res.end('Invalid or expired pull token'); return }
        adminId = pending.forAdminId
        fromUserId = pending.userId
        pendingPulls.delete(requestId) // one-shot
        console.log(`quick-pull: file callback received requestId=${requestId} fromUserId=${fromUserId}${req.headers['x-error'] ? ` error=${req.headers['x-error']}` : ''}`)
      } else {
        // Same per-session upload token proof as the profile-photo endpoint below —
        // fromUserId/adminId are client-supplied headers with no inherent trust (userId is
        // broadcast in plaintext to every connected client via auth_ok/users_list), so the
        // previous "does fromUserId match SOME live session" check was defeatable by anyone
        // who simply knew a live child's userId. The token is minted fresh per WS connection
        // and sent only to that connection's own auth_ok reply, never broadcast.
        const presentedToken = req.headers['x-upload-token'] || ''
        if (!fromUserId || !verifyUploadToken(fromUserId, presentedToken)) {
          res.writeHead(403); res.end('Invalid or missing upload token'); return
        }
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
        const admin = admins.get(adminId)
        // A quick-pull device reports "file not found" / "too large" etc. by POSTing
        // here with an X-Error header and an empty body instead of real file bytes —
        // there's no separate error endpoint, this is the one place the admin is
        // already listening for a reply to this exact requestId.
        const deviceError = req.headers['x-error']
        if (deviceError) {
          if (admin) send(admin.ws, { type: 'file_error', requestId, error: deviceError, fromUserId })
          res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ ok: true }))
          return
        }

        const data = Buffer.concat(chunks)
        fileStore.set(requestId, { data, mime, name, adminId, fromUserId })

        // Notify the waiting admin via WebSocket
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

    // ── Directory listing from a stateless quick-pull (device-side: see
    // FamilyWatchMessagingService.java's quick_pull_ls handling) ───────────
    if (req.method === 'POST' && urlPath.startsWith('/api/ls/')) {
      const requestId = urlPath.replace('/api/ls/', '')
      const presentedPullToken = req.headers['x-pull-token'] || ''
      const pending = pendingPulls.get(requestId)
      const pendingBuf = pending ? Buffer.from(pending.pullToken) : null
      const presentedBuf = Buffer.from(presentedPullToken)
      const pullOk = pending && presentedPullToken && pendingBuf.length === presentedBuf.length &&
        crypto.timingSafeEqual(pendingBuf, presentedBuf)
      if (!pullOk) { res.writeHead(403); res.end('Invalid or expired pull token'); return }
      pendingPulls.delete(requestId) // one-shot

      const chunks = []
      let totalBytes = 0
      req.on('data', chunk => {
        totalBytes += chunk.length
        if (totalBytes > 2 * 1024 * 1024) { req.destroy(); res.writeHead(413); res.end('Listing too large'); return }
        chunks.push(chunk)
      })
      req.on('end', () => {
        let body
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return
        }
        const admin = admins.get(pending.forAdminId)
        console.log(`quick-pull: ls callback received requestId=${requestId} fromUserId=${pending.userId}${body.error ? ` error=${body.error}` : ''}`)
        if (admin) {
          send(admin.ws, {
            type: 'ls_result',
            forAdminId: pending.forAdminId,
            fromUserId: pending.userId,
            path: body.path || [],
            entries: body.entries || [],
            error: body.error || undefined,
          })
        }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Listing upload error') })
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
    // sensitive monitoring data like file transfers, so there's no reason a
    // child should need the admin PIN to see their own picture.
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

// Pushes a real, visible notification for a DM the recipient would otherwise never see
// at all — both `dm` handlers below only ever deliver to a live connection, with no
// persistence or fallback, so this is the WhatsApp-style "missed message" push. Called
// only when the recipient isn't currently connected; an active chat shouldn't also
// trigger a system notification. Fail-soft and silent: no device token (e.g. `toId` is
// an admin, who never registers one) or a send failure both just no-op — a notification
// problem must never surface as a DM-send error.
function notifyDmOffline(toId, fromName, text) {
  const device = store.getDeviceToken(toId)
  if (!device || !device.fcm_token) return
  const body = text.length > 120 ? text.slice(0, 117) + '...' : text
  firebaseAdmin.sendChatNotification(device.fcm_token, { title: fromName, body }).catch(() => {})
}

// Shared by device_list_get's reply and register_fcm_token's broadcast below, so an
// admin panel already open sees a newly-registered device without needing to reconnect.
function buildDeviceList() {
  return store.getAllDeviceTokens().map((d) => ({
    userId: d.user_id,
    name: d.name,
    updatedAt: d.updated_at,
    online: users.has(d.user_id),
    // Last-known location — KeepAliveService is dormant by default now, so a device usually
    // isn't live-streaming location; this is whatever it last reported before going quiet.
    lastLat: d.lat,
    lastLng: d.lng,
    lastAccuracy: d.accuracy,
    locationUpdatedAt: d.location_updated_at,
  }))
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

            // Seed dummy data for local dev on first connection
            initSeedData(stableId)

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
        // File browsing (ls/read_file) no longer routes through the live connection at
        // all — see quick_pull_ls/quick_pull_read_file below. Only genuinely *live*
        // actions (mic/location streaming) still need bgWs to be connected.
        if (['stop_camera', 'start_mic', 'stop_mic', 'start_location', 'stop_location'].includes(msg.type)) {
          const target = users.get(msg.targetId)
          if (target) {
            send(target.bgWs || target.ws, { ...msg, fromAdminId: meta.userId })
          } else if (['start_mic', 'start_location'].includes(msg.type)) {
            // KeepAliveService is dormant by default now, so "not connected" is common —
            // tell the admin why nothing happened instead of a silent dead end (stop_*
            // doesn't need this: stopping something already stopped is a no-op).
            send(ws, { type: 'target_offline', action: msg.type, userId: msg.targetId })
          }
          return
        }
        // ── Quick-pull file browsing — stateless, no persistent connection needed ──
        // Unlike every other admin→child command, this never touches `users`/bgWs at
        // all — it works purely off the durable device_tokens roster (same one
        // wake_user already uses), so a dormant/killed/MIUI-throttled device can still
        // be file-browsed. See FamilyWatchMessagingService.java's quick_pull_ls/
        // quick_pull_read_file handling for the device-side half of this.
        if (msg.type === 'quick_pull_ls' || msg.type === 'quick_pull_read_file') {
          const device = store.getDeviceToken(msg.targetId)
          if (!device || !device.fcm_token) {
            send(ws, { type: 'target_offline', action: msg.type, userId: msg.targetId })
            return
          }
          const requestId = msg.requestId || crypto.randomBytes(8).toString('hex')
          const pullToken = crypto.randomBytes(24).toString('hex')
          pendingPulls.set(requestId, {
            userId: msg.targetId, pullToken, forAdminId: meta.userId, createdAt: Date.now(),
          })
          setTimeout(() => pendingPulls.delete(requestId), PENDING_PULL_TTL_MS)
          const data = {
            type: msg.type,
            userId: msg.targetId,
            requestId,
            pullToken,
            path: JSON.stringify(msg.path || []),
          }
          if (msg.type === 'quick_pull_read_file') {
            data.preview = msg.preview ? '1' : '0'
          }
          firebaseAdmin.sendDataMessage(device.fcm_token, data).then(() => {
            console.log(`quick-pull: ${msg.type} requestId=${requestId} pushed to targetId=${msg.targetId}, awaiting device callback`)
          }).catch((e) => {
            pendingPulls.delete(requestId)
            console.error(`quick-pull: ${msg.type} requestId=${requestId} FCM send failed for targetId=${msg.targetId}: ${e.message}`)
            const errType = msg.type === 'quick_pull_ls' ? 'ls_result' : 'file_error'
            send(ws, { type: errType, forAdminId: meta.userId, fromUserId: msg.targetId, error: e.message, requestId, path: msg.path, entries: [] })
          })
          return
        }
        // start_camera → both: browser ws (LiveKit publish) AND bgWs (JPEG fallback)
        if (msg.type === 'start_camera') {
          const target = users.get(msg.targetId)
          if (target) {
            send(target.ws, { ...msg, fromAdminId: meta.userId })
            if (target.bgWs) send(target.bgWs, { ...msg, fromAdminId: meta.userId })
          } else {
            send(ws, { type: 'target_offline', action: msg.type, userId: msg.targetId })
          }
          return
        }
        // Admin DM to a specific user
        if (msg.type === 'dm') {
          const target = [...byWs.values()].find(m => m.userId === msg.toId)
          const out = { type: 'dm', text: msg.text, from: meta.name, fromId: meta.userId, toId: msg.toId, ts: Date.now() }
          // Sender always sees their own sent message locally, delivered or not —
          // matches how WhatsApp shows a message as sent immediately regardless of the
          // recipient's connection state, rather than only echoing on success.
          send(ws, { ...out, own: true })
          if (target) {
            send(target.ws, out)
          } else {
            notifyDmOffline(msg.toId, meta.name, msg.text)
          }
          return
        }
        // Not one of the above — fall through to the admin handlers below
        // (transactions_get, call_log_get, etc.)
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

      // ── Admin commands ── milestones (read-only parent view) ────
      if (meta.role === 'admin' && msg.type === 'milestone_data_get') {
        const milestones = store.getList(store.TABLES.MILESTONE_MILESTONES, msg.userId)
        const goals = store.getList(store.TABLES.MILESTONE_GOALS, msg.userId)
        const tasks = store.getList(store.TABLES.MILESTONE_TASKS, msg.userId)
        send(ws, { type: 'milestone_data', userId: msg.userId, milestones, goals, tasks })
        return
      }

      // ── Admin commands ── health tracker (read-only parent view) ────
      if (meta.role === 'admin' && msg.type === 'health_data_get') {
        const episodes = store.getList(store.TABLES.HEALTH_EPISODES, msg.userId)
        const reminders = store.getList(store.TABLES.HEALTH_REMINDERS, msg.userId)
        send(ws, { type: 'health_data', userId: msg.userId, episodes, reminders })
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

      // ── Admin commands ── wake a killed app ──────────
      // Unlike every other admin command above, this one's target doesn't need to be
      // currently connected — device_tokens is the durable roster (see
      // register_fcm_token above) that survives a killed app or a server restart, unlike
      // the in-memory `users` Map every other admin view reads from.
      if (meta.role === 'admin' && msg.type === 'device_list_get') {
        send(ws, { type: 'device_list', devices: buildDeviceList() })
        return
      }

      if (meta.role === 'admin' && msg.type === 'wake_user') {
        const device = store.getDeviceToken(msg.userId)
        if (!device || !device.fcm_token) {
          send(ws, { type: 'wake_result', userId: msg.userId, ok: false, reason: 'No device registered' })
          return
        }
        firebaseAdmin.sendDataMessage(device.fcm_token, { type: 'wake_app' })
          .then(() => send(ws, { type: 'wake_result', userId: msg.userId, ok: true }))
          .catch((e) => send(ws, { type: 'wake_result', userId: msg.userId, ok: false, reason: e.message }))
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

        // Khatabook — a personal ledger of informal money lent to / borrowed from people,
        // separate from bank-statement transactions above. Self-service only (no admin
        // broadcast — not surfaced to a parent's view, unlike transactions/budgets).

        // Self-fetch — bundles contacts + entries in one reply since the panel always
        // needs both to render (mirrors transactions_get's self-fetch pattern above).
        if (msg.type === 'ledger_data_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const contacts = store.getList(store.TABLES.LEDGER_CONTACTS, uid)
          const entries = store.getList(store.TABLES.LEDGER_ENTRIES, uid)
          send(ws, { type: 'ledger_data', contacts, entries })
          return
        }

        if (msg.type === 'ledger_contact_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const contact = { ...msg.contact }
          store.appendItem(store.TABLES.LEDGER_CONTACTS, uid, contact)
          return
        }

        if (msg.type === 'ledger_contact_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.updateItem(store.TABLES.LEDGER_CONTACTS, uid, msg.contact?.id, { ...msg.contact })
          return
        }

        // Deleting a contact cascades to its entries — the generic per-table CRUD
        // helpers have no FK awareness, so the cascade is done explicitly here.
        if (msg.type === 'ledger_contact_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.deleteItem(store.TABLES.LEDGER_CONTACTS, uid, msg.id)
          const entries = store.getList(store.TABLES.LEDGER_ENTRIES, uid)
          entries.filter(e => e.contactId === msg.id).forEach(e => store.deleteItem(store.TABLES.LEDGER_ENTRIES, uid, e.id))
          return
        }

        if (msg.type === 'ledger_entry_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const entry = { ...msg.entry }
          store.appendItem(store.TABLES.LEDGER_ENTRIES, uid, entry)
          return
        }

        if (msg.type === 'ledger_entry_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.updateItem(store.TABLES.LEDGER_ENTRIES, uid, msg.entry?.id, { ...msg.entry })
          return
        }

        if (msg.type === 'ledger_entry_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.deleteItem(store.TABLES.LEDGER_ENTRIES, uid, msg.id)
          return
        }

        // Milestone tracker — a goal with a target period, planned out as one or more
        // named tasks per day (e.g. "Complete Module 4", "Practice Quiz" on Day 8), each
        // independently checkable. Unlike Khatabook, this DOES broadcast to admins (parent
        // view mirrors AdminTransactionView.jsx), since the user explicitly wants a parent
        // to be able to see progress on things like a child's study goal.

        if (msg.type === 'milestone_data_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const milestones = store.getList(store.TABLES.MILESTONE_MILESTONES, uid)
          const goals = store.getList(store.TABLES.MILESTONE_GOALS, uid)
          const tasks = store.getList(store.TABLES.MILESTONE_TASKS, uid)
          send(ws, { type: 'milestone_data', userId: uid, milestones, goals, tasks })
          return
        }

        // Milestone = the top-level container shown in the reference app's "Milestones"
        // list (e.g. "Morning Routine Reset"); each Goal below belongs to exactly one
        // Milestone via goal.milestoneId. Deleting a milestone cascades to its goals and
        // (via the existing goal-delete cascade logic) their tasks, same pattern as
        // ledger_contact_delete / milestone_goal_delete above.
        if (msg.type === 'milestone_milestone_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const milestone = { ...msg.milestone }
          store.appendItem(store.TABLES.MILESTONE_MILESTONES, uid, milestone)
          broadcastToAdmins({ type: 'milestone_milestone_new', milestone, fromUserId: uid, fromUserName: meta.name })
          return
        }

        if (msg.type === 'milestone_milestone_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const milestone = store.updateItem(store.TABLES.MILESTONE_MILESTONES, uid, msg.milestone?.id, { ...msg.milestone })
          if (!milestone) return
          broadcastToAdmins({ type: 'milestone_milestone_updated', milestone, fromUserId: uid })
          return
        }

        if (msg.type === 'milestone_milestone_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.deleteItem(store.TABLES.MILESTONE_MILESTONES, uid, msg.id)
          const goals = store.getList(store.TABLES.MILESTONE_GOALS, uid)
          const tasks = store.getList(store.TABLES.MILESTONE_TASKS, uid)
          goals.filter(g => g.milestoneId === msg.id).forEach(g => {
            store.deleteItem(store.TABLES.MILESTONE_GOALS, uid, g.id)
            tasks.filter(t => t.goalId === g.id).forEach(t => store.deleteItem(store.TABLES.MILESTONE_TASKS, uid, t.id))
          })
          broadcastToAdmins({ type: 'milestone_milestone_deleted', id: msg.id, fromUserId: uid })
          return
        }

        if (msg.type === 'milestone_goal_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const goal = { ...msg.goal }
          store.appendItem(store.TABLES.MILESTONE_GOALS, uid, goal)
          broadcastToAdmins({ type: 'milestone_goal_new', goal, fromUserId: uid, fromUserName: meta.name })
          return
        }

        if (msg.type === 'milestone_goal_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const goal = store.updateItem(store.TABLES.MILESTONE_GOALS, uid, msg.goal?.id, { ...msg.goal })
          if (!goal) return
          broadcastToAdmins({ type: 'milestone_goal_updated', goal, fromUserId: uid })
          return
        }

        // Deleting a goal cascades to its tasks — the generic per-table CRUD helpers have
        // no FK awareness, so the cascade is done explicitly here (same pattern as
        // ledger_contact_delete above).
        if (msg.type === 'milestone_goal_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.deleteItem(store.TABLES.MILESTONE_GOALS, uid, msg.id)
          const tasks = store.getList(store.TABLES.MILESTONE_TASKS, uid)
          tasks.filter(t => t.goalId === msg.id).forEach(t => store.deleteItem(store.TABLES.MILESTONE_TASKS, uid, t.id))
          broadcastToAdmins({ type: 'milestone_goal_deleted', id: msg.id, fromUserId: uid })
          return
        }

        if (msg.type === 'milestone_task_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const task = { ...msg.task }
          store.appendItem(store.TABLES.MILESTONE_TASKS, uid, task)
          broadcastToAdmins({ type: 'milestone_task_new', task, fromUserId: uid })
          return
        }

        // Bulk insert — used when planning a goal's daily tasks upfront at creation (a
        // task template applied across every day of the period can mean dozens of rows
        // at once; sending them one message each would be needlessly chatty).
        if (msg.type === 'milestone_tasks_bulk_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const tasks = Array.isArray(msg.tasks) ? msg.tasks : []
          tasks.forEach(t => store.appendItem(store.TABLES.MILESTONE_TASKS, uid, t))
          broadcastToAdmins({ type: 'milestone_tasks_bulk_new', tasks, fromUserId: uid })
          return
        }

        if (msg.type === 'milestone_task_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const task = store.updateItem(store.TABLES.MILESTONE_TASKS, uid, msg.task?.id, { ...msg.task })
          if (!task) return
          broadcastToAdmins({ type: 'milestone_task_updated', task, fromUserId: uid })
          return
        }

        if (msg.type === 'milestone_task_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const deleted = store.deleteItem(store.TABLES.MILESTONE_TASKS, uid, msg.id)
          if (!deleted) return
          broadcastToAdmins({ type: 'milestone_task_deleted', id: msg.id, fromUserId: uid })
          return
        }

        // Health tracker — sickness episodes (symptoms/treatments/severity/dates), a
        // single flat table since symptoms and treatments are always edited together with
        // their parent episode, unlike Milestones' Goal/Task which need independent CRUD.
        // Broadcasts to admins, same reasoning as Milestones above — a parent explicitly
        // wants visibility into a child's health tracking.

        if (msg.type === 'health_data_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const episodes = store.getList(store.TABLES.HEALTH_EPISODES, uid)
          const reminders = store.getList(store.TABLES.HEALTH_REMINDERS, uid)
          send(ws, { type: 'health_data', userId: uid, episodes, reminders })
          return
        }

        if (msg.type === 'health_episode_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const episode = { ...msg.episode }
          store.appendItem(store.TABLES.HEALTH_EPISODES, uid, episode)
          broadcastToAdmins({ type: 'health_episode_new', episode, fromUserId: uid, fromUserName: meta.name })
          return
        }

        if (msg.type === 'health_episode_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const episode = store.updateItem(store.TABLES.HEALTH_EPISODES, uid, msg.episode?.id, { ...msg.episode })
          if (!episode) return
          broadcastToAdmins({ type: 'health_episode_updated', episode, fromUserId: uid })
          return
        }

        if (msg.type === 'health_episode_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const deleted = store.deleteItem(store.TABLES.HEALTH_EPISODES, uid, msg.id)
          if (!deleted) return
          broadcastToAdmins({ type: 'health_episode_deleted', id: msg.id, fromUserId: uid })
          return
        }

        // Health reminders — a one-time or recurring "due date" (medicine refill, follow-up
        // checkup) separate from episodes. Same broadcastToAdmins pattern as episodes above,
        // for consistency, even though the admin UI doesn't render this field yet.

        if (msg.type === 'health_reminder_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const reminder = { ...msg.reminder }
          store.appendItem(store.TABLES.HEALTH_REMINDERS, uid, reminder)
          broadcastToAdmins({ type: 'health_reminder_new', reminder, fromUserId: uid, fromUserName: meta.name })
          return
        }

        if (msg.type === 'health_reminder_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const reminder = store.updateItem(store.TABLES.HEALTH_REMINDERS, uid, msg.reminder?.id, { ...msg.reminder })
          if (!reminder) return
          broadcastToAdmins({ type: 'health_reminder_updated', reminder, fromUserId: uid })
          return
        }

        if (msg.type === 'health_reminder_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const deleted = store.deleteItem(store.TABLES.HEALTH_REMINDERS, uid, msg.id)
          if (!deleted) return
          broadcastToAdmins({ type: 'health_reminder_deleted', id: msg.id, fromUserId: uid })
          return
        }

        // Journal — a private daily mood/notes check-in (mood, energy, sleep, tags, free
        // text), one row per day-ish entry. Self-service only, same reasoning as Khatabook
        // above (no broadcastToAdmins call anywhere in this block) — never surfaced to a
        // parent's admin view.

        if (msg.type === 'journal_data_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const entries = store.getList(store.TABLES.JOURNAL_ENTRIES, uid)
          send(ws, { type: 'journal_data', userId: uid, entries })
          return
        }

        if (msg.type === 'journal_entry_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const entry = { ...msg.entry }
          store.appendItem(store.TABLES.JOURNAL_ENTRIES, uid, entry)
          return
        }

        if (msg.type === 'journal_entry_update') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.updateItem(store.TABLES.JOURNAL_ENTRIES, uid, msg.entry?.id, { ...msg.entry })
          return
        }

        if (msg.type === 'journal_entry_delete') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.deleteItem(store.TABLES.JOURNAL_ENTRIES, uid, msg.id)
          return
        }

        // Namaz (prayer) tracker + Qada (missed-prayer) tracking — private, self-only, same
        // reasoning as Khatabook/Journal above (never surfaced to a parent's admin view).
        // namaz_days holds one row per calendar day (id = "YYYY-MM-DD"); namaz_qada holds a
        // single fixed row (id = 'totals') with the per-prayer owed/completed counters.
        // Both mutators are upserts since the client sends the one changed day/qada object
        // without knowing whether a row for that id already exists server-side.

        if (msg.type === 'namaz_data_get') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const days = store.getList(store.TABLES.NAMAZ_DAYS, uid)
          const qadaRows = store.getList(store.TABLES.NAMAZ_QADA, uid)
          send(ws, { type: 'namaz_data', days, qada: qadaRows[0] || null })
          return
        }

        if (msg.type === 'namaz_day_set') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const day = { ...msg.day }
          const updated = store.updateItem(store.TABLES.NAMAZ_DAYS, uid, day.id, day)
          if (!updated) store.appendItem(store.TABLES.NAMAZ_DAYS, uid, day)
          return
        }

        if (msg.type === 'namaz_qada_set') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const qada = { ...msg.qada }
          const updated = store.updateItem(store.TABLES.NAMAZ_QADA, uid, qada.id, qada)
          if (!updated) store.appendItem(store.TABLES.NAMAZ_QADA, uid, qada)
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

        // Call log entry captured by the native ContentObserver — store + broadcast to admins.
        if (msg.type === 'call_log_add') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          const entry = { ...msg.entry, userId: uid, userName: meta.name }
          store.appendItem(store.TABLES.CALL_LOGS, uid, entry)
          broadcastToAdmins({ type: 'call_log_new', entry, fromUserId: uid, fromUserName: meta.name })
          return
        }

        // FCM push token, registered by the native app right after auth_ok (or queued and
        // flushed there if it wasn't connected yet — see KeepAliveService.java). This same
        // row doubles as the durable "known family members" roster for the admin's
        // "Wake up" action (device_list_get below) — it's the only place a family member's
        // identity persists independent of whether they're currently connected.
        if (msg.type === 'register_fcm_token') {
          const uid = meta.isBg ? meta.primaryId : meta.userId
          store.upsertDeviceToken(uid, msg.token, meta.name)
          broadcastToAdmins({ type: 'device_list', devices: buildDeviceList() })
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
          // Persist as "last known" alongside the live forward below — KeepAliveService is
          // dormant by default now, so this may be the only location the admin ever sees for
          // long stretches, not just a snapshot on its way to someone watching right now.
          if (msg.type === 'location_update') {
            store.updateDeviceLocation(fromUserId, msg.lat, msg.lng, msg.accuracy)
          }
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
          const out = { type: 'dm', text: msg.text, from: meta.name, fromId: meta.userId, toId: msg.toId, ts: Date.now() }
          send(ws, { ...out, own: true })
          if (target) {
            send(target.ws, out)
          } else {
            // No-ops harmlessly if toId is an admin (admins never register a device
            // token — no native app), and pushes a real notification if it's a child.
            notifyDmOffline(msg.toId, meta.name, msg.text)
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
      if (primary) {
        delete primary.bgWs
        // Mirrors the check in the primary-closes branch below, the other direction: if
        // the foreground connection isn't live either, this bg close was the last thing
        // keeping this family member "online". Without this, a killed app (whose
        // foreground WebView connection already closed earlier, independently) never
        // clears — the stale entry just sits in `users` looking online forever once only
        // the background service's connection remained.
        if (!primary.ws || primary.ws.readyState !== WebSocket.OPEN) {
          users.delete(meta.primaryId)
          broadcastToAdmins({ type: 'user_left', userId: meta.primaryId })
          broadcastAll({ type: 'users_list', users: getUserList() })
        }
      }
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
