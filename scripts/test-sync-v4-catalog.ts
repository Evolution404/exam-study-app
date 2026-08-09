import assert from "node:assert/strict";
import {
  SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX,
  SYNC_V4_ARCHIVE_PRACTICE_RUNS_PREFIX,
  SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT,
  appendSyncArchiveSegmentsV4,
  createSyncArchiveCatalogV4,
  createSyncArchiveSegmentV4,
  dedupeSyncArchiveSegmentsV4,
  syncV4ArchiveSegmentPath,
  validateSyncArchiveCatalogV4,
} from "../lib/sync-v4-catalog";
import type { SyncArchiveSegmentV4 } from "../lib/types";

const generatedAt = "2026-08-09T00:00:00.000Z";
const timestamp = "2026-08-09T01:02:03.004Z";
const sha1 = (digit: string) => digit.repeat(40);
const sha256 = (digit: string) => digit.repeat(64);

function segment(kind: "attempts" | "practice-runs", digit: string, id = `${kind}-${digit}`, count = 1): SyncArchiveSegmentV4 {
  return createSyncArchiveSegmentV4(kind, {
    blobSha: sha1(digit),
    sha256: sha256(digit),
    size: 100,
    month: "2026-08",
    count,
    firstId: id,
    lastId: id,
    firstCreatedAt: timestamp,
    lastCreatedAt: timestamp,
  });
}

function expectThrow(action: () => unknown, pattern: RegExp): void {
  assert.throws(action, pattern);
}

const empty = createSyncArchiveCatalogV4(generatedAt);
validateSyncArchiveCatalogV4(empty);
assert.equal(syncV4ArchiveSegmentPath("attempts", "2026-08", sha256("a")), `${SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX}2026-08/${sha256("a")}.json`);
assert.equal(syncV4ArchiveSegmentPath("practice-runs", "2026-08", sha256("b")), `${SYNC_V4_ARCHIVE_PRACTICE_RUNS_PREFIX}2026-08/${sha256("b")}.json`);

// Exact segment and catalog boundaries are valid; 501 rows are not.
const one = segment("attempts", "a", "attempt-a", SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT);
const catalog = appendSyncArchiveSegmentsV4(empty, "attempts", [one]);
assert.equal(catalog.counts.attempts, SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT);
expectThrow(() => createSyncArchiveSegmentV4("attempts", { ...one, count: SYNC_V4_ARCHIVE_SEGMENT_MAX_COUNT + 1, path: undefined } as never), /count/);

// Appending the same immutable segment repeatedly is idempotent and does not mutate the input.
const twice = appendSyncArchiveSegmentsV4(catalog, "attempts", [one]);
assert.equal(twice.attemptSegments.length, 1);
assert.equal(catalog.attemptSegments.length, 1);
const other = segment("practice-runs", "b");
const both = appendSyncArchiveSegmentsV4(twice, { attemptSegments: [one], practiceRunSegments: [other] });
assert.deepEqual(both.practiceRunSegments.map((item) => item.path), [other.path]);

// Same path with a different immutable descriptor is a hard collision.
expectThrow(() => appendSyncArchiveSegmentsV4(catalog, "attempts", [{ ...one, size: 101 }]), /path collision/);
// A repeated boundary id with different content is also rejected.
expectThrow(() => appendSyncArchiveSegmentsV4(catalog, "attempts", [segment("attempts", "c", "attempt-a")]), /id collision/);

// Duplicate content under a shortened content-addressed pathname is deduped.
const shortPath = { ...other, path: `${SYNC_V4_ARCHIVE_PRACTICE_RUNS_PREFIX}2026-08/${sha256("b").slice(0, 24)}.json` };
assert.equal(dedupeSyncArchiveSegmentsV4([other, shortPath], "practice-runs").length, 1);

// Hostile paths, wrong digest algorithms and inconsistent metadata are rejected.
expectThrow(() => validateSyncArchiveCatalogV4({ ...empty, attemptSegments: [{ ...one, path: "../escape.json" }], counts: { attempts: one.count, practiceRuns: 0 } }), /safe relative path|dot path|archive path/);
expectThrow(() => validateSyncArchiveCatalogV4({ ...empty, attemptSegments: [{ ...one, path: `${SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX}2026-08/${sha256("z")}.json` }], counts: { attempts: one.count, practiceRuns: 0 } }), /digest/);
expectThrow(() => validateSyncArchiveCatalogV4({ ...empty, attemptSegments: [{ ...one, blobSha: "not-a-sha" }], counts: { attempts: one.count, practiceRuns: 0 } }), /blobSha/);
expectThrow(() => validateSyncArchiveCatalogV4({ ...empty, attemptSegments: [{ ...one, month: "2026-07" }], counts: { attempts: one.count, practiceRuns: 0 } }), /month/);
expectThrow(() => validateSyncArchiveCatalogV4({ ...empty, attemptSegments: [{ ...one, path: `sync/v3/archive/attempts/2026-08/${sha256("a")}.json` }], counts: { attempts: one.count, practiceRuns: 0 } }), /segment.path/);
expectThrow(() => validateSyncArchiveCatalogV4({ ...empty, attemptSegments: [{ ...one, path: `${SYNC_V4_ARCHIVE_ATTEMPTS_PREFIX}2026-08/${sha256("c")}.json`, sha256: sha256("c"), blobSha: sha1("c"), firstId: "attempt-c", lastId: "attempt-c" }, one], counts: { attempts: one.count * 2, practiceRuns: 0 } }), /sorted|duplicate/);

console.log("sync v4 catalog tests passed: validation, content-addressed paths, bounded segments, dedupe and hostile inputs");
