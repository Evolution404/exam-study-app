import { sha256DigestHex } from "../crypto/sha256";
import {
  CHANGE_SET_V7_DIGEST_PATTERN,
  type ClaimedBatchV7,
  type ChangeSetDependencyV7,
  type ChangeSetEntityRefV7,
  type ChangeSetMutationV7,
  type ChangeSetPolicyV7,
  type ChangeSetPublicationStateV7,
  type ChangeSetQueueBlockerV7,
  type ChangeSetQueuePlanV7,
  type ChangeSetReplayPhaseV7,
  type ChangeSetV7,
} from "./change-set-v7-types";
import { mutationEntityRefs } from "./change-set-v7-refs";

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

async function sha256(value: Uint8Array): Promise<string> {
  return sha256DigestHex(value);
}

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

export function dependentChangeSetIdsV7(target: ChangeSetV7, queued: readonly ChangeSetV7[]): string[] {
  const dependentIds = new Set<string>();
  const provided = new Set(target.mutations.flatMap(mutationCreatedRefs).map((ref) => `${ref.type}:${ref.id}`));
  // Precompute each candidate's required refs once; `requires` depends only on
  // the candidate's own mutations, never on the rest of the queue, so we avoid
  // the O(n) conflict scan that dependenciesForChangeSetV7 would otherwise run
  // per candidate per pass (this made the UI quadratic-to-cubic as events grew).
  const requiresByCandidate = new Map(queued.map((candidate) => [candidate.id, new Set(dependenciesForChangeSetV7(candidate).requires)]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const candidate of queued) {
      if (candidate.id === target.id || dependentIds.has(candidate.id)) continue;
      if (![...requiresByCandidate.get(candidate.id)!].some((required) => provided.has(required))) continue;
      dependentIds.add(candidate.id);
      for (const mutation of candidate.mutations) {
        for (const ref of mutationCreatedRefs(mutation)) provided.add(`${ref.type}:${ref.id}`);
      }
      changed = true;
    }
  }
  return [...dependentIds].sort();
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
