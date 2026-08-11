import type {
  Bank as LegacyBank,
  BankFolder as LegacyBankFolder,
  Note as LegacyNote,
  PracticeRun,
  QuestionGroup as LegacyQuestionGroup,
  QuestionType,
  SyncFile as LegacySyncFile,
  SyncMeta as LegacySyncMeta,
  SyncTombstone as LegacySyncTombstone,
} from "./types";

/**
 * v6 keeps the bank metadata shape familiar to the existing UI, but the
 * question count is always derived from the membership join table.  The
 * optional legacy fields are intentionally retained for a painless UI
 * integration; v6 never stores a bank id on a question.
 */
export interface BankV6 extends Omit<LegacyBank, "questionCount"> {
  sortOrder: number;
  questionCount: number;
}

export type BankFolderV6 = LegacyBankFolder;
export type NoteV6 = LegacyNote;
export type QuestionGroupV6 = LegacyQuestionGroup;
export type SyncFileV6 = LegacySyncFile;
export type SyncMetaV6 = LegacySyncMeta;
export interface TombstoneV6 extends Omit<LegacySyncTombstone, "entityType"> {
  entityType: LegacySyncTombstone["entityType"] | "membership";
}

/** The question kinds currently supported by the v6 content model. */
export type QuestionTypeV6 = QuestionType;

export interface TextContentBlock {
  id: string;
  type: "text";
  text: string;
}

export interface ImageContentBlock {
  id: string;
  type: "image";
  assetId: string;
  alt?: string;
  caption?: string;
}

export type ContentBlock = TextContentBlock | ImageContentBlock;

/**
 * A question is content-addressed independently of the bank(s) that contain
 * it.  Bank membership is represented by BankQuestionMembership below.
 */
export interface QuestionV6 {
  id: string;
  type: QuestionTypeV6;
  content: ContentBlock[];
  options: ContentBlock[][];
  answer: string;
  tags: string[];
  favorite?: boolean;
  contentFingerprint: string;
  updatedAt: string;
  deviceId: string;
}

export interface BankQuestionMembership {
  key: string;
  bankId: string;
  questionId: string;
  sortOrder: number;
  addedAt: string;
  updatedAt: string;
  deviceId: string;
}

export interface AttemptV6 {
  id: string;
  runId: string;
  questionId: string;
  selected: string;
  correct: boolean;
  elapsedMs: number;
  createdAt: string;
  deviceId: string;
  sourceBankId?: string;
}

/** Global (bank-independent) attempt projection keyed only by question id. */
export interface AttemptStatsV6 {
  questionId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
  firstAttemptAt: string;
  firstAttemptCorrect: boolean;
  latestAttemptAt: string;
  hasBeenWrong: boolean;
  correctStreakAfterWrong: number;
  currentCorrectStreak: number;
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean }>;
}

export interface AttemptDailyStatsV6 {
  key: string;
  date: string;
  questionId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
}

export interface PracticeRunStatsV6 {
  key: string;
  bankId: string;
  total: number;
  completed: number;
  inProgress: number;
  abandoned: number;
  latestUpdatedAt: string;
}

export type ReviewRoundStatus = "active" | "completed" | "archived";

export interface ReviewRound {
  id: string;
  name: string;
  bankIds: string[];
  startedAt: string;
  status: ReviewRoundStatus;
  completedAt?: string;
  finalQuestionIds?: string[];
  createdAt: string;
  updatedAt: string;
  deviceId: string;
}

export interface ReviewRoundProgress {
  key: string;
  roundId: string;
  questionId: string;
  attempts: number;
  correct: number;
  wrong: number;
  firstAttemptAt: string;
  latestAttemptAt: string;
}

export interface V6Event {
  id: string;
  type: V6EventType;
  payload: unknown;
  deviceId: string;
  sequence: number;
  createdAt: string;
  /** 0 is a local pending event; 1 marks an event applied from sync. */
  synced: 0 | 1;
}

export type V6EventType =
  | "bank.created"
  | "bank.updated"
  | "bank.deleted"
  | "bankFolder.saved"
  | "bankFolder.deleted"
  | "question.upserted"
  | "question.deleted"
  | "membership.saved"
  | "membership.removed"
  | "question.split"
  | "attempt.created"
  | "practice.answer.submitted"
  | "practice.run.saved"
  | "practice.run.status.changed"
  | "note.upserted"
  | "questionGroup.saved"
  | "questionGroup.deleted"
  | "review.round.saved"
  | "review.round.completed"
  | "review.round.archived"
  | "image.asset.saved";

/** v6 only adds an optional review-round association to the existing run. */
export type PracticeRunV6 = PracticeRun & { reviewRoundId?: string };

/**
 * A remote image is an immutable blob-addressed object in the sync vault.
 * `blob` is the local browser cache and is deliberately not part of the
 * remote descriptor.
 */
export interface ImageAssetRemoteDescriptor {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
}

export interface ImageAsset {
  id: string;
  mimeType: "image/webp" | "image/jpeg" | "image/png";
  size: number;
  width: number;
  height: number;
  remote?: ImageAssetRemoteDescriptor;
  blob?: Blob;
}
