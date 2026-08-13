/**
 * Pure v7 projection reducer.  The reducer intentionally has no Dexie or
 * browser dependencies: callers can validate and persist its returned value
 * in one transaction.  A failed mutation throws before the new projection is
 * returned, so a change-set is atomic even when it contains many mutations.
 */
import type {
  AttemptDailyStatsV6,
  AttemptStatsV6,
  AttemptV6,
  BankFolderV6,
  BankQuestionMembership,
  BankV6,
  ImageAsset,
  NoteV6,
  PracticeRunStatsV6,
  PracticeRunV6,
  QuestionGroupV6,
  QuestionV6,
  ReviewRound,
  ReviewRoundProgress,
  TombstoneV6,
} from "./v6-types";
import {
  assertChangeSetV7,
  type ChangeSetMutationV7,
  type ChangeSetV7,
} from "./change-set-v7";

export interface ChangeSetProjectionV7 {
  banks: BankV6[];
  bankFolders: BankFolderV6[];
  questions: QuestionV6[];
  memberships: BankQuestionMembership[];
  /** Alias retained for callers using the v6 table name. */
  bankQuestionMemberships?: BankQuestionMembership[];
  imageAssets: ImageAsset[];
  attempts: AttemptV6[];
  attemptStats: AttemptStatsV6[];
  attemptDailyStats: AttemptDailyStatsV6[];
  notes: NoteV6[];
  practiceRuns: PracticeRunV6[];
  practiceRunStats: PracticeRunStatsV6[];
  questionGroups: QuestionGroupV6[];
  reviewRounds: ReviewRound[];
  reviewRoundProgress: ReviewRoundProgress[];
  tombstones: TombstoneV6[];
  /** Attempt-to-round provenance is needed because AttemptV6 is round-neutral. */
  attemptRoundIds?: Record<string, string[]>;
}

export type ChangeSetProjectionInputV7 = Omit<ChangeSetProjectionV7, "bankQuestionMemberships"> & {
  bankQuestionMemberships?: BankQuestionMembership[];
  memberships?: BankQuestionMembership[];
};

export interface ProjectionValidationIssueV7 {
  path: string;
  message: string;
}

function fail(message: string): never {
  throw new Error(`v7 projection conflict: ${message}`);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function list<T>(value: readonly T[] | undefined): T[] {
  return value ? clone([...value]) : [];
}

function byId<T extends { id: string }>(values: T[], id: string): T | undefined {
  return values.find((value) => value.id === id);
}

function requireById<T extends { id: string }>(values: T[], id: string, entity: string): T {
  const value = byId(values, id);
  if (!value) fail(`${entity} ${id} 不存在`);
  return value;
}

function compareClock(
  a: { updatedAt?: string; createdAt?: string; deletedAt?: string; deviceId?: string; id?: string; eventId?: string },
  b: { updatedAt?: string; createdAt?: string; deletedAt?: string; deviceId?: string; id?: string; eventId?: string },
): number {
  return (a.updatedAt ?? a.createdAt ?? a.deletedAt ?? "").localeCompare(b.updatedAt ?? b.createdAt ?? b.deletedAt ?? "")
    || (a.deviceId ?? "").localeCompare(b.deviceId ?? "")
    || (a.id ?? a.eventId ?? "").localeCompare(b.id ?? b.eventId ?? "");
}

function datePart(value: string): string {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : value.slice(0, 10);
}

function dailyKey(createdAt: string, questionId: string): string {
  return `${datePart(createdAt)}:${questionId}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function normalizeProjection(input: ChangeSetProjectionInputV7): ChangeSetProjectionV7 {
  const memberships = input.memberships ?? input.bankQuestionMemberships ?? [];
  return {
    banks: list(input.banks),
    bankFolders: list(input.bankFolders),
    questions: list(input.questions),
    memberships: list(memberships),
    bankQuestionMemberships: list(memberships),
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

function setById<T extends { id: string }>(values: T[], value: T, allowInsert = true): void {
  const index = values.findIndex((item) => item.id === value.id);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.id} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}

function removeById<T extends { id: string }>(values: T[], id: string, entity: string): T {
  const index = values.findIndex((item) => item.id === id);
  if (index < 0) fail(`${entity} ${id} 不存在`);
  const [removed] = values.splice(index, 1);
  return removed;
}

function removeMembership(projection: ChangeSetProjectionV7, key: string): BankQuestionMembership {
  const index = projection.memberships.findIndex((membership) => membership.key === key);
  if (index < 0) fail(`题库关系 ${key} 不存在`);
  const [removed] = projection.memberships.splice(index, 1);
  return removed;
}

function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

function ensureQuestion(projection: ChangeSetProjectionV7, questionId: string): QuestionV6 {
  return requireById(projection.questions, questionId, "题目");
}

function ensureBank(projection: ChangeSetProjectionV7, bankId: string): BankV6 {
  return requireById(projection.banks, bankId, "题库");
}

function ensureRun(projection: ChangeSetProjectionV7, runId: string): PracticeRunV6 {
  return requireById(projection.practiceRuns, runId, "练习");
}

function upsertAttemptRound(projection: ChangeSetProjectionV7, attemptId: string, roundId?: string): void {
  if (!roundId) return;
  const current = projection.attemptRoundIds?.[attemptId] ?? [];
  projection.attemptRoundIds ??= {};
  projection.attemptRoundIds[attemptId] = uniqueStrings([...current, roundId]).sort();
}

function removeAttemptRound(projection: ChangeSetProjectionV7, attemptId: string): void {
  if (projection.attemptRoundIds) delete projection.attemptRoundIds[attemptId];
}

function putTombstone(projection: ChangeSetProjectionV7, entityType: TombstoneV6["entityType"], entityId: string, deletedAt: string, deviceId: string, eventId: string): void {
  const key = `${entityType}:${entityId}`;
  const old = projection.tombstones.find((item) => item.key === key);
  const next: TombstoneV6 = { key, entityType, entityId, deletedAt, deviceId, eventId };
  if (!old) projection.tombstones.push(next);
  else if (compareClock(next, old) > 0) projection.tombstones[projection.tombstones.indexOf(old)] = next;
}

function removeTombstone(projection: ChangeSetProjectionV7, type: string, id: string): void {
  projection.tombstones = projection.tombstones.filter((item) => item.key !== `${type}:${id}`);
}

function rejectTombstoned(projection: ChangeSetProjectionV7, type: string, id: string): void {
  if (projection.tombstones.some((item) => item.key === `${type}:${id}`)) fail(`${type} ${id} 已被删除，陈旧变更不能重新创建它`);
}

function updateQuestionDeleteCascade(projection: ChangeSetProjectionV7, questionId: string, deletedAt: string, deviceId: string, eventId: string): void {
  ensureQuestion(projection, questionId);
  projection.questions = projection.questions.filter((question) => question.id !== questionId);
  projection.memberships = projection.memberships.filter((membership) => membership.questionId !== questionId);
  projection.attempts = projection.attempts.filter((attempt) => attempt.questionId !== questionId);
  projection.attemptRoundIds = Object.fromEntries(Object.entries(projection.attemptRoundIds ?? {}).filter(([id]) => projection.attempts.some((attempt) => attempt.id === id)));
  projection.notes = projection.notes.filter((note) => note.questionId !== questionId);
  projection.reviewRoundProgress = projection.reviewRoundProgress.filter((item) => item.questionId !== questionId);
  projection.questionGroups = projection.questionGroups.flatMap((group) => {
    const items = group.items.filter((item) => item.questionId !== questionId);
    return items.length ? [{ ...group, items }] : [];
  });
  projection.practiceRuns = projection.practiceRuns.map((run) => {
    if (!run.questionIds.includes(questionId)) return run;
    const answers = { ...run.answers };
    delete answers[questionId];
    const questionTypes = { ...run.questionTypes };
    delete questionTypes[questionId];
    return { ...run, questionIds: run.questionIds.filter((id) => id !== questionId), answers, questionTypes, updatedAt: deletedAt };
  });
  putTombstone(projection, "question", questionId, deletedAt, deviceId, eventId);
}

function applyMutation(projection: ChangeSetProjectionV7, mutation: ChangeSetMutationV7, context: { createdAt: string; deviceId: string; eventId: string }): void {
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
      putTombstone(projection, "bank", bank.id, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId);
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
      putTombstone(projection, "bankFolder", mutation.folderId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId);
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
      updateQuestionDeleteCascade(projection, question.id, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId);
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
      for (const key of mutation.deletedMembershipKeys ?? []) removeMembership(projection, key);
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
      for (const questionId of mutation.questionIds) applyMutation(projection, { kind: "question.delete", questionId, deletedAt: mutation.deletedAt, cascade: mutation.cascade }, context);
      return;
    case "membership.save": {
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
      putTombstone(projection, "membership", key, mutation.removedAt ?? context.createdAt, context.deviceId, context.eventId);
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
      putTombstone(projection, "imageAsset", mutation.assetId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId);
      return;
    }
    case "attempt.create": case "attempt.update": {
      ensureQuestion(projection, mutation.attempt.questionId);
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
      return;
    }
    case "practice.answer.submitted": case "practice.answer.updated": {
      const run = ensureRun(projection, mutation.runId);
      ensureQuestion(projection, mutation.questionId);
      if (mutation.attempt.runId !== mutation.runId || mutation.attempt.questionId !== mutation.questionId) fail("答案作答记录与 run/question 不一致");
      if (mutation.kind === "practice.answer.submitted" && byId(projection.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 已存在，提交必须使用新 id`);
      if (mutation.kind === "practice.answer.updated" && !byId(projection.attempts, mutation.attempt.id)) fail(`作答 ${mutation.attempt.id} 不存在`);
      setById(projection.attempts, mutation.attempt, mutation.kind === "practice.answer.submitted");
      upsertAttemptRound(projection, mutation.attempt.id, mutation.reviewRoundId ?? run.reviewRoundId);
      setRunAnswer(run, mutation.questionId, mutation.answer);
      return;
    }
    case "practice.answer.deleted": {
      const run = ensureRun(projection, mutation.runId);
      const attempt = requireById(projection.attempts, mutation.attemptId, "作答");
      if (attempt.runId !== mutation.runId || attempt.questionId !== mutation.questionId) fail("答案删除目标不一致");
      removeById(projection.attempts, mutation.attemptId, "作答");
      removeAttemptRound(projection, mutation.attemptId);
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
      putTombstone(projection, "practiceRun", mutation.runId, mutation.deletedAt ?? context.createdAt, context.deviceId, context.eventId);
      return;
    case "note.upserted":
      ensureQuestion(projection, mutation.note.questionId);
      setByQuestionId(projection.notes, mutation.note);
      return;
    case "note.deleted":
      ensureQuestion(projection, mutation.questionId);
      if (!projection.notes.some((note) => note.questionId === mutation.questionId)) fail(`解析 ${mutation.questionId} 不存在`);
      projection.notes = projection.notes.filter((note) => note.questionId !== mutation.questionId);
      return;
    case "questionGroup.saved":
      rejectTombstoned(projection, "questionGroup", mutation.group.id);
      mutation.group.items.forEach((item) => ensureQuestion(projection, item.questionId));
      setById(projection.questionGroups, mutation.group);
      return;
    case "questionGroup.deleted":
      removeById(projection.questionGroups, mutation.groupId, "题组");
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

function setByKey<T extends { key: string }>(values: T[], value: T, allowInsert = true): void {
  const index = values.findIndex((item) => item.key === value.key);
  if (index < 0) {
    if (!allowInsert) fail(`实体 ${value.key} 不存在`);
    values.push(clone(value));
  } else values[index] = clone(value);
}

function setByQuestionId(values: NoteV6[], value: NoteV6): void {
  const index = values.findIndex((item) => item.questionId === value.questionId);
  if (index < 0) values.push(clone(value));
  else values[index] = clone(value);
}

function ensureFolder(projection: ChangeSetProjectionV7, folderId: string): BankFolderV6 {
  return requireById(projection.bankFolders, folderId, "题库文件夹");
}

function ensureAsset(projection: ChangeSetProjectionV7, assetId: string): ImageAsset {
  const asset = projection.imageAssets.find((item) => item.id === assetId);
  if (!asset) fail(`图片资产 ${assetId} 不存在`);
  return asset;
}

function ensureRound(projection: ChangeSetProjectionV7, roundId: string): ReviewRound {
  return requireById(projection.reviewRounds, roundId, "复习轮次");
}

function runBankIds(run: Pick<PracticeRunV6, "bankId" | "bankIds">): string[] {
  return uniqueStrings(run.bankIds?.length ? run.bankIds : [run.bankId]);
}

function setRunAnswer(run: PracticeRunV6, questionId: string, answer: PracticeRunV6["answers"][string]): void {
  run.answers = { ...run.answers, [questionId]: clone(answer) };
  run.updatedAt = answer.updatedAt ?? run.updatedAt;
  run.revision += 1;
  const submitted = run.questionIds.reduce((last, id, index) => run.answers[id]?.submitted ? index : last, -1);
  if (submitted >= 0) run.lastAnsweredIndex = submitted;
}

function sortAttempts(attempts: readonly AttemptV6[]): AttemptV6[] {
  return [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function deriveAttemptStats(attempts: readonly AttemptV6[]): AttemptStatsV6[] {
  const grouped = new Map<string, AttemptV6[]>();
  for (const attempt of sortAttempts(attempts)) grouped.set(attempt.questionId, [...(grouped.get(attempt.questionId) ?? []), attempt]);
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([questionId, values]) => {
    const ordered = sortAttempts(values);
    const first = ordered[0];
    const last = ordered[ordered.length - 1];
    let currentCorrectStreak = 0;
    for (let index = ordered.length - 1; index >= 0 && ordered[index].correct; index -= 1) currentCorrectStreak += 1;
    let lastWrongIndex = -1;
    ordered.forEach((attempt, index) => { if (!attempt.correct) lastWrongIndex = index; });
    const correctStreakAfterWrong = lastWrongIndex < 0 ? 0 : ordered.slice(lastWrongIndex + 1).reduce((count, attempt) => count + (attempt.correct ? 1 : 0), 0);
    return {
      questionId,
      total: ordered.length,
      correct: ordered.filter((attempt) => attempt.correct).length,
      wrong: ordered.filter((attempt) => !attempt.correct).length,
      giveUps: ordered.filter((attempt) => !attempt.selected).length,
      totalElapsedMs: ordered.reduce((sum, attempt) => sum + Math.max(0, attempt.elapsedMs), 0),
      firstAttemptAt: first.createdAt,
      firstAttemptCorrect: first.correct,
      latestAttemptAt: last.createdAt,
      hasBeenWrong: ordered.some((attempt) => !attempt.correct),
      correctStreakAfterWrong,
      currentCorrectStreak,
      recentOutcomes: ordered.slice(-32).map((attempt) => ({ id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct })),
    } satisfies AttemptStatsV6;
  });
}

function deriveDailyStats(attempts: readonly AttemptV6[]): AttemptDailyStatsV6[] {
  const grouped = new Map<string, AttemptDailyStatsV6>();
  for (const attempt of sortAttempts(attempts)) {
    const key = dailyKey(attempt.createdAt, attempt.questionId);
    const current = grouped.get(key) ?? { key, date: datePart(attempt.createdAt), questionId: attempt.questionId, total: 0, correct: 0, wrong: 0, giveUps: 0, totalElapsedMs: 0 };
    current.total += 1;
    if (attempt.correct) current.correct += 1; else current.wrong += 1;
    if (!attempt.selected) current.giveUps += 1;
    current.totalElapsedMs += Math.max(0, attempt.elapsedMs);
    grouped.set(key, current);
  }
  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function deriveRunStats(runs: readonly PracticeRunV6[]): PracticeRunStatsV6[] {
  const grouped = new Map<string, PracticeRunStatsV6>();
  for (const run of [...runs].sort((a, b) => a.id.localeCompare(b.id))) {
    for (const bankId of runBankIds(run)) {
      const current = grouped.get(bankId) ?? { key: bankId, bankId, total: 0, completed: 0, inProgress: 0, abandoned: 0, latestUpdatedAt: "" };
      current.total += 1;
      if (run.status === "completed") current.completed += 1;
      else if (run.status === "abandoned") current.abandoned += 1;
      else current.inProgress += 1;
      if (run.updatedAt > current.latestUpdatedAt) current.latestUpdatedAt = run.updatedAt;
      grouped.set(bankId, current);
    }
  }
  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function deriveRoundProgress(projection: ChangeSetProjectionV7): ReviewRoundProgress[] {
  const roundsById = new Map(projection.reviewRounds.map((round) => [round.id, round]));
  const grouped = new Map<string, ReviewRoundProgress>();
  for (const attempt of sortAttempts(projection.attempts)) {
    const run = projection.practiceRuns.find((candidate) => candidate.id === attempt.runId);
    const roundIds = uniqueStrings([...(projection.attemptRoundIds?.[attempt.id] ?? []), ...(run?.reviewRoundId ? [run.reviewRoundId] : [])]);
    for (const roundId of roundIds) {
      if (!roundsById.has(roundId)) fail(`作答 ${attempt.id} 引用了不存在的轮次 ${roundId}`);
      const key = `${roundId}:${attempt.questionId}`;
      const current = grouped.get(key) ?? { key, roundId, questionId: attempt.questionId, attempts: 0, correct: 0, wrong: 0, firstAttemptAt: attempt.createdAt, latestAttemptAt: attempt.createdAt };
      current.attempts += 1;
      if (attempt.correct) current.correct += 1; else current.wrong += 1;
      if (attempt.createdAt < current.firstAttemptAt) current.firstAttemptAt = attempt.createdAt;
      if (attempt.createdAt > current.latestAttemptAt) current.latestAttemptAt = attempt.createdAt;
      grouped.set(key, current);
    }
  }
  return [...grouped.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Rebuild every derived v6 table from the durable entity/attempt projections. */
export function recomputeChangeSetProjectionV7(input: ChangeSetProjectionInputV7): ChangeSetProjectionV7 {
  const projection = normalizeProjection(input);
  const countByBank = new Map<string, number>();
  for (const membership of projection.memberships) countByBank.set(membership.bankId, (countByBank.get(membership.bankId) ?? 0) + 1);
  projection.banks = projection.banks.map((bank) => ({ ...bank, questionCount: countByBank.get(bank.id) ?? 0 }));
  projection.attempts = sortAttempts(projection.attempts);
  projection.attemptStats = deriveAttemptStats(projection.attempts);
  projection.attemptDailyStats = deriveDailyStats(projection.attempts);
  projection.practiceRunStats = deriveRunStats(projection.practiceRuns);
  projection.reviewRoundProgress = deriveRoundProgress(projection);
  projection.banks.sort((a, b) => a.id.localeCompare(b.id));
  projection.bankFolders.sort((a, b) => a.id.localeCompare(b.id));
  projection.questions.sort((a, b) => a.id.localeCompare(b.id));
  projection.imageAssets.sort((a, b) => a.id.localeCompare(b.id));
  projection.notes.sort((a, b) => a.questionId.localeCompare(b.questionId));
  projection.practiceRuns.sort((a, b) => a.id.localeCompare(b.id));
  projection.questionGroups.sort((a, b) => a.id.localeCompare(b.id));
  projection.reviewRounds.sort((a, b) => a.id.localeCompare(b.id));
  projection.tombstones.sort((a, b) => a.key.localeCompare(b.key));
  projection.memberships.sort((a, b) => a.key.localeCompare(b.key));
  projection.bankQuestionMemberships = projection.memberships;
  return projection;
}

function pushIssue(issues: ProjectionValidationIssueV7[], path: string, message: string): void {
  issues.push({ path, message });
}

/** Return all referential/count errors without mutating the supplied projection. */
export function projectionValidationIssuesV7(input: ChangeSetProjectionInputV7): ProjectionValidationIssueV7[] {
  const issues: ProjectionValidationIssueV7[] = [];
  let projection: ChangeSetProjectionV7;
  try { projection = normalizeProjection(input); } catch (error) { return [{ path: "projection", message: String(error) }]; }
  const banks = new Set<string>();
  for (const bank of projection.banks) {
    if (banks.has(bank.id)) pushIssue(issues, `banks.${bank.id}`, "duplicate bank id");
    banks.add(bank.id);
    if (bank.folderId && !projection.bankFolders.some((folder) => folder.id === bank.folderId)) pushIssue(issues, `banks.${bank.id}.folderId`, "missing folder");
  }
  const questions = new Set<string>();
  for (const question of projection.questions) {
    if (questions.has(question.id)) pushIssue(issues, `questions.${question.id}`, "duplicate question id");
    questions.add(question.id);
  }
  const membershipKeys = new Set<string>();
  for (const membership of projection.memberships) {
    if (membership.key !== membershipKey(membership.bankId, membership.questionId)) pushIssue(issues, `memberships.${membership.key}`, "non-canonical key");
    if (membershipKeys.has(membership.key)) pushIssue(issues, `memberships.${membership.key}`, "duplicate membership");
    membershipKeys.add(membership.key);
    if (!banks.has(membership.bankId)) pushIssue(issues, `memberships.${membership.key}.bankId`, "missing bank");
    if (!questions.has(membership.questionId)) pushIssue(issues, `memberships.${membership.key}.questionId`, "missing question");
  }
  for (const attempt of projection.attempts) {
    if (!questions.has(attempt.questionId)) pushIssue(issues, `attempts.${attempt.id}.questionId`, "missing question");
  }
  for (const run of projection.practiceRuns) {
    for (const bankId of runBankIds(run)) if (!banks.has(bankId)) pushIssue(issues, `practiceRuns.${run.id}.bankIds`, `missing bank ${bankId}`);
    for (const questionId of run.questionIds) if (!questions.has(questionId)) pushIssue(issues, `practiceRuns.${run.id}.questionIds`, `missing question ${questionId}`);
  }
  try {
    const rebuilt = recomputeChangeSetProjectionV7(projection);
    for (const bank of projection.banks) if (bank.questionCount !== rebuilt.banks.find((candidate) => candidate.id === bank.id)?.questionCount) pushIssue(issues, `banks.${bank.id}.questionCount`, "count is stale");
    if (JSON.stringify(projection.attemptStats) !== JSON.stringify(rebuilt.attemptStats)) pushIssue(issues, "attemptStats", "derived stats are stale");
    if (JSON.stringify(projection.attemptDailyStats) !== JSON.stringify(rebuilt.attemptDailyStats)) pushIssue(issues, "attemptDailyStats", "derived daily stats are stale");
    if (JSON.stringify(projection.practiceRunStats) !== JSON.stringify(rebuilt.practiceRunStats)) pushIssue(issues, "practiceRunStats", "derived run stats are stale");
    if (JSON.stringify(projection.reviewRoundProgress) !== JSON.stringify(rebuilt.reviewRoundProgress)) pushIssue(issues, "reviewRoundProgress", "derived round progress is stale");
  } catch (error) { pushIssue(issues, "derived", String(error)); }
  return issues;
}

export function validateChangeSetProjectionV7(input: ChangeSetProjectionInputV7): boolean {
  return projectionValidationIssuesV7(input).length === 0;
}

export function assertChangeSetProjectionV7(input: ChangeSetProjectionInputV7): asserts input is ChangeSetProjectionV7 {
  const issues = projectionValidationIssuesV7(input);
  if (issues.length) fail(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
}

/** Apply all mutations atomically to a cloned projection. */
export function reduceChangeSetV7(input: ChangeSetProjectionInputV7, changeSet: ChangeSetV7): ChangeSetProjectionV7 {
  assertChangeSetV7(changeSet);
  const next = normalizeProjection(input);
  const context = { createdAt: changeSet.createdAt, deviceId: changeSet.deviceId, eventId: changeSet.id };
  // Applying to a private clone guarantees no partial writes if any mutation
  // fails.  Mutations are intentionally kept in their supplied order: a
  // createQuestion batch may create a question before its membership/answer.
  for (const mutation of changeSet.mutations) applyMutation(next, mutation, context);
  const rebuilt = recomputeChangeSetProjectionV7(next);
  const issues = projectionValidationIssuesV7(rebuilt);
  if (issues.length) fail(issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  return rebuilt;
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
