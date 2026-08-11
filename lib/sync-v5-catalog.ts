import type { SyncArchiveCatalogV5, SyncArchiveSegmentV5 } from "./types";

/** The two independently-retained history streams in an archive catalog. */
export type SyncArchiveKindV5 = "attempts" | "practice-runs";

/** Ordinary v5 archive paths are immutable and content addressed. */
export const SYNC_V5_ARCHIVE_PREFIX = "sync/v5/archive/";
export const SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX = `${SYNC_V5_ARCHIVE_PREFIX}attempts/`;
export const SYNC_V5_ARCHIVE_PRACTICE_RUNS_PREFIX = `${SYNC_V5_ARCHIVE_PREFIX}practice-runs/`;

/** A segment contains at most this many rows on the wire. */
export const SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT = 500;
/** Keep archive descriptors subject to the same bounded immutable-file limit as v5 heads. */
export const SYNC_V5_ARCHIVE_SEGMENT_MAX_BYTES = 16 * 1024 * 1024;
export const SYNC_V5_ARCHIVE_MAX_SEGMENT_COUNT = SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT;
export const SYNC_V5_MAX_ARCHIVE_SEGMENT_COUNT = SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT;

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_MAX_LENGTH = 1024;

/** Fields required by the v5 path builder; `path` is deliberately not accepted. */
export type SyncArchiveSegmentInputV5 = Omit<SyncArchiveSegmentV5, "path">;

function fail(message: string): never {
  throw new Error(`invalid v5 archive catalog: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > SYNC_V5_ARCHIVE_SEGMENT_MAX_BYTES) {
    fail(`${field} is outside the archive byte limit`);
  }
}

function assertCount(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT) {
    fail(`${field} must be between 1 and ${SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT}`);
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

function prefixFor(kind: SyncArchiveKindV5): string {
  return kind === "attempts" ? SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX : SYNC_V5_ARCHIVE_PRACTICE_RUNS_PREFIX;
}

function kindForPath(path: string): SyncArchiveKindV5 | undefined {
  if (path.startsWith(SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX)) return "attempts";
  if (path.startsWith(SYNC_V5_ARCHIVE_PRACTICE_RUNS_PREFIX)) return "practice-runs";
  return undefined;
}

function pathParts(path: string, kind: SyncArchiveKindV5): { month: string; digest: string } | undefined {
  const prefix = prefixFor(kind);
  const match = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}(\\d{4}-(?:0[1-9]|1[0-2]))/([a-f0-9]{24,64})\\.json$`).exec(path);
  return match ? { month: match[1], digest: match[2] } : undefined;
}

function assertSegmentPath(path: unknown, kind: SyncArchiveKindV5, sha256: string): asserts path is string {
  assertSafeRelativePath(path, "segment.path");
  const parts = pathParts(path, kind);
  if (!parts) {
    fail(`segment.path must use ${prefixFor(kind)}<month>/<digest>.json`);
  }
  if (!sha256.startsWith(parts.digest)) {
    fail(`segment.path digest does not match segment.sha256`);
  }
}

function segmentEqual(a: SyncArchiveSegmentV5, b: SyncArchiveSegmentV5): boolean {
  return a.path === b.path
    && a.blobSha === b.blobSha
    && a.sha256 === b.sha256
    && a.size === b.size
    && a.month === b.month
    && a.count === b.count
    && a.firstId === b.firstId
    && a.lastId === b.lastId
    && a.firstCreatedAt === b.firstCreatedAt
    && a.lastCreatedAt === b.lastCreatedAt;
}

function cloneSegment(segment: SyncArchiveSegmentV5): SyncArchiveSegmentV5 {
  return { ...segment };
}

function validateSegment(value: unknown, kind: SyncArchiveKindV5): asserts value is SyncArchiveSegmentV5 {
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
  if ("legacy" in value) fail(`${kind} segment contains a removed legacy marker`);
  assertSegmentPath(value.path, kind, value.sha256);
  const parsed = pathParts(value.path, kind);
  if (!parsed || parsed.month !== value.month) fail(`${kind} segment path month does not match month`);
}

function assertSorted(segments: readonly SyncArchiveSegmentV5[], kind: SyncArchiveKindV5): void {
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index - 1].path.localeCompare(segments[index].path) >= 0) {
      fail(`${kind} segments must be sorted by path`);
    }
  }
}

function assertCatalogCounts(catalog: Pick<SyncArchiveCatalogV5, "attemptSegments" | "practiceRunSegments" | "counts">): void {
  const attempts = catalog.attemptSegments.reduce((total, segment) => total + segment.count, 0);
  const practiceRuns = catalog.practiceRunSegments.reduce((total, segment) => total + segment.count, 0);
  if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(practiceRuns)
    || catalog.counts.attempts !== attempts || catalog.counts.practiceRuns !== practiceRuns) {
    fail("counts do not match segment counts");
  }
}

/** Strictly validate an unknown value as a v5 archive catalog. */
export function validateSyncArchiveCatalogV5(value: unknown): asserts value is SyncArchiveCatalogV5 {
  if (!isRecord(value) || value.formatVersion !== 5) fail("formatVersion must be 5");
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
  const ids = new Map<SyncArchiveKindV5, Set<string>>([
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
  assertCatalogCounts(value as unknown as SyncArchiveCatalogV5);
}

export function isSyncArchiveCatalogV5(value: unknown): value is SyncArchiveCatalogV5 {
  try {
    validateSyncArchiveCatalogV5(value);
    return true;
  } catch {
    return false;
  }
}

/** Build the ordinary content-addressed path for a v5 archive segment. */
export function syncV5ArchiveSegmentPath(kind: SyncArchiveKindV5, month: string, sha256: string): string {
  if (kind !== "attempts" && kind !== "practice-runs") throw new TypeError("invalid v5 archive kind");
  assertMonth(month, "month");
  assertDigest(sha256, "sha256", SHA256);
  return `${prefixFor(kind)}${month}/${sha256}.json`;
}

/** Create a content-addressed v5 archive segment. */
export function createSyncArchiveSegmentV5(kind: SyncArchiveKindV5, input: SyncArchiveSegmentInputV5): SyncArchiveSegmentV5 {
  const segment: SyncArchiveSegmentV5 = {
    ...input,
    path: syncV5ArchiveSegmentPath(kind, input.month, input.sha256),
  };
  validateSegment(segment, kind);
  return cloneSegment(segment);
}

export const makeSyncArchiveSegmentV5 = createSyncArchiveSegmentV5;

/** Return an empty, valid v5 catalog. */
export function createSyncArchiveCatalogV5(generatedAt = new Date().toISOString()): SyncArchiveCatalogV5 {
  assertDate(generatedAt, "generatedAt");
  return {
    formatVersion: 5,
    generatedAt,
    attemptSegments: [],
    practiceRunSegments: [],
    counts: { attempts: 0, practiceRuns: 0 },
  };
}

function inferredKind(segment: SyncArchiveSegmentV5): SyncArchiveKindV5 {
  const kind = kindForPath(segment.path);
  if (!kind) throw new Error(`cannot infer archive kind from path: ${segment.path}`);
  return kind;
}

/**
 * Deduplicate immutable segments without mutating the input.  Exact content
 * duplicates and repeated boundary ids are idempotent.  A path that names a
 * different immutable descriptor is always a hard collision.
 */
export function dedupeSyncArchiveSegmentsV5(
  segments: readonly SyncArchiveSegmentV5[],
  kind?: SyncArchiveKindV5,
): SyncArchiveSegmentV5[] {
  const byPath = new Map<string, SyncArchiveSegmentV5>();
  const byContent = new Map<string, SyncArchiveSegmentV5>();
  const byId = new Map<string, SyncArchiveSegmentV5>();
  const result: SyncArchiveSegmentV5[] = [];

  for (const candidate of segments) {
    const candidateKind = kind ?? inferredKind(candidate);
    validateSegment(candidate, candidateKind);
    const existingPath = byPath.get(candidate.path);
    if (existingPath) {
      if (!segmentEqual(existingPath, candidate)) throw new Error(`v5 archive segment path collision: ${candidate.path}`);
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
    let repeatedId: SyncArchiveSegmentV5 | undefined;
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
      throw new Error(`v5 archive segment id collision: ${candidate.firstId}`);
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

export const dedupeSyncV5ArchiveSegments = dedupeSyncArchiveSegmentsV5;

function normalizeAppendArguments(
  kindOrSegments: SyncArchiveKindV5 | readonly SyncArchiveSegmentV5[] | {
    attemptSegments?: readonly SyncArchiveSegmentV5[];
    practiceRunSegments?: readonly SyncArchiveSegmentV5[];
  },
  maybeSegmentsOrKind?: SyncArchiveKindV5 | readonly SyncArchiveSegmentV5[],
): { attempts: SyncArchiveSegmentV5[]; practiceRuns: SyncArchiveSegmentV5[]; explicitSingleKind?: SyncArchiveKindV5 } {
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
    const attempts: SyncArchiveSegmentV5[] = [];
    const practiceRuns: SyncArchiveSegmentV5[] = [];
    for (const segment of kindOrSegments) {
      const inferred = inferredKind(segment);
      (inferred === "attempts" ? attempts : practiceRuns).push(segment);
    }
    return { attempts, practiceRuns };
  }
  if (maybeSegmentsOrKind !== undefined) throw new TypeError("bulk archive append accepts one argument");
  const bulk = kindOrSegments as {
    attemptSegments?: readonly SyncArchiveSegmentV5[];
    practiceRunSegments?: readonly SyncArchiveSegmentV5[];
  };
  return {
    attempts: [...(bulk.attemptSegments ?? [])],
    practiceRuns: [...(bulk.practiceRunSegments ?? [])],
  };
}

function assertOrdinaryAppendSegment(segment: SyncArchiveSegmentV5, kind: SyncArchiveKindV5): void {
  validateSegment(segment, kind);
}

export function appendSyncArchiveSegmentsV5(
  catalog: SyncArchiveCatalogV5,
  kind: SyncArchiveKindV5,
  additions: readonly SyncArchiveSegmentV5[],
): SyncArchiveCatalogV5;
export function appendSyncArchiveSegmentsV5(
  catalog: SyncArchiveCatalogV5,
  additions: readonly SyncArchiveSegmentV5[],
  kind?: SyncArchiveKindV5,
): SyncArchiveCatalogV5;
export function appendSyncArchiveSegmentsV5(
  catalog: SyncArchiveCatalogV5,
  additions: {
    attemptSegments?: readonly SyncArchiveSegmentV5[];
    practiceRunSegments?: readonly SyncArchiveSegmentV5[];
  },
): SyncArchiveCatalogV5;
export function appendSyncArchiveSegmentsV5(
  catalog: SyncArchiveCatalogV5,
  kindOrSegments: SyncArchiveKindV5 | readonly SyncArchiveSegmentV5[] | {
    attemptSegments?: readonly SyncArchiveSegmentV5[];
    practiceRunSegments?: readonly SyncArchiveSegmentV5[];
  },
  maybeSegmentsOrKind?: SyncArchiveKindV5 | readonly SyncArchiveSegmentV5[],
): SyncArchiveCatalogV5 {
  validateSyncArchiveCatalogV5(catalog);
  const normalized = normalizeAppendArguments(kindOrSegments, maybeSegmentsOrKind);
  const attempts = normalized.attempts;
  const practiceRuns = normalized.practiceRuns;
  for (const segment of attempts) assertOrdinaryAppendSegment(segment, "attempts");
  for (const segment of practiceRuns) assertOrdinaryAppendSegment(segment, "practice-runs");
  const nextAttempts = dedupeSyncArchiveSegmentsV5([...catalog.attemptSegments, ...attempts], "attempts");
  const nextPracticeRuns = dedupeSyncArchiveSegmentsV5([...catalog.practiceRunSegments, ...practiceRuns], "practice-runs");
  const next: SyncArchiveCatalogV5 = {
    formatVersion: 5,
    generatedAt: catalog.generatedAt,
    attemptSegments: nextAttempts,
    practiceRunSegments: nextPracticeRuns,
    counts: {
      attempts: nextAttempts.reduce((total, segment) => total + segment.count, 0),
      practiceRuns: nextPracticeRuns.reduce((total, segment) => total + segment.count, 0),
    },
  };
  validateSyncArchiveCatalogV5(next);
  return next;
}

export const appendSyncV5ArchiveSegments = appendSyncArchiveSegmentsV5;
export const appendSyncArchiveCatalogV5 = appendSyncArchiveSegmentsV5;

/** Stable JSON serialization is useful when placing the catalog behind a digest path. */
export function canonicalizeSyncArchiveCatalogV5(catalog: SyncArchiveCatalogV5): SyncArchiveCatalogV5 {
  validateSyncArchiveCatalogV5(catalog);
  return {
    formatVersion: 5,
    generatedAt: catalog.generatedAt,
    attemptSegments: catalog.attemptSegments.map(cloneSegment),
    practiceRunSegments: catalog.practiceRunSegments.map(cloneSegment),
    counts: { ...catalog.counts },
  };
}
