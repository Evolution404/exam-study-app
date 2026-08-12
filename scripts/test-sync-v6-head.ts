import assert from "node:assert/strict";
import {
  SYNC_V6_ARCHIVE_CATALOG_PREFIX,
  SYNC_V6_CHECKPOINT_PREFIX,
  SYNC_V6_EVENT_PREFIX,
  SYNC_V6_HEAD_PATH,
  SYNC_V6_MAX_EVENT_BYTES,
  SYNC_V6_MAX_EVENT_PAGE_BYTES,
  SYNC_V6_MAX_HOT_EVENT_BYTES,
  SYNC_V6_ASSET_PREFIX,
  assertSyncV6HotTail,
  assertSyncV6Path,
  createSyncV6PublicationPlan,
  encodeSyncV6Event,
  encodeSyncV6EventPage,
  paginateSyncV6Events,
  planSyncV6HotTail,
  validateSyncHeadV6,
} from "../lib/sync-v6-head";
import type { SyncHeadV6, SyncV6Descriptor, SyncV6EventPageDescriptor } from "../lib/sync-v6-head";

const generatedAt = "2026-08-11T00:00:00.000Z";
const sha1 = (digit: string) => digit.repeat(40);
const sha256 = (digit: string) => digit.repeat(64);
const descriptor = (prefix: string, digit: string): SyncV6Descriptor => ({
  path: `${prefix}${sha256(digit)}.json`, blobSha: sha1(digit), sha256: sha256(digit), size: 128,
});
const page = (digit: string, count = 2, size = 128): SyncV6EventPageDescriptor => ({
  path: `${SYNC_V6_EVENT_PREFIX}${sha256(digit)}.json`, blobSha: sha1(digit), sha256: sha256(digit), size, count,
  deviceCursors: { "device-a": count },
});

const empty: SyncHeadV6 = {
  formatVersion: 6,
  generatedAt,
  checkpoint: descriptor(SYNC_V6_CHECKPOINT_PREFIX, "a"),
  archiveCatalog: descriptor(SYNC_V6_ARCHIVE_CATALOG_PREFIX, "b"),
  eventPages: [],
};
validateSyncHeadV6(empty);
assertSyncV6Path(SYNC_V6_HEAD_PATH, "head");
assertSyncV6Path(`${SYNC_V6_ASSET_PREFIX}${sha256("c")}.webp`, "asset");

assert.throws(() => validateSyncHeadV6({ ...empty, checkpoint: { ...empty.checkpoint, path: `${SYNC_V6_CHECKPOINT_PREFIX}${"d".repeat(64)}.json` } }), /path digest/);
assert.throws(() => assertSyncV6Path("sync/v6/assets/not-a-hash.gif", "asset"), /asset path/);
assert.throws(() => validateSyncHeadV6({ ...empty, eventPages: [page("a"), page("a")] }), /duplicate path/);
assert.throws(() => validateSyncHeadV6({ ...empty, eventPages: [{ ...page("a"), size: SYNC_V6_MAX_EVENT_PAGE_BYTES + 1 }] }), /byte limit/);

// UTF-8, not JavaScript UTF-16 length, controls both event and page limits.
const chinese = { stem: "题".repeat(100), answer: "甲" };
assert.equal(encodeSyncV6Event(chinese).byteLength, new TextEncoder().encode(JSON.stringify(chinese)).byteLength);
assert.throws(() => encodeSyncV6Event({ value: "中".repeat(SYNC_V6_MAX_EVENT_BYTES) }), /UTF-8 bytes/);
assert.throws(() => encodeSyncV6EventPage(Array.from({ length: 2 }, () => ({ value: "x".repeat(SYNC_V6_MAX_EVENT_PAGE_BYTES / 2) }))), /event page exceeds/);

const events = Array.from({ length: 6000 }, (_, index) => ({ id: index, stem: "题目内容".repeat(100) }));
const pages = paginateSyncV6Events(events);
assert.ok(pages.length > Math.ceil(events.length / 250));
assert.ok(pages.every((item) => item.count <= 250 && item.size <= SYNC_V6_MAX_EVENT_PAGE_BYTES));
const plan = planSyncV6HotTail(events);
assert.equal(plan.requiresCheckpoint, true, "6,000-question import must require checkpoint/archive");
assert.ok(plan.archived.length > 0);
assert.ok(plan.hotBytes <= SYNC_V6_MAX_HOT_EVENT_BYTES);
assert.throws(() => assertSyncV6HotTail(events), /checkpoint\/archive/);
assert.equal(assertSyncV6HotTail(events, { checkpointPublished: true }).requiresCheckpoint, true);

// A legacy migration source marker on an existing head is ignored for
// validation: remote heads created before the v5 cleanup may still carry it,
// while new publications omit the field entirely.
validateSyncHeadV6({ ...empty, source: { protocol: 5, headPath: "sync/v5/head.json", headBlobSha: sha1("f"), generatedAt } });
validateSyncHeadV6({ ...empty, source: { protocol: 4, headPath: "sync/v4/head.json", headBlobSha: sha1("f"), generatedAt } });

const publication = createSyncV6PublicationPlan({
  assets: [{ path: `${SYNC_V6_ASSET_PREFIX}${sha256("1")}.png`, bytes: "asset", kind: "asset" }],
  immutable: [{ path: `${SYNC_V6_CHECKPOINT_PREFIX}${sha256("2")}.json`, bytes: "checkpoint", kind: "checkpoint" }],
  head: empty,
  expectedHeadSha: sha1("e"),
});
assert.deepEqual(publication.order, ["assets", "immutable", "head-cas"]);

console.log("sync v6 head tests passed: strict hash paths, UTF-8/page limits, 6,000-event checkpoint tail and publish ordering");
