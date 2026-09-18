/**
 * Core projection types and base helpers for the projection reducer.
 * This module intentionally has no browser/Dexie dependencies and must not
 * depend on the cascade/derived/reducer modules (strict one-way layering).
 */
import type {
  AttemptDailyStats,
  AttemptStats,
  Attempt,
  BankFolder,
  BankQuestionMembership,
  Bank,
  ImageAsset,
  Note,
  PracticeRunStats,
  PracticeRun,
  QuestionGroup,
  Question,
  ReviewRound,
  ReviewRoundProgress,
  Tombstone,
} from "../db/types";

export interface ChangeSetProjection {
  banks: Bank[];
  bankFolders: BankFolder[];
  questions: Question[];
  memberships: BankQuestionMembership[];
  imageAssets: ImageAsset[];
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

export type ChangeSetProjectionInput = ChangeSetProjection;

export interface ProjectionValidationIssue {
  path: string;
  message: string;
}

export function fail(message: string): never {
  throw new Error(`projection conflict: ${message}`);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function list<T>(value: readonly T[] | undefined): T[] {
  return value ? clone([...value]) : [];
}

export function byId<T extends { id: string }>(values: T[], id: string): T | undefined {
  return values.find((value) => value.id === id);
}

export function requireById<T extends { id: string }>(values: T[], id: string, entity: string): T {
  const value = byId(values, id);
  if (!value) fail(`${entity} ${id} 不存在`);
  return value;
}

export function compareClock(
  a: { updatedAt?: string; createdAt?: string; deletedAt?: string; deviceId?: string; id?: string; eventId?: string },
  b: { updatedAt?: string; createdAt?: string; deletedAt?: string; deviceId?: string; id?: string; eventId?: string },
): number {
  return (a.updatedAt ?? a.createdAt ?? a.deletedAt ?? "").localeCompare(b.updatedAt ?? b.createdAt ?? b.deletedAt ?? "")
    || (a.deviceId ?? "").localeCompare(b.deviceId ?? "")
    || (a.id ?? a.eventId ?? "").localeCompare(b.id ?? b.eventId ?? "");
}

export function datePart(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value.slice(0, 10);
}

export function dailyKey(createdAt: string, questionId: string): string {
  return `${datePart(createdAt)}:${questionId}`;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function usableTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function latestAttemptTimestamps(attempts: readonly Attempt[]): Map<string, Map<string, string>> {
  const byRun = new Map<string, Map<string, string>>();
  for (const attempt of attempts) {
    let byQuestion = byRun.get(attempt.runId);
    if (!byQuestion) {
      byQuestion = new Map<string, string>();
      byRun.set(attempt.runId, byQuestion);
    }
    const current = byQuestion.get(attempt.questionId);
    if (!current || attempt.createdAt.localeCompare(current) > 0) byQuestion.set(attempt.questionId, attempt.createdAt);
  }
  return byRun;
}

function repairSubmittedAnswerTimestamps(practiceRuns: PracticeRun[], attempts: readonly Attempt[]): void {
  const attemptTimestamps = latestAttemptTimestamps(attempts);
  for (const run of practiceRuns) {
    const runAttempts = attemptTimestamps.get(run.id);
    for (const [questionId, answer] of Object.entries(run.answers)) {
      if (!answer.submitted || usableTimestamp(answer.updatedAt)) continue;
      const fallback = runAttempts?.get(questionId) ?? run.updatedAt;
      if (!usableTimestamp(fallback)) continue;
      run.answers[questionId] = { ...answer, updatedAt: fallback };
    }
  }
}

export function normalizeProjection(input: ChangeSetProjectionInput): ChangeSetProjection {
  const attempts = list(input.attempts);
  const practiceRuns = list(input.practiceRuns);
  // Current writers persist answer.updatedAt together with the matching attempt.
  // Some already-published checkpoints were produced from a run snapshot whose
  // submitted answers predate that invariant. Repair only that missing field from
  // canonical data already present in the same projection, so a synchronized
  // checkpoint cannot poison IndexedDB during install/reconcile.
  repairSubmittedAnswerTimestamps(practiceRuns, attempts);
  return {
    banks: list(input.banks),
    bankFolders: list(input.bankFolders),
    questions: list(input.questions),
    memberships: list(input.memberships),
    imageAssets: list(input.imageAssets),
    attempts,
    attemptStats: list(input.attemptStats),
    attemptDailyStats: list(input.attemptDailyStats),
    notes: list(input.notes),
    practiceRuns,
    practiceRunStats: list(input.practiceRunStats),
    questionGroups: list(input.questionGroups),
    reviewRounds: list(input.reviewRounds),
    reviewRoundProgress: list(input.reviewRoundProgress),
    tombstones: list(input.tombstones),
  };
}

export function setById<T extends { id: string }>(values: T[], value: T, allowInsert = true): void {
  const index = values.findIndex((item) => item.id === value.id);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.id} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}

export function removeById<T extends { id: string }>(values: T[], id: string, entity: string): T {
  const index = values.findIndex((item) => item.id === id);
  if (index < 0) fail(`${entity} ${id} 不存在`);
  const [removed] = values.splice(index, 1);
  return removed;
}

export function removeMembership(projection: ChangeSetProjection, key: string): BankQuestionMembership {
  const index = projection.memberships.findIndex((membership) => membership.key === key);
  if (index < 0) fail(`题库关系 ${key} 不存在`);
  const [removed] = projection.memberships.splice(index, 1);
  return removed;
}

export function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

export function ensureQuestion(projection: ChangeSetProjection, questionId: string): Question {
  return requireById(projection.questions, questionId, "题目");
}

export function ensureBank(projection: ChangeSetProjection, bankId: string): Bank {
  return requireById(projection.banks, bankId, "题库");
}

export function ensureRun(projection: ChangeSetProjection, runId: string): PracticeRun {
  return requireById(projection.practiceRuns, runId, "练习");
}

export function ensureFolder(projection: ChangeSetProjection, folderId: string): BankFolder {
  return requireById(projection.bankFolders, folderId, "题库文件夹");
}

export function ensureAsset(projection: ChangeSetProjection, assetId: string): ImageAsset {
  const asset = projection.imageAssets.find((item) => item.id === assetId);
  if (!asset) fail(`图片资产 ${assetId} 不存在`);
  return asset;
}

export function ensureRound(projection: ChangeSetProjection, roundId: string): ReviewRound {
  return requireById(projection.reviewRounds, roundId, "复习轮次");
}

export function setByKey<T extends { key: string }>(values: T[], value: T, allowInsert = true): void {
  const index = values.findIndex((item) => item.key === value.key);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.key} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}

export function setByQuestionId(values: Note[], value: Note): void {
  const index = values.findIndex((item) => item.questionId === value.questionId);
  if (index < 0) values.push(clone(value));
  else values[index] = clone(value);
}

export function putTombstone(projection: ChangeSetProjection, entityType: Tombstone["entityType"], entityId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  const key = `${entityType}:${entityId}`;
  const old = projection.tombstones.find((item) => item.key === key);
  const next: Tombstone = { key, entityType, entityId, deletedAt, deviceId, eventId, sequence };
  if (!old) projection.tombstones.push(next);
  else if (compareClock(next, old) > 0) projection.tombstones[projection.tombstones.indexOf(old)] = next;
}

export function removeTombstone(projection: ChangeSetProjection, type: string, id: string): void {
  projection.tombstones = projection.tombstones.filter((item) => item.key !== `${type}:${id}`);
}

export function rejectTombstoned(projection: ChangeSetProjection, type: string, id: string): void {
  if (projection.tombstones.some((item) => item.key === `${type}:${id}`)) fail(`${type} ${id} 已被删除，陈旧变更不能重新创建它`);
}

export function runBankIds(run: Pick<PracticeRun, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

/** Copy-on-write answer update: returns a NEW run object.  In-place mutation
 *  would leak into the base projection shared with a shallow replay envelope,
 *  breaking per-record rollback. */
export function runWithAnswer(run: PracticeRun, questionId: string, answer: PracticeRun["answers"][string]): PracticeRun {
  const normalizedAnswer = clone(answer);
  // Decoder compatibility is deliberately narrow: a historical wire record may
  // have a submitted answer without the timestamp that the current DB requires.
  // A replayed record has no access to the attempt here, so the run clock is the
  // deterministic fallback; normalizeProjection uses the matching attempt clock
  // whenever the answer came from a checkpoint/base projection.
  if (normalizedAnswer.submitted && !usableTimestamp(normalizedAnswer.updatedAt) && usableTimestamp(run.updatedAt)) {
    normalizedAnswer.updatedAt = run.updatedAt;
  }
  const answers = { ...run.answers, [questionId]: normalizedAnswer };
  const updatedAt = normalizedAnswer.updatedAt ?? run.updatedAt;
  const revision = run.revision + 1;
  const submitted = run.questionIds.reduce((last, id, index) => answers[id]?.submitted ? index : last, -1);
  return { ...run, answers, updatedAt, revision, ...(submitted >= 0 ? { lastAnsweredIndex: submitted } : {}) };
}

type CopyOnWriteArrayHandle<T> = {
  proxy: T[];
  current(): T[];
};

function copyOnWriteArray<T>(base: T[]): CopyOnWriteArrayHandle<T> {
  let current = base;
  let copied = false;
  const ensureCopy = () => {
    if (copied) return;
    current = [...base];
    copied = true;
  };
  const proxy = new Proxy(base, {
    get(_target, property) {
      return Reflect.get(current, property, proxy);
    },
    set(_target, property, value) {
      ensureCopy();
      return Reflect.set(current, property, value);
    },
    deleteProperty(_target, property) {
      ensureCopy();
      return Reflect.deleteProperty(current, property);
    },
    defineProperty(_target, property, descriptor) {
      ensureCopy();
      return Reflect.defineProperty(current, property, descriptor);
    },
    has(_target, property) {
      return Reflect.has(current, property);
    },
    ownKeys() {
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(_target, property) {
      return Reflect.getOwnPropertyDescriptor(current, property);
    },
  }) as T[];
  return { proxy, current: () => current };
}

function committedArray<T>(value: T[], handle: CopyOnWriteArrayHandle<T>): T[] {
  return value === handle.proxy ? handle.current() : value;
}

/**
 * Per-change replay envelope with table-level copy-on-write.
 *
 * Reads reuse the caller-owned projection arrays directly. The first write to
 * a table clones only that one top-level array; tables untouched by the
 * change-set keep reference identity. If a later mutation in the same
 * change-set throws, discarding this envelope rolls back every write because
 * the base arrays were never mutated.
 */
export function shallowEnvelope(base: ChangeSetProjection): {
  projection: ChangeSetProjection;
  commit(): ChangeSetProjection;
} {
  const banks = copyOnWriteArray(base.banks);
  const bankFolders = copyOnWriteArray(base.bankFolders);
  const questions = copyOnWriteArray(base.questions);
  const memberships = copyOnWriteArray(base.memberships);
  const imageAssets = copyOnWriteArray(base.imageAssets);
  const attempts = copyOnWriteArray(base.attempts);
  const attemptStats = copyOnWriteArray(base.attemptStats);
  const attemptDailyStats = copyOnWriteArray(base.attemptDailyStats);
  const notes = copyOnWriteArray(base.notes);
  const practiceRuns = copyOnWriteArray(base.practiceRuns);
  const practiceRunStats = copyOnWriteArray(base.practiceRunStats);
  const questionGroups = copyOnWriteArray(base.questionGroups);
  const reviewRounds = copyOnWriteArray(base.reviewRounds);
  const reviewRoundProgress = copyOnWriteArray(base.reviewRoundProgress);
  const tombstones = copyOnWriteArray(base.tombstones);

  const projection: ChangeSetProjection = {
    banks: banks.proxy,
    bankFolders: bankFolders.proxy,
    questions: questions.proxy,
    memberships: memberships.proxy,
    imageAssets: imageAssets.proxy,
    attempts: attempts.proxy,
    attemptStats: attemptStats.proxy,
    attemptDailyStats: attemptDailyStats.proxy,
    notes: notes.proxy,
    practiceRuns: practiceRuns.proxy,
    practiceRunStats: practiceRunStats.proxy,
    questionGroups: questionGroups.proxy,
    reviewRounds: reviewRounds.proxy,
    reviewRoundProgress: reviewRoundProgress.proxy,
    tombstones: tombstones.proxy,
  };

  return {
    projection,
    commit: () => ({
      banks: committedArray(projection.banks, banks),
      bankFolders: committedArray(projection.bankFolders, bankFolders),
      questions: committedArray(projection.questions, questions),
      memberships: committedArray(projection.memberships, memberships),
      imageAssets: committedArray(projection.imageAssets, imageAssets),
      attempts: committedArray(projection.attempts, attempts),
      attemptStats: committedArray(projection.attemptStats, attemptStats),
      attemptDailyStats: committedArray(projection.attemptDailyStats, attemptDailyStats),
      notes: committedArray(projection.notes, notes),
      practiceRuns: committedArray(projection.practiceRuns, practiceRuns),
      practiceRunStats: committedArray(projection.practiceRunStats, practiceRunStats),
      questionGroups: committedArray(projection.questionGroups, questionGroups),
      reviewRounds: committedArray(projection.reviewRounds, reviewRounds),
      reviewRoundProgress: committedArray(projection.reviewRoundProgress, reviewRoundProgress),
      tombstones: committedArray(projection.tombstones, tombstones),
    }),
  };
}
