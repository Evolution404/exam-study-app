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
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  QuestionGroupItem,
  QuestionGroupRecord,
  Question,
  ReviewRoundBank,
  ReviewRoundItem,
  ReviewRoundRecord,
} from "../db/types";

export const CHANGE_SET_FORMAT = 8 as const;
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
  | { kind: "attempt.create"; attempt: Attempt }
  | { kind: "attempt.delete"; attemptId: string; questionId?: string; deletedAt?: string }
  | {
      kind: "practice.answer.submitted";
      attempt: Attempt;
      runRecord: PracticeRunRecord;
      item: PracticeRunItem;
    }
  | {
      kind: "practice.answer.deleted";
      attemptId: string;
      runRecord: PracticeRunRecord;
      item: PracticeRunItem;
      deletedAt?: string;
    }
  | {
      kind: "practice.run.saved";
      record: PracticeRunRecord;
      sources: PracticeRunSource[];
      items: PracticeRunItem[];
      definition?: ImmutablePayloadRef;
    }
  | { kind: "practice.run.status.changed"; record: PracticeRunRecord; definition?: ImmutablePayloadRef }
  | { kind: "practice.run.deleted"; runId: string; deletedAt?: string }
  | { kind: "note.upserted"; note: Note }
  | { kind: "note.deleted"; questionId: string; deletedAt?: string }
  | { kind: "questionGroup.saved"; record: QuestionGroupRecord; items: QuestionGroupItem[] }
  | { kind: "questionGroup.deleted"; groupId: string; deletedAt?: string }
  | { kind: "review.round.saved"; record: ReviewRoundRecord; banks: ReviewRoundBank[]; items: ReviewRoundItem[] }
  | { kind: "review.round.completed"; record: ReviewRoundRecord; banks: ReviewRoundBank[]; items: ReviewRoundItem[] }
  | { kind: "review.round.archived"; record: ReviewRoundRecord; banks: ReviewRoundBank[]; items: ReviewRoundItem[] };

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

