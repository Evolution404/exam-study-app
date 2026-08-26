/**
 * The v7 local change-set protocol.
 *
 * Change sets are the only mutable unit that is handed to a queue/sync
 * implementation.  Their immutable content is deliberately small and
 * content-addressed: publication/claim state belongs in a queue record and
 * is never included in `digest`.
 */
import type {
  AttemptV7,
  BankFolderV7,
  BankQuestionMembership,
  BankV7,
  ImageAsset,
  NoteV7,
  PracticeRunV7,
  QuestionGroupV7,
  QuestionV7,
  ReviewRound,
} from "../db/v7-types";
import type { PracticeAnswerV7 } from "../db/db-v7";

export const CHANGE_SET_V7_FORMAT = 7 as const;
export const CHANGE_SET_V7_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export type ChangeSetReplayPhaseV7 =
  | "assets"
  | "folders"
  | "banks"
  | "questions"
  | "memberships"
  | "runs"
  | "answers"
  | "annotations"
  | "deletes";

export interface ImmutablePayloadRefV7 {
  path: string;
  sha256: string;
  size: number;
  kind?: string;
}

export interface ChangeSetEntityRefV7 {
  type: string;
  id: string;
}

export type ChangeSetMutationV7 =
  | { kind: "bank.create"; bank: BankV7 }
  | { kind: "bank.update"; bank: BankV7; previous?: BankV7 }
  | { kind: "bank.reorder"; bankIds: string[]; folderId?: string; updatedAt?: string }
  | { kind: "bank.delete"; bankId: string; deletedAt?: string; cascade?: boolean }
  | { kind: "bank.delete.cascade"; bankId: string; deletedAt?: string; questionIds?: string[] }
  | { kind: "bankFolder.save"; folder: BankFolderV7 }
  | { kind: "bankFolder.delete"; folderId: string; deletedAt?: string }
  | { kind: "question.upsert"; question: QuestionV7 }
  | { kind: "question.delete"; questionId: string; deletedAt?: string; cascade?: boolean }
  | { kind: "question.delete.cascade"; questionId: string; deletedAt?: string }
  | {
      kind: "question.split";
      originalQuestionId: string;
      clone: QuestionV7;
      memberships: BankQuestionMembership[];
      deletedMembershipKeys?: string[];
      note?: NoteV7;
    }
  | {
      kind: "question.import";
      bank: BankV7;
      questions: QuestionV7[];
      memberships: BankQuestionMembership[];
      images?: ImageAsset[];
      dedupeFingerprints?: string[];
    }
  | { kind: "question.bulk.upsert"; questions: QuestionV7[] }
  | { kind: "question.bulk.delete"; questionIds: string[]; deletedAt?: string; cascade?: boolean }
  | { kind: "membership.save"; membership: BankQuestionMembership }
  | { kind: "membership.remove"; bankId: string; questionId: string; key?: string; removedAt?: string }
  | { kind: "membership.bulk.save"; memberships: BankQuestionMembership[] }
  | { kind: "membership.bulk.remove"; keys: string[]; bankId?: string; removedAt?: string }
  | { kind: "image.asset.save"; asset: Omit<ImageAsset, "blob"> }
  | { kind: "image.asset.delete"; assetId: string; deletedAt?: string }
  | { kind: "attempt.create"; attempt: AttemptV7; reviewRoundId?: string }
  | { kind: "attempt.update"; attempt: AttemptV7; reviewRoundId?: string }
  | { kind: "attempt.delete"; attemptId: string; questionId?: string; deletedAt?: string }
  | {
      kind: "practice.answer.submitted";
      attempt: AttemptV7;
      answer: PracticeAnswerV7;
      runId: string;
      questionId: string;
      reviewRoundId?: string;
    }
  | {
      kind: "practice.answer.updated";
      attempt: AttemptV7;
      answer: PracticeAnswerV7;
      runId: string;
      questionId: string;
      reviewRoundId?: string;
    }
  | { kind: "practice.answer.deleted"; attemptId: string; runId: string; questionId: string; reviewRoundId?: string; deletedAt?: string }
  | { kind: "practice.run.saved"; run: PracticeRunV7; definition?: ImmutablePayloadRefV7 }
  | { kind: "practice.run.status.changed"; run: PracticeRunV7; definition?: ImmutablePayloadRefV7 }
  | { kind: "practice.run.deleted"; runId: string; deletedAt?: string }
  | { kind: "note.upserted"; note: NoteV7 }
  | { kind: "note.deleted"; questionId: string; deletedAt?: string }
  | { kind: "questionGroup.saved"; group: QuestionGroupV7 }
  | { kind: "questionGroup.deleted"; groupId: string; deletedAt?: string }
  | { kind: "review.round.saved"; round: ReviewRound }
  | { kind: "review.round.completed"; round: ReviewRound }
  | { kind: "review.round.archived"; round: ReviewRound };

export type ChangeSetKindV7 = ChangeSetMutationV7["kind"] | "batch";

/** Immutable change-set value. `publication` is intentionally not a field. */
export interface ChangeSetV7 {
  formatVersion: typeof CHANGE_SET_V7_FORMAT;
  id: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind: ChangeSetKindV7;
  mutations: ChangeSetMutationV7[];
  entityRefs: ChangeSetEntityRefV7[];
  payloadRefs?: ImmutablePayloadRefV7[];
  digest: string;
}

export interface CreateChangeSetV7Input {
  id?: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind?: ChangeSetKindV7;
  mutations?: readonly ChangeSetMutationV7[];
  /** Convenience for callers creating a one-mutation set. */
  mutation?: ChangeSetMutationV7;
  entityRefs?: readonly ChangeSetEntityRefV7[];
  payloadRefs?: readonly ImmutablePayloadRefV7[];
}

export interface ChangeSetPublicationStateV7 {
  state: "pending" | "claimed" | "published" | "acknowledged" | "cancelled";
  claimId?: string;
  claimedAt?: string;
  publishedAt?: string;
  acknowledgedAt?: string;
}

export interface ChangeSetPolicyV7 {
  editable: boolean;
  cancellable: boolean;
  reason?: string;
}

export interface ChangeSetDependencyV7 {
  requires: string[];
  conflicts: string[];
  phase: ChangeSetReplayPhaseV7;
}

export interface ChangeSetQueueBlockerV7 {
  changeSetId: string;
  code: "missing-dependency" | "cascade-required" | "conflict";
  message: string;
  requires?: string[];
}

export interface ChangeSetQueuePlanV7 {
  ordered: ChangeSetV7[];
  phases: Record<ChangeSetReplayPhaseV7, ChangeSetV7[]>;
  blockers: ChangeSetQueueBlockerV7[];
  digest: string;
}

export interface ClaimedBatchV7 {
  claimId: string;
  changeSetIds: string[];
  digest: string;
}

