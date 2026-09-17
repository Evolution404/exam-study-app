/**
 * The local change-set protocol.
 *
 * Change sets are the only mutable unit that is handed to a queue/sync
 * implementation.  Their immutable content is deliberately small and
 * content-addressed: publication/claim state belongs in a queue record and
 * is never included in `digest`.
 */
import type {
  Attempt,
  BankFolder,
  BankQuestionMembership,
  Bank,
  ImageAsset,
  Note,
  PracticeRun,
  QuestionGroup,
  Question,
  ReviewRound,
} from "../db/types";
import type { PracticeAnswer } from "../db/db";

export const CHANGE_SET_FORMAT = 7 as const;
export const CHANGE_SET_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type ChangeSetReplayPhase =
  | "assets"
  | "folders"
  | "banks"
  | "questions"
  | "memberships"
  | "runs"
  | "answers"
  | "annotations"
  | "deletes";

export interface ImmutablePayloadRef {
  path: string;
  sha256: string;
  size: number;
  kind?: string;
}

export interface ChangeSetEntityRef {
  type: string;
  id: string;
}

export type ChangeSetMutation =
  | { kind: "bank.create"; bank: Bank }
  | { kind: "bank.update"; bank: Bank; previous?: Bank }
  | { kind: "bank.reorder"; bankIds: string[]; folderId?: string; updatedAt?: string }
  | { kind: "bank.delete"; bankId: string; deletedAt?: string; cascade?: boolean }
  | { kind: "bank.delete.cascade"; bankId: string; deletedAt?: string; questionIds?: string[] }
  | { kind: "bankFolder.save"; folder: BankFolder }
  | { kind: "bankFolder.delete"; folderId: string; deletedAt?: string }
  | { kind: "question.upsert"; question: Question }
  | { kind: "question.delete"; questionId: string; deletedAt?: string; cascade?: boolean }
  | { kind: "question.delete.cascade"; questionId: string; deletedAt?: string }
  | {
      kind: "question.split";
      originalQuestionId: string;
      clone: Question;
      memberships: BankQuestionMembership[];
      deletedMembershipKeys?: string[];
      note?: Note;
    }
  | {
      kind: "question.import";
      bank: Bank;
      questions: Question[];
      memberships: BankQuestionMembership[];
      images?: ImageAsset[];
      dedupeFingerprints?: string[];
    }
  | { kind: "question.bulk.upsert"; questions: Question[] }
  | { kind: "question.bulk.delete"; questionIds: string[]; deletedAt?: string; cascade?: boolean }
  | { kind: "membership.save"; membership: BankQuestionMembership }
  | { kind: "membership.remove"; bankId: string; questionId: string; key?: string; removedAt?: string }
  | { kind: "membership.bulk.save"; memberships: BankQuestionMembership[] }
  | { kind: "membership.bulk.remove"; keys: string[]; bankId?: string; removedAt?: string }
  | { kind: "image.asset.save"; asset: Omit<ImageAsset, "blob"> }
  | { kind: "image.asset.delete"; assetId: string; deletedAt?: string }
  | { kind: "attempt.create"; attempt: Attempt; reviewRoundId?: string }
  | { kind: "attempt.update"; attempt: Attempt; reviewRoundId?: string }
  | { kind: "attempt.delete"; attemptId: string; questionId?: string; deletedAt?: string }
  | {
      kind: "practice.answer.submitted";
      attempt: Attempt;
      answer: PracticeAnswer;
      runId: string;
      questionId: string;
      reviewRoundId?: string;
    }
  | {
      kind: "practice.answer.updated";
      attempt: Attempt;
      answer: PracticeAnswer;
      runId: string;
      questionId: string;
      reviewRoundId?: string;
    }
  | { kind: "practice.answer.deleted"; attemptId: string; runId: string; questionId: string; reviewRoundId?: string; deletedAt?: string }
  | { kind: "practice.run.saved"; run: PracticeRun; definition?: ImmutablePayloadRef }
  | { kind: "practice.run.status.changed"; run: PracticeRun; definition?: ImmutablePayloadRef }
  | { kind: "practice.run.deleted"; runId: string; deletedAt?: string }
  | { kind: "note.upserted"; note: Note }
  | { kind: "note.deleted"; questionId: string; deletedAt?: string }
  | { kind: "questionGroup.saved"; group: QuestionGroup }
  | { kind: "questionGroup.deleted"; groupId: string; deletedAt?: string }
  | { kind: "review.round.saved"; round: ReviewRound }
  | { kind: "review.round.completed"; round: ReviewRound }
  | { kind: "review.round.archived"; round: ReviewRound };

export type ChangeSetKind = ChangeSetMutation["kind"] | "batch";

/** Immutable change-set value. `publication` is intentionally not a field. */
export interface ChangeSet {
  formatVersion: typeof CHANGE_SET_FORMAT;
  id: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind: ChangeSetKind;
  mutations: ChangeSetMutation[];
  entityRefs: ChangeSetEntityRef[];
  payloadRefs?: ImmutablePayloadRef[];
  digest: string;
}

export interface CreateChangeSetInput {
  id?: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind?: ChangeSetKind;
  mutations?: readonly ChangeSetMutation[];
  /** Convenience for callers creating a one-mutation set. */
  mutation?: ChangeSetMutation;
  entityRefs?: readonly ChangeSetEntityRef[];
  payloadRefs?: readonly ImmutablePayloadRef[];
}

export interface ChangeSetPublicationState {
  state: "pending" | "claimed" | "published" | "acknowledged" | "cancelled";
  claimId?: string;
  claimedAt?: string;
  publishedAt?: string;
  acknowledgedAt?: string;
}

export interface ChangeSetPolicy {
  editable: boolean;
  cancellable: boolean;
  reason?: string;
}

export interface ChangeSetDependency {
  requires: string[];
  conflicts: string[];
  phase: ChangeSetReplayPhase;
}

export interface ChangeSetQueueBlocker {
  changeSetId: string;
  code: "missing-dependency" | "cascade-required" | "conflict";
  message: string;
  requires?: string[];
}

export interface ChangeSetQueuePlan {
  ordered: ChangeSet[];
  phases: Record<ChangeSetReplayPhase, ChangeSet[]>;
  blockers: ChangeSetQueueBlocker[];
  digest: string;
}

export interface ClaimedBatch {
  claimId: string;
  changeSetIds: string[];
  digest: string;
}

