import type {
  SyncArchiveCatalogV3,
  SyncArchiveCatalogV4,
  SyncArchiveSegmentV3,
  SyncArchiveSegmentV4,
} from "./types";

/** The two independently-retained history streams in an archive catalog. */
export type SyncArchiveKindV4 = "attempts" | "practice-runs";

/** Ordinary v4 archive paths are immutable and content addressed. */
export const SYNC_V4_ARCHIVE_PREFIX = "sync/v4/archive/";
export const SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX = `${SYNC_V4_ARCHIVE_PREFIX}attempts/`;
export const SYNC_V4_ARCHIVE_PRACTICE_RUNS_PREFIX = `${SYNC_V4_ARCHIVE_PREFIX}practice-runs/`;
export const SYNC_V4_ARCHIVE_LEGACY_PREFIX = "sync/v3/archive/";
export const SYNC_V3_ARCHIVE_ATTEMPTS_PREFIX = `${SYNC_V4_ARCHIVE_LEGACY_PREFIX}attempts/`;
export const SYNC_V3_ARCHIVE_PRACTICE_RUNS_PREFIX = `${SYNC_V4_ARCHIVE_LEGACY_PREFIX}practice-runs/`;

/** A segment contains at most this many rows on the wire. */
export const SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT = 500;
/** Keep archive descriptors subject to the same bounded immutable-file limit as v4 heads. */
export const SYNC_V4_ARCHIVE_SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_V4_ARCHIVE_MAX_SEGMENT_COUNT = SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT;
export const SYNC_V4_MAX_ARCHIVE_SEGMENT_COUNT = SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_MAX_LENGTH = 1024;

type MaybePromise<T> = T | PromiseLike<T>;

export interface SyncArchiveBlobResolutionV4 {
  blobSha: string;
  size: number;
}

export type ResolveV3ArchiveBlob = (path: string) => MaybePromise<SyncArchiveBlobResolutionV4>;

/** Fields required by the v4 path builder; `path` is deliberately not accepted. */
export type SyncArchiveSegmentInputV4 = Omit<SyncArchiveSegmentV4, "path" | "legacy">;

function fail(message: string): never {
  throw new Error(`invalid v4 archive catalog: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRecord(value) && typeof value.then === "function";
}

function assertSafeRelativePath(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512
    || value.startsWith("/") || value.includes("\\")
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })) {
    fail(`${field} must be a safe relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    fail(`${field} must not contain empty or dot path segments`);
  }
}

function assertDigest(value: unknown, field: string, pattern: RegExp): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} must be lowercase hexadecimal`);
}

function assertSize(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > SYNC_V4_ARCHIVE_SEGMENT_MAX_BYTES) {
    fail(`${field} is outside the archive byte limit`);
  }
}

function assertCount(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT) {
    fail(`${field} must be between 1 and ${SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT}`);
  }
}

function assertMonth(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !MONTH.test(value)) fail(`${field} must be YYYY-MM`);
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`);
  }
}

function assertId(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > ID_MAX_LENGTH
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    })) {
    fail(`${field} must be a non-empty identifier`);
  }
}

function prefixFor(kind: SyncArchiveKindV4, legacy = false): string {
  if (legacy) return kind === "attempts" ? SYNC_V3_ARCHIVE_ATTEMPTS_PREFIX : SYNC_V3_ARCHIVE_PRACTICE_RUNS_PREFIX;
  return kind === "attempts" ? SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX : SYNC_V4_ARCHIVE_PRACTICE_RUNS_PREFIX;
}

function kindForPath(path: string): SyncArchiveKindV4 | undefined {
  if (path.startsWith(SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX) || path.startsWith(SYNC_V3_ARCHIVE_ATTEMPTS_PREFIX)) return "attempts";
  if (path.startsWith(SYNC_V4_ARCHIVE_PRACTICE_RUNS_PREFIX) || path.startsWith(SYNC_V3_ARCHIVE_PRACTICE_RUNS_PREFIX)) return "practice-runs";
  return undefined;
}

function pathParts(path: string, kind: SyncArchiveKindV4, legacy: boolean): { month: string; digest: string } | undefined {
  const prefix = prefixFor(kind, legacy);
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(\\d{4}-(?:0[1-9]|1[0-2]))/([a-f0-9]{24,64})\\.json$`).exec(path);
  return match ? { month: match[1], digest: match[2] } : undefined;
}

function assertSegmentPath(path: unknown, kind: SyncArchiveKindV4, legacy: boolean, sha256: string): asserts path is string {
  assertSafeRelativePath(path, "segment.path");
  const expectedLegacy = legacy === true;
  const parts = pathParts(path, kind, expectedLegacy);
  if (!parts) {
    const allowed = expectedLegacy ? `${prefixFor(kind, true)}<month>/<digest>.json` : `${prefixFor(kind)}<month>/<digest>.json`;
    fail(`segment.path must use ${allowed}`);
  }
  if (!sha256.startsWith(parts.digest)) {
    fail(`segment.path digest does not match segment.sha256`);
  }
}

function segmentEqual(a: SyncArchiveSegmentV4, b: SyncArchiveSegmentV4): boolean {
  return a.path === b.path
    && a.blobSha === b.blobSha
    && a.sha256 === b.sha256
    && a.size === b.size
    && a.month === b.month
    && a.count === b.count
    && a.firstId === b.firstId
    && a.lastId === b.lastId
    && a.firstCreatedAt === b.firstCreatedAt
    && a.lastCreatedAt === b.lastCreatedAt
    && Boolean(a.legacy) === Boolean(b.legacy);
}

function cloneSegment(segment: SyncArchiveSegmentV4): SyncArchiveSegmentV4 {
  return segment.legacy === undefined ? { ...segment } : { ...segment, legacy: segment.legacy };
}

function validateSegment(value: unknown, kind: SyncArchiveKindV4): asserts value is SyncArchiveSegmentV4 {
  if (!isRecord(value)) fail(`${kind} segment must be an object`);
  assertDigest(value.blobSha, `${kind} segment.blobSha`, SHA1);
  assertDigest(value.sha256, `${kind} segment.sha256`, SHA256);
  assertSize(value.size, `${kind} segment.size`);
  assertMonth(value.month, `${kind} segment.month`);
  assertCount(value.count, `${kind} segment.count`);
  assertId(value.firstId, `${kind} segment.firstId`);
  assertId(value.lastId, `${kind} segment.lastId`);
  assertDate(value.firstCreatedAt, `${kind} segment.firstCreatedAt`);
  assertDate(value.lastCreatedAt, `${kind} segment.lastCreatedAt`);
  if (Date.parse(value.firstCreatedAt) > Date.parse(value.lastCreatedAt)) {
    fail(`${kind} segment firstCreatedAt must not be after lastCreatedAt`);
  }
  if (value.firstCreatedAt.slice(0, 7) !== value.month || value.lastCreatedAt.slice(0, 7) !== value.month) {
    fail(`${kind} segment timestamps must belong to segment.month`);
  }
  if (value.legacy !== undefined && typeof value.legacy !== "boolean") {
    fail(`${kind} segment.legacy must be boolean when present`);
  }
  const legacy = value.legacy === true;
  if (!legacy && (typeof value.path === "string")
    && (value.path.startsWith(SYNC_V3_ARCHIVE_ATTEMPTS_PREFIX) || value.path.startsWith(SYNC_V3_ARCHIVE_PRACTICE_RUNS_PREFIX))) {
    fail(`${kind} v3 archive path requires legacy:true migration marker`);
  }
  assertSegmentPath(value.path, kind, legacy, value.sha256);
  const parsed = pathParts(value.path, kind, legacy);
  if (!parsed || parsed.month !== value.month) fail(`${kind} segment path month does not match month`);
}

function assertSorted(segments: readonly SyncArchiveSegmentV4[], kind: SyncArchiveKindV4): void {
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index - 1].path.localeCompare(segments[index].path) >= 0) {
      fail(`${kind} segments must be sorted by path`);
    }
  }
}

function assertCatalogCounts(catalog: Pick<SyncArchiveCatalogV4, "attemptSegments" | "practiceRunSegments" | "counts">): void {
  const attempts = catalog.attemptSegments.reduce((total, segment) => total + segment.count, 0);
  const practiceRuns = catalog.practiceRunSegments.reduce((total, segment) => total + segment.count, 0);
  if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(practiceRuns)
    || catalog.counts.attempts !== attempts || catalog.counts.practiceRuns !== practiceRuns) {
    fail("counts do not match segment counts");
  }
}

/** Strictly validate an unknown value as a v4 archive catalog. */
export function validateSyncArchiveCatalogV4(value: unknown): asserts value is SyncArchiveCatalogV4 {
  if (!isRecord(value) || value.formatVersion !== 4) fail("formatVersion must be 4");
  assertDate(value.generatedAt, "generatedAt");
  if (!Array.isArray(value.attemptSegments) || !Array.isArray(value.practiceRunSegments)) {
    fail("attemptSegments and practiceRunSegments must be arrays");
  }
  if (!isRecord(value.counts)) fail("counts must be an object");
  if (!Number.isSafeInteger(value.counts.attempts) || (value.counts.attempts as number) < 0
    || !Number.isSafeInteger(value.counts.practiceRuns) || (value.counts.practiceRuns as number) < 0) {
    fail("counts must contain non-negative safe integers");
  }
  for (const segment of value.attemptSegments) validateSegment(segment, "attempts");
  for (const segment of value.practiceRunSegments) validateSegment(segment, "practice-runs");
  assertSorted(value.attemptSegments, "attempts");
  assertSorted(value.practiceRunSegments, "practice-runs");

  const paths = new Set<string>();
  const content = new Set<string>();
  const ids = new Map<SyncArchiveKindV4, Set<string>>([
    ["attempts", new Set<string>()],
    ["practice-runs", new Set<string>()],
  ]);
  for (const [kind, segments] of [["attempts", value.attemptSegments], ["practice-runs", value.practiceRunSegments]] as const) {
    const kindIds = ids.get(kind)!;
    for (const segment of segments) {
      if (paths.has(segment.path)) fail(`duplicate segment path: ${segment.path}`);
      paths.add(segment.path);
      if (content.has(segment.sha256)) fail(`duplicate segment content: ${segment.sha256}`);
      content.add(segment.sha256);
      for (const id of [segment.firstId, segment.lastId]) {
        // A one-row segment necessarily repeats its first/last id internally.
        if (id !== segment.firstId || segment.lastId !== segment.firstId) {
          if (kindIds.has(id)) fail(`duplicate ${kind} boundary id: ${id}`);
        }
        kindIds.add(id);
      }
    }
  }
  assertCatalogCounts(value as unknown as SyncArchiveCatalogV4);
}

export function isSyncArchiveCatalogV4(value: unknown): value is SyncArchiveCatalogV4 {
  try {
    validateSyncArchiveCatalogV4(value);
    return true;
  } catch {
    return false;
  }
}

/** Build the ordinary content-addressed path for a v4 archive segment. */
export function syncV4ArchiveSegmentPath(kind: SyncArchiveKindV4, month: string, sha256: string): string {
  if (kind !== "attempts" && kind !== "practice-runs") throw new TypeError("invalid v4 archive kind");
  assertMonth(month, "month");
  assertDigest(sha256, "sha256", SHA256);
  return `${prefixFor(kind)}${month}/${sha256}.json`;
}

/** Create a v4 segment; unlike migration, this function can never emit a v3 path. */
export function createSyncArchiveSegmentV4(kind: SyncArchiveKindV4, input: SyncArchiveSegmentInputV4): SyncArchiveSegmentV4 {
  const segment: SyncArchiveSegmentV4 = {
    ...input,
    path: syncV4ArchiveSegmentPath(kind, input.month, input.sha256),
  };
  validateSegment(segment, kind);
  return cloneSegment(segment);
}

export const makeSyncArchiveSegmentV4 = createSyncArchiveSegmentV4;

/** Return an empty, valid v4 catalog. */
export function createSyncArchiveCatalogV4(generatedAt = new Date().toISOString()): SyncArchiveCatalogV4 {
  assertDate(generatedAt, "generatedAt");
  return {
    formatVersion: 4,
    generatedAt,
    attemptSegments: [],
    practiceRunSegments: [],
    counts: { attempts: 0, practiceRuns: 0 },
  };
}

function inferredKind(segment: SyncArchiveSegmentV4): SyncArchiveKindV4 {
  const kind = kindForPath(segment.path);
  if (!kind) throw new Error(`cannot infer archive kind from path: ${segment.path}`);
  return kind;
}

/**
 * Deduplicate immutable segments without mutating the input.  Exact content
 * duplicates and repeated boundary ids are idempotent.  A path that names a
 * different immutable descriptor is always a hard collision.
 */
export function dedupeSyncArchiveSegmentsV4(
  segments: readonly SyncArchiveSegmentV4[],
  kind?: SyncArchiveKindV4,
): SyncArchiveSegmentV4[] {
  const byPath = new Map<string, SyncArchiveSegmentV4>();
  const byContent = new Map<string, SyncArchiveSegmentV4>();
  const byId = new Map<string, SyncArchiveSegmentV4>();
  const result: SyncArchiveSegmentV4[] = [];

  for (const candidate of segments) {
    const candidateKind = kind ?? inferredKind(candidate);
    validateSegment(candidate, candidateKind);
    if (candidate.legacy === true && candidateKind !== inferredKind(candidate)) {
      throw new Error(`archive segment path kind does not match ${candidateKind}`);
    }
    const existingPath = byPath.get(candidate.path);
    if (existingPath) {
      if (!segmentEqual(existingPath, candidate)) throw new Error(`v4 archive segment path collision: ${candidate.path}`);
      continue;
    }
    const existingContent = byContent.get(candidate.sha256);
    if (existingContent) {
      // Content addressing makes a repeated digest the same immutable object,
      // even when another caller supplied a second equivalent pathname.
      byPath.set(candidate.path, existingContent);
      continue;
    }
    const ids = [candidate.firstId, candidate.lastId];
    let repeatedId: SyncArchiveSegmentV4 | undefined;
    for (const id of ids) {
      const prior = byId.get(`${candidateKind}\u0000${id}`);
      if (prior && prior !== candidate) {
        repeatedId = prior;
        break;
      }
    }
    if (repeatedId) {
      if (repeatedId.sha256 === candidate.sha256) {
        byPath.set(candidate.path, repeatedId);
        continue;
      }
      throw new Error(`v4 archive segment id collision: ${candidate.firstId}`);
    }
    const copy = cloneSegment(candidate);
    result.push(copy);
    byPath.set(copy.path, copy);
    byContent.set(copy.sha256, copy);
    for (const id of ids) byId.set(`${candidateKind}\u0000${id}`, copy);
  }
  result.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}

export const dedupeSyncV4ArchiveSegments = dedupeSyncArchiveSegmentsV4;

function normalizeAppendArguments(
  kindOrSegments: SyncArchiveKindV4 | readonly SyncArchiveSegmentV4[] | {
    attemptSegments?: readonly SyncArchiveSegmentV4[];
    practiceRunSegments?: readonly SyncArchiveSegmentV4[];
  },
  maybeSegmentsOrKind?: SyncArchiveKindV4 | readonly SyncArchiveSegmentV4[],
): { attempts: SyncArchiveSegmentV4[]; practiceRuns: SyncArchiveSegmentV4[]; explicitSingleKind?: SyncArchiveKindV4 } {
  if (typeof kindOrSegments === "string") {
    if (!Array.isArray(maybeSegmentsOrKind)) throw new TypeError("archive segments are required");
    return {
      attempts: kindOrSegments === "attempts" ? [...maybeSegmentsOrKind] : [],
      practiceRuns: kindOrSegments === "practice-runs" ? [...maybeSegmentsOrKind] : [],
      explicitSingleKind: kindOrSegments,
    };
  }
  if (Array.isArray(kindOrSegments)) {
    if (typeof maybeSegmentsOrKind === "string") {
      return {
        attempts: maybeSegmentsOrKind === "attempts" ? [...kindOrSegments] : [],
        practiceRuns: maybeSegmentsOrKind === "practice-runs" ? [...kindOrSegments] : [],
        explicitSingleKind: maybeSegmentsOrKind,
      };
    }
    const attempts: SyncArchiveSegmentV4[] = [];
    const practiceRuns: SyncArchiveSegmentV4[] = [];
    for (const segment of kindOrSegments) {
      const inferred = inferredKind(segment);
      (inferred === "attempts" ? attempts : practiceRuns).push(segment);
    }
    return { attempts, practiceRuns };
  }
  if (maybeSegmentsOrKind !== undefined) throw new TypeError("bulk archive append accepts one argument");
  const bulk = kindOrSegments as {
    attemptSegments?: readonly SyncArchiveSegmentV4[];
    practiceRunSegments?: readonly SyncArchiveSegmentV4[];
  };
  return {
    attempts: [...(bulk.attemptSegments ?? [])],
    practiceRuns: [...(bulk.practiceRunSegments ?? [])],
  };
}

function assertOrdinaryAppendSegment(segment: SyncArchiveSegmentV4, kind: SyncArchiveKindV4): void {
  validateSegment(segment, kind);
  if (segment.legacy === true || segment.path.startsWith(SYNC_V4_ARCHIVE_LEGACY_PREFIX)) {
    throw new Error("ordinary v4 append cannot add a legacy archive path");
  }
}

export function appendSyncArchiveSegmentsV4(
  catalog: SyncArchiveCatalogV4,
  kind: SyncArchiveKindV4,
  additions: readonly SyncArchiveSegmentV4[],
): SyncArchiveCatalogV4;
export function appendSyncArchiveSegmentsV4(
  catalog: SyncArchiveCatalogV4,
  additions: readonly SyncArchiveSegmentV4[],
  kind?: SyncArchiveKindV4,
): SyncArchiveCatalogV4;
export function appendSyncArchiveSegmentsV4(
  catalog: SyncArchiveCatalogV4,
  additions: {
    attemptSegments?: readonly SyncArchiveSegmentV4[];
    practiceRunSegments?: readonly SyncArchiveSegmentV4[];
  },
): SyncArchiveCatalogV4;
export function appendSyncArchiveSegmentsV4(
  catalog: SyncArchiveCatalogV4,
  kindOrSegments: SyncArchiveKindV4 | readonly SyncArchiveSegmentV4[] | {
    attemptSegments?: readonly SyncArchiveSegmentV4[];
    practiceRunSegments?: readonly SyncArchiveSegmentV4[];
  },
  maybeSegmentsOrKind?: SyncArchiveKindV4 | readonly SyncArchiveSegmentV4[],
): SyncArchiveCatalogV4 {
  validateSyncArchiveCatalogV4(catalog);
  const normalized = normalizeAppendArguments(kindOrSegments, maybeSegmentsOrKind);
  const attempts = normalized.attempts;
  const practiceRuns = normalized.practiceRuns;
  for (const segment of attempts) assertOrdinaryAppendSegment(segment, "attempts");
  for (const segment of practiceRuns) assertOrdinaryAppendSegment(segment, "practice-runs");
  const nextAttempts = dedupeSyncArchiveSegmentsV4([...catalog.attemptSegments, ...attempts], "attempts");
  const nextPracticeRuns = dedupeSyncArchiveSegmentsV4([...catalog.practiceRunSegments, ...practiceRuns], "practice-runs");
  const next: SyncArchiveCatalogV4 = {
    formatVersion: 4,
    generatedAt: catalog.generatedAt,
    attemptSegments: nextAttempts,
    practiceRunSegments: nextPracticeRuns,
    counts: {
      attempts: nextAttempts.reduce((total, segment) => total + segment.count, 0),
      practiceRuns: nextPracticeRuns.reduce((total, segment) => total + segment.count, 0),
    },
  };
  validateSyncArchiveCatalogV4(next);
  return next;
}

export const appendSyncV4ArchiveSegments = appendSyncArchiveSegmentsV4;
export const appendSyncArchiveCatalogV4 = appendSyncArchiveSegmentsV4;

function validateV3Segment(segment: unknown, kind: SyncArchiveKindV4): asserts segment is SyncArchiveSegmentV3 {
  if (!isRecord(segment)) fail(`v3 ${kind} segment must be an object`);
  assertSafeRelativePath(segment.path, `v3 ${kind} segment.path`);
  const expectedPrefix = prefixFor(kind, true);
  const parts = pathParts(segment.path, kind, true);
  if (!parts || !segment.path.startsWith(expectedPrefix)) fail(`v3 ${kind} segment path is not controlled`);
  assertDigest(segment.sha256, `v3 ${kind} segment.sha256`, SHA256);
  if (!segment.sha256.startsWith(parts.digest)) fail(`v3 ${kind} segment path digest does not match sha256`);
  assertMonth(segment.month, `v3 ${kind} segment.month`);
  assertCount(segment.count, `v3 ${kind} segment.count`);
  assertId(segment.firstId, `v3 ${kind} segment.firstId`);
  assertId(segment.lastId, `v3 ${kind} segment.lastId`);
  assertDate(segment.firstCreatedAt, `v3 ${kind} segment.firstCreatedAt`);
  assertDate(segment.lastCreatedAt, `v3 ${kind} segment.lastCreatedAt`);
  if (parts.month !== segment.month || segment.firstCreatedAt.slice(0, 7) !== segment.month || segment.lastCreatedAt.slice(0, 7) !== segment.month) {
    fail(`v3 ${kind} segment month metadata is inconsistent`);
  }
  if (Date.parse(segment.firstCreatedAt) > Date.parse(segment.lastCreatedAt)) fail(`v3 ${kind} segment timestamps are reversed`);
}

function validateV3Catalog(catalog: unknown): asserts catalog is SyncArchiveCatalogV3 {
  if (!isRecord(catalog) || catalog.formatVersion !== 3) fail("migration input must have formatVersion 3");
  assertDate(catalog.generatedAt, "v3 generatedAt");
  if (!Array.isArray(catalog.attemptSegments) || !Array.isArray(catalog.practiceRunSegments) || !isRecord(catalog.counts)) {
    fail("migration input has invalid segment arrays or counts");
  }
  if (!Number.isSafeInteger(catalog.counts.attempts) || (catalog.counts.attempts as number) < 0
    || !Number.isSafeInteger(catalog.counts.practiceRuns) || (catalog.counts.practiceRuns as number) < 0) {
    fail("migration input counts must be non-negative safe integers");
  }
  const paths = new Set<string>();
  const content = new Set<string>();
  for (const [kind, segments] of [["attempts", catalog.attemptSegments], ["practice-runs", catalog.practiceRunSegments]] as const) {
    for (const segment of segments) {
      validateV3Segment(segment, kind);
      if (paths.has(segment.path)) fail(`migration input has duplicate path: ${segment.path}`);
      paths.add(segment.path);
      if (content.has(segment.sha256)) fail(`migration input has duplicate content: ${segment.sha256}`);
      content.add(segment.sha256);
    }
  }
  const attempts = catalog.attemptSegments.reduce((total, segment) => total + segment.count, 0);
  const practiceRuns = catalog.practiceRunSegments.reduce((total, segment) => total + segment.count, 0);
  if (catalog.counts.attempts !== attempts || catalog.counts.practiceRuns !== practiceRuns) fail("migration input counts do not match segments");
}

function mapV3Segments(
  segments: readonly SyncArchiveSegmentV3[],
  kind: SyncArchiveKindV4,
  resolutions: readonly SyncArchiveBlobResolutionV4[],
): SyncArchiveSegmentV4[] {
  return segments.map((segment, index) => ({
    path: segment.path,
    blobSha: resolutions[index].blobSha,
    sha256: segment.sha256,
    size: resolutions[index].size,
    month: segment.month,
    count: segment.count,
    firstId: segment.firstId,
    lastId: segment.lastId,
    firstCreatedAt: segment.firstCreatedAt,
    lastCreatedAt: segment.lastCreatedAt,
    legacy: true,
  })).map((segment) => {
    validateSegment(segment, kind);
    return segment;
  });
}

function assertResolution(value: unknown, path: string): asserts value is SyncArchiveBlobResolutionV4 {
  if (!isRecord(value)) throw new Error(`v3 migration resolver returned no blob metadata for ${path}`);
  assertDigest(value.blobSha, `resolver(${path}).blobSha`, SHA1);
  assertSize(value.size, `resolver(${path}).size`);
}

function finishMigration(
  catalog: SyncArchiveCatalogV3,
  attemptResolutions: readonly SyncArchiveBlobResolutionV4[],
  runResolutions: readonly SyncArchiveBlobResolutionV4[],
): SyncArchiveCatalogV4 {
  const attemptSegments = dedupeSyncArchiveSegmentsV4(mapV3Segments(catalog.attemptSegments, "attempts", attemptResolutions), "attempts");
  const practiceRunSegments = dedupeSyncArchiveSegmentsV4(mapV3Segments(catalog.practiceRunSegments, "practice-runs", runResolutions), "practice-runs");
  const migrated: SyncArchiveCatalogV4 = {
    formatVersion: 4,
    generatedAt: catalog.generatedAt,
    attemptSegments,
    practiceRunSegments,
    counts: {
      attempts: attemptSegments.reduce((total, segment) => total + segment.count, 0),
      practiceRuns: practiceRunSegments.reduce((total, segment) => total + segment.count, 0),
    },
  };
  validateSyncArchiveCatalogV4(migrated);
  return migrated;
}

/**
 * Explicitly migrate a v3 catalog.  A synchronous resolver returns a catalog
 * synchronously; if any resolver result is a Promise, a Promise of the same
 * catalog is returned.  Legacy paths are retained only with `legacy:true`.
 */
export function migrateV3ArchiveCatalog(catalog: SyncArchiveCatalogV3, resolveBlob: (path: string) => SyncArchiveBlobResolutionV4): SyncArchiveCatalogV4;
export function migrateV3ArchiveCatalog(catalog: SyncArchiveCatalogV3, resolveBlob: (path: string) => PromiseLike<SyncArchiveBlobResolutionV4>): Promise<SyncArchiveCatalogV4>;
export function migrateV3ArchiveCatalog(catalog: SyncArchiveCatalogV3, resolveBlob: ResolveV3ArchiveBlob): SyncArchiveCatalogV4 | Promise<SyncArchiveCatalogV4>;
export function migrateV3ArchiveCatalog(catalog: SyncArchiveCatalogV3, resolveBlob: ResolveV3ArchiveBlob): SyncArchiveCatalogV4 | Promise<SyncArchiveCatalogV4> {
  validateV3Catalog(catalog);
  if (typeof resolveBlob !== "function") throw new TypeError("v3 migration requires resolveBlob(path)");
  const attemptResults = catalog.attemptSegments.map((segment) => resolveBlob(segment.path));
  const runResults = catalog.practiceRunSegments.map((segment) => resolveBlob(segment.path));
  const all = [...attemptResults, ...runResults];
  const finalize = (resolved: readonly unknown[]): SyncArchiveCatalogV4 => {
    const attempts = resolved.slice(0, attemptResults.length);
    const runs = resolved.slice(attemptResults.length);
    attempts.forEach((value, index) => assertResolution(value, catalog.attemptSegments[index].path));
    runs.forEach((value, index) => assertResolution(value, catalog.practiceRunSegments[index].path));
    return finishMigration(catalog, attempts as SyncArchiveBlobResolutionV4[], runs as SyncArchiveBlobResolutionV4[]);
  };
  if (all.some(isThenable)) return Promise.all(all).then(finalize);
  return finalize(all);
}

export async function migrateV3ArchiveCatalogAsync(catalog: SyncArchiveCatalogV3, resolveBlob: ResolveV3ArchiveBlob): Promise<SyncArchiveCatalogV4> {
  return await migrateV3ArchiveCatalog(catalog, resolveBlob);
}

/** Stable JSON serialization is useful when placing the catalog behind a digest path. */
export function canonicalizeSyncArchiveCatalogV4(catalog: SyncArchiveCatalogV4): SyncArchiveCatalogV4 {
  validateSyncArchiveCatalogV4(catalog);
  return {
    formatVersion: 4,
    generatedAt: catalog.generatedAt,
    attemptSegments: catalog.attemptSegments.map(cloneSegment),
    practiceRunSegments: catalog.practiceRunSegments.map(cloneSegment),
    counts: { ...catalog.counts },
  };
}
