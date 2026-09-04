#!/usr/bin/env node
'use strict';

/**
 * Nightly off-VM backup of the SQLite database to Google Cloud Storage.
 *
 * Run via `node server/backup.js` (no arguments). Intended to be invoked by
 * the familywatch-backup.timer / familywatch-backup.service systemd units
 * (see deploy/), but can also be run manually for a one-off backup.
 *
 * How it works:
 *   1. Take a consistent point-in-time snapshot of server/data.sqlite using
 *      SQLite's own online-backup mechanism (never a raw fs.copyFile of a
 *      live database — that risks capturing a half-written page and
 *      producing a corrupt backup).
 *   2. Upload the snapshot to GCS via the JSON API's simple upload endpoint,
 *      authenticated with a bearer token fetched from the GCE metadata
 *      server for this VM's attached service account.
 *
 * No new npm dependencies are introduced by this script. It uses
 * better-sqlite3 if (and only if) it's already installed as a server
 * dependency (added by the separate SQLite-persistence work); otherwise it
 * falls back to shelling out to the `sqlite3` CLI's `.backup` command. If
 * neither is available, it fails loudly rather than silently skipping the
 * backup.
 *
 * TODO(ops, one-time): once the bucket is confirmed working, add an Object
 * Lifecycle rule on gs://<bucket> to age-delete objects under backups/
 * after ~14 days (via Console or `gcloud storage buckets update ... `
 * --lifecycle-file=...). Not implemented here — retention is out of scope
 * for this script.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { getAccessToken, uploadBytesToGcs } = require('./gcsUpload');

const DB_PATH = path.join(__dirname, 'data.sqlite');

// Documented default so the bucket name isn't hardcoded magic; override with
// the BACKUP_BUCKET env var if the bucket is ever renamed/recreated.
const DEFAULT_BUCKET = 'familywatch-backups-7f266f68';
const BUCKET = process.env.BACKUP_BUCKET || DEFAULT_BUCKET;

function log(msg) {
  console.log(`[backup ${new Date().toISOString()}] ${msg}`);
}

function errLog(msg) {
  console.error(`[backup ${new Date().toISOString()}] ${msg}`);
}

/** YYYY-MM-DD for "today", based on local system time. */
function todayStamp() {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Produce a consistent snapshot of DB_PATH at a fresh temp path and return
 * that path. Prefers better-sqlite3's own backup() API (uses SQLite's
 * online backup mechanism under the hood — safe against concurrent writers).
 * Falls back to the `sqlite3` CLI's `.backup` dot-command if the module
 * isn't installed. Throws if neither route is available.
 */
async function snapshotDatabase() {
  if (!fs.existsSync(DB_PATH)) {
    throw new Error(`Database file not found at ${DB_PATH} — nothing to back up.`);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'familywatch-backup-'));
  const destPath = path.join(tmpDir, 'data.sqlite');

  let betterSqlite3;
  try {
    betterSqlite3 = require('better-sqlite3');
  } catch (e) {
    betterSqlite3 = null;
  }

  if (betterSqlite3) {
    log('Using better-sqlite3 online backup API.');
    const db = new betterSqlite3(DB_PATH, { readonly: true, fileMustExist: true });
    try {
      await db.backup(destPath);
    } finally {
      db.close();
    }
    return { destPath, tmpDir };
  }

  // Fallback: shell out to the sqlite3 CLI. Note this is NOT installed by
  // default on Debian 12 — if this branch is hit, `apt-get install sqlite3`
  // is required on the VM first. This is only expected to matter as a
  // stop-gap before the better-sqlite3 dependency lands.
  log('better-sqlite3 not installed; falling back to sqlite3 CLI .backup.');
  try {
    execFileSync('sqlite3', [DB_PATH, `.backup ${destPath}`], { stdio: 'inherit' });
  } catch (e) {
    throw new Error(
      'Neither better-sqlite3 (node module) nor a working `sqlite3` CLI is available. ' +
        'Install one of the two before backups can run. ' +
        `Underlying error: ${e.message}`
    );
  }
  return { destPath, tmpDir };
}

async function main() {
  const stamp = todayStamp();
  const objectName = `backups/familywatch-${stamp}.sqlite`;

  log(`Starting backup: db=${DB_PATH} bucket=${BUCKET} object=${objectName}`);

  let snapshot;
  try {
    snapshot = await snapshotDatabase();
  } catch (e) {
    errLog(`FAILED to create local snapshot: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const { destPath, tmpDir } = snapshot;

  try {
    const stat = fs.statSync(destPath);
    log(`Snapshot created at ${destPath} (${stat.size} bytes). Fetching access token...`);

    const accessToken = await getAccessToken();

    log('Access token acquired. Uploading to GCS...');
    const bytes = fs.readFileSync(destPath);
    await uploadBytesToGcs({ bucket: BUCKET, objectName, bytes, accessToken });

    log(`Backup uploaded successfully to gs://${BUCKET}/${objectName}`);
  } catch (e) {
    errLog(`FAILED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    // Best-effort cleanup of the temp snapshot regardless of outcome.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (cleanupErr) {
      errLog(`Warning: failed to clean up temp dir ${tmpDir}: ${cleanupErr.message}`);
    }
  }
}

main();
