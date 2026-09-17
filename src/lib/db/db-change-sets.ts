/**
 * Change-set queue: publication records, claim lifecycle and queue helpers.
 */
import Dexie from "dexie";
import { type ChangeSetMutation, type ChangeSet } from "../sync/change-set-types";
import { createChangeSet } from "../sync/change-set-codec";

export type { ChangeSetMutation } from "../sync/change-set-types";
import { studyDb, getDeviceId, makeId, nextSequence, nowIso } from "./db-core";

export type ChangeSetQueueState = "pending" | "claimed" | "blocked" | "committed";

export interface ChangeSetQueueRecord extends ChangeSet {
  state: ChangeSetQueueState;
  claimId?: string;
  claimedAt?: string;
  committedAt?: string;
  blockedReason?: string;
}

export async function enqueueChangeSet(mutations: readonly ChangeSetMutation[], createdAt = nowIso(), options?: { localSequence?: number }): Promise<ChangeSetQueueRecord> {
  const deviceId = getDeviceId();
  const localSequence = options?.localSequence ?? await Dexie.waitFor(nextSequence(deviceId));
  const changeSet = await Dexie.waitFor(createChangeSet({ deviceId, localSequence, createdAt, mutations }));
  const record: ChangeSetQueueRecord = { ...changeSet, state: "pending" };
  await studyDb.changeSets.put(record);
  return record;
}

export async function listChangeSets(states?: readonly ChangeSetQueueState[]): Promise<ChangeSetQueueRecord[]> {
  const rows = states?.length ? await studyDb.changeSets.where("state").anyOf([...states]).toArray() : await studyDb.changeSets.toArray();
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

export async function claimPendingChangeSets(snapshot?: readonly Pick<ChangeSetQueueRecord, "id" | "digest">[]): Promise<{ claimId: string; records: ChangeSetQueueRecord[] }> {
  const claimId = makeId("claim");
  const claimedAt = nowIso();
  return studyDb.transaction("rw", studyDb.changeSets, async () => {
    const pending = (await studyDb.changeSets.where("state").equals("pending").toArray())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
    const allowed = snapshot === undefined ? undefined : new Map(snapshot.map((record) => [record.id, record.digest]));
    const records = pending
      .filter((record) => allowed === undefined || allowed.get(record.id) === record.digest)
      .map((record) => ({ ...record, state: "claimed" as const, claimId, claimedAt }));
    if (records.length) await studyDb.changeSets.bulkPut(records);
    return { claimId, records };
  });
}

/** Mark only the exact rows covered by a checkpoint snapshot. */
export async function commitChangeSetSnapshot(
  snapshot: readonly Pick<ChangeSetQueueRecord, "id" | "digest">[],
  committedAt = nowIso(),
): Promise<number> {
  return studyDb.transaction("rw", studyDb.changeSets, async () => {
    const expected = new Map(snapshot.map((record) => [record.id, record.digest]));
    const current = await studyDb.changeSets.toArray();
    const exact = current.filter((record) =>
      (record.state === "pending" || record.state === "blocked") && expected.get(record.id) === record.digest,
    );
    if (exact.length) await studyDb.changeSets.bulkPut(exact.map((record) => ({ ...record, state: "committed" as const, committedAt })));
    return exact.length;
  });
}

/** Apply a rebased blocked state only while the original pending digest still exists. */
export async function blockChangeSetSnapshot(records: readonly ChangeSetQueueRecord[]): Promise<number> {
  return studyDb.transaction("rw", studyDb.changeSets, async () => {
    const current = await studyDb.changeSets.toArray();
    const byId = new Map(current.map((record) => [record.id, record]));
    const exact = records.filter((record) => {
      const live = byId.get(record.id);
      return live?.state === "pending" && live.digest === record.digest;
    });
    if (exact.length) await studyDb.changeSets.bulkPut(exact);
    return exact.length;
  });
}

export async function releaseChangeSetClaim(claimId: string): Promise<number> {
  return studyDb.transaction("rw", studyDb.changeSets, async () => {
    const claimed = await studyDb.changeSets.where("claimId").equals(claimId).toArray();
    if (claimed.length) await studyDb.changeSets.bulkPut(claimed.map((record) => ({ ...record, state: "pending" as const, claimId: undefined, claimedAt: undefined })));
    return claimed.length;
  });
}

export async function commitChangeSetClaim(claimId: string, digests: ReadonlyMap<string, string>, committedAt = nowIso()): Promise<number> {
  return studyDb.transaction("rw", studyDb.changeSets, async () => {
    const claimed = await studyDb.changeSets.where("claimId").equals(claimId).toArray();
    const exact = claimed.filter((record) => digests.get(record.id) === record.digest);
    if (exact.length) await studyDb.changeSets.bulkPut(exact.map((record) => ({ ...record, state: "committed" as const, committedAt })));
    return exact.length;
  });
}

/** internal：用裁剪后的 mutations 重建同一 change-set（保持 id/序号/时间不变）。 */
export async function rewriteChangeSetMutations(record: ChangeSetQueueRecord, mutations: readonly ChangeSetMutation[]): Promise<ChangeSetQueueRecord> {
  const rebuilt = await Dexie.waitFor(createChangeSet({ id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, mutations }));
  return { ...record, ...rebuilt, state: "pending", claimId: undefined, claimedAt: undefined, blockedReason: undefined };
}

export async function discardPendingChangeSet(id: string): Promise<boolean> {
  return studyDb.transaction("rw", studyDb.changeSets, async () => {
    const record = await studyDb.changeSets.get(id);
    if (!record || record.state !== "pending") return false;
    await studyDb.changeSets.delete(id);
    return true;
  });
}
