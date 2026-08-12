/**
 * Sync v6 wire contract.
 *
 * This module intentionally has no dependency on the database or on the v5
 * implementation.  A v6 head is a small, mutable index; every other object
 * named by it is immutable and content addressed.
 */

export const SYNC_V6_HEAD_PATH = "sync/v6/head.json";
export const SYNC_V6_MANIFEST_PATH = SYNC_V6_HEAD_PATH;

export const SYNC_V6_CHECKPOINT_PREFIX = "sync/v6/checkpoints/";
export const SYNC_V6_ARCHIVE_PREFIX = "sync/v6/archive/";
export const SYNC_V6_ARCHIVE_CATALOG_PREFIX = `${SYNC_V6_ARCHIVE_PREFIX}catalogs/`;
export const SYNC_V6_EVENT_PREFIX = "sync/v6/events/";
export const SYNC_V6_IMMUTABLE_PREFIX = "sync/v6/objects/";
export const SYNC_V6_ASSET_PREFIX = "sync/v6/assets/";
export const SYNC_V6_IMAGE_PREFIX = SYNC_V6_ASSET_PREFIX;

export const SYNC_V6_MAX_EVENT_BYTES = 1024 * 1024;
export const SYNC_V6_MAX_EVENT_PAGE_BYTES = 1024 * 1024;
export const SYNC_V6_MAX_EVENT_PAGE_COUNT = 1000;
/** Re-pack the hot tail into full pages once incremental pages exceed this count. */
export const SYNC_V6_EVENT_PAGE_CONSOLIDATE_COUNT = 24;
export const SYNC_V6_MAX_HOT_EVENT_BYTES = 4 * 1024 * 1024;
/** A second name makes the aggregate budget unambiguous to callers. */
export const SYNC_V6_MAX_HOT_BYTES = SYNC_V6_MAX_HOT_EVENT_BYTES;
export const SYNC_V6_MAX_EVENT_PAGES = 1024;
export const SYNC_V6_MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
export const SYNC_V6_MAX_PATH_LENGTH = 512;
export const SYNC_V6_MAX_DEVICE_CURSORS = 256;

export const SYNC_V6_LIMITS = Object.freeze({
  maxEventBytes: SYNC_V6_MAX_EVENT_BYTES,
  maxEventPageBytes: SYNC_V6_MAX_EVENT_PAGE_BYTES,
  maxEventPageCount: SYNC_V6_MAX_EVENT_PAGE_COUNT,
  eventPageConsolidateCount: SYNC_V6_EVENT_PAGE_CONSOLIDATE_COUNT,
  maxHotEventBytes: SYNC_V6_MAX_HOT_EVENT_BYTES,
  maxEventPages: SYNC_V6_MAX_EVENT_PAGES,
  maxDescriptorBytes: SYNC_V6_MAX_DESCRIPTOR_BYTES,
  maxPathLength: SYNC_V6_MAX_PATH_LENGTH,
  maxDeviceCursors: SYNC_V6_MAX_DEVICE_CURSORS,
});

export interface SyncV6Descriptor {
  path: string;
  /** Git's SHA-1 blob id, returned by the Contents API. */
  blobSha: string;
  /** SHA-256 of the exact bytes stored in the blob. */
  sha256: string;
  size: number;
}

export interface SyncV6EventPageDescriptor extends SyncV6Descriptor {
  count: number;
  deviceCursors: Record<string, number>;
}

export interface SyncHeadV6 {
  formatVersion: 6;
  generatedAt: string;
  checkpoint: SyncV6Descriptor;
  archiveCatalog: SyncV6Descriptor;
  eventPages: SyncV6EventPageDescriptor[];
}

export type SyncManifestV6 = SyncHeadV6;
export type SyncHeadDescriptorV6 = SyncV6Descriptor;
export type SyncEventPageDescriptorV6 = SyncV6EventPageDescriptor;
export type SyncV6Head = SyncHeadV6;
export type ImmutableBytes = Uint8Array | ArrayBuffer | string;

export type SyncV6DescriptorKind =
  | "checkpoint"
  | "archiveCatalog"
  | "archiveSegment"
  | "eventPage"
  | "immutable"
  | "asset"
  | "image";

export interface SyncV6EventPage<T = unknown> {
  events: T[];
  bytes: Uint8Array;
  size: number;
  count: number;
}

export interface SyncV6HotTailPlan<T = unknown> {
  /** Tail pages retained by the hot head. */
  pages: SyncV6EventPage<T>[];
  /** Older events that must be represented by a checkpoint/archive. */
  archived: T[];
  requiresCheckpoint: boolean;
  hotBytes: number;
}

export interface SyncV6PublicationFile {
  path: string;
  bytes: Uint8Array | ArrayBuffer | string;
  kind?: SyncV6DescriptorKind;
}

/**
 * A transport-independent description of the required write ordering.  The
 * GitHub transport consumes this shape, but keeping it here avoids coupling
 * protocol planning to a database or a particular remote implementation.
 */
export interface SyncV6PublicationPlan {
  assets: SyncV6PublicationFile[];
  immutable: SyncV6PublicationFile[];
  head: SyncHeadV6;
  expectedHeadSha?: string;
  order: readonly ["assets", "immutable", "head-cas"];
}

export interface SyncV6AppendInput {
  expectedHead: SyncHeadV6;
  latestHead: SyncHeadV6;
  newPages: readonly SyncV6EventPageDescriptor[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[\x21-\x7e]{1,128}$/;

function fail(message: string): never {
  throw new Error(`invalid v6 sync head: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeRelativePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SYNC_V6_MAX_PATH_LENGTH) return false;
  if (value.startsWith("/") || value.includes("\\")) return false;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  })) return false;
  return value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`);
  }
}

function assertSha(value: unknown, field: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} must be lowercase hexadecimal`);
}

function assertSize(value: unknown, field: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    fail(`${field} is outside its byte limit`);
  }
}

function assertCount(value: unknown, field: string, maximum: number): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    fail(`${field} is outside its count limit`);
  }
}

function assertCursors(value: unknown, field: string): asserts value is Record<string, number> {
  if (!isRecord(value)) fail(`${field} must be a device cursor map`);
  const entries = Object.entries(value) as Array<[string, unknown]>;
  if (entries.length === 0 || entries.length > SYNC_V6_MAX_DEVICE_CURSORS) fail(`${field} has an invalid number of devices`);
  for (const [deviceId, sequence] of entries) {
    if (!DEVICE_ID.test(deviceId) || !Number.isSafeInteger(sequence) || (sequence as number) < 0) {
      fail(`${field} contains an invalid device cursor`);
    }
  }
}

function pathDigest(path: string): string | undefined {
  const match = /\/([0-9a-f]{64})\.(?:json|webp|jpg|png)$/.exec(path);
  return match?.[1];
}

function isHashNamedJson(path: string, prefix: string): boolean {
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{64}\\.json$`).test(path);
}

/** Assert that a path belongs to the exact v6 immutable namespace. */
export function assertSyncV6Path(value: unknown, kind: SyncV6DescriptorKind | "head"): asserts value is string {
  if (!isSafeRelativePath(value)) fail(`${kind} path is not a safe relative path`);
  if (kind === "head") {
    if (value !== SYNC_V6_HEAD_PATH) fail(`head path must be ${SYNC_V6_HEAD_PATH}`);
    return;
  }
  if (value === SYNC_V6_HEAD_PATH) fail("head.json is mutable and cannot be an immutable descriptor");
  if (kind === "checkpoint" && !isHashNamedJson(value, SYNC_V6_CHECKPOINT_PREFIX)) {
    fail(`checkpoint path must be ${SYNC_V6_CHECKPOINT_PREFIX}<sha256>.json`);
  }
  if (kind === "archiveCatalog" && !isHashNamedJson(value, SYNC_V6_ARCHIVE_CATALOG_PREFIX)) {
    fail(`archive catalog path must be ${SYNC_V6_ARCHIVE_CATALOG_PREFIX}<sha256>.json`);
  }
  if (kind === "archiveSegment" && !new RegExp(`^${SYNC_V6_ARCHIVE_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.+/[0-9a-f]{64}\\.json$`).test(value)) {
    fail(`archive segment path must be under ${SYNC_V6_ARCHIVE_PREFIX} and end in <sha256>.json`);
  }
  if (kind === "eventPage" && !isHashNamedJson(value, SYNC_V6_EVENT_PREFIX)) {
    fail(`event page path must be ${SYNC_V6_EVENT_PREFIX}<sha256>.json`);
  }
  if (kind === "immutable" && !isHashNamedJson(value, SYNC_V6_IMMUTABLE_PREFIX)) {
    fail(`immutable path must be ${SYNC_V6_IMMUTABLE_PREFIX}<sha256>.json`);
  }
  if (kind === "asset" || kind === "image") {
    if (!new RegExp(`^${SYNC_V6_ASSET_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[0-9a-f]{64}\\.(?:webp|jpg|png)$`).test(value)) {
      fail(`asset path must be ${SYNC_V6_ASSET_PREFIX}<sha256>.(webp|jpg|png)`);
    }
  }
}

function validateDescriptor(value: unknown, kind: Exclude<SyncV6DescriptorKind, "image">): asserts value is SyncV6Descriptor {
  if (!isRecord(value)) fail(`${kind} descriptor must be an object`);
  assertSyncV6Path(value.path, kind);
  assertSha(value.blobSha, `${kind}.blobSha`, SHA1);
  assertSha(value.sha256, `${kind}.sha256`, SHA256);
  assertSize(value.size, `${kind}.size`, kind === "eventPage" ? SYNC_V6_MAX_EVENT_PAGE_BYTES : SYNC_V6_MAX_DESCRIPTOR_BYTES);
  const digest = pathDigest(value.path);
  if (digest && digest !== value.sha256) fail(`${kind} path digest must equal descriptor.sha256`);
}

function validateEventPage(value: unknown, index: number): asserts value is SyncV6EventPageDescriptor {
  if (!isRecord(value)) fail(`eventPages[${index}] must be an object`);
  validateDescriptor(value, "eventPage");
  assertCount(value.count, `eventPages[${index}].count`, SYNC_V6_MAX_EVENT_PAGE_COUNT);
  assertCursors(value.deviceCursors, `eventPages[${index}].deviceCursors`);
}

/** Strictly validate an unknown value as a v6 hot head. */
export function validateSyncHeadV6(value: unknown): asserts value is SyncHeadV6 {
  if (!isRecord(value) || value.formatVersion !== 6) fail("formatVersion must be 6");
  assertDate(value.generatedAt, "generatedAt");
  validateDescriptor(value.checkpoint, "checkpoint");
  validateDescriptor(value.archiveCatalog, "archiveCatalog");
  if (!Array.isArray(value.eventPages)) fail("eventPages must be an array");
  if (value.eventPages.length > SYNC_V6_MAX_EVENT_PAGES) fail("eventPages exceed the bounded index limit");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (let index = 0; index < value.eventPages.length; index += 1) {
    const page = value.eventPages[index];
    validateEventPage(page, index);
    if (paths.has(page.path)) fail(`eventPages contains duplicate path: ${page.path}`);
    paths.add(page.path);
    totalBytes += page.size;
    if (totalBytes > SYNC_V6_MAX_HOT_EVENT_BYTES) fail("eventPages exceed the aggregate hot-window byte limit");
  }
  for (let index = 1; index < value.eventPages.length; index += 1) {
    if (value.eventPages[index - 1].path.localeCompare(value.eventPages[index].path) >= 0) {
      fail("eventPages must be sorted by path");
    }
  }
}

export function isSyncHeadV6(value: unknown): value is SyncHeadV6 {
  try {
    validateSyncHeadV6(value);
    return true;
  } catch {
    return false;
  }
}

export function validateSyncV6Descriptor(value: unknown, kind: SyncV6DescriptorKind): asserts value is SyncV6Descriptor | SyncV6EventPageDescriptor {
  if (kind === "eventPage") validateEventPage(value, 0);
  else validateDescriptor(value, kind === "image" ? "asset" : kind);
}

/** Return a stable descriptor equality check for head merge code. */
export function sameSyncV6Descriptor(left: SyncV6Descriptor, right: SyncV6Descriptor): boolean {
  return left.path === right.path && left.blobSha === right.blobSha && left.sha256 === right.sha256 && left.size === right.size;
}

function sameSyncV6EventPage(left: SyncV6EventPageDescriptor, right: SyncV6EventPageDescriptor): boolean {
  if (!sameSyncV6Descriptor(left, right) || left.count !== right.count) return false;
  const leftKeys = Object.keys(left.deviceCursors);
  const rightKeys = Object.keys(right.deviceCursors);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => left.deviceCursors[key] === right.deviceCursors[key]);
}

function cloneSyncV6Descriptor(value: SyncV6Descriptor): SyncV6Descriptor {
  return { path: value.path, blobSha: value.blobSha, sha256: value.sha256, size: value.size };
}

function cloneSyncV6Page(value: SyncV6EventPageDescriptor): SyncV6EventPageDescriptor {
  return { ...cloneSyncV6Descriptor(value), count: value.count, deviceCursors: { ...value.deviceCursors } };
}

function canonicalSyncV6Pages(pages: Iterable<SyncV6EventPageDescriptor>): SyncV6EventPageDescriptor[] {
  const byPath = new Map<string, SyncV6EventPageDescriptor>();
  for (const page of pages) {
    validateEventPage(page, 0);
    const existing = byPath.get(page.path);
    if (existing) {
      if (!sameSyncV6EventPage(existing, page)) throw new Error(`v6 event page path collision: ${page.path}`);
      continue;
    }
    byPath.set(page.path, cloneSyncV6Page(page));
  }
  const result = [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
  if (result.length > SYNC_V6_MAX_EVENT_PAGES) throw new Error("v6 event pages exceed the bounded index limit");
  if (result.reduce((sum, page) => sum + page.size, 0) > SYNC_V6_MAX_HOT_EVENT_BYTES) {
    throw new Error("v6 event pages exceed the aggregate hot-window byte limit");
  }
  return result;
}

export function mergeSyncV6EventPages(
  existing: readonly SyncV6EventPageDescriptor[],
  additions: readonly SyncV6EventPageDescriptor[],
): SyncV6EventPageDescriptor[] {
  return canonicalSyncV6Pages([...existing, ...additions]);
}

export function appendSyncV6EventPages(
  head: SyncHeadV6,
  additions: readonly SyncV6EventPageDescriptor[],
): SyncHeadV6 {
  validateSyncHeadV6(head);
  const next: SyncHeadV6 = {
    formatVersion: 6,
    generatedAt: head.generatedAt,
    checkpoint: cloneSyncV6Descriptor(head.checkpoint),
    archiveCatalog: cloneSyncV6Descriptor(head.archiveCatalog),
    eventPages: mergeSyncV6EventPages(head.eventPages, additions),
  };
  validateSyncHeadV6(next);
  return next;
}

export function appendSyncV6EventPagesAfterCas(input: SyncV6AppendInput): SyncHeadV6 {
  validateSyncHeadV6(input.expectedHead);
  validateSyncHeadV6(input.latestHead);
  return appendSyncV6EventPages(input.latestHead, input.newPages);
}

export const mergeSyncV6EventPagesAfterCas = appendSyncV6EventPagesAfterCas;

/** Encode one event and enforce the hard UTF-8 byte limit. */
export function encodeSyncV6Event(event: unknown): Uint8Array {
  const json = JSON.stringify(event);
  if (json === undefined) throw new TypeError("v6 event must be JSON serializable");
  const bytes = new TextEncoder().encode(json);
  if (bytes.byteLength > SYNC_V6_MAX_EVENT_BYTES) {
    throw new RangeError(`v6 event exceeds ${SYNC_V6_MAX_EVENT_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

/** Encode a page as a JSON array, with UTF-8 byte accounting. */
export function encodeSyncV6EventPage<T>(events: readonly T[]): Uint8Array {
  if (events.length < 1 || events.length > SYNC_V6_MAX_EVENT_PAGE_COUNT) {
    throw new RangeError(`v6 event page must contain 1-${SYNC_V6_MAX_EVENT_PAGE_COUNT} events`);
  }
  for (const event of events) encodeSyncV6Event(event);
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  if (bytes.byteLength > SYNC_V6_MAX_EVENT_PAGE_BYTES) {
    throw new RangeError(`v6 event page exceeds ${SYNC_V6_MAX_EVENT_PAGE_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

/** Paginate by encoded UTF-8 bytes (never by JavaScript string length). */
export function paginateSyncV6Events<T>(events: readonly T[]): SyncV6EventPage<T>[] {
  const pages: SyncV6EventPage<T>[] = [];
  let current: T[] = [];
  for (const event of events) {
    encodeSyncV6Event(event);
    const candidate = [...current, event];
    if (candidate.length > SYNC_V6_MAX_EVENT_PAGE_COUNT || (current.length > 0 && (() => {
      try {
        return encodeSyncV6EventPage(candidate).byteLength > SYNC_V6_MAX_EVENT_PAGE_BYTES;
      } catch {
        return true;
      }
    })())) {
      const bytes = encodeSyncV6EventPage(current);
      pages.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
      current = [event];
      // A single event may fit the individual limit but not the page framing.
      encodeSyncV6EventPage(current);
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    const bytes = encodeSyncV6EventPage(current);
    pages.push({ events: current, bytes, size: bytes.byteLength, count: current.length });
  }
  return pages;
}

export const partitionSyncV6Events = paginateSyncV6Events;

/**
 * Keep only a suffix that fits the hot download window.  A non-empty prefix
 * is explicitly reported as requiring a checkpoint/archive rather than being
 * silently retained by growing the mutable head.
 */
export function planSyncV6HotTail<T>(events: readonly T[]): SyncV6HotTailPlan<T> {
  const allPages = paginateSyncV6Events(events);
  const total = allPages.reduce((sum, page) => sum + page.size, 0);
  if (total <= SYNC_V6_MAX_HOT_EVENT_BYTES) {
    return { pages: allPages, archived: [], requiresCheckpoint: false, hotBytes: total };
  }
  // Pagination has already made every page independently bounded.  Retaining
  // whole pages avoids an O(n²) suffix search when an offline device returns
  // thousands of events (for example a 6,000-question import).
  let firstHotPage = allPages.length;
  let hotBytes = 0;
  for (let index = allPages.length - 1; index >= 0; index -= 1) {
    if (hotBytes + allPages[index].size > SYNC_V6_MAX_HOT_EVENT_BYTES) break;
    hotBytes += allPages[index].size;
    firstHotPage = index;
  }
  const pages = allPages.slice(firstHotPage);
  const archived = allPages.slice(0, firstHotPage).flatMap((page) => page.events);
  return { pages, archived, requiresCheckpoint: archived.length > 0, hotBytes };
}

export class SyncV6HotWindowError extends Error {
  readonly code = "checkpoint-required" as const;
  readonly eventCount: number;

  constructor(eventCount: number) {
    super(`v6 hot window requires a checkpoint/archive for ${eventCount} older events`);
    this.name = "SyncV6HotWindowError";
    this.eventCount = eventCount;
  }
}

/**
 * Validate a proposed hot tail and fail loudly if older events would be
 * dropped without a checkpoint/archive.
 */
export function assertSyncV6HotTail<T>(events: readonly T[], options: { checkpointPublished?: boolean } = {}): SyncV6HotTailPlan<T> {
  const plan = planSyncV6HotTail(events);
  if (plan.requiresCheckpoint && !options.checkpointPublished) throw new SyncV6HotWindowError(plan.archived.length);
  return plan;
}

/** Build a transport-independent assets -> immutable -> head CAS plan. */
export function createSyncV6PublicationPlan(input: {
  assets?: readonly SyncV6PublicationFile[];
  immutable?: readonly SyncV6PublicationFile[];
  head: SyncHeadV6;
  expectedHeadSha?: string;
}): SyncV6PublicationPlan {
  validateSyncHeadV6(input.head);
  const assets = [...(input.assets ?? [])];
  const immutable = [...(input.immutable ?? [])];
  for (const file of assets) {
    assertSyncV6Path(file.path, file.kind ?? "asset");
  }
  for (const file of immutable) {
    assertSyncV6Path(file.path, file.kind ?? "immutable");
  }
  if (input.expectedHeadSha !== undefined && !SHA1.test(input.expectedHeadSha)) {
    throw new TypeError("expectedHeadSha must be a Git SHA-1 blob id");
  }
  return { assets, immutable, head: input.head, ...(input.expectedHeadSha ? { expectedHeadSha: input.expectedHeadSha } : {}), order: ["assets", "immutable", "head-cas"] };
}
