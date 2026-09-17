import {
  SYNC_FORMAT_VERSION, SYNC_MAX_DESCRIPTOR_BYTES, SYNC_MAX_EVENT_BYTES, SYNC_MAX_HOT_BYTES, SYNC_MAX_SEGMENT_BYTES,
  SYNC_MAX_SEGMENT_COUNT, SYNC_MAX_SEGMENT_EVENT_COUNT,
  type SyncHead, type SyncAppendPublicationInput, type SyncBytes, type SyncCompactionPlan, type SyncDescriptor,
  type SyncDescriptorKind, type SyncImmutableRef, type SyncPublicationFile, type SyncPublicationPlan, type SyncReplaySegment,
  type SyncSegment, type SyncSegmentDescriptor, type SyncSegmentMetadata,
} from "./sync-head-types";
import {
  ISO_DATE, SHA1, SHA256, assertSha, assertSafeInteger, assertSize, assertSyncPath, assertVaultId, compareSyncSegmentOrder,
  digestFromPath, isRecord, sameSyncDescriptor, sameSyncSegment, validateCursors, validateMetadata, validateSegment, validateSyncHead,
} from "./sync-head-validation";

function cloneDescriptor(value: SyncDescriptor): SyncDescriptor {
  return { path: value.path, blobSha: value.blobSha, sha256: value.sha256, size: value.size, storedSize: value.storedSize, ...(value.generation !== undefined ? { generation: value.generation } : {}) };
}

function cloneMetadata(value: SyncSegmentMetadata): SyncSegmentMetadata {
  return { ...value };
}

function cloneSegment(value: SyncSegmentDescriptor): SyncSegmentDescriptor {
  return { ...cloneDescriptor(value), generation: value.generation, ordinal: value.ordinal, count: value.count, cursors: { ...value.cursors }, metadata: cloneMetadata(value.metadata) };
}

/** Merge segments using only their explicit replay key. */
export function mergeSyncSegments(existing: readonly SyncSegmentDescriptor[], additions: readonly SyncSegmentDescriptor[], vaultId?: string): SyncSegmentDescriptor[] {
  const byKey = new Map<string, SyncSegmentDescriptor>();
  const byPath = new Map<string, SyncSegmentDescriptor>();
  const canonicalVaultId = vaultId ?? existing[0]?.metadata.vaultId ?? additions[0]?.metadata.vaultId;
  if (!canonicalVaultId) throw new Error("segment merge requires an explicit vault identity");
  for (const segment of [...existing, ...additions]) {
    validateSegment(segment, 0, canonicalVaultId);
    const key = `${segment.generation}:${segment.ordinal}`;
    const prior = byKey.get(key);
    if (prior && !sameSyncSegment(prior, segment)) throw new Error(`segment replay-key collision: ${key}`);
    const pathPrior = byPath.get(segment.path);
    if (pathPrior && !sameSyncSegment(pathPrior, segment)) throw new Error(`segment path collision: ${segment.path}`);
    if (!prior) byKey.set(key, cloneSegment(segment));
    if (!pathPrior) byPath.set(segment.path, cloneSegment(segment));
  }
  const result = [...byKey.values()].sort(compareSyncSegmentOrder);
  if (result.length > SYNC_MAX_SEGMENT_COUNT) throw new Error("segments exceed the bounded index limit");
  const hotBytes = result.reduce((sum, segment) => sum + segment.size, 0);
  if (hotBytes > SYNC_MAX_HOT_BYTES) throw new Error("segments exceed the aggregate hot-window byte limit; compact explicitly first");
  return result;
}

export function appendSyncSegments(head: SyncHead, additions: readonly SyncSegmentDescriptor[], generatedAt = head.generatedAt): SyncHead {
  validateSyncHead(head);
  if (!ISO_DATE.test(generatedAt) || Number.isNaN(Date.parse(generatedAt))) throw new TypeError("generatedAt must be an ISO timestamp");
  for (const segment of additions) if (segment.metadata.vaultId !== head.vaultId) throw new Error("segment vault identity does not match head");
  const segments = mergeSyncSegments(head.segments, additions, head.vaultId);
  const generation = Math.max(head.generation, segments.reduce((maximum, segment) => Math.max(maximum, segment.generation), 0));
  const next: SyncHead = { ...head, generatedAt, generation, segments, metadata: { ...head.metadata }, cursors: { ...head.cursors } };
  validateSyncHead(next);
  return next;
}

export const appendSyncEventSegments = appendSyncSegments;
export const mergeSyncEventSegments = mergeSyncSegments;

/** Encode one inline event and enforce the UTF-8 byte limit. */
export function encodeSyncEvent(event: unknown): Uint8Array {
  const json = JSON.stringify(event);
  if (json === undefined) throw new TypeError("event must be JSON serializable");
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > SYNC_MAX_EVENT_BYTES) throw new RangeError(`event exceeds ${SYNC_MAX_EVENT_BYTES} UTF-8 bytes; store its payload as an immutable ref`);
  return bytes;
}

export function encodeSyncSegment<T>(segment: SyncSegment<T>): Uint8Array {
  if (!segment || segment.formatVersion !== SYNC_FORMAT_VERSION) throw new TypeError(`segment formatVersion must be ${SYNC_FORMAT_VERSION}`);
  assertVaultId(segment.vaultId, "segment.vaultId");
  assertSafeInteger(segment.generation, "segment.generation", 0);
  assertSafeInteger(segment.ordinal, "segment.ordinal", 0);
  if (!Array.isArray(segment.events) || segment.events.length < 1 || segment.events.length > SYNC_MAX_SEGMENT_EVENT_COUNT) throw new RangeError(`segment must contain 1-${SYNC_MAX_SEGMENT_EVENT_COUNT} events`);
  validateMetadata(segment.metadata, "segment.metadata", segment.vaultId);
  validateCursors(segment.cursors, "segment.cursors");
  for (const event of segment.events) encodeSyncEvent(event);
  const bytes = new TextEncoder().encode(JSON.stringify(segment));
  if (bytes.byteLength > SYNC_MAX_SEGMENT_BYTES) throw new RangeError(`segment exceeds ${SYNC_MAX_SEGMENT_BYTES} bytes`);
  return bytes;
}

export function decodeSyncSegment<T = unknown>(bytes: SyncBytes, expected?: { vaultId?: string; generation?: number; ordinal?: number }): SyncSegment<T> {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(raw)) as unknown; } catch { throw new Error("invalid segment JSON"); }
  if (!isRecord(value) || value.formatVersion !== SYNC_FORMAT_VERSION || !Array.isArray(value.events)) throw new Error("invalid segment envelope");
  const segment = value as unknown as SyncSegment<T>;
  if (expected?.vaultId !== undefined && segment.vaultId !== expected.vaultId) throw new Error("segment vault identity mismatch");
  if (expected?.generation !== undefined && segment.generation !== expected.generation) throw new Error("segment generation mismatch");
  if (expected?.ordinal !== undefined && segment.ordinal !== expected.ordinal) throw new Error("segment ordinal mismatch");
  encodeSyncSegment(segment);
  return segment;
}

function paginationSegment<T>(events: T[]): SyncSegment<T> {
  const vaultId = "sync-pagination";
  return {
    formatVersion: SYNC_FORMAT_VERSION,
    vaultId,
    generation: 0,
    ordinal: 0,
    metadata: { vaultId, createdAt: "2026-01-01T00:00:00.000Z" },
    cursors: {},
    events,
  };
}

/** Paginate by encoded UTF-8 bytes, not JavaScript string length or page count. */
export function paginateSyncEvents<T>(events: readonly T[]): Array<{ events: T[]; bytes: Uint8Array; size: number; count: number }> {
  const result: Array<{ events: T[]; bytes: Uint8Array; size: number; count: number }> = [];
  let current: T[] = [];
  for (const event of events) {
    encodeSyncEvent(event);
    const candidate = [...current, event];
    let tooLarge = candidate.length > SYNC_MAX_SEGMENT_EVENT_COUNT;
    if (!tooLarge && current.length > 0) {
      try { tooLarge = encodeSyncSegment(paginationSegment(candidate)).byteLength > SYNC_MAX_SEGMENT_BYTES; } catch { tooLarge = true; }
    }
    if (tooLarge) {
      const bytes = encodeSyncSegment(paginationSegment(current));
      result.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
      current = [event];
      encodeSyncSegment(paginationSegment(current));
    } else current = candidate;
  }
  if (current.length > 0) {
    const bytes = encodeSyncSegment(paginationSegment(current));
    result.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
  }
  return result;
}

export const partitionSyncEvents = paginateSyncEvents;
export const encodeSyncEventSegment = encodeSyncSegment;
export const decodeSyncEventSegment = decodeSyncSegment;

/** Deterministic replay: generation first, ordinal second; never path/hash. */
export function orderSyncSegments<T>(segments: readonly SyncReplaySegment<T>[]): SyncReplaySegment<T>[] {
  const copy = segments.map((segment) => ({ ...segment, events: [...segment.events] }));
  for (const segment of copy) {
    assertSafeInteger(segment.generation, "replay segment generation", 0);
    assertSafeInteger(segment.ordinal, "replay segment ordinal", 0);
  }
  copy.sort(compareSyncSegmentOrder);
  for (let index = 1; index < copy.length; index += 1) {
    if (compareSyncSegmentOrder(copy[index - 1], copy[index]) === 0) throw new Error("replay contains duplicate generation/ordinal");
  }
  return copy;
}

export function replaySyncSegments<T>(segments: readonly SyncReplaySegment<T>[]): T[];
export function replaySyncSegments<T, State>(segments: readonly SyncReplaySegment<T>[], initial: State, apply: (state: State, event: T, segment: SyncReplaySegment<T>) => State): State;
export function replaySyncSegments<T, State>(segments: readonly SyncReplaySegment<T>[], initial?: State, apply?: (state: State, event: T, segment: SyncReplaySegment<T>) => State): T[] | State {
  const ordered = orderSyncSegments(segments);
  if (!apply) return ordered.flatMap((segment) => segment.events);
  let state = initial as State;
  for (const segment of ordered) for (const event of segment.events) state = apply(state, event, segment);
  return state;
}

export const replaySegments = replaySyncSegments;

/** Compute checkpoint eligibility from actual aggregate bytes only. */
export function planSyncCompaction(input: { head?: SyncHead | null; hotSegments?: readonly Pick<SyncSegmentDescriptor, "size">[]; hotBytes?: number }): SyncCompactionPlan {
  const segments = input.hotSegments ?? (input.hotBytes === undefined ? input.head?.segments ?? [] : []);
  const hotBytes = input.hotBytes ?? segments.reduce((sum, segment) => sum + segment.size, 0);
  if (!Number.isSafeInteger(hotBytes) || hotBytes < 0) throw new TypeError("hotBytes must be a non-negative safe integer");
  const initialization = !input.head || input.head.checkpoint === null;
  const overflow = hotBytes > SYNC_MAX_HOT_BYTES;
  const required = initialization || overflow;
  return { required, reason: initialization ? "initialization" : overflow ? "hot-window-overflow" : "none", hotBytes, segmentCount: segments.length, checkpointAllowed: required };
}

export const decideSyncCompaction = planSyncCompaction;
export const createSyncCompactionPlan = planSyncCompaction;
export const createSyncCompactionDecision = planSyncCompaction;

function assertExpectedHeadSha(value: string | undefined): void {
  if (value !== undefined && !SHA1.test(value)) throw new TypeError("expectedHeadSha must be a Git SHA-1 blob id");
}

function validatePublicationFiles(files: readonly SyncPublicationFile[], kind: SyncDescriptorKind): SyncPublicationFile[] {
  return files.map((file) => {
    if (!file || typeof file.path !== "string") throw new TypeError("publication file path is required");
    assertSyncPath(file.path, file.kind ?? kind);
    if ((file.kind ?? kind) !== kind) throw new TypeError(`publication file kind must be ${kind}`);
    return { path: file.path, bytes: file.bytes, kind: file.kind ?? kind, ...(file.uploaded ? { uploaded: true } : {}) };
  });
}

function descriptorEqualNullable(left: SyncDescriptor | null, right: SyncDescriptor | null): boolean {
  if (left === null || right === null) return left === right;
  return sameSyncDescriptor(left, right);
}

function assertCompactionPlan(value: SyncCompactionPlan): void {
  if (!value || !Number.isSafeInteger(value.hotBytes) || value.hotBytes < 0 || !Number.isSafeInteger(value.segmentCount) || value.segmentCount < 0) throw new TypeError("invalid compaction plan");
  if (!value.required || !value.checkpointAllowed || (value.reason !== "initialization" && value.reason !== "hot-window-overflow")) throw new Error("checkpoint publication requires an explicit initialization or byte-overflow compaction plan");
  if (value.reason === "hot-window-overflow" && value.hotBytes <= SYNC_MAX_HOT_BYTES) throw new Error("hot-window-overflow compaction requires aggregate bytes above the threshold");
}

/** Build an ordinary append plan. It categorically cannot upload a checkpoint. */
export function createSyncAppendPublicationPlan(input: SyncAppendPublicationInput): SyncPublicationPlan {
  validateSyncHead(input.expectedHead);
  validateSyncHead(input.head);
  if (input.head.vaultId !== input.expectedHead.vaultId) throw new Error("append vault identity mismatch");
  if (input.expectedHead.checkpoint === null) throw new Error("uninitialized vault requires an explicit initialization checkpoint");
  if (!descriptorEqualNullable(input.head.checkpoint, input.expectedHead.checkpoint)) throw new Error("ordinary append cannot change the checkpoint");
  const objects = validatePublicationFiles(input.objects ?? [], "object");
  const segments = validatePublicationFiles(input.segments ?? [], "segment");
  assertExpectedHeadSha(input.expectedHeadSha);
  return { objects, segments, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["objects", "segments", "head-cas"], mode: "append" };
}

export const createSyncAppendPlan = createSyncAppendPublicationPlan;

/** Build either an append or explicit compaction publication. */
export function createSyncPublicationPlan(input: {
  head: SyncHead;
  expectedHead?: SyncHead;
  expectedHeadSha?: string;
  objects?: readonly SyncPublicationFile[];
  segments?: readonly SyncPublicationFile[];
  checkpoint?: SyncPublicationFile;
  compaction?: SyncCompactionPlan;
}): SyncPublicationPlan {
  validateSyncHead(input.head);
  if (input.expectedHead) {
    validateSyncHead(input.expectedHead);
    if (input.head.vaultId !== input.expectedHead.vaultId) throw new Error("publication vault identity mismatch");
    const changedCheckpoint = !descriptorEqualNullable(input.head.checkpoint, input.expectedHead.checkpoint);
    if (!changedCheckpoint) {
      if (input.checkpoint) throw new Error("ordinary append cannot upload a checkpoint");
      return createSyncAppendPublicationPlan({ expectedHead: input.expectedHead, head: input.head, objects: input.objects, segments: input.segments, expectedHeadSha: input.expectedHeadSha });
    }
    if (!input.checkpoint) throw new Error("changing the checkpoint requires an explicit checkpoint publication");
    if (!input.compaction) throw new Error("checkpoint upload requires explicit initialization or hot-window-overflow compaction");
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
    if (input.head.checkpoint === null) throw new Error("uninitialized vault requires an explicit initialization checkpoint");
    if (input.compaction?.required) throw new Error("required compaction plan must include a checkpoint publication");
    return { objects, segments, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["objects", "segments", "head-cas"], mode: "append" };
  }
  if (!input.compaction) throw new Error("checkpoint upload requires explicit initialization or hot-window-overflow compaction");
  assertCompactionPlan(input.compaction);
  const checkpoint = validatePublicationFiles([input.checkpoint], "checkpoint")[0];
  if (input.head.checkpoint === null) throw new Error("compaction head must name the newly published checkpoint");
  if (!input.head.checkpoint.path || input.head.checkpoint.path !== checkpoint.path) throw new Error("head checkpoint descriptor does not match checkpoint publication");
  return { objects, segments, checkpoint, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["checkpoint", "objects", "segments", "head-cas"], mode: "compaction" };
}

export function createSyncObjectRef(path: string, sha256: string, size: number, kind: "object" | "asset" = "object", blobSha?: string): SyncImmutableRef {
  assertSyncPath(path, kind);
  assertSha(sha256, "object ref sha256", SHA256);
  const pathHash = digestFromPath(path);
  if (pathHash && pathHash !== sha256) throw new Error("object ref path digest must equal sha256");
  assertSize(size, "object ref size", SYNC_MAX_DESCRIPTOR_BYTES);
  if (blobSha !== undefined) assertSha(blobSha, "object ref blobSha", SHA1);
  return { path, sha256, size, kind, ...(blobSha ? { blobSha } : {}) };
}

export const createSyncBlobRef = createSyncObjectRef;
