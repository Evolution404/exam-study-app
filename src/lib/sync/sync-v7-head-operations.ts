import {
  SYNC_V9_FORMAT_VERSION, SYNC_V7_MAX_DESCRIPTOR_BYTES, SYNC_V7_MAX_EVENT_BYTES, SYNC_V7_MAX_HOT_BYTES, SYNC_V7_MAX_SEGMENT_BYTES,
  SYNC_V7_MAX_SEGMENT_COUNT, SYNC_V7_MAX_SEGMENT_EVENT_COUNT,
  type SyncHeadV7, type SyncV7AppendPublicationInput, type SyncV7Bytes, type SyncV7CompactionPlan, type SyncV7Descriptor,
  type SyncV7DescriptorKind, type SyncV7ImmutableRef, type SyncV7PublicationFile, type SyncV7PublicationPlan, type SyncV7ReplaySegment,
  type SyncV7Segment, type SyncV7SegmentDescriptor, type SyncV7SegmentMetadata,
} from "./sync-v7-head-types";
import {
  ISO_DATE, SHA1, SHA256, assertSha, assertSafeInteger, assertSize, assertSyncV7Path, assertVaultId, compareSyncV7SegmentOrder,
  digestFromPath, isRecord, sameSyncV7Descriptor, sameSyncV7Segment, validateCursors, validateMetadata, validateSegment, validateSyncHeadV7,
} from "./sync-v7-head-validation";

function cloneDescriptor(value: SyncV7Descriptor): SyncV7Descriptor {
  return { path: value.path, blobSha: value.blobSha, sha256: value.sha256, size: value.size, ...(value.storedSize !== undefined ? { storedSize: value.storedSize } : {}), ...(value.generation !== undefined ? { generation: value.generation } : {}) };
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
  if (!canonicalVaultId) throw new Error("v9 segment merge requires an explicit vault identity");
  for (const segment of [...existing, ...additions]) {
    validateSegment(segment, 0, canonicalVaultId);
    const key = `${segment.generation}:${segment.ordinal}`;
    const prior = byKey.get(key);
    if (prior && !sameSyncV7Segment(prior, segment)) throw new Error(`v9 segment replay-key collision: ${key}`);
    const pathPrior = byPath.get(segment.path);
    if (pathPrior && !sameSyncV7Segment(pathPrior, segment)) throw new Error(`v9 segment path collision: ${segment.path}`);
    if (!prior) byKey.set(key, cloneSegment(segment));
    if (!pathPrior) byPath.set(segment.path, cloneSegment(segment));
  }
  const result = [...byKey.values()].sort(compareSyncV7SegmentOrder);
  if (result.length > SYNC_V7_MAX_SEGMENT_COUNT) throw new Error("v9 segments exceed the bounded index limit");
  const hotBytes = result.reduce((sum, segment) => sum + segment.size, 0);
  if (hotBytes > SYNC_V7_MAX_HOT_BYTES) throw new Error("v9 segments exceed the aggregate hot-window byte limit; compact explicitly first");
  return result;
}

export function appendSyncV7Segments(head: SyncHeadV7, additions: readonly SyncV7SegmentDescriptor[], generatedAt = head.generatedAt): SyncHeadV7 {
  validateSyncHeadV7(head);
  if (!ISO_DATE.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) throw new TypeError("generatedAt must be an ISO timestamp");
  for (const segment of additions) if (segment.metadata.vaultId !== head.vaultId) throw new Error("v9 segment vault identity does not match head");
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
  if (json === undefined) throw new TypeError("v9 event must be JSON serializable");
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > SYNC_V7_MAX_EVENT_BYTES) throw new RangeError(`v9 event exceeds ${SYNC_V7_MAX_EVENT_BYTES} UTF-8 bytes; store its payload as an immutable ref`);
  return bytes;
}

export function encodeSyncV7Segment<T>(segment: SyncV7Segment<T>): Uint8Array {
  if (!segment || segment.formatVersion !== SYNC_V9_FORMAT_VERSION) throw new TypeError("v9 segment formatVersion must be 9");
  assertVaultId(segment.vaultId, "segment.vaultId");
  assertSafeInteger(segment.generation, "segment.generation", 0);
  assertSafeInteger(segment.ordinal, "segment.ordinal", 0);
  if (!Array.isArray(segment.events) || segment.events.length < 1 || segment.events.length > SYNC_V7_MAX_SEGMENT_EVENT_COUNT) throw new RangeError(`v9 segment must contain 1-${SYNC_V7_MAX_SEGMENT_EVENT_COUNT} events`);
  validateMetadata(segment.metadata, "segment.metadata", segment.vaultId);
  validateCursors(segment.cursors, "segment.cursors");
  for (const event of segment.events) encodeSyncV7Event(event);
  const bytes = new TextEncoder().encode(JSON.stringify(segment));
  if (bytes.byteLength > SYNC_V7_MAX_SEGMENT_BYTES) throw new RangeError(`v9 segment exceeds ${SYNC_V7_MAX_SEGMENT_BYTES} bytes`);
  return bytes;
}

export function decodeSyncV7Segment<T = unknown>(bytes: SyncV7Bytes, expected?: { vaultId?: string; generation?: number; ordinal?: number }): SyncV7Segment<T> {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(raw)) as unknown; } catch { throw new Error("invalid v9 segment JSON"); }
  if (!isRecord(value) || value.formatVersion !== SYNC_V9_FORMAT_VERSION || !Array.isArray(value.events)) throw new Error("invalid v9 segment envelope");
  const segment = value as unknown as SyncV7Segment<T>;
  if (expected?.vaultId !== undefined && segment.vaultId !== expected.vaultId) throw new Error("v9 segment vault identity mismatch");
  if (expected?.generation !== undefined && segment.generation !== expected.generation) throw new Error("v9 segment generation mismatch");
  if (expected?.ordinal !== undefined && segment.ordinal !== expected.ordinal) throw new Error("v9 segment ordinal mismatch");
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
      try { tooLarge = encodeSyncV7Segment({ formatVersion: 9, vaultId: "v9-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v9-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: candidate }).byteLength > SYNC_V7_MAX_SEGMENT_BYTES; } catch { tooLarge = true; }
    }
    if (tooLarge) {
      const bytes = encodeSyncV7Segment({ formatVersion: 9, vaultId: "v9-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v9-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: current });
      result.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
      current = [event];
      encodeSyncV7Segment({ formatVersion: 9, vaultId: "v9-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v9-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: current });
    } else current = candidate;
  }
  if (current.length > 0) {
    const bytes = encodeSyncV7Segment({ formatVersion: 9, vaultId: "v9-pagination", generation: 0, ordinal: 0, metadata: { vaultId: "v9-pagination", createdAt: "2026-01-01T00:00:00.000Z" }, cursors: {}, events: current });
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
    if (compareSyncV7SegmentOrder(copy[index - 1], copy[index]) === 0) throw new Error("v9 replay contains duplicate generation/ordinal");
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
  const segments = input.hotSegments ?? (input.hotBytes === undefined ? input.head?.segments ?? [] : []);
  const hotBytes = input.hotBytes ?? segments.reduce((sum, segment) => sum + segment.size, 0);
  if (!Number.isSafeInteger(hotBytes) || hotBytes < 0) throw new TypeError("v9 hotBytes must be a non-negative safe integer");
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
    if (!file || typeof file.path !== "string") throw new TypeError("v9 publication file path is required");
    assertSyncV7Path(file.path, file.kind ?? kind);
    if ((file.kind ?? kind) !== kind) throw new TypeError(`v9 publication file kind must be ${kind}`);
    return { path: file.path, bytes: file.bytes, kind: file.kind ?? kind, ...(file.uploaded ? { uploaded: true } : {}) };
  });
}

function descriptorEqualNullable(left: SyncV7Descriptor | null, right: SyncV7Descriptor | null): boolean {
  if (left === null || right === null) return left === right;
  return sameSyncV7Descriptor(left, right);
}

function assertCompactionPlan(value: SyncV7CompactionPlan): void {
  if (!value || !Number.isSafeInteger(value.hotBytes) || value.hotBytes < 0 || !Number.isSafeInteger(value.segmentCount) || value.segmentCount < 0) throw new TypeError("invalid v9 compaction plan");
  if (!value.required || !value.checkpointAllowed || (value.reason !== "initialization" && value.reason !== "hot-window-overflow")) throw new Error("v9 checkpoint publication requires an explicit initialization or byte-overflow compaction plan");
  if (value.reason === "hot-window-overflow" && value.hotBytes <= SYNC_V7_MAX_HOT_BYTES) throw new Error("v9 hot-window-overflow compaction requires aggregate bytes above the threshold");
}

/** Build an ordinary append plan. It categorically cannot upload a checkpoint. */
export function createSyncV7AppendPublicationPlan(input: SyncV7AppendPublicationInput): SyncV7PublicationPlan {
  validateSyncHeadV7(input.expectedHead);
  validateSyncHeadV7(input.head);
  if (input.head.vaultId !== input.expectedHead.vaultId) throw new Error("v9 append vault identity mismatch");
  if (input.expectedHead.checkpoint === null) throw new Error("uninitialized v9 vault requires an explicit initialization checkpoint");
  if (!descriptorEqualNullable(input.head.checkpoint, input.expectedHead.checkpoint)) throw new Error("ordinary v9 append cannot change the checkpoint");
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
    if (input.head.vaultId !== input.expectedHead.vaultId) throw new Error("v9 publication vault identity mismatch");
    const changedCheckpoint = !descriptorEqualNullable(input.head.checkpoint, input.expectedHead.checkpoint);
    if (!changedCheckpoint) {
      if (input.checkpoint) throw new Error("ordinary v9 append cannot upload a checkpoint");
      return createSyncV7AppendPublicationPlan({ expectedHead: input.expectedHead, head: input.head, objects: input.objects, segments: input.segments, expectedHeadSha: input.expectedHeadSha });
    }
    if (!input.checkpoint) throw new Error("changing the v9 checkpoint requires an explicit checkpoint publication");
    if (!input.compaction) throw new Error("v9 checkpoint upload requires explicit initialization or hot-window-overflow compaction");
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
    if (input.head.checkpoint === null) throw new Error("uninitialized v9 vault requires an explicit initialization checkpoint");
    if (input.compaction?.required) throw new Error("required v9 compaction plan must include a checkpoint publication");
    return { objects, segments, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["objects", "segments", "head-cas"], mode: "append" };
  }
  if (!input.compaction) throw new Error("v9 checkpoint upload requires explicit initialization or hot-window-overflow compaction");
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
