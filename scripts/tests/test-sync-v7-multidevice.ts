import assert from "node:assert/strict";
import { createChangeSetV7 } from "../../lib/change-set-v7";
import { reduceChangeSetV7, type ChangeSetProjectionV7 } from "../../lib/change-set-v7-projection";
import { replayRemoteResilient } from "../../lib/github-sync-v7";
import { planSyncV7Compaction, replaySyncV7Segments } from "../../lib/sync-v7-head";
import type { BankQuestionMembership, BankV6, QuestionV6 } from "../../lib/v6-types";

const at = "2026-08-13T00:00:00.000Z";
const bank: BankV6 = { id: "bank-1", name: "基础题库", sortOrder: 0, questionCount: 0, importedAt: at, updatedAt: at, deviceId: "seed" };
const empty: ChangeSetProjectionV7 = { banks: [bank], bankFolders: [], questions: [], memberships: [], imageAssets: [], attempts: [], attemptStats: [], attemptDailyStats: [], notes: [], practiceRuns: [], practiceRunStats: [], questionGroups: [], reviewRounds: [], reviewRoundProgress: [], tombstones: [] };

function question(id: string, deviceId: string): QuestionV6 {
  return { id, type: "单选", content: [{ id: "stem-0", type: "text", text: `题目 ${id}` }], options: [[{ id: "a", type: "text", text: "A" }], [{ id: "b", type: "text", text: "B" }]], answer: "A", tags: [], contentFingerprint: `fingerprint-${id}`, updatedAt: at, deviceId };
}

function membership(questionId: string, deviceId: string): BankQuestionMembership {
  return { key: `bank-1:${questionId}`, bankId: "bank-1", questionId, sortOrder: 0, addedAt: at, updatedAt: at, deviceId };
}

const deviceAImport = await createChangeSetV7({ id: "a-import", deviceId: "device-a", localSequence: 1, createdAt: at, mutations: [{ kind: "question.import", bank: { ...bank, id: "bank-a", name: "A 导入", deviceId: "device-a" }, questions: [question("question-a", "device-a")], memberships: [{ ...membership("question-a", "device-a"), key: "bank-a:question-a", bankId: "bank-a" }] }] });
const deviceBQuestion = await createChangeSetV7({ id: "b-question", deviceId: "device-b", localSequence: 1, createdAt: at, mutations: [{ kind: "question.upsert", question: question("question-b", "device-b") }, { kind: "membership.save", membership: membership("question-b", "device-b") }] });

// Both devices worked offline. CAS makes A generation 1; B rebases and becomes
// generation 2. Hash/path order is deliberately reversed and must not matter.
const wire = replaySyncV7Segments([
  { generation: 2, ordinal: 0, path: "sync/v7/segments/000.json", events: [deviceBQuestion] },
  { generation: 1, ordinal: 0, path: "sync/v7/segments/fff.json", events: [deviceAImport] },
]);
let merged = structuredClone(empty);
for (const change of wire) merged = reduceChangeSetV7(merged, change);
assert.equal(merged.questions.length, 2);
assert.equal(merged.memberships.length, 2);
assert.equal(merged.banks.find((item) => item.id === "bank-a")?.questionCount, 1, "atomic import must preserve its bank and membership");
assert.equal(merged.banks.find((item) => item.id === "bank-1")?.questionCount, 1, "question and membership must apply atomically");

// Same-millisecond concurrent edits converge to the CAS/replay winner, never
// wall-clock or path/hash order.
const editA = await createChangeSetV7({ id: "edit-a", deviceId: "device-a", localSequence: 2, createdAt: at, mutation: { kind: "bank.update", bank: { ...bank, name: "A 名称", deviceId: "device-a" } } });
const editB = await createChangeSetV7({ id: "edit-b", deviceId: "device-b", localSequence: 2, createdAt: at, mutation: { kind: "bank.update", bank: { ...bank, name: "B 名称", deviceId: "device-b" } } });
let left = structuredClone(empty);
for (const change of replaySyncV7Segments([{ generation: 8, ordinal: 0, events: [editB] }, { generation: 7, ordinal: 0, events: [editA] }])) left = reduceChangeSetV7(left, change);
let right = structuredClone(empty);
for (const change of replaySyncV7Segments([{ generation: 7, ordinal: 0, events: [editA] }, { generation: 8, ordinal: 0, events: [editB] }])) right = reduceChangeSetV7(right, change);
assert.equal(left.banks[0].name, "B 名称");
assert.deepEqual(left, right, "devices must converge despite download enumeration order");

// A stale device cannot resurrect a globally deleted entity: its rebased edit
// is rejected before publication and can be shown as blocked in event manager.
const deleted = await createChangeSetV7({ id: "delete", deviceId: "device-a", localSequence: 3, createdAt: at, mutation: { kind: "question.delete", questionId: "question-b", cascade: true, deletedAt: at } });
const staleEdit = await createChangeSetV7({ id: "stale", deviceId: "device-b", localSequence: 3, createdAt: at, mutation: { kind: "question.upsert", question: { ...question("question-b", "device-b"), answer: "B" } } });
const afterDelete = reduceChangeSetV7(merged, deleted);
assert.throws(() => reduceChangeSetV7(afterDelete, staleEdit), /不存在|conflict|deleted/i);

// Hazard 防御：远端（committed）回放路径没有 local-pending 那样的 per-record try/catch。
// 若一条已提交的远端变更与检查点里的墓碑冲突（理论上因「下载先于推送」极难触达，但需防御），
// replayRemoteResilient 应跳过该毒记录而非让整个 sync 抛错。此处 afterDelete 即「含墓碑的检查点投影」，
// staleEdit 即「后续 segment 里的陈旧 upsert」——单条 reduceChangeSetV7 会抛（上一行已证），但批量回放不得崩。
const resilient = replayRemoteResilient(afterDelete, [staleEdit]);
assert.deepEqual(resilient.skipped, ["stale"], "与墓碑冲突的远端变更应被跳过并记录其 id");
assert.equal(resilient.projection.questions.find((item) => item.id === "question-b"), undefined, "墓碑优先：被跳过的毒 upsert 不得让已删题复活");
assert.ok(resilient.projection.tombstones.some((item) => item.key === "question:question-b"), "墓碑应保留");
// 正常记录仍应照常应用（不被毒记录波及）
const otherQuestion = await createChangeSetV7({ id: "other", deviceId: "device-c", localSequence: 1, createdAt: at, mutation: { kind: "question.upsert", question: question("question-c", "device-c") } });
const mixed = replayRemoteResilient(afterDelete, [staleEdit, otherQuestion]);
assert.deepEqual(mixed.skipped, ["stale"], "毒记录被跳过");
assert.equal(mixed.projection.questions.find((item) => item.id === "question-c")?.id, "question-c", "毒记录前后的正常变更仍应正常应用");

// Repeated normal sync and CAS retries remain below the real aggregate byte
// threshold and therefore categorically cannot request a checkpoint.
for (let count = 1; count <= 100; count += 1) {
  const decision = planSyncV7Compaction({ head: { formatVersion: 7, vaultId: "vault", generatedAt: at, generation: count, metadata: { vaultId: "vault" }, checkpoint: { path: `sync/v7/checkpoints/${"a".repeat(64)}.json`, blobSha: "b".repeat(40), sha256: "a".repeat(64), size: 100 }, segments: [], cursors: {} }, hotBytes: count * 512 });
  assert.equal(decision.required, false);
  assert.equal(decision.checkpointAllowed, false);
}
assert.equal(planSyncV7Compaction({ hotBytes: 4 * 1024 * 1024 + 1 }).reason, "initialization");

console.log("sync v7 multi-device tests passed: offline merge, CAS ordering, same-ms convergence, stale resurrection blocking and hot-window discipline");
