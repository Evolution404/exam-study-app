/**
 * v6 descriptor validation + path constants shared by the live data layer.
 *
 * The v6 sync transport (event pages, hot tail, publication plans) has been
 * removed; what remains is the path namespace + descriptor-shape validation
 * that db-v6 (SYNC_V6_IMMUTABLE_PREFIX) and the v7 checkpoint module
 * (validateSyncV6Descriptor / SYNC_V6_ARCHIVE_PREFIX) still depend on.
 */

export const SYNC_V6_HEAD_PATH = "sync/v6/head.json";
export const SYNC_V6_CHECKPOINT_PREFIX = "sync/v6/checkpoints/";
export const SYNC_V6_ARCHIVE_PREFIX = "sync/v6/archive/";
export const SYNC_V6_ARCHIVE_CATALOG_PREFIX = `${SYNC_V6_ARCHIVE_PREFIX}catalogs/`;
export const SYNC_V6_EVENT_PREFIX = "sync/v6/events/";
export const SYNC_V6_IMMUTABLE_PREFIX = "sync/v6/objects/";
export const SYNC_V6_ASSET_PREFIX = "sync/v6/assets/";

export const SYNC_V6_MAX_EVENT_PAGE_BYTES = 1024 * 1024;
export const SYNC_V6_MAX_EVENT_PAGE_COUNT = 1000;
export const SYNC_V6_MAX_DESCRIPTOR_BYTES = 32 * 1024 * 1024;
export const SYNC_V6_MAX_PATH_LENGTH = 512;
export const SYNC_V6_MAX_DEVICE_CURSORS = 256;

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

export type SyncV6DescriptorKind =
  | "checkpoint"
  | "archiveCatalog"
  | "archiveSegment"
  | "eventPage"
  | "immutable"
  | "asset"
  | "image";

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

export function validateSyncV6Descriptor(value: unknown, kind: SyncV6DescriptorKind): asserts value is SyncV6Descriptor | SyncV6EventPageDescriptor {
  if (kind === "eventPage") validateEventPage(value, 0);
  else validateDescriptor(value, kind === "image" ? "asset" : kind);
}
