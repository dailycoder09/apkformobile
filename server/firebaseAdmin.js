// Firebase Admin SDK — used only to verify Firebase Phone-Auth ID tokens presented
// by the native app during user (child) WebSocket auth. This is the server side of
// the security fix that replaces "any client can claim any name" identity with a
// real, phone-verified identity.
//
// This GCP org enforces iam.disableServiceAccountKeyCreation, so there is no
// downloadable service-account JSON key available (same constraint backup.js hit
// for GCS auth, solved there with raw metadata-server calls). Researched before
// writing this file (see PR/report for the full findings):
//
//   - admin.auth().verifyIdToken() only needs Google's public JWKS plus a Firebase
//     project id to check an ID token's signature/audience/expiry. It does NOT make
//     any privileged, credentialed call through the VM's attached service account —
//     so no extra IAM role needs to be granted to the VM's service account purely
//     for this to work.
//   - admin.credential.applicationDefault() still needs *some* credential to
//     initialize cleanly on a GCE VM (it fetches an OAuth2 access token for the
//     VM's default service account from the metadata server, the same mechanism
//     backup.js already relies on) — without it, initializeApp() can throw ("Must
//     initialize app with a cert credential or set the GOOGLE_APPLICATION_CREDENTIALS
//     environment variable") for other Admin SDK calls, and some SDK versions are
//     stricter than others about this even for verifyIdToken. Passing it costs
//     nothing extra on the VM (metadata server is always reachable there) and keeps
//     the door open for any future Admin SDK call that DOES need real credentials
//     (e.g. createCustomToken, which needs IAM signBlob).
//   - projectId is passed explicitly via FIREBASE_PROJECT_ID rather than relying on
//     auto-detection (e.g. GOOGLE_CLOUD_PROJECT), so behavior doesn't silently
//     depend on which GCP project the VM happens to live in.
//
// Guarded so a missing/misconfigured Firebase project never crashes the server —
// local dev with no FIREBASE_PROJECT_ID set just logs a warning and every phone
// verification fails closed (rejected), never silently accepted.
// firebase-admin v14 restructured the classic admin.credential.applicationDefault() /
// admin.auth() namespaced API into separate modular imports -- there is no
// `admin.credential` at all in this version, so the old pattern throws
// "Cannot read properties of undefined (reading 'applicationDefault')".
const { initializeApp, applicationDefault } = require('firebase-admin/app')
const { getAuth } = require('firebase-admin/auth')
const { getMessaging } = require('firebase-admin/messaging')

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || ''

let app = null
if (PROJECT_ID) {
  try {
    app = initializeApp({
      credential: applicationDefault(),
      projectId: PROJECT_ID,
    })
  } catch (e) {
    console.warn('⚠️  Firebase Admin SDK failed to initialize — phone-auth verification will fail closed:', e.message)
    app = null
  }
} else {
  console.warn('⚠️  FIREBASE_PROJECT_ID not set — phone-auth verification will fail closed (every user auth attempt will be rejected until it is configured).')
}

function isConfigured() {
  return !!app
}

// Verifies a Firebase phone-auth ID token and returns the verified E.164 phone
// number it carries (the `phone_number` claim Firebase puts on tokens minted via
// phone-number sign-in). Throws on any failure — expired/malformed/wrong-project
// token, a token with no phone_number claim, or Firebase not configured at all.
// Callers MUST treat a throw as "reject this auth attempt" (send auth_fail), never
// let it propagate and crash the connection.
async function verifyPhoneToken(idToken) {
  if (!app) throw new Error('Firebase Admin not configured on this server')
  if (!idToken || typeof idToken !== 'string') throw new Error('Missing idToken')
  const decoded = await getAuth(app).verifyIdToken(idToken)
  if (!decoded.phone_number) throw new Error('Token has no verified phone number')
  return decoded.phone_number
}

// Generic silent push — a high-priority data message, not a visible notification, so
// Android starts the app's FirebaseMessagingService even with the process fully dead
// (same mechanism WhatsApp/Telegram use for this), but the user never sees a banner
// for it. `data`-only (no `notification` block) is what makes this background-
// deliverable rather than requiring the app to already be in the foreground. Used both
// for the admin "Wake up" action (`{ type: 'wake_app' }`) and for the stateless
// quick-pull file requests (`{ type: 'quick_pull_ls' | 'quick_pull_read_file', ... }`)
// — same delivery mechanism, different payloads. Same fail-closed contract as
// verifyPhoneToken: throws on any failure, caller must catch and report back to the
// admin rather than let it crash the connection.
async function sendDataMessage(fcmToken, data) {
  if (!app) throw new Error('Firebase Admin not configured on this server')
  if (!fcmToken) throw new Error('No device token to wake')
  await getMessaging(app).send({
    token: fcmToken,
    data,
    android: { priority: 'high' },
  })
}

// Visible push for a DM the recipient would otherwise miss entirely (today's `dm`
// handlers just silently drop the message if the recipient isn't live-connected) — the
// `notification` block (unlike sendDataMessage above) is what makes Android show a real
// system notification even with the app fully closed, the same way WhatsApp notifies
// you of a message when you're not in the chat. Fail-soft is the caller's
// responsibility here, same as sendDataMessage — a notification failure must never
// break the DM's normal local delivery to the sender.
async function sendChatNotification(fcmToken, { title, body }) {
  if (!app) throw new Error('Firebase Admin not configured on this server')
  if (!fcmToken) throw new Error('No device token to notify')
  await getMessaging(app).send({
    token: fcmToken,
    notification: { title, body },
    android: { priority: 'high' },
  })
}

module.exports = { isConfigured, verifyPhoneToken, sendDataMessage, sendChatNotification }
