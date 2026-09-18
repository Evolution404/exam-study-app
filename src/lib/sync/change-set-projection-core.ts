/**
 * Canonical reducer primitives.
 *
 * This module owns only synchronized canonical facts. Device-local projections,
 * drafts and caches are intentionally absent.
 */
import type {
  Bank,
  BankFolder,
  BankQuestionMembership,
  CanonicalState,
  ImageAssetDescriptor,
  Note,
  PracticeRunRecord,
  Question,
  ReviewRoundRecord,
  Tombstone,
} from "../db/types";

export interface CanonicalStateValidationIssue {
  path: string;
  message: string;
}

export function fail(message: string): never {
  throw new Error(`canonical conflict: ${message}`);
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function list<T>(value: readonly T[] | undefined): T[] {
  return value ? clone([...value]) : [];
}

type LookupCacheEntry = { length: number; positions: Map<string, number> };
const idLookupCache = new WeakMap<object, LookupCacheEntry>();
const keyLookupCache = new WeakMap<object, LookupCacheEntry>();
const questionIdLookupCache = new WeakMap<object, LookupCacheEntry>();
const copyOnWriteBacking = new WeakMap<object, () => unknown[]>();

function lookupSource<T>(values: T[]): T[] {
  const backing = copyOnWriteBacking.get(values);
  return backing ? backing() as T[] : values;
}

function stringIndexOf<T>(
  values: T[],
  key: string,
  cache: WeakMap<object, LookupCacheEntry>,
  keyOf: (value: T) => string,
): number {
  const source = lookupSource(values);
  let cached = cache.get(source);
  if (!cached || cached.length !== source.length) {
    cached = { length: source.length, positions: new Map(source.map((value, index) => [keyOf(value), index])) };
    cache.set(source, cached);
  }
  let index = cached.positions.get(key);
  if (index === undefined) return -1;
  const current = source[index];
  if (!current || keyOf(current) !== key) {
    cached = { length: source.length, positions: new Map(source.map((value, position) => [keyOf(value), position])) };
    cache.set(source, cached);
    index = cached.positions.get(key);
  }
  return index ?? -1;
}

function idIndexOf<T extends { id: string }>(values: T[], id: string): number {
  return stringIndexOf(values, id, idLookupCache, (value) => value.id);
}
function keyIndexOf<T extends { key: string }>(values: T[], key: string): number {
  return stringIndexOf(values, key, keyLookupCache, (value) => value.key);
}
function questionIdIndexOf<T extends { questionId: string }>(values: T[], questionId: string): number {
  return stringIndexOf(values, questionId, questionIdLookupCache, (value) => value.questionId);
}

export function byId<T extends { id: string }>(values: T[], id: string): T | undefined {
  const source = lookupSource(values);
  const index = idIndexOf(values, id);
  return index < 0 ? undefined : source[index];
}
export function requireById<T extends { id: string }>(values: T[], id: string, entity: string): T {
  const value = byId(values, id);
  if (!value) fail(`${entity} ${id} 不存在`);
  return value;
}
export function setById<T extends { id: string }>(values: T[], value: T, allowInsert = true): void {
  const index = idIndexOf(values, value.id);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.id} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}
export function removeById<T extends { id: string }>(values: T[], id: string, entity: string): T {
  const index = idIndexOf(values, id);
  if (index < 0) fail(`${entity} ${id} 不存在`);
  const [removed] = values.splice(index, 1);
  return removed;
}
export function byKey<T extends { key: string }>(values: T[], key: string): T | undefined {
  const source = lookupSource(values);
  const index = keyIndexOf(values, key);
  return index < 0 ? undefined : source[index];
}
export function setByKey<T extends { key: string }>(values: T[], value: T, allowInsert = true): void {
  const index = keyIndexOf(values, value.key);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.key} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}
export function byQuestionId<T extends { questionId: string }>(values: T[], questionId: string): T | undefined {
  const source = lookupSource(values);
  const index = questionIdIndexOf(values, questionId);
  return index < 0 ? undefined : source[index];
}
export function setByQuestionId(values: Note[], value: Note): void {
  const index = questionIdIndexOf(values, value.questionId);
  if (index < 0) values.push(clone(value));
  else values[index] = clone(value);
}

export function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}
export function removeMembership(state: CanonicalState, key: string): BankQuestionMembership {
  const index = keyIndexOf(state.memberships, key);
  if (index < 0) fail(`题库关系 ${key} 不存在`);
  const [removed] = state.memberships.splice(index, 1);
  return removed;
}
export function ensureQuestion(state: CanonicalState, questionId: string): Question {
  return requireById(state.questions, questionId, "题目");
}
export function ensureBank(state: CanonicalState, bankId: string): Bank {
  return requireById(state.banks, bankId, "题库");
}
export function ensureRun(state: CanonicalState, runId: string): PracticeRunRecord {
  return requireById(state.practiceRuns, runId, "练习");
}
export function ensureFolder(state: CanonicalState, folderId: string): BankFolder {
  return requireById(state.bankFolders, folderId, "题库文件夹");
}
export function ensureAsset(state: CanonicalState, assetId: string): ImageAssetDescriptor {
  const asset = byId(state.imageAssets, assetId);
  if (!asset) fail(`图片资产 ${assetId} 不存在`);
  return asset;
}
export function ensureRound(state: CanonicalState, roundId: string): ReviewRoundRecord {
  return requireById(state.reviewRounds, roundId, "复习轮次");
}
export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function compareClock(
  a: { updatedAt?: string; createdAt?: string; deletedAt?: string; deviceId?: string; id?: string; eventId?: string },
  b: { updatedAt?: string; createdAt?: string; deletedAt?: string; deviceId?: string; id?: string; eventId?: string },
): number {
  return (a.updatedAt ?? a.createdAt ?? a.deletedAt ?? "").localeCompare(b.updatedAt ?? b.createdAt ?? b.deletedAt ?? "")
    || (a.deviceId ?? "").localeCompare(b.deviceId ?? "")
    || (a.id ?? a.eventId ?? "").localeCompare(b.id ?? b.eventId ?? "");
}

export function putTombstone(state: CanonicalState, entityType: Tombstone["entityType"], entityId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  const key = `${entityType}:${entityId}`;
  const index = keyIndexOf(state.tombstones, key);
  const old = index >= 0 ? lookupSource(state.tombstones)[index] : undefined;
  const next: Tombstone = { key, entityType, entityId, deletedAt, deviceId, eventId, sequence };
  if (!old) state.tombstones.push(next);
  else if (compareClock(next, old) > 0) state.tombstones[index] = next;
}
export function removeTombstone(state: CanonicalState, type: string, id: string): void {
  const index = keyIndexOf(state.tombstones, `${type}:${id}`);
  if (index >= 0) state.tombstones.splice(index, 1);
}
export function rejectTombstoned(state: CanonicalState, type: string, id: string): void {
  if (keyIndexOf(state.tombstones, `${type}:${id}`) >= 0) fail(`${type} ${id} 已被删除，陈旧变更不能重新创建它`);
}

export function normalizeCanonicalState(input: CanonicalState): CanonicalState {
  return {
    banks: list(input.banks),
    bankFolders: list(input.bankFolders),
    questions: list(input.questions),
    memberships: list(input.memberships),
    imageAssets: list(input.imageAssets),
    attempts: list(input.attempts),
    notes: list(input.notes),
    practiceRuns: list(input.practiceRuns),
    practiceRunSources: list(input.practiceRunSources),
    practiceRunItems: list(input.practiceRunItems),
    questionGroups: list(input.questionGroups),
    questionGroupItems: list(input.questionGroupItems),
    reviewRounds: list(input.reviewRounds),
    reviewRoundBanks: list(input.reviewRoundBanks),
    reviewRoundItems: list(input.reviewRoundItems),
    tombstones: list(input.tombstones),
  };
}

type CopyOnWriteArrayHandle<T> = { proxy: T[]; current(): T[] };
function copyOnWriteArray<T>(base: T[]): CopyOnWriteArrayHandle<T> {
  let current = base;
  let copied = false;
  const ensureCopy = () => {
    if (copied) return;
    current = [...base];
    copied = true;
  };
  const proxy = new Proxy(base, {
    get(_target, property) { return Reflect.get(current, property, proxy); },
    set(_target, property, value) { ensureCopy(); return Reflect.set(current, property, value); },
    deleteProperty(_target, property) { ensureCopy(); return Reflect.deleteProperty(current, property); },
    defineProperty(_target, property, descriptor) { ensureCopy(); return Reflect.defineProperty(current, property, descriptor); },
    has(_target, property) { return Reflect.has(current, property); },
    ownKeys() { return Reflect.ownKeys(current); },
    getOwnPropertyDescriptor(_target, property) { return Reflect.getOwnPropertyDescriptor(current, property); },
  });
  copyOnWriteBacking.set(proxy, () => current);
  return { proxy, current: () => current };
}
function committedArray<T>(value: T[], handle: CopyOnWriteArrayHandle<T>): T[] {
  return value === handle.proxy ? handle.current() : value;
}

export function shallowCanonicalEnvelope(base: CanonicalState): { state: CanonicalState; commit(): CanonicalState } {
  const banks = copyOnWriteArray(base.banks);
  const bankFolders = copyOnWriteArray(base.bankFolders);
  const questions = copyOnWriteArray(base.questions);
  const memberships = copyOnWriteArray(base.memberships);
  const imageAssets = copyOnWriteArray(base.imageAssets);
  const attempts = copyOnWriteArray(base.attempts);
  const notes = copyOnWriteArray(base.notes);
  const practiceRuns = copyOnWriteArray(base.practiceRuns);
  const practiceRunSources = copyOnWriteArray(base.practiceRunSources);
  const practiceRunItems = copyOnWriteArray(base.practiceRunItems);
  const questionGroups = copyOnWriteArray(base.questionGroups);
  const questionGroupItems = copyOnWriteArray(base.questionGroupItems);
  const reviewRounds = copyOnWriteArray(base.reviewRounds);
  const reviewRoundBanks = copyOnWriteArray(base.reviewRoundBanks);
  const reviewRoundItems = copyOnWriteArray(base.reviewRoundItems);
  const tombstones = copyOnWriteArray(base.tombstones);
  const state: CanonicalState = {
    banks: banks.proxy,
    bankFolders: bankFolders.proxy,
    questions: questions.proxy,
    memberships: memberships.proxy,
    imageAssets: imageAssets.proxy,
    attempts: attempts.proxy,
    notes: notes.proxy,
    practiceRuns: practiceRuns.proxy,
    practiceRunSources: practiceRunSources.proxy,
    practiceRunItems: practiceRunItems.proxy,
    questionGroups: questionGroups.proxy,
    questionGroupItems: questionGroupItems.proxy,
    reviewRounds: reviewRounds.proxy,
    reviewRoundBanks: reviewRoundBanks.proxy,
    reviewRoundItems: reviewRoundItems.proxy,
    tombstones: tombstones.proxy,
  };
  return {
    state,
    commit: () => ({
      banks: committedArray(state.banks, banks),
      bankFolders: committedArray(state.bankFolders, bankFolders),
      questions: committedArray(state.questions, questions),
      memberships: committedArray(state.memberships, memberships),
      imageAssets: committedArray(state.imageAssets, imageAssets),
      attempts: committedArray(state.attempts, attempts),
      notes: committedArray(state.notes, notes),
      practiceRuns: committedArray(state.practiceRuns, practiceRuns),
      practiceRunSources: committedArray(state.practiceRunSources, practiceRunSources),
      practiceRunItems: committedArray(state.practiceRunItems, practiceRunItems),
      questionGroups: committedArray(state.questionGroups, questionGroups),
      questionGroupItems: committedArray(state.questionGroupItems, questionGroupItems),
      reviewRounds: committedArray(state.reviewRounds, reviewRounds),
      reviewRoundBanks: committedArray(state.reviewRoundBanks, reviewRoundBanks),
      reviewRoundItems: committedArray(state.reviewRoundItems, reviewRoundItems),
      tombstones: committedArray(state.tombstones, tombstones),
    }),
  };
}
