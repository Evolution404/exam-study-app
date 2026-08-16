/**
 * Cascade delete helpers for the v7 projection reducer.  These are separated
 * from the core so the reducer can share the bulk-delete path while keeping the
 * dependency graph one-way (core -> cascade -> derived -> reducer).
 */
import {
  ensureQuestion,
  putTombstone,
  type ChangeSetProjectionV7,
} from "./change-set-v7-projection-core";

export function updateQuestionDeleteCascade(projection: ChangeSetProjectionV7, questionId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  ensureQuestion(projection, questionId);
  projection.questions = projection.questions.filter((question) => question.id !== questionId);
  projection.memberships = projection.memberships.filter((membership) => membership.questionId !== questionId);
  projection.attempts = projection.attempts.filter((attempt) => attempt.questionId !== questionId);
  projection.attemptRoundIds = Object.fromEntries(Object.entries(projection.attemptRoundIds ?? {}).filter(([id]) => projection.attempts.some((attempt) => attempt.id === id)));
  projection.notes = projection.notes.filter((note) => note.questionId !== questionId);
  projection.reviewRoundProgress = projection.reviewRoundProgress.filter((item) => item.questionId !== questionId);
  projection.questionGroups = projection.questionGroups.flatMap((group) => {
    const items = group.items.filter((item) => item.questionId !== questionId);
    if (!items.length) {
      // 题目删除把组裁空时，一并写墓碑，使后续到达的陈旧 questionGroup.saved 被
      // rejectTombstoned 拦截（题组不可复活）。此前只丢弃组不写墓碑，远端 replay 后
      // saved 仍能重建含 dangling 题目引用的组。
      putTombstone(projection, "questionGroup", group.id, deletedAt, deviceId, eventId, sequence);
      return [];
    }
    return [{ ...group, items }];
  });
  projection.practiceRuns = projection.practiceRuns.map((run) => {
    if (!run.questionIds.includes(questionId)) return run;
    const answers = { ...run.answers };
    delete answers[questionId];
    const questionTypes = { ...run.questionTypes };
    delete questionTypes[questionId];
    return { ...run, questionIds: run.questionIds.filter((id) => id !== questionId), answers, questionTypes, updatedAt: deletedAt };
  });
  putTombstone(projection, "question", questionId, deletedAt, deviceId, eventId, sequence);
}

/** Bulk cascade delete in ONE pass per table (Set membership instead of a
 *  full cascade per question — the naive path was O(questions × tables)). */
export function updateQuestionsBulkDeleteCascade(projection: ChangeSetProjectionV7, questionIds: readonly string[], deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  const ids = new Set(questionIds);
  for (const questionId of ids) ensureQuestion(projection, questionId);
  const keepQuestion = (questionId: string) => !ids.has(questionId);
  projection.questions = projection.questions.filter((question) => keepQuestion(question.id));
  projection.memberships = projection.memberships.filter((membership) => keepQuestion(membership.questionId));
  const attemptIds = new Set(projection.attempts.filter((attempt) => !keepQuestion(attempt.questionId)).map((attempt) => attempt.id));
  projection.attempts = projection.attempts.filter((attempt) => keepQuestion(attempt.questionId));
  projection.attemptRoundIds = Object.fromEntries(Object.entries(projection.attemptRoundIds ?? {}).filter(([attemptId]) => !attemptIds.has(attemptId)));
  projection.notes = projection.notes.filter((note) => keepQuestion(note.questionId));
  projection.reviewRoundProgress = projection.reviewRoundProgress.filter((item) => keepQuestion(item.questionId));
  projection.questionGroups = projection.questionGroups.flatMap((group) => {
    const items = group.items.filter((item) => keepQuestion(item.questionId));
    if (!items.length) {
      // 与单题删除一致：组被裁空时写墓碑，拦截后续陈旧的 questionGroup.saved。
      putTombstone(projection, "questionGroup", group.id, deletedAt, deviceId, eventId, sequence);
      return [];
    }
    return [{ ...group, items }];
  });
  projection.practiceRuns = projection.practiceRuns.map((run) => {
    if (!run.questionIds.some((id) => ids.has(id))) return run;
    const answers = { ...run.answers };
    const questionTypes = { ...run.questionTypes };
    for (const questionId of run.questionIds) {
      if (!ids.has(questionId)) continue;
      delete answers[questionId];
      delete questionTypes[questionId];
    }
    return { ...run, questionIds: run.questionIds.filter(keepQuestion), answers, questionTypes, updatedAt: deletedAt };
  });
  for (const questionId of ids) putTombstone(projection, "question", questionId, deletedAt, deviceId, eventId, sequence);
}
