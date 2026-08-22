import type {
  Bank as LegacyBank,
  BankFolder as LegacyBankFolder,
  Note as LegacyNote,
  PracticeRun,
  AttemptOutcome,
  QuestionGroup as LegacyQuestionGroup,
  QuestionSolution,
  PracticeResponse,
  QuestionType,
  SyncFile as LegacySyncFile,
  SyncMeta as LegacySyncMeta,
  SyncTombstone as LegacySyncTombstone,
} from "../../types/types";

/**
 * v7 reuses only the bank metadata concepts (name, folder, colour and order);
 * question membership and all learning records live in v7-owned tables.  The
 * v7 namespace never reads, migrates or falls back to the legacy database.
 */
export interface BankV7 extends Omit<LegacyBank, "questionCount"> {
  sortOrder: number;
  questionCount: number;
}

export type BankFolderV7 = LegacyBankFolder;
export type NoteV7 = LegacyNote;
export type QuestionGroupV7 = LegacyQuestionGroup;
export type SyncFileV7 = LegacySyncFile;
export type SyncMetaV7 = LegacySyncMeta;
export interface TombstoneV7 extends Omit<LegacySyncTombstone, "entityType"> {
  entityType: LegacySyncTombstone["entityType"] | "membership" | "imageAsset" | "note" | "attempt";
  /**
   * Causal-stability anchor: the deleting device's localSequence for the
   * deletion event.  A tombstone is reclaimable once every known device's
   * reported watermark for the deleting device reaches this sequence — the
   * Yorkie minVersionVector / Riak reaping rule (see SYNC_V7_DEVICE_RETIRE_DAYS).
   */
  sequence: number;
}

/** The question kinds currently supported by the v7 content model. */
export type QuestionTypeV7 = QuestionType;
export type { AttemptOutcome, PracticeResponse, QuestionSolution };

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
export interface QuestionV7 {
  id: string;
  type: QuestionTypeV7;
  content: ContentBlock[];
  options: ContentBlock[][];
  answer: string;
  /** Stable option IDs aligned with `options`; never derive identity from A/B/C. */
  optionIds?: string[];
  /** Structured solution; `answer` is retained as a legacy projection. */
  solution?: QuestionSolution;
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

export interface AttemptV7 {
  id: string;
  runId: string;
  questionId: string;
  selected: string;
  correct: boolean;
  elapsedMs: number;
  createdAt: string;
  deviceId: string;
  sourceBankId?: string;
  response?: PracticeResponse;
  outcome?: AttemptOutcome;
}

/** Global (bank-independent) attempt projection keyed only by question id. */
export interface AttemptStatsV7 {
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
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs?: number }>;
}

export interface AttemptDailyStatsV7 {
  key: string;
  date: string;
  questionId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
}

export interface PracticeRunStatsV7 {
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
  /** Optional on legacy rows; new/rebuilt rows carry the same evidence as global stats. */
  giveUps?: number;
  totalElapsedMs?: number;
  firstAttemptCorrect?: boolean;
  hasBeenWrong?: boolean;
  currentCorrectStreak?: number;
  correctStreakAfterWrong?: number;
  recentOutcomes?: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs?: number }>;
}

/** v7 only adds an optional review-round association to the existing run. */
export type PracticeRunV7 = PracticeRun & { reviewRoundId?: string };

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
