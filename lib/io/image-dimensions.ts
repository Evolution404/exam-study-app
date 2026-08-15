/**
 * Dependency-free image dimension sniffing for the import pipeline.
 *
 * The editor's upload path decodes dimensions through the canvas adapter, but
 * imports run in Node tests too, so the byte-level headers are parsed directly
 * for the three mime types the asset store accepts (png / jpeg / webp).
 */

export interface ImageDimensions {
  width: number;
  height: number;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  // 8-byte signature + IHDR chunk: length(4) + type(4) + width(4) + height(4).
  if (bytes.length < 24) return undefined;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (signature.some((value, index) => bytes[index] !== value)) return undefined;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return undefined; // "IHDR"
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 2;
  while (offset + 9 < view.byteLength) {
    if (view.getUint8(offset) !== 0xff) return undefined;
    const marker = view.getUint8(offset + 1);
    // Standalone markers without a length payload.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { offset += 2; continue; }
    const length = view.getUint16(offset + 2);
    // SOF0..SOF15 except DHT (0xc4), DAC (0xcc), RSTn and TEM which never carry frames.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) };
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (bytes.length < 30) return undefined;
  if (String.fromCharCode(...bytes.subarray(0, 4)) !== "RIFF" || String.fromCharCode(...bytes.subarray(8, 12)) !== "WEBP") return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = String.fromCharCode(...bytes.subarray(12, 16));
  if (tag === "VP8 ") {
    // Lossy: keyframe header starts at +6; dims at +6+6 (14-bit LE values).
    if (view.getUint32(20 + 3, true) !== 0x9d012a) return undefined;
    return { width: view.getUint16(26) & 0x3fff, height: view.getUint16(28) & 0x3fff };
  }
  if (tag === "VP8L") {
    // Lossless: 14-bit dims packed after the signature byte 0x2f.
    const bits = view.getUint32(21, true);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (tag === "VP8X") {
    // Extended: 24-bit canvas dims stored minus one, little-endian across 3 bytes.
    return {
      width: 1 + ((bytes[24]) | (bytes[25] << 8) | (bytes[26] << 16)),
      height: 1 + ((bytes[27]) | (bytes[28] << 8) | (bytes[29] << 16)),
    };
  }
  return undefined;
}

/** Read the pixel dimensions of a png / jpeg / webp image; undefined when the
 * bytes are not one of those formats or the header is truncated. */
export function sniffImageDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  for (const parse of [pngDimensions, jpegDimensions, webpDimensions]) {
    const parsed = parse(bytes);
    if (parsed && parsed.width > 0 && parsed.height > 0) return parsed;
  }
  return undefined;
}
