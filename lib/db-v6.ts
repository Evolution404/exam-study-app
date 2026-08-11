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
import { sha256Blob } from "./image-assets";
import {
  normalizeContentText,
  plainTextToContentBlocks,
  questionContentFingerprint,
} from "./question-content";
import { normalizeCalculationAnswer } from "./question-utils";
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
  V6Event,
  V6EventType,
} from "./v6-types";

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
  /** Optional event history embedded by migration-produced checkpoints. */
  events?: V6Event[];
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

function eventInTx(type: V6EventType, payload: unknown, createdAt = nowIso(), synced: 0 | 1 = 0): V6Event {
  const deviceId = getV6DeviceId();
  return { id: makeV6Id("event"), type, payload, deviceId, sequence: nextV6Sequence(deviceId), createdAt, synced };
}

function eventWithId(type: V6EventType, payload: unknown, eventId: string, createdAt: string, deviceId: string, synced: 0 | 1): V6Event {
  return { id: eventId, type, payload, deviceId, sequence: nextV6Sequence(deviceId), createdAt, synced };
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

async function latestImageAssetSavedEventInTx(assetId: string): Promise<V6Event | undefined> {
  const events = await dbV6.events.where("type").equals("image.asset.saved").filter((event) => (
    (event.payload as { id?: string }).id === assetId
  )).toArray();
  events.sort((left, right) => compareClock(right, left));
  return events[0];
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
  events!: EntityTable<V6Event, "id">;
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
  await dbV6.transaction("rw", [dbV6.banks, dbV6.events], async () => {
    await dbV6.banks.put(bank);
    await dbV6.events.put(eventInTx("bank.created", bank, timestamp));
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
  await dbV6.transaction("rw", [dbV6.banks, dbV6.events], async () => {
    await dbV6.banks.put(updated);
    await dbV6.events.put(eventInTx("bank.updated", updated, updated.updatedAt));
  });
  return updated;
}

export async function reorderBanksV6(bankIds: readonly string[], folderId?: string): Promise<BankV6[]> {
  const banks = (await dbV6.banks.bulkGet(uniqueStrings(bankIds))).filter(Boolean) as BankV6[];
  if (!banks.length) return [];
  const updatedAt = nowIso();
  const deviceId = getV6DeviceId();
  const rows = banks.map((bank, sortOrder) => ({ ...bank, folderId, sortOrder, updatedAt, deviceId }));
  await dbV6.transaction("rw", [dbV6.banks, dbV6.events], async () => {
    await dbV6.banks.bulkPut(rows);
    await dbV6.events.bulkPut(rows.map((bank) => eventInTx("bank.updated", bank, updatedAt)));
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
  await dbV6.transaction("rw", [dbV6.bankFolders, dbV6.tombstones, dbV6.events], async () => {
    await dbV6.bankFolders.put(folder);
    await dbV6.tombstones.delete(tombstoneKey("bankFolder", folder.id));
    await dbV6.events.put(eventInTx("bankFolder.saved", folder, updatedAt));
  });
  return folder;
}

export async function deleteBankFolderV6(folderId: string): Promise<boolean> {
  const current = await dbV6.bankFolders.get(folderId);
  if (!current) return false;
  const updatedAt = nowIso();
  const deviceId = getV6DeviceId();
  const event = eventWithId("bankFolder.deleted", { id: folderId, deletedAt: updatedAt }, makeV6Id("folder-delete"), updatedAt, deviceId, 0);
  const banks = await dbV6.banks.where("folderId").equals(folderId).toArray();
  await dbV6.transaction("rw", [dbV6.bankFolders, dbV6.banks, dbV6.tombstones, dbV6.events], async () => {
    await dbV6.bankFolders.delete(folderId);
    const detached = banks.map((bank) => ({ ...bank, folderId: undefined, updatedAt, deviceId }));
    await dbV6.banks.bulkPut(detached);
    await dbV6.events.bulkPut(detached.map((bank) => eventInTx("bank.updated", bank, updatedAt)));
    await dbV6.tombstones.put({ key: tombstoneKey("bankFolder", folderId), entityType: "bankFolder", entityId: folderId, deletedAt: updatedAt, deviceId, eventId: event.id });
    await dbV6.events.put(event);
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

async function saveMembershipInTx(membership: BankQuestionMembership, emit = true): Promise<void> {
  const normalized = normalizeMembership(membership);
  const tombstone = await dbV6.tombstones.get(tombstoneKey("membership", normalized.key));
  if (tombstone && compareClock(normalized, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) return;
  if (tombstone) await dbV6.tombstones.delete(tombstone.key);
  await dbV6.bankQuestionMemberships.put(normalized);
  if (emit) await dbV6.events.put(eventInTx("membership.saved", normalized, normalized.updatedAt));
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
  await dbV6.transaction("rw", [dbV6.questions, dbV6.bankQuestionMemberships, dbV6.banks, dbV6.tombstones, dbV6.events], async () => {
    if (!existing) await dbV6.questions.put(question);
    const currentMembership = await dbV6.bankQuestionMemberships.get(membership.key);
    await saveMembershipInTx(currentMembership ? { ...currentMembership, updatedAt: timestamp, deviceId } : membership, true);
    await refreshBankQuestionCountInTx(bankId);
    if (!existing) await dbV6.events.put(eventInTx("question.upserted", question, timestamp));
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
  await dbV6.transaction("rw", [dbV6.questions, dbV6.events], async () => {
    await dbV6.questions.put(updated);
    await dbV6.events.put(eventInTx("question.upserted", updated, timestamp));
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
  await dbV6.transaction("rw", [
    dbV6.questions, dbV6.bankQuestionMemberships, dbV6.notes, dbV6.banks,
    dbV6.tombstones, dbV6.events,
  ], async () => {
    await dbV6.questions.put(clone);
    for (const membership of selected) {
      await dbV6.bankQuestionMemberships.delete(membership.key);
      await dbV6.tombstones.put({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId: makeV6Id("membership-split"),
      });
    }
    await dbV6.bankQuestionMemberships.bulkPut(movedMemberships);
    if (clonedNote) await dbV6.notes.put(clonedNote);
    await dbV6.events.put(eventInTx("question.split", {
      originalQuestionId: original.id,
      clone,
      memberships: movedMemberships,
      deletedMembershipKeys: selected.map((membership) => membership.key),
      note: clonedNote,
    }, timestamp));
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
  await dbV6.transaction("rw", [dbV6.bankQuestionMemberships, dbV6.banks, dbV6.tombstones, dbV6.events], async () => {
    await dbV6.bankQuestionMemberships.delete(key);
    await dbV6.tombstones.put({
      key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
      deletedAt: timestamp, deviceId, eventId: makeV6Id("membership-delete"),
    });
    await dbV6.events.put(eventInTx("membership.removed", current, timestamp));
    await refreshBankQuestionCountInTx(bankId);
  });
  return true;
}

export async function deleteQuestionV6(questionId: string): Promise<boolean> {
  const current = await dbV6.questions.get(questionId);
  if (!current) return false;
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const eventId = makeV6Id("question-delete");
  const memberships = await dbV6.bankQuestionMemberships.where("questionId").equals(questionId).toArray();
  await dbV6.transaction("rw", [
    dbV6.questions, dbV6.bankQuestionMemberships, dbV6.attempts, dbV6.attemptStats,
    dbV6.attemptDailyStats, dbV6.notes, dbV6.questionGroups, dbV6.reviewRoundProgress,
    dbV6.practiceRuns, dbV6.banks, dbV6.events, dbV6.tombstones,
  ], async () => {
    await dbV6.questions.delete(questionId);
    await dbV6.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    for (const membership of memberships) {
      await dbV6.tombstones.put({
        key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
        deletedAt: timestamp, deviceId, eventId,
      });
    }
    await dbV6.attempts.where("questionId").equals(questionId).delete();
    await dbV6.attemptStats.delete(questionId);
    await dbV6.attemptDailyStats.where("questionId").equals(questionId).delete();
    await dbV6.reviewRoundProgress.where("questionId").equals(questionId).delete();
    await dbV6.notes.delete(questionId);
    const groups = await dbV6.questionGroups.toArray();
    for (const group of groups) {
      const items = group.items.filter((item) => item.questionId !== questionId);
      if (items.length !== group.items.length) {
        if (items.length) await dbV6.questionGroups.put({ ...group, items, updatedAt: timestamp });
        else await dbV6.questionGroups.delete(group.id);
      }
    }
    const runs = await dbV6.practiceRuns.toArray();
    for (const run of runs) {
      if (!run.questionIds.includes(questionId)) continue;
      const answers = { ...run.answers };
      delete answers[questionId];
      const questionTypes = { ...run.questionTypes };
      delete questionTypes[questionId];
      await dbV6.practiceRuns.put({ ...run, questionIds: run.questionIds.filter((id) => id !== questionId), answers, questionTypes, updatedAt: timestamp });
    }
    for (const membership of memberships) await refreshBankQuestionCountInTx(membership.bankId);
    const tombstone: TombstoneV6 = {
      key: tombstoneKey("question", questionId),
      entityType: "question",
      entityId: questionId,
      deletedAt: timestamp,
      deviceId,
      eventId,
    };
    await dbV6.tombstones.put(tombstone);
    await dbV6.events.put(eventInTx("question.deleted", { id: questionId, deletedAt: timestamp }, timestamp));
  });
  return true;
}

export const deleteQuestionGlobalV6 = deleteQuestionV6;

/** Delete only the bank and its joins; content and all learning history stay. */
export async function deleteBankV6(bankId: string): Promise<boolean> {
  const bank = await dbV6.banks.get(bankId);
  if (!bank) return false;
  const timestamp = nowIso();
  const deviceId = getV6DeviceId();
  const memberships = await dbV6.bankQuestionMemberships.where("bankId").equals(bankId).toArray();
  await dbV6.transaction("rw", [dbV6.banks, dbV6.bankQuestionMemberships, dbV6.events, dbV6.tombstones], async () => {
    await dbV6.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
    await dbV6.banks.delete(bankId);
    await dbV6.tombstones.put({ key: tombstoneKey("bank", bankId), entityType: "bank", entityId: bankId, deletedAt: timestamp, deviceId, eventId: makeV6Id("bank-delete") });
    await dbV6.events.put(eventInTx("bank.deleted", { id: bankId, deletedAt: timestamp }, timestamp));
  });
  return true;
}

export const deleteBankOnlyV6 = deleteBankV6;

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

function importDraft(row: ImportedQuestionRowV6): QuestionDraftV6 | undefined {
  if (!row || typeof row !== "object") return undefined;
  const record = row as unknown as Record<string, unknown>;
  const stem = normalizeContentText(rowString(record, "stem", "question", "q", "题干"));
  if (!stem) return undefined;
  const rawOptions = rowOptions(record);
  const options = Array.isArray(rawOptions) ? rawOptions.map((item) => String(item ?? "").trim()) : [];
  const rawType = rowString(record, "type", "questionType", "题型").trim();
  const rawAnswer = record.answer ?? record.ans ?? record.correctAnswer ?? record["答案"] ?? "";
  const answer = Array.isArray(rawAnswer) ? rawAnswer.map(String).join("") : String(rawAnswer);
  const type: QuestionTypeV6 = rawType === "判断" || rawType === "单选" || rawType === "多选" || rawType === "计算"
    ? rawType
    : options.length === 2 && options[0] === "正确" && options[1] === "错误"
      ? "判断"
      : answer.replace(/[^A-Z]/gi, "").length > 1 ? "多选" : "单选";
  if (!answer.trim() || (type !== "计算" && options.length < 2)) return undefined;
  const rawTags = record.tags ?? record["标签"];
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags ?? "").split(/[，,、\n]+/);
  return { type, stem, options, answer, tags: uniqueStrings(tags) };
}

/**
 * Import a plain JSON question list.  The bank id is deterministic for a
 * filename/name, while question identity is content-addressed globally.  A
 * large import still emits bounded per-question events rather than one huge
 * `bank.imported` payload.
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
  }
  await dbV6.transaction("rw", [dbV6.banks, dbV6.questions, dbV6.bankQuestionMemberships, dbV6.tombstones, dbV6.events], async () => {
    await dbV6.banks.put(bank);
    for (const item of materialised) {
      // Existing content is user-owned and already semantically identical;
      // preserving it avoids a second device overwriting tags/favourites.
      if (!(await dbV6.questions.get(item.question.id))) await dbV6.questions.put(item.question);
      await saveMembershipInTx(item.membership, false);
      await dbV6.events.put(eventInTx("question.upserted", item.question, timestamp));
      await dbV6.events.put(eventInTx("membership.saved", item.membership, timestamp));
    }
    const refreshed = await refreshBankQuestionCountInTx(bank.id);
    if (refreshed) await dbV6.banks.put({ ...refreshed, updatedAt: timestamp, deviceId });
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
  await dbV6.transaction("rw", [dbV6.notes, dbV6.events], async () => {
    await dbV6.notes.put(note);
    await dbV6.events.put(eventInTx("note.upserted", note, timestamp));
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
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.events], async () => {
    await dbV6.practiceRuns.put(run);
    await updatePracticeRunStatsInTx(undefined, run);
    await dbV6.events.put(eventInTx("practice.run.saved", run, timestamp));
  });
  return run;
}

export async function savePracticeRunV6(run: PracticeRunV6): Promise<PracticeRunV6> {
  const current = await dbV6.practiceRuns.get(run.id);
  const updated = { ...run, updatedAt: run.updatedAt || nowIso() };
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.events], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV6.practiceRuns.put(updated);
    await dbV6.events.put(eventInTx("practice.run.saved", updated, updated.updatedAt));
  });
  return updated;
}

/**
 * Persist navigation and unsubmitted UI progress without creating a domain
 * event. Submitted answers and status changes have their own single events;
 * emitting a run snapshot here would reintroduce the historical two-events-
 * per-answer bug and can exceed the event-page limit for large runs.
 */
export async function savePracticeProgressV6(run: PracticeRunV6): Promise<PracticeRunV6> {
  const current = await dbV6.practiceRuns.get(run.id);
  const updated = { ...run, updatedAt: run.updatedAt || nowIso() };
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV6.practiceRuns.put(updated);
  });
  return updated;
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
  await dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.events], async () => {
    await dbV6.reviewRounds.put(round);
    await dbV6.events.put(eventInTx("review.round.saved", round, timestamp));
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
  await dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.events], async () => {
    await dbV6.reviewRounds.put(updated);
    await dbV6.events.put(eventInTx("review.round.saved", updated, updated.updatedAt));
  });
  return updated;
}

async function completeRoundInTx(round: ReviewRound, finalQuestionIds: string[], emit: boolean): Promise<ReviewRound> {
  const timestamp = nowIso();
  const completed: ReviewRound = { ...round, status: "completed", completedAt: timestamp, finalQuestionIds: uniqueStrings(finalQuestionIds), updatedAt: timestamp, deviceId: getV6DeviceId() };
  await dbV6.reviewRounds.put(completed);
  if (emit) await dbV6.events.put(eventInTx("review.round.completed", completed, timestamp));
  return completed;
}

export async function completeReviewRoundV6(roundId: string, finalQuestionIds?: readonly string[]): Promise<ReviewRound> {
  const current = await dbV6.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "completed" || current.status === "archived") return current;
  const targets = finalQuestionIds ? uniqueStrings(finalQuestionIds) : await getReviewRoundQuestionIdsV6(roundId);
  return dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.events], () => completeRoundInTx(current, targets, true));
}

export async function archiveReviewRoundV6(roundId: string): Promise<ReviewRound> {
  const current = await dbV6.reviewRounds.get(roundId);
  if (!current) throw new Error("复习轮次不存在或已被删除。");
  if (current.status === "archived") return current;
  const updated: ReviewRound = { ...current, status: "archived", updatedAt: nowIso(), deviceId: getV6DeviceId() };
  await dbV6.transaction("rw", [dbV6.reviewRounds, dbV6.events], async () => {
    await dbV6.reviewRounds.put(updated);
    await dbV6.events.put(eventInTx("review.round.archived", updated, updated.updatedAt));
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
  await dbV6.transaction("rw", [dbV6.questionGroups, dbV6.tombstones, dbV6.events], async () => {
    await dbV6.questionGroups.put(group);
    await dbV6.tombstones.delete(tombstoneKey("questionGroup", group.id));
    await dbV6.events.put(eventInTx("questionGroup.saved", group, updatedAt));
  });
  return group;
}

export async function deleteQuestionGroupV6(groupId: string): Promise<boolean> {
  const current = await dbV6.questionGroups.get(groupId);
  if (!current) return false;
  const deletedAt = nowIso();
  const deviceId = getV6DeviceId();
  const event = eventWithId("questionGroup.deleted", { id: groupId, deletedAt }, makeV6Id("group-delete"), deletedAt, deviceId, 0);
  await dbV6.transaction("rw", [dbV6.questionGroups, dbV6.tombstones, dbV6.events], async () => {
    await dbV6.questionGroups.delete(groupId);
    await dbV6.tombstones.put({ key: tombstoneKey("questionGroup", groupId), entityType: "questionGroup", entityId: groupId, deletedAt, deviceId, eventId: event.id });
    await dbV6.events.put(event);
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
  await dbV6.transaction("rw", [dbV6.practiceRuns, dbV6.practiceRunStats, dbV6.events], async () => {
    await updatePracticeRunStatsInTx(current, updated);
    await dbV6.practiceRuns.put(updated);
    await dbV6.events.put(eventInTx("practice.run.status.changed", updated, updatedAt));
  });
  return updated;
}

export async function toggleQuestionFavoriteV6(questionId: string): Promise<QuestionV6> {
  const current = await dbV6.questions.get(questionId);
  if (!current) throw new Error("题目不存在或已被删除。");
  return updateQuestionV6(questionId, { favorite: !current.favorite });
}

async function autoCompleteRoundIfReadyInTx(roundId: string, emitCompletionEvent: boolean): Promise<void> {
  const round = await dbV6.reviewRounds.get(roundId);
  if (!round || round.status !== "active") return;
  const targets = await getReviewRoundQuestionIdsV6(roundId);
  if (!targets.length) return;
  const progress = await dbV6.reviewRoundProgress.where("roundId").equals(roundId).toArray();
  const done = new Set(progress.map((item) => item.questionId));
  if (targets.every((questionId) => done.has(questionId))) await completeRoundInTx(round, targets, emitCompletionEvent);
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

async function applyAnswerPayloadInTx(payload: PracticeAnswerSubmittedV6Payload, event: V6Event, emitEvent: boolean): Promise<void> {
  const { attempt, answer } = payload;
  const existingAttempt = await dbV6.attempts.get(attempt.id);
  if (!existingAttempt) {
    await dbV6.attempts.put(attempt);
    await dbV6.attemptStats.put(addAttemptToStatsV6(await dbV6.attemptStats.get(attempt.questionId), attempt));
    const dailyKey = dailyStatsKey(attempt.createdAt, attempt.questionId);
    await dbV6.attemptDailyStats.put(addDailyStatsV6(await dbV6.attemptDailyStats.get(dailyKey), attempt));
  }
  const run = await dbV6.practiceRuns.get(payload.runId);
  const baseRun = run;
  if (baseRun) {
    const updatedRun: PracticeRunV6 = {
      ...baseRun,
      answers: { ...baseRun.answers, [payload.questionId]: answer },
      updatedAt: answer.updatedAt,
      revision: Math.max(baseRun.revision + 1, (run?.revision ?? 0) + 1),
      lastAnsweredIndex: baseRun.questionIds.indexOf(payload.questionId),
    };
    await updatePracticeRunStatsInTx(run, updatedRun);
    await dbV6.practiceRuns.put(updatedRun);
  }
  if (payload.reviewRoundId) {
    const round = await dbV6.reviewRounds.get(payload.reviewRoundId);
    if (round?.status === "active") {
      const targets = await getReviewRoundQuestionIdsV6(round.id);
      if (targets.includes(payload.questionId)) {
        await progressForAnswerInTx(round.id, payload.questionId, attempt);
        await autoCompleteRoundIfReadyInTx(round.id, false);
      }
    }
  }
  if (emitEvent) await dbV6.events.put(event);
}

/**
 * Submit one answer.  All local projections and the optional round progress
 * are committed in one transaction and exactly one domain event is emitted.
 */
export async function recordPracticeAnswerV6(input: PracticeAnswerInputV6): Promise<{ attempt: AttemptV6; answer: PracticeAnswerV6; event: V6Event }> {
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
  const nextRun: PracticeRunV6 = {
    ...run,
    answers: { ...run.answers, [input.questionId]: answer },
    updatedAt: timestamp,
    revision: run.revision + 1,
    lastAnsweredIndex: run.questionIds.indexOf(input.questionId),
  };
  const event = eventWithId("practice.answer.submitted", {
    attempt,
    answer,
    runId: input.runId,
    questionId: input.questionId,
    ...(reviewRoundId ? { reviewRoundId } : {}),
  } satisfies PracticeAnswerSubmittedV6Payload, eventId, timestamp, deviceId, 0);
  await dbV6.transaction("rw", [
    dbV6.attempts, dbV6.attemptStats, dbV6.attemptDailyStats, dbV6.practiceRuns,
    dbV6.practiceRunStats, dbV6.reviewRounds, dbV6.reviewRoundProgress,
    dbV6.questions, dbV6.bankQuestionMemberships, dbV6.events,
  ], async () => {
    await dbV6.attempts.put(attempt);
    await dbV6.attemptStats.put(addAttemptToStatsV6(await dbV6.attemptStats.get(input.questionId), attempt));
    const key = dailyStatsKey(timestamp, input.questionId);
    await dbV6.attemptDailyStats.put(addDailyStatsV6(await dbV6.attemptDailyStats.get(key), attempt));
    await updatePracticeRunStatsInTx(run, nextRun);
    await dbV6.practiceRuns.put(nextRun);
    if (reviewRoundId) {
      await progressForAnswerInTx(reviewRoundId, input.questionId, attempt);
      await autoCompleteRoundIfReadyInTx(reviewRoundId, true);
    }
    await dbV6.events.put(event);
  });
  return { attempt, answer, event };
}

/** Apply one remote event exactly once.  Existing event ids are no-ops. */
export async function applyV6Event(input: V6Event): Promise<boolean> {
  if (await dbV6.events.get(input.id)) return false;
  const event: V6Event = { ...input, synced: 1 };
  await dbV6.transaction("rw", [
    dbV6.banks, dbV6.bankFolders, dbV6.bankQuestionMemberships, dbV6.questions, dbV6.attempts,
    dbV6.attemptStats, dbV6.attemptDailyStats, dbV6.practiceRuns, dbV6.practiceRunStats,
    dbV6.notes, dbV6.reviewRounds, dbV6.reviewRoundProgress, dbV6.events,
    dbV6.questionGroups, dbV6.imageAssets, dbV6.tombstones,
  ], async () => {
    switch (event.type) {
      case "bank.created":
      case "bank.updated": {
        const bank = event.payload as BankV6;
        const tombstone = await dbV6.tombstones.get(tombstoneKey("bank", bank.id));
        if (tombstone && compareClock(bank, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        if (tombstone) await dbV6.tombstones.delete(tombstone.key);
        const current = await dbV6.banks.get(bank.id);
        if (!current || compareClock(bank, current) >= 0) await dbV6.banks.put(bank);
        break;
      }
      case "bank.deleted": {
        const payload = event.payload as { id: string; deletedAt?: string };
        const deletedAt = payload.deletedAt ?? event.createdAt;
        const deletedClock = { updatedAt: deletedAt, deviceId: event.deviceId, id: event.id };
        const tombstone = await dbV6.tombstones.get(tombstoneKey("bank", payload.id));
        if (tombstone && compareClock(deletedClock, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        const current = await dbV6.banks.get(payload.id);
        if (current && compareClock(deletedClock, current) < 0) break;
        await dbV6.bankQuestionMemberships.where("bankId").equals(payload.id).delete();
        await dbV6.banks.delete(payload.id);
        await dbV6.tombstones.put({ key: tombstoneKey("bank", payload.id), entityType: "bank", entityId: payload.id, deletedAt, deviceId: event.deviceId, eventId: event.id });
        break;
      }
      case "question.upserted": {
        const question = event.payload as QuestionV6;
        const tombstone = await dbV6.tombstones.get(tombstoneKey("question", question.id));
        if (tombstone && compareClock(question, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        if (tombstone) await dbV6.tombstones.delete(tombstone.key);
        const current = await dbV6.questions.get(question.id);
        if (!current || compareClock(question, current) >= 0) await dbV6.questions.put(question);
        break;
      }
      case "question.split": {
        const payload = event.payload as {
          originalQuestionId: string;
          clone: QuestionV6;
          memberships: BankQuestionMembership[];
          deletedMembershipKeys: string[];
          note?: NoteV6;
        };
        await dbV6.questions.put(payload.clone);
        for (const key of payload.deletedMembershipKeys) {
          await dbV6.bankQuestionMemberships.delete(key);
          await dbV6.tombstones.put({
            key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
            deletedAt: event.createdAt, deviceId: event.deviceId, eventId: event.id,
          });
        }
        for (const membership of payload.memberships) await saveMembershipInTx(membership, false);
        if (payload.note) await dbV6.notes.put(payload.note);
        for (const membership of payload.memberships) await refreshBankQuestionCountInTx(membership.bankId);
        break;
      }
      case "question.deleted": {
        const payload = event.payload as { id: string; deletedAt?: string };
        const deletedAt = payload.deletedAt ?? event.createdAt;
        const deletedClock = { updatedAt: deletedAt, deviceId: event.deviceId, id: event.id };
        const existingTombstone = await dbV6.tombstones.get(tombstoneKey("question", payload.id));
        if (existingTombstone && compareClock(deletedClock, { updatedAt: existingTombstone.deletedAt, deviceId: existingTombstone.deviceId, id: existingTombstone.eventId }) <= 0) break;
        const currentQuestion = await dbV6.questions.get(payload.id);
        if (currentQuestion && compareClock(deletedClock, currentQuestion) < 0) break;
        await dbV6.questions.delete(payload.id);
        const memberships = await dbV6.bankQuestionMemberships.where("questionId").equals(payload.id).toArray();
        await dbV6.bankQuestionMemberships.bulkDelete(memberships.map((membership) => membership.key));
        for (const membership of memberships) {
          await dbV6.tombstones.put({
            key: tombstoneKey("membership", membership.key), entityType: "membership", entityId: membership.key,
            deletedAt, deviceId: event.deviceId, eventId: event.id,
          });
        }
        await dbV6.attempts.where("questionId").equals(payload.id).delete();
        await dbV6.attemptStats.delete(payload.id);
        await dbV6.attemptDailyStats.where("questionId").equals(payload.id).delete();
        await dbV6.reviewRoundProgress.where("questionId").equals(payload.id).delete();
        await dbV6.notes.delete(payload.id);
        const groups = await dbV6.questionGroups.toArray();
        for (const group of groups) {
          const items = group.items.filter((item) => item.questionId !== payload.id);
          if (items.length === group.items.length) continue;
          if (items.length) await dbV6.questionGroups.put({ ...group, items, updatedAt: deletedAt });
          else await dbV6.questionGroups.delete(group.id);
        }
        const runs = await dbV6.practiceRuns.toArray();
        for (const run of runs) {
          if (!run.questionIds.includes(payload.id)) continue;
          const answers = { ...run.answers };
          delete answers[payload.id];
          const questionTypes = { ...run.questionTypes };
          delete questionTypes[payload.id];
          const updatedRun = {
            ...run,
            questionIds: run.questionIds.filter((questionId) => questionId !== payload.id),
            answers,
            questionTypes,
            updatedAt: deletedAt,
          };
          await updatePracticeRunStatsInTx(run, updatedRun);
          await dbV6.practiceRuns.put(updatedRun);
        }
        await dbV6.tombstones.put({ key: tombstoneKey("question", payload.id), entityType: "question", entityId: payload.id, deletedAt, deviceId: event.deviceId, eventId: event.id });
        break;
      }
      case "membership.saved": {
        const membership = normalizeMembership(event.payload as BankQuestionMembership);
        if (!await dbV6.banks.get(membership.bankId) || !await dbV6.questions.get(membership.questionId)) break;
        const tombstone = await dbV6.tombstones.get(tombstoneKey("membership", membership.key));
        if (tombstone && compareClock(membership, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        if (tombstone) await dbV6.tombstones.delete(tombstone.key);
        const current = await dbV6.bankQuestionMemberships.get(membership.key);
        if (!current || compareClock(membership, current) >= 0) await dbV6.bankQuestionMemberships.put(membership);
        await refreshBankQuestionCountInTx(membership.bankId);
        break;
      }
      case "membership.removed": {
        const membership = event.payload as BankQuestionMembership;
        const key = membership.key || membershipKey(membership.bankId, membership.questionId);
        const current = await dbV6.bankQuestionMemberships.get(key);
        const existingTombstone = await dbV6.tombstones.get(tombstoneKey("membership", key));
        const removalClock = { updatedAt: event.createdAt, deviceId: event.deviceId, id: event.id };
        if (existingTombstone && compareClock(removalClock, { updatedAt: existingTombstone.deletedAt, deviceId: existingTombstone.deviceId, id: existingTombstone.eventId }) <= 0) break;
        if (current && compareClock(removalClock, current) < 0) break;
        await dbV6.bankQuestionMemberships.delete(key);
        await dbV6.tombstones.put({
          key: tombstoneKey("membership", key), entityType: "membership", entityId: key,
          deletedAt: event.createdAt, deviceId: event.deviceId, eventId: event.id,
        });
        await refreshBankQuestionCountInTx(membership.bankId);
        break;
      }
      case "practice.answer.submitted":
        await applyAnswerPayloadInTx(event.payload as PracticeAnswerSubmittedV6Payload, event, false);
        break;
      case "practice.run.saved": {
        const run = event.payload as PracticeRunV6;
        const current = await dbV6.practiceRuns.get(run.id);
        if (!current || compareClock(run, current) >= 0) {
          await updatePracticeRunStatsInTx(current, run);
          await dbV6.practiceRuns.put(run);
        }
        break;
      }
      case "practice.run.status.changed": {
        const run = event.payload as PracticeRunV6;
        const current = await dbV6.practiceRuns.get(run.id);
        if (!current || compareClock(run, current) >= 0) {
          await updatePracticeRunStatsInTx(current, run);
          await dbV6.practiceRuns.put(run);
        }
        break;
      }
      case "note.upserted": {
        const note = event.payload as NoteV6;
        const current = await dbV6.notes.get(note.questionId);
        if (!current || compareClock(note, current) >= 0) await dbV6.notes.put(note);
        break;
      }
      case "review.round.saved": {
        const round = event.payload as ReviewRound;
        const current = await dbV6.reviewRounds.get(round.id);
        if (!current || compareClock(round, current) >= 0) await dbV6.reviewRounds.put(round);
        break;
      }
      case "review.round.completed":
      case "review.round.archived": {
        const round = event.payload as ReviewRound;
        const current = await dbV6.reviewRounds.get(round.id);
        if (!current || compareClock(round, current) >= 0) await dbV6.reviewRounds.put(round);
        break;
      }
      case "bankFolder.saved": {
        const folder = event.payload as BankFolderV6;
        const tombstone = await dbV6.tombstones.get(tombstoneKey("bankFolder", folder.id));
        if (tombstone && compareClock(folder, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        if (tombstone) await dbV6.tombstones.delete(tombstone.key);
        const current = await dbV6.bankFolders.get(folder.id);
        if (!current || compareClock(folder, current) >= 0) await dbV6.bankFolders.put(folder);
        break;
      }
      case "bankFolder.deleted": {
        const payload = event.payload as { id: string; deletedAt?: string };
        const deletedAt = payload.deletedAt ?? event.createdAt;
        const deletedClock = { updatedAt: deletedAt, deviceId: event.deviceId, id: event.id };
        const tombstone = await dbV6.tombstones.get(tombstoneKey("bankFolder", payload.id));
        if (tombstone && compareClock(deletedClock, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        const current = await dbV6.bankFolders.get(payload.id);
        if (current && compareClock(deletedClock, current) < 0) break;
        await dbV6.bankFolders.delete(payload.id);
        await dbV6.tombstones.put({ key: tombstoneKey("bankFolder", payload.id), entityType: "bankFolder", entityId: payload.id, deletedAt, deviceId: event.deviceId, eventId: event.id });
        break;
      }
      case "questionGroup.saved": {
        const group = event.payload as QuestionGroupV6;
        const tombstone = await dbV6.tombstones.get(tombstoneKey("questionGroup", group.id));
        if (tombstone && compareClock(group, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        if (tombstone) await dbV6.tombstones.delete(tombstone.key);
        const current = await dbV6.questionGroups.get(group.id);
        if (!current || compareClock(group, current) >= 0) await dbV6.questionGroups.put(group);
        break;
      }
      case "questionGroup.deleted": {
        const payload = event.payload as { id: string; deletedAt?: string };
        const deletedAt = payload.deletedAt ?? event.createdAt;
        const deletedClock = { updatedAt: deletedAt, deviceId: event.deviceId, id: event.id };
        const tombstone = await dbV6.tombstones.get(tombstoneKey("questionGroup", payload.id));
        if (tombstone && compareClock(deletedClock, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        const current = await dbV6.questionGroups.get(payload.id);
        if (current && compareClock(deletedClock, current) < 0) break;
        await dbV6.questionGroups.delete(payload.id);
        await dbV6.tombstones.put({ key: tombstoneKey("questionGroup", payload.id), entityType: "questionGroup", entityId: payload.id, deletedAt, deviceId: event.deviceId, eventId: event.id });
        break;
      }
      case "image.asset.saved": {
        const descriptor = event.payload as ImageAsset;
        assertImageAssetShape(descriptor);
        const tombstone = await dbV6.tombstones.get(tombstoneKey("imageAsset", descriptor.id));
        if (tombstone && compareClock({ updatedAt: event.createdAt, deviceId: event.deviceId, id: event.id }, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        if (tombstone) await dbV6.tombstones.delete(tombstone.key);
        const current = await dbV6.imageAssets.get(descriptor.id);
        const latestSaved = await latestImageAssetSavedEventInTx(descriptor.id);
        if (!latestSaved || compareClock(event, latestSaved) >= 0) {
          const preservedBlob = current?.blob && current.blob.size === descriptor.size ? current.blob : undefined;
          await dbV6.imageAssets.put({ ...descriptor, ...(preservedBlob ? { blob: preservedBlob } : {}) });
        }
        break;
      }
      case "image.asset.deleted": {
        const payload = event.payload as { id: string; deletedAt?: string };
        const deletedAt = payload.deletedAt ?? event.createdAt;
        const deletedClock = { updatedAt: deletedAt, deviceId: event.deviceId, id: event.id };
        const tombstone = await dbV6.tombstones.get(tombstoneKey("imageAsset", payload.id));
        if (tombstone && compareClock(deletedClock, { updatedAt: tombstone.deletedAt, deviceId: tombstone.deviceId, id: tombstone.eventId }) <= 0) break;
        const current = await dbV6.imageAssets.get(payload.id);
        const latestSaved = await latestImageAssetSavedEventInTx(payload.id);
        if (current && latestSaved && compareClock(deletedClock, latestSaved) < 0) break;
        await dbV6.imageAssets.delete(payload.id);
        await dbV6.tombstones.put({ key: tombstoneKey("imageAsset", payload.id), entityType: "imageAsset", entityId: payload.id, deletedAt, deviceId: event.deviceId, eventId: event.id });
        break;
      }
      case "attempt.created":
        // v6 attempts are emitted only as part of practice.answer.submitted;
        // standalone legacy-style attempt events are intentionally ignored.
        break;
      default:
        break;
    }
    await dbV6.events.put(event);
  });
  return true;
}

export const reduceV6Event = applyV6Event;
export const applyRemoteV6Event = applyV6Event;

/**
 * Replace every v6 projection and replay remote events atomically.
 *
 * The helper intentionally leaves `syncFiles` and `syncMeta` untouched: those
 * tables are the v6 remote cache and are committed by the sync orchestrator
 * only after this transaction succeeds.  Local pending events can optionally
 * be projected back over the checkpoint while retaining their `synced: 0`
 * marker, which is what pull/sync use to avoid losing offline edits.
 */
export async function restoreV6CheckpointAndEvents(
  state: V6RestoreState,
  remoteEvents: readonly V6Event[] = [],
  options: { preservePending?: boolean } = {},
): Promise<{ applied: number; preserved: number }> {
  const pending = options.preservePending ? await dbV6.events.where("synced").equals(0).toArray() : [];
  const remoteIds = new Set(remoteEvents.map((event) => event.id));
  const cachedAssets = await dbV6.imageAssets.toArray();
  const cachedBlobs = new Map(cachedAssets.filter((asset) => asset.blob).map((asset) => [asset.id, asset]));
  const memberships = state.memberships ?? state.bankQuestionMemberships ?? [];
  const tables = [
    dbV6.banks, dbV6.bankFolders, dbV6.questions, dbV6.bankQuestionMemberships, dbV6.imageAssets,
    dbV6.attempts, dbV6.attemptStats, dbV6.attemptDailyStats, dbV6.notes, dbV6.practiceRuns,
    dbV6.practiceRunStats, dbV6.questionGroups, dbV6.reviewRounds, dbV6.reviewRoundProgress,
    dbV6.tombstones, dbV6.events,
  ];
  let applied = 0;
  let preserved = 0;
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

    for (const event of remoteEvents) {
      if (await applyV6Event(event)) applied += 1;
    }
    for (const event of pending) {
      if (remoteIds.has(event.id)) continue;
      if (await applyV6Event(event)) {
        await dbV6.events.put({ ...event, synced: 0 });
        preserved += 1;
      }
    }
  });
  return { applied, preserved };
}

export const applyV6CheckpointAndEvents = restoreV6CheckpointAndEvents;

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
  await dbV6.imageAssets.put(asset);
  if (asset.remote) await dbV6.events.put(eventInTx("image.asset.saved", { ...asset, blob: undefined }, nowIso()));
  return asset;
}

export async function putImageAssetDescriptorV6(asset: Omit<ImageAsset, "blob">): Promise<ImageAsset> {
  return putImageAssetV6(asset);
}

export async function putImageAssetBlobV6(id: string, blob: Blob): Promise<ImageAsset> {
  const descriptor = await dbV6.imageAssets.get(id);
  if (!descriptor) throw new Error("图片 descriptor 不存在。");
  return putImageAssetV6({ ...descriptor, blob });
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
