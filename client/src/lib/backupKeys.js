// ── Parent-side encryption keys for the child-device backup feature ────────────────
//
// Envelope/hybrid encryption, the same pattern TLS and PGP use: the parent generates
// one RSA-OAEP keypair. Its PUBLIC half is sent to the server so every child device
// can fetch and cache it; its PRIVATE half is generated and stored ONLY in this
// browser's own IndexedDB and is never transmitted anywhere. Each backup chunk gets a
// random one-off AES-256 key that actually encrypts the data; that random key is what
// gets wrapped (encrypted) with the RSA public key. So the server, the cloud bucket,
// and anyone intercepting network traffic only ever see ciphertext plus a wrapped key
// — only whoever holds the private key can unwrap it and decrypt.
//
// This means losing the private key makes every past backup permanently unreadable —
// there is no recovery path around that by design, the same tradeoff every proper
// end-to-end encryption scheme makes. exportRecoveryFile() exists specifically so the
// parent has one clear moment to save it somewhere safe.

const DB_NAME = 'meeee-backup-keys'
const DB_VERSION = 1
const STORE = 'keys'
const PRIVATE_KEY_ID = 'parent_private_key'

const RSA_PARAMS = {
  name: 'RSA-OAEP',
  modulusLength: 3072,
  publicExponent: new Uint8Array([1, 0, 1]),
  hash: 'SHA-256',
}

function openKeyDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function idbGet(key) {
  const db = await openKeyDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(key)
    req.onsuccess = () => resolve(req.result ?? null)
    req.onerror = () => reject(req.error)
  })
}

async function idbSet(key, value) {
  const db = await openKeyDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite')
    tx.objectStore(STORE).put(value, key)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

/** True once this browser has generated (or imported) the parent's private key. */
export async function hasBackupPrivateKey() {
  const jwk = await idbGet(PRIVATE_KEY_ID)
  return jwk != null
}

/**
 * One-time setup. Generates a fresh RSA-OAEP-3072 keypair, stores the private key
 * (as a JWK) in this browser's IndexedDB, and returns the public key as a JWK ready
 * to send to the server via the `set_parent_public_key` WS message.
 */
export async function generateBackupKeypair() {
  const keyPair = await crypto.subtle.generateKey(RSA_PARAMS, true, ['wrapKey', 'unwrapKey', 'encrypt', 'decrypt'])
  const [publicKeyJwk, privateKeyJwk] = await Promise.all([
    crypto.subtle.exportKey('jwk', keyPair.publicKey),
    crypto.subtle.exportKey('jwk', keyPair.privateKey),
  ])
  await idbSet(PRIVATE_KEY_ID, privateKeyJwk)
  return { publicKeyJwk }
}

/**
 * Returns the private-key JWK as a downloadable recovery file's contents. Callers own
 * the actual "save/download this file" UI — this only builds the payload. Throws if no
 * key has been generated yet (call generateBackupKeypair() first).
 */
export async function exportRecoveryFile() {
  const privateKeyJwk = await idbGet(PRIVATE_KEY_ID)
  if (!privateKeyJwk) throw new Error('No backup key has been generated on this device yet.')
  return JSON.stringify({ version: 1, kind: 'meeee-backup-recovery-key', privateKeyJwk }, null, 2)
}

/**
 * Restores a private key from a previously-exported recovery file's parsed JSON (e.g.
 * after a browser reset, or setting up a new "parent" device). Overwrites any key
 * already stored here.
 */
export async function importRecoveryFile(parsed) {
  if (!parsed || parsed.kind !== 'meeee-backup-recovery-key' || !parsed.privateKeyJwk) {
    throw new Error('This file is not a valid backup recovery key.')
  }
  await idbSet(PRIVATE_KEY_ID, parsed.privateKeyJwk)
}

async function loadPrivateKey() {
  const jwk = await idbGet(PRIVATE_KEY_ID)
  if (!jwk) throw new Error('No backup private key on this device — restore it from a recovery file first.')
  return crypto.subtle.importKey('jwk', jwk, RSA_PARAMS, false, ['unwrapKey', 'decrypt'])
}

/**
 * Unwraps a chunk's random AES-256-GCM data key (as produced by the Android
 * DeviceBackupWorker's RSA-OAEP wrap step) using the parent's stored private key.
 * `wrappedKeyBase64` is the base64-encoded RSA-OAEP ciphertext of the raw AES key.
 */
export async function unwrapChunkKey(wrappedKeyBase64) {
  const privateKey = await loadPrivateKey()
  const wrappedBytes = base64ToBytes(wrappedKeyBase64)
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, wrappedBytes)
  return crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt'])
}

/**
 * Decrypts one chunk's ciphertext bytes given its already-unwrapped AES key and IV
 * (base64). Returns the decrypted zip's bytes as an ArrayBuffer.
 */
export async function decryptChunk({ ciphertext, ivBase64, aesKey }) {
  const iv = base64ToBytes(ivBase64)
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)
}

function base64ToBytes(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}
