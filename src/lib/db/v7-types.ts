import type {
  Bank as BaseBank,
  BankFolder as BaseBankFolder,
  Note as BaseNote,
  PracticeRun,
  AttemptOutcome,
  QuestionGroup as BaseQuestionGroup,
  QuestionSolution,
  PracticeResponse,
  QuestionType,
  SyncFile as BaseSyncFile,
  SyncMeta as BaseSyncMeta,
  SyncTombstone as BaseSyncTombstone,
} from "../../types/types";

/** Current local-domain records used by the v9 sync wire. */
export interface BankV7 extends Omit<BaseBank, "questionCount"> {
  sortOrder: number;
  questionCount: number;
  /** Disabled banks stay synchronized/managed but are excluded from new study scopes. */
  enabled?: boolean;
}

export function isBankEnabled(bank: Pick<BankV7, "enabled">): boolean {
  return bank.enabled !== false;
}

export type BankFolderV7 = BaseBankFolder;
export type NoteV7 = BaseNote;
export type QuestionGroupV7 = BaseQuestionGroup;
export type SyncFileV7 = BaseSyncFile;
export type SyncMetaV7 = BaseSyncMeta;
export interface TombstoneV7 extends Omit<BaseSyncTombstone, "entityType"> {
  entityType: BaseSyncTombstone["entityType"] | "membership" | "imageAsset" | "note" | "attempt";
  /**
   * Causal-stability anchor: the deleting device's localSequence for the
   * deletion event. A tombstone is reclaimable once every known device's
   * reported watermark for the deleting device reaches this sequence.
   */
  sequence: number;
}

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

/** A question is independent of the bank memberships that reference it. */
export interface QuestionV7 {
  id: string;
  type: QuestionTypeV7;
  content: ContentBlock[];
  options: ContentBlock[][];
  /** Stable option IDs aligned with `options`; never derive identity from A/B/C. */
  optionIds?: string[];
  /** The single canonical answer representation persisted and synchronized. */
  solution: QuestionSolution;
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
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs: number }>;
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
  giveUps: number;
  totalElapsedMs: number;
  firstAttemptCorrect: boolean;
  hasBeenWrong: boolean;
  currentCorrectStreak: number;
  correctStreakAfterWrong: number;
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean; elapsedMs: number }>;
}

export type PracticeRunV7 = PracticeRun & { reviewRoundId?: string };

export interface ImageAsset {
  id: string;
  mimeType: "image/webp" | "image/jpeg" | "image/png";
  size: number;
  width: number;
  height: number;
  blob?: Blob;
}
