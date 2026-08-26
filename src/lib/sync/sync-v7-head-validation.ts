import {
  SYNC_V9_FORMAT_VERSION, SYNC_V9_HISTORY_PREFIX,
  SYNC_V7_ASSET_PREFIX, SYNC_V7_CHECKPOINT_PREFIX, SYNC_V7_HEAD_PATH, SYNC_V7_OBJECT_PREFIX, SYNC_V7_SEGMENT_PREFIX,
  SYNC_V7_MAX_DESCRIPTOR_BYTES, SYNC_V7_MAX_DEVICE_CURSORS, SYNC_V7_MAX_DEVICE_ID_LENGTH, SYNC_V7_MAX_HOT_BYTES,
  SYNC_V7_MAX_PATH_LENGTH, SYNC_V7_MAX_SEGMENT_COUNT, SYNC_V7_MAX_SEGMENT_EVENT_COUNT, SYNC_V7_MAX_VAULT_ID_LENGTH,
  type SyncHeadV7, type SyncV7Descriptor, type SyncV7DescriptorKind, type SyncV7HeadMetadata, type SyncV7SegmentDescriptor, type SyncV7SegmentMetadata,
} from "./sync-v7-head-types";

export const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const SHA1 = /^[0-9a-f]{40}$/;
export const SHA256 = /^[0-9a-f]{64}$/;
const DEVICE_ID = /^[\x21-\x7e]{1,128}$/;
const VAULT_ID = /^[\x21-\x7e]{1,256}$/;

function fail(message: string): never {
  throw new Error(`invalid v9 sync head: ${message}`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp`);
}

export function assertVaultId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > SYNC_V7_MAX_VAULT_ID_LENGTH || !VAULT_ID.test(value)) fail(`${field} must be an explicit printable vault identity`);
}

function assertDeviceId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !DEVICE_ID.test(value) || value.length > SYNC_V7_MAX_DEVICE_ID_LENGTH) fail(`${field} must be a printable device id`);
}

export function assertSha(value: unknown, field: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} must be lowercase hexadecimal`);
}

export function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} must be a safe integer >= ${minimum}`);
}

export function assertSize(value: unknown, field: string, maximum: number): asserts value is number {
  assertSafeInteger(value, field);
  if ((value) > maximum) fail(`${field} exceeds its byte limit`);
}

function assertCount(value: unknown, field: string): asserts value is number {
  assertSafeInteger(value, field, 1);
  if ((value) > SYNC_V7_MAX_SEGMENT_EVENT_COUNT) fail(`${field} exceeds the segment event limit`);
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

export function digestFromPath(path: string): string | undefined {
  return /\/([0-9a-f]{64})\.(?:json|webp|jpg|jpeg|png|bin)$/.exec(path)?.[1];
}

/** Strictly validate that a path is in the exact v9 immutable namespace. */
export function assertSyncV7Path(value: unknown, kind: SyncV7DescriptorKind | "head"): asserts value is string {
  if (!isSafeRelativePath(value)) fail(`${kind} path is not a safe relative path`);
  if (kind === "head") {
    if (value !== SYNC_V7_HEAD_PATH) fail(`head path must be ${SYNC_V7_HEAD_PATH}`);
    return;
  }
  if (value === SYNC_V7_HEAD_PATH) fail("head.json is mutable and cannot be an immutable descriptor");
  if (kind === "checkpoint" && !hashPath(value, SYNC_V7_CHECKPOINT_PREFIX)) fail(`checkpoint path must be ${SYNC_V7_CHECKPOINT_PREFIX}<sha256>.json`);
  if (kind === "object" && !hashPath(value, SYNC_V7_OBJECT_PREFIX)) fail(`object path must be ${SYNC_V7_OBJECT_PREFIX}<sha256>.json`);
  if (kind === "history" && !hashPath(value, SYNC_V9_HISTORY_PREFIX)) fail(`history path must be ${SYNC_V9_HISTORY_PREFIX}<sha256>.json`);
  if (kind === "segment" && !hashPath(value, SYNC_V7_SEGMENT_PREFIX)) fail(`segment path must be ${SYNC_V7_SEGMENT_PREFIX}<sha256>.json`);
  if (kind === "asset" && !hashPath(value, SYNC_V7_ASSET_PREFIX, "webp|jpg|jpeg|png|bin")) fail(`asset path must be ${SYNC_V7_ASSET_PREFIX}<sha256>.<ext>`);
}

export function validateCursors(value: unknown, field: string): asserts value is Record<string, number> {
  if (!isRecord(value)) fail(`${field} must be a cursor map`);
  const entries = Object.entries(value);
  if (entries.length > SYNC_V7_MAX_DEVICE_CURSORS) fail(`${field} has too many devices`);
  for (const [deviceId, sequence] of entries) {
    if (!DEVICE_ID.test(deviceId)) fail(`${field} contains an invalid device id`);
    assertSafeInteger(sequence, `${field}.${deviceId}`);
  }
}

export function validateMetadata(value: unknown, field: string, vaultId: string): asserts value is SyncV7SegmentMetadata | SyncV7HeadMetadata {
  if (!isRecord(value)) fail(`${field} must be an object`);
  assertVaultId(value.vaultId, `${field}.vaultId`);
  if (value.vaultId !== vaultId) fail(`${field}.vaultId does not match head vaultId`);
  if ("createdAt" in value) assertDate(value.createdAt, `${field}.createdAt`);
  if (value.deviceId !== undefined) assertDeviceId(value.deviceId, `${field}.deviceId`);
  if (value.producer !== undefined && (typeof value.producer !== "string" || value.producer.length > 128)) fail(`${field}.producer is invalid`);
  if (value.migratedFrom !== undefined) {
    if (!isRecord(value.migratedFrom)) fail(`${field}.migratedFrom must be an object`);
    if (value.migratedFrom.path !== "sync/v7/head.json" && value.migratedFrom.path !== "sync/v8/head.json") fail(`${field}.migratedFrom.path is invalid`);
    assertSha(value.migratedFrom.blobSha, `${field}.migratedFrom.blobSha`, SHA1);
    assertSafeInteger(value.migratedFrom.generation, `${field}.migratedFrom.generation`, 0);
  }
}

function validateDescriptor(value: unknown, kind: SyncV7DescriptorKind): asserts value is SyncV7Descriptor {
  if (!isRecord(value)) fail(`${kind} descriptor must be an object`);
  assertSyncV7Path(value.path, kind);
  assertSha(value.blobSha, `${kind}.blobSha`, SHA1);
  assertSha(value.sha256, `${kind}.sha256`, SHA256);
  assertSize(value.size, `${kind}.size`, SYNC_V7_MAX_DESCRIPTOR_BYTES);
  if (value.storedSize !== undefined) assertSize(value.storedSize, `${kind}.storedSize`, SYNC_V7_MAX_DESCRIPTOR_BYTES);
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
  return left.path === right.path && left.blobSha === right.blobSha && left.sha256 === right.sha256 && left.size === right.size && left.storedSize === right.storedSize;
}

export function sameSyncV7Segment(left: SyncV7SegmentDescriptor, right: SyncV7SegmentDescriptor): boolean {
  return sameSyncV7Descriptor(left, right) && left.generation === right.generation && left.ordinal === right.ordinal && left.count === right.count && sameCursors(left.cursors, right.cursors) && sameMetadata(left.metadata, right.metadata);
}

export function compareSyncV7SegmentOrder(left: Pick<SyncV7SegmentDescriptor, "generation" | "ordinal">, right: Pick<SyncV7SegmentDescriptor, "generation" | "ordinal">): number {
  return left.generation - right.generation || left.ordinal - right.ordinal;
}


export function validateSegment(value: unknown, index: number, vaultId: string): asserts value is SyncV7SegmentDescriptor {
  if (!isRecord(value)) fail(`segments[${index}] must be an object`);
  validateDescriptor(value, "segment");
  assertSafeInteger(value.generation, `segments[${index}].generation`, 0);
  assertSafeInteger(value.ordinal, `segments[${index}].ordinal`, 0);
  assertCount(value.count, `segments[${index}].count`);
  validateCursors(value.cursors, `segments[${index}].cursors`);
  validateMetadata(value.metadata, `segments[${index}].metadata`, vaultId);
}

/** Strict validation for a v9 mutable head. */
export function validateSyncHeadV7(value: unknown): asserts value is SyncHeadV7 {
  if (!isRecord(value) || value.formatVersion !== SYNC_V9_FORMAT_VERSION) fail("formatVersion must be 9");
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
  if (value.devices !== undefined) {
    if (!isRecord(value.devices)) fail("devices must be an object keyed by deviceId");
    for (const [device, watermark] of Object.entries(value.devices)) {
      if (!device) fail("devices keys must be non-empty device ids");
      if (!isRecord(watermark)) fail(`devices.${device} must be an object`);
      validateCursors(watermark.cursors, `devices.${device}.cursors`);
      assertDate(watermark.syncedAt, `devices.${device}.syncedAt`);
    }
  }
}

export function isSyncHeadV7(value: unknown): value is SyncHeadV7 {
  try { validateSyncHeadV7(value); return true; } catch { return false; }
}


export function validateSyncV7Descriptor(value: unknown, kind: SyncV7DescriptorKind): asserts value is SyncV7Descriptor | SyncV7SegmentDescriptor {
  if (kind === "segment") validateSegment(value, 0, isRecord(value) && isRecord(value.metadata) && typeof value.metadata.vaultId === "string" ? value.metadata.vaultId : "");
  else validateDescriptor(value, kind);
}
