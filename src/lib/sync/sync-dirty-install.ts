import type { CanonicalState } from "../db/types";
import type { ChangeSet, ChangeSetMutation } from "./change-set-types";

export interface DirtyInstallKeys {
  banks: readonly string[];
  bankFolders: readonly string[];
  questions: readonly string[];
  memberships: readonly string[];
  imageAssets: readonly string[];
  attempts: readonly string[];
  notes: readonly string[];
  practiceRuns: readonly string[];
  practiceRunSources: readonly string[];
  practiceRunItems: readonly string[];
  questionGroups: readonly string[];
  questionGroupItems: readonly string[];
  reviewRounds: readonly string[];
  reviewRoundBanks: readonly string[];
  reviewRoundItems: readonly string[];
  tombstones: readonly string[];
}

type DirtySets = { [K in keyof DirtyInstallKeys]: Set<string> };

function emptyDirtySets(): DirtySets {
  return {
    banks: new Set(),
    bankFolders: new Set(),
    questions: new Set(),
    memberships: new Set(),
    imageAssets: new Set(),
    attempts: new Set(),
    notes: new Set(),
    practiceRuns: new Set(),
    practiceRunSources: new Set(),
    practiceRunItems: new Set(),
    questionGroups: new Set(),
    questionGroupItems: new Set(),
    reviewRounds: new Set(),
    reviewRoundBanks: new Set(),
    reviewRoundItems: new Set(),
    tombstones: new Set(),
  };
}

function tombstoneKey(type: string, id: string): string {
  return `${type}:${id}`;
}

function relationKey(parentId: string, childId: string): string {
  return `${parentId}:${childId}`;
}

function addMutationKeys(sets: DirtySets, mutation: ChangeSetMutation): boolean {
  switch (mutation.kind) {
    case "bank.create":
    case "bank.update":
      sets.banks.add(mutation.bank.id);
      sets.tombstones.add(tombstoneKey("bank", mutation.bank.id));
      return true;
    case "bank.reorder":
      mutation.bankIds.forEach((id) => sets.banks.add(id));
      return true;
    case "bank.delete":
    case "bank.delete.cascade":
      return false;
    case "bankFolder.save":
      sets.bankFolders.add(mutation.folder.id);
      sets.tombstones.add(tombstoneKey("bankFolder", mutation.folder.id));
      return true;
    case "bankFolder.delete":
      sets.bankFolders.add(mutation.folderId);
      sets.tombstones.add(tombstoneKey("bankFolder", mutation.folderId));
      return true;
    case "question.upsert":
      sets.questions.add(mutation.question.id);
      sets.tombstones.add(tombstoneKey("question", mutation.question.id));
      return true;
    case "question.delete":
    case "question.delete.cascade":
    case "question.bulk.delete":
      return false;
    case "question.bulk.upsert":
      mutation.questions.forEach((question) => {
        sets.questions.add(question.id);
        sets.tombstones.add(tombstoneKey("question", question.id));
      });
      return true;
    case "question.split":
      sets.questions.add(mutation.clone.id);
      sets.tombstones.add(tombstoneKey("question", mutation.clone.id));
      mutation.memberships.forEach((membership) => {
        sets.memberships.add(membership.key);
      });
      for (const key of mutation.deletedMembershipKeys ?? []) {
        sets.memberships.add(key);
        sets.tombstones.add(tombstoneKey("membership", key));
        // Bank question counts are local projections; relation dirtiness is sufficient.
      }
      if (mutation.note) sets.notes.add(mutation.note.questionId);
      return true;
    case "question.import":
      sets.banks.add(mutation.bank.id);
      mutation.questions.forEach((question) => {
        sets.questions.add(question.id);
        sets.tombstones.add(tombstoneKey("question", question.id));
      });
      mutation.memberships.forEach((membership) => {
        sets.memberships.add(membership.key);
        sets.tombstones.add(tombstoneKey("membership", membership.key));
      });
      for (const asset of mutation.images ?? []) {
        sets.imageAssets.add(asset.id);
        sets.tombstones.add(tombstoneKey("imageAsset", asset.id));
      }
      return true;
    case "membership.save":
      sets.memberships.add(mutation.membership.key);
      sets.tombstones.add(tombstoneKey("membership", mutation.membership.key));
      return true;
    case "membership.remove": {
      const key = mutation.key ?? relationKey(mutation.bankId, mutation.questionId);
      sets.memberships.add(key);
      sets.tombstones.add(tombstoneKey("membership", key));
      return true;
    }
    case "membership.bulk.save":
      mutation.memberships.forEach((membership) => {
        sets.memberships.add(membership.key);
        sets.tombstones.add(tombstoneKey("membership", membership.key));
      });
      return true;
    case "membership.bulk.remove":
      mutation.keys.forEach((key) => {
        sets.memberships.add(key);
        sets.tombstones.add(tombstoneKey("membership", key));
        // Bank question counts are local projections; relation dirtiness is sufficient.
      });
      return true;
    case "image.asset.save":
      sets.imageAssets.add(mutation.asset.id);
      sets.tombstones.add(tombstoneKey("imageAsset", mutation.asset.id));
      return true;
    case "image.asset.delete":
      sets.imageAssets.add(mutation.assetId);
      sets.tombstones.add(tombstoneKey("imageAsset", mutation.assetId));
      return true;
    case "attempt.create":
      sets.attempts.add(mutation.attempt.id);
      sets.tombstones.add(tombstoneKey("attempt", mutation.attempt.id));
      return true;
    case "attempt.delete":
      sets.attempts.add(mutation.attemptId);
      sets.tombstones.add(tombstoneKey("attempt", mutation.attemptId));
      return true;
    case "practice.answer.submitted":
      sets.attempts.add(mutation.attempt.id);
      sets.practiceRuns.add(mutation.runRecord.id);
      sets.practiceRunItems.add(relationKey(mutation.item.runId, mutation.item.questionId));
      sets.tombstones.add(tombstoneKey("attempt", mutation.attempt.id));
      return true;
    case "practice.answer.deleted":
      sets.attempts.add(mutation.attemptId);
      sets.practiceRuns.add(mutation.runRecord.id);
      sets.practiceRunItems.add(relationKey(mutation.item.runId, mutation.item.questionId));
      sets.tombstones.add(tombstoneKey("attempt", mutation.attemptId));
      return true;
    case "practice.run.saved":
      sets.practiceRuns.add(mutation.record.id);
      mutation.sources.forEach((row) => sets.practiceRunSources.add(relationKey(row.runId, row.bankId)));
      mutation.items.forEach((row) => sets.practiceRunItems.add(relationKey(row.runId, row.questionId)));
      sets.tombstones.add(tombstoneKey("practiceRun", mutation.record.id));
      return true;
    case "practice.run.status.changed":
      sets.practiceRuns.add(mutation.record.id);
      return true;
    case "practice.run.deleted":
      sets.practiceRuns.add(mutation.runId);
      sets.tombstones.add(tombstoneKey("practiceRun", mutation.runId));
      return true;
    case "note.upserted":
      sets.notes.add(mutation.note.questionId);
      sets.tombstones.add(tombstoneKey("note", mutation.note.questionId));
      return true;
    case "note.deleted":
      sets.notes.add(mutation.questionId);
      sets.tombstones.add(tombstoneKey("note", mutation.questionId));
      return true;
    case "questionGroup.saved":
      sets.questionGroups.add(mutation.record.id);
      mutation.items.forEach((row) => sets.questionGroupItems.add(relationKey(row.groupId, row.questionId)));
      sets.tombstones.add(tombstoneKey("questionGroup", mutation.record.id));
      return true;
    case "questionGroup.deleted":
      sets.questionGroups.add(mutation.groupId);
      sets.tombstones.add(tombstoneKey("questionGroup", mutation.groupId));
      return true;
    case "review.round.saved":
    case "review.round.completed":
    case "review.round.archived":
      sets.reviewRounds.add(mutation.record.id);
      mutation.banks.forEach((row) => sets.reviewRoundBanks.add(relationKey(row.roundId, row.bankId)));
      mutation.items.forEach((row) => sets.reviewRoundItems.add(relationKey(row.roundId, row.questionId)));
      return true;
  }
}

export async function deriveDirtyInstallKeys(
  _target: CanonicalState,
  changes: readonly ChangeSet[],
): Promise<DirtyInstallKeys | null> {
  if (!changes.length) return null;
  const sets = emptyDirtySets();
  for (const change of changes) {
    for (const mutation of change.mutations) {
      if (!addMutationKeys(sets, mutation)) return null;
    }
  }
  const result = {} as DirtyInstallKeys;
  for (const key of Object.keys(sets) as Array<keyof DirtyInstallKeys>) result[key] = [...sets[key]].sort();
  return result;
}
