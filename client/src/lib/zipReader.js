// Minimal, dependency-free reader for the specific ZIP shape DeviceBackupWorker.java's
// zipFiles() produces: STORED (uncompressed) entries only. Deliberately not a general
// ZIP library — no DEFLATE support, no zip64, no encryption — because we control both
// ends: writing uncompressed means reading a file back out is just slicing raw bytes at
// a known offset, with zero decompression code (and zero new npm dependency) needed
// here. If this ever needs to read a compressed entry, that's a sign the writer side
// changed and this needs revisiting together with it, not just this file in isolation.

const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_DIR_SIGNATURE = 0x02014b50
const LOCAL_HEADER_SIGNATURE = 0x04034b50
const METHOD_STORED = 0

/**
 * @param {ArrayBuffer} buffer
 * @returns {{ name: string, offset: number, size: number }[]} offset/size point directly
 *   at the raw file bytes within `buffer` — slice with `buffer.slice(offset, offset+size)`.
 */
export function readStoredZipEntries(buffer) {
  const view = new DataView(buffer)
  const total = buffer.byteLength

  // No ZIP comment is ever written on the encoding side, so the End-Of-Central-
  // Directory record is always exactly the last 22 bytes — no need to scan backward.
  const eocdOffset = total - 22
  if (eocdOffset < 0 || view.getUint32(eocdOffset, true) !== EOCD_SIGNATURE) {
    throw new Error('Not a recognizable zip file (missing end-of-central-directory record).')
  }
  const entryCount = view.getUint16(eocdOffset + 10, true)
  const centralDirOffset = view.getUint32(eocdOffset + 16, true)

  const entries = []
  let pos = centralDirOffset
  const decoder = new TextDecoder('utf-8')

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error('Corrupt zip: central directory entry signature mismatch.')
    }
    const method = view.getUint16(pos + 10, true)
    const compressedSize = view.getUint32(pos + 20, true)
    const nameLength = view.getUint16(pos + 28, true)
    const extraLength = view.getUint16(pos + 30, true)
    const commentLength = view.getUint16(pos + 32, true)
    const localHeaderOffset = view.getUint32(pos + 42, true)
    const nameBytes = new Uint8Array(buffer, pos + 46, nameLength)
    const name = decoder.decode(nameBytes)

    if (method !== METHOD_STORED) {
      throw new Error(`Unsupported zip compression method (${method}) for "${name}" — expected STORED.`)
    }

    // The local header's own filename/extra lengths can differ slightly from the
    // central directory's copy, so they must be read fresh to find where data starts.
    if (view.getUint32(localHeaderOffset, true) !== LOCAL_HEADER_SIGNATURE) {
      throw new Error(`Corrupt zip: local header signature mismatch for "${name}".`)
    }
    const localNameLength = view.getUint16(localHeaderOffset + 26, true)
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true)
    const dataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength

    entries.push({ name, offset: dataOffset, size: compressedSize })

    pos += 46 + nameLength + extraLength + commentLength
  }

  return entries
}
