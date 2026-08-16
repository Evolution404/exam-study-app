/**
 * The v7 local-first database.
 *
 * This module is deliberately a separate namespace from `lib/db.ts`.  It
 * never imports the legacy database (doing so would construct the old
 * Dexie instance) and it does not contain an upgrade or
 * migration path.  Consumers can opt into v7 incrementally while the v5 UI
 * continues to use its own database.
 */
import Dexie, { type EntityTable } from "dexie";
import { createChangeSetV7, type ChangeSetMutationV7, type ChangeSetV7 } from "../sync/change-set-v7";
import { sha256Blob } from "../io/image-assets";
import {
  blocksFromPlaceholderText,
  deriveContentText,
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
  stripImagePlaceholders,
} from "../question/question-content";
import { normalizeCalculationAnswer } from "../question/question-utils";
import type {
  AttemptDailyStatsV7,
  AttemptStatsV7,
  AttemptV7,
  BankFolderV7,
  BankQuestionMembership,
  BankV7,
  ContentBlock,
  ImageAsset,
  NoteV7,
  PracticeRunStatsV7,
  PracticeRunV7,
  QuestionGroupV7,
  QuestionTypeV7,
  QuestionV7,
  ReviewRound,
  ReviewRoundProgress,
  SyncFileV7,
  SyncMetaV7,
  TombstoneV7,
} from "./v7-types";
export const V7_DATABASE_NAME = "shijuan-study-v7" as const;

export interface PracticeAnswerV7 {
  selected: string[];
  submitted: true;
  correct: boolean;
  updatedAt: string;
  deviceId: string;
  eventId: string;
}

export interface PracticeAnswerInputV7 {
  runId: string;
  questionId: string;
  selected: string | readonly string[];
  correct: boolean;
  elapsedMs?: number;
  /** Optional source bank for history display; statistics remain global. */
  sourceBankId?: string;
  bankId?: string;
  reviewRoundId?: string;
  createdAt?: string;
}

export interface QuestionDraftV7 {
  type: QuestionTypeV7;
  /** Plain text stem.  `content` takes precedence when supplied. */
  stem?: string;
  content?: ContentBlock[];
  options?: Array<string | ContentBlock[]>;
  answer: string | string[];
  tags?: string[];
  favorite?: boolean;
  /** Optional personal note/analysis, imported from a 解析 column or JSON field. */
  note?: string;
}

export interface BankQuestionJoinV7 {
  question: QuestionV7;
  membership: BankQuestionMembership;
}

export interface CreatePracticeRunInputV7 {
  id?: string;
  bankId?: string;
  bankIds?: string[];
  bankName?: string;
  mode?: PracticeRunV7["mode"];
  modeLabel?: string;
  questionIds?: string[];
  questionTypes?: Record<string, QuestionTypeV7>;
  answers?: PracticeRunV7["answers"];
  shuffleOptions?: boolean;
  optionOrders?: Record<string, number[]>;
  startedAt?: string;
  updatedAt?: string;
  status?: PracticeRunV7["status"];
  revision?: number;
  lastAnsweredIndex?: number;
  reviewRoundId?: string;
}

/** Complete projection shape accepted by the v7 atomic restore helper. */
export interface V7RestoreState {
  banks: BankV7[];
  bankFolders: BankFolderV7[];
  questions: QuestionV7[];
  /** Wire checkpoints call this `memberships`; the alias eases internal callers. */
  memberships?: BankQuestionMembership[];
  bankQuestionMemberships?: BankQuestionMembership[];
  imageAssets: ImageAsset[];
  attempts: AttemptV7[];
  attemptStats: AttemptStatsV7[];
  attemptDailyStats: AttemptDailyStatsV7[];
  notes: NoteV7[];
  practiceRuns: PracticeRunV7[];
  practiceRunStats: PracticeRunStatsV7[];
  questionGroups: QuestionGroupV7[];
  reviewRounds: ReviewRound[];
  reviewRoundProgress: ReviewRoundProgress[];
  tombstones: TombstoneV7[];
}

const imageMimeTypes = new Set(["image/webp", "image/jpeg", "image/png"]);
let idCounter = 0;
let sequenceCounter = 0;

function nowIso(): string {
  return new Date().toISOString();
}

export function makeV7Id(prefix = "v7"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

const V7_LEGACY_DEVICE_ID_KEY = "shijuan-study-v6-device-id";

export function getV7DeviceId(): string {
  if (typeof localStorage === "undefined") return "server-v7";
  const key = "shijuan-study-v7-device-id";
  let value: string | null = localStorage.getItem(key);
  if (!value) {
    // 一次迁移：沿用 v6 时代的设备号，避免同步身份变化。
    value = localStorage.getItem(V7_LEGACY_DEVICE_ID_KEY);
    if (!value) {
      value = makeV7Id("device");
    }
    localStorage.setItem(key, value);
  }
  return value;
}

function nextV7Sequence(deviceId = getV7DeviceId()): number {
  sequenceCounter = Math.max(sequenceCounter + 1, Date.now() * 1000);
  if (typeof localStorage !== "undefined") {
    const key = `shijuan-study-v7-sequence:${deviceId}`;
    const legacyKey = `shijuan-study-v6-sequence:${deviceId}`;
    const current = Number(localStorage.getItem(key)) || Number(localStorage.getItem(legacyKey)) || 0;
    sequenceCounter = Math.max(sequenceCounter, current) + 1;
    localStorage.setItem(key, String(sequenceCounter));
  }
  return sequenceCounter;
}

export async function enqueueChangeSetV7(mutations: readonly ChangeSetMutationV7[], createdAt = nowIso(), options?: { localSequence?: number }): Promise<ChangeSetQueueRecordV7> {
  const deviceId = getV7DeviceId();
  const localSequence = options?.localSequence ?? nextV7Sequence(deviceId);
  const changeSet = await Dexie.waitFor(createChangeSetV7({ deviceId, localSequence, createdAt, mutations }));
  const record: ChangeSetQueueRecordV7 = { ...changeSet, state: "pending" };
  await dbV7.changeSets.put(record);
  return record;
}

export async function listChangeSetsV7(states?: readonly ChangeSetQueueStateV7[]): Promise<ChangeSetQueueRecordV7[]> {
  const rows = states?.length ? await dbV7.changeSets.where("state").anyOf([...states]).toArray() : await dbV7.changeSets.toArray();
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

export async function claimPendingChangeSetsV7(): Promise<{ claimId: string; records: ChangeSetQueueRecordV7[] }> {
  const claimId = makeV7Id("claim");
  const claimedAt = nowIso();
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const pending = (await dbV7.changeSets.where("state").equals("pending").toArray())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
    const records = pending.map((record) => ({ ...record, state: "claimed" as const, claimId, claimedAt }));
    if (records.length) await dbV7.changeSets.bulkPut(records);
    return { claimId, records };
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

export async function discardPendingChangeSetV7(id: string): Promise<boolean> {
  return dbV7.transaction("rw", dbV7.changeSets, async () => {
    const record = await dbV7.changeSets.get(id);
    if (!record || record.state !== "pending") return false;
    await dbV7.changeSets.delete(id);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeAnswer(type: QuestionTypeV7, input: string | readonly string[]): string {
  const raw = Array.isArray(input) ? input.join("") : String(input);
  if (type === "计算") return normalizeCalculationAnswer(raw);
  return uniqueStrings([...raw.toUpperCase().replace(/[^A-Z]/g, "")]).sort().join("");
}

function normalizeBlocks(blocks: readonly ContentBlock[]): ContentBlock[] {
  return blocks.map((block, index) => {
    if (block.type === "text") {
      return { ...block, id: block.id || `text-${index}`, text: normalizeContentText(block.text) };
    }
    return { ...block, id: block.id || `image-${index}` };
  });
}

function blocksFromOptions(options: QuestionDraftV7["options"]): ContentBlock[][] {
  return (options ?? []).map((option, optionIndex) => {
    if (Array.isArray(option) && option.every((item) => typeof item === "object")) {
      return normalizeBlocks(option as ContentBlock[]);
    }
    const text = normalizeContentText(String(option ?? ""));
    return plainTextToContentBlocks(text, `option-${optionIndex}-0`);
  });
}

function questionFromDraft(id: string, draft: QuestionDraftV7, timestamp: string, deviceId: string): QuestionV7 {
  const content = normalizeBlocks(draft.content ?? plainTextToContentBlocks(draft.stem ?? "", "stem-0"));
  const options = blocksFromOptions(draft.options);
  const answer = normalizeAnswer(draft.type, draft.answer);
  const contentFingerprint = questionContentFingerprint({ type: draft.type, content, options, answer });
  return {
    id,
    type: draft.type,
    content,
    options,
    answer,
    tags: uniqueStrings(draft.tags ?? []),
    favorite: Boolean(draft.favorite),
    contentFingerprint,
    updatedAt: timestamp,
    deviceId,
  };
}

function tombstoneKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function compareClock(left: { updatedAt?: string; createdAt?: string; deviceId?: string; id?: string }, right: { updatedAt?: string; createdAt?: string; deviceId?: string; id?: string }): number {
  return (left.updatedAt ?? left.createdAt ?? "").localeCompare(right.updatedAt ?? right.createdAt ?? "")
    || (left.deviceId ?? "").localeCompare(right.deviceId ?? "")
    || (left.id ?? "").localeCompare(right.id ?? "");
}

function datePart(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value.slice(0, 10);
}

function dailyStatsKey(createdAt: string, questionId: string): string {
  return `${datePart(createdAt)}:${questionId}`;
}

export type ChangeSetQueueStateV7 = "pending" | "claimed" | "blocked" | "committed";

export interface ChangeSetQueueRecordV7 extends ChangeSetV7 {
  state: ChangeSetQueueStateV7;
  claimId?: string;
  claimedAt?: string;
  committedAt?: string;
  blockedReason?: string;
}

/** Dexie schema is intentionally one declaration only. */
class V7StudyDatabase extends Dexie {
  banks!: EntityTable<BankV7, "id">;
  bankFolders!: EntityTable<BankFolderV7, "id">;
  questions!: EntityTable<QuestionV7, "id">;
  bankQuestionMemberships!: EntityTable<BankQuestionMembership, "key">;
  imageAssets!: EntityTable<ImageAsset, "id">;
  attempts!: EntityTable<AttemptV7, "id">;
  attemptStats!: EntityTable<AttemptStatsV7, "questionId">;
  attemptDailyStats!: EntityTable<AttemptDailyStatsV7, "key">;
  notes!: EntityTable<NoteV7, "questionId">;
  practiceRuns!: EntityTable<PracticeRunV7, "id">;
  practiceRunStats!: EntityTable<PracticeRunStatsV7, "key">;
  questionGroups!: EntityTable<QuestionGroupV7, "id">;
  reviewRounds!: EntityTable<ReviewRound, "id">;
  reviewRoundProgress!: EntityTable<ReviewRoundProgress, "key">;
  changeSets!: EntityTable<ChangeSetQueueRecordV7, "id">;
  syncFiles!: EntityTable<SyncFileV7, "path">;
  tombstones!: EntityTable<TombstoneV7, "key">;
  syncMeta!: EntityTable<SyncMetaV7, "key">;

  constructor() {
    super(V7_DATABASE_NAME);
    this.version(1).stores({
      banks: "id, sortOrder, folderId, importedAt, updatedAt",
      bankFolders: "id, sortOrder, updatedAt",
      questions: "id, contentFingerprint, type, updatedAt, *tags",
      bankQuestionMemberships: "key, bankId, questionId, sortOrder, updatedAt, [bankId+sortOrder], [bankId+questionId]",
      imageAssets: "id, mimeType, size",
      attempts: "id, runId, questionId, sourceBankId, createdAt, deviceId",
      attemptStats: "questionId, latestAttemptAt",
      attemptDailyStats: "key, date, questionId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, updatedAt, startedAt",
      practiceRunStats: "key, bankId, latestUpdatedAt",
      questionGroups: "id, type, updatedAt",
      reviewRounds: "id, status, updatedAt, startedAt",
      reviewRoundProgress: "key, roundId, questionId, latestAttemptAt",
      events: "id, type, createdAt, deviceId, synced",
      syncFiles: "path, sha, appliedAt",
      tombstones: "key, entityType, entityId, deletedAt",
      syncMeta: "key, updatedAt",
    });
    this.version(2).stores({
      banks: "id, sortOrder, folderId, importedAt, updatedAt",
      bankFolders: "id, sortOrder, updatedAt",
      questions: "id, contentFingerprint, type, updatedAt, *tags",
      bankQuestionMemberships: "key, bankId, questionId, sortOrder, updatedAt, [bankId+sortOrder], [bankId+questionId]",
      imageAssets: "id, mimeType, size",
      attempts: "id, runId, questionId, sourceBankId, createdAt, deviceId",
      attemptStats: "questionId, latestAttemptAt",
      attemptDailyStats: "key, date, questionId",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, updatedAt, startedAt",
      practiceRunStats: "key, bankId, latestUpdatedAt",
      questionGroups: "id, type, updatedAt",
      reviewRounds: "id, status, updatedAt, startedAt",
      reviewRoundProgress: "key, roundId, questionId, latestAttemptAt",
      events: "id, type, createdAt, deviceId, synced",
      changeSets: "id, state, createdAt, deviceId, localSequence, claimId, committedAt, [state+createdAt]",
      syncFiles: "path, sha, appliedAt",
      tombstones: "key, entityType, entityId, deletedAt",
      syncMeta: "key, updatedAt",
    });
    // v3: the v7 event log is superseded by v7 change-sets; drop the store.
    this.version(3).stores({ events: null });
  }
}

const V7_LEGACY_DATABASE_NAME = "shijuan-study-v6";
const V7_MIGRATION_TABLES = [
  "banks", "bankFolders", "questions", "bankQuestionMemberships", "imageAssets",
  "attempts", "attemptStats", "attemptDailyStats", "notes", "practiceRuns",
  "practiceRunStats", "questionGroups", "reviewRounds", "reviewRoundProgress",
  "changeSets", "tombstones", "syncMeta", "syncFiles",
] as const;

function openLegacyV7Database(): Promise<IDBDatabase | undefined> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(undefined);
    const request = indexedDB.open(V7_LEGACY_DATABASE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
    request.onupgradeneeded = () => { /* never upgrade the legacy namespace */ };
  });
}

async function readLegacyV7Rows(): Promise<Map<string, unknown[]> | undefined> {
  const legacy = await openLegacyV7Database();
  if (!legacy) return undefined;
  try {
    const names = [...legacy.objectStoreNames].filter((name): name is (typeof V7_MIGRATION_TABLES)[number] => (V7_MIGRATION_TABLES as readonly string[]).includes(name));
    if (!names.length) return undefined;
    const rows = new Map<string, unknown[]>();
    await new Promise<void>((resolve, reject) => {
      const transaction = legacy.transaction(names, "readonly");
      for (const name of names) {
        const request = transaction.objectStore(name).getAll();
        request.onsuccess = () => { rows.set(name, request.result as unknown[]); };
        request.onerror = () => reject(request.error);
      }
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return rows;
  } finally {
    legacy.close();
  }
}

async function migrateLegacyV7DatabaseIfNeeded(): Promise<void> {
  try {
    await dbV7.open();
    const [banks, questions, changeSets, syncMeta] = await Promise.all([
      dbV7.banks.count(), dbV7.questions.count(), dbV7.changeSets.count(), dbV7.syncMeta.count(),
    ]);
    if (banks || questions || changeSets || syncMeta) return;
    const rows = await readLegacyV7Rows();
    if (!rows || rows.size === 0) return;
    const anyRows = [...rows.values()].some((list) => list.length > 0);
    if (!anyRows) return;
    const tables = [dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.imageAssets, dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress, dbV7.changeSets, dbV7.tombstones, dbV7.syncMeta, dbV7.syncFiles];
    await dbV7.transaction("rw", tables, async () => {
      for (const [name, list] of rows) {
        if (!list.length) continue;
        const table = dbV7.table(name) as { bulkPut(items: unknown[]): Promise<unknown> };
        await table.bulkPut(list);
      }
    });
  } catch {
    // 迁移失败不能阻塞启动；v7 仍会正常打开，旧库数据不会被删除。
  }
}

/** The sole v7 database instance.  Constructing it does not open the legacy DB. */
export const dbV7 = new V7StudyDatabase();
/** Short alias used by callers that prefer `v7Db`. */
export const v7Db = dbV7;
/**
 * One-time local migration promise: copy the old `shijuan-study-v6` namespace
 * into `shijuan-study-v7` when v7 is empty. The app awaits this before render;
 * tests can ignore it (fake-indexeddb has no legacy data by default).
 */
export const dbV7Ready: Promise<void> = migrateLegacyV7DatabaseIfNeeded();
/** Class is exported for tests that need a fresh, isolated namespace. */
export { V7StudyDatabase };

export async function resetV7Database(): Promise<void> {
  await dbV7Ready;
  await dbV7.close();
  await Dexie.delete(V7_DATABASE_NAME);
  await dbV7.open();
}

async function refreshBankQuestionCountInTx(bankId: string): Promise<BankV7 | undefined> {
  const bank = await dbV7.banks.get(bankId);
  if (!bank) return undefined;
  const count = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).count();
  if (bank.questionCount === count) return bank;
  const updated = { ...bank, questionCount: count };
  await dbV7.banks.put(updated);
  return updated;
}

async function findQuestionByFingerprint(fingerprint: string): Promise<QuestionV7 | undefined> {
  return dbV7.questions.where("contentFingerprint").equals(fingerprint).first();
}

function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

function normalizeMembership(input: BankQuestionMembership): BankQuestionMembership {
  return { ...input, key: input.key || membershipKey(input.bankId, input.questionId) };
}

async function sha256Text(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  // This fallback is only for unusual test runtimes without WebCrypto.  It
  // remains deterministic, while image blobs still require a real SHA-256.
  let hash = 2166136261;
  for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0)!, 16777619);
  return `${(hash >>> 0).toString(16).padStart(8, "0")}${"0".repeat(56)}`;
}

function bankLabel(bank: BankV7): string {
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
  const bank: BankV7 = {
    id: values.id ?? makeV7Id("bank"),
    name,
    displayName: values.displayName?.trim() || undefined,
    description: values.description?.trim() || undefined,
    color: values.color,
    folderId: values.folderId,
    sortOrder: Number.isFinite(values.sortOrder) ? Number(values.sortOrder) : await dbV7.banks.count(),
    questionCount: 0,
    importedAt: values.importedAt ?? timestamp,
    updatedAt: values.updatedAt ?? timestamp,
    deviceId: values.deviceId ?? getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.banks, dbV7.changeSets], async () => {
    await dbV7.banks.put(bank);
    await enqueueChangeSetV7([{ kind: "bank.create", bank }], timestamp);
  });
  return bank;
}

export async function updateBankV7(bankId: string, changes: Partial<Pick<BankV7, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder">>): Promise<BankV7> {
  const current = await dbV7.banks.get(bankId);
  if (!current) throw new Error("题库不存在或已被删除。");
  const updated: BankV7 = {
    ...current,
    ...changes,
    name: changes.name?.trim() || current.name,
    displayName: changes.displayName === undefined ? current.displayName : changes.displayName.trim() || undefined,
    description: changes.description === undefined ? current.description : changes.description.trim() || undefined,
    updatedAt: nowIso(),
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.banks, dbV7.changeSets], async () => {
    await dbV7.banks.put(updated);
    await enqueueChangeSetV7([{ kind: "bank.update", bank: updated, previous: current }], updated.updatedAt);
  });
  return updated;
}

export async function reorderBanksV7(bankIds: readonly string[], folderId?: string): Promise<BankV7[]> {
  const banks = (await dbV7.banks.bulkGet(uniqueStrings(bankIds))).filter(Boolean) as BankV7[];
  if (!banks.length) return [];
  const updatedAt = nowIso();
  const deviceId = getV7DeviceId();
  const rows = banks.map((bank, sortOrder) => ({ ...bank, folderId, sortOrder, updatedAt, deviceId }));
  await dbV7.transaction("rw", [dbV7.banks, dbV7.changeSets], async () => {
    await dbV7.banks.bulkPut(rows);
    await enqueueChangeSetV7(rows.map((bank) => ({ kind: "bank.update", bank })), updatedAt);
  });
  return rows;
}

export async function saveBankFolderV7(input: Pick<BankFolderV7, "name" | "description"> & { id?: string }): Promise<BankFolderV7> {
  const current = input.id ? await dbV7.bankFolders.get(input.id) : undefined;
  const name = input.name.trim();
  if (!name) throw new Error("请输入文件夹名称。");
  const updatedAt = nowIso();
  const folder: BankFolderV7 = {
    id: input.id ?? makeV7Id("folder"),
    name,
    description: input.description.trim(),
    sortOrder: current?.sortOrder ?? await dbV7.bankFolders.count(),
    createdAt: current?.createdAt ?? updatedAt,
    updatedAt,
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.bankFolders, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankFolders.put(folder);
    await dbV7.tombstones.delete(tombstoneKey("bankFolder", folder.id));
    await enqueueChangeSetV7([{ kind: "bankFolder.save", folder }], updatedAt);
  });
  return folder;
}

export async function deleteBankFolderV7(folderId: string): Promise<boolean> {
  const current = await dbV7.bankFolders.get(folderId);
  if (!current) return false;
  const updatedAt = nowIso();
  const deviceId = getV7DeviceId();
  const eventId = makeV7Id("folder-delete");
  const banks = await dbV7.banks.where("folderId").equals(folderId).toArray();
  const folderDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.bankFolders, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankFolders.delete(folderId);
    const detached = banks.map((bank) => ({ ...bank, folderId: undefined, updatedAt, deviceId }));
    await dbV7.banks.bulkPut(detached);
    await dbV7.tombstones.put({ key: tombstoneKey("bankFolder", folderId), entityType: "bankFolder", entityId: folderId, deletedAt: updatedAt, deviceId, eventId, sequence: folderDeleteSequence });
    await enqueueChangeSetV7([
      ...detached.map((bank) => ({ kind: "bank.update" as const, bank })),
      { kind: "bankFolder.delete", folderId, deletedAt: updatedAt },
    ], updatedAt, { localSequence: folderDeleteSequence });
  });
  return true;
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
  for (const bankId of uniqueStrings(bankIds)) {
    for (const row of await getBankQuestionJoinsV7(bankId)) {
      if (seen.has(row.question.id)) continue;
      seen.add(row.question.id);
      result.push(row.question);
    }
  }
  return result;
}

export const queryBankQuestionsV7 = getQuestionsForBanksV7;
export const listBankQuestionsV7 = getBankQuestionsV7;

async function saveMembershipInTx(membership: BankQuestionMembership): Promise<void> {
  const normalized = normalizeMembership(membership);
  const tombstone = await dbV7.tombstones.get(tombstoneKey("membership", normalized.key));
  if (tombstone && compareClock(normalized, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) return;
  if (tombstone) await dbV7.tombstones.delete(tombstone.key);
  await dbV7.bankQuestionMemberships.put(normalized);
}

/** Create content and attach it to a bank, sharing an existing exact match. */
export async function createQuestionV7(bankId: string, draft: QuestionDraftV7): Promise<QuestionV7> {
  const bank = await dbV7.banks.get(bankId);
  if (!bank) throw new Error("题库不存在或已被删除。");
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const provisional = questionFromDraft(makeV7Id("question"), draft, timestamp, deviceId);
  const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
  const question = existing ?? provisional;
  const currentMemberships = await getBankQuestionMembershipsV7(bankId);
  const membership: BankQuestionMembership = {
    key: membershipKey(bankId, question.id),
    bankId,
    questionId: question.id,
    sortOrder: (currentMemberships.at(-1)?.sortOrder ?? -1) + 1,
    addedAt: timestamp,
    updatedAt: timestamp,
    deviceId,
  };
  await dbV7.transaction("rw", [dbV7.questions, dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
    if (!existing) await dbV7.questions.put(question);
    const currentMembership = await dbV7.bankQuestionMemberships.get(membership.key);
    await saveMembershipInTx(currentMembership ? { ...currentMembership, updatedAt: timestamp, deviceId } : membership);
    await refreshBankQuestionCountInTx(bankId);
    await enqueueChangeSetV7([
      ...(!existing ? [{ kind: "question.upsert" as const, question }] : []),
      { kind: "membership.save", membership },
    ], timestamp);
  });
  return question;
}

export async function updateQuestionV7(questionId: string, changes: Partial<QuestionDraftV7>): Promise<QuestionV7> {
  const current = await dbV7.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const timestamp = nowIso();
  const draft: QuestionDraftV7 = {
    type: changes.type ?? current.type,
    content: changes.content ?? current.content,
    options: changes.options ?? current.options,
    answer: changes.answer ?? current.answer,
    tags: changes.tags ?? current.tags,
    favorite: changes.favorite ?? current.favorite,
  };
  const updated = questionFromDraft(current.id, draft, timestamp, getV7DeviceId());
  await dbV7.transaction("rw", [dbV7.questions, dbV7.changeSets], async () => {
    await dbV7.questions.put(updated);
    await enqueueChangeSetV7([{ kind: "question.upsert", question: updated }], timestamp);
  });
  return updated;
}

export const updateSharedQuestionV7 = updateQuestionV7;

/**
 * Split selected memberships into one independent shared content object.
 * Historical attempts/statistics/round progress remain attached to the
 * original global question; only the editable note is copied to the clone.
 */
export function splitQuestionV7(questionId: string, selectedBankIds: readonly string[]): Promise<{ original: QuestionV7; clones: QuestionV7[] }>;
export function splitQuestionV7(input: { questionId: string; selectedBankIds: readonly string[] }): Promise<{ original: QuestionV7; clones: QuestionV7[] }>;
export async function splitQuestionV7(
  questionIdOrInput: string | { questionId: string; selectedBankIds: readonly string[] },
  selectedBankIdsArgument?: readonly string[],
): Promise<{ original: QuestionV7; clones: QuestionV7[] }> {
  const questionId = typeof questionIdOrInput === "string" ? questionIdOrInput : questionIdOrInput.questionId;
  const selectedBankIds = typeof questionIdOrInput === "string" ? selectedBankIdsArgument ?? [] : questionIdOrInput.selectedBankIds;
  const original = await dbV7.questions.get(questionId);
  if (!original) throw new Error("题目不存在或已被删除。");
  const wanted = new Set(uniqueStrings(selectedBankIds));
  const memberships = await dbV7.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  const selected = memberships.filter((membership) => wanted.has(membership.bankId));
  if (!selected.length) return { original, clones: [] };
  const sourceNote = await dbV7.notes.get(questionId);
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const clone: QuestionV7 = {
    ...original,
    id: makeV7Id("question"),
    content: original.content.map((block) => ({ ...block })),
    options: original.options.map((option) => option.map((block) => ({ ...block }))),
    tags: [...original.tags],
    favorite: original.favorite,
    updatedAt: timestamp,
    deviceId,
  };
  const movedMemberships = selected.map((membership) => ({
    ...membership,
    key: membershipKey(membership.bankId, clone.id),
    questionId: clone.id,
    updatedAt: timestamp,
    deviceId,
  }));
  const clonedNote: NoteV7 | undefined = sourceNote ? {
    ...sourceNote,
    questionId: clone.id,
    revision: 1,
    updatedAt: timestamp,
    deviceId,
  } : undefined;
  const splitSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [
    dbV7.questions, dbV7.bankQuestionMemberships, dbV7.notes, dbV7.banks,
    dbV7.tombstones, dbV7.changeSets,
  ], async () => {
    await dbV7.questions.put(clone);
    for (const membership of selected) {
      await dbV7.bankQuestionMemberships.delete(membership.key);
      await dbV7.tombstones.put({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV7Id("membership-split"), sequence: splitSequence,
      });
    }
    await dbV7.bankQuestionMemberships.bulkPut(movedMemberships);
    if (clonedNote) await dbV7.notes.put(clonedNote);
    await enqueueChangeSetV7([{ kind: "question.split", originalQuestionId: original.id, clone, memberships: movedMemberships, deletedMembershipKeys: selected.map((membership) => membership.key), note: clonedNote }], timestamp, { localSequence: splitSequence });
    for (const membership of selected) await refreshBankQuestionCountInTx(membership.bankId);
  });
  return { original, clones: [clone] };
}

export const splitQuestion = splitQuestionV7;

export function removeMembershipV7(bankId: string, questionId: string): Promise<boolean>;
export function removeMembershipV7(input: Pick<BankQuestionMembership, "bankId" | "questionId">): Promise<boolean>;
export async function removeMembershipV7(
  bankIdOrInput: string | Pick<BankQuestionMembership, "bankId" | "questionId">,
  questionIdArgument?: string,
): Promise<boolean> {
  const bankId = typeof bankIdOrInput === "string" ? bankIdOrInput : bankIdOrInput.bankId;
  const questionId = typeof bankIdOrInput === "string" ? questionIdArgument ?? "" : bankIdOrInput.questionId;
  if (!bankId || !questionId) return false;
  const key = membershipKey(bankId, questionId);
  const current = await dbV7.bankQuestionMemberships.get(key);
  if (!current) return false;
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const membershipDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankQuestionMemberships.delete(key);
    await dbV7.tombstones.put({
      key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
      deletedAt: timestamp, deviceId, eventId: makeV7Id("membership-delete"), sequence: membershipDeleteSequence,
    });
    await enqueueChangeSetV7([{ kind: "membership.remove", bankId, questionId, key, removedAt: timestamp }], timestamp, { localSequence: membershipDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
  });
  return true;
}

export async function removeMembershipsV7(bankId: string, questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!bankId || !uniqueIds.length) return 0;
  const keys = uniqueIds.map((questionId) => membershipKey(bankId, questionId));
  const memberships = (await dbV7.bankQuestionMemberships.bulkGet(keys)).filter((membership): membership is BankQuestionMembership => Boolean(membership));
  if (!memberships.length) return 0;
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const membershipBulkDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.bankQuestionMemberships, dbV7.banks, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV7.tombstones.bulkPut(memberships.map((membership) => ({
      key: tombstoneKey("membership", membership.key), entityType: "membership" as const, entityId: membership.key,
      deletedAt: timestamp, deviceId, eventId: makeV7Id("membership-delete"), sequence: membershipBulkDeleteSequence,
    })));
    await enqueueChangeSetV7([{ kind: "membership.bulk.remove", keys: memberships.map((membership) => membership.key), bankId, removedAt: timestamp }], timestamp, { localSequence: membershipBulkDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
  });
  return memberships.length;
}

export async function deleteQuestionsV7(questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!uniqueIds.length) return 0;
  const questions = (await dbV7.questions.bulkGet(uniqueIds)).filter((question): question is QuestionV7 => Boolean(question));
  if (!questions.length) return 0;
  const existingIds = questions.map((question) => question.id);
  const deletingIds = new Set(existingIds);
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const memberships = await dbV7.bankQuestionMemberships.where("questionId").anyOf(existingIds).toArray();
  const affectedBankIds = [...new Set(memberships.map((membership) => membership.bankId))];
  // H5 导入即删的抵消：被删题目的创建事件仍在本机 pending/blocked（从未推送）时，
  // 从这些 change-set 里滤掉相关 mutation（change-set 变空则整组撤销）。远端从未见过
  // 这些题目，因此它们既不需要墓碑也不需要删除事件——零墓碑零事件。
  const unpublishedIds = new Set<string>();
  const rewritable: Array<{ record: ChangeSetQueueRecordV7; mutations: ChangeSetMutationV7[] }> = [];
  const cancellableIds: string[] = [];
  for (const record of await dbV7.changeSets.where("state").anyOf(["pending", "blocked"]).toArray()) {
    let touched = false;
    const mutations = record.mutations.flatMap((mutation) => {
      const created: string[] = mutation.kind === "question.upsert" ? [mutation.question.id]
        : mutation.kind === "question.import" ? mutation.questions.map((item) => item.id)
        : mutation.kind === "question.split" && deletingIds.has(mutation.clone.id) ? [mutation.clone.id]
        : [];
      const references = mutation.kind === "membership.save" ? [mutation.membership.questionId]
        : mutation.kind === "membership.remove" ? [mutation.questionId]
        : mutation.kind === "note.upserted" ? [mutation.note.questionId]
        : mutation.kind === "note.deleted" ? [mutation.questionId]
        : mutation.kind === "attempt.create" || mutation.kind === "attempt.update" ? [mutation.attempt.questionId]
        : mutation.kind === "attempt.delete" && mutation.questionId ? [mutation.questionId]
        : [];
      if (created.some((id) => deletingIds.has(id))) {
        touched = true;
        created.forEach((id) => deletingIds.has(id) && unpublishedIds.add(id));
        if (mutation.kind === "question.import") {
          // 题库创建保留（空题库合法），只滤掉题目与关系。
          const keptQuestions = mutation.questions.filter((item) => !deletingIds.has(item.id));
          const keptMemberships = mutation.memberships.filter((item) => !deletingIds.has(item.questionId));
          if (!keptQuestions.length && !keptMemberships.length) return [];
          return [{ ...mutation, questions: keptQuestions, memberships: keptMemberships }];
        }
        if (mutation.kind === "question.bulk.upsert") {
          const kept = mutation.questions.filter((item) => !deletingIds.has(item.id));
          return kept.length ? [{ ...mutation, questions: kept }] : [];
        }
        return [];
      }
      if (references.some((id) => deletingIds.has(id))) {
        touched = true;
        return [];
      }
      return [mutation];
    });
    if (!touched) continue;
    if (mutations.length) rewritable.push({ record, mutations });
    else cancellableIds.push(record.id);
  }
  // 只对「远端可能已经见过」的题目写墓碑/删除事件（未被抵消的创建）。
  const publishedIds = existingIds.filter((id) => !unpublishedIds.has(id));
  const publishedMembershipKeys = new Set(memberships.filter((membership) => !unpublishedIds.has(membership.questionId)).map((membership) => membership.key));
  const deleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [
    dbV7.questions, dbV7.bankQuestionMemberships, dbV7.attempts, dbV7.attemptStats,
    dbV7.attemptDailyStats, dbV7.notes, dbV7.questionGroups, dbV7.reviewRoundProgress,
    dbV7.practiceRuns, dbV7.banks, dbV7.tombstones,
    dbV7.changeSets,
  ], async () => {
    for (const id of cancellableIds) await dbV7.changeSets.delete(id);
    for (const { record, mutations } of rewritable) {
      // 重写 digest 承载的 change-set：同 id/序号/时间，只裁剪 mutation。
      const rebuilt = await Dexie.waitFor(createChangeSetV7({ id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, mutations }));
      await dbV7.changeSets.put({ ...record, ...rebuilt, state: "pending", claimId: undefined, claimedAt: undefined, blockedReason: undefined });
    }
    await dbV7.questions.bulkDelete(existingIds);
    await dbV7.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV7.tombstones.bulkPut(memberships.filter((membership) => publishedMembershipKeys.has(membership.key)).map((membership) => ({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV7Id("question-delete"), sequence: deleteSequence,
      })));
    await dbV7.attempts.where("questionId").anyOf(existingIds).delete();
    await dbV7.attemptStats.bulkDelete(existingIds);
    await dbV7.attemptDailyStats.where("questionId").anyOf(existingIds).delete();
    await dbV7.reviewRoundProgress.where("questionId").anyOf(existingIds).delete();
    await dbV7.notes.bulkDelete(existingIds);
    const groups = await dbV7.questionGroups.toArray();
    const emptiedGroupIds: string[] = [];
    for (const group of groups) {
      const items = group.items.filter((item) => !deletingIds.has(item.questionId));
      if (items.length !== group.items.length) {
        if (items.length) await dbV7.questionGroups.put({ ...group, items, updatedAt: timestamp });
        else {
          // E6: 删题把组裁空时，与显式 deleteQuestionGroupV7 一致地写墓碑——本地 tombstone 表
          // 与投影（question.bulk.delete 回放时 updateQuestionDeleteCascade 也写墓碑）保持一致，
          // 使后续到达的陈旧 questionGroup.saved 在本机 rebase 时被 rejectTombstoned 拦截。
          await dbV7.questionGroups.delete(group.id);
          emptiedGroupIds.push(group.id);
        }
      }
    }
    const runs = await dbV7.practiceRuns.toArray();
    for (const run of runs) {
      if (!run.questionIds.some((questionId) => deletingIds.has(questionId))) continue;
      const answers = Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => !deletingIds.has(questionId)));
      const questionTypes = Object.fromEntries(Object.entries(run.questionTypes).filter(([questionId]) => !deletingIds.has(questionId)));
      await dbV7.practiceRuns.put({ ...run, questionIds: run.questionIds.filter((id) => !deletingIds.has(id)), answers, questionTypes, updatedAt: timestamp });
    }
    for (const bankId of affectedBankIds) await refreshBankQuestionCountInTx(bankId);
    const tombstones: TombstoneV7[] = publishedIds.map((questionId) => ({
      key: tombstoneKey("question", questionId),
      entityType: "question",
      entityId: questionId,
      deletedAt: timestamp,
      deviceId,
      eventId: makeV7Id("question-delete"),
      sequence: deleteSequence,
    }));
    for (const groupId of emptiedGroupIds) {
      tombstones.push({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt: timestamp, deviceId, eventId: makeV7Id("question-delete"), sequence: deleteSequence });
    }
    await dbV7.tombstones.bulkPut(tombstones);
    if (publishedIds.length) {
      await enqueueChangeSetV7([{ kind: "question.bulk.delete", questionIds: publishedIds, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: deleteSequence });
    }
  });
  return existingIds.length;
}

export async function deleteQuestionV7(questionId: string): Promise<boolean> {
  return (await deleteQuestionsV7([questionId])) > 0;
}

export const deleteQuestionGlobalV7 = deleteQuestionV7;

/** Delete only the bank and its joins; content and all learning history stay. */
export async function deleteBankV7(bankId: string): Promise<boolean> {
  const bank = await dbV7.banks.get(bankId);
  if (!bank) return false;
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  // Runs that target this bank are dropped with it; otherwise their bankId
  // would dangle and the checkpoint would fail referential validation.
  const runs = (await dbV7.practiceRuns.toArray()).filter((run) => runBankIds(run).includes(bankId));
  const bankDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.banks, dbV7.bankQuestionMemberships, dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV7.banks.delete(bankId);
    for (const run of runs) {
      await updatePracticeRunStatsInTx(run, undefined);
      await dbV7.practiceRuns.delete(run.id);
      await dbV7.tombstones.put({ key: tombstoneKey("practiceRun", run.id), entityType: "practiceRun", entityId: run.id, deletedAt: timestamp, deviceId, eventId: makeV7Id("bank-delete"), sequence: bankDeleteSequence });
    }
    await dbV7.tombstones.put({ key: tombstoneKey("bank", bankId), entityType: "bank", entityId: bankId, deletedAt: timestamp, deviceId, eventId: makeV7Id("bank-delete"), sequence: bankDeleteSequence });
    await enqueueChangeSetV7([{ kind: "bank.delete", bankId, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: bankDeleteSequence });
  });
  return true;
}

export const deleteBankOnlyV7 = deleteBankV7;

export async function deleteBankWithExclusiveQuestionsV7(bankId: string): Promise<{ bankDeleted: boolean; deletedQuestions: number }> {
  const memberships = await dbV7.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  const questionIds = memberships.map((membership) => membership.questionId);
  const allMemberships = questionIds.length ? await dbV7.bankQuestionMemberships.where("questionId").anyOf(questionIds).toArray() : [];
  const membershipCounts = new Map<string, number>();
  for (const membership of allMemberships) membershipCounts.set(membership.questionId, (membershipCounts.get(membership.questionId) ?? 0) + 1);
  const exclusiveQuestionIds = questionIds.filter((questionId) => membershipCounts.get(questionId) === 1);
  const bankDeleted = await deleteBankV7(bankId);
  if (!bankDeleted) return { bankDeleted: false, deletedQuestions: 0 };
  return { bankDeleted: true, deletedQuestions: await deleteQuestionsV7(exclusiveQuestionIds) };
}

interface ImportedQuestionRowV7 {
  stem: string;
  type?: string;
  options?: unknown;
  answer?: unknown;
  tags?: unknown;
}

function rawQuestionRows(raw: unknown): { name?: string; rows: ImportedQuestionRowV7[] } {
  if (typeof raw === "string") {
    try {
      return rawQuestionRows(JSON.parse(raw) as unknown);
    } catch {
      throw new Error("JSON 题库内容无效。");
    }
  }
  if (Array.isArray(raw)) return { rows: raw as ImportedQuestionRowV7[] };
  if (!raw || typeof raw !== "object") throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  const record = raw as Record<string, unknown>;
  const questions = record.questions ?? record.items ?? record.data;
  if (!Array.isArray(questions)) throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  return { name: typeof record.name === "string" ? record.name : undefined, rows: questions as ImportedQuestionRowV7[] };
}

function rowString(row: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (row[key] === undefined || row[key] === null) continue;
    if (Array.isArray(row[key])) return row[key].join("");
    return String(row[key]);
  }
  return "";
}

function rowOptions(row: Record<string, unknown>): unknown {
  return row.options ?? row.a ?? row.choices ?? row["选项"];
}

const ASSET_ID_PATTERN = /^[0-9a-f]{64}$/;
const PLACEHOLDER_TEST = /【图[0-9]+】/;

/** Sanitise semi-trusted imported blocks: text blocks keep their text, image
 *  blocks must reference a materialised 64-hex asset id.  Anything else is
 *  dropped rather than trusted. */
function importedBlocks(value: unknown): ContentBlock[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const blocks: ContentBlock[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string") {
      blocks.push({ id: `text-${blocks.length}`, type: "text", text: normalizeContentText(block.text) });
    } else if (block.type === "image" && typeof block.assetId === "string" && ASSET_ID_PATTERN.test(block.assetId)) {
      blocks.push({ id: `image-${blocks.length}`, type: "image", assetId: block.assetId });
    } else return undefined;
  }
  return blocks;
}

function importDraft(row: ImportedQuestionRowV7): QuestionDraftV7 | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as unknown as Record<string, unknown>;
  const imageIds = Array.isArray(record.images)
    ? record.images.map(String).filter((id) => ASSET_ID_PATTERN.test(id))
    : [];
  // Structured content (zip bundle) wins; otherwise placeholder text (Excel
  // image columns) is split back into blocks, and plain stems stay plain.
  const structuredContent = importedBlocks(record.content);
  const rawStem = normalizeContentText(rowString(record, "stem", "question", "q", "题干"));
  const stem = rawStem || (structuredContent ? deriveContentText(structuredContent) : "");
  if (!stem && !structuredContent?.length) return undefined;
  const content = structuredContent ?? (imageIds.length ? blocksFromPlaceholderText(rawStem, imageIds, "stem") : undefined);
  const cleanStem = content ? undefined : (imageIds.length ? rawStem : stripImagePlaceholders(rawStem));
  const rawOptions = rowOptions(record);
  const blockOptions = Array.isArray(rawOptions) && rawOptions.length > 0 && rawOptions.every((item) => Array.isArray(item))
    ? rawOptions.map((item, index) => importedBlocks(item) ?? plainTextToContentBlocks("", `option-${index}-0`))
    : undefined;
  // Excel image columns ship option text with 【图N】 markers; those options
  // split into block arrays so the images land inside the option itself.
  const placeholderOption = (value: unknown, index: number) => {
    const optionText = String(value ?? "").trim();
    return imageIds.length && PLACEHOLDER_TEST.test(optionText) ? blocksFromPlaceholderText(optionText, imageIds, `option-${index}`) : optionText;
  };
  const options = blockOptions ?? (Array.isArray(rawOptions) ? rawOptions.map(placeholderOption) : []);
  const optionTexts = options.map((option) => typeof option === "string" ? option : deriveContentText(option));
  const rawType = rowString(record, "type", "questionType", "题型").trim();
  const rawAnswer = record.answer ?? record.ans ?? record.correctAnswer ?? record["答案"] ?? "";
  const answer = Array.isArray(rawAnswer) ? rawAnswer.map(String).join("") : String(rawAnswer);
  const type: QuestionTypeV7 = rawType === "判断" || rawType === "单选" || rawType === "多选" || rawType === "计算"
    ? rawType
    : optionTexts.length === 2 && optionTexts[0] === "正确" && optionTexts[1] === "错误"
      ? "判断"
      : answer.replace(/[^A-Z]/gi, "").length > 1 ? "多选" : "单选";
  if (!answer.trim() || (type !== "计算" && options.length < 2)) return undefined;
  const rawTags = record.tags ?? record["标签"];
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(/[，,、\n]+/);
  const note = rowString(record, "note", "analysis", "解析").trim();
  return {
    type,
    ...(content ? { content } : { stem: cleanStem ?? stem }),
    options,
    answer,
    tags: uniqueStrings(tags),
    ...(note ? { note } : {}),
  };
}

/**
 * Import a plain JSON question list.  The bank id is deterministic for a
 * filename/name, while question identity is content-addressed globally.  The
 * import is published as one atomic change-set; when its body exceeds the v7
 * inline-event budget the sync layer offloads it to a content-addressed
 * immutable object, so imports of any size stay within the protocol limits.
 */
export async function importQuestionBankV7(fileName: string, raw: unknown): Promise<BankV7> {
  const parsed = rawQuestionRows(raw);
  const sourceName = (parsed.name?.trim() || fileName.replace(/\.(json|txt)$/i, "").trim());
  if (!sourceName) throw new Error("题库名称不能为空。");
  const rows = parsed.rows.map(importDraft).filter((row): row is QuestionDraftV7 => Boolean(row));
  if (!rows.length) throw new Error("题库中没有可导入的有效题目。");
  const bankId = `bank_${(await sha256Text(sourceName)).slice(0, 48)}`;
  const existingBank = await dbV7.banks.get(bankId);
  const timestamp = nowIso();
  const deviceId = getV7DeviceId();
  const bank: BankV7 = existingBank ? {
    ...existingBank,
    name: existingBank.name || sourceName,
    updatedAt: timestamp,
    deviceId,
  } : {
    id: bankId,
    name: sourceName,
    sortOrder: await dbV7.banks.count(),
    questionCount: 0,
    importedAt: timestamp,
    updatedAt: timestamp,
    deviceId,
  };
  const seenInImport = new Set<string>();
  const materialised: Array<{ question: QuestionV7; membership: BankQuestionMembership }> = [];
  const materialisedNotes: NoteV7[] = [];
  let sortOrder = await dbV7.bankQuestionMemberships.where("bankId").equals(bank.id).count();
  for (const draft of rows) {
    const provisional = questionFromDraft(makeV7Id("question"), draft, timestamp, deviceId);
    const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
    const question = existing ?? provisional;
    if (seenInImport.has(question.id)) continue;
    seenInImport.add(question.id);
    const existingMembership = await dbV7.bankQuestionMemberships.get(membershipKey(bank.id, question.id));
    const membership: BankQuestionMembership = existingMembership ?? {
      key: membershipKey(bank.id, question.id),
      bankId: bank.id,
      questionId: question.id,
      sortOrder: sortOrder++,
      addedAt: timestamp,
      updatedAt: timestamp,
      deviceId,
    };
    materialised.push({ question, membership: { ...membership, updatedAt: timestamp, deviceId } });
    // Imported 解析 becomes a personal note only when the question has none yet;
    // an existing note is user-owned and must not be overwritten by re-import.
    if (draft.note?.trim() && !(await dbV7.notes.get(question.id))) {
      materialisedNotes.push({ questionId: question.id, content: draft.note.trim(), revision: 1, updatedAt: timestamp, deviceId });
    }
  }
  await dbV7.transaction("rw", [dbV7.banks, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.tombstones, dbV7.changeSets, dbV7.notes], async () => {
    await dbV7.banks.put(bank);
    for (const item of materialised) {
      // Existing content is user-owned and already semantically identical;
      // preserving it avoids a second device overwriting tags/favourites.
      if (!(await dbV7.questions.get(item.question.id))) await dbV7.questions.put(item.question);
      await saveMembershipInTx(item.membership);
    }
    for (const note of materialisedNotes) await dbV7.notes.put(note);
    const refreshed = await refreshBankQuestionCountInTx(bank.id);
    if (refreshed) await dbV7.banks.put({ ...refreshed, updatedAt: timestamp, deviceId });
    const bankSnapshot = (await dbV7.banks.get(bank.id))!;
    // A single atomic import change-set. The sync layer offloads any body that
    // exceeds the v7 inline-event budget to a content-addressed immutable
    // object, so a large import no longer needs to be split into byte-bounded
    // chunks here; the whole import applies atomically on every device.
    await enqueueChangeSetV7([{ kind: "question.import", bank: bankSnapshot, questions: materialised.map((item) => item.question), memberships: materialised.map((item) => item.membership) }], timestamp);
    if (materialisedNotes.length) {
      // Imported notes publish as a follow-up batch; the queue planner orders
      // them after question.import because each note depends on its question.
      await enqueueChangeSetV7(materialisedNotes.map((note) => ({ kind: "note.upserted" as const, note })), timestamp);
    }
  });
  return (await dbV7.banks.get(bank.id))!;
}

export const importTextJsonBankV7 = importQuestionBankV7;
export const importBankV7 = importQuestionBankV7;

export async function saveNoteV7(questionId: string, content: string): Promise<NoteV7> {
  const old = await dbV7.notes.get(questionId);
  const timestamp = nowIso();
  const note: NoteV7 = {
    questionId,
    content,
    revision: (old?.revision ?? 0) + 1,
    updatedAt: timestamp,
    deviceId: getV7DeviceId(),
  };
  if (old?.content === content) return old;
  await dbV7.transaction("rw", [dbV7.notes, dbV7.changeSets], async () => {
    await dbV7.notes.put(note);
    const pendingChange = await dbV7.changeSets.where("state").equals("pending").filter((record) => record.mutations.some((mutation) => mutation.kind === "note.upserted" && mutation.note.questionId === questionId)).first();
    if (pendingChange) await dbV7.changeSets.delete(pendingChange.id);
    await enqueueChangeSetV7([{ kind: "note.upserted", note }], timestamp);
  });
  return note;
}

export const upsertNoteV7 = saveNoteV7;

function runBankIds(run: Pick<PracticeRunV7, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

async function updatePracticeRunStatsInTx(previous: PracticeRunV7 | undefined, next: PracticeRunV7 | undefined): Promise<void> {
  const bankIds = new Set([...runBankIds(previous ?? { bankId: "", bankIds: [] }), ...runBankIds(next ?? { bankId: "", bankIds: [] })]);
  for (const bankId of bankIds) {
    if (!bankId) continue;
    const key = bankId;
    const current = await dbV7.practiceRunStats.get(key) ?? { key, bankId, total: 0, completed: 0, inProgress: 0, abandoned: 0, latestUpdatedAt: "" };
    if (previous && runBankIds(previous).includes(bankId)) {
      current.total = Math.max(0, current.total - 1);
      if (previous.status === "completed") current.completed = Math.max(0, current.completed - 1);
      else if (previous.status === "abandoned") current.abandoned = Math.max(0, current.abandoned - 1);
      else current.inProgress = Math.max(0, current.inProgress - 1);
    }
    if (next && runBankIds(next).includes(bankId)) {
      current.total += 1;
      if (next.status === "completed") current.completed += 1;
      else if (next.status === "abandoned") current.abandoned += 1;
      else current.inProgress += 1;
      current.latestUpdatedAt = current.latestUpdatedAt > next.updatedAt ? current.latestUpdatedAt : next.updatedAt;
    }
    if (current.total) await dbV7.practiceRunStats.put(current);
    else await dbV7.practiceRunStats.delete(key);
  }
}

async function deriveRunQuestions(bankIds: string[]): Promise<string[]> {
  return (await getQuestionsForBanksV7(bankIds)).map((question) => question.id);
}

export async function createPracticeRunV7(input: CreatePracticeRunInputV7 = {}): Promise<PracticeRunV7> {
  const bankIds = uniqueStrings(input.bankIds ?? (input.bankId ? [input.bankId] : []));
  const bankId = input.bankId ?? bankIds[0] ?? "";
  const banks = (await dbV7.banks.bulkGet(bankIds)).filter(Boolean) as BankV7[];
  const timestamp = input.startedAt ?? nowIso();
  const questionIds = uniqueStrings(input.questionIds ?? await deriveRunQuestions(bankIds));
  const questions = await dbV7.questions.bulkGet(questionIds);
  const questionTypes = input.questionTypes ?? Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type]));
  const run: PracticeRunV7 = {
    id: input.id ?? makeV7Id("run"),
    bankId,
    bankIds,
    bankName: input.bankName ?? (banks.length === 1 ? bankLabel(banks[0]) : `${banks.length} 个题库组合`),
    mode: input.mode ?? "sequential",
    modeLabel: input.modeLabel ?? "练习",
    questionIds,
    questionTypes,
    answers: input.answers ?? {},
    shuffleOptions: Boolean(input.shuffleOptions),
    optionOrders: input.optionOrders ?? {},
    startedAt: timestamp,
    updatedAt: input.updatedAt ?? timestamp,
    status: input.status ?? "in_progress",
    revision: input.revision ?? 0,
    lastAnsweredIndex: input.lastAnsweredIndex,
    reviewRoundId: input.reviewRoundId,
  };
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.changeSets], async () => {
    await dbV7.practiceRuns.put(run);
    await updatePracticeRunStatsInTx(undefined, run);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run }], timestamp);
  });
  return run;
}

export async function savePracticeRunV7(run: PracticeRunV7): Promise<PracticeRunV7> {
  const current = await dbV7.practiceRuns.get(run.id);
  const updated = { ...run, updatedAt: run.updatedAt || nowIso() };
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV7.practiceRuns.put(updated);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run: updated }], updated.updatedAt);
  });
  return updated;
}

/**
 * Persist navigation and unsubmitted UI progress without creating a domain
 * event. Submitted answers and status changes have their own single events;
 * emitting a run snapshot here would reintroduce the historical two-events-
 * per-answer bug and can exceed the event-page limit for large runs.
 *
 * The read and write are kept inside one transaction, and the run's structural
 * fields (questionIds/questionTypes) are always taken from the authoritative
 * DB row — never from the passed `run`, which may be a stale snapshot. This
 * closes a read-after-write race where a concurrent deleteQuestionsV7 trims the
 * run between the old non-atomic get and put: previously the stale questionIds
 * were written back, resurrecting a just-deleted question in the run. Answers
 * referencing questions no longer in the run are dropped so they cannot
 * outlive their question. Returns undefined if the run was deleted (the caller
 * surfaces that as an ended session — see the run-disappears guard in study-app).
 */
export async function savePracticeProgressV7(run: PracticeRunV7): Promise<PracticeRunV7 | undefined> {
  return dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats], async () => {
    const current = await dbV7.practiceRuns.get(run.id);
    if (!current) return undefined;
    const liveQuestionIds = new Set(current.questionIds);
    const answers = Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => liveQuestionIds.has(questionId)));
    const questionTypes = Object.fromEntries(Object.entries(current.questionTypes).filter(([questionId]) => liveQuestionIds.has(questionId)));
    const updated: PracticeRunV7 = {
      ...current,
      questionIds: current.questionIds,
      questionTypes,
      answers,
      lastAnsweredIndex: run.lastAnsweredIndex,
      updatedAt: run.updatedAt || nowIso(),
      revision: current.revision + 1,
    };
    await updatePracticeRunStatsInTx(current, updated);
    await dbV7.practiceRuns.put(updated);
    return updated;
  });
}

export async function getReviewRoundQuestionIdsV7(roundId: string): Promise<string[]> {
  const round = await dbV7.reviewRounds.get(roundId);
  if (!round) throw new Error("复习轮次不存在或已被删除。");
  if ((round.status === "completed" || round.status === "archived") && round.finalQuestionIds) return uniqueStrings(round.finalQuestionIds);
  return deriveRunQuestions(uniqueStrings(round.bankIds));
}

export const getRoundQuestionIdsV7 = getReviewRoundQuestionIdsV7;

export async function createReviewRoundV7(input: Pick<ReviewRound, "name" | "bankIds"> & Partial<ReviewRound>): Promise<ReviewRound> {
  const timestamp = input.startedAt ?? nowIso();
  const round: ReviewRound = {
    id: input.id ?? makeV7Id("round"),
    name: input.name.trim() || "复习轮次",
    bankIds: uniqueStrings(input.bankIds),
    startedAt: timestamp,
    status: "active",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets], async () => {
    await dbV7.reviewRounds.put(round);
    await enqueueChangeSetV7([{ kind: "review.round.saved", round }], timestamp);
  });
  return round;
}

export async function updateReviewRoundV7(roundId: string, changes: Partial<Pick<ReviewRound, "name" | "bankIds">>): Promise<ReviewRound> {
  const current = await dbV7.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status !== "active") throw new Error("已完成或归档的复习轮次不可修改目标题库。");
  const updated: ReviewRound = {
    ...current,
    name: changes.name === undefined ? current.name : changes.name.trim() || current.name,
    bankIds: changes.bankIds === undefined ? current.bankIds : uniqueStrings(changes.bankIds),
    updatedAt: nowIso(),
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets], async () => {
    await dbV7.reviewRounds.put(updated);
    await enqueueChangeSetV7([{ kind: "review.round.saved", round: updated }], updated.updatedAt);
  });
  return updated;
}

async function completeRoundInTx(round: ReviewRound, finalQuestionIds: string[]): Promise<ReviewRound> {
  const timestamp = nowIso();
  const completed: ReviewRound = { ...round, status: "completed", completedAt: timestamp, finalQuestionIds: uniqueStrings(finalQuestionIds), updatedAt: timestamp, deviceId: getV7DeviceId() };
  await dbV7.reviewRounds.put(completed);
  return completed;
}

export async function completeReviewRoundV7(roundId: string, finalQuestionIds?: readonly string[]): Promise<ReviewRound> {
  const current = await dbV7.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "completed" || current.status === "archived") return current;
  const targets = finalQuestionIds ? uniqueStrings(finalQuestionIds) : await getReviewRoundQuestionIdsV7(roundId);
  return dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets], async () => {
    const completed = await completeRoundInTx(current, targets);
    await enqueueChangeSetV7([{ kind: "review.round.completed", round: completed }], completed.updatedAt);
    return completed;
  });
}

export async function archiveReviewRoundV7(roundId: string): Promise<ReviewRound> {
  const current = await dbV7.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "archived") return current;
  const updated: ReviewRound = { ...current, status: "archived", updatedAt: nowIso(), deviceId: getV7DeviceId() };
  await dbV7.transaction("rw", [dbV7.reviewRounds, dbV7.changeSets], async () => {
    await dbV7.reviewRounds.put(updated);
    await enqueueChangeSetV7([{ kind: "review.round.archived", round: updated }], updated.updatedAt);
  });
  return updated;
}

export const archiveRoundV7 = archiveReviewRoundV7;

export async function saveQuestionGroupV7(input: Pick<QuestionGroupV7, "name" | "type" | "description" | "items"> & { id?: string }): Promise<QuestionGroupV7> {
  const current = input.id ? await dbV7.questionGroups.get(input.id) : undefined;
  const name = input.name.trim();
  if (!name) throw new Error("请输入题组名称。");
  const items = input.items
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.questionId === item.questionId) === index)
    .map((item) => ({ questionId: item.questionId, note: item.note.trim() }));
  if (!items.length) throw new Error("题组至少需要一道题。");
  const existingQuestions = new Set((await dbV7.questions.bulkGet(items.map((item) => item.questionId))).filter(Boolean).map((question) => question!.id));
  if (items.some((item) => !existingQuestions.has(item.questionId))) throw new Error("题组包含不存在或已删除的题目。");
  const updatedAt = nowIso();
  const group: QuestionGroupV7 = {
    id: input.id ?? makeV7Id("group"),
    name,
    type: input.type,
    description: input.description.trim(),
    items,
    createdAt: current?.createdAt ?? updatedAt,
    updatedAt,
    deviceId: getV7DeviceId(),
  };
  await dbV7.transaction("rw", [dbV7.questionGroups, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.questionGroups.put(group);
    await dbV7.tombstones.delete(tombstoneKey("questionGroup", group.id));
    await enqueueChangeSetV7([{ kind: "questionGroup.saved", group }], updatedAt);
  });
  return group;
}

export async function deleteQuestionGroupV7(groupId: string): Promise<boolean> {
  const current = await dbV7.questionGroups.get(groupId);
  if (!current) return false;
  const deletedAt = nowIso();
  const deviceId = getV7DeviceId();
  const eventId = makeV7Id("group-delete");
  const groupDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.questionGroups, dbV7.tombstones, dbV7.changeSets], async () => {
    await dbV7.questionGroups.delete(groupId);
    await dbV7.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId, sequence: groupDeleteSequence });
    await enqueueChangeSetV7([{ kind: "questionGroup.deleted", groupId, deletedAt }], deletedAt, { localSequence: groupDeleteSequence });
  });
  return true;
}

export async function setPracticeRunStatusV7(runId: string, status: PracticeRunV7["status"], answers?: PracticeRunV7["answers"]): Promise<PracticeRunV7 | undefined> {
  const current = await dbV7.practiceRuns.get(runId);
  if (!current) return undefined;
  const updatedAt = nowIso();
  const updated: PracticeRunV7 = {
    ...current,
    answers: answers ?? current.answers,
    status,
    updatedAt,
    completedAt: status === "completed" ? updatedAt : current.completedAt,
    abandonedAt: status === "abandoned" ? updatedAt : undefined,
    revision: current.revision + 1,
  };
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV7.practiceRuns.put(updated);
    await enqueueChangeSetV7([{ kind: "practice.run.status.changed", run: updated }], updatedAt);
  });
  return updated;
}

/** Remove the run projection without deleting global question learning stats. */
export async function deletePracticeRunV7(runId: string): Promise<boolean> {
  const current = await dbV7.practiceRuns.get(runId);
  if (!current) return false;
  const hasSubmittedAnswer = Object.values(current.answers).some((answer) => answer.submitted);
  const deletedAt = nowIso();
  const deviceId = getV7DeviceId();
  const eventId = makeV7Id("run-delete");
  const runDeleteSequence = nextV7Sequence(deviceId);
  await dbV7.transaction("rw", [dbV7.practiceRuns, dbV7.practiceRunStats, dbV7.tombstones, dbV7.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, undefined);
    await dbV7.practiceRuns.delete(runId);
    if (!hasSubmittedAnswer) return;
    await dbV7.tombstones.put({
      key: tombstoneKey("practiceRun", runId), entityType: "practiceRun", entityId: runId,
      deletedAt, deviceId, eventId, sequence: runDeleteSequence,
    });
    await enqueueChangeSetV7([{ kind: "practice.run.deleted", runId, deletedAt }], deletedAt, { localSequence: runDeleteSequence });
  });
  return true;
}

export async function toggleQuestionFavoriteV7(questionId: string): Promise<QuestionV7> {
  const current = await dbV7.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  return updateQuestionV7(questionId, { favorite: !current.favorite });
}

async function autoCompleteRoundIfReadyInTx(roundId: string): Promise<void> {
  const round = await dbV7.reviewRounds.get(roundId);
  if (!round || round.status !== "active") return;
  const targets = await getReviewRoundQuestionIdsV7(roundId);
  if (!targets.length) return;
  const progress = await dbV7.reviewRoundProgress.where("roundId").equals(roundId).toArray();
  const done = new Set(progress.map((item) => item.questionId));
  if (targets.every((questionId) => done.has(questionId))) await completeRoundInTx(round, targets);
}

function addAttemptToStatsV7(current: AttemptStatsV7 | undefined, attempt: AttemptV7): AttemptStatsV7 {
  if (!current) {
    return {
      questionId: attempt.questionId,
      total: 1,
      correct: attempt.correct ? 1 : 0,
      wrong: attempt.correct ? 0 : 1,
      giveUps: attempt.selected ? 0 : 1,
      totalElapsedMs: Math.max(0, attempt.elapsedMs || 0),
      firstAttemptAt: attempt.createdAt,
      firstAttemptCorrect: attempt.correct,
      latestAttemptAt: attempt.createdAt,
      hasBeenWrong: !attempt.correct,
      correctStreakAfterWrong: 0,
      currentCorrectStreak: attempt.correct ? 1 : 0,
      recentOutcomes: [{ id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct }],
    };
  }
  const recentOutcomes = [...current.recentOutcomes, { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct }]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
    .slice(-32);
  let currentCorrectStreak = 0;
  for (let index = recentOutcomes.length - 1; index >= 0 && recentOutcomes[index].correct; index -= 1) currentCorrectStreak += 1;
  const first = attempt.createdAt < current.firstAttemptAt;
  return {
    ...current,
    total: current.total + 1,
    correct: current.correct + (attempt.correct ? 1 : 0),
    wrong: current.wrong + (attempt.correct ? 0 : 1),
    giveUps: current.giveUps + (attempt.selected ? 0 : 1),
    totalElapsedMs: current.totalElapsedMs + Math.max(0, attempt.elapsedMs || 0),
    firstAttemptAt: first ? attempt.createdAt : current.firstAttemptAt,
    firstAttemptCorrect: first ? attempt.correct : current.firstAttemptCorrect,
    latestAttemptAt: attempt.createdAt > current.latestAttemptAt ? attempt.createdAt : current.latestAttemptAt,
    hasBeenWrong: current.hasBeenWrong || !attempt.correct,
    correctStreakAfterWrong: (current.hasBeenWrong || !attempt.correct) ? currentCorrectStreak : 0,
    currentCorrectStreak,
    recentOutcomes,
  };
}

function addDailyStatsV7(current: AttemptDailyStatsV7 | undefined, attempt: AttemptV7): AttemptDailyStatsV7 {
  return {
    key: dailyStatsKey(attempt.createdAt, attempt.questionId),
    date: datePart(attempt.createdAt),
    questionId: attempt.questionId,
    total: (current?.total ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    giveUps: (current?.giveUps ?? 0) + (attempt.selected ? 0 : 1),
    totalElapsedMs: (current?.totalElapsedMs ?? 0) + Math.max(0, attempt.elapsedMs || 0),
  };
}

async function progressForAnswerInTx(roundId: string, questionId: string, attempt: AttemptV7): Promise<void> {
  const key = `${roundId}:${questionId}`;
  const current = await dbV7.reviewRoundProgress.get(key);
  const progress: ReviewRoundProgress = {
    key,
    roundId,
    questionId,
    attempts: (current?.attempts ?? 0) + 1,
    correct: (current?.correct ?? 0) + (attempt.correct ? 1 : 0),
    wrong: (current?.wrong ?? 0) + (attempt.correct ? 0 : 1),
    firstAttemptAt: current?.firstAttemptAt ?? attempt.createdAt,
    latestAttemptAt: attempt.createdAt > (current?.latestAttemptAt ?? "") ? attempt.createdAt : (current?.latestAttemptAt ?? attempt.createdAt),
  };
  await dbV7.reviewRoundProgress.put(progress);
}

/**
 * Submit one answer.  All local projections and the optional round progress
 * are committed in one transaction and exactly one domain event is emitted.
 */
export async function recordPracticeAnswerV7(input: PracticeAnswerInputV7): Promise<{ attempt: AttemptV7; answer: PracticeAnswerV7 }> {
  const run = await dbV7.practiceRuns.get(input.runId);
  if (!run) throw new Error("练习记录不存在或已被删除。");
  if (!run.questionIds.includes(input.questionId)) throw new Error("练习记录不包含当前题目。");
  const selected = uniqueStrings(Array.isArray(input.selected) ? [...input.selected] : [input.selected]);
  const timestamp = input.createdAt ?? nowIso();
  const deviceId = getV7DeviceId();
  const eventId = makeV7Id("answer");
  if (input.reviewRoundId !== undefined && input.reviewRoundId !== run.reviewRoundId) {
    throw new Error("reviewRoundId 必须与练习记录绑定的 active 复习轮次一致。");
  }
  const reviewRoundId = run.reviewRoundId;
  if (reviewRoundId) {
    const round = await dbV7.reviewRounds.get(reviewRoundId);
    if (!round || round.status !== "active") throw new Error("reviewRoundId 必须匹配 active 复习轮次。");
    const targetIds = await getReviewRoundQuestionIdsV7(reviewRoundId);
    if (!targetIds.includes(input.questionId)) throw new Error("当前题目不属于 active 复习轮次。");
    if (run.reviewRoundId && run.reviewRoundId !== reviewRoundId) throw new Error("reviewRoundId 与练习记录不匹配。");
  }
  const sourceBankId = input.sourceBankId ?? input.bankId ?? run.bankIds[0];
  const attempt: AttemptV7 = {
    id: makeV7Id("attempt"),
    runId: input.runId,
    questionId: input.questionId,
    selected: selected.join(""),
    correct: Boolean(input.correct),
    elapsedMs: Math.max(0, Number(input.elapsedMs) || 0),
    createdAt: timestamp,
    deviceId,
    ...(sourceBankId ? { sourceBankId } : {}),
  };
  const answer: PracticeAnswerV7 = {
    selected,
    submitted: true,
    correct: Boolean(input.correct),
    updatedAt: timestamp,
    deviceId,
    eventId,
  };
  const answers = { ...run.answers, [input.questionId]: answer };
  const lastSubmittedIndex = run.questionIds.reduce(
    (last, questionId, index) => answers[questionId]?.submitted ? index : last,
    -1,
  );
  const nextRun: PracticeRunV7 = {
    ...run,
    answers,
    updatedAt: timestamp,
    revision: run.revision + 1,
    lastAnsweredIndex: lastSubmittedIndex >= 0 ? lastSubmittedIndex : run.lastAnsweredIndex,
  };
  await dbV7.transaction("rw", [
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.questions, dbV7.bankQuestionMemberships, dbV7.changeSets,
  ], async () => {
    await dbV7.attempts.put(attempt);
    await dbV7.attemptStats.put(addAttemptToStatsV7(await dbV7.attemptStats.get(input.questionId), attempt));
    const key = dailyStatsKey(timestamp, input.questionId);
    await dbV7.attemptDailyStats.put(addDailyStatsV7(await dbV7.attemptDailyStats.get(key), attempt));
    await updatePracticeRunStatsInTx(run, nextRun);
    await dbV7.practiceRuns.put(nextRun);
    if (reviewRoundId) {
      await progressForAnswerInTx(reviewRoundId, input.questionId, attempt);
      await autoCompleteRoundIfReadyInTx(reviewRoundId);
    }
    const completedRound = reviewRoundId ? await dbV7.reviewRounds.get(reviewRoundId) : undefined;
    await enqueueChangeSetV7([
      { kind: "practice.answer.submitted", attempt, answer, runId: input.runId, questionId: input.questionId, ...(reviewRoundId ? { reviewRoundId } : {}) },
      ...(completedRound?.status === "completed" ? [{ kind: "review.round.completed" as const, round: completedRound }] : []),
    ], timestamp);
  });
  return { attempt, answer };
}

/**
 * Replace every v7 projection atomically.  The `events` store stays dormant
 * (Phase 3) and pending change-sets are deliberately left in place: callers
 * clear `changeSets` separately when a remote tail is being replayed.
 */
export async function restoreV7Checkpoint(state: V7RestoreState): Promise<void> {
  const cachedAssets = await dbV7.imageAssets.toArray();
  const cachedBlobs = new Map(cachedAssets.filter((asset) => asset.blob).map((asset) => [asset.id, asset]));
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  const tables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.imageAssets,
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.tombstones,
  ];
  await dbV7.transaction("rw", tables, async () => {
    for (const table of tables) await table.clear();
    await dbV7.banks.bulkPut(state.banks);
    await dbV7.bankFolders.bulkPut(state.bankFolders);
    await dbV7.questions.bulkPut(state.questions);
    await dbV7.bankQuestionMemberships.bulkPut(memberships);
    await dbV7.imageAssets.bulkPut(state.imageAssets.map((descriptor) => {
      const cached = cachedBlobs.get(descriptor.id);
      return cached?.blob && cached.size === descriptor.size ? { ...descriptor, blob: cached.blob } : descriptor;
    }));
    await dbV7.attempts.bulkPut(state.attempts);
    await dbV7.attemptStats.bulkPut(state.attemptStats);
    await dbV7.attemptDailyStats.bulkPut(state.attemptDailyStats);
    await dbV7.notes.bulkPut(state.notes);
    await dbV7.practiceRuns.bulkPut(state.practiceRuns);
    await dbV7.practiceRunStats.bulkPut(state.practiceRunStats);
    await dbV7.questionGroups.bulkPut(state.questionGroups);
    await dbV7.reviewRounds.bulkPut(state.reviewRounds);
    await dbV7.reviewRoundProgress.bulkPut(state.reviewRoundProgress);
    await dbV7.tombstones.bulkPut(state.tombstones);
  });
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field}必须是 64 位小写 SHA-256 摘要`);
}

function assertImageAssetShape(asset: ImageAsset): void {
  assertDigest(asset.id, "图片 id");
  if (!imageMimeTypes.has(asset.mimeType)) throw new TypeError("图片 MIME 类型不受支持");
  if (!Number.isSafeInteger(asset.size) || asset.size < 0) throw new TypeError("图片 size 必须是非负整数");
  if (!Number.isSafeInteger(asset.width) || asset.width <= 0 || !Number.isSafeInteger(asset.height) || asset.height <= 0) throw new TypeError("图片尺寸必须是正整数");
  if (asset.remote) {
    assertDigest(asset.remote.sha256, "远端图片 sha256");
    if (asset.remote.sha256 !== asset.id) throw new TypeError("远端图片 sha256 必须与 id 一致");
    if (typeof asset.remote.path !== "string" || !asset.remote.path.trim()) throw new TypeError("远端图片路径不能为空");
    if (typeof asset.remote.blobSha !== "string" || !/^[a-f0-9]{40}$/.test(asset.remote.blobSha)) throw new TypeError("远端图片 blobSha 无效");
    if (!Number.isSafeInteger(asset.remote.size) || asset.remote.size !== asset.size) throw new TypeError("远端图片 size 必须与 descriptor 一致");
  }
  if (asset.blob !== undefined && asset.blob.size !== asset.size) throw new TypeError("图片 blob size 与 descriptor 不一致");
}

/** Store a descriptor and, when supplied, verify and cache its blob. */
export async function putImageAssetV7(asset: ImageAsset): Promise<ImageAsset> {
  assertImageAssetShape(asset);
  if (asset.blob) {
    const digest = await sha256Blob(asset.blob);
    if (digest !== asset.id) throw new TypeError("图片 blob 内容与 id 不一致");
  }
  const previous = await dbV7.imageAssets.get(asset.id);
  const descriptorChanged = JSON.stringify({ ...previous, blob: undefined }) !== JSON.stringify({ ...asset, blob: undefined });
  await dbV7.transaction("rw", [dbV7.imageAssets, dbV7.changeSets], async () => {
    await dbV7.imageAssets.put(asset);
    if (asset.remote && descriptorChanged) {
      const createdAt = nowIso();
      const descriptor = { ...asset, blob: undefined };
      await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    }
  });
  return asset;
}

export async function putImageAssetDescriptorV7(asset: Omit<ImageAsset, "blob">): Promise<ImageAsset> {
  return putImageAssetV7(asset);
}

export async function putImageAssetBlobV7(id: string, blob: Blob): Promise<ImageAsset> {
  const descriptor = await dbV7.imageAssets.get(id);
  if (!descriptor) throw new Error("图片 descriptor 不存在。");
  if (await sha256Blob(blob) !== id || blob.size !== descriptor.size) throw new TypeError("图片 blob 内容与 descriptor 不一致");
  const stored = { ...descriptor, blob };
  await dbV7.imageAssets.put(stored);
  return stored;
}

export async function getImageAssetV7(id: string): Promise<ImageAsset | undefined> {
  return dbV7.imageAssets.get(id);
}

export async function getImageAssetDescriptorV7(id: string): Promise<Omit<ImageAsset, "blob"> | undefined> {
  const asset = await dbV7.imageAssets.get(id);
  if (!asset) return undefined;
  const descriptor = { ...asset };
  delete descriptor.blob;
  return descriptor;
}

export async function getImageAssetBlobV7(id: string): Promise<Blob | undefined> {
  return (await dbV7.imageAssets.get(id))?.blob;
}

export async function getImageCacheSizeV7(): Promise<number> {
  const assets = await dbV7.imageAssets.toArray();
  return assets.reduce((total, asset) => total + (asset.blob?.size ?? 0), 0);
}

export async function clearImageCacheV7(): Promise<number> {
  const assets = await dbV7.imageAssets.toArray();
  let cleared = 0;
  await dbV7.transaction("rw", dbV7.imageAssets, async () => {
    for (const asset of assets) {
      if (!asset.blob) continue;
      await dbV7.imageAssets.put({ ...asset, blob: undefined });
      cleared += 1;
    }
  });
  return cleared;
}

export const putImageAssetDescriptor = putImageAssetDescriptorV7;
export const putImageAssetBlob = putImageAssetBlobV7;
export const getImageAssetDescriptor = getImageAssetDescriptorV7;
export const getImageAssetBlob = getImageAssetBlobV7;
export const getImageCacheSize = getImageCacheSizeV7;
export const clearImageCache = clearImageCacheV7;
