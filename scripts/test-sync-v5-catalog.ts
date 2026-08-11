import assert from "node:assert/strict";
import {
  SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX,
  SYNC_V5_ARCHIVE_PRACTICE_RUNS_PREFIX,
  SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT,
  appendSyncArchiveSegmentsV5,
  createSyncArchiveCatalogV5,
  createSyncArchiveSegmentV5,
  dedupeSyncArchiveSegmentsV5,
  syncV5ArchiveSegmentPath,
  validateSyncArchiveCatalogV5,
} from "../lib/sync-v5-catalog";
import type { SyncArchiveSegmentV5 } from "../lib/types";

const generatedAt = "2026-08-09T00:00:00.000Z";
const timestamp = "2026-08-09T01:02:03.004Z";
const sha1 = (digit: string) => digit.repeat(40);
const sha256 = (digit: string) => digit.repeat(64);

function segment(kind: "attempts" | "practice-runs", digit: string, id = `${kind}-${digit}`, count = 1): SyncArchiveSegmentV5 {
  return createSyncArchiveSegmentV5(kind, {
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

const empty = createSyncArchiveCatalogV5(generatedAt);
validateSyncArchiveCatalogV5(empty);
assert.equal(syncV5ArchiveSegmentPath("attempts", "2026-08", sha256("a")), `${SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX}2026-08/${sha256("a")}.json`);
assert.equal(syncV5ArchiveSegmentPath("practice-runs", "2026-08", sha256("b")), `${SYNC_V5_ARCHIVE_PRACTICE_RUNS_PREFIX}2026-08/${sha256("b")}.json`);

// Exact segment and catalog boundaries are valid; 501 rows are not.
const one = segment("attempts", "a", "attempt-a", SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT);
const catalog = appendSyncArchiveSegmentsV5(empty, "attempts", [one]);
assert.equal(catalog.counts.attempts, SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT);
expectThrow(() => createSyncArchiveSegmentV5("attempts", { ...one, count: SYNC_V5_ARCHIVE_SEGMENT_MAX_COUNT + 1, path: undefined } as never), /count/);

// Appending the same immutable segment repeatedly is idempotent and does not mutate the input.
const twice = appendSyncArchiveSegmentsV5(catalog, "attempts", [one]);
assert.equal(twice.attemptSegments.length, 1);
assert.equal(catalog.attemptSegments.length, 1);
const other = segment("practice-runs", "b");
const both = appendSyncArchiveSegmentsV5(twice, { attemptSegments: [one], practiceRunSegments: [other] });
assert.deepEqual(both.practiceRunSegments.map((item) => item.path), [other.path]);

// Same path with a different immutable descriptor is a hard collision.
expectThrow(() => appendSyncArchiveSegmentsV5(catalog, "attempts", [{ ...one, size: 101 }]), /path collision/);
// A repeated boundary id with different content is also rejected.
expectThrow(() => appendSyncArchiveSegmentsV5(catalog, "attempts", [segment("attempts", "c", "attempt-a")]), /id collision/);

// Duplicate content under a shortened content-addressed pathname is deduped.
const shortPath = { ...other, path: `${SYNC_V5_ARCHIVE_PRACTICE_RUNS_PREFIX}2026-08/${sha256("b").slice(0, 24)}.json` };
assert.equal(dedupeSyncArchiveSegmentsV5([other, shortPath], "practice-runs").length, 1);

// Hostile paths, wrong digest algorithms and inconsistent metadata are rejected.
expectThrow(() => validateSyncArchiveCatalogV5({ ...empty, attemptSegments: [{ ...one, path: "../escape.json" }], counts: { attempts: one.count, practiceRuns: 0 } }), /safe relative path|dot path|archive path/);
expectThrow(() => validateSyncArchiveCatalogV5({ ...empty, attemptSegments: [{ ...one, path: `${SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX}2026-08/${sha256("z")}.json` }], counts: { attempts: one.count, practiceRuns: 0 } }), /digest/);
expectThrow(() => validateSyncArchiveCatalogV5({ ...empty, attemptSegments: [{ ...one, blobSha: "not-a-sha" }], counts: { attempts: one.count, practiceRuns: 0 } }), /blobSha/);
expectThrow(() => validateSyncArchiveCatalogV5({ ...empty, attemptSegments: [{ ...one, month: "2026-07" }], counts: { attempts: one.count, practiceRuns: 0 } }), /month/);
expectThrow(() => validateSyncArchiveCatalogV5({ ...empty, attemptSegments: [{ ...one, path: `sync/v3/archive/attempts/2026-08/${sha256("a")}.json` }], counts: { attempts: one.count, practiceRuns: 0 } }), /segment.path/);
expectThrow(() => validateSyncArchiveCatalogV5({ ...empty, attemptSegments: [{ ...one, path: `${SYNC_V5_ARCHIVE_ATTEMPTS_PREFIX}2026-08/${sha256("c")}.json`, sha256: sha256("c"), blobSha: sha1("c"), firstId: "attempt-c", lastId: "attempt-c" }, one], counts: { attempts: one.count * 2, practiceRuns: 0 } }), /sorted|duplicate/);

console.log("sync v5 catalog tests passed: validation, content-addressed paths, bounded segments, dedupe and hostile inputs");
