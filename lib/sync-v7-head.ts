/**
 * Sync v7 transport contract.
 *
 * v7 deliberately keeps the mutable surface to one small head file.  The
 * checkpoint, objects and hot segments named by that file are immutable and
 * content addressed.  This module is transport-only: it has no dependency on
 * IndexedDB, a domain reducer or a UI.
 */

export const SYNC_V7_FORMAT_VERSION = 7 as const;
export const SYNC_V7_HEAD_PATH = "sync/v7/head.json";
export const SYNC_V7_CHECKPOINT_PREFIX = "sync/v7/checkpoints/";
export const SYNC_V7_OBJECT_PREFIX = "sync/v7/objects/";
export const SYNC_V7_SEGMENT_PREFIX = "sync/v7/segments/";
export const SYNC_V7_ASSET_PREFIX = "sync/v7/assets/";
/** Naming aliases used by callers that call segments “hot segments”. */
export const SYNC_V7_HOT_SEGMENT_PREFIX = SYNC_V7_SEGMENT_PREFIX;
export const SYNC_V7_EVENT_SEGMENT_PREFIX = SYNC_V7_SEGMENT_PREFIX;

/** The maximum encoded inline event. Larger payloads must be immutable refs. */
export const SYNC_V7_MAX_EVENT_BYTES = 256 * 1024;
/** A hot segment is bounded independently of the aggregate hot window. */
export const SYNC_V7_MAX_SEGMENT_BYTES = 1024 * 1024;
export const SYNC_V7_MAX_SEGMENT_EVENT_COUNT = 250;
export const SYNC_V7_MAX_HOT_SEGMENT_BYTES = SYNC_V7_MAX_SEGMENT_BYTES;
export const SYNC_V7_MAX_EVENT_PAGE_BYTES = SYNC_V7_MAX_SEGMENT_BYTES;
export const SYNC_V7_MAX_EVENT_PAGE_COUNT = SYNC_V7_MAX_SEGMENT_EVENT_COUNT;
export const SYNC_V7_MAX_SEGMENT_COUNT = 4096;
/** Checkpointing is driven by bytes, never by page count or CAS retries. */
export const SYNC_V7_MAX_HOT_BYTES = 4 * 1024 * 1024;
export const SYNC_V7_MAX_HOT_EVENT_BYTES = SYNC_V7_MAX_HOT_BYTES;
export const SYNC_V7_MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
export const SYNC_V7_MAX_OBJECT_BYTES = SYNC_V7_MAX_DESCRIPTOR_BYTES;
export const SYNC_V7_MAX_PATH_LENGTH = 512;
export const SYNC_V7_MAX_VAULT_ID_LENGTH = 256;
export const SYNC_V7_MAX_DEVICE_CURSORS = 256;
export const SYNC_V7_MAX_DEVICE_ID_LENGTH = 128;

export const SYNC_V7_LIMITS = Object.freeze({
  maxEventBytes: SYNC_V7_MAX_EVENT_BYTES,
  maxSegmentBytes: SYNC_V7_MAX_SEGMENT_BYTES,
  maxSegmentEventCount: SYNC_V7_MAX_SEGMENT_EVENT_COUNT,
  maxSegmentCount: SYNC_V7_MAX_SEGMENT_COUNT,
  maxHotBytes: SYNC_V7_MAX_HOT_BYTES,
  maxDescriptorBytes: SYNC_V7_MAX_DESCRIPTOR_BYTES,
  maxPathLength: SYNC_V7_MAX_PATH_LENGTH,
  maxVaultIdLength: SYNC_V7_MAX_VAULT_ID_LENGTH,
  maxDeviceCursors: SYNC_V7_MAX_DEVICE_CURSORS,
});

export type SyncV7Bytes = Uint8Array | ArrayBuffer | string;

export interface SyncV7Descriptor {
  /** Relative Git path in one of the immutable v7 namespaces. */
  path: string;
  /** Git's SHA-1 blob id returned by the Contents API. */
  blobSha: string;
  /** SHA-256 of the exact (uncompressed) bytes represented by this object. */
  sha256: string;
  /** Size of the exact bytes represented by this object. */
  size: number;
  /** Publication generation at which this checkpoint snapshot was written. */
  generation?: number;
}

export interface SyncV7HeadMetadata {
  /** Repeated in metadata so a decoded head cannot be detached from its vault. */
  vaultId: string;
  /** Device which last published this head, when known. */
  deviceId?: string;
  /** Optional producer label for forward-compatible diagnostics. */
  producer?: string;
}

export interface SyncV7SegmentMetadata {
  vaultId: string;
  createdAt: string;
  /** Optional producer/device label; cursor values remain authoritative. */
  deviceId?: string;
  producer?: string;
}

export interface SyncV7SegmentDescriptor extends SyncV7Descriptor {
  /** Replay key. It is intentionally independent of path/hash. */
  generation: number;
  /** Replay tie-breaker within a generation. */
  ordinal: number;
  count: number;
  /** Highest observed local sequence per device in this segment. */
  cursors: Record<string, number>;
  metadata: SyncV7SegmentMetadata;
}

export interface SyncHeadV7 {
  formatVersion: typeof SYNC_V7_FORMAT_VERSION;
  /** Explicit logical vault identity; never infer this from a repository name. */
  vaultId: string;
  generatedAt: string;
  /** Monotonic publication generation (not a replay ordering substitute). */
  generation: number;
  metadata: SyncV7HeadMetadata;
  /** Null is permitted only for an uninitialised vault. */
  checkpoint: SyncV7Descriptor | null;
  segments: SyncV7SegmentDescriptor[];
  cursors: Record<string, number>;
}

export type SyncHeadDescriptorV7 = SyncV7Descriptor;
export type SyncV7Head = SyncHeadV7;
export type SyncV7EventSegmentDescriptor = SyncV7SegmentDescriptor;
export type SyncV7HotSegmentDescriptor = SyncV7SegmentDescriptor;
export type SyncV7CheckpointDescriptor = SyncV7Descriptor;
export type SyncV7ObjectDescriptor = SyncV7Descriptor;

/** A reference used inside an event when the payload is too large to inline. */
export interface SyncV7ImmutableRef {
  path: string;
  sha256: string;
  size: number;
  kind: "object" | "asset";
  /** Filled after upload; omitted in an event awaiting publication. */
  blobSha?: string;
}
export type SyncV7BlobRef = SyncV7ImmutableRef;

export interface SyncV7Segment<T = unknown> {
  formatVersion: typeof SYNC_V7_FORMAT_VERSION;
  vaultId: string;
  generation: number;
  ordinal: number;
  metadata: SyncV7SegmentMetadata;
  cursors: Record<string, number>;
  events: T[];
}

export interface SyncV7EncodedSegment<T = unknown> {
  segment: SyncV7Segment<T>;
  bytes: Uint8Array;
  size: number;
  count: number;
}

export interface SyncV7ReplaySegment<T = unknown> {
  generation: number;
  ordinal: number;
  events: readonly T[];
  path?: string;
  metadata?: SyncV7SegmentMetadata;
}

export type SyncV7DescriptorKind = "checkpoint" | "object" | "segment" | "asset";

export interface SyncV7PublicationFile {
  path: string;
  bytes: SyncV7Bytes;
  kind?: SyncV7DescriptorKind;
  /**
   * The file's bytes are already present on the remote (uploaded out-of-band to
   * obtain its descriptor, e.g. via `uploadedDescriptor`). `publish` must not
   * re-upload it; it only needs to exist when the head is written.
   */
  uploaded?: boolean;
}

export interface SyncV7PublicationPlan {
  objects: SyncV7PublicationFile[];
  segments: SyncV7PublicationFile[];
  /** Present only for initialization or an actual byte-window overflow. */
  checkpoint?: SyncV7PublicationFile;
  head: SyncHeadV7;
  expectedHeadSha?: string;
  order: readonly ["objects", "segments", "head-cas"] | readonly ["checkpoint", "objects", "segments", "head-cas"];
  mode: "append" | "compaction";
}

export interface SyncV7CompactionPlan {
  required: boolean;
  reason: "none" | "initialization" | "hot-window-overflow";
  hotBytes: number;
  /** This is a diagnostic only; it never participates in the decision. */
  segmentCount: number;
  checkpointAllowed: boolean;
}

export interface SyncV7AppendPublicationInput {
  expectedHead: SyncHeadV7;
  head: SyncHeadV7;
  objects?: readonly SyncV7PublicationFile[];
  segments?: readonly SyncV7PublicationFile[];
  expectedHeadSha?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[\x21-\x7e]{1,128}$/;
const VAULT_ID = /^[\x21-\x7e]{1,256}$/;

function fail(message: string): never {
  throw new Error(`invalid v7 sync head: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp`);
}

function assertVaultId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SYNC_V7_MAX_VAULT_ID_LENGTH || !VAULT_ID.test(value)) fail(`${field} must be an explicit printable vault identity`);
}

function assertDeviceId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !DEVICE_ID.test(value) || value.length > SYNC_V7_MAX_DEVICE_ID_LENGTH) fail(`${field} must be a printable device id`);
}

function assertSha(value: unknown, field: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} must be lowercase hexadecimal`);
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} must be a safe integer >= ${minimum}`);
}

function assertSize(value: unknown, field: string, maximum: number): asserts value is number {
  assertSafeInteger(value, field);
  if ((value as number) > maximum) fail(`${field} exceeds its byte limit`);
}

function assertCount(value: unknown, field: string): asserts value is number {
  assertSafeInteger(value, field, 1);
  if ((value as number) > SYNC_V7_MAX_SEGMENT_EVENT_COUNT) fail(`${field} exceeds the segment event limit`);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SYNC_V7_MAX_PATH_LENGTH || value.startsWith("/") || value.includes("\\")) return false;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashPath(path: string, prefix: string, extensions = "json"): boolean {
  const extension = extensions.includes("|") ? `(?:${extensions})` : extensions;
  return new RegExp(`^${escaped(prefix)}[0-9a-f]{64}\\.${extension}$`).test(path);
}

function digestFromPath(path: string): string | undefined {
  return /\/([0-9a-f]{64})\.(?:json|webp|jpg|jpeg|png|bin)$/.exec(path)?.[1];
}

/** Strictly validate that a path is in the exact v7 immutable namespace. */
export function assertSyncV7Path(value: unknown, kind: SyncV7DescriptorKind | "head"): asserts value is string {
  if (!isSafeRelativePath(value)) fail(`${kind} path is not a safe relative path`);
  if (kind === "head") {
    if (value !== SYNC_V7_HEAD_PATH) fail(`head path must be ${SYNC_V7_HEAD_PATH}`);
    return;
  }
  if (value === SYNC_V7_HEAD_PATH) fail("head.json is mutable and cannot be an immutable descriptor");
  if (kind === "checkpoint" && !hashPath(value, SYNC_V7_CHECKPOINT_PREFIX)) fail(`checkpoint path must be ${SYNC_V7_CHECKPOINT_PREFIX}<sha256>.json`);
  if (kind === "object" && !hashPath(value, SYNC_V7_OBJECT_PREFIX)) fail(`object path must be ${SYNC_V7_OBJECT_PREFIX}<sha256>.json`);
  if (kind === "segment" && !hashPath(value, SYNC_V7_SEGMENT_PREFIX)) fail(`segment path must be ${SYNC_V7_SEGMENT_PREFIX}<sha256>.json`);
  if (kind === "asset" && !hashPath(value, SYNC_V7_ASSET_PREFIX, "webp|jpg|jpeg|png|bin")) fail(`asset path must be ${SYNC_V7_ASSET_PREFIX}<sha256>.<ext>`);
}

function validateCursors(value: unknown, field: string): asserts value is Record<string, number> {
  if (!isRecord(value)) fail(`${field} must be a cursor map`);
  const entries = Object.entries(value) as Array<[string, unknown]>;
  if (entries.length > SYNC_V7_MAX_DEVICE_CURSORS) fail(`${field} has too many devices`);
  for (const [deviceId, sequence] of entries) {
    if (!DEVICE_ID.test(deviceId)) fail(`${field} contains an invalid device id`);
    assertSafeInteger(sequence, `${field}.${deviceId}`);
  }
}

function validateMetadata(value: unknown, field: string, vaultId: string): asserts value is SyncV7SegmentMetadata | SyncV7HeadMetadata {
  if (!isRecord(value)) fail(`${field} must be an object`);
  assertVaultId(value.vaultId, `${field}.vaultId`);
  if (value.vaultId !== vaultId) fail(`${field}.vaultId does not match head vaultId`);
  if ("createdAt" in value) assertDate(value.createdAt, `${field}.createdAt`);
  if (value.deviceId !== undefined) assertDeviceId(value.deviceId, `${field}.deviceId`);
  if (value.producer !== undefined && (typeof value.producer !== "string" || value.producer.length > 128)) fail(`${field}.producer is invalid`);
}

function validateDescriptor(value: unknown, kind: SyncV7DescriptorKind): asserts value is SyncV7Descriptor {
  if (!isRecord(value)) fail(`${kind} descriptor must be an object`);
  assertSyncV7Path(value.path, kind);
  assertSha(value.blobSha, `${kind}.blobSha`, SHA1);
  assertSha(value.sha256, `${kind}.sha256`, SHA256);
  assertSize(value.size, `${kind}.size`, SYNC_V7_MAX_DESCRIPTOR_BYTES);
  if (value.generation !== undefined) assertSafeInteger(value.generation, `${kind}.generation`, 0);
  const digest = digestFromPath(value.path);
  if (digest && digest !== value.sha256) fail(`${kind} path digest must equal descriptor.sha256`);
}

function sameMetadata(left: SyncV7SegmentMetadata, right: SyncV7SegmentMetadata): boolean {
  return left.vaultId === right.vaultId && left.createdAt === right.createdAt && left.deviceId === right.deviceId && left.producer === right.producer;
}

function sameCursors(left: Record<string, number>, right: Record<string, number>): boolean {
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

export function sameSyncV7Descriptor(left: SyncV7Descriptor, right: SyncV7Descriptor): boolean {
  return left.path === right.path && left.blobSha === right.blobSha && left.sha256 === right.sha256 && left.size === right.size;
}

export function sameSyncV7Segment(left: SyncV7SegmentDescriptor, right: SyncV7SegmentDescriptor): boolean {
  return sameSyncV7Descriptor(left, right) && left.generation === right.generation && left.ordinal === right.ordinal && left.count === right.count && sameCursors(left.cursors, right.cursors) && sameMetadata(left.metadata, right.metadata);
}

export function compareSyncV7SegmentOrder(left: Pick<SyncV7SegmentDescriptor, "generation" | "ordinal">, right: Pick<SyncV7SegmentDescriptor, "generation" | "ordinal">): number {
  return left.generation - right.generation || left.ordinal - right.ordinal;
}

export const compareV7SegmentOrder = compareSyncV7SegmentOrder;

function validateSegment(value: unknown, index: number, vaultId: string): asserts value is SyncV7SegmentDescriptor {
  if (!isRecord(value)) fail(`segments[${index}] must be an object`);
  validateDescriptor(value, "segment");
  assertSafeInteger(value.generation, `segments[${index}].generation`, 0);
  assertSafeInteger(value.ordinal, `segments[${index}].ordinal`, 0);
  assertCount(value.count, `segments[${index}].count`);
  validateCursors(value.cursors, `segments[${index}].cursors`);
  validateMetadata(value.metadata, `segments[${index}].metadata`, vaultId);
}

/** Strict validation for a v7 mutable head. */
export function validateSyncHeadV7(value: unknown): asserts value is SyncHeadV7 {
  if (!isRecord(value) || value.formatVersion !== SYNC_V7_FORMAT_VERSION) fail("formatVersion must be 7");
  assertVaultId(value.vaultId, "vaultId");
  assertDate(value.generatedAt, "generatedAt");
  assertSafeInteger(value.generation, "generation", 0);
  validateMetadata(value.metadata, "metadata", value.vaultId);
  if (value.checkpoint !== null) validateDescriptor(value.checkpoint, "checkpoint");
  validateCursors(value.cursors, "cursors");
  if (!Array.isArray(value.segments)) fail("segments must be an array");
  if (value.segments.length > SYNC_V7_MAX_SEGMENT_COUNT) fail("segments exceed the bounded index limit");
  let hotBytes = 0;
  const segmentPaths = new Set<string>();
  for (let index = 0; index < value.segments.length; index += 1) {
    const segment = value.segments[index];
    validateSegment(segment, index, value.vaultId);
    if (segmentPaths.has(segment.path)) fail(`segments contains duplicate path: ${segment.path}`);
    segmentPaths.add(segment.path);
    hotBytes += segment.size;
    if (hotBytes > SYNC_V7_MAX_HOT_BYTES) fail("segments exceed the aggregate hot-window byte limit");
    if (index > 0) {
      const previous = value.segments[index - 1];
      const order = compareSyncV7SegmentOrder(previous, segment);
      if (order >= 0) fail("segments must be strictly ordered by generation then ordinal (never path/hash)");
    }
  }
  const highestGeneration = value.segments.reduce((maximum, segment) => Math.max(maximum, segment.generation), 0);
  if (highestGeneration > value.generation) fail("segment generation cannot exceed head generation");
}

export function isSyncHeadV7(value: unknown): value is SyncHeadV7 {
  try { validateSyncHeadV7(value); return true; } catch { return false; }
}

export const isSyncV7Head = isSyncHeadV7;
export const validateSyncV7Head = validateSyncHeadV7;

export function validateSyncV7Descriptor(value: unknown, kind: SyncV7DescriptorKind): asserts value is SyncV7Descriptor | SyncV7SegmentDescriptor {
  if (kind === "segment") validateSegment(value, 0, isRecord(value) && isRecord(value.metadata) && typeof value.metadata.vaultId === "string" ? value.metadata.vaultId : "");
  else validateDescriptor(value, kind);
}

function cloneDescriptor(value: SyncV7Descriptor): SyncV7Descriptor {
  return { path: value.path, blobSha: value.blobSha, sha256: value.sha256, size: value.size, ...(value.generation !== undefined ? { generation: value.generation } : {}) };
}

function cloneMetadata(value: SyncV7SegmentMetadata): SyncV7SegmentMetadata {
  return { ...value };
}

function cloneSegment(value: SyncV7SegmentDescriptor): SyncV7SegmentDescriptor {
  return { ...cloneDescriptor(value), generation: value.generation, ordinal: value.ordinal, count: value.count, cursors: { ...value.cursors }, metadata: cloneMetadata(value.metadata) };
}

/** Merge segments using only their explicit replay key. */
export function mergeSyncV7Segments(existing: readonly SyncV7SegmentDescriptor[], additions: readonly SyncV7SegmentDescriptor[], vaultId?: string): SyncV7SegmentDescriptor[] {
  const byKey = new Map<string, SyncV7SegmentDescriptor>();
  const byPath = new Map<string, SyncV7SegmentDescriptor>();
  const canonicalVaultId = vaultId ?? existing[0]?.metadata.vaultId ?? additions[0]?.metadata.vaultId;
  if (!canonicalVaultId) throw new Error("v7 segment merge requires an explicit vault identity");
  for (const segment of [...existing, ...additions]) {
    validateSegment(segment, 0, canonicalVaultId);
    const key = `${segment.generation}:${segment.ordinal}`;
    const prior = byKey.get(key);
    if (prior && !sameSyncV7Segment(prior, segment)) throw new Error(`v7 segment replay-key collision: ${key}`);
    const pathPrior = byPath.get(segment.path);
    if (pathPrior && !sameSyncV7Segment(pathPrior, segment)) throw new Error(`v7 segment path collision: ${segment.path}`);
    if (!prior) byKey.set(key, cloneSegment(segment));
    if (!pathPrior) byPath.set(segment.path, cloneSegment(segment));
  }
  const result = [...byKey.values()].sort(compareSyncV7SegmentOrder);
  if (result.length > SYNC_V7_MAX_SEGMENT_COUNT) throw new Error("v7 segments exceed the bounded index limit");
  const hotBytes = result.reduce((sum, segment) => sum + segment.size, 0);
  if (hotBytes > SYNC_V7_MAX_HOT_BYTES) throw new Error("v7 segments exceed the aggregate hot-window byte limit; compact explicitly first");
  return result;
}

export function appendSyncV7Segments(head: SyncHeadV7, additions: readonly SyncV7SegmentDescriptor[], generatedAt = head.generatedAt): SyncHeadV7 {
  validateSyncHeadV7(head);
  if (!ISO_DATE.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) throw new TypeError("generatedAt must be an ISO timestamp");
  for (const segment of additions) if (segment.metadata.vaultId !== head.vaultId) throw new Error("v7 segment vault identity does not match head");
  const segments = mergeSyncV7Segments(head.segments, additions, head.vaultId);
  const generation = Math.max(head.generation, segments.reduce((maximum, segment) => Math.max(maximum, segment.generation), 0));
  const next: SyncHeadV7 = { ...head, generatedAt, generation, segments, metadata: { ...head.metadata }, cursors: { ...head.cursors } };
  validateSyncHeadV7(next);
  return next;
}

export const appendSyncV7EventSegments = appendSyncV7Segments;
export const mergeSyncV7EventSegments = mergeSyncV7Segments;

/** Encode one inline event and enforce the UTF-8 byte limit. */
export function encodeSyncV7Event(event: unknown): Uint8Array {
  const json = JSON.stringify(event);
  if (json === undefined) throw new TypeError("v7 event must be JSON serializable");
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > SYNC_V7_MAX_EVENT_BYTES) throw new RangeError(`v7 event exceeds ${SYNC_V7_MAX_EVENT_BYTES} UTF-8 bytes; store its payload as an immutable ref`);
  return bytes;
}

export function encodeSyncV7Segment<T>(segment: SyncV7Segment<T>): Uint8Array {
  if (!segment || segment.formatVersion !== SYNC_V7_FORMAT_VERSION) throw new TypeError("v7 segment formatVersion must be 7");
  assertVaultId(segment.vaultId, "segment.vaultId");
  assertSafeInteger(segment.generation, "segment.generation", 0);
  assertSafeInteger(segment.ordinal, "segment.ordinal", 0);
  if (!Array.isArray(segment.events) || segment.events.length < 1 || segment.events.length > SYNC_V7_MAX_SEGMENT_EVENT_COUNT) throw new RangeError(`v7 segment must contain 1-${SYNC_V7_MAX_SEGMENT_EVENT_COUNT} events`);
  validateMetadata(segment.metadata, "segment.metadata", segment.vaultId);
  validateCursors(segment.cursors, "segment.cursors");
  for (const event of segment.events) encodeSyncV7Event(event);
  const bytes = new TextEncoder().encode(JSON.stringify(segment));
  if (bytes.byteLength > SYNC_V7_MAX_SEGMENT_BYTES) throw new RangeError(`v7 segment exceeds ${SYNC_V7_MAX_SEGMENT_BYTES} bytes`);
  return bytes;
}

export function decodeSyncV7Segment<T = unknown>(bytes: SyncV7Bytes, expected?: { vaultId?: string; generation?: number; ordinal?: number }): SyncV7Segment<T> {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(raw)) as unknown; } catch { throw new Error("invalid v7 segment JSON"); }
  if (!isRecord(value) || value.formatVersion !== SYNC_V7_FORMAT_VERSION || !Array.isArray(value.events)) throw new Error("invalid v7 segment envelope");
  const segment = value as unknown as SyncV7Segment<T>;
  if (expected?.vaultId !== undefined && segment.vaultId !== expected.vaultId) throw new Error("v7 segment vault identity mismatch");
  if (expected?.generation !== undefined && segment.generation !== expected.generation) throw new Error("v7 segment generation mismatch");
  if (expected?.ordinal !== undefined && segment.ordinal !== expected.ordinal) throw new Error("v7 segment ordinal mismatch");
  encodeSyncV7Segment(segment);
  return segment;
}

/** Paginate by encoded UTF-8 bytes, not JavaScript string length or page count. */
export function paginateSyncV7Events<T>(events: readonly T[]): Array<{ events: T[]; bytes: Uint8Array; size: number; count: number }> {
  const result: Array<{ events: T[]; bytes: Uint8Array; size: number; count: number }> = [];
  let current: T[] = [];
  for (const event of events) {
    encodeSyncV7Event(event);
    const candidate = [...current, event];
    let tooLarge = candidate.length > SYNC_V7_MAX_SEGMENT_EVENT_COUNT;
    if (!tooLarge && current.length > 0) {
      try { tooLarge = encodeSyncV7Segment({ formatVersion: 7, vaultId: "v7-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v7-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: candidate }).byteLength > SYNC_V7_MAX_SEGMENT_BYTES; } catch { tooLarge = true; }
    }
    if (tooLarge) {
      const bytes = encodeSyncV7Segment({ formatVersion: 7, vaultId: "v7-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v7-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: current });
      result.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
      current = [event];
      encodeSyncV7Segment({ formatVersion: 7, vaultId: "v7-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v7-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: current });
    } else current = candidate;
  }
  if (current.length > 0) {
    const bytes = encodeSyncV7Segment({ formatVersion: 7, vaultId: "v7-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v7-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: current });
    result.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
  }
  return result;
}

export const partitionSyncV7Events = paginateSyncV7Events;
export const encodeSyncV7EventSegment = encodeSyncV7Segment;
export const decodeSyncV7EventSegment = decodeSyncV7Segment;

/** Deterministic replay: generation first, ordinal second; never path/hash. */
export function orderSyncV7Segments<T>(segments: readonly SyncV7ReplaySegment<T>[]): SyncV7ReplaySegment<T>[] {
  const copy = segments.map((segment) => ({ ...segment, events: [...segment.events] }));
  for (const segment of copy) {
    assertSafeInteger(segment.generation, "replay segment generation", 0);
    assertSafeInteger(segment.ordinal, "replay segment ordinal", 0);
  }
  copy.sort(compareSyncV7SegmentOrder);
  for (let index = 1; index < copy.length; index += 1) {
    if (compareSyncV7SegmentOrder(copy[index - 1], copy[index]) === 0) throw new Error("v7 replay contains duplicate generation/ordinal");
  }
  return copy;
}

export function replaySyncV7Segments<T>(segments: readonly SyncV7ReplaySegment<T>[]): T[];
export function replaySyncV7Segments<T, State>(segments: readonly SyncV7ReplaySegment<T>[], initial: State, apply: (state: State, event: T, segment: SyncV7ReplaySegment<T>) => State): State;
export function replaySyncV7Segments<T, State>(segments: readonly SyncV7ReplaySegment<T>[], initial?: State, apply?: (state: State, event: T, segment: SyncV7ReplaySegment<T>) => State): T[] | State {
  const ordered = orderSyncV7Segments(segments);
  if (!apply) return ordered.flatMap((segment) => segment.events);
  let state = initial as State;
  for (const segment of ordered) for (const event of segment.events) state = apply(state, event, segment);
  return state;
}

export const replayV7Segments = replaySyncV7Segments;

/** Compute checkpoint eligibility from actual aggregate bytes only. */
export function planSyncV7Compaction(input: { head?: SyncHeadV7 | null; hotSegments?: readonly Pick<SyncV7SegmentDescriptor, "size">[]; hotBytes?: number }): SyncV7CompactionPlan {
  const segments = input.hotSegments ?? [];
  const hotBytes = input.hotBytes ?? segments.reduce((sum, segment) => sum + segment.size, 0);
  if (!Number.isSafeInteger(hotBytes) || hotBytes < 0) throw new TypeError("v7 hotBytes must be a non-negative safe integer");
  const initialization = !input.head || input.head.checkpoint === null;
  const overflow = hotBytes > SYNC_V7_MAX_HOT_BYTES;
  const required = initialization || overflow;
  return { required, reason: initialization ? "initialization" : overflow ? "hot-window-overflow" : "none", hotBytes, segmentCount: segments.length, checkpointAllowed: required };
}

export const decideSyncV7Compaction = planSyncV7Compaction;
export const createSyncV7CompactionPlan = planSyncV7Compaction;
export const createSyncV7CompactionDecision = planSyncV7Compaction;

function assertExpectedHeadSha(value: string | undefined): void {
  if (value !== undefined && !SHA1.test(value)) throw new TypeError("expectedHeadSha must be a Git SHA-1 blob id");
}

function validatePublicationFiles(files: readonly SyncV7PublicationFile[], kind: SyncV7DescriptorKind): SyncV7PublicationFile[] {
  return files.map((file) => {
    if (!file || typeof file.path !== "string") throw new TypeError("v7 publication file path is required");
    assertSyncV7Path(file.path, file.kind ?? kind);
    if ((file.kind ?? kind) !== kind) throw new TypeError(`v7 publication file kind must be ${kind}`);
    return { path: file.path, bytes: file.bytes, kind: file.kind ?? kind, ...(file.uploaded ? { uploaded: true } : {}) };
  });
}

function descriptorEqualNullable(left: SyncV7Descriptor | null, right: SyncV7Descriptor | null): boolean {
  if (left === null || right === null) return left === right;
  return sameSyncV7Descriptor(left, right);
}

function assertCompactionPlan(value: SyncV7CompactionPlan): void {
  if (!value || !Number.isSafeInteger(value.hotBytes) || value.hotBytes < 0 || !Number.isSafeInteger(value.segmentCount) || value.segmentCount < 0) throw new TypeError("invalid v7 compaction plan");
  if (!value.required || !value.checkpointAllowed || (value.reason !== "initialization" && value.reason !== "hot-window-overflow")) throw new Error("v7 checkpoint publication requires an explicit initialization or byte-overflow compaction plan");
  if (value.reason === "hot-window-overflow" && value.hotBytes <= SYNC_V7_MAX_HOT_BYTES) throw new Error("v7 hot-window-overflow compaction requires aggregate bytes above the threshold");
}

/** Build an ordinary append plan. It categorically cannot upload a checkpoint. */
export function createSyncV7AppendPublicationPlan(input: SyncV7AppendPublicationInput): SyncV7PublicationPlan {
  validateSyncHeadV7(input.expectedHead);
  validateSyncHeadV7(input.head);
  if (input.head.vaultId !== input.expectedHead.vaultId) throw new Error("v7 append vault identity mismatch");
  if (input.expectedHead.checkpoint === null) throw new Error("uninitialized v7 vault requires an explicit initialization checkpoint");
  if (!descriptorEqualNullable(input.head.checkpoint, input.expectedHead.checkpoint)) throw new Error("ordinary v7 append cannot change the checkpoint");
  const objects = validatePublicationFiles(input.objects ?? [], "object");
  const segments = validatePublicationFiles(input.segments ?? [], "segment");
  assertExpectedHeadSha(input.expectedHeadSha);
  return { objects, segments, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["objects", "segments", "head-cas"], mode: "append" };
}

export const createSyncV7AppendPlan = createSyncV7AppendPublicationPlan;

/**
 * Build either an append or explicit compaction publication. A checkpoint is
 * accepted only when the caller supplies a required compaction plan (initial
 * creation or byte-window overflow).
 */
export function createSyncV7PublicationPlan(input: {
  head: SyncHeadV7;
  expectedHead?: SyncHeadV7;
  expectedHeadSha?: string;
  objects?: readonly SyncV7PublicationFile[];
  segments?: readonly SyncV7PublicationFile[];
  checkpoint?: SyncV7PublicationFile;
  compaction?: SyncV7CompactionPlan;
}): SyncV7PublicationPlan {
  validateSyncHeadV7(input.head);
  if (input.expectedHead) {
    validateSyncHeadV7(input.expectedHead);
    if (input.head.vaultId !== input.expectedHead.vaultId) throw new Error("v7 publication vault identity mismatch");
    const changedCheckpoint = !descriptorEqualNullable(input.head.checkpoint, input.expectedHead.checkpoint);
    if (!changedCheckpoint) {
      if (input.checkpoint) throw new Error("ordinary v7 append cannot upload a checkpoint");
      return createSyncV7AppendPublicationPlan({ expectedHead: input.expectedHead, head: input.head, objects: input.objects, segments: input.segments, expectedHeadSha: input.expectedHeadSha });
    }
    if (!input.checkpoint) throw new Error("changing the v7 checkpoint requires an explicit checkpoint publication");
    if (!input.compaction) throw new Error("v7 checkpoint upload requires explicit initialization or hot-window-overflow compaction");
    assertCompactionPlan(input.compaction);
    const checkpoint = validatePublicationFiles([input.checkpoint], "checkpoint")[0];
    if (input.head.checkpoint === null || input.head.checkpoint.path !== checkpoint.path) throw new Error("head checkpoint descriptor does not match checkpoint publication");
    const objects = validatePublicationFiles(input.objects ?? [], "object");
    const segments = validatePublicationFiles(input.segments ?? [], "segment");
    assertExpectedHeadSha(input.expectedHeadSha);
    return { objects, segments, checkpoint, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["checkpoint", "objects", "segments", "head-cas"], mode: "compaction" };
  }
  const objects = validatePublicationFiles(input.objects ?? [], "object");
  const segments = validatePublicationFiles(input.segments ?? [], "segment");
  assertExpectedHeadSha(input.expectedHeadSha);
  if (!input.checkpoint) {
    if (input.head.checkpoint === null) throw new Error("uninitialized v7 vault requires an explicit initialization checkpoint");
    if (input.compaction?.required) throw new Error("required v7 compaction plan must include a checkpoint publication");
    return { objects, segments, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["objects", "segments", "head-cas"], mode: "append" };
  }
  if (!input.compaction) throw new Error("v7 checkpoint upload requires explicit initialization or hot-window-overflow compaction");
  assertCompactionPlan(input.compaction);
  const checkpoint = validatePublicationFiles([input.checkpoint], "checkpoint")[0];
  if (input.head.checkpoint === null) throw new Error("compaction head must name the newly published checkpoint");
  if (!input.head.checkpoint.path || input.head.checkpoint.path !== checkpoint.path) throw new Error("head checkpoint descriptor does not match checkpoint publication");
  return { objects, segments, checkpoint, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["checkpoint", "objects", "segments", "head-cas"], mode: "compaction" };
}

export function createSyncV7ObjectRef(path: string, sha256: string, size: number, kind: "object" | "asset" = "object", blobSha?: string): SyncV7ImmutableRef {
  assertSyncV7Path(path, kind);
  assertSha(sha256, "object ref sha256", SHA256);
  const pathHash = digestFromPath(path);
  if (pathHash && pathHash !== sha256) throw new Error("object ref path digest must equal sha256");
  assertSize(size, "object ref size", SYNC_V7_MAX_DESCRIPTOR_BYTES);
  if (blobSha !== undefined) assertSha(blobSha, "object ref blobSha", SHA1);
  return { path, sha256, size, kind, ...(blobSha ? { blobSha } : {}) };
}

export const createSyncV7BlobRef = createSyncV7ObjectRef;
