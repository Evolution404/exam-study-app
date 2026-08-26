/**
 * Transport/storage envelope codec for v8 sync objects (segments, checkpoints,
 * offloaded objects — everything except head.json).
 *
 * Writers DEFLATE-compress the JSON when `CompressionStream` is available;
 * readers sniff the zlib header and inflate, else treat the bytes as plain
 * JSON.  Content addressing is unchanged: paths and descriptors keep the
 * sha256/size of the LOGICAL JSON bytes, so compressed and plain objects of
 * the same content share one identity. Browsers without CompressionStream
 * use plain JSON as the current wire format, so
 * a vault can always be written to — never a hard failure.
 */

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function compressionAvailable(): boolean {
  return typeof CompressionStream !== "undefined" && typeof DecompressionStream !== "undefined";
}

/** zlib streams start with CMF 0x78 (deflate / 32 KiB window); the FLG byte
 *  makes (CMF<<8 | FLG) divisible by 31 — the header's own integrity check —
 *  and must not set FDICT (bit 0x20), which we never write.  That two-byte
 *  test distinguishes our envelope from every image format and from raw JSON
 *  ('{' = 0x7B). */
export function isZlibEnvelope(bytes: Uint8Array): boolean {
  if (bytes.length < 2) return false;
  const cmf = bytes[0];
  const flg = bytes[1];
  return cmf === 0x78 && ((cmf * 256) + flg) % 31 === 0 && (flg & 0x20) === 0;
}

async function pipeThrough(bytes: Uint8Array, transform: "deflate" | "deflate-raw" | "gzip"): Promise<Uint8Array> {
  // Blob.stream() gives a ReadableStream without copying the input.
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream(transform));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** True when the running environment will write the compressed envelope. */
export function syncV7CompressionEnabled(): boolean {
  return compressionAvailable();
}

/** Encode logical JSON bytes for upload/storage: DEFLATE when possible, else
 *  keep the logical JSON bytes unchanged. */
export async function encodeSyncV7JsonBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!compressionAvailable()) return bytes;
  return pipeThrough(bytes, "deflate");
}

/** Decode stored/uploaded sync bytes back to the logical JSON bytes. The zlib
 *  sniff lets compressed and current plain-JSON objects use the same call. */
export async function decodeSyncV7JsonBytes(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isZlibEnvelope(bytes)) return bytes;
  return inflate(bytes);
}

/** Text-level convenience wrappers over the byte codec. */
export async function encodeSyncV7Json(text: string): Promise<Uint8Array> {
  return encodeSyncV7JsonBytes(TEXT_ENCODER.encode(text));
}

export async function decodeSyncV7Json(bytes: Uint8Array): Promise<string> {
  return TEXT_DECODER.decode(await decodeSyncV7JsonBytes(bytes));
}
