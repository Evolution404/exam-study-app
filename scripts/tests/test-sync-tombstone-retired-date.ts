import assert from "node:assert/strict";
import { reclaimableTombstonesV7 } from "../../src/lib/sync/github-sync-v7";
import type { TombstoneV6 } from "../../src/lib/db/v6-types";

const tombstone: TombstoneV6 = { key: "question:q1", entityType: "question", entityId: "q1", deletedAt: "2026-08-13T00:00:00.000Z", deviceId: "deleter", eventId: "evt", sequence: 1 };

// 水位 syncedAt 非法时，应保守处理：不允许回收墓碑。
const result = reclaimableTombstonesV7([tombstone], {
  devices: { other: { cursors: {}, syncedAt: "not-a-date" } },
  headCursors: { other: 1 },
  selfDeviceId: "self",
  now: "2026-08-13T00:00:00.000Z",
});
assert.equal(result.keep.length, 1, "非法 syncedAt 不得让未确认设备被当作已退役，从而错误回收墓碑");
assert.equal(result.dropped, 0, "非法 syncedAt 时不应回收任何墓碑");

console.log("sync tombstone retired date tests passed");
