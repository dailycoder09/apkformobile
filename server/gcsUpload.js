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
      'Content-Length': String(bytes.length),
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

module.exports = {
  getAccessToken,
  uploadBytesToGcs,
  uploadToGcs,
  downloadBytesFromGcs,
  downloadFromGcs,
};
