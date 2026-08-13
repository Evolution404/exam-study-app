/**
 * The v7 local change-set protocol.
 *
 * Change sets are the only mutable unit that is handed to a queue/sync
 * implementation.  Their immutable content is deliberately small and
 * content-addressed: publication/claim state belongs in a queue record and
 * is never included in `digest`.
 */
import type {
  AttemptV6,
  BankFolderV6,
  BankQuestionMembership,
  BankV6,
  ImageAsset,
  NoteV6,
  PracticeRunV6,
  QuestionGroupV6,
  QuestionV6,
  ReviewRound,
} from "./v6-types";
import type { PracticeAnswerV6 } from "./db-v6";

export const CHANGE_SET_V7_FORMAT = 7 as const;
export const CHANGE_SET_V7_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type ChangeSetReplayPhaseV7 =
  | "assets"
  | "folders"
  | "banks"
  | "questions"
  | "memberships"
  | "runs"
  | "answers"
  | "annotations"
  | "deletes";

export interface ImmutablePayloadRefV7 {
  path: string;
  sha256: string;
  size: number;
  kind?: string;
}

export interface ChangeSetEntityRefV7 {
  type: string;
  id: string;
}

export type ChangeSetMutationV7 =
  | { kind: "bank.create"; bank: BankV6 }
  | { kind: "bank.update"; bank: BankV6; previous?: BankV6 }
  | { kind: "bank.reorder"; bankIds: string[]; folderId?: string; updatedAt?: string }
  | { kind: "bank.delete"; bankId: string; deletedAt?: string; cascade?: boolean }
  | { kind: "bank.delete.cascade"; bankId: string; deletedAt?: string; questionIds?: string[] }
  | { kind: "bankFolder.save"; folder: BankFolderV6 }
  | { kind: "bankFolder.delete"; folderId: string; deletedAt?: string }
  | { kind: "question.upsert"; question: QuestionV6 }
  | { kind: "question.delete"; questionId: string; deletedAt?: string; cascade?: boolean }
  | { kind: "question.delete.cascade"; questionId: string; deletedAt?: string }
  | {
      kind: "question.split";
      originalQuestionId: string;
      clone: QuestionV6;
      memberships: BankQuestionMembership[];
      deletedMembershipKeys?: string[];
      note?: NoteV6;
    }
  | {
      kind: "question.import";
      bank: BankV6;
      questions: QuestionV6[];
      memberships: BankQuestionMembership[];
      images?: ImageAsset[];
      dedupeFingerprints?: string[];
    }
  | { kind: "question.bulk.upsert"; questions: QuestionV6[] }
  | { kind: "question.bulk.delete"; questionIds: string[]; deletedAt?: string; cascade?: boolean }
  | { kind: "membership.save"; membership: BankQuestionMembership }
  | { kind: "membership.remove"; bankId: string; questionId: string; key?: string; removedAt?: string }
  | { kind: "membership.bulk.save"; memberships: BankQuestionMembership[] }
  | { kind: "membership.bulk.remove"; keys: string[]; bankId?: string; removedAt?: string }
  | { kind: "image.asset.save"; asset: Omit<ImageAsset, "blob"> }
  | { kind: "image.asset.delete"; assetId: string; deletedAt?: string }
  | { kind: "attempt.create"; attempt: AttemptV6; reviewRoundId?: string }
  | { kind: "attempt.update"; attempt: AttemptV6; reviewRoundId?: string }
  | { kind: "attempt.delete"; attemptId: string; questionId?: string; deletedAt?: string }
  | {
      kind: "practice.answer.submitted";
      attempt: AttemptV6;
      answer: PracticeAnswerV6;
      runId: string;
      questionId: string;
      reviewRoundId?: string;
    }
  | {
      kind: "practice.answer.updated";
      attempt: AttemptV6;
      answer: PracticeAnswerV6;
      runId: string;
      questionId: string;
      reviewRoundId?: string;
    }
  | { kind: "practice.answer.deleted"; attemptId: string; runId: string; questionId: string; reviewRoundId?: string; deletedAt?: string }
  | { kind: "practice.run.saved"; run: PracticeRunV6; definition?: ImmutablePayloadRefV7 }
  | { kind: "practice.run.status.changed"; run: PracticeRunV6; definition?: ImmutablePayloadRefV7 }
  | { kind: "practice.run.deleted"; runId: string; deletedAt?: string }
  | { kind: "note.upserted"; note: NoteV6 }
  | { kind: "note.deleted"; questionId: string; deletedAt?: string }
  | { kind: "questionGroup.saved"; group: QuestionGroupV6 }
  | { kind: "questionGroup.deleted"; groupId: string; deletedAt?: string }
  | { kind: "review.round.saved"; round: ReviewRound }
  | { kind: "review.round.completed"; round: ReviewRound }
  | { kind: "review.round.archived"; round: ReviewRound };

export type ChangeSetKindV7 = ChangeSetMutationV7["kind"] | "batch";

/** Immutable change-set value. `publication` is intentionally not a field. */
export interface ChangeSetV7 {
  formatVersion: typeof CHANGE_SET_V7_FORMAT;
  id: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind: ChangeSetKindV7;
  mutations: ChangeSetMutationV7[];
  entityRefs: ChangeSetEntityRefV7[];
  payloadRefs?: ImmutablePayloadRefV7[];
  digest: string;
}

export interface CreateChangeSetV7Input {
  id?: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  mutations?: readonly ChangeSetMutationV7[];
  /** Convenience for callers creating a one-mutation set. */
  mutation?: ChangeSetMutationV7;
  entityRefs?: readonly ChangeSetEntityRefV7[];
  payloadRefs?: readonly ImmutablePayloadRefV7[];
}

export interface ChangeSetPublicationStateV7 {
  state: "pending" | "claimed" | "published" | "acknowledged" | "cancelled";
  claimId?: string;
  claimedAt?: string;
  publishedAt?: string;
  acknowledgedAt?: string;
}

export interface ChangeSetPolicyV7 {
  editable: boolean;
  cancellable: boolean;
  reason?: string;
}

export interface ChangeSetDependencyV7 {
  requires: string[];
  conflicts: string[];
  phase: ChangeSetReplayPhaseV7;
}

export interface ChangeSetQueueBlockerV7 {
  changeSetId: string;
  code: "missing-dependency" | "cascade-required" | "conflict";
  message: string;
  requires?: string[];
}

export interface ChangeSetQueuePlanV7 {
  ordered: ChangeSetV7[];
  phases: Record<ChangeSetReplayPhaseV7, ChangeSetV7[]>;
  blockers: ChangeSetQueueBlockerV7[];
  digest: string;
}

export interface ClaimedBatchV7 {
  claimId: string;
  changeSetIds: string[];
  digest: string;
}

const encoder = new TextEncoder();
const phases: readonly ChangeSetReplayPhaseV7[] = ["assets", "folders", "banks", "questions", "memberships", "runs", "answers", "annotations", "deletes"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new Error(`invalid v7 change-set: ${message}`);
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) fail(`${field} must be a non-empty string`);
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} must be an integer >= ${minimum}`);
}

function assertIsoDate(value: unknown, field: string): asserts value is string {
  assertNonEmptyString(value, field);
  if (!Number.isFinite(Date.parse(value))) fail(`${field} must be an ISO timestamp`);
}

function assertDigest(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !CHANGE_SET_V7_DIGEST_PATTERN.test(value)) fail(`${field} must be a lowercase SHA-256 digest`);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

/** Stable JSON serialization. Object key order is canonical; arrays are semantic order. */
export function canonicalSerializeV7(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** Canonical immutable bytes exclude the digest and any queue publication state. */
export function canonicalChangeSetV7(changeSet: Omit<ChangeSetV7, "digest"> | ChangeSetV7): string {
  const { digest: _digest, ...content } = changeSet as ChangeSetV7;
  return canonicalSerializeV7(content);
}

async function sha256(value: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("当前环境不支持 SHA-256");
  const digest = await subtle.digest("SHA-256", new Uint8Array(value));
  return Array.from(new Uint8Array(digest), (item) => item.toString(16).padStart(2, "0")).join("");
}

function generatedId(deviceId: string, sequence: number): string {
  const random = globalThis.crypto?.randomUUID?.();
  return `${deviceId}:${sequence}:${random ?? "v7"}`;
}

function normalizeMutation(mutation: ChangeSetMutationV7): ChangeSetMutationV7 {
  const value = structuredClone(mutation) as ChangeSetMutationV7;
  if ("bankIds" in value && value.bankIds) value.bankIds = [...value.bankIds].sort();
  if ("questionIds" in value && value.questionIds) value.questionIds = [...value.questionIds].sort();
  if ("keys" in value && value.keys) value.keys = [...value.keys].sort();
  if (value.kind === "question.bulk.upsert") value.questions = [...value.questions].sort((a, b) => a.id.localeCompare(b.id));
  if (value.kind === "question.import") value.questions = [...value.questions].sort((a, b) => a.id.localeCompare(b.id));
  if ("memberships" in value && value.memberships) value.memberships = [...value.memberships].sort((a, b) => a.key.localeCompare(b.key));
  if ("images" in value && value.images) value.images = [...value.images].sort((a, b) => a.id.localeCompare(b.id));
  return value;
}

function mutationEntityRefs(mutation: ChangeSetMutationV7): ChangeSetEntityRefV7[] {
  const add = (type: string, id: string): ChangeSetEntityRefV7 => ({ type, id });
  switch (mutation.kind) {
    case "bank.create": case "bank.update": return [add("bank", mutation.bank.id)];
    case "bank.reorder": return mutation.bankIds.map((id) => add("bank", id));
    case "bank.delete": case "bank.delete.cascade": return [add("bank", mutation.bankId)];
    case "bankFolder.save": return [add("bankFolder", mutation.folder.id)];
    case "bankFolder.delete": return [add("bankFolder", mutation.folderId)];
    case "question.upsert": return [add("question", mutation.question.id), ...[...mutation.question.content, ...mutation.question.options.flat()].filter((block) => block.type === "image").map((block) => add("imageAsset", block.assetId))];
    case "question.delete": case "question.delete.cascade": return [add("question", mutation.questionId)];
    case "question.split": return [add("question", mutation.originalQuestionId), add("question", mutation.clone.id)];
    case "question.import": return [add("bank", mutation.bank.id), ...mutation.questions.map((item) => add("question", item.id)), ...mutation.memberships.map((item) => add("membership", item.key)), ...(mutation.images ?? []).map((item) => add("imageAsset", item.id))];
    case "question.bulk.upsert": return mutation.questions.map((item) => add("question", item.id));
    case "question.bulk.delete": return mutation.questionIds.map((id) => add("question", id));
    case "membership.save": return [add("membership", mutation.membership.key), add("bank", mutation.membership.bankId), add("question", mutation.membership.questionId)];
    case "membership.remove": return [add("membership", mutation.key ?? `${mutation.bankId}:${mutation.questionId}`), add("bank", mutation.bankId), add("question", mutation.questionId)];
    case "membership.bulk.save": return mutation.memberships.flatMap((item) => [add("membership", item.key), add("bank", item.bankId), add("question", item.questionId)]);
    case "membership.bulk.remove": return mutation.keys.map((id) => add("membership", id));
    case "image.asset.save": return [add("imageAsset", mutation.asset.id)];
    case "image.asset.delete": return [add("imageAsset", mutation.assetId)];
    case "attempt.create": case "attempt.update": return [add("attempt", mutation.attempt.id), add("question", mutation.attempt.questionId)];
    case "attempt.delete": return [add("attempt", mutation.attemptId)];
    case "practice.answer.submitted": case "practice.answer.updated": return [add("attempt", mutation.attempt.id), add("practiceRun", mutation.runId), add("question", mutation.questionId)];
    case "practice.answer.deleted": return [add("attempt", mutation.attemptId), add("practiceRun", mutation.runId), add("question", mutation.questionId)];
    case "practice.run.saved": case "practice.run.status.changed": return [add("practiceRun", mutation.run.id), ...runRefs(mutation.run)];
    case "practice.run.deleted": return [add("practiceRun", mutation.runId)];
    case "note.upserted": return [add("note", mutation.note.questionId), add("question", mutation.note.questionId)];
    case "note.deleted": return [add("note", mutation.questionId), add("question", mutation.questionId)];
    case "questionGroup.saved": return [add("questionGroup", mutation.group.id)];
    case "questionGroup.deleted": return [add("questionGroup", mutation.groupId)];
    case "review.round.saved": case "review.round.completed": case "review.round.archived": return [add("reviewRound", mutation.round.id), ...mutation.round.bankIds.map((id) => add("bank", id))];
  }
}

function runRefs(run: PracticeRunV6): ChangeSetEntityRefV7[] {
  return [...new Set([...(run.bankIds ?? []), run.bankId])].filter(Boolean).map((id) => ({ type: "bank", id }))
    .concat(run.questionIds.map((id) => ({ type: "question", id })));
}

const mutationKindsV7 = new Set<ChangeSetKindV7>([
  "bank.create", "bank.update", "bank.reorder", "bank.delete", "bank.delete.cascade",
  "bankFolder.save", "bankFolder.delete", "question.upsert", "question.delete", "question.delete.cascade",
  "question.split", "question.import", "question.bulk.upsert", "question.bulk.delete", "membership.save",
  "membership.remove", "membership.bulk.save", "membership.bulk.remove", "image.asset.save", "image.asset.delete",
  "attempt.create", "attempt.update", "attempt.delete", "practice.answer.submitted", "practice.answer.updated",
  "practice.answer.deleted", "practice.run.saved", "practice.run.status.changed", "practice.run.deleted",
  "note.upserted", "note.deleted", "questionGroup.saved", "questionGroup.deleted", "review.round.saved",
  "review.round.completed", "review.round.archived",
]);

function validateMutationShapeV7(value: Record<string, unknown>): value is ChangeSetMutationV7 {
  if (typeof value.kind !== "string" || !mutationKindsV7.has(value.kind as ChangeSetKindV7)) return false;
  const requiresObject = ["bank", "folder", "question", "clone", "membership", "attempt", "answer", "run", "note", "group", "round", "asset"];
  for (const field of requiresObject) {
    if (field in value && !isRecord(value[field])) return false;
  }
  const requiresId = ["bankId", "folderId", "questionId", "originalQuestionId", "assetId", "attemptId", "runId", "groupId"];
  for (const field of requiresId) {
    if (field in value && (typeof value[field] !== "string" || !(value[field] as string).trim())) return false;
  }
  for (const field of ["bankIds", "questionIds", "keys", "questions", "memberships", "images"]) {
    if (field in value && !Array.isArray(value[field])) return false;
  }
  return true;
}

/** Construct a fully validated, digest-bearing immutable change set. */
export async function createChangeSetV7(input: CreateChangeSetV7Input): Promise<ChangeSetV7> {
  if (!isRecord(input)) fail("input must be an object");
  assertNonEmptyString(input.deviceId, "deviceId");
  assertSafeInteger(input.localSequence, "localSequence", 0);
  assertIsoDate(input.createdAt, "createdAt");
  const rawMutations = input.mutations ?? (input.mutation ? [input.mutation] : []);
  if (!rawMutations.length) fail("mutations must contain at least one mutation");
  const mutations = rawMutations.map(normalizeMutation);
  const inferredRefs = mutations.flatMap(mutationEntityRefs);
  const entityRefs = (input.entityRefs ? [...input.entityRefs] : inferredRefs)
    .map((ref, index) => {
      if (!isRecord(ref)) fail(`entityRefs[${index}] must be an object`);
      assertNonEmptyString(ref.type, `entityRefs[${index}].type`);
      assertNonEmptyString(ref.id, `entityRefs[${index}].id`);
      return { type: ref.type.trim(), id: ref.id.trim() };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
  const payloadRefs = input.payloadRefs?.map((ref, index) => {
    if (!isRecord(ref)) fail(`payloadRefs[${index}] must be an object`);
    assertNonEmptyString(ref.path, `payloadRefs[${index}].path`);
    assertDigest(ref.sha256, `payloadRefs[${index}].sha256`);
    assertSafeInteger(ref.size, `payloadRefs[${index}].size`, 0);
    return { path: ref.path, sha256: ref.sha256, size: ref.size, ...(ref.kind ? { kind: ref.kind } : {}) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const base = {
    formatVersion: CHANGE_SET_V7_FORMAT,
    id: input.id?.trim() || generatedId(input.deviceId, input.localSequence),
    deviceId: input.deviceId.trim(),
    localSequence: input.localSequence,
    createdAt: new Date(input.createdAt).toISOString(),
    kind: mutations.length === 1 ? mutations[0].kind : "batch",
    mutations,
    entityRefs,
    ...(payloadRefs?.length ? { payloadRefs } : {}),
  } as Omit<ChangeSetV7, "digest">;
  assertNonEmptyString(base.id, "id");
  const digest = await sha256(encoder.encode(canonicalChangeSetV7(base)));
  return { ...base, digest };
}

/** Runtime structural validation; digest recomputation is available separately. */
export function validateChangeSetV7(value: unknown): value is ChangeSetV7 {
  try {
    if (!isRecord(value)) return false;
    if (value.formatVersion !== CHANGE_SET_V7_FORMAT) return false;
    assertNonEmptyString(value.id, "id");
    assertNonEmptyString(value.deviceId, "deviceId");
    assertSafeInteger(value.localSequence, "localSequence", 0);
    assertIsoDate(value.createdAt, "createdAt");
    if (typeof value.kind !== "string" || !Array.isArray(value.mutations) || value.mutations.length === 0) return false;
    if ((value.kind === "batch") !== (value.mutations.length > 1)) return false;
    if (value.kind !== "batch" && value.kind !== (value.mutations[0] as ChangeSetMutationV7).kind) return false;
    value.mutations.forEach((mutation, index) => {
      if (!isRecord(mutation) || typeof mutation.kind !== "string" || !validateMutationShapeV7(mutation)) fail(`mutations[${index}] is invalid`);
    });
    if (!Array.isArray(value.entityRefs)) return false;
    value.entityRefs.forEach((ref, index) => {
      if (!isRecord(ref)) fail(`entityRefs[${index}] must be an object`);
      assertNonEmptyString(ref.type, `entityRefs[${index}].type`);
      assertNonEmptyString(ref.id, `entityRefs[${index}].id`);
    });
    if (value.payloadRefs !== undefined) {
      if (!Array.isArray(value.payloadRefs)) return false;
      value.payloadRefs.forEach((ref, index) => {
        if (!isRecord(ref)) fail(`payloadRefs[${index}] must be an object`);
        assertNonEmptyString(ref.path, `payloadRefs[${index}].path`);
        assertDigest(ref.sha256, `payloadRefs[${index}].sha256`);
        assertSafeInteger(ref.size, `payloadRefs[${index}].size`, 0);
      });
    }
    assertDigest(value.digest, "digest");
    return true;
  } catch {
    return false;
  }
}

export function assertChangeSetV7(value: unknown): asserts value is ChangeSetV7 {
  if (!validateChangeSetV7(value)) fail("value does not satisfy the v7 change-set schema");
}

export async function digestChangeSetV7(value: Omit<ChangeSetV7, "digest"> | ChangeSetV7): Promise<string> {
  return sha256(encoder.encode(canonicalChangeSetV7(value)));
}

export async function verifyChangeSetDigestV7(value: unknown): Promise<boolean> {
  if (!validateChangeSetV7(value)) return false;
  return (await digestChangeSetV7(value)) === value.digest;
}

export const isChangeSetV7 = validateChangeSetV7;
export const serializeChangeSetV7 = canonicalChangeSetV7;

export function summarizeChangeSetV7(changeSet: ChangeSetV7): string {
  const mutation = changeSet.mutations[0];
  if (changeSet.mutations.length > 1) return `批量操作 ${changeSet.mutations.length} 项：${summarizeMutationV7(mutation)}`;
  return summarizeMutationV7(mutation);
}

function summarizeMutationV7(mutation: ChangeSetMutationV7): string {
  switch (mutation.kind) {
    case "bank.create": return `创建题库“${mutation.bank.name}”`;
    case "bank.update": return `更新题库“${mutation.bank.name}”`;
    case "bank.reorder": return `重新排序 ${mutation.bankIds.length} 个题库`;
    case "bank.delete": case "bank.delete.cascade": return `删除题库 ${mutation.bankId}`;
    case "bankFolder.save": return `保存题库文件夹“${mutation.folder.name}”`;
    case "bankFolder.delete": return `删除题库文件夹 ${mutation.folderId}`;
    case "question.upsert": return `保存题目 ${mutation.question.id}`;
    case "question.delete": case "question.delete.cascade": return `删除题目 ${mutation.questionId}`;
    case "question.split": return `分裂题目 ${mutation.originalQuestionId}`;
    case "question.import": return `导入 ${mutation.questions.length} 道题目到“${mutation.bank.name}”`;
    case "question.bulk.upsert": return `批量保存 ${mutation.questions.length} 道题目`;
    case "question.bulk.delete": return `批量删除 ${mutation.questionIds.length} 道题目`;
    case "membership.save": return `加入题库 ${mutation.membership.bankId}`;
    case "membership.remove": return `从题库移除 ${mutation.key ?? `${mutation.bankId}:${mutation.questionId}`}`;
    case "membership.bulk.save": return `批量加入 ${mutation.memberships.length} 条题库关系`;
    case "membership.bulk.remove": return `批量移除 ${mutation.keys.length} 条题库关系`;
    case "image.asset.save": return `保存图片资产 ${mutation.asset.id}`;
    case "image.asset.delete": return `删除图片资产 ${mutation.assetId}`;
    case "attempt.create": case "attempt.update": return `保存作答记录 ${mutation.attempt.id}`;
    case "attempt.delete": return `删除作答记录 ${mutation.attemptId}`;
    case "practice.answer.submitted": return `提交练习答案 ${mutation.questionId}`;
    case "practice.answer.updated": return `修改练习答案 ${mutation.questionId}`;
    case "practice.answer.deleted": return `删除练习答案 ${mutation.questionId}`;
    case "practice.run.saved": case "practice.run.status.changed": return `保存练习 ${mutation.run.id}`;
    case "practice.run.deleted": return `删除练习 ${mutation.runId}`;
    case "note.upserted": return `保存解析 ${mutation.note.questionId}`;
    case "note.deleted": return `删除解析 ${mutation.questionId}`;
    case "questionGroup.saved": return `保存题组“${mutation.group.name}”`;
    case "questionGroup.deleted": return `删除题组 ${mutation.groupId}`;
    case "review.round.saved": return `保存复习轮次“${mutation.round.name}”`;
    case "review.round.completed": return `完成复习轮次“${mutation.round.name}”`;
    case "review.round.archived": return `归档复习轮次“${mutation.round.name}”`;
  }
}

export function replayPhaseForMutationV7(mutation: ChangeSetMutationV7): ChangeSetReplayPhaseV7 {
  if (mutation.kind.startsWith("image.asset")) return "assets";
  if (mutation.kind.startsWith("bankFolder")) return "folders";
  if (mutation.kind.startsWith("bank.")) return mutation.kind.includes("delete") ? "deletes" : "banks";
  if (mutation.kind.startsWith("question.") && mutation.kind.includes("delete")) return "deletes";
  if (mutation.kind.startsWith("question.")) return "questions";
  if (mutation.kind.startsWith("membership.")) return "memberships";
  if (mutation.kind.startsWith("practice.answer") || mutation.kind.startsWith("attempt.")) return "answers";
  if (mutation.kind.startsWith("practice.run")) return mutation.kind.endsWith("deleted") ? "deletes" : "runs";
  return "annotations";
}

function refsFor(mutation: ChangeSetMutationV7, type: string): string[] {
  return mutationEntityRefs(mutation).filter((ref) => ref.type === type).map((ref) => ref.id);
}

/** Static dependency/conflict metadata used by queue planning. */
export function dependenciesForChangeSetV7(changeSet: ChangeSetV7, queued: readonly ChangeSetV7[] = []): ChangeSetDependencyV7 {
  const mutations = changeSet.mutations;
  const requires = new Set<string>();
  const conflicts = new Set<string>();
  for (const mutation of mutations) {
    const ids = (type: string) => refsFor(mutation, type);
    if (mutation.kind.startsWith("membership.")) {
      for (const id of ids("bank")) requires.add(`bank:${id}`);
      for (const id of ids("question")) requires.add(`question:${id}`);
    }
    if (mutation.kind === "question.upsert") {
      for (const id of ids("imageAsset")) requires.add(`imageAsset:${id}`);
    }
    if (mutation.kind === "question.import") {
      for (const id of ids("imageAsset")) requires.add(`imageAsset:${id}`);
    }
    if (mutation.kind.startsWith("question.") && mutation.kind !== "question.import") {
      if ("question" in mutation) for (const id of ids("question")) requires.add(`question:${id}`);
    }
    if (mutation.kind.startsWith("practice.answer") || mutation.kind.startsWith("practice.run")) {
      for (const id of ids("practiceRun")) requires.add(`practiceRun:${id}`);
      for (const id of ids("bank")) requires.add(`bank:${id}`);
      for (const id of ids("question")) requires.add(`question:${id}`);
    }
    if (mutation.kind.startsWith("review.round")) for (const id of ids("bank")) requires.add(`bank:${id}`);
    if (mutation.kind.startsWith("note.")) for (const id of ids("question")) requires.add(`question:${id}`);
    if (mutation.kind.startsWith("questionGroup.")) for (const id of ids("question")) requires.add(`question:${id}`);
  }
  for (const other of queued) {
    if (other.id === changeSet.id) continue;
    const shared = mutations.some((mutation) => mutationEntityRefs(mutation).some((left) => other.mutations.some((otherMutation) => mutationEntityRefs(otherMutation).some((right) => left.type === right.type && left.id === right.id))));
    if (shared) conflicts.add(other.id);
  }
  const mutationPhases = mutations.map(replayPhaseForMutationV7);
  const phase = phases.find((candidate) => mutationPhases.includes(candidate)) ?? "annotations";
  return { requires: [...requires].sort(), conflicts: [...conflicts].sort(), phase };
}

export const getChangeSetDependenciesV7 = dependenciesForChangeSetV7;

export function policyForChangeSetV7(changeSet: ChangeSetV7, publication: ChangeSetPublicationStateV7 = { state: "pending" }): ChangeSetPolicyV7 {
  void changeSet;
  const editable = publication.state === "pending";
  const cancellable = publication.state === "pending" || publication.state === "claimed";
  return { editable, cancellable, ...(!editable ? { reason: "已发布的 change-set 内容不可编辑" } : cancellable ? {} : { reason: "change-set 已确认，不能取消" }) };
}

export const canEditChangeSetV7 = (changeSet: ChangeSetV7, publication?: ChangeSetPublicationStateV7): boolean => policyForChangeSetV7(changeSet, publication).editable;
export const canCancelChangeSetV7 = (changeSet: ChangeSetV7, publication?: ChangeSetPublicationStateV7): boolean => policyForChangeSetV7(changeSet, publication).cancellable;

function compareChangeSets(a: ChangeSetV7, b: ChangeSetV7): number {
  return a.localSequence - b.localSequence || a.createdAt.localeCompare(b.createdAt) || a.deviceId.localeCompare(b.deviceId) || a.id.localeCompare(b.id);
}

export async function digestChangeSetBatchV7(changeSets: readonly ChangeSetV7[]): Promise<string> {
  const ordered = [...changeSets].sort(compareChangeSets).map((item) => item.digest);
  return sha256(encoder.encode(JSON.stringify(ordered)));
}

function mutationCreatedRefs(mutation: ChangeSetMutationV7): ChangeSetEntityRefV7[] {
  switch (mutation.kind) {
    case "bank.create": return [{ type: "bank", id: mutation.bank.id }];
    case "bankFolder.save": return [{ type: "bankFolder", id: mutation.folder.id }];
    case "question.upsert": return [{ type: "question", id: mutation.question.id }];
    case "question.import": return [{ type: "bank", id: mutation.bank.id }, ...mutation.questions.map((item) => ({ type: "question", id: item.id })), ...mutation.memberships.map((item) => ({ type: "membership", id: item.key })), ...(mutation.images ?? []).map((item) => ({ type: "imageAsset", id: item.id }))];
    case "question.bulk.upsert": return mutation.questions.map((item) => ({ type: "question", id: item.id }));
    case "membership.save": return [{ type: "membership", id: mutation.membership.key }];
    case "membership.bulk.save": return mutation.memberships.map((item) => ({ type: "membership", id: item.key }));
    case "image.asset.save": return [{ type: "imageAsset", id: mutation.asset.id }];
    case "attempt.create": return [{ type: "attempt", id: mutation.attempt.id }];
    case "practice.answer.submitted": return [{ type: "attempt", id: mutation.attempt.id }];
    case "practice.run.saved": return [{ type: "practiceRun", id: mutation.run.id }];
    case "note.upserted": return [{ type: "note", id: mutation.note.questionId }];
    case "questionGroup.saved": return [{ type: "questionGroup", id: mutation.group.id }];
    case "review.round.saved": return [{ type: "reviewRound", id: mutation.round.id }];
    default: return [];
  }
}

export async function planChangeSetQueueV7(changeSets: readonly ChangeSetV7[], existingEntityRefs: readonly ChangeSetEntityRefV7[] = []): Promise<ChangeSetQueuePlanV7> {
  const ordered = [...changeSets].sort(compareChangeSets);
  const known = new Set(existingEntityRefs.map((ref) => `${ref.type}:${ref.id}`));
  for (const item of ordered) for (const mutation of item.mutations) for (const ref of mutationCreatedRefs(mutation)) {
    known.add(`${ref.type}:${ref.id}`);
  }
  const blockers: ChangeSetQueueBlockerV7[] = [];
  for (const item of ordered) {
    const dependency = dependenciesForChangeSetV7(item, ordered);
    const missing = dependency.requires.filter((required) => !known.has(required) && !ordered.some((candidate) => candidate.mutations.some((mutation) => mutationCreatedRefs(mutation).some((ref) => `${ref.type}:${ref.id}` === required))));
    if (missing.length) blockers.push({ changeSetId: item.id, code: "missing-dependency", message: `依赖不存在：${missing.join(", ")}`, requires: missing });
    for (const mutation of item.mutations) {
      if ((mutation.kind === "bank.delete" || mutation.kind === "question.delete" || mutation.kind === "question.bulk.delete") && !mutation.cascade) {
        blockers.push({ changeSetId: item.id, code: "cascade-required", message: "删除仍有潜在关联，必须显式选择 cascade" });
      }
    }
  }
  const phaseMap = Object.fromEntries(phases.map((phase) => [phase, [] as ChangeSetV7[]])) as Record<ChangeSetReplayPhaseV7, ChangeSetV7[]>;
  for (const item of ordered) phaseMap[dependenciesForChangeSetV7(item).phase].push(item);
  const phaseOrdered = phases.flatMap((phase) => phaseMap[phase]);
  return { ordered: phaseOrdered, phases: phaseMap, blockers, digest: await digestChangeSetBatchV7(phaseOrdered) };
}

export const buildChangeSetQueuePlanV7 = planChangeSetQueueV7;

export async function createClaimedBatchV7(claimId: string, changeSets: readonly ChangeSetV7[]): Promise<ClaimedBatchV7> {
  assertNonEmptyString(claimId, "claimId");
  const ordered = [...changeSets].sort(compareChangeSets);
  return { claimId, changeSetIds: ordered.map((item) => item.id), digest: await digestChangeSetBatchV7(ordered) };
}

export async function verifyClaimedBatchDigestV7(claim: ClaimedBatchV7, changeSets: readonly ChangeSetV7[]): Promise<boolean> {
  if (!isRecord(claim) || typeof claim.claimId !== "string" || !Array.isArray(claim.changeSetIds) || !CHANGE_SET_V7_DIGEST_PATTERN.test(claim.digest)) return false;
  const byId = new Map(changeSets.map((item) => [item.id, item]));
  const selected = claim.changeSetIds.map((id) => byId.get(id));
  if (selected.some((item): item is undefined => !item) || selected.length !== new Set(claim.changeSetIds).size) return false;
  return (await digestChangeSetBatchV7(selected as ChangeSetV7[])) === claim.digest;
}

export async function assertClaimedBatchDigestV7(claim: ClaimedBatchV7, changeSets: readonly ChangeSetV7[]): Promise<void> {
  if (!await verifyClaimedBatchDigestV7(claim, changeSets)) throw new Error("v7 claim acknowledgement digest mismatch");
}

export const checkClaimedBatchDigestV7 = verifyClaimedBatchDigestV7;
