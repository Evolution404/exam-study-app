/**
 * Core projection types and base helpers for the pure v7 projection reducer.
 * This module intentionally has no browser/Dexie dependencies and must not
 * depend on the cascade/derived/reducer modules (strict one-way layering).
 */
import type {
  AttemptDailyStatsV7,
  AttemptStatsV7,
  AttemptV7,
  BankFolderV7,
  BankQuestionMembership,
  BankV7,
  ImageAsset,
  NoteV7,
  PracticeRunStatsV7,
  PracticeRunV7,
  QuestionGroupV7,
  QuestionV7,
  ReviewRound,
  ReviewRoundProgress,
  TombstoneV7,
} from "../db/v7-types";

export interface ChangeSetProjectionV7 {
  banks: BankV7[];
  bankFolders: BankFolderV7[];
  questions: QuestionV7[];
  memberships: BankQuestionMembership[];
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
  /** Attempt-to-round provenance is needed because AttemptV7 is round-neutral. */
  attemptRoundIds?: Record<string, string[]>;
}

export type ChangeSetProjectionInputV7 = ChangeSetProjectionV7;

export interface ProjectionValidationIssueV7 {
  path: string;
  message: string;
}

export function fail(message: string): never {
  throw new Error(`v7 projection conflict: ${message}`);
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

export function normalizeProjection(input: ChangeSetProjectionInputV7): ChangeSetProjectionV7 {
  return {
    banks: list(input.banks),
    bankFolders: list(input.bankFolders),
    questions: list(input.questions),
    memberships: list(input.memberships),
    imageAssets: list(input.imageAssets),
    attempts: list(input.attempts),
    attemptStats: list(input.attemptStats),
    attemptDailyStats: list(input.attemptDailyStats),
    notes: list(input.notes),
    practiceRuns: list(input.practiceRuns),
    practiceRunStats: list(input.practiceRunStats),
    questionGroups: list(input.questionGroups),
    reviewRounds: list(input.reviewRounds),
    reviewRoundProgress: list(input.reviewRoundProgress),
    tombstones: list(input.tombstones),
    attemptRoundIds: clone(input.attemptRoundIds ?? {}),
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

export function removeMembership(projection: ChangeSetProjectionV7, key: string): BankQuestionMembership {
  const index = projection.memberships.findIndex((membership) => membership.key === key);
  if (index < 0) fail(`题库关系 ${key} 不存在`);
  const [removed] = projection.memberships.splice(index, 1);
  return removed;
}

export function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

export function ensureQuestion(projection: ChangeSetProjectionV7, questionId: string): QuestionV7 {
  return requireById(projection.questions, questionId, "题目");
}

export function ensureBank(projection: ChangeSetProjectionV7, bankId: string): BankV7 {
  return requireById(projection.banks, bankId, "题库");
}

export function ensureRun(projection: ChangeSetProjectionV7, runId: string): PracticeRunV7 {
  return requireById(projection.practiceRuns, runId, "练习");
}

export function ensureFolder(projection: ChangeSetProjectionV7, folderId: string): BankFolderV7 {
  return requireById(projection.bankFolders, folderId, "题库文件夹");
}

export function ensureAsset(projection: ChangeSetProjectionV7, assetId: string): ImageAsset {
  const asset = projection.imageAssets.find((item) => item.id === assetId);
  if (!asset) fail(`图片资产 ${assetId} 不存在`);
  return asset;
}

export function ensureRound(projection: ChangeSetProjectionV7, roundId: string): ReviewRound {
  return requireById(projection.reviewRounds, roundId, "复习轮次");
}

export function setByKey<T extends { key: string }>(values: T[], value: T, allowInsert = true): void {
  const index = values.findIndex((item) => item.key === value.key);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.key} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}

export function setByQuestionId(values: NoteV7[], value: NoteV7): void {
  const index = values.findIndex((item) => item.questionId === value.questionId);
  if (index < 0) values.push(clone(value));
  else values[index] = clone(value);
}

export function upsertAttemptRound(projection: ChangeSetProjectionV7, attemptId: string, roundId?: string): void {
  if (!roundId) return;
  const current = projection.attemptRoundIds?.[attemptId] ?? [];
  projection.attemptRoundIds ??= {};
  projection.attemptRoundIds[attemptId] = uniqueStrings([...current, roundId]).sort();
}

export function removeAttemptRound(projection: ChangeSetProjectionV7, attemptId: string): void {
  if (projection.attemptRoundIds) delete projection.attemptRoundIds[attemptId];
}

export function putTombstone(projection: ChangeSetProjectionV7, entityType: TombstoneV7["entityType"], entityId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  const key = `${entityType}:${entityId}`;
  const old = projection.tombstones.find((item) => item.key === key);
  const next: TombstoneV7 = { key, entityType, entityId, deletedAt, deviceId, eventId, sequence };
  if (!old) projection.tombstones.push(next);
  else if (compareClock(next, old) > 0) projection.tombstones[projection.tombstones.indexOf(old)] = next;
}

export function removeTombstone(projection: ChangeSetProjectionV7, type: string, id: string): void {
  projection.tombstones = projection.tombstones.filter((item) => item.key !== `${type}:${id}`);
}

export function rejectTombstoned(projection: ChangeSetProjectionV7, type: string, id: string): void {
  if (projection.tombstones.some((item) => item.key === `${type}:${id}`)) fail(`${type} ${id} 已被删除，陈旧变更不能重新创建它`);
}

export function runBankIds(run: Pick<PracticeRunV7, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

/** Copy-on-write answer update: returns a NEW run object.  In-place mutation
 *  would leak into the base projection shared with a shallow replay envelope,
 *  breaking per-record rollback. */
export function runWithAnswer(run: PracticeRunV7, questionId: string, answer: PracticeRunV7["answers"][string]): PracticeRunV7 {
  const answers = { ...run.answers, [questionId]: clone(answer) };
  const updatedAt = answer.updatedAt ?? run.updatedAt;
  const revision = run.revision + 1;
  const submitted = run.questionIds.reduce((last, id, index) => answers[id]?.submitted ? index : last, -1);
  return { ...run, answers, updatedAt, revision, ...(submitted >= 0 ? { lastAnsweredIndex: submitted } : {}) };
}

/** Shallow replay envelope: a new projection object whose top-level arrays are
 *  fresh (pointer-copied) but whose elements are shared with the base until a
 *  mutation writes them.  Every mutation path writes either a whole array or a
 *  CLONED entity into a slot (see runWithAnswer for the one former exception),
 *  so the base projection is never observably mutated and a failed record can
 *  be rolled back by simply discarding its envelope. */
export function shallowEnvelope(base: ChangeSetProjectionV7): ChangeSetProjectionV7 {
  return {
    banks: [...base.banks],
    bankFolders: [...base.bankFolders],
    questions: [...base.questions],
    memberships: [...base.memberships],
    imageAssets: [...base.imageAssets],
    attempts: [...base.attempts],
    attemptStats: [...base.attemptStats],
    attemptDailyStats: [...base.attemptDailyStats],
    notes: [...base.notes],
    practiceRuns: [...base.practiceRuns],
    practiceRunStats: [...base.practiceRunStats],
    questionGroups: [...base.questionGroups],
    reviewRounds: [...base.reviewRounds],
    reviewRoundProgress: [...base.reviewRoundProgress],
    tombstones: [...base.tombstones],
    attemptRoundIds: { ...base.attemptRoundIds },
  };
}
