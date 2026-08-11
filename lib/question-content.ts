import type { ContentBlock, ImageContentBlock, QuestionV6, TextContentBlock } from "./v6-types";

export interface TextSelection {
  start: number;
  end?: number;
}

export interface QuestionContentFingerprintInput {
  type: QuestionV6["type"];
  content: readonly ContentBlock[];
  options: readonly (readonly ContentBlock[])[];
  answer: string;
}

const encoder = new TextEncoder();

/** Normalize user-authored text without changing its semantic line breaks. */
export function normalizeContentText(value: string): string {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

/** Derive only the human-readable text from a block sequence. */
export function deriveContentText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is TextContentBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** Search text includes image alt/caption so image-only questions remain findable. */
export function deriveSearchText(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => block.type === "text" ? block.text : [block.alt, block.caption].filter(Boolean).join(" "))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Return a compact plain-text preview of a content sequence. */
export function summarizeContent(blocks: readonly ContentBlock[], maxLength = 120): string {
  const text = deriveSearchText(blocks);
  if (text.length <= maxLength) return text;
  const safeLength = Math.max(0, Math.floor(maxLength));
  if (!safeLength) return "";
  return `${text.slice(0, Math.max(0, safeLength - 1))}…`;
}

/** Convert an imported plain-text value to the smallest editable block model. */
export function plainTextToContentBlocks(value: string, id = "text-0"): ContentBlock[] {
  return [{ id, type: "text", text: value.replace(/\r\n?/g, "\n").replace(/[\u2028\u2029]/g, "\n") }];
}

function normalizedFingerprintBlock(block: ContentBlock): Record<string, string> {
  return block.type === "text"
    ? { type: "text", text: normalizeContentText(block.text) }
    : { type: "image", assetId: block.assetId };
}

function canonicalFingerprintPayload(input: QuestionContentFingerprintInput): string {
  return JSON.stringify({
    type: input.type,
    content: input.content.map(normalizedFingerprintBlock),
    options: input.options.map((option) => option.map(normalizedFingerprintBlock)),
    answer: normalizeContentText(input.answer),
  });
}

/* A small synchronous SHA-256 implementation keeps fingerprinting usable in
 * both the browser and import scripts without a Node-only crypto dependency. */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

function sha256(bytes: Uint8Array): string {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const high = Math.floor(bitLength / 0x100000000);
  const low = bitLength >>> 0;
  padded[padded.length - 8] = (high >>> 24) & 0xff;
  padded[padded.length - 7] = (high >>> 16) & 0xff;
  padded[padded.length - 6] = (high >>> 8) & 0xff;
  padded[padded.length - 5] = high & 0xff;
  padded[padded.length - 4] = (low >>> 24) & 0xff;
  padded[padded.length - 3] = (low >>> 16) & 0xff;
  padded[padded.length - 2] = (low >>> 8) & 0xff;
  padded[padded.length - 1] = low & 0xff;

  const state = new Uint32Array(INITIAL);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const base = offset + index * 4;
      words[index] = ((padded[base] << 24) | (padded[base + 1] << 16) | (padded[base + 2] << 8) | padded[base + 3]) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const value = words[index - 15];
      const sigma0 = rotateRight(value, 7) ^ rotateRight(value, 18) ^ (value >>> 3);
      const previous = words[index - 2];
      const sigma1 = rotateRight(previous, 17) ^ rotateRight(previous, 19) ^ (previous >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sigma1 + choose + K[index] + words[index]) >>> 0;
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sigma0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    state[0] = (state[0] + a) >>> 0;
    state[1] = (state[1] + b) >>> 0;
    state[2] = (state[2] + c) >>> 0;
    state[3] = (state[3] + d) >>> 0;
    state[4] = (state[4] + e) >>> 0;
    state[5] = (state[5] + f) >>> 0;
    state[6] = (state[6] + g) >>> 0;
    state[7] = (state[7] + h) >>> 0;
  }
  return [...state].map((word) => word.toString(16).padStart(8, "0")).join("");
}

/**
 * Fingerprint only question semantics.  IDs, block metadata, tags and
 * favorite state intentionally do not participate, so the same question can
 * be shared by multiple banks without duplicate content objects.
 */
export function questionContentFingerprint(input: QuestionContentFingerprintInput | QuestionV6): string {
  return sha256(encoder.encode(canonicalFingerprintPayload(input)));
}

function splitSelection(text: string, selection: TextSelection): [string, string] {
  const length = text.length;
  const requestedStart = Number.isFinite(selection.start) ? Math.trunc(selection.start) : 0;
  const requestedEnd = Number.isFinite(selection.end ?? selection.start) ? Math.trunc(selection.end ?? selection.start) : requestedStart;
  const start = Math.max(0, Math.min(length, Math.min(requestedStart, requestedEnd)));
  const end = Math.max(0, Math.min(length, Math.max(requestedStart, requestedEnd)));
  return [text.slice(0, start), text.slice(end)];
}

function splitBlockId(id: string, suffix: string): string {
  return `${id}:${suffix}`;
}

/**
 * Insert an image at a text selection.  Empty text blocks are retained at the
 * edges; this makes a second insertion at the same caret deterministic and
 * supports consecutive images without a DOM/editor dependency.
 */
export function insertImageAtSelection(
  blocks: readonly ContentBlock[],
  textBlockId: string,
  selection: TextSelection,
  image: ImageContentBlock,
): ContentBlock[] {
  const index = blocks.findIndex((block) => block.id === textBlockId && block.type === "text");
  if (index < 0) return [...blocks];
  const current = blocks[index];
  if (current.type !== "text") return [...blocks];
  const [before, after] = splitSelection(current.text, selection);
  const replacement: ContentBlock[] = [
    { id: current.id, type: "text", text: before },
    { ...image },
    { id: splitBlockId(current.id, "after"), type: "text", text: after },
  ];
  return [...blocks.slice(0, index), ...replacement, ...blocks.slice(index + 1)];
}

export function moveContentBlock(blocks: readonly ContentBlock[], blockId: string, toIndex: number): ContentBlock[] {
  const fromIndex = blocks.findIndex((block) => block.id === blockId);
  if (fromIndex < 0) return [...blocks];
  const result = [...blocks];
  const [block] = result.splice(fromIndex, 1);
  const destination = Math.max(0, Math.min(result.length, Math.trunc(toIndex)));
  result.splice(destination, 0, block);
  return result;
}

export function replaceContentBlock(
  blocks: readonly ContentBlock[],
  blockId: string,
  replacement: ContentBlock,
): ContentBlock[] {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return [...blocks];
  const result = [...blocks];
  result[index] = replacement;
  return result;
}

export function deleteContentBlock(blocks: readonly ContentBlock[], blockId: string): ContentBlock[] {
  const index = blocks.findIndex((block) => block.id === blockId);
  if (index < 0) return [...blocks];
  return [...blocks.slice(0, index), ...blocks.slice(index + 1)];
}

