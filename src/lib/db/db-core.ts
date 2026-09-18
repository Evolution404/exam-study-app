/**
 * Database core: the single Dexie instance, its schema, shared id/clock
 * helpers and the shared domain interfaces. This module deliberately does not
 * import change-set creation, image hashing or question content helpers so it
 * stays free of business logic and can be imported by every sibling module.
 */
import Dexie, { type EntityTable, type Table } from "dexie";
import { queueConfigMirror } from "../../platform/persistent-config";
import type { ChangeSetQueueRecord } from "./db-change-sets";
import type {
  AttemptDailyStats,
  AttemptStats,
  Attempt,
  BankFolder,
  BankQuestionMembership,
  BankPracticeStats,
  Bank,
  ContentBlock,
  ImageAssetDescriptor,
  ImageBlob,
  Note,
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  PracticeRunStats,
  PracticeRun,
  QuestionGroupItem,
  QuestionGroupRecord,
  QuestionGroup,
  QuestionType,
  Question,
  ReviewRound,
  ReviewRoundRecord,
  ReviewRoundBank,
  ReviewRoundItem,
  ReviewRoundProgress,
  SyncFile,
  SyncMeta,
  Tombstone,
} from "./types";

/** Current local IndexedDB namespace. */
export const DATABASE_NAME = "shijuan-study" as const;

export interface PracticeAnswer {
  selected: string[];
  submitted: true;
  correct: boolean;
  updatedAt: string;
  deviceId: string;
  eventId: string;
}

export interface PracticeAnswerInput {
  runId: string;
  questionId: string;
  selected: string | readonly string[];
  correct: boolean;
  elapsedMs: number;
  /** Optional source bank for history display; statistics remain global. */
  sourceBankId?: string;
  bankId?: string;
  reviewRoundId?: string;
  createdAt?: string;
}

export interface QuestionDraft {
  type: QuestionType;
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

export interface BankQuestionJoin {
  question: Question;
  membership: BankQuestionMembership;
}

export interface CreatePracticeRunInput {
  id?: string;
  bankId?: string;
  bankIds?: string[];
  bankName?: string;
  mode?: PracticeRun["mode"];
  modeLabel?: string;
  questionIds?: string[];
  questionTypes?: Record<string, QuestionType>;
  answers?: PracticeRun["answers"];
  shuffleOptions?: boolean;
  optionOrders?: Record<string, number[]>;
  startedAt?: string;
  updatedAt?: string;
  status?: PracticeRun["status"];
  revision?: number;
  lastAnsweredIndex?: number;
  reviewRoundId?: string;
}

/** Complete projection shape accepted by the atomic restore helper. */
export interface RestoreState {
  banks: Bank[];
  bankFolders: BankFolder[];
  questions: Question[];
  memberships: BankQuestionMembership[];
  imageAssets: ImageAssetDescriptor[];
  attempts: Attempt[];
  attemptStats: AttemptStats[];
  attemptDailyStats: AttemptDailyStats[];
  notes: Note[];
  practiceRuns: PracticeRun[];
  practiceRunStats: PracticeRunStats[];
  questionGroups: QuestionGroup[];
  reviewRounds: ReviewRound[];
  reviewRoundProgress: ReviewRoundProgress[];
  tombstones: Tombstone[];
}

let idCounter = 0;
let sequenceCounter = 0;
let sequenceLockTail: Promise<void> = Promise.resolve();

/** internal, 供兄弟模块使用 */
export function nowIso(): string {
  return new Date().toISOString();
}

export function makeId(prefix = "id"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}_${uuid}`;
  idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

const DEVICE_ID_KEY = "shijuan-study-device-id";

export function getDeviceId(): string {
  if (typeof localStorage === "undefined") return "server";
  // This is the current durable sync-device identity key.
  let value: string | null = localStorage.getItem(DEVICE_ID_KEY);
  if (!value) {
    value = makeId("device");
    localStorage.setItem(DEVICE_ID_KEY, value);
    queueConfigMirror(DEVICE_ID_KEY, value);
  }
  return value;
}

/** internal, 供兄弟模块使用 */
type NavigatorLocksLike = {
  request<T>(name: string, options: { mode: "exclusive" }, callback: () => Promise<T>): Promise<T>;
};

function navigatorLocks(): NavigatorLocksLike | undefined {
  const navigatorValue = (globalThis as { navigator?: { locks?: NavigatorLocksLike } }).navigator;
  return navigatorValue?.locks;
}

async function withSequenceLock<T>(operation: () => Promise<T>): Promise<T> {
  let release!: () => void;
  const previous = sequenceLockTail;
  sequenceLockTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const locks = navigatorLocks();
    if (locks) return await locks.request("shijuan-study-sequence", { mode: "exclusive" }, operation);
    return await operation();
  } finally {
    release();
  }
}

/**
 * Allocate a per-device sequence under an async lock and an IndexedDB
 * read/write transaction. The IDB row is the cross-realm source of truth;
 * Web Locks additionally serialize the localStorage mirror.
 * Gaps are harmless when a surrounding domain transaction later aborts.
 */
export async function nextSequence(deviceId = getDeviceId()): Promise<number> {
  const current = Dexie.currentTransaction;
  if (current?.active && current.db === studyDb && current.mode === "readwrite") {
    if (!current.storeNames.includes(studyDb.syncMeta.name)) {
      throw new Error("分配同步序号的业务事务必须包含 syncMeta，禁止在 Safari 中启动嵌套写事务。");
    }
    const key = `shijuan-study-sequence:${deviceId}`;
    const row = await studyDb.syncMeta.get(key);
    const persisted = Number(row?.value) || 0;
    // The localStorage mirror survives the namespace swap and keeps allocated
    // sequences monotonic even before the fresh database has any rows.
    const mirrored = typeof localStorage !== "undefined" ? Number(localStorage.getItem(key)) || 0 : 0;
    const value = Math.max(sequenceCounter, Date.now() * 1000, Number.isSafeInteger(persisted) ? persisted : 0, Number.isSafeInteger(mirrored) ? mirrored : 0) + 1;
    await studyDb.syncMeta.put({ key, value, updatedAt: nowIso() });
    sequenceCounter = Math.max(sequenceCounter, value);
    if (typeof localStorage !== "undefined") localStorage.setItem(key, String(value));
    return value;
  }
  return withSequenceLock(async () => {
    const key = `shijuan-study-sequence:${deviceId}`;
    // Outside a domain transaction, reserve through a short independent
    // transaction. Domain transactions include syncMeta and use the branch
    // above: Safari serializes all read/write transactions at database level,
    // so awaiting an independent syncMeta write from inside another write
    // transaction would deadlock the entire local app.
    const allocated = await Dexie.ignoreTransaction(() => studyDb.transaction("rw", studyDb.syncMeta, async () => {
      const row = await studyDb.syncMeta.get(key);
      const persisted = Number(row?.value) || 0;
      const mirrored = typeof localStorage !== "undefined" ? Number(localStorage.getItem(key)) || 0 : 0;
      const current = Math.max(sequenceCounter, Date.now() * 1000, Number.isSafeInteger(persisted) ? persisted : 0, Number.isSafeInteger(mirrored) ? mirrored : 0);
      const next = current + 1;
      await studyDb.syncMeta.put({ key, value: next, updatedAt: nowIso() });
      return next;
    }));
    sequenceCounter = Math.max(sequenceCounter, allocated);
    if (typeof localStorage !== "undefined") localStorage.setItem(key, String(allocated));
    return allocated;
  });
}

/** internal, 供兄弟模块使用 */
export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/** internal, 供兄弟模块使用 */
export function tombstoneKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/** internal, 供兄弟模块使用 */
export function compareClock(left: { updatedAt?: string; createdAt?: string; deviceId?: string; id?: string }, right: { updatedAt?: string; createdAt?: string; deviceId?: string; id?: string }): number {
  return (left.updatedAt ?? left.createdAt ?? "").localeCompare(right.updatedAt ?? right.createdAt ?? "")
    || (left.deviceId ?? "").localeCompare(right.deviceId ?? "")
    || (left.id ?? "").localeCompare(right.id ?? "");
}

/** internal, 供兄弟模块使用 */
export function datePart(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value.slice(0, 10);
}

/** internal, 供兄弟模块使用 */
export function dailyStatsKey(createdAt: string, questionId: string): string {
  return `${datePart(createdAt)}:${questionId}`;
}

/** Single current schema. Old local schemas are not supported or migrated. */
class StudyDatabase extends Dexie {
  banks!: EntityTable<Bank, "id">;
  bankFolders!: EntityTable<BankFolder, "id">;
  questions!: EntityTable<Question, "id">;
  bankQuestionMemberships!: Table<BankQuestionMembership, [string, string]>;
  imageAssets!: EntityTable<ImageAssetDescriptor, "id">;
  imageBlobs!: EntityTable<ImageBlob, "assetId">;
  attempts!: EntityTable<Attempt, "id">;
  questionProgress!: EntityTable<AttemptStats, "questionId">;
  questionDailyProgress!: Table<AttemptDailyStats, [string, string]>;
  notes!: EntityTable<Note, "questionId">;
  practiceRuns!: EntityTable<PracticeRunRecord, "id">;
  practiceRunSources!: Table<PracticeRunSource, [string, string]>;
  practiceRunItems!: Table<PracticeRunItem, [string, string]>;
  bankPracticeStats!: EntityTable<BankPracticeStats, "bankId">;
  questionGroups!: EntityTable<QuestionGroupRecord, "id">;
  questionGroupItems!: Table<QuestionGroupItem, [string, string]>;
  reviewRounds!: EntityTable<ReviewRoundRecord, "id">;
  reviewRoundBanks!: Table<ReviewRoundBank, [string, string]>;
  reviewRoundItems!: Table<ReviewRoundItem, [string, string]>;
  reviewRoundProgress!: Table<ReviewRoundProgress, [string, string]>;
  changeSets!: EntityTable<ChangeSetQueueRecord, "id">;
  syncFiles!: EntityTable<SyncFile, "path">;
  tombstones!: EntityTable<Tombstone, "key">;
  syncMeta!: EntityTable<SyncMeta, "key">;

  constructor() {
    super(DATABASE_NAME);
    // Development policy: all clients move together. When this schema changes,
    // local data is cleared and rebuilt from remote sync; do not add migrations.
    this.version(1).stores({
      banks: "id, sortOrder, folderId, importedAt, updatedAt",
      bankFolders: "id, sortOrder, updatedAt",
      questions: "id, contentFingerprint, type, updatedAt, *tags",
      bankQuestionMemberships: "[bankId+questionId], bankId, questionId, sortOrder, updatedAt, [bankId+sortOrder]",
      imageAssets: "id, mimeType, size",
      imageBlobs: "assetId, cachedAt, lastUsedAt",
      attempts: "id, runId, questionId, reviewRoundId, sourceBankId, createdAt, deviceId, [questionId+createdAt], [runId+createdAt], [reviewRoundId+createdAt], [reviewRoundId+questionId+createdAt]",
      questionProgress: "questionId, latestAttemptAt",
      questionDailyProgress: "[date+questionId], date, questionId, [questionId+date]",
      notes: "questionId, updatedAt",
      practiceRuns: "id, status, startedAt, updatedAt, activityAt, reviewRoundId, [status+activityAt]",
      practiceRunSources: "[runId+bankId], runId, bankId, [runId+position]",
      practiceRunItems: "[runId+questionId], runId, questionId, submittedAttemptId, [runId+position]",
      bankPracticeStats: "bankId, latestActivityAt",
      questionGroups: "id, type, updatedAt",
      questionGroupItems: "[groupId+questionId], groupId, questionId, [groupId+position]",
      reviewRounds: "id, status, updatedAt, startedAt",
      reviewRoundBanks: "[roundId+bankId], roundId, bankId, [roundId+position]",
      reviewRoundItems: "[roundId+questionId], roundId, questionId, [roundId+position]",
      reviewRoundProgress: "[roundId+questionId], roundId, questionId, latestAttemptAt",
      changeSets: "id, state, createdAt, deviceId, localSequence, claimId, committedAt, [state+createdAt]",
      syncFiles: "path, sha, appliedAt",
      tombstones: "key, entityType, entityId, deletedAt",
      syncMeta: "key, updatedAt",
    });
  }
}

/** The sole database instance for this release train. */
export const studyDb = new StudyDatabase();
/**
 * Startup health gate: the app awaits this before render so namespace-open
 * failures surface before interaction.
 */
export const studyDbReady: Promise<void> = studyDb.open().then(() => undefined);
/** Class is exported for tests that need a fresh, isolated namespace. */
export { StudyDatabase };

export async function resetDatabase(): Promise<void> {
  await studyDbReady;
  studyDb.close();
  await Dexie.delete(DATABASE_NAME);
  await studyDb.open();
}
