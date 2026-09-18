import { datePart } from "../db/db-core";
import type { ChangeSet, ChangeSetMutation } from "./change-set-types";

export interface ProjectionImpact {
  questionIds: Set<string>;
  questionDailyKeys: Set<string>;
  reviewRoundQuestionKeys: Set<string>;
  bankIds: Set<string>;
  bankRunKeys: Set<string>;
  runIds: Set<string>;
}

export function emptyProjectionImpact(): ProjectionImpact {
  return {
    questionIds: new Set(),
    questionDailyKeys: new Set(),
    reviewRoundQuestionKeys: new Set(),
    bankIds: new Set(),
    bankRunKeys: new Set(),
    runIds: new Set(),
  };
}

function addAttemptImpact(impact: ProjectionImpact, attempt: { questionId: string; createdAt: string; reviewRoundId?: string }) {
  impact.questionIds.add(attempt.questionId);
  impact.questionDailyKeys.add(`${datePart(attempt.createdAt)}:${attempt.questionId}`);
  if (attempt.reviewRoundId) impact.reviewRoundQuestionKeys.add(`${attempt.reviewRoundId}:${attempt.questionId}`);
}

function bankIdFromMembershipKey(key: string): string | undefined {
  const separator = key.indexOf(":");
  return separator > 0 ? key.slice(0, separator) : undefined;
}

function addMutationImpact(impact: ProjectionImpact, mutation: ChangeSetMutation): void {
  switch (mutation.kind) {
    case "membership.save":
      impact.bankIds.add(mutation.membership.bankId);
      return;
    case "membership.bulk.save":
      mutation.memberships.forEach((row) => impact.bankIds.add(row.bankId));
      return;
    case "membership.remove":
      impact.bankIds.add(mutation.bankId);
      return;
    case "membership.bulk.remove":
      mutation.keys.forEach((key) => {
        const bankId = bankIdFromMembershipKey(key);
        if (bankId) impact.bankIds.add(bankId);
      });
      if (mutation.bankId) impact.bankIds.add(mutation.bankId);
      return;
    case "question.split":
      mutation.memberships.forEach((row) => impact.bankIds.add(row.bankId));
      (mutation.deletedMembershipKeys ?? []).forEach((key) => {
        const bankId = bankIdFromMembershipKey(key);
        if (bankId) impact.bankIds.add(bankId);
      });
      return;
    case "question.import":
      impact.bankIds.add(mutation.bank.id);
      mutation.memberships.forEach((row) => impact.bankIds.add(row.bankId));
      return;
    case "attempt.create":
      addAttemptImpact(impact, mutation.attempt);
      return;
    case "attempt.delete":
      if (mutation.questionId) impact.questionIds.add(mutation.questionId);
      return;
    case "practice.answer.submitted":
      addAttemptImpact(impact, mutation.attempt);
      impact.runIds.add(mutation.runRecord.id);
      return;
    case "practice.answer.deleted":
      impact.questionIds.add(mutation.item.questionId);
      impact.runIds.add(mutation.runRecord.id);
      return;
    case "practice.run.saved":
      impact.runIds.add(mutation.record.id);
      mutation.sources.forEach((row) => {
        impact.bankIds.add(row.bankId);
        impact.bankRunKeys.add(`${row.bankId}:${row.runId}`);
      });
      return;
    case "practice.run.status.changed":
      impact.runIds.add(mutation.record.id);
      return;
    case "practice.run.deleted":
      impact.runIds.add(mutation.runId);
      return;
    case "bank.delete":
    case "bank.delete.cascade":
      impact.bankIds.add(mutation.bankId);
      return;
    default:
      return;
  }
}

export function planProjectionImpact(changes: readonly ChangeSet[]): ProjectionImpact {
  const impact = emptyProjectionImpact();
  for (const change of changes) {
    for (const mutation of change.mutations) addMutationImpact(impact, mutation);
  }
  return impact;
}

export function projectionImpactIsEmpty(impact: ProjectionImpact): boolean {
  return impact.questionIds.size === 0
    && impact.questionDailyKeys.size === 0
    && impact.reviewRoundQuestionKeys.size === 0
    && impact.bankIds.size === 0
    && impact.bankRunKeys.size === 0
    && impact.runIds.size === 0;
}
