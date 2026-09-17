/**
 * Bank/folder/membership records and bank-scoped queries.
 */
import {
  compareClock,
  studyDb,
  getDeviceId,
  makeId,
  nextSequence,
  nowIso,
  tombstoneKey,
  uniqueStrings,
} from "./db-core";
import type { BankQuestionJoin } from "./db-core";
import { enqueueChangeSet } from "./db-change-sets";
import type { BankFolder, BankQuestionMembership, Bank, Question } from "./types";
import { sha256DigestHex } from "../crypto/sha256";

/** internal，供兄弟模块使用 */
export async function refreshBankQuestionCountInTx(bankId: string): Promise<Bank | undefined> {
  const bank = await studyDb.banks.get(bankId);
  if (!bank) return undefined;
  const count = await studyDb.bankQuestionMemberships.where("bankId").equals(bankId).count();
  if (bank.questionCount === count) return bank;
  const updated = { ...bank, questionCount: count };
  await studyDb.banks.put(updated);
  return updated;
}

/** internal，供兄弟模块使用 */
export function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

/** IndexedDB primary key for the normalized membership relation. */
export function membershipPrimaryKey(bankId: string, questionId: string): [string, string] {
  return [bankId, questionId];
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
export function bankLabel(bank: Bank): string {
  return bank.displayName?.trim() || bank.name;
}

/** Create a bank. Counts are always initialised from memberships (zero). */
export function createBank(name: string): Promise<Bank>;
export function createBank(input: Partial<Bank> & Pick<Bank, "name">): Promise<Bank>;
export async function createBank(input: string | (Partial<Bank> & Pick<Bank, "name">)): Promise<Bank> {
  const values = typeof input === "string" ? { name: input } : input;
  const name = values.name.trim();
  if (!name) throw new Error("题库名称不能为空。");
  const timestamp = values.importedAt ?? nowIso();
  return studyDb.transaction("rw", [studyDb.banks, studyDb.bankFolders, studyDb.changeSets, studyDb.syncMeta], async () => {
    if (values.folderId) {
      const folder = await studyDb.bankFolders.get(values.folderId);
      if (!folder) throw new Error("题库文件夹不存在或已被删除。");
    }
    const bank: Bank = {
      id: values.id ?? makeId("bank"),
      name,
      displayName: values.displayName?.trim() || undefined,
      description: values.description?.trim() || undefined,
      color: values.color,
      folderId: values.folderId,
      sortOrder: Number.isFinite(values.sortOrder) ? Number(values.sortOrder) : await studyDb.banks.count(),
      questionCount: 0,
      enabled: values.enabled ?? true,
      importedAt: values.importedAt ?? timestamp,
      updatedAt: values.updatedAt ?? timestamp,
      deviceId: values.deviceId ?? getDeviceId(),
    };
    await studyDb.banks.put(bank);
    await enqueueChangeSet([{ kind: "bank.create", bank }], timestamp);
    return bank;
  });
}

export async function updateBank(bankId: string, changes: Partial<Pick<Bank, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder" | "enabled">>): Promise<Bank> {
  return studyDb.transaction("rw", [studyDb.banks, studyDb.bankFolders, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = await studyDb.banks.get(bankId);
    if (!current) throw new Error("题库不存在或已被删除。");
    if (changes.folderId) {
      const folder = await studyDb.bankFolders.get(changes.folderId);
      if (!folder) throw new Error("题库文件夹不存在或已被删除。");
    }
    const updated: Bank = {
      ...current,
      ...changes,
      name: changes.name?.trim() || current.name,
      displayName: changes.displayName === undefined ? current.displayName : changes.displayName.trim() || undefined,
      description: changes.description === undefined ? current.description : changes.description.trim() || undefined,
      updatedAt: nowIso(),
      deviceId: getDeviceId(),
    };
    await studyDb.banks.put(updated);
    await enqueueChangeSet([{ kind: "bank.update", bank: updated, previous: current }], updated.updatedAt);
    return updated;
  });
}

export async function reorderBanks(bankIds: readonly string[], folderId?: string): Promise<Bank[]> {
  const ids = uniqueStrings(bankIds);
  if (!ids.length) return [];
  return studyDb.transaction("rw", [studyDb.banks, studyDb.bankFolders, studyDb.changeSets, studyDb.syncMeta], async () => {
    const banks = (await studyDb.banks.bulkGet(ids)).filter(Boolean) as Bank[];
    if (!banks.length) return [];
    if (folderId) {
      const folder = await studyDb.bankFolders.get(folderId);
      if (!folder) throw new Error("题库文件夹不存在或已被删除。");
    }
    const updatedAt = nowIso();
    const deviceId = getDeviceId();
    const rows = banks.map((bank, sortOrder) => ({ ...bank, folderId, sortOrder, updatedAt, deviceId }));
    await studyDb.banks.bulkPut(rows);
    await enqueueChangeSet(rows.map((bank) => ({ kind: "bank.update", bank })), updatedAt);
    return rows;
  });
}

export async function saveBankFolder(input: Pick<BankFolder, "name" | "description"> & { id?: string }): Promise<BankFolder> {
  const name = input.name.trim();
  if (!name) throw new Error("请输入文件夹名称。");
  const updatedAt = nowIso();
  return studyDb.transaction("rw", [studyDb.bankFolders, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = input.id ? await studyDb.bankFolders.get(input.id) : undefined;
    const folder: BankFolder = {
      id: input.id ?? makeId("folder"),
      name,
      description: input.description.trim(),
      sortOrder: current?.sortOrder ?? await studyDb.bankFolders.count(),
      createdAt: current?.createdAt ?? updatedAt,
      updatedAt,
      deviceId: getDeviceId(),
    };
    await studyDb.bankFolders.put(folder);
    await studyDb.tombstones.delete(tombstoneKey("bankFolder", folder.id));
    await enqueueChangeSet([{ kind: "bankFolder.save", folder }], updatedAt);
    return folder;
  });
}

export async function deleteBankFolder(folderId: string): Promise<boolean> {
  return studyDb.transaction("rw", [studyDb.bankFolders, studyDb.banks, studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta], async () => {
    const current = await studyDb.bankFolders.get(folderId);
    if (!current) return false;
    const updatedAt = nowIso();
    const deviceId = getDeviceId();
    const eventId = makeId("folder-delete");
    const banks = await studyDb.banks.where("folderId").equals(folderId).toArray();
    const folderDeleteSequence = await nextSequence(deviceId);
    await studyDb.bankFolders.delete(folderId);
    const detached = banks.map((bank) => ({ ...bank, folderId: undefined, updatedAt, deviceId }));
    await studyDb.banks.bulkPut(detached);
    await studyDb.tombstones.put({ key: tombstoneKey("bankFolder", folderId), entityType: "bankFolder", entityId: folderId, deletedAt: updatedAt, deviceId, eventId, sequence: folderDeleteSequence });
    await enqueueChangeSet([
      ...detached.map((bank) => ({ kind: "bank.update" as const, bank })),
      { kind: "bankFolder.delete", folderId, deletedAt: updatedAt },
    ], updatedAt, { localSequence: folderDeleteSequence });
    return true;
  });
}

/** Return memberships joined with their content, preserving sort order. */
export async function getBankQuestionJoins(bankId: string): Promise<BankQuestionJoin[]> {
  const memberships = await studyDb.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  memberships.sort((left, right) => left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
  const questions = new Map((await studyDb.questions.bulkGet(memberships.map((item) => item.questionId))).filter(Boolean).map((item) => [item!.id, item!]));
  return memberships.flatMap((membership) => {
    const question = questions.get(membership.questionId);
    return question ? [{ question, membership }] : [];
  });
}

/**
 * Join multiple banks with one indexed membership read and one de-duplicated
 * question bulkGet. The result preserves the caller's bank order and each
 * bank's membership order, matching repeated getBankQuestionJoins calls
 * without paying their per-bank IndexedDB round trips.
 */
export async function getBankQuestionJoinsForBanks(bankIds: readonly string[]): Promise<BankQuestionJoin[]> {
  const selected = uniqueStrings(bankIds);
  if (!selected.length) return [];
  const bankOrder = new Map(selected.map((bankId, index) => [bankId, index]));
  const memberships = await studyDb.bankQuestionMemberships.where("bankId").anyOf(selected).toArray();
  memberships.sort((left, right) =>
    (bankOrder.get(left.bankId) ?? selected.length) - (bankOrder.get(right.bankId) ?? selected.length)
    || left.sortOrder - right.sortOrder
    || left.questionId.localeCompare(right.questionId));
  const questionIds = uniqueStrings(memberships.map((item) => item.questionId));
  const questions = new Map((await studyDb.questions.bulkGet(questionIds)).filter(Boolean).map((item) => [item!.id, item!]));
  return memberships.flatMap((membership) => {
    const question = questions.get(membership.questionId);
    return question ? [{ question, membership }] : [];
  });
}

export async function getBankQuestionMemberships(bankId: string): Promise<BankQuestionMembership[]> {
  return (await studyDb.bankQuestionMemberships.where("bankId").equals(bankId).toArray())
    .sort((left, right) => left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
}

export async function getBankQuestions(bankId: string): Promise<Question[]> {
  return (await getBankQuestionJoins(bankId)).map((row) => row.question);
}

/** Join multiple banks and deduplicate shared global question ids. */
export async function getQuestionsForBanks(bankIds: readonly string[]): Promise<Question[]> {
  const result: Question[] = [];
  const seen = new Set<string>();
  for (const row of await getBankQuestionJoinsForBanks(bankIds)) {
    if (seen.has(row.question.id)) continue;
    seen.add(row.question.id);
    result.push(row.question);
  }
  return result;
}

export const queryBankQuestions = getQuestionsForBanks;
export const listBankQuestions = getBankQuestions;

/** internal，供兄弟模块使用 */
export async function saveMembershipInTx(membership: BankQuestionMembership): Promise<void> {
  const normalized = normalizeMembership(membership);
  const tombstone = await studyDb.tombstones.get(tombstoneKey("membership", normalized.key));
  if (tombstone && compareClock(normalized, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) return;
  if (tombstone) await studyDb.tombstones.delete(tombstone.key);
  await studyDb.bankQuestionMemberships.put(normalized);
}

/** Delete only the bank and its joins; content and all learning history stay. */
export async function deleteBank(bankId: string): Promise<boolean> {
  return studyDb.transaction("rw", [
    studyDb.banks, studyDb.bankQuestionMemberships, studyDb.bankPracticeStats,
    studyDb.tombstones, studyDb.changeSets, studyDb.syncMeta,
  ], async () => {
    const bank = await studyDb.banks.get(bankId);
    if (!bank) return false;
    const timestamp = nowIso();
    const deviceId = getDeviceId();
    const memberships = await studyDb.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
    const bankDeleteSequence = await nextSequence(deviceId);
    await studyDb.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membershipPrimaryKey(membership.bankId, membership.questionId)));
    await studyDb.banks.delete(bankId);
    // Historical practiceRunSources/reviewRoundBanks are attribution snapshots,
    // not live foreign keys. Deleting current master data must not erase them.
    await studyDb.bankPracticeStats.delete(bankId);
    await studyDb.tombstones.put({ key: tombstoneKey("bank", bankId), entityType: "bank", entityId: bankId, deletedAt: timestamp, deviceId, eventId: makeId("bank-delete"), sequence: bankDeleteSequence });
    await enqueueChangeSet([{ kind: "bank.delete", bankId, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: bankDeleteSequence });
    return true;
  });
}

export const deleteBankOnly = deleteBank;
