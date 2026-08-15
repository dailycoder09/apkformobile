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
const admin = require('firebase-admin')

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || ''

let app = null
if (PROJECT_ID) {
  try {
    app = admin.initializeApp({
      credential: admin.credential.applicationDefault(),
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
  const decoded = await admin.auth().verifyIdToken(idToken)
  if (!decoded.phone_number) throw new Error('Token has no verified phone number')
  return decoded.phone_number
}

module.exports = { isConfigured, verifyPhoneToken }
