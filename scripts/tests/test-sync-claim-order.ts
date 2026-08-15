import assert from "node:assert/strict";
import "fake-indexeddb/auto";
import { claimPendingChangeSetsV7, dbV6, enqueueChangeSetV7, resetV6Database } from "../../src/lib/db/db-v6";

const memoryLocalStorage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => memoryLocalStorage.get(key) ?? null,
    setItem: (key: string, value: string) => void memoryLocalStorage.set(key, value),
    removeItem: (key: string) => void memoryLocalStorage.delete(key),
  },
});

await resetV6Database();
// createdAt 故意乱序：最早创建的事件后写入，主键 id 顺序与时间顺序不一致。
await enqueueChangeSetV7([{ kind: "bank.create", bank: { id: "bank-3", name: "第三个", sortOrder: 0, questionCount: 0, importedAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", deviceId: "device-a" } }], "2026-08-13T00:00:03.000Z", { localSequence: 10 });
await enqueueChangeSetV7([{ kind: "bank.create", bank: { id: "bank-1", name: "第一个", sortOrder: 0, questionCount: 0, importedAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", deviceId: "device-a" } }], "2026-08-13T00:00:01.000Z", { localSequence: 9 });
await enqueueChangeSetV7([{ kind: "bank.create", bank: { id: "bank-2", name: "第二个", sortOrder: 0, questionCount: 0, importedAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", deviceId: "device-a" } }], "2026-08-13T00:00:02.000Z", { localSequence: 11 });

const claim = await claimPendingChangeSetsV7();
const order = claim.records.map((record) => record.localSequence);
assert.deepEqual(order, [9, 11, 10], "claim 应按 createdAt/deviceId/localSequence 的确定顺序返回待同步变更");

await dbV6.close();
console.log("sync claim order tests passed");
