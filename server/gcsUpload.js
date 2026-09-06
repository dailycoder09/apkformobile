'use strict';

/**
 * Shared Google Cloud Storage upload helper, extracted from backup.js so the
 * new per-device encrypted-chunk backup path (see index.js's
 * /api/device-backup/chunk route) can reuse the exact same, already-working
 * auth mechanism instead of duplicating it.
 *
 * Auth: bearer token from the GCE VM's own attached service account, fetched
 * from the instance metadata server. This project's org policy
 * (iam.disableServiceAccountKeyCreation) blocks downloading a service-account
 * key file, and no @google-cloud/storage or googleapis SDK is installed — so
 * this hand-rolled metadata-token + JSON-API-simple-upload approach is not
 * just the existing pattern, it's the only one available without adding new
 * GCP-side setup. This also means GCS *signed URLs* (which need a private key
 * to sign with) aren't an option here — every upload goes: device -> this
 * server -> GCS, never device -> GCS directly.
 */

const METADATA_TOKEN_URL =
  'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token';

/** Fetch a bearer token for the VM's attached service account. */
async function getAccessToken() {
  let res;
  try {
    res = await fetch(METADATA_TOKEN_URL, { headers: { 'Metadata-Flavor': 'Google' } });
  } catch (e) {
    throw new Error(
      'Could not reach the GCE metadata server at ' +
        METADATA_TOKEN_URL +
        '. This must run on the GCE VM itself. ' +
        `Underlying error: ${e.message}`
    );
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(
      `Metadata server token request failed: HTTP ${res.status} ${res.statusText}. ${body}`
    );
  }
  const json = await res.json();
  if (!json.access_token) {
    throw new Error('Metadata server response did not include an access_token.');
  }
  return json.access_token;
}

/** Upload raw bytes (Buffer) to GCS via the JSON API's simple upload endpoint. */
async function uploadBytesToGcs({ bucket, objectName, bytes, accessToken }) {
  const url =
    `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
    `?uploadType=media&name=${encodeURIComponent(objectName)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/octet-stream',
    },
    body: bytes,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (res.status === 403) {
      throw new Error(
        'GCS upload failed with HTTP 403 Forbidden. This almost certainly means the VM\'s ' +
          'service account does NOT yet have the devstorage.read_write scope (or the bucket-level ' +
          'Storage Object Admin binding hasn\'t been applied yet) — this is a pending infra/scopes ' +
          `setup step, NOT a bug in this code. Response body: ${body}`
      );
    }
    throw new Error(`GCS upload failed: HTTP ${res.status} ${res.statusText}. ${body}`);
  }

  return res.json();
}

/** Convenience wrapper: fetch a fresh token, then upload. */
async function uploadToGcs({ bucket, objectName, bytes }) {
  const accessToken = await getAccessToken();
  return uploadBytesToGcs({ bucket, objectName, bytes, accessToken });
}

/**
 * Stream bytes to GCS via the JSON API's simple upload endpoint, without buffering
 * the whole payload in memory. `sourceStream` is any Node Readable (e.g. an HTTP
 * IncomingMessage); `contentLength` must be the exact byte length the caller has
 * already determined (e.g. from the source request's own Content-Length header) —
 * never recompute it from a buffer, since the whole point is to never hold one.
 * Uses the raw `https` module rather than `fetch`, deliberately: undici's fetch
 * throws InvalidArgumentError if you set a Content-Length header explicitly (see
 * uploadBytesToGcs's history) — raw https.request has no such restriction.
 */
function streamBytesToGcs({ bucket, objectName, contentLength, sourceStream, accessToken }) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const path =
      `/upload/storage/v1/b/${encodeURIComponent(bucket)}/o` +
      `?uploadType=media&name=${encodeURIComponent(objectName)}`;

    const req = https.request(
      {
        hostname: 'storage.googleapis.com',
        path,
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': contentLength,
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            if (res.statusCode === 403) {
              reject(new Error(
                'GCS upload failed with HTTP 403 Forbidden. This almost certainly means the VM\'s ' +
                  'service account does NOT yet have the devstorage.read_write scope (or the bucket-level ' +
                  'Storage Object Admin binding hasn\'t been applied yet) — this is a pending infra/scopes ' +
                  `setup step, NOT a bug in this code. Response body: ${body}`
              ));
              return;
            }
            reject(new Error(`GCS upload failed: HTTP ${res.statusCode} ${res.statusMessage}. ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (e) {
            reject(new Error(`GCS upload response was not valid JSON: ${e.message}`));
          }
        });
      }
    );

    req.on('error', reject);
    sourceStream.on('error', (e) => req.destroy(e));
    sourceStream.pipe(req);
  });
}

/** Download an object's raw bytes from GCS via the JSON API's alt=media param. */
async function downloadBytesFromGcs({ bucket, objectName, accessToken }) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/` +
    `${encodeURIComponent(objectName)}?alt=media`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GCS download failed: HTTP ${res.status} ${res.statusText}. ${body}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/** Convenience wrapper: fetch a fresh token, then download. */
async function downloadFromGcs({ bucket, objectName }) {
  const accessToken = await getAccessToken();
  return downloadBytesFromGcs({ bucket, objectName, accessToken });
}

/**
 * Deletes an object from GCS — used when a device is removed (manually or via the
 * inactivity-based auto-cleanup) so the actual backup data is gone, not just the
 * SQLite record referencing it. A 404 (object already gone) is treated as success,
 * not an error, since the end state either way is "this object doesn't exist".
 */
async function deleteObjectFromGcs({ bucket, objectName, accessToken }) {
  const url =
    `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(bucket)}/o/` +
    `${encodeURIComponent(objectName)}`;
  const res = await fetch(url, { method: 'DELETE', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok && res.status !== 404) {
    const body = await res.text().catch(() => '');
    throw new Error(`GCS delete failed: HTTP ${res.status} ${res.statusText}. ${body}`);
  }
}

module.exports = {
  getAccessToken,
  uploadBytesToGcs,
  uploadToGcs,
  streamBytesToGcs,
  downloadBytesFromGcs,
  downloadFromGcs,
  deleteObjectFromGcs,
};
