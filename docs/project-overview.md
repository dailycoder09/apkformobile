# FamilyWatch — Project Overview

Internal codename: `meeee`. A family-monitoring PWA + native Android wrapper: a
parent ("admin") can chat with, and monitor, a child's device — messages,
transactions, call log, browsing activity, screenshots, and live camera/mic/
location — from a browser or the same installed app.

This is a living reference doc: Section 1 describes the system as it stands
today, Section 2 is a dated log of what was built and why, Section 3 is
current status. It is not a tutorial — it assumes you lived through the work.

---

## 1. Architecture overview

### Client — `client/` (Vite + React PWA)

Single-page app (`client/src/App.jsx`) that authenticates over a WebSocket
(admin via PIN, child via name) and then routes between modules by a simple
`module` state — there's no router. Bottom nav (`BottomNav.jsx`) exposes
Home / Namaz / Workout / Chat / Finance; admin gets extra tiles on
`HomeScreen.jsx` (Messages, Transactions, Browsing Activity, Call Log).

Top-level components in `client/src/components/`:

| Component | Purpose |
|---|---|
| `Login.jsx` | Role selection + PIN/name entry, drives the WS auth handshake |
| `Dashboard.jsx` / `HomeScreen.jsx` | Landing screens (child vs. admin) that select a module |
| `AdminPanel.jsx` / `UserPanel.jsx` | Chat UI, role-specific (admin sees all users + DM, child sees single thread) |
| `ChatWindow.jsx`, `MessageList.jsx`, `MessageInput.jsx` | Chat rendering/composition, shared by admin and user panels |
| `TransactionPanel.jsx` | Child-side: manual transaction entry + PhonePe statement upload |
| `AdminTransactionView.jsx` | Admin-side: per-user transaction list/dashboard |
| `AdminBrowsingView.jsx` | Admin-side: per-user browsing history (domains visited) |
| `AdminCallLogView.jsx` | Admin-side: per-user call log |
| `LiveMonitorPanel.jsx` | Admin-side: live camera (LiveKit, JPEG fallback), mic, and location control/viewing |
| `ScreenshotsPanel.jsx` | Admin-side: browse/view periodic encrypted screenshots |
| `RemoteFileBrowser.jsx` / `FolderBrowser.jsx` | Admin-side: browse and pull files off the child's device |
| `NamazTracker.jsx` | Prayer times, reminders, Qada tracker, gold/glass-themed UI; entry point into Islamic reference content |
| `DuasPage.jsx` | Quran (with Ruku markers + last-read resume), Duas, Hadees reference reader — opened from within `NamazTracker.jsx`, not a top-level tab |
| `InstallPrompt.jsx` | PWA "Add to Home Screen" prompt |

"Workout" is a nav placeholder (`ComingSoon` in `App.jsx`) — not built yet.

`App.jsx` also owns, for the non-native (plain-browser) path: periodic
screen-capture via `getDisplayMedia`, and always-on camera/mic/location relay
to the admin (LiveKit for camera publish, raw WS messages for mic PCM chunks
and geolocation). The native Android app has its own equivalents for these
(see below) so it works from a background service, not just a foreground tab.

### Native wrapper — `client/android/` (Capacitor)

Java/Kotlin sources live in
`client/android/app/src/main/java/com/familywatch/app/`:

| File | Purpose |
|---|---|
| `MainActivity.java` | Capacitor bridge activity; requests runtime permissions (camera, mic, location, call log); exposes a JS-native bridge (`MeeeeNative`) for connect/disconnect, screen-capture consent, opening Accessibility settings, and self-installing a downloaded APK |
| `KeepAliveService.java` | Foreground service — the workhorse. Owns the persistent WebSocket to the server, call-log `ContentObserver` + sync, MediaProjection-based periodic screenshot capture (30s interval, skipped while screen is off), camera (LiveKit) and mic (PCM over WS) streaming, and offline queuing of call-log/browsing events for when the WS is down |
| `BootReceiver.java` | Restarts `KeepAliveService` on device boot |
| `ServiceRestartWorker.java` | WorkManager job that restarts `KeepAliveService` if it gets killed, but only if the device was previously connected |
| `LiveKitManager.kt` | Thin wrapper around the LiveKit Android SDK for the camera-publish path |
| `BrowserActivityAccessibilityService.kt` | Reads Chrome's address-bar node via `AccessibilityService` to capture browsing domains — deliberately Chrome-only and address-bar-only (enforced both in the service config and in code) |

**Capabilities built and then removed** (do not go looking for these files —
they no longer exist as of commit `9cb2abc`, "revert: remove
notification-listener and SMS transaction capture"):

- `TransactionNotificationListener.kt` — a `NotificationListenerService` that
  auto-captured UPI/bank payment notifications.
- `SmsTransactionParser.kt` + `BankSmsReceiver.kt` — a second, independent
  capture path reading bank confirmation SMS.

Both were fully built, wired into `KeepAliveService`, and live-debugged
against a real device before being deliberately reverted. See Section 2,
item 3, for why.

### Server — `server/index.js`

Single Node process, no framework — a plain `http` server plus a `ws`
WebSocket server, both on one port. Responsibilities:

- **Auth**: admin connects with a PIN (`ADMIN_PIN` env var, WS `auth` message);
  child connects with just a display name. The same admin PIN is also reused
  for plain HTTP admin-only endpoints (screenshots), since `<img src>` tags
  can't carry custom headers — see Section 2, item 1.
- **Transactions**: manual entry + PhonePe CSV statement import, admin
  browsing per user, dedup on exact transaction id.
- **Call log sync** and **browsing history sync**: native services push
  events over WS; admin can request a per-user list.
- **Screenshots**: `POST /api/screenshot/:userId` (from the browser or
  native `KeepAliveService`) stores an AES-256-GCM-encrypted blob in memory
  with a 24h TTL; `GET /api/screenshots/:userId` (list) and
  `GET /api/screenshot/:id` (fetch one) are gated behind `isAdminRequest`.
- **Live camera/mic/location relay**: camera goes over LiveKit (the server
  hands out short-lived tokens via `GET /api/lk-token`, wrapping
  `livekit-server-sdk`) with a raw-WS JPEG-frame path as fallback if LiveKit
  isn't reachable; mic audio (PCM chunks) and location updates are relayed
  as plain WS messages, not LiveKit tracks.
- **File browsing**: `ls` / `read_file` commands relayed to the child's
  background WS connection, with `POST/GET /api/file/:requestId` for the
  actual file bytes.
- **In-app auto-update**: `GET /api/version` queries the GitHub Releases API
  for the latest release (cached 5 min) and returns a version + download
  URL; `GET /api/app-download` proxies the actual APK bytes through the
  server (the repo is private, so the client can't hold a GitHub token).

**WS message-type surface** (summary, not exhaustive): `auth` / `auth_ok` /
`auth_fail`; chat via `text` and `dm`; `transaction_add` / `_update` /
`_delete` / `_get` / `..._list` / `..._new`; `browsing_add` / `_get` /
`_list` / `_new`; `call_log_add` / `_get` / `_list` / `_new`;
`start_camera` / `stop_camera` / `camera_frame`; `start_mic` / `stop_mic` /
`audio_chunk`; `start_location` / `stop_location` / `location_update`;
`ls` / `read_file`; `user_joined` / `user_left` / `users_list`.

### Infrastructure

Everything runs on a single GCE `e2-micro` VM (`familywatch-server-2`,
`us-west1-b`, Debian 12): the Node server under systemd
(`familywatch.service`), nginx (TLS via Certbot/Let's Encrypt) reverse-proxying
`/` to the app and `/livekit/` to a self-hosted LiveKit SFU running in Docker,
and DuckDNS providing the public hostname (`familywatch.duckdns.org`) since
the VM has no static IP. One VM, one domain, path-based routing — no load
balancer, no managed database.

Deployment is CI-driven: `.github/workflows/build-apk.yml` runs on every push
to `main` — builds and signs the release APK, publishes it as a GitHub
Release, then SSHes into the VM to `git pull` + reinstall deps + rebuild the
client + restart the systemd service. A second (best-effort,
`continue-on-error`) step in the same workflow idempotently installs the
nightly backup systemd timer (Section 2, item 7).

Full migration history/procedure (how the VM was moved from `us-central1-a`
to `us-west1-b`, free-tier constraints, DNS cutover, rollback plan) is
documented in detail in
[`docs/gcp-deployment-runbook.md`](./gcp-deployment-runbook.md) — summarized
above, not repeated here.

### Data durability (current state — changing, see Section 2)

Historically, all server-side data (transactions, call logs, browsing
history) lived only in in-memory JS `Map`s and was lost on every server
restart or redeploy. A migration to SQLite-backed persistence
(`server/store.js`, `better-sqlite3`) is **in progress** as separate,
concurrent work at the time of this writing — see Section 2, item 6, for the
design rationale, and Section 3 for exactly what's landed vs. deployed.
Implementation internals aren't detailed here since that work may still be
changing.

---

## 2. Chronological log of recent work

Dates below are commit dates (`git log`); reasoning is filled in from project
context where it isn't visible in the commit message.

1. **2026-08-13 — Screenshot capture: encrypted, admin-only, 30s interval**
   (`fc86371`). Periodic screen capture (via native `MediaProjection`)
   settled at a 30-second interval, skipping capture entirely while the
   screen is off. Screenshots are AES-256-GCM-encrypted at rest server-side
   — plaintext is never stored, even without an explicit encryption key
   configured. This same change closed a real pre-existing hole: the
   screenshot list/fetch endpoints had *no* auth check at all — anyone who
   guessed an id could pull it. Fixed by gating both endpoints behind
   `isAdminRequest`, reusing the existing admin WS-auth PIN rather than
   inventing a new auth system, since plain `<img src>` tags can't carry
   custom headers anyway. Note: git history for this interval shows a
   straight 5s → 30s change (`5867b10` introduced 5s; `fc86371` moved to
   30s) — no intermediate 10s/15s step appears in the committed history.

2. **2026-08-13 — Reliable in-app auto-update**
   (part of `93302f2`). Fixed a previously-broken update mechanism: CI was
   producing debug-signed APKs with a fresh signing key every build, so
   installs of a "new version" silently failed with a signature mismatch
   against the already-installed app. Fixed with a dedicated release
   keystore stored as GitHub Actions secrets and a real
   `signingConfigs.release` Gradle block. `/api/version` now dynamically
   queries the GitHub Releases API instead of returning a static value;
   `/api/app-download` proxies the actual APK bytes through the server
   because the repo is private and the client can't safely hold a GitHub
   token. CI now auto-bumps the app version every build (`1.0.<run_number>`).
   The in-app check runs once per app open, not a continuous poll.

3. **2026-08-14 — Automatic transaction capture: built, then reverted**
   (`cb66343` → `073023d` → `b1e2f1a` → reverted in `9cb2abc`). Built a
   `NotificationListenerService` to auto-capture UPI/bank payment
   notifications, then live-debugged it against a real device (Xiaomi/MIUI)
   and hit two real platform limits: (a) Android 13+'s "Restricted Settings"
   blocks sideloaded apps from getting Notification Listener /
   Accessibility access without an extra manual unlock step (Settings → App
   info → ⋮ → "Allow restricted settings"), and MIUI shows its own explicit
   denial dialog on top of that; (b) some real transactions never post a
   notification at all — the OS delays/batches them — so notification
   listening alone isn't fully reliable (one real payment took several
   minutes to show up). To cover the gap, a second independent signal was
   added: `SmsTransactionParser.kt` + `BankSmsReceiver.kt`, reading bank
   confirmation SMS directly, with a cross-source dedup layer. The user then
   **explicitly reversed course** on both mechanisms — judged too fragile
   and too sensitive a permission set for a sideloaded app (Google Play
   Protect flags the exact combination of Accessibility + Notification
   Listener + Call Log + Camera/Mic/Location as stalkerware-like on
   install) — and asked for both to be removed entirely, replaced by manual
   statement upload (item 4). The revert commit (`9cb2abc`) deleted
   `TransactionNotificationListener.kt`, `SmsTransactionParser.kt`,
   `BankSmsReceiver.kt`, their manifest entries, and the related
   `KeepAliveService`/`TransactionPanel.jsx` plumbing; browsing
   (Accessibility) and call-log capture were explicitly kept, as unrelated
   features not part of this decision. Confirmed: none of the three removed
   files exist in the current tree.

4. **PhonePe statement CSV upload** (replaces automatic capture) — working
   tree only, not yet committed as of this writing.
   `client/src/utils/phonePeStatement.js` parses a manually-exported PhonePe
   transaction statement CSV, verified against a real user-provided sample
   (74 rows: 70 debits, 4 credits, exact amounts/dates/merchants matched).
   Server-side dedup switched from a fuzzy type+amount+time-window heuristic
   to **exact transaction-id match only** (`server/index.js`, the
   `isDuplicate` check against `store.getList(...)`), after real statement
   data showed the fuzzy check produced false positives — e.g. two
   genuinely distinct ₹1 debits in the same minute with different real
   transaction IDs.

5. **Quran "last read" resume + Ruku markers** — working tree only, not yet
   committed as of this writing (`client/src/components/DuasPage.jsx`,
   confirmed present: `quran-last-read` localStorage key,
   `duas-continue-card`, `duas-ruku-marker`). Added because there was
   previously no way to resume Quran reading across days. A debounced
   scroll-position tracker persists `{surah, ayah, surahName, timestamp}` to
   `localStorage`, surfaced as a "Continue Reading" card on the surah-list
   landing view; tapping it reopens the surah and auto-scrolls to that ayah,
   reusing the reveal-then-scroll pattern originally built for keeping the
   currently-playing audio ayah in view. Ruku (the Quran's ~558-section
   traditional subdivision) was previously unshown despite the Al Quran
   Cloud API already returning a `ruku` field per ayah — now plumbed
   through and rendered as small dividers between ayahs.

6. **Durable server-side storage (GCP)** — **in progress**, working tree
   only, not committed as of this writing (`server/store.js` exists;
   `server/index.js` already requires it and routes transactions/browsing/
   call-log reads and writes through it). Requirement: no user data should
   be lost on server restart. A researched comparison of Firestore+Cloud
   Storage vs. SQLite-on-the-existing-VM-disk concluded **SQLite via
   `better-sqlite3`**, not Firestore: at this app's real scale (a handful of
   family users, a few hundred records/month), Firestore/Cloud Storage would
   solve a scale problem this app doesn't have, at real cost — new
   billing-account/IAM setup, and converting the server's synchronous
   in-memory reads into async network calls. SQLite on the VM's
   already-persistent boot disk costs nothing new, needs no new GCP
   resources, and keeps the server's code synchronous. This surfaced a real
   pre-existing bug that had to be fixed as part of the same change:
   `userId` was previously re-minted randomly on every connection and
   wasn't stable across a restart, so persisting the old in-memory data
   keyed by `userId` as-is would still have orphaned every user's data after
   a restart (the admin would look up a new `userId` and find nothing). The
   fix keys persisted data by the user's **name** (the app's real stable
   identity) and assigns each name a stable `userId` once, tracked in a
   `known_users` table. This work is not yet deployed to the VM — see
   Section 3.

7. **Nightly off-VM backup** — working tree only, not committed as of this
   writing (`server/backup.js`, `deploy/familywatch-backup.service`,
   `deploy/familywatch-backup.timer`, and a new deploy step in
   `.github/workflows/build-apk.yml`). Insurance against the one gap
   SQLite-on-VM doesn't cover — disk loss/corruption, as opposed to ordinary
   restarts, which SQLite-on-disk already survives. A plain Node script (no
   new npm dependencies) snapshots the SQLite DB safely via
   `better-sqlite3`'s own online-backup API (never a raw file copy of a live
   DB, which risks capturing a half-written page) and uploads it to a Cloud
   Storage bucket (`familywatch-backups-7f266f68`) using the VM's GCE
   metadata-server service-account token directly against the GCS JSON API
   — no `gsutil`/Cloud SDK needed. Scheduled via a systemd timer, nightly at
   ~02:37, installed/enabled idempotently by CI on every deploy. Two real
   platform obstacles along the way: (a) the first approach tried —
   downloading a service-account JSON key — was blocked outright by a GCP
   org policy (`iam.disableServiceAccountKeyCreation`, part of Google's
   "Secure by Default" enforcement on newer projects), so that path was
   abandoned in favor of the metadata-server token approach; (b) the VM's
   default Compute Engine service account only has **read-only** Cloud
   Storage access by default (GCP's default instance OAuth scope set),
   which blocks the upload regardless of IAM role bindings — the fix
   requires expanding the VM's instance-level scopes, which GCP only allows
   while the instance is stopped, done via a `gcloud` script intended to be
   run manually in Cloud Shell (not from CI). **This scope expansion is a
   user-executed manual step with no way to confirm its status from the
   repo — confirm separately.**

---

## 3. Current status / open items

As of this writing (`git status` / `git log` on branch
`feature/admin-home-calllog-browsing-v2`):

- **Committed and on this branch**: glass UI/bottom nav/dashboard/Namaz
  tracker, transactions dashboard + (now-reverted) auto-import, browsing
  activity monitoring, call log monitoring, admin home redesign, reliable
  auto-update, encrypted 30s screenshot capture, and the notification/SMS
  capture revert. All of this has been through at least one CI build; the
  server-side portions have been deployed via the existing CI SSH step
  (though CI deploys `main`, and the current work is on a feature branch —
  confirm branch/merge state before assuming the VM is running this exact
  code).
- **Implemented but not yet committed** (all sitting in the working tree,
  per `git status`): PhonePe statement CSV upload
  (`client/src/utils/phonePeStatement.js`), Quran resume + Ruku markers
  (`DuasPage.jsx`), SQLite persistence (`server/store.js`, plus
  `server/index.js` changes already wired to use it), and nightly backup
  (`server/backup.js`, `deploy/`, CI workflow changes). None of this has
  been deployed to the VM yet, since nothing has been pushed to `main`.
- **Not yet started**: Workout tab (nav placeholder only).
- **Pending manual/external verification, not determinable from the repo**:
  - Whether the VM's instance-level OAuth scopes have actually been
    expanded to allow Cloud Storage writes (required for backups to
    succeed) — this was a manual `gcloud` step run outside of CI.
  - First real deploy of the SQLite persistence work, and confirmation that
    transactions/call-log/browsing data actually survive a server restart
    in production (not just locally).
  - First real (non-manual) run of `server/backup.js` via the systemd timer
    on the VM, and confirmation a backup object actually lands in
    `familywatch-backups-7f266f68`.

---

*See also: [`docs/gcp-deployment-runbook.md`](./gcp-deployment-runbook.md)
for the full GCP VM migration procedure and infra checklist.*
