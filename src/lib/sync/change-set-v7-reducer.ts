/**
 * Event reducer and batch replay for the pure v7 projection.  The reducer
 * intentionally has no Dexie or browser dependencies: callers can validate and
 * persist its returned value in one transaction.  A failed mutation throws
 * before the new projection is returned, so a change-set is atomic even when
 * it contains many mutations.
 */
import { type ChangeSetMutationV7, type ChangeSetV7 } from "./change-set-v7-types";
import { assertChangeSetV7 } from "./change-set-v7-codec";
import {
  byId,
  clone,
  ensureAsset,
  ensureBank,
  ensureFolder,
  ensureQuestion,
  ensureRun,
  ensureRound,
  fail,
  membershipKey,
  normalizeProjection,
  putTombstone,
  rejectTombstoned,
  removeAttemptRound,
  removeById,
  removeMembership,
  removeTombstone,
  requireById,
  runBankIds,
  runWithAnswer,
  setById,
  setByKey,
  setByQuestionId,
  shallowEnvelope,
  uniqueStrings,
  upsertAttemptRound,
  type ChangeSetProjectionInputV7,
  type ChangeSetProjectionV7,
} from "./change-set-v7-projection-core";
import {
  updateQuestionDeleteCascade,
  updateQuestionsBulkDeleteCascade,
} from "./change-set-v7-cascade";
import {
  projectionValidationIssuesV7,
  recomputeProjectionInPlace,
} from "./change-set-v7-derived";

function applyMutation(projection: ChangeSetProjectionV7, mutation: ChangeSetMutationV7, context: { createdAt: string; deviceId: string; eventId: string; localSequence: number }): void {
  switch (mutation.kind) {
    case "bank.create":
      rejectTombstoned(projection, "bank", mutation.bank.id);
      if (byId(projection.banks, mutation.bank.id)) fail(`题库 ${mutation.bank.id} 已存在`);
      if (mutation.bank.folderId) ensureFolder(projection, mutation.bank.folderId);
      projection.banks.push(clone(mutation.bank));
      return;
    case "bank.update":
      ensureBank(projection, mutation.bank.id);
      if (mutation.bank.folderId) ensureFolder(projection, mutation.bank.folderId);
      setById(projection.banks, mutation.bank, false);
      return;
    case "bank.reorder": {
      const ids = uniqueStrings(mutation.bankIds);
      if (ids.length !== mutation.bankIds.length) fail("题库排序包含重复 id");
      ids.forEach((id) => ensureBank(projection, id));
      ids.forEach((id, index) => {
        const bank = ensureBank(projection, id);
        setById(projection.banks, { ...bank, sortOrder: index, ...(mutation.folderId !== undefined ? { folderId: mutation.folderId } : {}), ...(mutation.updatedAt ? { updatedAt: mutation.updatedAt } : {}) }, false);
      });
      return;
    }
    case "bank.delete": case "bank.delete.cascade": {
      const bank = ensureBank(projection, mutation.bankId);
      const related = projection.memberships.filter((membership) => membership.bankId === bank.id);
      if (related.length && mutation.kind === "bank.delete" && !mutation.cascade) fail(`题库 ${bank.id} 仍有题目关系，必须 cascade 删除`);
      projection.memberships = projection.memberships.filter((membership) => membership.bankId !== bank.id);
      projection.banks = projection.banks.filter((item) => item.id !== bank.id);
      // A run that targets this bank can no longer be represented once the bank
      // is gone; drop it so the checkpoint never references a dangling bank.
      const deletedAt = mutation.deletedAt ?? context.createdAt;
      for (const run of projection.practiceRuns.filter((run) => runBankIds(run).includes(bank.id))) {
        putTombstone(projection, "practiceRun", run.id, deletedAt, context.deviceId, context.eventId, context.localSequence);
      }
      projection.practiceRuns = projection.practiceRuns.filter((run) => !runBankIds(run).includes(bank.id));
      putTombstone(projection, "bank", bank.id, deletedAt, context.deviceId, context.eventId, context.localSequence);
      return;
    }
    case "bankFolder.save":
      rejectTombstoned(projection, "bankFolder", mutation.folder.id);
      setById(projection.bankFolders, mutation.folder);
      removeTombstone(projection, "bankFolder", mutation.folder.id);
      return;
    case "bankFolder.delete": {
      ensureFolder(projection, mutation.folderId);
      if (projection.banks.some((bank) => bank.folderId === mutation.folderId)) fail(`文件夹 ${mutation.folderId} 仍被题库使用`);
      projection.bankFolders = projection.bankFolders.filter((folder) => folder.id !== mutation.folderId);
      putTombstone(projection, "bankFolder", mutation.folderId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    }
    case "question.upsert":
      rejectTombstoned(projection, "question", mutation.question.id);
      for (const block of [...mutation.question.content, ...mutation.question.options.flat()]) if (block.type === "image") ensureAsset(projection, block.assetId);
      setById(projection.questions, mutation.question);
      removeTombstone(projection, "question", mutation.question.id);
      return;
    case "question.delete": case "question.delete.cascade": {
      const question = ensureQuestion(projection, mutation.questionId);
      const hasDependencies = projection.memberships.some((item) => item.questionId === question.id)
        || projection.attempts.some((item) => item.questionId === question.id)
        || projection.notes.some((item) => item.questionId === question.id)
        || projection.practiceRuns.some((run) => run.questionIds.includes(question.id))
        || projection.reviewRoundProgress.some((item) => item.questionId === question.id)
        || projection.questionGroups.some((item) => item.items.some((entry) => entry.questionId === question.id));
      if (mutation.kind === "question.delete" && hasDependencies && !mutation.cascade) fail(`题目 ${question.id} 仍有学习记录或关联，必须 cascade 删除`);
      updateQuestionDeleteCascade(projection, question.id, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    }
    case "question.split": {
      ensureQuestion(projection, mutation.originalQuestionId);
      rejectTombstoned(projection, "question", mutation.clone.id);
      if (byId(projection.questions, mutation.clone.id)) fail(`分裂目标题目 ${mutation.clone.id} 已存在`);
      for (const membership of mutation.memberships) {
        ensureBank(projection, membership.bankId);
        if (membership.questionId !== mutation.clone.id) fail(`分裂关系 ${membership.key} 未指向 clone`);
      }
      for (const key of mutation.deletedMembershipKeys ?? []) {
        removeMembership(projection, key);
        putTombstone(projection, "membership", key, context.createdAt, context.deviceId, context.eventId, context.localSequence);
      }
      projection.questions.push(clone(mutation.clone));
      for (const membership of mutation.memberships) {
        if (projection.memberships.some((item) => item.key === membership.key)) fail(`题库关系 ${membership.key} 已存在`);
        projection.memberships.push(clone(membership));
      }
      if (mutation.note) setByQuestionId(projection.notes, mutation.note);
      return;
    }
    case "question.import": {
      rejectTombstoned(projection, "bank", mutation.bank.id);
      const existingBank = byId(projection.banks, mutation.bank.id);
      if (existingBank) setById(projection.banks, mutation.bank, false);
      else projection.banks.push(clone(mutation.bank));
      for (const asset of mutation.images ?? []) applyMutation(projection, { kind: "image.asset.save", asset }, context);
      const seen = new Set<string>();
      for (const question of mutation.questions) {
        if (seen.has(question.id)) fail(`导入题目 ${question.id} 重复`);
        seen.add(question.id);
        rejectTombstoned(projection, "question", question.id);
        const existing = byId(projection.questions, question.id);
        if (existing && existing.contentFingerprint !== question.contentFingerprint) fail(`导入题目 ${question.id} 与现有内容冲突`);
        if (!existing) projection.questions.push(clone(question));
      }
      for (const membership of mutation.memberships) {
        ensureQuestion(projection, membership.questionId);
        ensureBank(projection, membership.bankId);
        if (membership.key !== membershipKey(membership.bankId, membership.questionId)) fail(`导入关系 ${membership.key} 不是 canonical key`);
        setByKey(projection.memberships, membership);
        removeTombstone(projection, "membership", membership.key);
      }
      return;
    }
    case "question.bulk.upsert":
      for (const question of mutation.questions) applyMutation(projection, { kind: "question.upsert", question }, context);
      return;
    case "question.bulk.delete":
      if (!mutation.cascade) {
        // 保留单题删除的非级联语义：仍有依赖时必须显式 cascade（生产端总是 cascade）。
        for (const questionId of mutation.questionIds) applyMutation(projection, { kind: "question.delete", questionId, deletedAt: mutation.deletedAt, cascade: mutation.cascade }, context);
        return;
      }
      updateQuestionsBulkDeleteCascade(projection, mutation.questionIds, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    case "membership.save": {
      rejectTombstoned(projection, "membership", mutation.membership.key);
      ensureBank(projection, mutation.membership.bankId);
      ensureQuestion(projection, mutation.membership.questionId);
      const canonical = membershipKey(mutation.membership.bankId, mutation.membership.questionId);
      if (canonical !== mutation.membership.key) fail(`题库关系 key ${mutation.membership.key} 不是 canonical key`);
      setByKey(projection.memberships, mutation.membership);
      removeTombstone(projection, "membership", mutation.membership.key);
      return;
    }
    case "membership.remove": {
      const key = mutation.key ?? membershipKey(mutation.bankId, mutation.questionId);
      const current = removeMembership(projection, key);
      if (current.bankId !== mutation.bankId || current.questionId !== mutation.questionId) fail(`题库关系 ${key} 与目标不一致`);
      putTombstone(projection, "membership", key, mutation.removedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    }
    case "membership.bulk.save": for (const membership of mutation.memberships) applyMutation(projection, { kind: "membership.save", membership }, context); return;
    case "membership.bulk.remove": for (const key of mutation.keys) {
      const current = projection.memberships.find((item) => item.key === key);
      if (!current) fail(`题库关系 ${key} 不存在`);
      applyMutation(projection, { kind: "membership.remove", bankId: current.bankId, questionId: current.questionId, key, removedAt: mutation.removedAt }, context);
    } return;
    case "image.asset.save": {
      rejectTombstoned(projection, "imageAsset", mutation.asset.id);
      const old = projection.imageAssets.find((asset) => asset.id === mutation.asset.id);
      if (old && JSON.stringify({ ...old, blob: undefined }) !== JSON.stringify(mutation.asset)) fail(`图片资产 ${mutation.asset.id} 不可变内容冲突`);
      if (!old) projection.imageAssets.push(clone(mutation.asset));
      return;
    }
    case "image.asset.delete": {
      ensureAsset(projection, mutation.assetId);
      if (projection.questions.some((question) => [...question.content, ...question.options.flat()].some((block) => block.type === "image" && block.assetId === mutation.assetId))) fail(`图片资产 ${mutation.assetId} 仍被题目引用`);
      projection.imageAssets = projection.imageAssets.filter((asset) => asset.id !== mutation.assetId);
      putTombstone(projection, "imageAsset", mutation.assetId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    }
    case "attempt.create": case "attempt.update": {
      ensureQuestion(projection, mutation.attempt.questionId);
      if (mutation.kind === "attempt.create") rejectTombstoned(projection, "attempt", mutation.attempt.id);
      if (mutation.attempt.elapsedMs < 0) fail("elapsedMs 不能为负数");
      if (mutation.kind === "attempt.create" && byId(projection.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 已存在`);
      if (mutation.kind === "attempt.update" && !byId(projection.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 不存在`);
      setById(projection.attempts, mutation.attempt, mutation.kind === "attempt.create");
      upsertAttemptRound(projection, mutation.attempt.id, mutation.reviewRoundId);
      return;
    }
    case "attempt.delete": {
      const attempt = requireById(projection.attempts, mutation.attemptId, "作答");
      if (mutation.questionId && mutation.questionId !== attempt.questionId) fail("删除作答 questionId 不一致");
      removeById(projection.attempts, mutation.attemptId, "作答");
      removeAttemptRound(projection, mutation.attemptId);
      putTombstone(projection, "attempt", mutation.attemptId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    }
    case "practice.answer.submitted": case "practice.answer.updated": {
      const run = ensureRun(projection, mutation.runId);
      ensureQuestion(projection, mutation.questionId);
      if (mutation.kind === "practice.answer.submitted") rejectTombstoned(projection, "attempt", mutation.attempt.id);
      if (mutation.attempt.runId !== mutation.runId || mutation.attempt.questionId !== mutation.questionId) fail("答案作答记录与 run/question 不一致");
      if (mutation.kind === "practice.answer.submitted" && byId(projection.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 已存在，提交必须使用新 id`);
      if (mutation.kind === "practice.answer.updated" && !byId(projection.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 不存在`);
      setById(projection.attempts, mutation.attempt, mutation.kind === "practice.answer.submitted");
      upsertAttemptRound(projection, mutation.attempt.id, mutation.reviewRoundId ?? run.reviewRoundId);
      setById(projection.practiceRuns, runWithAnswer(run, mutation.questionId, mutation.answer), false);
      return;
    }
    case "practice.answer.deleted": {
      const run = ensureRun(projection, mutation.runId);
      const attempt = requireById(projection.attempts, mutation.attemptId, "作答");
      if (attempt.runId !== mutation.runId || attempt.questionId !== mutation.questionId) fail("答案删除目标不一致");
      removeById(projection.attempts, mutation.attemptId, "作答");
      removeAttemptRound(projection, mutation.attemptId);
      putTombstone(projection, "attempt", mutation.attemptId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      const answers = { ...run.answers };
      delete answers[mutation.questionId];
      setById(projection.practiceRuns, { ...run, answers, updatedAt: mutation.deletedAt ?? context.createdAt }, false);
      return;
    }
    case "practice.run.saved":
      rejectTombstoned(projection, "practiceRun", mutation.run.id);
      for (const bankId of runBankIds(mutation.run)) ensureBank(projection, bankId);
      for (const questionId of mutation.run.questionIds) ensureQuestion(projection, questionId);
      if (mutation.run.reviewRoundId) ensureRound(projection, mutation.run.reviewRoundId);
      setById(projection.practiceRuns, mutation.run);
      return;
    case "practice.run.status.changed":
      ensureRun(projection, mutation.run.id);
      setById(projection.practiceRuns, mutation.run, false);
      return;
    case "practice.run.deleted":
      removeById(projection.practiceRuns, mutation.runId, "练习");
      putTombstone(projection, "practiceRun", mutation.runId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    case "note.upserted":
      rejectTombstoned(projection, "note", mutation.note.questionId);
      ensureQuestion(projection, mutation.note.questionId);
      setByQuestionId(projection.notes, mutation.note);
      return;
    case "note.deleted":
      ensureQuestion(projection, mutation.questionId);
      if (!projection.notes.some((note) => note.questionId === mutation.questionId)) fail(`解析 ${mutation.questionId} 不存在`);
      projection.notes = projection.notes.filter((note) => note.questionId !== mutation.questionId);
      putTombstone(projection, "note", mutation.questionId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    case "questionGroup.saved":
      rejectTombstoned(projection, "questionGroup", mutation.group.id);
      mutation.group.items.forEach((item) => ensureQuestion(projection, item.questionId));
      setById(projection.questionGroups, mutation.group);
      return;
    case "questionGroup.deleted":
      removeById(projection.questionGroups, mutation.groupId, "题组");
      // 写墓碑，使后续到达的陈旧 questionGroup.saved 被 rejectTombstoned 拦截（题组不可复活，
      // 与题库/资产一致）。此前只 removeById 不写墓碑，导致远端 replay 后 saved 仍能重建组。
      putTombstone(projection, "questionGroup", mutation.groupId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return;
    case "review.round.saved":
      mutation.round.bankIds.forEach((bankId) => ensureBank(projection, bankId));
      setById(projection.reviewRounds, mutation.round);
      return;
    case "review.round.completed": case "review.round.archived": {
      const current = ensureRound(projection, mutation.round.id);
      if (mutation.kind === "review.round.completed" && current.status !== "active") fail(`轮次 ${current.id} 不是进行中状态`);
      setById(projection.reviewRounds, mutation.round, false);
      return;
    }
  }
}

/** Apply one change-set onto a caller-owned projection through a shallow
 *  envelope (rollback = discard the envelope; the input projection is never
 *  observably mutated).  Throws on any failed mutation BEFORE returning, so a
 *  change-set stays atomic even when it contains many mutations.  Derived
 *  tables are NOT recomputed here — chains should recompute + validate exactly
 *  once via finalizeRebasedProjectionV7 instead of per record. */
export function applyChangeSetToOwnedProjectionV7(projection: ChangeSetProjectionV7, changeSet: ChangeSetV7): ChangeSetProjectionV7 {
  assertChangeSetV7(changeSet);
  const envelope = shallowEnvelope(projection);
  const context = { createdAt: changeSet.createdAt, deviceId: changeSet.deviceId, eventId: changeSet.id, localSequence: changeSet.localSequence };
  // Mutations are intentionally kept in their supplied order: a createQuestion
  // batch may create a question before its membership/answer.
  for (const mutation of changeSet.mutations) applyMutation(envelope, mutation, context);
  return envelope;
}

/** One recompute + one validation pass for a finished rebase/replay chain. */
export function finalizeRebasedProjectionV7(projection: ChangeSetProjectionV7): ChangeSetProjectionV7 {
  const rebuilt = recomputeProjectionInPlace(projection);
  const issues = projectionValidationIssuesV7(rebuilt, { verifyDerived: false });
  if (issues.length) fail(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return rebuilt;
}

/** Apply one change-set's mutations to a private envelope, recompute derived
 *  tables once, and validate.  (Single-change fast path of the batch replay.) */
export function reduceChangeSetV7(input: ChangeSetProjectionInputV7, changeSet: ChangeSetV7): ChangeSetProjectionV7 {
  return finalizeRebasedProjectionV7(applyChangeSetToOwnedProjectionV7(normalizeProjection(input), changeSet));
}

/** Batch replay for sync pulls and queue rebuilds: applies every change-set on
 *  its own shallow envelope (discarding the envelope on failure = poison-skip
 *  with the exact rollback semantics of the single-record path) and performs
 *  ONE recompute + validation at the end instead of two per record.  Records
 *  that fail mid-application are skipped and their ids returned; pass
 *  `onConflict: "throw"` to propagate the first failure instead (queue
 *  rebuilds must stay strict). */
export function replayChangeSetBatchV7(input: ChangeSetProjectionInputV7, changes: readonly ChangeSetV7[], onStep?: (done: number, total: number) => void, options?: { onConflict?: "skip" | "throw" }): { projection: ChangeSetProjectionV7; skipped: string[] } {
  const skip = options?.onConflict !== "throw";
  let good = normalizeProjection(input);
  const skipped: string[] = [];
  const every = Math.max(1, Math.floor(changes.length / 24));
  for (let index = 0; index < changes.length; index += 1) {
    const change = changes[index];
    try {
      good = applyChangeSetToOwnedProjectionV7(good, change);
    } catch (error) {
      if (!skip) throw error;
      skipped.push(change.id);
    }
    if (onStep && ((index + 1) % every === 0 || index + 1 === changes.length)) onStep(index + 1, changes.length);
  }
  return { projection: finalizeRebasedProjectionV7(good), skipped };
}

export const applyChangeSetV7 = reduceChangeSetV7;
export const applyV7ChangeSet = reduceChangeSetV7;

export function reduceChangeSetsV7(input: ChangeSetProjectionInputV7, changeSets: readonly ChangeSetV7[]): ChangeSetProjectionV7 {
  const ordered = [...changeSets].sort((a, b) => a.localSequence - b.localSequence || a.createdAt.localeCompare(b.createdAt) || a.deviceId.localeCompare(b.deviceId) || a.id.localeCompare(b.id));
  let projection = normalizeProjection(input);
  for (const changeSet of ordered) projection = reduceChangeSetV7(projection, changeSet);
  return projection;
}

export const replayChangeSetsV7 = reduceChangeSetsV7;
