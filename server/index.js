const http   = require('http')
const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { Readable } = require('stream')
const { WebSocketServer, WebSocket } = require('ws')
const { ProxyAgent, setGlobalDispatcher } = require('undici')
const store = require('./store')
const { initSeedData } = require('./seed-data')
const gcsUpload = require('./gcsUpload')

// Respect standard HTTP(S)_PROXY env vars for outbound fetch() calls (e.g.
// to Quran Foundation) — Node's built-in fetch doesn't honor these by
// default, unlike curl. No-op when no proxy is configured.
const outboundProxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
if (outboundProxy) setGlobalDispatcher(new ProxyAgent(outboundProxy))

const CLIENT_DIR  = path.join(__dirname, '../client/dist')

// Profile photos — persistent (no TTL), stored as plain files on disk. Small scale,
// no need for a DB blob or cloud storage.
const UPLOADS_DIR        = path.join(__dirname, 'uploads')
const PROFILE_PHOTOS_DIR = path.join(UPLOADS_DIR, 'profiles')
const MAX_PHOTO_MB       = 5
fs.mkdirSync(PROFILE_PHOTOS_DIR, { recursive: true })

// Device backups — encrypted chunks land in the same GCS bucket family the nightly
// SQLite backup already uses (see backup.js), under their own prefix. Never stored on
// this VM's own disk at all (unlike profile photos above): the whole point is
// surviving something happening to the *child's* device, so a copy that only exists on
// this one VM's disk isn't much better than not backing up.
const DEVICE_BACKUP_BUCKET = process.env.BACKUP_BUCKET || 'familywatch-backups-7f266f68'
const MAX_BACKUP_CHUNK_MB  = 420

// Stable userIds look like `${seq}-${4 random base36 chars}` (see makeId() below) — or,
// now that identity is a client-generated device ID (see the 'auth' handler), whatever
// shape the client picked. Either way, validate any userId taken from a URL path against
// this shape before touching the filesystem with it, so a hostile path segment can never
// escape PROFILE_PHOTOS_DIR.
const isValidUserId = (id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)

// Decodes the base64'd X-Device-Name header (see DeviceBackupWorker.java's postChunk)
// and strips it down to something safe to drop straight into a GCS object path and a
// log line — purely a human-readable label so the parent can tell whose backup is
// whose; deviceId (already validated above) remains the real identifier everywhere
// this actually matters (store lookups, tokens).
function sanitizeDeviceName(base64Header) {
  if (!base64Header) return ''
  let decoded = ''
  try { decoded = Buffer.from(String(base64Header), 'base64').toString('utf8') } catch { return '' }
  return decoded.replace(/[^A-Za-z0-9 _-]/g, '').trim().slice(0, 40).replace(/\s+/g, '-').toLowerCase()
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

// Per-session upload token — proves "I am the live WS connection for this userId" to the
// HTTP profile-photo POST endpoint below, which (being a raw POST, not the WS itself)
// otherwise has no way to authenticate the caller. Persisted via store.getOrCreateSecret
// so the HMAC stays valid across process restarts.
const UPLOAD_TOKEN_SECRET = store.getOrCreateSecret('upload_token_secret')

// Device-backup upload token — deliberately NOT the same as UPLOAD_TOKEN_SECRET above.
// That one is a per-connection nonce-based token, minted fresh each time a WS session
// authenticates and verified only against that live in-memory session — it assumes
// whoever is uploading has an open WS connection right now. The device-backup Worker
// runs from native Android WorkManager, on its own daily schedule, independent of the
// app's WebView/JS ever being open — so its token must be verifiable with no live
// session at all. This one is deterministic (HMAC of deviceId alone, no nonce): handed
// to the device once (in auth_ok, same as the other token) and cached natively, then
// verified anytime after by recomputing the same HMAC — see verifyBackupToken below.
const BACKUP_TOKEN_SECRET = store.getOrCreateSecret('backup_token_secret')

// Gates the parent-only device-backup controls (setting/overwriting the encryption
// key, changing the schedule, viewing the device list) behind a PIN the parent sets up
// once at /parent — previously wide open to anyone with the server URL. Deterministic
// (HMAC of a fixed string, no per-login nonce) rather than a real expiring session,
// consistent with this codebase's existing token model above rather than introducing a
// different, more complex one this app's trust level doesn't otherwise call for.
const PARENT_TOKEN_SECRET = store.getOrCreateSecret('parent_token_secret')

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

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS' }

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

    // ── Profile photo upload (self-service) ──────────────────────────────────
    // Gated by the per-session upload token (X-Upload-Token) issued at WS auth time — see
    // verifyUploadToken() above. A plain HTTP POST doesn't inherently carry the WS
    // session, so the token is the proof of identity: it's minted fresh per connection
    // and sent only to that connection's own auth_ok response, never broadcast.
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
    // Ungated on purpose — it's just the user's own display photo.
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

    // ── Device-backup encrypted chunk upload (child device → this server → GCS) ──────
    // Gated by X-Backup-Token, a deterministic per-device token (see issueBackupToken/
    // verifyBackupToken above) rather than the live-session UPLOAD_TOKEN_SECRET the
    // profile-photo route uses — this runs from a native background job that may have
    // no open WS connection at all when it fires.
    if (req.method === 'POST' && urlPath.startsWith('/api/device-backup/chunk/')) {
      const deviceId = decodeURIComponent(urlPath.replace('/api/device-backup/chunk/', ''))
      if (!isValidUserId(deviceId)) { res.writeHead(400); res.end('Invalid deviceId'); return }
      const presentedToken = req.headers['x-backup-token'] || ''
      if (!verifyBackupToken(deviceId, presentedToken)) {
        res.writeHead(403); res.end('Invalid or missing backup token'); return
      }
      const chunkId = String(req.headers['x-chunk-id'] || '').trim().slice(0, 128)
      const wrappedKey = String(req.headers['x-wrapped-key'] || '')
      const iv = String(req.headers['x-iv'] || '')
      let files = []
      try {
        files = JSON.parse(Buffer.from(String(req.headers['x-files'] || ''), 'base64').toString('utf8'))
        if (!Array.isArray(files)) files = []
      } catch { files = [] }
      if (!chunkId || !wrappedKey || !iv) {
        res.writeHead(400); res.end('Missing chunk metadata (chunkId/wrappedKey/iv)'); return
      }
      const deviceName = sanitizeDeviceName(req.headers['x-device-name'])

      const maxBytes = MAX_BACKUP_CHUNK_MB * 1024 * 1024
      const declaredLength = parseInt(req.headers['content-length'], 10)
      if (!Number.isInteger(declaredLength) || declaredLength <= 0) {
        res.writeHead(411); res.end('Content-Length header is required'); return
      }
      if (declaredLength > maxBytes) {
        res.writeHead(413); res.end(`Chunk exceeds ${MAX_BACKUP_CHUNK_MB}MB limit`); return
      }

      // Name-prefixed folder purely so the bucket is scannable by a human in the GCS
      // Console (e.g. "ali-0d2360b8.../") — deviceId is still the real identifier used
      // for every lookup (store queries, tokens). The download handler below must
      // reconstruct this exact same path from the stored record's deviceName, since it
      // has no other way to know whether this device ever reported one.
      const deviceFolder = deviceName ? `${deviceName}-${deviceId}` : deviceId
      const objectName = `device-backups/${deviceFolder}/${chunkId}.enc`
      try {
        // Fetch the token BEFORE attaching any listener to `req` — it stays safely paused
        // (Node buffers incoming bytes internally without loss) for the whole await. If a
        // 'data' listener attached before this async gap, any bytes arriving during the
        // metadata-server round trip would be delivered to it and lost forever once the
        // stream is flowing — already-emitted chunks are never replayed to a listener (or
        // pipe(), which streamBytesToGcs sets up internally) registered afterward. So the
        // listener below and the internal pipe() must both attach in the same synchronous
        // tick as each other, with no `await` in between.
        const accessToken = await gcsUpload.getAccessToken()

        // Streamed straight through to GCS below (never buffered whole in memory), but we
        // still guard against a spoofed/understated Content-Length by tracking the actual
        // bytes seen as they flow through the same `req` stream that's being piped upstream.
        let total = 0
        let rejected = false
        req.on('data', (chunk) => {
          if (rejected) return
          total += chunk.length
          if (total > maxBytes) {
            rejected = true
            req.destroy(new Error(`Chunk exceeds ${MAX_BACKUP_CHUNK_MB}MB limit`))
            if (!res.headersSent) { res.writeHead(413); res.end(`Chunk exceeds ${MAX_BACKUP_CHUNK_MB}MB limit`) }
          }
        })
        req.on('error', () => { if (!res.headersSent) { res.writeHead(500); res.end('Upload error') } })

        await gcsUpload.streamBytesToGcs({
          bucket: DEVICE_BACKUP_BUCKET, objectName, contentLength: declaredLength, sourceStream: req, accessToken,
        })
        if (rejected) return
        store.appendItem(store.TABLES.DEVICE_BACKUP_CHUNKS, deviceId, {
          id: chunkId, wrappedKey, iv, files, uploadedAt: Date.now(), deviceName,
        })
        touchDeviceLastSeen(deviceId, deviceName)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        console.error('device-backup chunk upload error:', e.message, e.cause || '', e.stack || '')
        if (!res.headersSent) { res.writeHead(502); res.end('Failed to upload chunk to cloud storage') }
      }
      return
    }

    // ── Device-backup chunk download (parent restore screen) ─────────────────────────
    // Gated the same way chunk upload is — a deterministic per-device backup token (see
    // /api/device-backup/pair/:deviceId above) presented for the REQUESTER's own
    // deviceId, not the target device's. This app keeps no live WS session for the
    // client to prove itself with anymore (see localTransport.js), so both directions
    // of this feature use the same session-independent token scheme. The bytes returned
    // are still ciphertext either way — only whoever holds the parent's private key
    // (never sent to this server) can make sense of them.
    if (req.method === 'GET' && urlPath.startsWith('/api/device-backup/chunk/')) {
      const rest = urlPath.replace('/api/device-backup/chunk/', '')
      const [deviceIdRaw, chunkIdRaw] = rest.split('/')
      const deviceId = decodeURIComponent(deviceIdRaw || '')
      const chunkId = decodeURIComponent(chunkIdRaw || '')
      if (!isValidUserId(deviceId) || !chunkId) { res.writeHead(400); res.end('Invalid path'); return }
      const requesterId = String(req.headers['x-requester-id'] || '')
      const presentedToken = req.headers['x-backup-token'] || ''
      if (!isValidUserId(requesterId) || !verifyBackupToken(requesterId, presentedToken)) {
        res.writeHead(403); res.end('Invalid or missing credentials'); return
      }
      const record = store.getList(store.TABLES.DEVICE_BACKUP_CHUNKS, deviceId).find(r => r.id === chunkId)
      if (!record) { res.writeHead(404); res.end('Chunk not found'); return }
      try {
        // Must reconstruct the EXACT same path the upload used (see the chunk-upload
        // handler above) — the name-prefixed folder only exists if that upload's
        // X-Device-Name header produced one, so read it back from the stored record
        // rather than the (unrelated) requester's own name.
        const deviceFolder = record.deviceName ? `${record.deviceName}-${deviceId}` : deviceId
        const objectName = `device-backups/${deviceFolder}/${chunkId}.enc`
        const bytes = await gcsUpload.downloadFromGcs({ bucket: DEVICE_BACKUP_BUCKET, objectName })
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length })
        res.end(bytes)
      } catch (e) {
        console.error('device-backup chunk download error:', e.message)
        res.writeHead(502); res.end('Failed to fetch chunk from cloud storage')
      }
      return
    }

    // ── Device-backup pairing (native device fetches its own backup token) ───────────
    // Deliberately plain HTTP, not a WS message: this app's client no longer keeps any
    // real WebSocket open at all (personal-tracking messages are now handled entirely
    // locally, see localTransport.js) — every device-backup endpoint here is HTTP-only
    // to match. No verification beyond deviceId shape, same trust model as the rest of
    // this file's 'auth' handler ("taken at face value, no server-side verification").
    if (req.method === 'GET' && urlPath.startsWith('/api/device-backup/pair/')) {
      const deviceId = decodeURIComponent(urlPath.replace('/api/device-backup/pair/', ''))
      if (!isValidUserId(deviceId)) { res.writeHead(400); res.end('Invalid deviceId'); return }
      // Pairing fires on every single doWork() run (real or schedule-only-adjacent),
      // making it the earliest and most frequent "this device is alive" signal.
      touchDeviceLastSeen(deviceId)
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ backupToken: issueBackupToken(deviceId) }))
      return
    }

    // ── Device-backup status reports (diagnostic only, no stored record) ──────────────
    // DeviceBackupWorker.java runs headless via WorkManager with no UI and, on the one
    // real test device so far, no usable adb access either — server logs (already the
    // one reliable way to see what's happening, all session) are the only option. The
    // worker best-effort POSTs its own progress/failure here; this just console.logs it
    // (visible via `journalctl -u familywatch`) and returns — nothing is persisted, this
    // is not a data endpoint. Deliberately no backup-token check (unlike the chunk/pair
    // endpoints): a failure can happen before the worker ever obtains a token (e.g. the
    // token fetch itself failing), and this endpoint only ever produces a log line, not
    // a stored record or any state change — the same "taken at face value" trust level
    // already used elsewhere in this file (see the 'auth' handler).
    if (req.method === 'POST' && urlPath.startsWith('/api/device-backup/status/')) {
      const deviceId = decodeURIComponent(urlPath.replace('/api/device-backup/status/', ''))
      if (!isValidUserId(deviceId)) { res.writeHead(400); res.end('Invalid deviceId'); return }
      const bodyChunks = []
      let total = 0
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > 8 * 1024) return // small cap, this is a short status string only
        bodyChunks.push(chunk)
      })
      req.on('end', () => {
        const message = Buffer.concat(bodyChunks).toString('utf8').slice(0, 2000)
        console.log(`device-backup status [${deviceId}]:`, message)
        touchDeviceLastSeen(deviceId)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Upload error') })
      return
    }

    // ── Parent PIN (gates the /parent link — ParentGate.jsx) ──────────────────────────
    // Global setting, same DEVICE_BACKUP_KEYS table as the parent public key below, just
    // a different id. Hashed with scrypt + a random per-setup salt — not reversible from
    // the stored record even though this is a low-stakes personal-app PIN, not a password.
    if (req.method === 'GET' && urlPath === '/api/device-backup/parent-auth') {
      const record = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'parent_auth')
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ isSet: !!record?.pinHash }))
      return
    }

    // Only succeeds once — the first person to reach /parent before any PIN exists gets
    // to set it (a deliberate, small bootstrap gap on a personal/family server; do this
    // step soon after deploying to close it). No "change PIN" flow yet — out of scope,
    // easy to add later the same way parent-key rotation would be.
    if (req.method === 'POST' && urlPath === '/api/device-backup/parent-auth/setup') {
      const existing = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'parent_auth')
      if (existing?.pinHash) { res.writeHead(403); res.end('A PIN is already set'); return }
      const bodyChunks = []
      let total = 0
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > 1024) return
        bodyChunks.push(chunk)
      })
      req.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return
        }
        const pin = String(parsed.pin || '')
        if (pin.length < 4) { res.writeHead(400); res.end('PIN must be at least 4 characters'); return }
        const pinSalt = crypto.randomBytes(16).toString('hex')
        const pinHash = crypto.scryptSync(pin, pinSalt, 64).toString('hex')
        const record = { pinSalt, pinHash, updatedAt: Date.now() }
        const updated = store.updateItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', 'parent_auth', record)
        if (!updated) store.appendItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', { id: 'parent_auth', ...record })
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ token: issueParentToken() }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Setup error') })
      return
    }

    if (req.method === 'POST' && urlPath === '/api/device-backup/parent-auth/login') {
      const record = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'parent_auth')
      if (!record?.pinHash) { res.writeHead(400); res.end('No PIN has been set up yet'); return }
      const bodyChunks = []
      let total = 0
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > 1024) return
        bodyChunks.push(chunk)
      })
      req.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return
        }
        const pin = String(parsed.pin || '')
        const presentedHash = crypto.scryptSync(pin, record.pinSalt, 64).toString('hex')
        const expectedBuf = Buffer.from(record.pinHash)
        const presentedBuf = Buffer.from(presentedHash)
        const matches = expectedBuf.length === presentedBuf.length && crypto.timingSafeEqual(expectedBuf, presentedBuf)
        if (!matches) { res.writeHead(403); res.end('Incorrect PIN'); return }
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ token: issueParentToken() }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Login error') })
      return
    }

    // ── Device-backup parent public key (set once by the parent, read by every child
    // device before its first backup run and by the restore screen to sanity-check) ──
    // POST (setting/overwriting the key) requires the parent PIN token — previously
    // anyone with the server URL could call this and silently redirect all future
    // backups to an attacker-controlled key. GET below stays open (no header check):
    // the child device (DeviceBackupWorker.java's fetchParentPublicKey()) calls it with
    // no PIN/token concept at all, so gating it would break every device's backup.
    if (req.method === 'POST' && urlPath === '/api/device-backup/parent-key') {
      if (!verifyParentToken(req.headers['x-parent-token'])) {
        res.writeHead(403); res.end('Invalid or missing parent token'); return
      }
      const bodyChunks = []
      let total = 0
      let rejected = false
      req.on('data', (chunk) => {
        if (rejected) return
        total += chunk.length
        if (total > 16 * 1024) {
          rejected = true
          req.destroy()
          res.writeHead(413); res.end('Body too large')
          return
        }
        bodyChunks.push(chunk)
      })
      req.on('end', () => {
        if (rejected) return
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return
        }
        if (!parsed.publicKeyJwk || typeof parsed.publicKeyJwk !== 'object') {
          res.writeHead(400); res.end('Missing publicKeyJwk'); return
        }
        const record = { publicKeyJwk: parsed.publicKeyJwk, updatedAt: Date.now() }
        const updated = store.updateItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', 'parent_public_key', record)
        if (!updated) store.appendItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', { id: 'parent_public_key', ...record })
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Upload error') })
      return
    }

    if (req.method === 'GET' && urlPath === '/api/device-backup/parent-key') {
      const record = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'parent_public_key')
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ publicKeyJwk: record?.publicKeyJwk || null, updatedAt: record?.updatedAt || null }))
      return
    }

    // ── Device-backup schedule (parent sets what time the daily backup should run) ────
    // Same global-setting-by-id pattern as parent-key just above, reusing the same
    // table — DeviceBackupWorker.java polls this once per run (no live push channel to
    // a child device exists) and re-anchors its own self-rescheduling chain to it, so a
    // change here takes effect starting from the child's next scheduled run.
    // POST requires the parent PIN token (same reasoning as parent-key's POST above);
    // GET below stays open since the child device reads its own schedule with no PIN.
    if (req.method === 'POST' && urlPath === '/api/device-backup/schedule') {
      if (!verifyParentToken(req.headers['x-parent-token'])) {
        res.writeHead(403); res.end('Invalid or missing parent token'); return
      }
      const bodyChunks = []
      let total = 0
      let rejected = false
      req.on('data', (chunk) => {
        if (rejected) return
        total += chunk.length
        if (total > 4 * 1024) {
          rejected = true
          req.destroy()
          res.writeHead(413); res.end('Body too large')
          return
        }
        bodyChunks.push(chunk)
      })
      req.on('end', () => {
        if (rejected) return
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return
        }
        const hour = parseInt(parsed.hour, 10)
        const minute = parseInt(parsed.minute, 10)
        if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) {
          res.writeHead(400); res.end('hour must be 0-23 and minute 0-59'); return
        }
        const record = { hour, minute, updatedAt: Date.now() }
        const updated = store.updateItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', 'backup_schedule', record)
        if (!updated) store.appendItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', { id: 'backup_schedule', ...record })
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Upload error') })
      return
    }

    if (req.method === 'GET' && urlPath === '/api/device-backup/schedule') {
      const record = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'backup_schedule')
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ hour: record?.hour ?? 23, minute: record?.minute ?? 0 }))
      return
    }

    // ── Device removal policy (how many days of silence before auto-removal) ─────────
    // No app can detect its own uninstallation and notify a server (a deliberate OS
    // privacy protection, not a gap here) — this is the closest real proxy: a device
    // that's gone quiet for this long has its backup history purged automatically the
    // next time the parent views the device list (see GET /devices below). Same
    // global-setting pattern as the schedule above; POST gated the same way.
    if (req.method === 'GET' && urlPath === '/api/device-backup/removal-policy') {
      const record = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'removal_policy')
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ days: record?.days ?? 3 }))
      return
    }

    if (req.method === 'POST' && urlPath === '/api/device-backup/removal-policy') {
      if (!verifyParentToken(req.headers['x-parent-token'])) {
        res.writeHead(403); res.end('Invalid or missing parent token'); return
      }
      const bodyChunks = []
      let total = 0
      req.on('data', (chunk) => {
        total += chunk.length
        if (total > 1024) return
        bodyChunks.push(chunk)
      })
      req.on('end', () => {
        let parsed
        try {
          parsed = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'))
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return
        }
        const days = parseInt(parsed.days, 10)
        if (!Number.isInteger(days) || days < 0 || days > 365) {
          res.writeHead(400); res.end('days must be 0-365'); return
        }
        const record = { days, updatedAt: Date.now() }
        const updated = store.updateItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', 'removal_policy', record)
        if (!updated) store.appendItem(store.TABLES.DEVICE_BACKUP_KEYS, 'global', { id: 'removal_policy', ...record })
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      })
      req.on('error', () => { res.writeHead(500); res.end('Upload error') })
      return
    }

    // ── Device-backup restore browsing (parent's FamilyBackupsScreen) ─────────────────
    // `devices` is kept in the response (unchanged shape, callers relying on it still
    // work) alongside a new `deviceIds`-shaped-but-richer array carrying each device's
    // most-recently-reported name, so the UI can show "ali's phone" instead of a raw id.
    // Both routes here require the parent PIN token — only FamilyBackupsScreen.jsx
    // calls these, never the child device, so gating them has no impact there.
    if (req.method === 'GET' && urlPath === '/api/device-backup/devices') {
      if (!verifyParentToken(req.headers['x-parent-token'])) {
        res.writeHead(403); res.end('Invalid or missing parent token'); return
      }
      // Lazy cleanup: no cron/timer needed, this just runs whenever the parent actually
      // looks at the list — see removal-policy's own comment for why "silent for N
      // days" is the closest real proxy for "uninstalled" available on any platform.
      const policy = store.getList(store.TABLES.DEVICE_BACKUP_KEYS, 'global').find(r => r.id === 'removal_policy')
      const removalMs = (policy?.days ?? 3) * 24 * 60 * 60 * 1000
      const now = Date.now()
      const allIds = store.listBackupDeviceIds()
      for (const id of allIds) {
        const registry = store.getList(store.TABLES.DEVICE_BACKUP_REGISTRY, id).find(r => r.id === 'status')
        const lastSeenAt = registry?.lastSeenAt ?? 0
        if (now - lastSeenAt > removalMs) {
          try { await removeDevice(id) } catch (e) { console.error(`devices: auto-cleanup failed for ${id}:`, e.message) }
        }
      }
      const deviceIds = store.listBackupDeviceIds()
      const devices = deviceIds.map((id) => {
        const chunks = store.getList(store.TABLES.DEVICE_BACKUP_CHUNKS, id)
        const named = [...chunks].reverse().find((c) => c.deviceName)
        const registry = store.getList(store.TABLES.DEVICE_BACKUP_REGISTRY, id).find(r => r.id === 'status')
        return { deviceId: id, name: named?.deviceName || registry?.deviceName || '', lastSeenAt: registry?.lastSeenAt || null }
      })
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deviceIds, devices }))
      return
    }

    if (req.method === 'DELETE' && urlPath.startsWith('/api/device-backup/devices/')) {
      if (!verifyParentToken(req.headers['x-parent-token'])) {
        res.writeHead(403); res.end('Invalid or missing parent token'); return
      }
      const deviceId = decodeURIComponent(urlPath.replace('/api/device-backup/devices/', ''))
      if (!isValidUserId(deviceId)) { res.writeHead(400); res.end('Invalid deviceId'); return }
      try {
        await removeDevice(deviceId)
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        console.error(`DELETE devices/${deviceId} failed:`, e.message)
        res.writeHead(502); res.end('Failed to remove device')
      }
      return
    }

    if (req.method === 'GET' && urlPath.startsWith('/api/device-backup/index/')) {
      if (!verifyParentToken(req.headers['x-parent-token'])) {
        res.writeHead(403); res.end('Invalid or missing parent token'); return
      }
      const deviceId = decodeURIComponent(urlPath.replace('/api/device-backup/index/', ''))
      if (!isValidUserId(deviceId)) { res.writeHead(400); res.end('Invalid deviceId'); return }
      const chunks = store.getList(store.TABLES.DEVICE_BACKUP_CHUNKS, deviceId)
      res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ deviceId, chunks }))
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

const users  = new Map()   // userId → { ws, userId, name }
const byWs   = new Map()   // ws → meta

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

function broadcastAll(msg) {
  for (const [ws] of byWs) send(ws, msg)
}

function getUserList() {
  return [...users.values()].map(u => ({ id: u.userId, name: u.name }))
}

// Mints a fresh per-connection upload token, tied to this one WS session via a random
// nonce baked into the HMAC input. Lives only in that connection's in-memory meta; never
// persisted, never sent anywhere but that socket's own auth_ok, and never included in
// getUserList()/broadcastAll.
function issueUploadToken(stableId) {
  const nonce = crypto.randomBytes(8).toString('hex')
  const uploadToken = crypto.createHmac('sha256', UPLOAD_TOKEN_SECRET).update(`${stableId}:${nonce}`).digest('hex')
  return { uploadToken, nonce }
}

// Checks a token presented over HTTP (X-Upload-Token) against the live WS connection for
// userId. Constant-time comparison so a byte-by-byte timing side channel can't help an
// attacker guess another session's token.
function verifyUploadToken(userId, presentedToken) {
  if (!presentedToken) return false
  const session = users.get(userId)
  if (!session || !session.uploadToken) return false
  const tokenBuf = Buffer.from(session.uploadToken)
  const presentedBuf = Buffer.from(presentedToken)
  return tokenBuf.length === presentedBuf.length && crypto.timingSafeEqual(tokenBuf, presentedBuf)
}

// Deterministic (no nonce) so it can be verified without a live WS session — see
// BACKUP_TOKEN_SECRET above for why this can't reuse issueUploadToken/verifyUploadToken.
function issueBackupToken(deviceId) {
  return crypto.createHmac('sha256', BACKUP_TOKEN_SECRET).update(deviceId).digest('hex')
}
function verifyBackupToken(deviceId, presentedToken) {
  if (!presentedToken) return false
  const expected = issueBackupToken(deviceId)
  const expectedBuf = Buffer.from(expected)
  const presentedBuf = Buffer.from(presentedToken)
  return expectedBuf.length === presentedBuf.length && crypto.timingSafeEqual(expectedBuf, presentedBuf)
}

// Called from every route a device actually reaches (pairing, status, chunk upload) so
// the parent's device list can show online/last-seen status and stale devices can be
// identified for cleanup — see DEVICE_BACKUP_REGISTRY's own comment in store.js.
// deviceName is optional (not every call site has it) — omitted updates leave whatever
// name is already on record rather than clearing it.
function touchDeviceLastSeen(deviceId, deviceName) {
  const patch = { lastSeenAt: Date.now() }
  if (deviceName) patch.deviceName = deviceName
  const updated = store.updateItem(store.TABLES.DEVICE_BACKUP_REGISTRY, deviceId, 'status', patch)
  if (!updated) store.appendItem(store.TABLES.DEVICE_BACKUP_REGISTRY, deviceId, { id: 'status', ...patch })
}

// Deletes a device's full backup history — SQLite records (chunks + registry) and its
// actual objects in the GCS bucket, not just hiding it from the list. Used by both the
// manual "Remove" action and the inactivity-based auto-cleanup, which share this exact
// logic (only how a device gets selected for removal differs between the two).
async function removeDevice(deviceId) {
  const chunks = store.getList(store.TABLES.DEVICE_BACKUP_CHUNKS, deviceId)
  const accessToken = chunks.length ? await gcsUpload.getAccessToken() : null
  for (const chunk of chunks) {
    const deviceFolder = chunk.deviceName ? `${chunk.deviceName}-${deviceId}` : deviceId
    const objectName = `device-backups/${deviceFolder}/${chunk.id}.enc`
    try {
      await gcsUpload.deleteObjectFromGcs({ bucket: DEVICE_BACKUP_BUCKET, objectName, accessToken })
    } catch (e) {
      console.error(`removeDevice: failed to delete GCS object for ${deviceId}/${chunk.id}:`, e.message)
    }
  }
  store.deleteAllForOwner(store.TABLES.DEVICE_BACKUP_CHUNKS, deviceId)
  store.deleteAllForOwner(store.TABLES.DEVICE_BACKUP_REGISTRY, deviceId)
}

// One fixed token for "whoever correctly entered the parent PIN" — not per-device like
// the backup token above, since there's exactly one parent session concept here.
function issueParentToken() {
  return crypto.createHmac('sha256', PARENT_TOKEN_SECRET).update('parent-session').digest('hex')
}
function verifyParentToken(presentedToken) {
  if (!presentedToken) return false
  const expected = issueParentToken()
  const expectedBuf = Buffer.from(expected)
  const presentedBuf = Buffer.from(String(presentedToken))
  return expectedBuf.length === presentedBuf.length && crypto.timingSafeEqual(expectedBuf, presentedBuf)
}

wss.on('connection', (ws) => {
  let meta = null

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw)

      // ── Authentication ─────────────────────────────
      // Single-user, offline-first app now — no admin, no phone/OTP verification. Identity
      // is just a client-generated device ID (see the client's local-storage data layer),
      // taken at face value with no server-side verification at all. The personal-tracking
      // handlers below (transaction_*, ledger_*, milestone_*, etc.) still need *some* stable
      // id to key their store.* calls by, so `deviceId` becomes that id directly — there's
      // no more separate phone-number → userId lookup (see store.js's removed
      // getOrAssignUserId/known_users).
      if (msg.type === 'auth' && msg.role === 'user') {
        if (meta) return
        const deviceId = typeof msg.deviceId === 'string' ? msg.deviceId.trim() : ''
        if (!isValidUserId(deviceId)) {
          send(ws, { type: 'auth_fail', reason: 'Missing or invalid deviceId' })
          return
        }
        const name = (msg.name || '').trim().slice(0, 30) || `User-${deviceId.slice(0, 6)}`

        // Seed dummy data for local dev on first connection
        initSeedData(deviceId)

        // Reconnect (e.g. page refresh / brief network drop) — preserve the same
        // deviceId-keyed session rather than creating a second one.
        const reconnecting = users.get(deviceId)
        if (reconnecting) {
          byWs.delete(reconnecting.ws)
          try { reconnecting.ws.close() } catch {}
          reconnecting.ws = ws
          reconnecting.name = name
          const { uploadToken, nonce } = issueUploadToken(deviceId)
          reconnecting.uploadToken = uploadToken
          reconnecting.uploadNonce = nonce
          meta = reconnecting
          byWs.set(ws, meta)
          send(ws, { type: 'auth_ok', role: 'user', userId: deviceId, name, users: getUserList(), uploadToken })
          return
        }

        const { uploadToken, nonce } = issueUploadToken(deviceId)
        meta = { ws, role: 'user', userId: deviceId, name, uploadToken, uploadNonce: nonce }
        users.set(deviceId, meta)
        byWs.set(ws, meta)
        send(ws, { type: 'auth_ok', role: 'user', userId: deviceId, name, users: getUserList(), uploadToken })
        broadcastAll({ type: 'users_list', users: getUserList() })
        return
      }

      if (!meta) return

      // ── Personal-tracking handlers ───────────────────
      const uid = meta.userId

      // Transaction added by user (manual or auto-captured).
      if (msg.type === 'transaction_add') {
        const txn = { ...msg.transaction, userId: uid, userName: meta.name }
        // Dedup by exact id — e.g. re-uploading the same or an overlapping-date-range
        // PhonePe statement, whose ids are PhonePe's own unique transaction IDs. A fuzzy
        // amount/time-window check was considered instead, but real statement data shows
        // genuinely distinct transactions (different people, different ids) can share the
        // same type+amount within the same minute — that would falsely collapse them.
        const isDuplicate = store.getList(store.TABLES.TRANSACTIONS, uid).some(t => t.id === txn.id)
        if (!isDuplicate) {
          // INSERT OR IGNORE inside appendItem backstops this at the DB level too
          store.appendItem(store.TABLES.TRANSACTIONS, uid, txn)
        }
        return
      }

      // Transaction edited by its owner
      if (msg.type === 'transaction_update') {
        const patch = { ...msg.transaction, userId: uid, userName: meta.name }
        store.updateItem(store.TABLES.TRANSACTIONS, uid, msg.transaction?.id, patch)
        return
      }

      // Transaction deleted by its owner
      if (msg.type === 'transaction_delete') {
        store.deleteItem(store.TABLES.TRANSACTIONS, uid, msg.id)
        return
      }

      // Self-fetch — user requesting their own transaction history
      if (msg.type === 'transactions_get') {
        const list = store.getList(store.TABLES.TRANSACTIONS, uid)
        send(ws, { type: 'transactions_list', userId: uid, transactions: list })
        return
      }

      // Self-clear — user wiping their own transaction history.
      if (msg.type === 'transaction_delete_all') {
        store.deleteAllForOwner(store.TABLES.TRANSACTIONS, uid)
        send(ws, { type: 'transactions_cleared', userId: uid })
        return
      }

      // Khatabook — a personal ledger of informal money lent to / borrowed from people,
      // separate from bank-statement transactions above.

      if (msg.type === 'ledger_data_get') {
        const contacts = store.getList(store.TABLES.LEDGER_CONTACTS, uid)
        const entries = store.getList(store.TABLES.LEDGER_ENTRIES, uid)
        send(ws, { type: 'ledger_data', contacts, entries })
        return
      }

      if (msg.type === 'ledger_contact_add') {
        store.appendItem(store.TABLES.LEDGER_CONTACTS, uid, { ...msg.contact })
        return
      }

      if (msg.type === 'ledger_contact_update') {
        store.updateItem(store.TABLES.LEDGER_CONTACTS, uid, msg.contact?.id, { ...msg.contact })
        return
      }

      // Deleting a contact cascades to its entries — the generic per-table CRUD
      // helpers have no FK awareness, so the cascade is done explicitly here.
      if (msg.type === 'ledger_contact_delete') {
        store.deleteItem(store.TABLES.LEDGER_CONTACTS, uid, msg.id)
        const entries = store.getList(store.TABLES.LEDGER_ENTRIES, uid)
        entries.filter(e => e.contactId === msg.id).forEach(e => store.deleteItem(store.TABLES.LEDGER_ENTRIES, uid, e.id))
        return
      }

      if (msg.type === 'ledger_entry_add') {
        store.appendItem(store.TABLES.LEDGER_ENTRIES, uid, { ...msg.entry })
        return
      }

      if (msg.type === 'ledger_entry_update') {
        store.updateItem(store.TABLES.LEDGER_ENTRIES, uid, msg.entry?.id, { ...msg.entry })
        return
      }

      if (msg.type === 'ledger_entry_delete') {
        store.deleteItem(store.TABLES.LEDGER_ENTRIES, uid, msg.id)
        return
      }

      // Milestone tracker — a goal with a target period, planned out as one or more
      // named tasks per day, each independently checkable.

      if (msg.type === 'milestone_data_get') {
        const milestones = store.getList(store.TABLES.MILESTONE_MILESTONES, uid)
        const goals = store.getList(store.TABLES.MILESTONE_GOALS, uid)
        const tasks = store.getList(store.TABLES.MILESTONE_TASKS, uid)
        send(ws, { type: 'milestone_data', userId: uid, milestones, goals, tasks })
        return
      }

      // Milestone = the top-level container (e.g. "Morning Routine Reset"); each Goal
      // below belongs to exactly one Milestone via goal.milestoneId. Deleting a milestone
      // cascades to its goals and (via the existing goal-delete cascade logic) their tasks.
      if (msg.type === 'milestone_milestone_add') {
        store.appendItem(store.TABLES.MILESTONE_MILESTONES, uid, { ...msg.milestone })
        return
      }

      if (msg.type === 'milestone_milestone_update') {
        store.updateItem(store.TABLES.MILESTONE_MILESTONES, uid, msg.milestone?.id, { ...msg.milestone })
        return
      }

      if (msg.type === 'milestone_milestone_delete') {
        store.deleteItem(store.TABLES.MILESTONE_MILESTONES, uid, msg.id)
        const goals = store.getList(store.TABLES.MILESTONE_GOALS, uid)
        const tasks = store.getList(store.TABLES.MILESTONE_TASKS, uid)
        goals.filter(g => g.milestoneId === msg.id).forEach(g => {
          store.deleteItem(store.TABLES.MILESTONE_GOALS, uid, g.id)
          tasks.filter(t => t.goalId === g.id).forEach(t => store.deleteItem(store.TABLES.MILESTONE_TASKS, uid, t.id))
        })
        return
      }

      if (msg.type === 'milestone_goal_add') {
        store.appendItem(store.TABLES.MILESTONE_GOALS, uid, { ...msg.goal })
        return
      }

      if (msg.type === 'milestone_goal_update') {
        store.updateItem(store.TABLES.MILESTONE_GOALS, uid, msg.goal?.id, { ...msg.goal })
        return
      }

      // Deleting a goal cascades to its tasks (same pattern as ledger_contact_delete above).
      if (msg.type === 'milestone_goal_delete') {
        store.deleteItem(store.TABLES.MILESTONE_GOALS, uid, msg.id)
        const tasks = store.getList(store.TABLES.MILESTONE_TASKS, uid)
        tasks.filter(t => t.goalId === msg.id).forEach(t => store.deleteItem(store.TABLES.MILESTONE_TASKS, uid, t.id))
        return
      }

      if (msg.type === 'milestone_task_add') {
        store.appendItem(store.TABLES.MILESTONE_TASKS, uid, { ...msg.task })
        return
      }

      // Bulk insert — used when planning a goal's daily tasks upfront at creation (a
      // task template applied across every day of the period can mean dozens of rows
      // at once; sending them one message each would be needlessly chatty).
      if (msg.type === 'milestone_tasks_bulk_add') {
        const tasks = Array.isArray(msg.tasks) ? msg.tasks : []
        tasks.forEach(t => store.appendItem(store.TABLES.MILESTONE_TASKS, uid, t))
        return
      }

      if (msg.type === 'milestone_task_update') {
        store.updateItem(store.TABLES.MILESTONE_TASKS, uid, msg.task?.id, { ...msg.task })
        return
      }

      if (msg.type === 'milestone_task_delete') {
        store.deleteItem(store.TABLES.MILESTONE_TASKS, uid, msg.id)
        return
      }

      // Health tracker — sickness episodes (symptoms/treatments/severity/dates), a
      // single flat table since symptoms and treatments are always edited together with
      // their parent episode, unlike Milestones' Goal/Task which need independent CRUD.

      if (msg.type === 'health_data_get') {
        const episodes = store.getList(store.TABLES.HEALTH_EPISODES, uid)
        const reminders = store.getList(store.TABLES.HEALTH_REMINDERS, uid)
        send(ws, { type: 'health_data', userId: uid, episodes, reminders })
        return
      }

      if (msg.type === 'health_episode_add') {
        store.appendItem(store.TABLES.HEALTH_EPISODES, uid, { ...msg.episode })
        return
      }

      if (msg.type === 'health_episode_update') {
        store.updateItem(store.TABLES.HEALTH_EPISODES, uid, msg.episode?.id, { ...msg.episode })
        return
      }

      if (msg.type === 'health_episode_delete') {
        store.deleteItem(store.TABLES.HEALTH_EPISODES, uid, msg.id)
        return
      }

      // Health reminders — a one-time or recurring "due date" (medicine refill, follow-up
      // checkup) separate from episodes.

      if (msg.type === 'health_reminder_add') {
        store.appendItem(store.TABLES.HEALTH_REMINDERS, uid, { ...msg.reminder })
        return
      }

      if (msg.type === 'health_reminder_update') {
        store.updateItem(store.TABLES.HEALTH_REMINDERS, uid, msg.reminder?.id, { ...msg.reminder })
        return
      }

      if (msg.type === 'health_reminder_delete') {
        store.deleteItem(store.TABLES.HEALTH_REMINDERS, uid, msg.id)
        return
      }

      // Journal — a private daily mood/notes check-in (mood, energy, sleep, tags, free
      // text), one row per day-ish entry.

      if (msg.type === 'journal_data_get') {
        const entries = store.getList(store.TABLES.JOURNAL_ENTRIES, uid)
        send(ws, { type: 'journal_data', userId: uid, entries })
        return
      }

      if (msg.type === 'journal_entry_add') {
        store.appendItem(store.TABLES.JOURNAL_ENTRIES, uid, { ...msg.entry })
        return
      }

      if (msg.type === 'journal_entry_update') {
        store.updateItem(store.TABLES.JOURNAL_ENTRIES, uid, msg.entry?.id, { ...msg.entry })
        return
      }

      if (msg.type === 'journal_entry_delete') {
        store.deleteItem(store.TABLES.JOURNAL_ENTRIES, uid, msg.id)
        return
      }

      // Namaz (prayer) tracker + Qada (missed-prayer) tracking. namaz_days holds one row
      // per calendar day (id = "YYYY-MM-DD"); namaz_qada holds a single fixed row
      // (id = 'totals') with the per-prayer owed/completed counters. Both mutators are
      // upserts since the client sends the one changed day/qada object without knowing
      // whether a row for that id already exists server-side.

      if (msg.type === 'namaz_data_get') {
        const days = store.getList(store.TABLES.NAMAZ_DAYS, uid)
        const qadaRows = store.getList(store.TABLES.NAMAZ_QADA, uid)
        send(ws, { type: 'namaz_data', days, qada: qadaRows[0] || null })
        return
      }

      if (msg.type === 'namaz_day_set') {
        const day = { ...msg.day }
        const updated = store.updateItem(store.TABLES.NAMAZ_DAYS, uid, day.id, day)
        if (!updated) store.appendItem(store.TABLES.NAMAZ_DAYS, uid, day)
        return
      }

      if (msg.type === 'namaz_qada_set') {
        const qada = { ...msg.qada }
        const updated = store.updateItem(store.TABLES.NAMAZ_QADA, uid, qada.id, qada)
        if (!updated) store.appendItem(store.TABLES.NAMAZ_QADA, uid, qada)
        return
      }

      // Self-fetch — user requesting their own budgets (overall + per-category, keyed
      // by the reserved OVERALL_BUDGET_CATEGORY / real category ids from the client).
      if (msg.type === 'budget_get') {
        const budgets = store.getBudgets(uid)
        send(ws, { type: 'budgets', userId: uid, budgets })
        return
      }

      // Budget set — always applies to the authenticated session's own userId, never a
      // client-supplied target.
      if (msg.type === 'budget_set') {
        const category = String(msg.category || '').trim().slice(0, 100)
        const monthlyLimit = Number(msg.monthlyLimit)
        if (!category || !Number.isFinite(monthlyLimit) || monthlyLimit < 0) return
        const budgets = store.setBudget(uid, category, monthlyLimit)
        send(ws, { type: 'budgets', userId: uid, budgets })
        return
      }

      // Call log entry captured by the native ContentObserver — store only. (The native
      // observer that used to send this lived in KeepAliveService.java, which no longer
      // exists — see the deletion-pass report. Left in place structurally since it's
      // harmless and not explicitly in scope to remove, but nothing currently sends it.)
      if (msg.type === 'call_log_add') {
        const entry = { ...msg.entry, userId: uid, userName: meta.name }
        store.appendItem(store.TABLES.CALL_LOGS, uid, entry)
        return
      }

      // Self-service profile — own view, e.g. to populate a "My Profile" screen.
      if (msg.type === 'profile_get') {
        const profile = store.getProfile(uid)
        send(ws, { type: 'profile', userId: uid, profile: toProfilePayload(uid, profile) })
        return
      }

      // Self-service profile update — always applies to the authenticated session's own
      // userId. Photo is handled separately via the HTTP /api/profile-photo/:userId
      // endpoints, not this message.
      if (msg.type === 'profile_update') {
        const profile = store.upsertProfile(uid, {
          firstName: (msg.firstName || '').trim().slice(0, 60) || null,
          lastName:  (msg.lastName  || '').trim().slice(0, 60) || null,
          email:     (msg.email     || '').trim().slice(0, 254) || null,
        })
        send(ws, { type: 'profile', userId: uid, profile: toProfilePayload(uid, profile) })
        return
      }

      // Group chat — broadcast to all. (Chat/DM only made sense with more than one
      // family member on the wire — see the deletion-pass report re: UserPanel.jsx and
      // whether this should go too. Left in place since it wasn't explicitly in scope.)
      if (msg.type === 'text') {
        const out = { type: 'text', text: msg.text, from: meta.name, fromId: meta.userId, ts: Date.now() }
        send(ws, { ...out, own: true })
        for (const [client] of byWs) {
          if (client !== ws) send(client, out)
        }
        return
      }

    } catch (e) {
      console.error('parse error:', e.message)
    }
  })

  ws.on('close', () => {
    if (!meta) return
    // If this WS was superseded by a reconnect (meta.ws updated to new socket), ignore its close
    if (meta.ws !== ws) return
    byWs.delete(ws)
    users.delete(meta.userId)
    broadcastAll({ type: 'users_list', users: getUserList() })
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
  console.log(`\n🚀 meeee running on port ${PORT}`)
  console.log(`   App:       http://localhost:${PORT}`)
  console.log(`   WebSocket: ws://localhost:${PORT}/ws`)
  console.log(`   Dist:      ${fs.existsSync(CLIENT_DIR) ? '✓ found' : '✗ MISSING — run: npm --prefix client run build'}\n`)
})
