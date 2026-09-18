/** Canonical cascade-delete helpers for the change-set reducer. */
import type { CanonicalState } from "../db/types";
import { ensureQuestion, putTombstone } from "./change-set-projection-core";

function removeRun(state: CanonicalState, runId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  state.practiceRuns = state.practiceRuns.filter((row)=>row.id!==runId);
  state.practiceRunSources = state.practiceRunSources.filter((row)=>row.runId!==runId);
  state.practiceRunItems = state.practiceRunItems.filter((row)=>row.runId!==runId);
  putTombstone(state,"practiceRun",runId,deletedAt,deviceId,eventId,sequence);
}

export function updateBankDeleteCascade(
  state: CanonicalState, bankId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number,
): void {
  state.memberships=state.memberships.filter((row)=>row.bankId!==bankId);
  const runIds=new Set(state.practiceRunSources.filter((row)=>row.bankId===bankId).map((row)=>row.runId));
  for(const runId of runIds) removeRun(state,runId,deletedAt,deviceId,eventId,sequence);
  const affectedRounds=new Set(state.reviewRoundBanks.filter((row)=>row.bankId===bankId).map((row)=>row.roundId));
  state.reviewRoundBanks=state.reviewRoundBanks.filter((row)=>row.bankId!==bankId);
  state.reviewRounds=state.reviewRounds.map((round)=>affectedRounds.has(round.id)?{...round,updatedAt:deletedAt,deviceId}:round);
  state.banks=state.banks.filter((bank)=>bank.id!==bankId);
  putTombstone(state,"bank",bankId,deletedAt,deviceId,eventId,sequence);
}

function deleteQuestionRelations(state: CanonicalState, ids: ReadonlySet<string>, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  const keep=(id:string)=>!ids.has(id);
  state.questions=state.questions.filter((row)=>keep(row.id));
  state.memberships=state.memberships.filter((row)=>keep(row.questionId));
  state.attempts=state.attempts.filter((row)=>keep(row.questionId));
  state.notes=state.notes.filter((row)=>keep(row.questionId));

  const affectedRuns=new Set(state.practiceRunItems.filter((row)=>ids.has(row.questionId)).map((row)=>row.runId));
  state.practiceRunItems=state.practiceRunItems.filter((row)=>keep(row.questionId));
  state.practiceRuns=state.practiceRuns.map((run)=>affectedRuns.has(run.id)?{...run,updatedAt:deletedAt}:run);

  const affectedRounds=new Set(state.reviewRoundItems.filter((row)=>ids.has(row.questionId)).map((row)=>row.roundId));
  state.reviewRoundItems=state.reviewRoundItems.filter((row)=>keep(row.questionId));
  state.reviewRounds=state.reviewRounds.map((round)=>affectedRounds.has(round.id)?{...round,updatedAt:deletedAt,deviceId}:round);

  state.questionGroupItems=state.questionGroupItems.filter((row)=>keep(row.questionId));
  const liveGroups=new Set(state.questionGroupItems.map((row)=>row.groupId));
  const removedGroups=state.questionGroups.filter((group)=>!liveGroups.has(group.id));
  state.questionGroups=state.questionGroups.filter((group)=>liveGroups.has(group.id));
  for(const group of removedGroups) putTombstone(state,"questionGroup",group.id,deletedAt,deviceId,eventId,sequence);

  for(const questionId of ids) putTombstone(state,"question",questionId,deletedAt,deviceId,eventId,sequence);
}

export function updateQuestionDeleteCascade(state: CanonicalState, questionId: string, deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  ensureQuestion(state,questionId);
  deleteQuestionRelations(state,new Set([questionId]),deletedAt,deviceId,eventId,sequence);
}
export function updateQuestionsBulkDeleteCascade(state: CanonicalState, questionIds: readonly string[], deletedAt: string, deviceId: string, eventId: string, sequence: number): void {
  const ids=new Set(questionIds);
  for(const id of ids) ensureQuestion(state,id);
  deleteQuestionRelations(state,ids,deletedAt,deviceId,eventId,sequence);
}
