import type {
  SyncEventPageDescriptorV5,
  SyncHeadDescriptorV5,
  SyncHeadV5,
} from "./types";

/** The paths owned by the v5 protocol.  The head itself is always published here. */
export const SYNC_V5_HEAD_PATH = "sync/v5/head.json";
export const SYNC_V5_MANIFEST_PATH = SYNC_V5_HEAD_PATH;
export const SYNC_V5_EVENT_PREFIX = "sync/v5/events/";
export const SYNC_V5_CHECKPOINT_PREFIX = "sync/v5/checkpoints/";
export const SYNC_V5_PRACTICE_DEFINITION_PREFIX = "sync/v5/practice-definitions/";
export const SYNC_V5_EVENT_PAYLOAD_PREFIX = "sync/v5/event-payloads/";
/**
 * Archive catalogs are immutable just like event pages and checkpoints.  A
 * catalog therefore gets a content-addressed file name instead of the old
 * mutable `archive/catalog.json` path.  The concrete constant is retained as
 * a compatibility fixture for callers that need a valid catalog path; new
 * catalogs should derive their path from their SHA-256 digest.
 */
export const SYNC_V5_ARCHIVE_CATALOG_PREFIX = "sync/v5/archive/catalogs/";
export const SYNC_V5_ARCHIVE_CATALOG_PATH = `${SYNC_V5_ARCHIVE_CATALOG_PREFIX}${"0".repeat(64)}.json`;

/**
 * Keep the hot index bounded even when a client has been offline for a long
 * time.  A page follows the v5 wire limits (250 events / 256 KiB); the head
 * can reference at most the normal four-megabyte download window.
 */
export const SYNC_V5_MAX_EVENT_PAGES = 1024;
export const SYNC_V5_MAX_EVENT_PAGE_COUNT = 250;
export const SYNC_V5_MAX_EVENT_PAGE_BYTES = 256 * 1024;
export const SYNC_V5_MAX_EVENT_BYTES = 4 * 1024 * 1024;
export const SYNC_V5_MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
export const SYNC_V5_MAX_PATH_LENGTH = 512;
export const SYNC_V5_MAX_DEVICE_CURSORS = 256;

/** A compact options object is useful to tests and future protocol clients. */
export const SYNC_V5_LIMITS = Object.freeze({
  maxEventPages: SYNC_V5_MAX_EVENT_PAGES,
  maxEventPageCount: SYNC_V5_MAX_EVENT_PAGE_COUNT,
  maxEventPageBytes: SYNC_V5_MAX_EVENT_PAGE_BYTES,
  maxEventBytes: SYNC_V5_MAX_EVENT_BYTES,
  maxDescriptorBytes: SYNC_V5_MAX_DESCRIPTOR_BYTES,
  maxPathLength: SYNC_V5_MAX_PATH_LENGTH,
  maxDeviceCursors: SYNC_V5_MAX_DEVICE_CURSORS,
});

export type SyncV5DescriptorKind = "checkpoint" | "archiveCatalog" | "eventPage" | "practiceDefinition" | "eventPayload";

export interface SyncV5AppendInput {
  /** Head read before writing the local pages (for diagnostics only). */
  expectedHead: SyncHeadV5;
  /** Head read immediately before the conditional ref update. */
  latestHead: SyncHeadV5;
  /** Pages created by this device and not yet represented by a successful head. */
  newPages: readonly SyncEventPageDescriptorV5[];
}

export interface SyncV5CompactionInput {
  /** Head from which the checkpoint/catalog were generated. */
  expectedHead: SyncHeadV5;
  /** Head read immediately before the conditional ref update. */
  latestHead: SyncHeadV5;
  /** Immutable replacement checkpoint descriptor. */
  checkpoint: SyncHeadDescriptorV5;
  /** Immutable replacement archive catalog descriptor. */
  archiveCatalog: SyncHeadDescriptorV5;
  /** Event page paths included in the replacement checkpoint/catalog. */
  includedPaths: readonly string[];
  /** Optional timestamp for the new head; latest.generatedAt is retained by default. */
  generatedAt?: string;
}

export interface SyncV5CompactionSuccess {
  ok: true;
  head: SyncHeadV5;
  removedPaths: string[];
}

export interface SyncV5CompactionConflict {
  ok: false;
  reason: "checkpoint-or-catalog-advanced";
  changed: "checkpoint" | "archiveCatalog" | "both";
}

export type SyncV5CompactionResult = SyncV5CompactionSuccess | SyncV5CompactionConflict;

/** Error thrown by the throwing compaction helper. */
export class SyncV5CompactionConflictError extends Error {
  readonly code = "checkpoint-or-catalog-advanced" as const;
  readonly changed: SyncV5CompactionConflict["changed"];

  constructor(changed: SyncV5CompactionConflict["changed"]) {
    super(`v5 compaction refused: ${changed} baseline advanced`);
    this.name = "SyncV5CompactionConflictError";
    this.changed = changed;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[\x21-\x7e]{1,128}$/;

function fail(message: string): never {
  throw new Error(`invalid v5 sync head: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SYNC_V5_MAX_PATH_LENGTH) return false;
  if (value.startsWith("/") || value.includes("\\") || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function hasPrefix(path: string, prefix: string): boolean {
  return path.startsWith(prefix) && path.length > prefix.length;
}

function assertPath(value: unknown, kind: SyncV5DescriptorKind): asserts value is string {
  if (!isSafeRelativePath(value)) fail(`${kind} path is not a safe relative path`);
  if (kind === "eventPage" && (!hasPrefix(value, SYNC_V5_EVENT_PREFIX) || !value.endsWith(".json"))) {
    fail(`event page path must be under ${SYNC_V5_EVENT_PREFIX}`);
  }
  if (kind === "checkpoint" && (!hasPrefix(value, SYNC_V5_CHECKPOINT_PREFIX) || !value.endsWith(".json"))) {
    fail(`checkpoint path must be under ${SYNC_V5_CHECKPOINT_PREFIX}`);
  }
  if (kind === "practiceDefinition" && (!hasPrefix(value, SYNC_V5_PRACTICE_DEFINITION_PREFIX) || !value.endsWith(".json"))) {
    fail(`practice definition path must be under ${SYNC_V5_PRACTICE_DEFINITION_PREFIX}`);
  }
  if (kind === "eventPayload" && (!hasPrefix(value, SYNC_V5_EVENT_PAYLOAD_PREFIX) || !value.endsWith(".json"))) {
    fail(`event payload path must be under ${SYNC_V5_EVENT_PAYLOAD_PREFIX}`);
  }
  if (kind === "archiveCatalog" && value !== SYNC_V5_ARCHIVE_CATALOG_PATH) {
    if (!new RegExp(`^${SYNC_V5_ARCHIVE_CATALOG_PREFIX}[a-f0-9]{24,64}\\.json$`).test(value)) {
      fail(`archive catalog path must be under ${SYNC_V5_ARCHIVE_CATALOG_PREFIX} with a hexadecimal digest filename`);
    }
  }
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) fail(`${field} is not an ISO timestamp`);
}

function assertDigest(value: unknown, field: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} is not a lowercase hexadecimal digest`);
}

function assertSize(value: unknown, field: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) fail(`${field} is outside its byte limit`);
}

function assertPositiveCount(value: unknown, field: string, max: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) fail(`${field} is outside its count limit`);
}

function assertCursors(value: unknown, field: string): asserts value is Record<string, number> {
  if (!isRecord(value)) fail(`${field} must be a device cursor map`);
  const entries = Object.entries(value) as Array<[string, unknown]>;
  if (entries.length === 0 || entries.length > SYNC_V5_MAX_DEVICE_CURSORS) fail(`${field} has too many (or no) devices`);
  for (const [deviceId, sequence] of entries) {
    if (!DEVICE_ID.test(deviceId) || !Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      fail(`${field} contains an invalid device cursor`);
    }
  }
}

function descriptorKey(value: Pick<SyncHeadDescriptorV5, "path" | "blobSha">): string {
  return `${value.path}\u0000${value.blobSha}`;
}

function descriptorEqual(a: SyncHeadDescriptorV5, b: SyncHeadDescriptorV5): boolean {
  return a.path === b.path && a.blobSha === b.blobSha && a.sha256 === b.sha256 && a.size === b.size;
}

function eventPageEqual(a: SyncEventPageDescriptorV5, b: SyncEventPageDescriptorV5): boolean {
  if (!descriptorEqual(a, b) || a.count !== b.count) return false;
  const aKeys = Object.keys(a.deviceCursors);
  const bKeys = Object.keys(b.deviceCursors);
  return aKeys.length === bKeys.length && aKeys.every((key) => a.deviceCursors[key] === b.deviceCursors[key]);
}

function cloneDescriptor(value: SyncHeadDescriptorV5): SyncHeadDescriptorV5 {
  return { path: value.path, blobSha: value.blobSha, sha256: value.sha256, size: value.size };
}

function clonePage(value: SyncEventPageDescriptorV5): SyncEventPageDescriptorV5 {
  return { ...cloneDescriptor(value), count: value.count, deviceCursors: { ...value.deviceCursors } };
}

function validateDescriptor(value: unknown, kind: Exclude<SyncV5DescriptorKind, "eventPage">): asserts value is SyncHeadDescriptorV5 {
  if (!isRecord(value)) fail(`${kind} descriptor must be an object`);
  assertPath(value.path, kind);
  assertDigest(value.blobSha, `${kind}.blobSha`, SHA1);
  assertDigest(value.sha256, `${kind}.sha256`, SHA256);
  assertSize(value.size, `${kind}.size`, SYNC_V5_MAX_DESCRIPTOR_BYTES);
}

function validateEventPage(value: unknown, index: number): asserts value is SyncEventPageDescriptorV5 {
  if (!isRecord(value)) fail(`eventPages[${index}] must be an object`);
  assertPath(value.path, "eventPage");
  assertDigest(value.blobSha, `eventPages[${index}].blobSha`, SHA1);
  assertDigest(value.sha256, `eventPages[${index}].sha256`, SHA256);
  assertSize(value.size, `eventPages[${index}].size`, SYNC_V5_MAX_EVENT_PAGE_BYTES);
  assertPositiveCount(value.count, `eventPages[${index}].count`, SYNC_V5_MAX_EVENT_PAGE_COUNT);
  assertCursors(value.deviceCursors, `eventPages[${index}].deviceCursors`);
}

/** Strictly validate an unknown value as a v5 hot index. */
export function validateSyncHeadV5(value: unknown): asserts value is SyncHeadV5 {
  if (!isRecord(value) || value.formatVersion !== 5) fail("formatVersion must be 5");
  assertDate(value.generatedAt, "generatedAt");
  validateDescriptor(value.checkpoint, "checkpoint");
  validateDescriptor(value.archiveCatalog, "archiveCatalog");
  if (!Array.isArray(value.eventPages)) fail("eventPages must be an array");
  if (value.eventPages.length > SYNC_V5_MAX_EVENT_PAGES) fail("eventPages exceed the bounded index limit");
  const paths = new Set<string>();
  const keys = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < value.eventPages.length; index += 1) {
    const page = value.eventPages[index];
    validateEventPage(page, index);
    if (paths.has(page.path)) fail(`eventPages contains duplicate path: ${page.path}`);
    const key = descriptorKey(page);
    if (keys.has(key)) fail(`eventPages contains duplicate descriptor: ${page.path}`);
    paths.add(page.path);
    keys.add(key);
    totalBytes += page.size;
    if (totalBytes > SYNC_V5_MAX_EVENT_BYTES) fail("eventPages exceed the aggregate byte limit");
  }
  // A canonical head is deterministic.  This also prevents two devices from
  // repeatedly publishing a different order for the same immutable pages.
  for (let index = 1; index < value.eventPages.length; index += 1) {
    if (value.eventPages[index - 1].path.localeCompare(value.eventPages[index].path) >= 0) {
      fail("eventPages must be sorted by path");
    }
  }
}

export function isSyncHeadV5(value: unknown): value is SyncHeadV5 {
  try {
    validateSyncHeadV5(value);
    return true;
  } catch {
    return false;
  }
}

/** Validate a descriptor independently before adding it to a head. */
export function validateSyncV5Descriptor(value: unknown, kind: SyncV5DescriptorKind): asserts value is SyncHeadDescriptorV5 | SyncEventPageDescriptorV5 {
  if (kind === "eventPage") validateEventPage(value, 0);
  else validateDescriptor(value, kind);
}

/** Compare immutable descriptor identity (all fields, not object identity). */
export function sameSyncV5Descriptor(a: SyncHeadDescriptorV5, b: SyncHeadDescriptorV5): boolean {
  return descriptorEqual(a, b);
}

function canonicalPages(pages: Iterable<SyncEventPageDescriptorV5>): SyncEventPageDescriptorV5[] {
  const byPath = new Map<string, SyncEventPageDescriptorV5>();
  const byKey = new Set<string>();
  for (const page of pages) {
    validateEventPage(page, 0);
    const existing = byPath.get(page.path);
    if (existing) {
      if (!eventPageEqual(existing, page)) throw new Error(`v5 event page path collision: ${page.path}`);
      continue;
    }
    const key = descriptorKey(page);
    if (byKey.has(key)) continue;
    byPath.set(page.path, clonePage(page));
    byKey.add(key);
  }
  const result = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  if (result.length > SYNC_V5_MAX_EVENT_PAGES) throw new Error("v5 event pages exceed the bounded index limit");
  const totalBytes = result.reduce((sum, page) => sum + page.size, 0);
  if (totalBytes > SYNC_V5_MAX_EVENT_BYTES) throw new Error("v5 event pages exceed the aggregate byte limit");
  return result;
}

/**
 * Merge immutable page descriptors by `(path, blobSha)`.  A path cannot point
 * at two different immutable blobs: that is surfaced as a conflict rather
 * than silently dropping one device's page.
 */
export function mergeSyncV5EventPages(
  existing: readonly SyncEventPageDescriptorV5[],
  additions: readonly SyncEventPageDescriptorV5[],
): SyncEventPageDescriptorV5[] {
  return canonicalPages([...existing, ...additions]);
}

/** Return a new head with pages merged; input heads are never mutated. */
export function appendSyncV5EventPages(
  head: SyncHeadV5,
  additions: readonly SyncEventPageDescriptorV5[],
): SyncHeadV5 {
  validateSyncHeadV5(head);
  const eventPages = mergeSyncV5EventPages(head.eventPages, additions);
  return {
    formatVersion: 5,
    generatedAt: head.generatedAt,
    checkpoint: cloneDescriptor(head.checkpoint),
    archiveCatalog: cloneDescriptor(head.archiveCatalog),
    eventPages,
  };
}

/**
 * Rebase local pages onto the latest head after a failed conditional ref
 * update.  Pages committed by the other device remain intact; pages already
 * present are deduplicated and all immutable baselines come from latestHead.
 */
export function appendSyncV5EventPagesAfterCas(input: SyncV5AppendInput): SyncHeadV5 {
  validateSyncHeadV5(input.expectedHead);
  validateSyncHeadV5(input.latestHead);
  return appendSyncV5EventPages(input.latestHead, input.newPages);
}

/** Short form for callers that already have the latest head. */
export function mergeSyncV5EventPagesAfterCas(
  latestHead: SyncHeadV5,
  newPages: readonly SyncEventPageDescriptorV5[],
): SyncHeadV5 {
  validateSyncHeadV5(latestHead);
  return appendSyncV5EventPages(latestHead, newPages);
}

function classifyBaselineChange(expectedHead: SyncHeadV5, latestHead: SyncHeadV5): SyncV5CompactionConflict["changed"] | undefined {
  const checkpointChanged = !descriptorEqual(expectedHead.checkpoint, latestHead.checkpoint);
  const catalogChanged = !descriptorEqual(expectedHead.archiveCatalog, latestHead.archiveCatalog);
  if (checkpointChanged && catalogChanged) return "both";
  if (checkpointChanged) return "checkpoint";
  if (catalogChanged) return "archiveCatalog";
  return undefined;
}

function validateIncludedPaths(paths: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const path of paths) {
    assertPath(path, "eventPage");
    unique.add(path);
  }
  return [...unique];
}

/**
 * Build the result of a compaction CAS.  Only paths explicitly present in
 * `includedPaths` and in the expected (compactor's) head are removed.  This
 * second membership check is what keeps a page appended concurrently from
 * being lost.  A checkpoint/catalog baseline change is a hard conflict.
 */
export function tryCompactSyncV5HeadAfterCas(input: SyncV5CompactionInput): SyncV5CompactionResult {
  validateSyncHeadV5(input.expectedHead);
  validateSyncHeadV5(input.latestHead);
  validateDescriptor(input.checkpoint, "checkpoint");
  validateDescriptor(input.archiveCatalog, "archiveCatalog");
  assertDate(input.generatedAt ?? input.latestHead.generatedAt, "generatedAt");
  const changed = classifyBaselineChange(input.expectedHead, input.latestHead);
  if (changed) return { ok: false, reason: "checkpoint-or-catalog-advanced", changed };

  const included = validateIncludedPaths(input.includedPaths);
  const expectedPaths = new Set(input.expectedHead.eventPages.map((page) => page.path));
  const remove = new Set(included.filter((path) => expectedPaths.has(path)));
  const eventPages = input.latestHead.eventPages.filter((page) => !remove.has(page.path)).map(clonePage);
  const next: SyncHeadV5 = {
    formatVersion: 5,
    generatedAt: input.generatedAt ?? input.latestHead.generatedAt,
    checkpoint: cloneDescriptor(input.checkpoint),
    archiveCatalog: cloneDescriptor(input.archiveCatalog),
    eventPages: canonicalPages(eventPages),
  };
  // Keep this assertion next to the construction: future callers adding
  // fields cannot accidentally bypass the same strict bounds.
  validateSyncHeadV5(next);
  return { ok: true, head: next, removedPaths: [...remove].filter((path) => input.latestHead.eventPages.some((page) => page.path === path)) };
}

/** Throwing variant for transaction code that treats a baseline race as an error. */
export function compactSyncV5HeadAfterCas(input: SyncV5CompactionInput): SyncHeadV5 {
  const result = tryCompactSyncV5HeadAfterCas(input);
  if (!result.ok) throw new SyncV5CompactionConflictError(result.changed);
  return result.head;
}

/** Alias matching transaction terminology used by Git ref clients. */
export const compactSyncV5HeadCas = compactSyncV5HeadAfterCas;
