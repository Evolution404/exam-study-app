/**
 * Derived statistics and validation for the v7 projection reducer.  Rebuilds
 * every derived table from durable entity/attempt projections and verifies
 * referential integrity.
 */
import type {
  AttemptDailyStatsV7,
  AttemptStatsV7,
  AttemptV7,
  PracticeRunStatsV7,
  PracticeRunV7,
  ReviewRoundProgress,
} from "../db/v7-types";
import {
  dailyKey,
  datePart,
  fail,
  membershipKey,
  normalizeProjection,
  runBankIds,
  uniqueStrings,
  type ChangeSetProjectionInputV7,
  type ChangeSetProjectionV7,
  type ProjectionValidationIssueV7,
} from "./change-set-v7-projection-core";

function sortAttempts(attempts: readonly AttemptV7[]): AttemptV7[] {
  return [...attempts].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function deriveAttemptStats(attempts: readonly AttemptV7[]): AttemptStatsV7[] {
  // Group by direct push (the old `[...grouped.get(k) ?? [], a]` spread was
  // O(k²) copies for a question answered k times).
  const grouped = new Map<string, AttemptV7[]>();
  for (const attempt of sortAttempts(attempts)) {
    const bucket = grouped.get(attempt.questionId);
    if (bucket) bucket.push(attempt);
    else grouped.set(attempt.questionId, [attempt]);
  }
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
    } satisfies AttemptStatsV7;
  });
}

function deriveDailyStats(attempts: readonly AttemptV7[]): AttemptDailyStatsV7[] {
  const grouped = new Map<string, AttemptDailyStatsV7>();
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

function deriveRunStats(runs: readonly PracticeRunV7[]): PracticeRunStatsV7[] {
  const grouped = new Map<string, PracticeRunStatsV7>();
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
  // Run lookup by Map — the old per-attempt linear find made this O(attempts × runs).
  const runsById = new Map(projection.practiceRuns.map((run) => [run.id, run]));
  const grouped = new Map<string, ReviewRoundProgress>();
  for (const attempt of sortAttempts(projection.attempts)) {
    const run = runsById.get(attempt.runId);
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

/** In-place recompute for envelopes the caller privately owns (replay paths):
 *  skips the defensive deep clone of `recomputeChangeSetProjectionV7`. */
export function recomputeProjectionInPlace(projection: ChangeSetProjectionV7): ChangeSetProjectionV7 {
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

/** Rebuild every derived v7 table from the durable entity/attempt projections. */
export function recomputeChangeSetProjectionV7(input: ChangeSetProjectionInputV7): ChangeSetProjectionV7 {
  return recomputeProjectionInPlace(normalizeProjection(input));
}

function pushIssue(issues: ProjectionValidationIssueV7[], path: string, message: string): void {
  issues.push({ path, message });
}

/** Return all referential/count errors without mutating the supplied projection.
 *  `verifyDerived: false` skips the staleness re-derivation — call it ONLY on a
 *  projection that was just passed through `recomputeChangeSetProjectionV7`
 *  (fresh derived tables are correct by construction; the re-derivation plus
 *  four full-table JSON comparisons exist for externally supplied inputs). */
export function projectionValidationIssuesV7(input: ChangeSetProjectionInputV7, options?: { verifyDerived?: boolean }): ProjectionValidationIssueV7[] {
  const verifyDerived = options?.verifyDerived !== false;
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
    if (!verifyDerived) return issues;
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
