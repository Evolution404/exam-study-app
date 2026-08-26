/**
 * v7 change-set queue: publication records, claim lifecycle and queue helpers.
 */
import Dexie from "dexie";
import { type ChangeSetMutationV7, type ChangeSetV7 } from "../sync/change-set-v7-types";
import { createChangeSetV7 } from "../sync/change-set-v7-codec";

export type { ChangeSetMutationV7 } from "../sync/change-set-v7-types";
import { dbV7, getV7DeviceId, makeV7Id, nextV7Sequence, nowIso } from "./db-v7-core";

export type ChangeSetQueueStateV7 = "pending" | "claimed" | "blocked" | "committed";

export interface ChangeSetQueueRecordV7 extends ChangeSetV7 {
  state: ChangeSetQueueStateV7;
  claimId?: string;
  claimedAt?: string;
  committedAt?: string;
  blockedReason?: string;
}

export async function enqueueChangeSetV7(mutations: readonly ChangeSetMutationV7[], createdAt = nowIso(), options?: { localSequence?: number }): Promise<ChangeSetQueueRecordV7> {
  const deviceId = getV7DeviceId();
  const localSequence = options?.localSequence ?? await Dexie.waitFor(nextV7Sequence(deviceId));
  const changeSet = await Dexie.waitFor(createChangeSetV7({ deviceId, localSequence, createdAt, mutations }));
  const record: ChangeSetQueueRecordV7 = { ...changeSet, state: "pending" };
  await dbV7.changeSets.put(record);
  return record;
}

export async function listChangeSetsV7(states?: readonly ChangeSetQueueStateV7[]): Promise<ChangeSetQueueRecordV7[]> {
  const rows = states?.length ? await dbV7.changeSets.where("state").anyOf([...states]).toArray() : await dbV7.changeSets.toArray();
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

export async function claimPendingChangeSetsV7(snapshot?: readonly Pick<ChangeSetQueueRecordV7, "id" | "digest">[]): Promise<{ claimId: string; records: ChangeSetQueueRecordV7[] }> {
  const claimId = makeV7Id("claim");
  const claimedAt = nowIso();
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const pending = (await dbV7.changeSets.where("state").equals("pending").toArray())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
    const allowed = snapshot === undefined ? undefined : new Map(snapshot.map((record) => [record.id, record.digest]));
    const records = pending
      .filter((record) => allowed === undefined || allowed.get(record.id) === record.digest)
      .map((record) => ({ ...record, state: "claimed" as const, claimId, claimedAt }));
    if (records.length) await dbV7.changeSets.bulkPut(records);
    return { claimId, records };
  });
}

/** Mark only the exact rows covered by a checkpoint snapshot. */
export async function commitChangeSetSnapshotV7(
  snapshot: readonly Pick<ChangeSetQueueRecordV7, "id" | "digest">[],
  committedAt = nowIso(),
): Promise<number> {
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const expected = new Map(snapshot.map((record) => [record.id, record.digest]));
    const current = await dbV7.changeSets.toArray();
    const exact = current.filter((record) =>
      (record.state === "pending" || record.state === "blocked") && expected.get(record.id) === record.digest,
    );
    if (exact.length) await dbV7.changeSets.bulkPut(exact.map((record) => ({ ...record, state: "committed" as const, committedAt })));
    return exact.length;
  });
}

/** Apply a rebased blocked state only while the original pending digest still exists. */
export async function blockChangeSetSnapshotV7(records: readonly ChangeSetQueueRecordV7[]): Promise<number> {
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const current = await dbV7.changeSets.toArray();
    const byId = new Map(current.map((record) => [record.id, record]));
    const exact = records.filter((record) => {
      const live = byId.get(record.id);
      return live?.state === "pending" && live.digest === record.digest;
    });
    if (exact.length) await dbV7.changeSets.bulkPut(exact);
    return exact.length;
  });
}

export async function releaseChangeSetClaimV7(claimId: string): Promise<number> {
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const claimed = await dbV7.changeSets.where("claimId").equals(claimId).toArray();
    if (claimed.length) await dbV7.changeSets.bulkPut(claimed.map((record) => ({ ...record, state: "pending" as const, claimId: undefined, claimedAt: undefined })));
    return claimed.length;
  });
}

export async function commitChangeSetClaimV7(claimId: string, digests: ReadonlyMap<string, string>, committedAt = nowIso()): Promise<number> {
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const claimed = await dbV7.changeSets.where("claimId").equals(claimId).toArray();
    const exact = claimed.filter((record) => digests.get(record.id) === record.digest);
    if (exact.length) await dbV7.changeSets.bulkPut(exact.map((record) => ({ ...record, state: "committed" as const, committedAt })));
    return exact.length;
  });
}

/** internal：用裁剪后的 mutations 重建同一 change-set（保持 id/序号/时间不变）。 */
export async function rewriteChangeSetMutationsV7(record: ChangeSetQueueRecordV7, mutations: readonly ChangeSetMutationV7[]): Promise<ChangeSetQueueRecordV7> {
  const rebuilt = await Dexie.waitFor(createChangeSetV7({ id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, mutations }));
  return { ...record, ...rebuilt, state: "pending", claimId: undefined, claimedAt: undefined, blockedReason: undefined };
}

export async function discardPendingChangeSetV7(id: string): Promise<boolean> {
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const record = await dbV7.changeSets.get(id);
    if (!record || record.state !== "pending") return false;
    await dbV7.changeSets.delete(id);
    return true;
  });
}
