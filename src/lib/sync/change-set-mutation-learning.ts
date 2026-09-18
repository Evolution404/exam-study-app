import type {
  CanonicalState,
  PracticeRunItem,
  PracticeRunSource,
  QuestionGroupItem,
  ReviewRoundBank,
  ReviewRoundItem,
} from "../db/types";
import type { ChangeSetMutation } from "./change-set-types";
import type { MutationContext } from "./change-set-mutation-entities";
import {
  byId, clone, ensureBank, ensureQuestion, ensureRun, ensureRound, fail, putTombstone,
  rejectTombstoned, removeById, removeTombstone, requireById, setById,
} from "./change-set-projection-core";

function replaceRunRelations(state: CanonicalState, runId: string, sources: readonly PracticeRunSource[], items: readonly PracticeRunItem[]): void {
  if (sources.some((row) => row.runId !== runId)) fail(`练习 ${runId} 的来源关系 runId 不一致`);
  if (items.some((row) => row.runId !== runId)) fail(`练习 ${runId} 的题目关系 runId 不一致`);
  const sourceIds = new Set<string>();
  for (const row of sources) {
    ensureBank(state, row.bankId);
    if (sourceIds.has(row.bankId)) fail(`练习 ${runId} 包含重复题库来源 ${row.bankId}`);
    sourceIds.add(row.bankId);
  }
  if (!sources.length) fail(`练习 ${runId} 至少需要一个题库来源`);
  const questionIds = new Set<string>();
  for (const row of items) {
    ensureQuestion(state, row.questionId);
    if (questionIds.has(row.questionId)) fail(`练习 ${runId} 包含重复题目 ${row.questionId}`);
    questionIds.add(row.questionId);
    if (row.submittedAttemptId) {
      const attempt = byId(state.attempts, row.submittedAttemptId);
      if (!attempt || attempt.runId !== runId || attempt.questionId !== row.questionId) {
        fail(`练习题目 ${runId}:${row.questionId} 的 submittedAttemptId 无效`);
      }
    }
  }
  state.practiceRunSources = state.practiceRunSources.filter((row) => row.runId !== runId).concat(clone([...sources]));
  state.practiceRunItems = state.practiceRunItems.filter((row) => row.runId !== runId).concat(clone([...items]));
}

function replaceGroupItems(state: CanonicalState, groupId: string, items: readonly QuestionGroupItem[]): void {
  if (items.some((row) => row.groupId !== groupId)) fail(`题组 ${groupId} 的题目关系 groupId 不一致`);
  const questionIds = new Set<string>();
  for (const row of items) {
    ensureQuestion(state, row.questionId);
    if (questionIds.has(row.questionId)) fail(`题组 ${groupId} 包含重复题目 ${row.questionId}`);
    questionIds.add(row.questionId);
  }
  if (!items.length) fail(`题组 ${groupId} 至少需要一道题`);
  state.questionGroupItems = state.questionGroupItems.filter((row) => row.groupId !== groupId).concat(clone([...items]));
}

function replaceRoundRelations(state: CanonicalState, roundId: string, banks: readonly ReviewRoundBank[], items: readonly ReviewRoundItem[]): void {
  if (banks.some((row) => row.roundId !== roundId) || items.some((row) => row.roundId !== roundId)) fail(`复习轮次 ${roundId} 的关系 roundId 不一致`);
  const bankIds = new Set<string>();
  for (const row of banks) {
    ensureBank(state, row.bankId);
    if (bankIds.has(row.bankId)) fail(`复习轮次 ${roundId} 包含重复题库 ${row.bankId}`);
    bankIds.add(row.bankId);
  }
  const questionIds = new Set<string>();
  for (const row of items) {
    ensureQuestion(state, row.questionId);
    if (questionIds.has(row.questionId)) fail(`复习轮次 ${roundId} 包含重复题目 ${row.questionId}`);
    questionIds.add(row.questionId);
  }
  state.reviewRoundBanks = state.reviewRoundBanks.filter((row) => row.roundId !== roundId).concat(clone([...banks]));
  state.reviewRoundItems = state.reviewRoundItems.filter((row) => row.roundId !== roundId).concat(clone([...items]));
}

export function applyLearningMutation(state: CanonicalState, mutation: ChangeSetMutation, context: MutationContext): boolean {
  switch (mutation.kind) {
    case "attempt.create":
      ensureQuestion(state, mutation.attempt.questionId);
      rejectTombstoned(state, "attempt", mutation.attempt.id);
      if (mutation.attempt.elapsedMs < 0) fail("elapsedMs 不能为负数");
      if (mutation.attempt.reviewRoundId) ensureRound(state, mutation.attempt.reviewRoundId);
      if (byId(state.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 已存在`);
      setById(state.attempts, mutation.attempt);
      return true;
    case "attempt.delete": {
      const attempt = requireById(state.attempts, mutation.attemptId, "作答");
      if (mutation.questionId && mutation.questionId !== attempt.questionId) fail("删除作答 questionId 不一致");
      removeById(state.attempts, mutation.attemptId, "作答");
      state.practiceRunItems = state.practiceRunItems.map((item) => (
        item.submittedAttemptId === mutation.attemptId ? { ...item, submittedAttemptId: undefined } : item
      ));
      putTombstone(state, "attempt", mutation.attemptId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    }
    case "practice.answer.submitted": {
      const currentRun = ensureRun(state, mutation.runRecord.id);
      ensureQuestion(state, mutation.attempt.questionId);
      rejectTombstoned(state, "attempt", mutation.attempt.id);
      if (mutation.attempt.runId !== currentRun.id || mutation.item.runId !== currentRun.id || mutation.item.questionId !== mutation.attempt.questionId) {
        fail("答案作答记录与 run/question 不一致");
      }
      if (mutation.attempt.reviewRoundId !== mutation.runRecord.reviewRoundId) fail("答案作答轮次与练习记录不一致");
      if (mutation.attempt.reviewRoundId) ensureRound(state, mutation.attempt.reviewRoundId);
      if (!state.practiceRunItems.some((item) => item.runId === mutation.item.runId && item.questionId === mutation.item.questionId)) {
        fail("练习记录不包含当前题目");
      }
      if (mutation.item.submittedAttemptId !== mutation.attempt.id) fail("练习题目 submittedAttemptId 必须指向本次 Attempt");
      if (byId(state.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 已存在，提交必须使用新 id`);
      state.attempts.push(clone(mutation.attempt));
      setById(state.practiceRuns, mutation.runRecord, false);
      state.practiceRunItems = state.practiceRunItems.map((item) => (
        item.runId === mutation.item.runId && item.questionId === mutation.item.questionId ? clone(mutation.item) : item
      ));
      return true;
    }
    case "practice.answer.deleted": {
      const currentRun = ensureRun(state, mutation.runRecord.id);
      const attempt = requireById(state.attempts, mutation.attemptId, "作答");
      if (attempt.runId !== currentRun.id || mutation.item.runId !== currentRun.id || mutation.item.questionId !== attempt.questionId) fail("答案删除目标不一致");
      removeById(state.attempts, mutation.attemptId, "作答");
      setById(state.practiceRuns, mutation.runRecord, false);
      state.practiceRunItems = state.practiceRunItems.map((item) => (
        item.runId === mutation.item.runId && item.questionId === mutation.item.questionId ? clone(mutation.item) : item
      ));
      putTombstone(state, "attempt", mutation.attemptId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    }
    case "practice.run.saved":
      rejectTombstoned(state, "practiceRun", mutation.record.id);
      if (mutation.record.reviewRoundId) ensureRound(state, mutation.record.reviewRoundId);
      setById(state.practiceRuns, mutation.record);
      replaceRunRelations(state, mutation.record.id, mutation.sources, mutation.items);
      removeTombstone(state, "practiceRun", mutation.record.id);
      return true;
    case "practice.run.status.changed":
      ensureRun(state, mutation.record.id);
      if (mutation.record.reviewRoundId) ensureRound(state, mutation.record.reviewRoundId);
      setById(state.practiceRuns, mutation.record, false);
      return true;
    case "practice.run.deleted":
      removeById(state.practiceRuns, mutation.runId, "练习");
      state.practiceRunSources = state.practiceRunSources.filter((row) => row.runId !== mutation.runId);
      state.practiceRunItems = state.practiceRunItems.filter((row) => row.runId !== mutation.runId);
      putTombstone(state, "practiceRun", mutation.runId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    case "questionGroup.saved":
      rejectTombstoned(state, "questionGroup", mutation.record.id);
      setById(state.questionGroups, mutation.record);
      replaceGroupItems(state, mutation.record.id, mutation.items);
      removeTombstone(state, "questionGroup", mutation.record.id);
      return true;
    case "questionGroup.deleted":
      removeById(state.questionGroups, mutation.groupId, "题组");
      state.questionGroupItems = state.questionGroupItems.filter((row) => row.groupId !== mutation.groupId);
      putTombstone(state, "questionGroup", mutation.groupId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId, context.localSequence);
      return true;
    case "review.round.saved":
      setById(state.reviewRounds, mutation.record);
      replaceRoundRelations(state, mutation.record.id, mutation.banks, mutation.items);
      return true;
    case "review.round.completed":
    case "review.round.archived": {
      const current = ensureRound(state, mutation.record.id);
      if (mutation.kind === "review.round.completed" && current.status !== "active") fail(`轮次 ${current.id} 不是进行中状态`);
      setById(state.reviewRounds, mutation.record, false);
      replaceRoundRelations(state, mutation.record.id, mutation.banks, mutation.items);
      return true;
    }
    default:
      return false;
  }
}
