import { dbV7 } from "../db/db-v7";
import type { BankQuestionMembership, PracticeRunV7 } from "../db/v7-types";
import type { ChangeSetProjectionV7 } from "./change-set-v7-projection";
import type { ChangeSetV7, ChangeSetMutationV7 } from "./change-set-v7-types";

export interface DirtyInstallKeysV7 {
  banks: string[];
  bankFolders: string[];
  questions: string[];
  memberships: string[];
  imageAssets: string[];
  attempts: string[];
  attemptStats: string[];
  attemptDailyStats: string[];
  notes: string[];
  practiceRuns: string[];
  practiceRunStats: string[];
  questionGroups: string[];
  reviewRounds: string[];
  reviewRoundProgress: string[];
  tombstones: string[];
}

type DirtySets = { [K in keyof DirtyInstallKeysV7]: Set<string> };

function emptyDirtySets(): DirtySets {
  return {
    banks: new Set(),
    bankFolders: new Set(),
    questions: new Set(),
    memberships: new Set(),
    imageAssets: new Set(),
    attempts: new Set(),
    attemptStats: new Set(),
    attemptDailyStats: new Set(),
    notes: new Set(),
    practiceRuns: new Set(),
    practiceRunStats: new Set(),
    questionGroups: new Set(),
    reviewRounds: new Set(),
    reviewRoundProgress: new Set(),
    tombstones: new Set(),
  };
}

function tombstoneKey(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

function runBankIds(run: PracticeRunV7 | undefined): string[] {
  if (!run) return [];
  const ids = run.bankIds?.length ? run.bankIds : (run.bankId ? [run.bankId] : []);
  return [...new Set(ids.filter(Boolean))];
}

function membershipKey(bankId: string, questionId: string): string {
  return `${bankId}:${questionId}`;
}

function addQuestionUpsert(sets: DirtySets, questionId: string): void {
  sets.questions.add(questionId);
  // Successful upserts cannot coexist with a live tombstone, but include the
  // key so a dirty install also mirrors any legitimate reducer tombstone clear.
  sets.tombstones.add(tombstoneKey("question", questionId));
}

/**
 * Add primary keys directly named by one reducer mutation. Complex cascades
 * return false: the caller must use full reconcile because proving every
 * dependent deletion would otherwise duplicate the reducer's cascade graph.
 */
function addMutationKeys(sets: DirtySets, mutation: ChangeSetMutationV7): boolean {
  switch (mutation.kind) {
    case "bank.create":
    case "bank.update":
      sets.banks.add(mutation.bank.id);
      if (mutation.kind === "bank.create") sets.tombstones.add(tombstoneKey("bank", mutation.bank.id));
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
      addQuestionUpsert(sets, mutation.question.id);
      return true;
    case "question.delete":
    case "question.delete.cascade":
    case "question.bulk.delete":
      return false;
    case "question.bulk.upsert":
      mutation.questions.forEach((question) => addQuestionUpsert(sets, question.id));
      return true;
    case "question.split":
      addQuestionUpsert(sets, mutation.clone.id);
      mutation.memberships.forEach((membership) => sets.memberships.add(membership.key));
      for (const key of mutation.deletedMembershipKeys ?? []) {
        sets.memberships.add(key);
        sets.tombstones.add(tombstoneKey("membership", key));
      }
      if (mutation.note) sets.notes.add(mutation.note.questionId);
      return true;
    case "question.import":
      sets.banks.add(mutation.bank.id);
      mutation.questions.forEach((question) => addQuestionUpsert(sets, question.id));
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
      const key = mutation.key ?? membershipKey(mutation.bankId, mutation.questionId);
      sets.memberships.add(key);
      sets.banks.add(mutation.bankId);
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
      });
      if (mutation.bankId) sets.banks.add(mutation.bankId);
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
    case "attempt.update":
      sets.attempts.add(mutation.attempt.id);
      sets.tombstones.add(tombstoneKey("attempt", mutation.attempt.id));
      return true;
    case "attempt.delete":
      sets.attempts.add(mutation.attemptId);
      if (mutation.questionId) sets.attemptStats.add(mutation.questionId);
      sets.tombstones.add(tombstoneKey("attempt", mutation.attemptId));
      return true;
    case "practice.answer.submitted":
    case "practice.answer.updated":
      sets.attempts.add(mutation.attempt.id);
      sets.practiceRuns.add(mutation.runId);
      sets.attemptStats.add(mutation.questionId);
      sets.tombstones.add(tombstoneKey("attempt", mutation.attempt.id));
      return true;
    case "practice.answer.deleted":
      sets.attempts.add(mutation.attemptId);
      sets.practiceRuns.add(mutation.runId);
      sets.attemptStats.add(mutation.questionId);
      sets.tombstones.add(tombstoneKey("attempt", mutation.attemptId));
      return true;
    case "practice.run.saved":
      sets.practiceRuns.add(mutation.run.id);
      sets.tombstones.add(tombstoneKey("practiceRun", mutation.run.id));
      return true;
    case "practice.run.status.changed":
      sets.practiceRuns.add(mutation.run.id);
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
      sets.questionGroups.add(mutation.group.id);
      sets.tombstones.add(tombstoneKey("questionGroup", mutation.group.id));
      return true;
    case "questionGroup.deleted":
      sets.questionGroups.add(mutation.groupId);
      sets.tombstones.add(tombstoneKey("questionGroup", mutation.groupId));
      return true;
    case "review.round.saved":
    case "review.round.completed":
    case "review.round.archived":
      sets.reviewRounds.add(mutation.round.id);
      return true;
  }
}

function targetMembershipMap(target: ChangeSetProjectionV7, keys: Set<string>): Map<string, BankQuestionMembership> {
  const result = new Map<string, BankQuestionMembership>();
  if (!keys.size) return result;
  for (const membership of target.memberships) if (keys.has(membership.key)) result.set(membership.key, membership);
  return result;
}

function targetRunMap(target: ChangeSetProjectionV7, keys: Set<string>): Map<string, PracticeRunV7> {
  const result = new Map<string, PracticeRunV7>();
  if (!keys.size) return result;
  for (const run of target.practiceRuns) if (keys.has(run.id)) result.set(run.id, run);
  return result;
}

function targetAttemptMap(target: ChangeSetProjectionV7, keys: Set<string>): Map<string, ChangeSetProjectionV7["attempts"][number]> {
  const result = new Map<string, ChangeSetProjectionV7["attempts"][number]>();
  if (!keys.size) return result;
  for (const attempt of target.attempts) if (keys.has(attempt.id)) result.set(attempt.id, attempt);
  return result;
}

/**
 * Derive the smallest safe IndexedDB key closure for an ordinary sync install.
 * Returns null for reducer cascades whose dependency surface cannot be proven
 * from the mutation envelope alone; callers must fall back to full reconcile.
 *
 * The closure is based on CURRENT local rows plus the FINAL target projection.
 * This is important when local pending edits are already installed: only the
 * current→target difference matters, not transient states while remote/local
 * change-sets were replayed in memory.
 */
export async function deriveDirtyInstallKeysV7(
  target: ChangeSetProjectionV7,
  changes: readonly ChangeSetV7[],
): Promise<DirtyInstallKeysV7 | null> {
  if (!changes.length) return null;
  const sets = emptyDirtySets();
  const roundLinkRunIds = new Set<string>();

  for (const change of changes) {
    for (const mutation of change.mutations) {
      if (!addMutationKeys(sets, mutation)) return null;
      if (mutation.kind === "practice.run.saved" || mutation.kind === "practice.run.deleted") {
        roundLinkRunIds.add(mutation.kind === "practice.run.saved" ? mutation.run.id : mutation.runId);
      }
    }
  }

  // Membership changes alter the derived bank.questionCount. Union current and
  // target memberships so remove/split/import remain correct even when a local
  // pending edit has already changed the installed membership row.
  if (sets.memberships.size) {
    const keys = [...sets.memberships];
    const [current, targetByKey] = await Promise.all([
      dbV7.bankQuestionMemberships.bulkGet(keys),
      Promise.resolve(targetMembershipMap(target, sets.memberships)),
    ]);
    keys.forEach((key, index) => {
      const old = current[index];
      if (old) sets.banks.add(old.bankId);
      const next = targetByKey.get(key);
      if (next) sets.banks.add(next.bankId);
    });
  }

  // Run changes alter practiceRunStats for every bank referenced by either the
  // currently installed run or the final target run.
  if (sets.practiceRuns.size) {
    const runIds = [...sets.practiceRuns];
    const [currentRuns, targetById] = await Promise.all([
      dbV7.practiceRuns.bulkGet(runIds),
      Promise.resolve(targetRunMap(target, sets.practiceRuns)),
    ]);
    runIds.forEach((runId, index) => {
      runBankIds(currentRuns[index]).forEach((bankId) => sets.practiceRunStats.add(bankId));
      runBankIds(targetById.get(runId)).forEach((bankId) => sets.practiceRunStats.add(bankId));
    });
  }

  // Attempt changes alter per-question stats/daily stats/round progress. Again
  // union current and target question ids so a remote attempt.update that moves
  // an attempt between questions cleans both derived sides.
  if (sets.attempts.size) {
    const attemptIds = [...sets.attempts];
    const [currentAttempts, targetById] = await Promise.all([
      dbV7.attempts.bulkGet(attemptIds),
      Promise.resolve(targetAttemptMap(target, sets.attempts)),
    ]);
    attemptIds.forEach((attemptId, index) => {
      const old = currentAttempts[index];
      if (old) sets.attemptStats.add(old.questionId);
      const next = targetById.get(attemptId);
      if (next) sets.attemptStats.add(next.questionId);
    });
  }

  // Changing/deleting a run can change which review round its existing attempts
  // feed even when those attempt rows themselves are unchanged. Only run.saved
  // and run.deleted can alter that structural link; answer/status changes cannot.
  if (roundLinkRunIds.size) {
    const runIds = [...roundLinkRunIds];
    const currentAttempts = await dbV7.attempts.where("runId").anyOf(runIds).toArray();
    currentAttempts.forEach((attempt) => sets.attemptStats.add(attempt.questionId));
    target.attempts.forEach((attempt) => {
      if (roundLinkRunIds.has(attempt.runId)) sets.attemptStats.add(attempt.questionId);
    });
  }

  if (sets.attemptStats.size) {
    const questionIds = [...sets.attemptStats];
    const questionSet = sets.attemptStats;
    const [localDailyKeys, localRoundKeys] = await Promise.all([
      dbV7.attemptDailyStats.where("questionId").anyOf(questionIds).primaryKeys(),
      dbV7.reviewRoundProgress.where("questionId").anyOf(questionIds).primaryKeys(),
    ]);
    localDailyKeys.forEach((key) => sets.attemptDailyStats.add(String(key)));
    localRoundKeys.forEach((key) => sets.reviewRoundProgress.add(String(key)));
    for (const row of target.attemptDailyStats) if (questionSet.has(row.questionId)) sets.attemptDailyStats.add(row.key);
    for (const row of target.reviewRoundProgress) if (questionSet.has(row.questionId)) sets.reviewRoundProgress.add(row.key);
  }

  const result = {} as DirtyInstallKeysV7;
  for (const key of Object.keys(sets) as Array<keyof DirtyInstallKeysV7>) result[key] = [...sets[key]].sort();
  return result;
}
