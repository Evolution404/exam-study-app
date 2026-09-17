import assert from "node:assert/strict";
import { reclaimableTombstones } from "../../src/lib/sync/github-sync-engine";
import type { Tombstone } from "../../src/lib/db/types";

const tombstone: Tombstone = { key: "question:q1", entityType: "question", entityId: "q1", deletedAt: "2026-08-13T00:00:00.000Z", deviceId: "deleter", eventId: "evt", sequence: 1 };

// 水位 syncedAt 非法时，应保守处理：不允许回收墓碑。
const result = reclaimableTombstones([tombstone], {
  devices: { other: { cursors: {}, syncedAt: "not-a-date" } },
  headCursors: { other: 1 },
  selfDeviceId: "self",
  now: "2026-08-13T00:00:00.000Z",
});
assert.equal(result.keep.length, 1, "非法 syncedAt 不得让未确认设备被当作已退役，从而错误回收墓碑");
assert.equal(result.dropped, 0, "非法 syncedAt 时不应回收任何墓碑");

console.log("sync tombstone retired date tests passed");
