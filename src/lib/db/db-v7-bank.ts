/**
 * v7 bank/folder/membership projections and bank-scoped queries.
 */
import {
  compareClock,
  dbV7,
  getV7DeviceId,
  makeV7Id,
  nextV7Sequence,
  nowIso,
  tombstoneKey,
  uniqueStrings,
} from "./db-v7-core";
import type { BankQuestionJoinV7 } from "./db-v7-core";
import { enqueueChangeSetV7 } from "./db-v7-change-sets";
import { updatePracticeRunStatsInTx } from "./db-v7-practice-stats";
import { deletePracticeRunInTx } from "./db-v7-practice-activity";
import { listPracticeRunsForBankV7 } from "./practice-run-read-v7";
import type { BankFolderV7, BankQuestionMembership, BankV7, QuestionV7 } from "./v7-types";
import { sha256DigestHex } from "../crypto/sha256";

/** internal，供兄弟模块使用 */
export async function refreshBankQuestionCountInTx(bankId: string): Promise<BankV7 | undefined> {
  const bank = await dbV7.banks.get(bankId);
  if (!bank) return undefined;
  const count = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).count();
  if (bank.questionCount === count) return bank;
  const updated = { ...bank, questionCount: count };
  await dbV7.banks.put(updated);
  return updated;
}

/** internal，供兄弟模块使用 */
export function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

/** internal，供兄弟模块使用 */
export function normalizeMembership(input: BankQuestionMembership): BankQuestionMembership {
  return { ...input, key: input.key || membershipKey(input.bankId, input.questionId) };
}

/** internal，供兄弟模块使用 */
export async function sha256Text(value: string): Promise<string> {
  return sha256DigestHex(new TextEncoder().encode(value));
}

/** internal，供兄弟模块使用 */
export function bankLabel(bank: BankV7): string {
  return bank.displayName?.trim() || bank.name;
}

/** Create a v7 bank.  Counts are always initialised from memberships (zero). */
export function createBankV7(name: string): Promise<BankV7>;
export function createBankV7(input: Partial<BankV7> & Pick<BankV7, "name">): Promise<BankV7>;
export async function createBankV7(input: string | (Partial<BankV7> & Pick<BankV7, "name">)): Promise<BankV7> {
  const values = typeof input === "string" ? { name: input } : input;
  const name = values.name.trim();
  if (!name) throw new Error("题库名称不能为空。");
  const timestamp = values.importedAt ?? nowIso();
  return dbV7.transaction("rw", [dbV7.banks, dbV7.bankFolders, dbV7.changeSets, dbV7.syncMeta], async () => {
    if (values.folderId) {
      const folder = await dbV7.bankFolders.get(values.folderId);
      if (!folder) throw new Error("题库文件夹不存在或已被删除。");
    }
    const bank: BankV7 = {
      id: values.id ?? makeV7Id("bank"),
      name,
      displayName: values.displayName?.trim() || undefined,
      description: values.description?.trim() || undefined,
      color: values.color,
      folderId: values.folderId,
      sortOrder: Number.isFinite(values.sortOrder) ? Number(values.sortOrder) : await dbV7.banks.count(),
      questionCount: 0,
      enabled: values.enabled ?? true,
      importedAt: values.importedAt ?? timestamp,
      updatedAt: values.updatedAt ?? timestamp,
      deviceId: values.deviceId ?? getV7DeviceId(),
    };
    await dbV7.banks.put(bank);
    await enqueueChangeSetV7([{ kind: "bank.create", bank }], timestamp);
    return bank;
  });
}

export async function updateBankV7(bankId: string, changes: Partial<Pick<BankV7, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder" | "enabled">>): Promise<BankV7> {
  return dbV7.transaction("rw", [dbV7.banks, dbV7.bankFolders, dbV7.changeSets, dbV7.syncMeta], async () => {
    const current = await dbV7.banks.get(bankId);
    if (!current) throw new Error("题库不存在或已被删除。");
    if (changes.folderId) {
      const folder = await dbV7.bankFolders.get(changes.folderId);
      if (!folder) throw new Error("题库文件夹不存在或已被删除。");
    }
    const updated: BankV7 = {
      ...current,
      ...changes,
      name: changes.name?.trim() || current.name,
      displayName: changes.displayName === undefined ? current.displayName : changes.displayName.trim() || undefined,
      description: changes.description === undefined ? current.description : changes.description.trim() || undefined,
      updatedAt: nowIso(),
      deviceId: getV7DeviceId(),
    };
    await dbV7.banks.put(updated);
    await enqueueChangeSetV7([{ kind: "bank.update", bank: updated, previous: current }], updated.updatedAt);
    return updated;
  });
}

export async function reorderBanksV7(bankIds: readonly string[], folderId?: string): Promise<BankV7[]> {
  const ids = uniqueStrings(bankIds);
  if (!ids.length) return [];
  return dbV7.transaction("rw", [dbV7.banks, dbV7.bankFolders, dbV7.changeSets, dbV7.syncMeta], async () => {
    const banks = (await dbV7.banks.bulkGet(ids)).filter(Boolean) as BankV7[];
    if (!banks.length) return [];
    if (folderId) {
      const folder = await dbV7.bankFolders.get(folderId);
      if (!folder) throw new Error("题库文件夹不存在或已被删除。");
    }
    const updatedAt = nowIso();
    const deviceId = getV7DeviceId();
    const rows = banks.map((bank, sortOrder) => ({ ...bank, folderId, sortOrder, updatedAt, deviceId }));
    await dbV7.banks.bulkPut(rows);
    await enqueueChangeSetV7(rows.map((bank) => ({ kind: "bank.update", bank })), updatedAt);
    return rows;
  });
}

export async function saveBankFolderV7(input: Pick<BankFolderV7, "name" | "description"> & { id?: string }): Promise<BankFolderV7> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入文件夹名称。");
  const updatedAt = nowIso();
  return dbV7.transaction("rw", [dbV7.bankFolders, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta], async () => {
    const current = input.id ? await dbV7.bankFolders.get(input.id) : undefined;
    const folder: BankFolderV7 = {
      id: input.id ?? makeV7Id("folder"),
      name,
      description: input.description.trim(),
      sortOrder: current?.sortOrder ?? await dbV7.bankFolders.count(),
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
      deviceId: getV7DeviceId(),
    };
    await dbV7.bankFolders.put(folder);
    await dbV7.tombstones.delete(tombstoneKey("bankFolder", folder.id));
    await enqueueChangeSetV7([{ kind: "bankFolder.save", folder }], updatedAt);
    return folder;
  });
}

export async function deleteBankFolderV7(folderId: string): Promise<boolean> {
  return dbV7.transaction("rw", [dbV7.bankFolders, dbV7.banks, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta], async () => {
    const current = await dbV7.bankFolders.get(folderId);
    if (!current) return false;
    const updatedAt = nowIso();
    const deviceId = getV7DeviceId();
    const eventId = makeV7Id("folder-delete");
    const banks = await dbV7.banks.where("folderId").equals(folderId).toArray();
    const folderDeleteSequence = await nextV7Sequence(deviceId);
    await dbV7.bankFolders.delete(folderId);
    const detached = banks.map((bank) => ({ ...bank, folderId: undefined, updatedAt, deviceId }));
    await dbV7.banks.bulkPut(detached);
    await dbV7.tombstones.put({ key: tombstoneKey("bankFolder", folderId), entityType: "bankFolder", entityId: folderId, deletedAt: updatedAt, deviceId, eventId, sequence: folderDeleteSequence });
    await enqueueChangeSetV7([
      ...detached.map((bank) => ({ kind: "bank.update" as const, bank })),
      { kind: "bankFolder.delete", folderId, deletedAt: updatedAt },
    ], updatedAt, { localSequence: folderDeleteSequence });
    return true;
  });
}

/** Return memberships joined with their content, preserving sort order. */
export async function getBankQuestionJoinsV7(bankId: string): Promise<BankQuestionJoinV7[]> {
  const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  memberships.sort((left, right) => left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
  const questions = new Map((await dbV7.questions.bulkGet(memberships.map((item) => item.questionId))).filter(Boolean).map((item) => [item!.id, item!]));
  return memberships.flatMap((membership) => {
    const question = questions.get(membership.questionId);
    return question ? [{ question, membership }] : [];
  });
}

/**
 * Join multiple banks with one indexed membership read and one de-duplicated
 * question bulkGet. The result preserves the caller's bank order and each
 * bank's membership order, matching repeated getBankQuestionJoinsV7 calls
 * without paying their per-bank IndexedDB round trips.
 */
export async function getBankQuestionJoinsForBanksV7(bankIds: readonly string[]): Promise<BankQuestionJoinV7[]> {
  const selected = uniqueStrings(bankIds);
  if (!selected.length) return [];
  const bankOrder = new Map(selected.map((bankId, index) => [bankId, index]));
  const memberships = await dbV7.bankQuestionMemberships.where("bankId").anyOf(selected).toArray();
  memberships.sort((left, right) =>
    (bankOrder.get(left.bankId) ?? selected.length) - (bankOrder.get(right.bankId) ?? selected.length)
    || left.sortOrder - right.sortOrder
    || left.questionId.localeCompare(right.questionId));
  const questionIds = uniqueStrings(memberships.map((item) => item.questionId));
  const questions = new Map((await dbV7.questions.bulkGet(questionIds)).filter(Boolean).map((item) => [item!.id, item!]));
  return memberships.flatMap((membership) => {
    const question = questions.get(membership.questionId);
    return question ? [{ question, membership }] : [];
  });
}

export async function getBankQuestionMembershipsV7(bankId: string): Promise<BankQuestionMembership[]> {
  return (await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray())
    .sort((left, right) => left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
}

export async function getBankQuestionsV7(bankId: string): Promise<QuestionV7[]> {
  return (await getBankQuestionJoinsV7(bankId)).map((row) => row.question);
}

/** Join multiple banks and deduplicate shared global question ids. */
export async function getQuestionsForBanksV7(bankIds: readonly string[]): Promise<QuestionV7[]> {
  const result: QuestionV7[] = [];
  const seen = new Set<string>();
  for (const row of await getBankQuestionJoinsForBanksV7(bankIds)) {
    if (seen.has(row.question.id)) continue;
    seen.add(row.question.id);
    result.push(row.question);
  }
  return result;
}

export const queryBankQuestionsV7 = getQuestionsForBanksV7;
export const listBankQuestionsV7 = getBankQuestionsV7;

/** internal，供兄弟模块使用 */
export async function saveMembershipInTx(membership: BankQuestionMembership): Promise<void> {
  const normalized = normalizeMembership(membership);
  const tombstone = await dbV7.tombstones.get(tombstoneKey("membership", normalized.key));
  if (tombstone && compareClock(normalized, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) return;
  if (tombstone) await dbV7.tombstones.delete(tombstone.key);
  await dbV7.bankQuestionMemberships.put(normalized);
}

/** Delete only the bank and its joins; content and all learning history stay. */
export async function deleteBankV7(bankId: string): Promise<boolean> {
  return dbV7.transaction("rw", [
    dbV7.banks, dbV7.bankQuestionMemberships, dbV7.practiceRuns, dbV7.practiceRunActivity,
    dbV7.practiceRunStats, dbV7.reviewRounds, dbV7.tombstones, dbV7.changeSets, dbV7.syncMeta,
  ], async () => {
    const bank = await dbV7.banks.get(bankId);
    if (!bank) return false;
    const timestamp = nowIso();
    const deviceId = getV7DeviceId();
    const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
    // Runs that target this bank are dropped with it; otherwise their bankId
    // would dangle and the checkpoint would fail referential validation.
    const runs = await listPracticeRunsForBankV7(bankId);
    const rounds = (await dbV7.reviewRounds.toArray()).filter((round) => round.bankIds.includes(bankId));
    const bankDeleteSequence = await nextV7Sequence(deviceId);
    await dbV7.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV7.banks.delete(bankId);
    for (const run of runs) {
      await updatePracticeRunStatsInTx(run, undefined);
      await deletePracticeRunInTx(run.id);
      await dbV7.tombstones.put({ key: tombstoneKey("practiceRun", run.id), entityType: "practiceRun", entityId: run.id, deletedAt: timestamp, deviceId, eventId: makeV7Id("bank-delete"), sequence: bankDeleteSequence });
    }
    for (const round of rounds) {
      await dbV7.reviewRounds.put({
        ...round,
        bankIds: round.bankIds.filter((id) => id !== bankId),
        updatedAt: timestamp,
        deviceId,
      });
    }
    await dbV7.tombstones.put({ key: tombstoneKey("bank", bankId), entityType: "bank", entityId: bankId, deletedAt: timestamp, deviceId, eventId: makeV7Id("bank-delete"), sequence: bankDeleteSequence });
    await enqueueChangeSetV7([{ kind: "bank.delete", bankId, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: bankDeleteSequence });
    return true;
  });
}

export const deleteBankOnlyV7 = deleteBankV7;
