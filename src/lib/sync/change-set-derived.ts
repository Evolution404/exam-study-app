/**
 * Deterministic canonical-state normalization and validation.
 * No device-local projection rows are represented or recomputed here.
 */
import type { CanonicalState } from "../db/types";
import {
  fail,
  membershipKey,
  normalizeCanonicalState,
  type CanonicalStateValidationIssue,
} from "./change-set-projection-core";

function pushIssue(issues: CanonicalStateValidationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}
function relationId(...parts: string[]): string { return parts.join(":"); }

export function normalizeCanonicalStateForReplay(input: CanonicalState): CanonicalState {
  const state = normalizeCanonicalState(input);
  state.banks.sort((a,b)=>a.id.localeCompare(b.id));
  state.bankFolders.sort((a,b)=>a.id.localeCompare(b.id));
  state.questions.sort((a,b)=>a.id.localeCompare(b.id));
  state.memberships.sort((a,b)=>a.key.localeCompare(b.key));
  state.imageAssets.sort((a,b)=>a.id.localeCompare(b.id));
  state.attempts.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id));
  state.notes.sort((a,b)=>a.questionId.localeCompare(b.questionId));
  state.practiceRuns.sort((a,b)=>a.id.localeCompare(b.id));
  state.practiceRunSources.sort((a,b)=>a.runId.localeCompare(b.runId)||a.position-b.position||a.bankId.localeCompare(b.bankId));
  state.practiceRunItems.sort((a,b)=>a.runId.localeCompare(b.runId)||a.position-b.position||a.questionId.localeCompare(b.questionId));
  state.questionGroups.sort((a,b)=>a.id.localeCompare(b.id));
  state.questionGroupItems.sort((a,b)=>a.groupId.localeCompare(b.groupId)||a.position-b.position||a.questionId.localeCompare(b.questionId));
  state.reviewRounds.sort((a,b)=>a.id.localeCompare(b.id));
  state.reviewRoundBanks.sort((a,b)=>a.roundId.localeCompare(b.roundId)||a.position-b.position||a.bankId.localeCompare(b.bankId));
  state.reviewRoundItems.sort((a,b)=>a.roundId.localeCompare(b.roundId)||a.position-b.position||a.questionId.localeCompare(b.questionId));
  state.tombstones.sort((a,b)=>a.key.localeCompare(b.key));
  return state;
}

export function canonicalStateValidationIssues(input: CanonicalState): CanonicalStateValidationIssue[] {
  const issues: CanonicalStateValidationIssue[] = [];
  let state: CanonicalState;
  try { state = normalizeCanonicalState(input); } catch (error) { return [{ path:"canonical", message:String(error) }]; }

  const folders = new Set(state.bankFolders.map((row)=>row.id));
  const banks = new Set<string>();
  for (const bank of state.banks) {
    if (banks.has(bank.id)) pushIssue(issues,`banks.${bank.id}`,"duplicate bank id");
    banks.add(bank.id);
    if (bank.folderId && !folders.has(bank.folderId)) pushIssue(issues,`banks.${bank.id}.folderId`,"missing folder");
  }
  const questions = new Set<string>();
  for (const question of state.questions) {
    if (questions.has(question.id)) pushIssue(issues,`questions.${question.id}`,"duplicate question id");
    questions.add(question.id);
    for (const block of [...question.content,...question.options.flat()]) {
      if (block.type === "image" && !state.imageAssets.some((asset)=>asset.id===block.assetId)) pushIssue(issues,`questions.${question.id}.image`,`missing image asset ${block.assetId}`);
    }
  }

  const membershipKeys = new Set<string>();
  for (const row of state.memberships) {
    if (row.key !== membershipKey(row.bankId,row.questionId)) pushIssue(issues,`memberships.${row.key}`,"non-canonical key");
    if (membershipKeys.has(row.key)) pushIssue(issues,`memberships.${row.key}`,"duplicate membership");
    membershipKeys.add(row.key);
    if (!banks.has(row.bankId)) pushIssue(issues,`memberships.${row.key}.bankId`,"missing bank");
    if (!questions.has(row.questionId)) pushIssue(issues,`memberships.${row.key}.questionId`,"missing question");
  }

  const runIds = new Set(state.practiceRuns.map((row)=>row.id));
  const roundIds = new Set(state.reviewRounds.map((row)=>row.id));
  for (const run of state.practiceRuns) {
    if (run.reviewRoundId && !roundIds.has(run.reviewRoundId)) pushIssue(issues,`practiceRuns.${run.id}.reviewRoundId`,"missing review round");
  }
  const runSources = new Set<string>();
  const runSourceCount = new Map<string,number>();
  for (const row of state.practiceRunSources) {
    const key=relationId(row.runId,row.bankId);
    if (runSources.has(key)) pushIssue(issues,`practiceRunSources.${key}`,"duplicate source");
    runSources.add(key);
    runSourceCount.set(row.runId,(runSourceCount.get(row.runId)??0)+1);
    if (!runIds.has(row.runId)) pushIssue(issues,`practiceRunSources.${key}.runId`,"missing run");
    if (!banks.has(row.bankId)) pushIssue(issues,`practiceRunSources.${key}.bankId`,"missing bank");
  }
  for (const run of state.practiceRuns) if (!(runSourceCount.get(run.id)??0)) pushIssue(issues,`practiceRuns.${run.id}`,"run has no bank source");

  const attemptsById = new Map(state.attempts.map((row)=>[row.id,row]));
  for (const attempt of state.attempts) {
    if (!questions.has(attempt.questionId)) pushIssue(issues,`attempts.${attempt.id}.questionId`,"missing question");
    if (attempt.reviewRoundId && !roundIds.has(attempt.reviewRoundId)) pushIssue(issues,`attempts.${attempt.id}.reviewRoundId`,"missing review round");
  }
  const runItems = new Set<string>();
  for (const row of state.practiceRunItems) {
    const key=relationId(row.runId,row.questionId);
    if (runItems.has(key)) pushIssue(issues,`practiceRunItems.${key}`,"duplicate item");
    runItems.add(key);
    if (!runIds.has(row.runId)) pushIssue(issues,`practiceRunItems.${key}.runId`,"missing run");
    if (!questions.has(row.questionId)) pushIssue(issues,`practiceRunItems.${key}.questionId`,"missing question");
    if (row.submittedAttemptId) {
      const attempt=attemptsById.get(row.submittedAttemptId);
      if (!attempt) pushIssue(issues,`practiceRunItems.${key}.submittedAttemptId`,"missing attempt");
      else if (attempt.runId!==row.runId || attempt.questionId!==row.questionId) pushIssue(issues,`practiceRunItems.${key}.submittedAttemptId`,"attempt attribution mismatch");
    }
  }

  const groupIds = new Set(state.questionGroups.map((row)=>row.id));
  const groupItems = new Set<string>();
  for (const row of state.questionGroupItems) {
    const key=relationId(row.groupId,row.questionId);
    if (groupItems.has(key)) pushIssue(issues,`questionGroupItems.${key}`,"duplicate item");
    groupItems.add(key);
    if (!groupIds.has(row.groupId)) pushIssue(issues,`questionGroupItems.${key}.groupId`,"missing group");
    if (!questions.has(row.questionId)) pushIssue(issues,`questionGroupItems.${key}.questionId`,"missing question");
  }

  for (const row of state.reviewRoundBanks) {
    if (!roundIds.has(row.roundId)) pushIssue(issues,`reviewRoundBanks.${row.roundId}:${row.bankId}.roundId`,"missing round");
    if (!banks.has(row.bankId)) pushIssue(issues,`reviewRoundBanks.${row.roundId}:${row.bankId}.bankId`,"missing bank");
  }
  for (const row of state.reviewRoundItems) {
    if (!roundIds.has(row.roundId)) pushIssue(issues,`reviewRoundItems.${row.roundId}:${row.questionId}.roundId`,"missing round");
    if (!questions.has(row.questionId)) pushIssue(issues,`reviewRoundItems.${row.roundId}:${row.questionId}.questionId`,"missing question");
  }
  return issues;
}

export function assertCanonicalState(input: CanonicalState): asserts input is CanonicalState {
  const issues=canonicalStateValidationIssues(input);
  if (issues.length) fail(issues.map((issue)=>`${issue.path}: ${issue.message}`).join("; "));
}
