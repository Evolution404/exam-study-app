/**
 * The v6 local-first database.
 *
 * This module is deliberately a separate namespace from `lib/db.ts`.  It
 * never imports the legacy database (doing so would construct the old
 * Dexie instance) and it does not contain an upgrade or
 * migration path.  Consumers can opt into v6 incrementally while the v5 UI
 * continues to use its own database.
 */
import Dexie, { type EntityTable } from "dexie";
import { createChangeSetV7, type ChangeSetMutationV7, type ChangeSetV7 } from "../sync/change-set-v7";
import { sha256Blob, sha256Bytes } from "../io/image-assets";
import {
  blocksFromPlaceholderText,
  deriveContentText,
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
  stripImagePlaceholders,
} from "../question/question-content";
import { normalizeCalculationAnswer } from "../question/question-utils";
import type { PracticeAnswerState, PracticeRunStatus, QuestionType } from "../../types/types";
import type {
  AttemptDailyStatsV6,
  AttemptStatsV6,
  AttemptV6,
  BankFolderV6,
  BankQuestionMembership,
  BankV6,
  ContentBlock,
  ImageAsset,
  NoteV6,
  PracticeRunStatsV6,
  PracticeRunV6,
  QuestionGroupV6,
  QuestionTypeV6,
  QuestionV6,
  ReviewRound,
  ReviewRoundProgress,
  SyncFileV6,
  SyncMetaV6,
  TombstoneV6,
} from "./v6-types";
import { SYNC_V6_IMMUTABLE_PREFIX } from "../sync/sync-v6-head";

export const V6_DATABASE_NAME = "shijuan-study-v6" as const;

/**
 * Event payloads intentionally stay small: an answer carries one attempt and
 * one answer projection, while import emits one question/member event per
 * input row.  The run itself is a separate projection/event and is never
 * duplicated inside every answer payload.
 */
export interface PracticeAnswerSubmittedV6Payload {
  attempt: AttemptV6;
  answer: PracticeAnswerV6;
  runId: string;
  questionId: string;
  reviewRoundId?: string;
}

/**
 * The immutable part of a practice run is externalized into a content
 * addressed object so run events stay small regardless of bank size.  The
 * ref names the object by path and digest; the mutable snapshot (answers,
 * status, timestamps) stays in the event payload itself.
 */
export interface RunDefinitionRefV6 {
  path: string;
  sha256: string;
  size: number;
}

/**
 * Immutable projection stored in a sync/v6/objects/<sha256>.json object.
 * Question ids appear once; `types` and `orders` are parallel arrays aligned
 * with `ids` (the historical three id-keyed maps repeated the 64-char id
 * three times, tripling the object).  `orders` is omitted entirely when the
 * run is not shuffled.
 */
export interface RunDefinitionV6 {
  formatVersion: 6;
  kind: "runDefinition";
  runId: string;
  bankId: string;
  bankIds: string[];
  bankName: string;
  mode: string;
  modeLabel: string;
  shuffleOptions: boolean;
  startedAt: string;
  reviewRoundId?: string;
  ids: string[];
  types: QuestionType[];
  orders?: number[][];
}

/** Mutable snapshot carried by practice.run.saved / practice.run.status.changed. */
export interface PracticeRunSnapshotV6Payload {
  runId: string;
  definition: RunDefinitionRefV6;
  answers: Record<string, PracticeAnswerState>;
  status: PracticeRunStatus;
  updatedAt: string;
  revision: number;
  lastAnsweredIndex?: number;
  completedAt?: string;
  abandonedAt?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRunDefinitionV6(value: unknown): value is RunDefinitionV6 {
  if (!isRecord(value)) return false;
  const { formatVersion, kind, runId, bankId, bankIds, ids, types, orders, shuffleOptions, startedAt, reviewRoundId } = value;
  return formatVersion === 6
    && kind === "runDefinition"
    && typeof runId === "string"
    && typeof bankId === "string"
    && Array.isArray(bankIds) && bankIds.every((id) => typeof id === "string")
    && Array.isArray(ids) && ids.every((id) => typeof id === "string")
    && Array.isArray(types) && types.length === ids.length && types.every((type) => typeof type === "string")
    && typeof shuffleOptions === "boolean"
    && (orders === undefined
      || (Array.isArray(orders) && orders.length === ids.length && orders.every((order) => Array.isArray(order) && order.every((item) => typeof item === "number"))))
    && typeof startedAt === "string"
    && (reviewRoundId === undefined || typeof reviewRoundId === "string");
}

/** Deterministic immutable definition value for a run. */
export function runDefinitionValue(run: PracticeRunV6): RunDefinitionV6 {
  return {
    formatVersion: 6,
    kind: "runDefinition",
    runId: run.id,
    bankId: run.bankId,
    bankIds: run.bankIds,
    bankName: run.bankName,
    mode: run.mode,
    modeLabel: run.modeLabel,
    shuffleOptions: run.shuffleOptions,
    startedAt: run.startedAt,
    ...(run.reviewRoundId ? { reviewRoundId: run.reviewRoundId } : {}),
    ids: run.questionIds,
    types: run.questionIds.map((id) => run.questionTypes[id]),
    ...(run.shuffleOptions ? { orders: run.questionIds.map((id) => run.optionOrders[id] ?? []) } : {}),
  };
}

export async function serializeRunDefinition(run: PracticeRunV6): Promise<{ value: RunDefinitionV6; bytes: Uint8Array; sha256: string; size: number }> {
  const value = runDefinitionValue(run);
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { value, bytes, sha256: await sha256Bytes(bytes), size: bytes.byteLength };
}

/** Content-addressed reference to a run's immutable definition. */
export async function runDefinitionRef(run: PracticeRunV6): Promise<RunDefinitionRefV6> {
  const { sha256, size } = await serializeRunDefinition(run);
  return { path: `${SYNC_V6_IMMUTABLE_PREFIX}${sha256}.json`, sha256, size };
}

export function practiceRunSnapshotPayload(run: PracticeRunV6, definition: RunDefinitionRefV6): PracticeRunSnapshotV6Payload {
  return {
    runId: run.id,
    definition,
    answers: run.answers,
    status: run.status,
    updatedAt: run.updatedAt,
    revision: run.revision,
    lastAnsweredIndex: run.lastAnsweredIndex,
    completedAt: run.completedAt,
    abandonedAt: run.abandonedAt,
  };
}

export interface PracticeAnswerV6 {
  selected: string[];
  submitted: true;
  correct: boolean;
  updatedAt: string;
  deviceId: string;
  eventId: string;
}

export interface PracticeAnswerInputV6 {
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

export interface QuestionDraftV6 {
  type: QuestionTypeV6;
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

export interface BankQuestionJoinV6 {
  question: QuestionV6;
  membership: BankQuestionMembership;
}

export interface CreatePracticeRunInputV6 {
  id?: string;
  bankId?: string;
  bankIds?: string[];
  bankName?: string;
  mode?: PracticeRunV6["mode"];
  modeLabel?: string;
  questionIds?: string[];
  questionTypes?: Record<string, QuestionTypeV6>;
  answers?: PracticeRunV6["answers"];
  shuffleOptions?: boolean;
  optionOrders?: Record<string, number[]>;
  startedAt?: string;
  updatedAt?: string;
  status?: PracticeRunV6["status"];
  revision?: number;
  lastAnsweredIndex?: number;
  reviewRoundId?: string;
}

/** Complete projection shape accepted by the v6 atomic restore helper. */
export interface V6RestoreState {
  banks: BankV6[];
  bankFolders: BankFolderV6[];
  questions: QuestionV6[];
  /** Wire checkpoints call this `memberships`; the alias eases internal callers. */
  memberships?: BankQuestionMembership[];
  bankQuestionMemberships?: BankQuestionMembership[];
  imageAssets: ImageAsset[];
  attempts: AttemptV6[];
  attemptStats: AttemptStatsV6[];
  attemptDailyStats: AttemptDailyStatsV6[];
  notes: NoteV6[];
  practiceRuns: PracticeRunV6[];
  practiceRunStats: PracticeRunStatsV6[];
  questionGroups: QuestionGroupV6[];
  reviewRounds: ReviewRound[];
  reviewRoundProgress: ReviewRoundProgress[];
  tombstones: TombstoneV6[];
}

const imageMimeTypes = new Set(["image/webp", "image/jpeg", "image/png"]);
let idCounter = 0;
let sequenceCounter = 0;

function nowIso(): string {
  return new Date().toISOString();
}

export function makeV6Id(prefix = "v6"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export function getV6DeviceId(): string {
  if (typeof localStorage === "undefined") return "server-v6";
  const key = "shijuan-study-v6-device-id";
  let value = localStorage.getItem(key);
  if (!value) {
    value = makeV6Id("device");
    localStorage.setItem(key, value);
  }
  return value;
}

function nextV6Sequence(deviceId = getV6DeviceId()): number {
  sequenceCounter = Math.max(sequenceCounter + 1, Date.now() * 1000);
  if (typeof localStorage !== "undefined") {
    const key = `shijuan-study-v6-sequence:${deviceId}`;
    sequenceCounter = Math.max(sequenceCounter, Number(localStorage.getItem(key)) || 0) + 1;
    localStorage.setItem(key, String(sequenceCounter));
  }
  return sequenceCounter;
}

export async function enqueueChangeSetV7(mutations: readonly ChangeSetMutationV7[], createdAt = nowIso(), options?: { localSequence?: number }): Promise<ChangeSetQueueRecordV7> {
  const deviceId = getV6DeviceId();
  const localSequence = options?.localSequence ?? nextV6Sequence(deviceId);
  const changeSet = await Dexie.waitFor(createChangeSetV7({ deviceId, localSequence, createdAt, mutations }));
  const record: ChangeSetQueueRecordV7 = { ...changeSet, state: "pending" };
  await dbV6.changeSets.put(record);
  return record;
}

export async function listChangeSetsV7(states?: readonly ChangeSetQueueStateV7[]): Promise<ChangeSetQueueRecordV7[]> {
  const rows = states?.length ? await dbV6.changeSets.where("state").anyOf([...states]).toArray() : await dbV6.changeSets.toArray();
  return rows.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.deviceId.localeCompare(right.deviceId) || left.localSequence - right.localSequence || left.id.localeCompare(right.id));
}

export async function claimPendingChangeSetsV7(): Promise<{ claimId: string; records: ChangeSetQueueRecordV7[] }> {
  const claimId = makeV6Id("claim");
  const claimedAt = nowIso();
  return dbV6.transaction("rw", dbV6.changeSets, async () => {
    const pending = await dbV6.changeSets.where("state").equals("pending").toArray();
    const records = pending.map((record) => ({ ...record, state: "claimed" as const, claimId, claimedAt }));
    if (records.length) await dbV6.changeSets.bulkPut(records);
    return { claimId, records };
  });
}

export async function releaseChangeSetClaimV7(claimId: string): Promise<number> {
  return dbV6.transaction("rw", dbV6.changeSets, async () => {
    const claimed = await dbV6.changeSets.where("claimId").equals(claimId).toArray();
    if (claimed.length) await dbV6.changeSets.bulkPut(claimed.map((record) => ({ ...record, state: "pending" as const, claimId: undefined, claimedAt: undefined })));
    return claimed.length;
  });
}

export async function commitChangeSetClaimV7(claimId: string, digests: ReadonlyMap<string, string>, committedAt = nowIso()): Promise<number> {
  return dbV6.transaction("rw", dbV6.changeSets, async () => {
    const claimed = await dbV6.changeSets.where("claimId").equals(claimId).toArray();
    const exact = claimed.filter((record) => digests.get(record.id) === record.digest);
    if (exact.length) await dbV6.changeSets.bulkPut(exact.map((record) => ({ ...record, state: "committed" as const, committedAt })));
    return exact.length;
  });
}

export async function discardPendingChangeSetV7(id: string): Promise<boolean> {
  return dbV6.transaction("rw", dbV6.changeSets, async () => {
    const record = await dbV6.changeSets.get(id);
    if (!record || record.state !== "pending") return false;
    await dbV6.changeSets.delete(id);
    return true;
  });
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeAnswer(type: QuestionTypeV6, input: string | readonly string[]): string {
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

function blocksFromOptions(options: QuestionDraftV6["options"]): ContentBlock[][] {
  return (options ?? []).map((option, optionIndex) => {
    if (Array.isArray(option) && option.every((item) => typeof item === "object")) {
      return normalizeBlocks(option as ContentBlock[]);
    }
    const text = normalizeContentText(String(option ?? ""));
    return plainTextToContentBlocks(text, `option-${optionIndex}-0`);
  });
}

function questionFromDraft(id: string, draft: QuestionDraftV6, timestamp: string, deviceId: string): QuestionV6 {
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
class V6StudyDatabase extends Dexie {
  banks!: EntityTable<BankV6, "id">;
  bankFolders!: EntityTable<BankFolderV6, "id">;
  questions!: EntityTable<QuestionV6, "id">;
  bankQuestionMemberships!: EntityTable<BankQuestionMembership, "key">;
  imageAssets!: EntityTable<ImageAsset, "id">;
  attempts!: EntityTable<AttemptV6, "id">;
  attemptStats!: EntityTable<AttemptStatsV6, "questionId">;
  attemptDailyStats!: EntityTable<AttemptDailyStatsV6, "key">;
  notes!: EntityTable<NoteV6, "questionId">;
  practiceRuns!: EntityTable<PracticeRunV6, "id">;
  practiceRunStats!: EntityTable<PracticeRunStatsV6, "key">;
  questionGroups!: EntityTable<QuestionGroupV6, "id">;
  reviewRounds!: EntityTable<ReviewRound, "id">;
  reviewRoundProgress!: EntityTable<ReviewRoundProgress, "key">;
  changeSets!: EntityTable<ChangeSetQueueRecordV7, "id">;
  syncFiles!: EntityTable<SyncFileV6, "path">;
  tombstones!: EntityTable<TombstoneV6, "key">;
  syncMeta!: EntityTable<SyncMetaV6, "key">;

  constructor() {
    super(V6_DATABASE_NAME);
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
    // v3: the v6 event log is superseded by v7 change-sets; drop the store.
    this.version(3).stores({ events: null });
  }
}

/** The sole v6 database instance.  Constructing it does not open the legacy DB. */
export const dbV6 = new V6StudyDatabase();
/** Short alias used by callers that prefer `v6Db`. */
export const v6Db = dbV6;
/** Class is exported for tests that need a fresh, isolated namespace. */
export { V6StudyDatabase };

export async function resetV6Database(): Promise<void> {
  await dbV6.close();
  await Dexie.delete(V6_DATABASE_NAME);
  await dbV6.open();
}

async function refreshBankQuestionCountInTx(bankId: string): Promise<BankV6 | undefined> {
  const bank = await dbV6.banks.get(bankId);
  if (!bank) return undefined;
  const count = await dbV6.bankQuestionMemberships.where("bankId").equals(bankId).count();
  if (bank.questionCount === count) return bank;
  const updated = { ...bank, questionCount: count };
  await dbV6.banks.put(updated);
  return updated;
}

async function findQuestionByFingerprint(fingerprint: string): Promise<QuestionV6 | undefined> {
  return dbV6.questions.where("contentFingerprint").equals(fingerprint).first();
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

function bankLabel(bank: BankV6): string {
  return bank.displayName?.trim() || bank.name;
}

/** Create a v6 bank.  Counts are always initialised from memberships (zero). */
export function createBankV6(name: string): Promise<BankV6>;
export function createBankV6(input: Partial<BankV6> & Pick<BankV6, "name">): Promise<BankV6>;
export async function createBankV6(input: string | (Partial<BankV6> & Pick<BankV6, "name">)): Promise<BankV6> {
  const values = typeof input === "string" ? { name: input } : input;
  const name = values.name.trim();
  if (!name) throw new Error("题库名称不能为空。");
  const timestamp = values.importedAt ?? nowIso();
  const bank: BankV6 = {
    id: values.id ?? makeV6Id("bank"),
    name,
    displayName: values.displayName?.trim() || undefined,
    description: values.description?.trim() || undefined,
    color: values.color,
    folderId: values.folderId,
    sortOrder: Number.isFinite(values.sortOrder) ? Number(values.sortOrder) : await dbV6.banks.count(),
    questionCount: 0,
    importedAt: values.importedAt ?? timestamp,
    updatedAt: values.updatedAt ?? timestamp,
    deviceId: values.deviceId ?? getV6DeviceId(),
  };
  await dbV6.transaction("rw", [dbV6.banks, dbV6.changeSets], async () => {
    await dbV6.banks.put(bank);
    await enqueueChangeSetV7([{ kind: "bank.create", bank }], timestamp);
  });
  return bank;
}

export async function updateBankV6(bankId: string, changes: Partial<Pick<BankV6, "name" | "displayName" | "description" | "color" | "folderId" | "sortOrder">>): Promise<BankV6> {
  const current = await dbV6.banks.get(bankId);
  if (!current) throw new Error("题库不存在或已被删除。");
  const updated: BankV6 = {
    ...current,
    ...changes,
    name: changes.name?.trim() || current.name,
    displayName: changes.displayName === undefined ? current.displayName : changes.displayName.trim() || undefined,
    description: changes.description === undefined ? current.description : changes.description.trim() || undefined,
    updatedAt: nowIso(),
    deviceId: getV6DeviceId(),
  };
  await dbV6.transaction("rw", [dbV6.banks, dbV6.changeSets], async () => {
    await dbV6.banks.put(updated);
    await enqueueChangeSetV7([{ kind: "bank.update", bank: updated, previous: current }], updated.updatedAt);
  });
  return updated;
}

export async function reorderBanksV6(bankIds: readonly string[], folderId?: string): Promise<BankV6[]> {
  const banks = (await dbV6.banks.bulkGet(uniqueStrings(bankIds))).filter(Boolean) as BankV6[];
  if (!banks.length) return [];
  const updatedAt = nowIso();
  const deviceId = getV6DeviceId();
  const rows = banks.map((bank, sortOrder) => ({ ...bank, folderId, sortOrder, updatedAt, deviceId }));
  await dbV6.transaction("rw", [dbV6.banks, dbV6.changeSets], async () => {
    await dbV6.banks.bulkPut(rows);
    await enqueueChangeSetV7(rows.map((bank) => ({ kind: "bank.update", bank })), updatedAt);
  });
  return rows;
}

export async function saveBankFolderV6(input: Pick<BankFolderV6, "name" | "description"> & { id?: string }): Promise<BankFolderV6> {
  const current = input.id ? await dbV6.bankFolders.get(input.id) : undefined;
  const name = input.name.trim();
  if (!name) throw new Error("请输入文件夹名称。");
  const updatedAt = nowIso();
  const folder: BankFolderV6 = {
    id: input.id ?? makeV6Id("folder"),
    name,
    description: input.description.trim(),
    sortOrder: current?.sortOrder ?? await dbV6.bankFolders.count(),
    createdAt: current?.createdAt ?? updatedAt,
    updatedAt,
    deviceId: getV6DeviceId(),
  };
  await dbV6.transaction("rw", [dbV6.bankFolders, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.bankFolders.put(folder);
    await dbV6.tombstones.delete(tombstoneKey("bankFolder", folder.id));
    await enqueueChangeSetV7([{ kind: "bankFolder.save", folder }], updatedAt);
  });
  return folder;
}

export async function deleteBankFolderV6(folderId: string): Promise<boolean> {
  const current = await dbV6.bankFolders.get(folderId);
  if (!current) return false;
  const updatedAt = nowIso();
  const deviceId = getV6DeviceId();
  const eventId = makeV6Id("folder-delete");
  const banks = await dbV6.banks.where("folderId").equals(folderId).toArray();
  const folderDeleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [dbV6.bankFolders, dbV6.banks, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.bankFolders.delete(folderId);
    const detached = banks.map((bank) => ({ ...bank, folderId: undefined, updatedAt, deviceId }));
    await dbV6.banks.bulkPut(detached);
    await dbV6.tombstones.put({ key: tombstoneKey("bankFolder", folderId), entityType: "bankFolder", entityId: folderId, deletedAt: updatedAt, deviceId, eventId, sequence: folderDeleteSequence });
    await enqueueChangeSetV7([
      ...detached.map((bank) => ({ kind: "bank.update" as const, bank })),
      { kind: "bankFolder.delete", folderId, deletedAt: updatedAt },
    ], updatedAt, { localSequence: folderDeleteSequence });
  });
  return true;
}

/** Return memberships joined with their content, preserving sort order. */
export async function getBankQuestionJoinsV6(bankId: string): Promise<BankQuestionJoinV6[]> {
  const memberships = await dbV6.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  memberships.sort((left, right) => left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
  const questions = new Map((await dbV6.questions.bulkGet(memberships.map((item) => item.questionId))).filter(Boolean).map((item) => [item!.id, item!]));
  return memberships.flatMap((membership) => {
    const question = questions.get(membership.questionId);
    return question ? [{ question, membership }] : [];
  });
}

export async function getBankQuestionMembershipsV6(bankId: string): Promise<BankQuestionMembership[]> {
  return (await dbV6.bankQuestionMemberships.where("bankId").equals(bankId).toArray())
    .sort((left, right) => left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
}

export async function getBankQuestionsV6(bankId: string): Promise<QuestionV6[]> {
  return (await getBankQuestionJoinsV6(bankId)).map((row) => row.question);
}

/** Join multiple banks and deduplicate shared global question ids. */
export async function getQuestionsForBanksV6(bankIds: readonly string[]): Promise<QuestionV6[]> {
  const result: QuestionV6[] = [];
  const seen = new Set<string>();
  for (const bankId of uniqueStrings(bankIds)) {
    for (const row of await getBankQuestionJoinsV6(bankId)) {
      if (seen.has(row.question.id)) continue;
      seen.add(row.question.id);
      result.push(row.question);
    }
  }
  return result;
}

export const queryBankQuestionsV6 = getQuestionsForBanksV6;
export const listBankQuestionsV6 = getBankQuestionsV6;

async function saveMembershipInTx(membership: BankQuestionMembership): Promise<void> {
  const normalized = normalizeMembership(membership);
  const tombstone = await dbV6.tombstones.get(tombstoneKey("membership", normalized.key));
  if (tombstone && compareClock(normalized, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) return;
  if (tombstone) await dbV6.tombstones.delete(tombstone.key);
  await dbV6.bankQuestionMemberships.put(normalized);
}

/** Create content and attach it to a bank, sharing an existing exact match. */
export async function createQuestionV6(bankId: string, draft: QuestionDraftV6): Promise<QuestionV6> {
  const bank = await dbV6.banks.get(bankId);
  if (!bank) throw new Error("题库不存在或已被删除。");
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const provisional = questionFromDraft(makeV6Id("question"), draft, timestamp, deviceId);
  const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
  const question = existing ?? provisional;
  const currentMemberships = await getBankQuestionMembershipsV6(bankId);
  const membership: BankQuestionMembership = {
    key: membershipKey(bankId, question.id),
    bankId,
    questionId: question.id,
    sortOrder: (currentMemberships.at(-1)?.sortOrder ?? -1) + 1,
    addedAt: timestamp,
    updatedAt: timestamp,
    deviceId,
  };
  await dbV6.transaction("rw", [dbV6.questions, dbV6.bankQuestionMemberships, dbV6.banks, dbV6.tombstones, dbV6.changeSets], async () => {
    if (!existing) await dbV6.questions.put(question);
    const currentMembership = await dbV6.bankQuestionMemberships.get(membership.key);
    await saveMembershipInTx(currentMembership ? { ...currentMembership, updatedAt: timestamp, deviceId } : membership);
    await refreshBankQuestionCountInTx(bankId);
    await enqueueChangeSetV7([
      ...(!existing ? [{ kind: "question.upsert" as const, question }] : []),
      { kind: "membership.save", membership },
    ], timestamp);
  });
  return question;
}

export async function updateQuestionV6(questionId: string, changes: Partial<QuestionDraftV6>): Promise<QuestionV6> {
  const current = await dbV6.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  const timestamp = nowIso();
  const draft: QuestionDraftV6 = {
    type: changes.type ?? current.type,
    content: changes.content ?? current.content,
    options: changes.options ?? current.options,
    answer: changes.answer ?? current.answer,
    tags: changes.tags ?? current.tags,
    favorite: changes.favorite ?? current.favorite,
  };
  const updated = questionFromDraft(current.id, draft, timestamp, getV6DeviceId());
  await dbV6.transaction("rw", [dbV6.questions, dbV6.changeSets], async () => {
    await dbV6.questions.put(updated);
    await enqueueChangeSetV7([{ kind: "question.upsert", question: updated }], timestamp);
  });
  return updated;
}

export const updateSharedQuestionV6 = updateQuestionV6;

/**
 * Split selected memberships into one independent shared content object.
 * Historical attempts/statistics/round progress remain attached to the
 * original global question; only the editable note is copied to the clone.
 */
export function splitQuestionV6(questionId: string, selectedBankIds: readonly string[]): Promise<{ original: QuestionV6; clones: QuestionV6[] }>;
export function splitQuestionV6(input: { questionId: string; selectedBankIds: readonly string[] }): Promise<{ original: QuestionV6; clones: QuestionV6[] }>;
export async function splitQuestionV6(
  questionIdOrInput: string | { questionId: string; selectedBankIds: readonly string[] },
  selectedBankIdsArgument?: readonly string[],
): Promise<{ original: QuestionV6; clones: QuestionV6[] }> {
  const questionId = typeof questionIdOrInput === "string" ? questionIdOrInput : questionIdOrInput.questionId;
  const selectedBankIds = typeof questionIdOrInput === "string" ? selectedBankIdsArgument ?? [] : questionIdOrInput.selectedBankIds;
  const original = await dbV6.questions.get(questionId);
  if (!original) throw new Error("题目不存在或已被删除。");
  const wanted = new Set(uniqueStrings(selectedBankIds));
  const memberships = await dbV6.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  const selected = memberships.filter((membership) => wanted.has(membership.bankId));
  if (!selected.length) return { original, clones: [] };
  const sourceNote = await dbV6.notes.get(questionId);
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const clone: QuestionV6 = {
    ...original,
    id: makeV6Id("question"),
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
  const clonedNote: NoteV6 | undefined = sourceNote ? {
    ...sourceNote,
    questionId: clone.id,
    revision: 1,
    updatedAt: timestamp,
    deviceId,
  } : undefined;
  const splitSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [
    dbV6.questions, dbV6.bankQuestionMemberships, dbV6.notes, dbV6.banks,
    dbV6.tombstones, dbV6.changeSets,
  ], async () => {
    await dbV6.questions.put(clone);
    for (const membership of selected) {
      await dbV6.bankQuestionMemberships.delete(membership.key);
      await dbV6.tombstones.put({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV6Id("membership-split"), sequence: splitSequence,
      });
    }
    await dbV6.bankQuestionMemberships.bulkPut(movedMemberships);
    if (clonedNote) await dbV6.notes.put(clonedNote);
    await enqueueChangeSetV7([{ kind: "question.split", originalQuestionId: original.id, clone, memberships: movedMemberships, deletedMembershipKeys: selected.map((membership) => membership.key), note: clonedNote }], timestamp, { localSequence: splitSequence });
    for (const membership of selected) await refreshBankQuestionCountInTx(membership.bankId);
  });
  return { original, clones: [clone] };
}

export const splitQuestion = splitQuestionV6;

export function removeMembershipV6(bankId: string, questionId: string): Promise<boolean>;
export function removeMembershipV6(input: Pick<BankQuestionMembership, "bankId" | "questionId">): Promise<boolean>;
export async function removeMembershipV6(
  bankIdOrInput: string | Pick<BankQuestionMembership, "bankId" | "questionId">,
  questionIdArgument?: string,
): Promise<boolean> {
  const bankId = typeof bankIdOrInput === "string" ? bankIdOrInput : bankIdOrInput.bankId;
  const questionId = typeof bankIdOrInput === "string" ? questionIdArgument ?? "" : bankIdOrInput.questionId;
  if (!bankId || !questionId) return false;
  const key = membershipKey(bankId, questionId);
  const current = await dbV6.bankQuestionMemberships.get(key);
  if (!current) return false;
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const membershipDeleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [dbV6.bankQuestionMemberships, dbV6.banks, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.bankQuestionMemberships.delete(key);
    await dbV6.tombstones.put({
      key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
      deletedAt: timestamp, deviceId, eventId: makeV6Id("membership-delete"), sequence: membershipDeleteSequence,
    });
    await enqueueChangeSetV7([{ kind: "membership.remove", bankId, questionId, key, removedAt: timestamp }], timestamp, { localSequence: membershipDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
  });
  return true;
}

export async function removeMembershipsV6(bankId: string, questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!bankId || !uniqueIds.length) return 0;
  const keys = uniqueIds.map((questionId) => membershipKey(bankId, questionId));
  const memberships = (await dbV6.bankQuestionMemberships.bulkGet(keys)).filter((membership): membership is BankQuestionMembership => Boolean(membership));
  if (!memberships.length) return 0;
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const membershipBulkDeleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [dbV6.bankQuestionMemberships, dbV6.banks, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV6.tombstones.bulkPut(memberships.map((membership) => ({
      key: tombstoneKey("membership", membership.key), entityType: "membership" as const, entityId: membership.key,
      deletedAt: timestamp, deviceId, eventId: makeV6Id("membership-delete"), sequence: membershipBulkDeleteSequence,
    })));
    await enqueueChangeSetV7([{ kind: "membership.bulk.remove", keys: memberships.map((membership) => membership.key), bankId, removedAt: timestamp }], timestamp, { localSequence: membershipBulkDeleteSequence });
    await refreshBankQuestionCountInTx(bankId);
  });
  return memberships.length;
}

export async function deleteQuestionsV6(questionIds: readonly string[]): Promise<number> {
  const uniqueIds = [...new Set(questionIds.filter(Boolean))];
  if (!uniqueIds.length) return 0;
  const questions = (await dbV6.questions.bulkGet(uniqueIds)).filter((question): question is QuestionV6 => Boolean(question));
  if (!questions.length) return 0;
  const existingIds = questions.map((question) => question.id);
  const deletingIds = new Set(existingIds);
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const memberships = await dbV6.bankQuestionMemberships.where("questionId").anyOf(existingIds).toArray();
  const affectedBankIds = [...new Set(memberships.map((membership) => membership.bankId))];
  // H5 导入即删的抵消：被删题目的创建事件仍在本机 pending/blocked（从未推送）时，
  // 从这些 change-set 里滤掉相关 mutation（change-set 变空则整组撤销）。远端从未见过
  // 这些题目，因此它们既不需要墓碑也不需要删除事件——零墓碑零事件。
  const unpublishedIds = new Set<string>();
  const rewritable: Array<{ record: ChangeSetQueueRecordV7; mutations: ChangeSetMutationV7[] }> = [];
  const cancellableIds: string[] = [];
  for (const record of await dbV6.changeSets.where("state").anyOf(["pending", "blocked"]).toArray()) {
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
  const deleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [
    dbV6.questions, dbV6.bankQuestionMemberships, dbV6.attempts, dbV6.attemptStats,
    dbV6.attemptDailyStats, dbV6.notes, dbV6.questionGroups, dbV6.reviewRoundProgress,
    dbV6.practiceRuns, dbV6.banks, dbV6.tombstones,
    dbV6.changeSets,
  ], async () => {
    for (const id of cancellableIds) await dbV6.changeSets.delete(id);
    for (const { record, mutations } of rewritable) {
      // 重写 digest 承载的 change-set：同 id/序号/时间，只裁剪 mutation。
      const rebuilt = await Dexie.waitFor(createChangeSetV7({ id: record.id, deviceId: record.deviceId, localSequence: record.localSequence, createdAt: record.createdAt, mutations }));
      await dbV6.changeSets.put({ ...record, ...rebuilt, state: "pending", claimId: undefined, claimedAt: undefined, blockedReason: undefined });
    }
    await dbV6.questions.bulkDelete(existingIds);
    await dbV6.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV6.tombstones.bulkPut(memberships.filter((membership) => publishedMembershipKeys.has(membership.key)).map((membership) => ({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV6Id("question-delete"), sequence: deleteSequence,
      })));
    await dbV6.attempts.where("questionId").anyOf(existingIds).delete();
    await dbV6.attemptStats.bulkDelete(existingIds);
    await dbV6.attemptDailyStats.where("questionId").anyOf(existingIds).delete();
    await dbV6.reviewRoundProgress.where("questionId").anyOf(existingIds).delete();
    await dbV6.notes.bulkDelete(existingIds);
    const groups = await dbV6.questionGroups.toArray();
    const emptiedGroupIds: string[] = [];
    for (const group of groups) {
      const items = group.items.filter((item) => !deletingIds.has(item.questionId));
      if (items.length !== group.items.length) {
        if (items.length) await dbV6.questionGroups.put({ ...group, items, updatedAt: timestamp });
        else {
          // E6: 删题把组裁空时，与显式 deleteQuestionGroupV6 一致地写墓碑——本地 tombstone 表
          // 与投影（question.bulk.delete 回放时 updateQuestionDeleteCascade 也写墓碑）保持一致，
          // 使后续到达的陈旧 questionGroup.saved 在本机 rebase 时被 rejectTombstoned 拦截。
          await dbV6.questionGroups.delete(group.id);
          emptiedGroupIds.push(group.id);
        }
      }
    }
    const runs = await dbV6.practiceRuns.toArray();
    for (const run of runs) {
      if (!run.questionIds.some((questionId) => deletingIds.has(questionId))) continue;
      const answers = Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => !deletingIds.has(questionId)));
      const questionTypes = Object.fromEntries(Object.entries(run.questionTypes).filter(([questionId]) => !deletingIds.has(questionId)));
      await dbV6.practiceRuns.put({ ...run, questionIds: run.questionIds.filter((id) => !deletingIds.has(id)), answers, questionTypes, updatedAt: timestamp });
    }
    for (const bankId of affectedBankIds) await refreshBankQuestionCountInTx(bankId);
    const tombstones: TombstoneV6[] = publishedIds.map((questionId) => ({
      key: tombstoneKey("question", questionId),
      entityType: "question",
      entityId: questionId,
      deletedAt: timestamp,
      deviceId,
      eventId: makeV6Id("question-delete"),
      sequence: deleteSequence,
    }));
    for (const groupId of emptiedGroupIds) {
      tombstones.push({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt: timestamp, deviceId, eventId: makeV6Id("question-delete"), sequence: deleteSequence });
    }
    await dbV6.tombstones.bulkPut(tombstones);
    if (publishedIds.length) {
      await enqueueChangeSetV7([{ kind: "question.bulk.delete", questionIds: publishedIds, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: deleteSequence });
    }
  });
  return existingIds.length;
}

export async function deleteQuestionV6(questionId: string): Promise<boolean> {
  return (await deleteQuestionsV6([questionId])) > 0;
}

export const deleteQuestionGlobalV6 = deleteQuestionV6;

/** Delete only the bank and its joins; content and all learning history stay. */
export async function deleteBankV6(bankId: string): Promise<boolean> {
  const bank = await dbV6.banks.get(bankId);
  if (!bank) return false;
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const memberships = await dbV6.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  // Runs that target this bank are dropped with it; otherwise their bankId
  // would dangle and the checkpoint would fail referential validation.
  const runs = (await dbV6.practiceRuns.toArray()).filter((run) => runBankIds(run).includes(bankId));
  const bankDeleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [dbV6.banks, dbV6.bankQuestionMemberships, dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV6.banks.delete(bankId);
    for (const run of runs) {
      await updatePracticeRunStatsInTx(run, undefined);
      await dbV6.practiceRuns.delete(run.id);
      await dbV6.tombstones.put({ key: tombstoneKey("practiceRun", run.id), entityType: "practiceRun", entityId: run.id, deletedAt: timestamp, deviceId, eventId: makeV6Id("bank-delete"), sequence: bankDeleteSequence });
    }
    await dbV6.tombstones.put({ key: tombstoneKey("bank", bankId), entityType: "bank", entityId: bankId, deletedAt: timestamp, deviceId, eventId: makeV6Id("bank-delete"), sequence: bankDeleteSequence });
    await enqueueChangeSetV7([{ kind: "bank.delete", bankId, deletedAt: timestamp, cascade: true }], timestamp, { localSequence: bankDeleteSequence });
  });
  return true;
}

export const deleteBankOnlyV6 = deleteBankV6;

export async function deleteBankWithExclusiveQuestionsV6(bankId: string): Promise<{ bankDeleted: boolean; deletedQuestions: number }> {
  const memberships = await dbV6.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  const questionIds = memberships.map((membership) => membership.questionId);
  const allMemberships = questionIds.length ? await dbV6.bankQuestionMemberships.where("questionId").anyOf(questionIds).toArray() : [];
  const membershipCounts = new Map<string, number>();
  for (const membership of allMemberships) membershipCounts.set(membership.questionId, (membershipCounts.get(membership.questionId) ?? 0) + 1);
  const exclusiveQuestionIds = questionIds.filter((questionId) => membershipCounts.get(questionId) === 1);
  const bankDeleted = await deleteBankV6(bankId);
  if (!bankDeleted) return { bankDeleted: false, deletedQuestions: 0 };
  return { bankDeleted: true, deletedQuestions: await deleteQuestionsV6(exclusiveQuestionIds) };
}

interface ImportedQuestionRowV6 {
  stem: string;
  type?: string;
  options?: unknown;
  answer?: unknown;
  tags?: unknown;
}

function rawQuestionRows(raw: unknown): { name?: string; rows: ImportedQuestionRowV6[] } {
  if (typeof raw === "string") {
    try {
      return rawQuestionRows(JSON.parse(raw) as unknown);
    } catch {
      throw new Error("JSON 题库内容无效。");
    }
  }
  if (Array.isArray(raw)) return { rows: raw as ImportedQuestionRowV6[] };
  if (!raw || typeof raw !== "object") throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  const record = raw as Record<string, unknown>;
  const questions = record.questions ?? record.items ?? record.data;
  if (!Array.isArray(questions)) throw new Error("未找到题目数组。支持数组或 { questions: [] } 格式。");
  return { name: typeof record.name === "string" ? record.name : undefined, rows: questions as ImportedQuestionRowV6[] };
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

function importDraft(row: ImportedQuestionRowV6): QuestionDraftV6 | undefined {
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
  const type: QuestionTypeV6 = rawType === "判断" || rawType === "单选" || rawType === "多选" || rawType === "计算"
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
export async function importQuestionBankV6(fileName: string, raw: unknown): Promise<BankV6> {
  const parsed = rawQuestionRows(raw);
  const sourceName = (parsed.name?.trim() || fileName.replace(/\.(json|txt)$/i, "").trim());
  if (!sourceName) throw new Error("题库名称不能为空。");
  const rows = parsed.rows.map(importDraft).filter((row): row is QuestionDraftV6 => Boolean(row));
  if (!rows.length) throw new Error("题库中没有可导入的有效题目。");
  const bankId = `bank_${(await sha256Text(sourceName)).slice(0, 48)}`;
  const existingBank = await dbV6.banks.get(bankId);
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const bank: BankV6 = existingBank ? {
    ...existingBank,
    name: existingBank.name || sourceName,
    updatedAt: timestamp,
    deviceId,
  } : {
    id: bankId,
    name: sourceName,
    sortOrder: await dbV6.banks.count(),
    questionCount: 0,
    importedAt: timestamp,
    updatedAt: timestamp,
    deviceId,
  };
  const seenInImport = new Set<string>();
  const materialised: Array<{ question: QuestionV6; membership: BankQuestionMembership }> = [];
  const materialisedNotes: NoteV6[] = [];
  let sortOrder = await dbV6.bankQuestionMemberships.where("bankId").equals(bank.id).count();
  for (const draft of rows) {
    const provisional = questionFromDraft(makeV6Id("question"), draft, timestamp, deviceId);
    const existing = await findQuestionByFingerprint(provisional.contentFingerprint);
    const question = existing ?? provisional;
    if (seenInImport.has(question.id)) continue;
    seenInImport.add(question.id);
    const existingMembership = await dbV6.bankQuestionMemberships.get(membershipKey(bank.id, question.id));
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
    if (draft.note?.trim() && !(await dbV6.notes.get(question.id))) {
      materialisedNotes.push({ questionId: question.id, content: draft.note.trim(), revision: 1, updatedAt: timestamp, deviceId });
    }
  }
  await dbV6.transaction("rw", [dbV6.banks, dbV6.questions, dbV6.bankQuestionMemberships, dbV6.tombstones, dbV6.changeSets, dbV6.notes], async () => {
    await dbV6.banks.put(bank);
    for (const item of materialised) {
      // Existing content is user-owned and already semantically identical;
      // preserving it avoids a second device overwriting tags/favourites.
      if (!(await dbV6.questions.get(item.question.id))) await dbV6.questions.put(item.question);
      await saveMembershipInTx(item.membership);
    }
    for (const note of materialisedNotes) await dbV6.notes.put(note);
    const refreshed = await refreshBankQuestionCountInTx(bank.id);
    if (refreshed) await dbV6.banks.put({ ...refreshed, updatedAt: timestamp, deviceId });
    const bankSnapshot = (await dbV6.banks.get(bank.id))!;
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
  return (await dbV6.banks.get(bank.id))!;
}

export const importTextJsonBankV6 = importQuestionBankV6;
export const importBankV6 = importQuestionBankV6;

export async function saveNoteV6(questionId: string, content: string): Promise<NoteV6> {
  const old = await dbV6.notes.get(questionId);
  const timestamp = nowIso();
  const note: NoteV6 = {
    questionId,
    content,
    revision: (old?.revision ?? 0) + 1,
    updatedAt: timestamp,
    deviceId: getV6DeviceId(),
  };
  if (old?.content === content) return old;
  await dbV6.transaction("rw", [dbV6.notes, dbV6.changeSets], async () => {
    await dbV6.notes.put(note);
    const pendingChange = await dbV6.changeSets.where("state").equals("pending").filter((record) => record.mutations.some((mutation) => mutation.kind === "note.upserted" && mutation.note.questionId === questionId)).first();
    if (pendingChange) await dbV6.changeSets.delete(pendingChange.id);
    await enqueueChangeSetV7([{ kind: "note.upserted", note }], timestamp);
  });
  return note;
}

export const upsertNoteV6 = saveNoteV6;

function runBankIds(run: Pick<PracticeRunV6, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

async function updatePracticeRunStatsInTx(previous: PracticeRunV6 | undefined, next: PracticeRunV6 | undefined): Promise<void> {
  const bankIds = new Set([...runBankIds(previous ?? { bankId: "", bankIds: [] }), ...runBankIds(next ?? { bankId: "", bankIds: [] })]);
  for (const bankId of bankIds) {
    if (!bankId) continue;
    const key = bankId;
    const current = await dbV6.practiceRunStats.get(key) ?? { key, bankId, total: 0, completed: 0, inProgress: 0, abandoned: 0, latestUpdatedAt: "" };
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
    if (current.total) await dbV6.practiceRunStats.put(current);
    else await dbV6.practiceRunStats.delete(key);
  }
}

async function deriveRunQuestions(bankIds: string[]): Promise<string[]> {
  return (await getQuestionsForBanksV6(bankIds)).map((question) => question.id);
}

export async function createPracticeRunV6(input: CreatePracticeRunInputV6 = {}): Promise<PracticeRunV6> {
  const bankIds = uniqueStrings(input.bankIds ?? (input.bankId ? [input.bankId] : []));
  const bankId = input.bankId ?? bankIds[0] ?? "";
  const banks = (await dbV6.banks.bulkGet(bankIds)).filter(Boolean) as BankV6[];
  const timestamp = input.startedAt ?? nowIso();
  const questionIds = uniqueStrings(input.questionIds ?? await deriveRunQuestions(bankIds));
  const questions = await dbV6.questions.bulkGet(questionIds);
  const questionTypes = input.questionTypes ?? Object.fromEntries(questions.filter(Boolean).map((question) => [question!.id, question!.type]));
  const run: PracticeRunV6 = {
    id: input.id ?? makeV6Id("run"),
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
  // The immutable definition is externalized: the event carries only a
  // content-addressed ref plus the mutable snapshot, independent of bank size.
  const snapshot = practiceRunSnapshotPayload(run, await runDefinitionRef(run));
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.changeSets], async () => {
    await dbV6.practiceRuns.put(run);
    await updatePracticeRunStatsInTx(undefined, run);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run, definition: { path: snapshot.definition.path, sha256: snapshot.definition.sha256, size: snapshot.definition.size, kind: "run-definition" } }], timestamp);
  });
  return run;
}

export async function savePracticeRunV6(run: PracticeRunV6): Promise<PracticeRunV6> {
  const current = await dbV6.practiceRuns.get(run.id);
  const updated = { ...run, updatedAt: run.updatedAt || nowIso() };
  const snapshot = practiceRunSnapshotPayload(updated, await runDefinitionRef(updated));
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV6.practiceRuns.put(updated);
    await enqueueChangeSetV7([{ kind: "practice.run.saved", run: updated, definition: { path: snapshot.definition.path, sha256: snapshot.definition.sha256, size: snapshot.definition.size, kind: "run-definition" } }], updated.updatedAt);
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
 * closes a read-after-write race where a concurrent deleteQuestionsV6 trims the
 * run between the old non-atomic get and put: previously the stale questionIds
 * were written back, resurrecting a just-deleted question in the run. Answers
 * referencing questions no longer in the run are dropped so they cannot
 * outlive their question. Returns undefined if the run was deleted (the caller
 * surfaces that as an ended session — see the run-disappears guard in study-app).
 */
export async function savePracticeProgressV6(run: PracticeRunV6): Promise<PracticeRunV6 | undefined> {
  return dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats], async () => {
    const current = await dbV6.practiceRuns.get(run.id);
    if (!current) return undefined;
    const liveQuestionIds = new Set(current.questionIds);
    const answers = Object.fromEntries(Object.entries(run.answers).filter(([questionId]) => liveQuestionIds.has(questionId)));
    const questionTypes = Object.fromEntries(Object.entries(current.questionTypes).filter(([questionId]) => liveQuestionIds.has(questionId)));
    const updated: PracticeRunV6 = {
      ...current,
      questionIds: current.questionIds,
      questionTypes,
      answers,
      lastAnsweredIndex: run.lastAnsweredIndex,
      updatedAt: run.updatedAt || nowIso(),
      revision: current.revision + 1,
    };
    await updatePracticeRunStatsInTx(current, updated);
    await dbV6.practiceRuns.put(updated);
    return updated;
  });
}

export async function getReviewRoundQuestionIdsV6(roundId: string): Promise<string[]> {
  const round = await dbV6.reviewRounds.get(roundId);
  if (!round) throw new Error("复习轮次不存在或已被删除。");
  if ((round.status === "completed" || round.status === "archived") && round.finalQuestionIds) return uniqueStrings(round.finalQuestionIds);
  return deriveRunQuestions(uniqueStrings(round.bankIds));
}

export const getRoundQuestionIdsV6 = getReviewRoundQuestionIdsV6;

export async function createReviewRoundV6(input: Pick<ReviewRound, "name" | "bankIds"> & Partial<ReviewRound>): Promise<ReviewRound> {
  const timestamp = input.startedAt ?? nowIso();
  const round: ReviewRound = {
    id: input.id ?? makeV6Id("round"),
    name: input.name.trim() || "复习轮次",
    bankIds: uniqueStrings(input.bankIds),
    startedAt: timestamp,
    status: "active",
    createdAt: input.createdAt ?? timestamp,
    updatedAt: timestamp,
    deviceId: getV6DeviceId(),
  };
  await dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.changeSets], async () => {
    await dbV6.reviewRounds.put(round);
    await enqueueChangeSetV7([{ kind: "review.round.saved", round }], timestamp);
  });
  return round;
}

export async function updateReviewRoundV6(roundId: string, changes: Partial<Pick<ReviewRound, "name" | "bankIds">>): Promise<ReviewRound> {
  const current = await dbV6.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status !== "active") throw new Error("已完成或归档的复习轮次不可修改目标题库。");
  const updated: ReviewRound = {
    ...current,
    name: changes.name === undefined ? current.name : changes.name.trim() || current.name,
    bankIds: changes.bankIds === undefined ? current.bankIds : uniqueStrings(changes.bankIds),
    updatedAt: nowIso(),
    deviceId: getV6DeviceId(),
  };
  await dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.changeSets], async () => {
    await dbV6.reviewRounds.put(updated);
    await enqueueChangeSetV7([{ kind: "review.round.saved", round: updated }], updated.updatedAt);
  });
  return updated;
}

async function completeRoundInTx(round: ReviewRound, finalQuestionIds: string[]): Promise<ReviewRound> {
  const timestamp = nowIso();
  const completed: ReviewRound = { ...round, status: "completed", completedAt: timestamp, finalQuestionIds: uniqueStrings(finalQuestionIds), updatedAt: timestamp, deviceId: getV6DeviceId() };
  await dbV6.reviewRounds.put(completed);
  return completed;
}

export async function completeReviewRoundV6(roundId: string, finalQuestionIds?: readonly string[]): Promise<ReviewRound> {
  const current = await dbV6.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "completed" || current.status === "archived") return current;
  const targets = finalQuestionIds ? uniqueStrings(finalQuestionIds) : await getReviewRoundQuestionIdsV6(roundId);
  return dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.changeSets], async () => {
    const completed = await completeRoundInTx(current, targets);
    await enqueueChangeSetV7([{ kind: "review.round.completed", round: completed }], completed.updatedAt);
    return completed;
  });
}

export async function archiveReviewRoundV6(roundId: string): Promise<ReviewRound> {
  const current = await dbV6.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "archived") return current;
  const updated: ReviewRound = { ...current, status: "archived", updatedAt: nowIso(), deviceId: getV6DeviceId() };
  await dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.changeSets], async () => {
    await dbV6.reviewRounds.put(updated);
    await enqueueChangeSetV7([{ kind: "review.round.archived", round: updated }], updated.updatedAt);
  });
  return updated;
}

export const archiveRoundV6 = archiveReviewRoundV6;

export async function saveQuestionGroupV6(input: Pick<QuestionGroupV6, "name" | "type" | "description" | "items"> & { id?: string }): Promise<QuestionGroupV6> {
  const current = input.id ? await dbV6.questionGroups.get(input.id) : undefined;
  const name = input.name.trim();
  if (!name) throw new Error("请输入题组名称。");
  const items = input.items
    .filter((item, index, rows) => rows.findIndex((candidate) => candidate.questionId === item.questionId) === index)
    .map((item) => ({ questionId: item.questionId, note: item.note.trim() }));
  if (!items.length) throw new Error("题组至少需要一道题。");
  const existingQuestions = new Set((await dbV6.questions.bulkGet(items.map((item) => item.questionId))).filter(Boolean).map((question) => question!.id));
  if (items.some((item) => !existingQuestions.has(item.questionId))) throw new Error("题组包含不存在或已删除的题目。");
  const updatedAt = nowIso();
  const group: QuestionGroupV6 = {
    id: input.id ?? makeV6Id("group"),
    name,
    type: input.type,
    description: input.description.trim(),
    items,
    createdAt: current?.createdAt ?? updatedAt,
    updatedAt,
    deviceId: getV6DeviceId(),
  };
  await dbV6.transaction("rw", [dbV6.questionGroups, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.questionGroups.put(group);
    await dbV6.tombstones.delete(tombstoneKey("questionGroup", group.id));
    await enqueueChangeSetV7([{ kind: "questionGroup.saved", group }], updatedAt);
  });
  return group;
}

export async function deleteQuestionGroupV6(groupId: string): Promise<boolean> {
  const current = await dbV6.questionGroups.get(groupId);
  if (!current) return false;
  const deletedAt = nowIso();
  const deviceId = getV6DeviceId();
  const eventId = makeV6Id("group-delete");
  const groupDeleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [dbV6.questionGroups, dbV6.tombstones, dbV6.changeSets], async () => {
    await dbV6.questionGroups.delete(groupId);
    await dbV6.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId, sequence: groupDeleteSequence });
    await enqueueChangeSetV7([{ kind: "questionGroup.deleted", groupId, deletedAt }], deletedAt, { localSequence: groupDeleteSequence });
  });
  return true;
}

export async function setPracticeRunStatusV6(runId: string, status: PracticeRunV6["status"], answers?: PracticeRunV6["answers"]): Promise<PracticeRunV6 | undefined> {
  const current = await dbV6.practiceRuns.get(runId);
  if (!current) return undefined;
  const updatedAt = nowIso();
  const updated: PracticeRunV6 = {
    ...current,
    answers: answers ?? current.answers,
    status,
    updatedAt,
    completedAt: status === "completed" ? updatedAt : current.completedAt,
    abandonedAt: status === "abandoned" ? updatedAt : undefined,
    revision: current.revision + 1,
  };
  const snapshot = practiceRunSnapshotPayload(updated, await runDefinitionRef(updated));
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV6.practiceRuns.put(updated);
    await enqueueChangeSetV7([{ kind: "practice.run.status.changed", run: updated, definition: { path: snapshot.definition.path, sha256: snapshot.definition.sha256, size: snapshot.definition.size, kind: "run-definition" } }], updatedAt);
  });
  return updated;
}

/** Remove the run projection without deleting global question learning stats. */
export async function deletePracticeRunV6(runId: string): Promise<boolean> {
  const current = await dbV6.practiceRuns.get(runId);
  if (!current) return false;
  const hasSubmittedAnswer = Object.values(current.answers).some((answer) => answer.submitted);
  const deletedAt = nowIso();
  const deviceId = getV6DeviceId();
  const eventId = makeV6Id("run-delete");
  const runDeleteSequence = nextV6Sequence(deviceId);
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.tombstones, dbV6.changeSets], async () => {
    await updatePracticeRunStatsInTx(current, undefined);
    await dbV6.practiceRuns.delete(runId);
    if (!hasSubmittedAnswer) return;
    await dbV6.tombstones.put({
      key: tombstoneKey("practiceRun", runId), entityType: "practiceRun", entityId: runId,
      deletedAt, deviceId, eventId, sequence: runDeleteSequence,
    });
    await enqueueChangeSetV7([{ kind: "practice.run.deleted", runId, deletedAt }], deletedAt, { localSequence: runDeleteSequence });
  });
  return true;
}

export async function toggleQuestionFavoriteV6(questionId: string): Promise<QuestionV6> {
  const current = await dbV6.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  return updateQuestionV6(questionId, { favorite: !current.favorite });
}

async function autoCompleteRoundIfReadyInTx(roundId: string): Promise<void> {
  const round = await dbV6.reviewRounds.get(roundId);
  if (!round || round.status !== "active") return;
  const targets = await getReviewRoundQuestionIdsV6(roundId);
  if (!targets.length) return;
  const progress = await dbV6.reviewRoundProgress.where("roundId").equals(roundId).toArray();
  const done = new Set(progress.map((item) => item.questionId));
  if (targets.every((questionId) => done.has(questionId))) await completeRoundInTx(round, targets);
}

function addAttemptToStatsV6(current: AttemptStatsV6 | undefined, attempt: AttemptV6): AttemptStatsV6 {
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

function addDailyStatsV6(current: AttemptDailyStatsV6 | undefined, attempt: AttemptV6): AttemptDailyStatsV6 {
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

async function progressForAnswerInTx(roundId: string, questionId: string, attempt: AttemptV6): Promise<void> {
  const key = `${roundId}:${questionId}`;
  const current = await dbV6.reviewRoundProgress.get(key);
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
  await dbV6.reviewRoundProgress.put(progress);
}

/**
 * Submit one answer.  All local projections and the optional round progress
 * are committed in one transaction and exactly one domain event is emitted.
 */
export async function recordPracticeAnswerV6(input: PracticeAnswerInputV6): Promise<{ attempt: AttemptV6; answer: PracticeAnswerV6 }> {
  const run = await dbV6.practiceRuns.get(input.runId);
  if (!run) throw new Error("练习记录不存在或已被删除。");
  if (!run.questionIds.includes(input.questionId)) throw new Error("练习记录不包含当前题目。");
  const selected = uniqueStrings(Array.isArray(input.selected) ? [...input.selected] : [input.selected]);
  const timestamp = input.createdAt ?? nowIso();
  const deviceId = getV6DeviceId();
  const eventId = makeV6Id("answer");
  if (input.reviewRoundId !== undefined && input.reviewRoundId !== run.reviewRoundId) {
    throw new Error("reviewRoundId 必须与练习记录绑定的 active 复习轮次一致。");
  }
  const reviewRoundId = run.reviewRoundId;
  if (reviewRoundId) {
    const round = await dbV6.reviewRounds.get(reviewRoundId);
    if (!round || round.status !== "active") throw new Error("reviewRoundId 必须匹配 active 复习轮次。");
    const targetIds = await getReviewRoundQuestionIdsV6(reviewRoundId);
    if (!targetIds.includes(input.questionId)) throw new Error("当前题目不属于 active 复习轮次。");
    if (run.reviewRoundId && run.reviewRoundId !== reviewRoundId) throw new Error("reviewRoundId 与练习记录不匹配。");
  }
  const sourceBankId = input.sourceBankId ?? input.bankId ?? run.bankIds[0];
  const attempt: AttemptV6 = {
    id: makeV6Id("attempt"),
    runId: input.runId,
    questionId: input.questionId,
    selected: selected.join(""),
    correct: Boolean(input.correct),
    elapsedMs: Math.max(0, Number(input.elapsedMs) || 0),
    createdAt: timestamp,
    deviceId,
    ...(sourceBankId ? { sourceBankId } : {}),
  };
  const answer: PracticeAnswerV6 = {
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
  const nextRun: PracticeRunV6 = {
    ...run,
    answers,
    updatedAt: timestamp,
    revision: run.revision + 1,
    lastAnsweredIndex: lastSubmittedIndex >= 0 ? lastSubmittedIndex : run.lastAnsweredIndex,
  };
  await dbV6.transaction("rw", [
    dbV6.attempts, dbV6.attemptStats, dbV6.attemptDailyStats, dbV6.practiceRuns,
    dbV6.practiceRunStats, dbV6.reviewRounds, dbV6.reviewRoundProgress,
    dbV6.questions, dbV6.bankQuestionMemberships, dbV6.changeSets,
  ], async () => {
    await dbV6.attempts.put(attempt);
    await dbV6.attemptStats.put(addAttemptToStatsV6(await dbV6.attemptStats.get(input.questionId), attempt));
    const key = dailyStatsKey(timestamp, input.questionId);
    await dbV6.attemptDailyStats.put(addDailyStatsV6(await dbV6.attemptDailyStats.get(key), attempt));
    await updatePracticeRunStatsInTx(run, nextRun);
    await dbV6.practiceRuns.put(nextRun);
    if (reviewRoundId) {
      await progressForAnswerInTx(reviewRoundId, input.questionId, attempt);
      await autoCompleteRoundIfReadyInTx(reviewRoundId);
    }
    const completedRound = reviewRoundId ? await dbV6.reviewRounds.get(reviewRoundId) : undefined;
    await enqueueChangeSetV7([
      { kind: "practice.answer.submitted", attempt, answer, runId: input.runId, questionId: input.questionId, ...(reviewRoundId ? { reviewRoundId } : {}) },
      ...(completedRound?.status === "completed" ? [{ kind: "review.round.completed" as const, round: completedRound }] : []),
    ], timestamp);
  });
  return { attempt, answer };
}

/**
 * Replace every v6 projection atomically.  The `events` store stays dormant
 * (Phase 3) and pending change-sets are deliberately left in place: callers
 * clear `changeSets` separately when a remote tail is being replayed.
 */
export async function restoreV6Checkpoint(state: V6RestoreState): Promise<void> {
  const cachedAssets = await dbV6.imageAssets.toArray();
  const cachedBlobs = new Map(cachedAssets.filter((asset) => asset.blob).map((asset) => [asset.id, asset]));
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  const tables = [
    dbV6.banks, dbV6.bankFolders, dbV6.questions, dbV6.bankQuestionMemberships, dbV6.imageAssets,
    dbV6.attempts, dbV6.attemptStats, dbV6.attemptDailyStats, dbV6.notes, dbV6.practiceRuns,
    dbV6.practiceRunStats, dbV6.questionGroups, dbV6.reviewRounds, dbV6.reviewRoundProgress,
    dbV6.tombstones,
  ];
  await dbV6.transaction("rw", tables, async () => {
    for (const table of tables) await table.clear();
    await dbV6.banks.bulkPut(state.banks);
    await dbV6.bankFolders.bulkPut(state.bankFolders);
    await dbV6.questions.bulkPut(state.questions);
    await dbV6.bankQuestionMemberships.bulkPut(memberships);
    await dbV6.imageAssets.bulkPut(state.imageAssets.map((descriptor) => {
      const cached = cachedBlobs.get(descriptor.id);
      return cached?.blob && cached.size === descriptor.size ? { ...descriptor, blob: cached.blob } : descriptor;
    }));
    await dbV6.attempts.bulkPut(state.attempts);
    await dbV6.attemptStats.bulkPut(state.attemptStats);
    await dbV6.attemptDailyStats.bulkPut(state.attemptDailyStats);
    await dbV6.notes.bulkPut(state.notes);
    await dbV6.practiceRuns.bulkPut(state.practiceRuns);
    await dbV6.practiceRunStats.bulkPut(state.practiceRunStats);
    await dbV6.questionGroups.bulkPut(state.questionGroups);
    await dbV6.reviewRounds.bulkPut(state.reviewRounds);
    await dbV6.reviewRoundProgress.bulkPut(state.reviewRoundProgress);
    await dbV6.tombstones.bulkPut(state.tombstones);
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
export async function putImageAssetV6(asset: ImageAsset): Promise<ImageAsset> {
  assertImageAssetShape(asset);
  if (asset.blob) {
    const digest = await sha256Blob(asset.blob);
    if (digest !== asset.id) throw new TypeError("图片 blob 内容与 id 不一致");
  }
  const previous = await dbV6.imageAssets.get(asset.id);
  const descriptorChanged = JSON.stringify({ ...previous, blob: undefined }) !== JSON.stringify({ ...asset, blob: undefined });
  await dbV6.transaction("rw", [dbV6.imageAssets, dbV6.changeSets], async () => {
    await dbV6.imageAssets.put(asset);
    if (asset.remote && descriptorChanged) {
      const createdAt = nowIso();
      const descriptor = { ...asset, blob: undefined };
      await enqueueChangeSetV7([{ kind: "image.asset.save", asset: descriptor }], createdAt);
    }
  });
  return asset;
}

export async function putImageAssetDescriptorV6(asset: Omit<ImageAsset, "blob">): Promise<ImageAsset> {
  return putImageAssetV6(asset);
}

export async function putImageAssetBlobV6(id: string, blob: Blob): Promise<ImageAsset> {
  const descriptor = await dbV6.imageAssets.get(id);
  if (!descriptor) throw new Error("图片 descriptor 不存在。");
  if (await sha256Blob(blob) !== id || blob.size !== descriptor.size) throw new TypeError("图片 blob 内容与 descriptor 不一致");
  const stored = { ...descriptor, blob };
  await dbV6.imageAssets.put(stored);
  return stored;
}

export async function getImageAssetV6(id: string): Promise<ImageAsset | undefined> {
  return dbV6.imageAssets.get(id);
}

export async function getImageAssetDescriptorV6(id: string): Promise<Omit<ImageAsset, "blob"> | undefined> {
  const asset = await dbV6.imageAssets.get(id);
  if (!asset) return undefined;
  const descriptor = { ...asset };
  delete descriptor.blob;
  return descriptor;
}

export async function getImageAssetBlobV6(id: string): Promise<Blob | undefined> {
  return (await dbV6.imageAssets.get(id))?.blob;
}

export async function getImageCacheSizeV6(): Promise<number> {
  const assets = await dbV6.imageAssets.toArray();
  return assets.reduce((total, asset) => total + (asset.blob?.size ?? 0), 0);
}

export async function clearImageCacheV6(): Promise<number> {
  const assets = await dbV6.imageAssets.toArray();
  let cleared = 0;
  await dbV6.transaction("rw", dbV6.imageAssets, async () => {
    for (const asset of assets) {
      if (!asset.blob) continue;
      await dbV6.imageAssets.put({ ...asset, blob: undefined });
      cleared += 1;
    }
  });
  return cleared;
}

export const putImageAssetDescriptor = putImageAssetDescriptorV6;
export const putImageAssetBlob = putImageAssetBlobV6;
export const getImageAssetDescriptor = getImageAssetDescriptorV6;
export const getImageAssetBlob = getImageAssetBlobV6;
export const getImageCacheSize = getImageCacheSizeV6;
export const clearImageCache = clearImageCacheV6;
