/**
 * v7 database core: the single Dexie instance, its schema, shared id/clock
 * helpers and the shared v7 interfaces.  This module deliberately does not
 * import change-set creation, image hashing or question content helpers so it
 * stays free of business logic and can be imported by every sibling module.
 */
import Dexie, { type EntityTable } from "dexie";
import { queueConfigMirror } from "../../platform/persistent-config";
import type { ChangeSetQueueRecordV7 } from "./db-v7-change-sets";
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

let idCounter = 0;
let sequenceCounter = 0;
let sequenceLockTail: Promise<void> = Promise.resolve();

/** internal, 供兄弟模块使用 */
export function nowIso(): string {
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
    queueConfigMirror(key, value);
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
    if (locks) return await locks.request("shijuan-study-v7-sequence", { mode: "exclusive" }, operation);
    return await operation();
  } finally {
    release();
  }
}

/**
 * Allocate a per-device sequence under an async lock and an IndexedDB
 * read/write transaction. The IDB row is the cross-realm source of truth;
 * Web Locks additionally serialize the localStorage compatibility mirror.
 * Gaps are harmless when a surrounding domain transaction later aborts.
 */
export async function nextV7Sequence(deviceId = getV7DeviceId()): Promise<number> {
  const current = Dexie.currentTransaction;
  if (current?.active && current.db === dbV7 && current.mode === "readwrite") {
    if (!current.storeNames.includes(dbV7.syncMeta.name)) {
      throw new Error("分配同步序号的业务事务必须包含 syncMeta，禁止在 Safari 中启动嵌套写事务。");
    }
    const key = `shijuan-study-v7-sequence:${deviceId}`;
    const legacyKey = `shijuan-study-v6-sequence:${deviceId}`;
    const row = await dbV7.syncMeta.get(key);
    const persisted = Number(row?.value) || 0;
    const legacy = typeof localStorage !== "undefined" ? Number(localStorage.getItem(legacyKey)) || Number(localStorage.getItem(key)) || 0 : 0;
    const value = Math.max(sequenceCounter, Date.now() * 1000, Number.isSafeInteger(persisted) ? persisted : 0, Number.isSafeInteger(legacy) ? legacy : 0) + 1;
    await dbV7.syncMeta.put({ key, value, updatedAt: nowIso() });
    sequenceCounter = Math.max(sequenceCounter, value);
    if (typeof localStorage !== "undefined") localStorage.setItem(key, String(value));
    return value;
  }
  return withSequenceLock(async () => {
    const key = `shijuan-study-v7-sequence:${deviceId}`;
    const legacyKey = `shijuan-study-v6-sequence:${deviceId}`;
    // Outside a domain transaction, reserve through a short independent
    // transaction. Domain transactions include syncMeta and use the branch
    // above: Safari serializes all read/write transactions at database level,
    // so awaiting an independent syncMeta write from inside another write
    // transaction would deadlock the entire local app.
    const allocated = await Dexie.ignoreTransaction(() => dbV7.transaction("rw", dbV7.syncMeta, async () => {
      const row = await dbV7.syncMeta.get(key);
      const persisted = Number(row?.value) || 0;
      const legacy = typeof localStorage !== "undefined" ? Number(localStorage.getItem(legacyKey)) || Number(localStorage.getItem(key)) || 0 : 0;
      const current = Math.max(sequenceCounter, Date.now() * 1000, Number.isSafeInteger(persisted) ? persisted : 0, Number.isSafeInteger(legacy) ? legacy : 0);
      const next = current + 1;
      await dbV7.syncMeta.put({ key, value: next, updatedAt: nowIso() });
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
