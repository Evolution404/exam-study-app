import type {
  BankFolder as BaseBankFolder,
  Note as BaseNote,
  PracticeRun as BasePracticeRun,
  AttemptOutcome,
  QuestionGroup as BaseQuestionGroup,
  QuestionSolution,
  PracticeResponse,
  QuestionType as BaseQuestionType,
  SyncFile as BaseSyncFile,
  SyncMeta as BaseSyncMeta,
  SyncTombstone as BaseSyncTombstone,
} from "../../types/types";

/** Canonical persisted bank fact. Rebuildable statistics do not belong here. */
export interface Bank {
  id: string;
  name: string;
  displayName?: string;
  description?: string;
  color?: string;
  folderId?: string;
  sortOrder: number;
  updatedAt?: string;
  deviceId?: string;
  syncEventId?: string;
  questionCount: number;
  importedAt: string;
  /** Disabled banks stay synchronized/managed but are excluded from new study scopes. */
  enabled?: boolean;
}

export function isBankEnabled(bank: Pick<Bank, "enabled">): boolean {
  return bank.enabled !== false;
}

export type BankFolder = BaseBankFolder;
export type Note = BaseNote;
export type QuestionGroup = BaseQuestionGroup;
export interface QuestionGroupRecord {
  id: string;
  name: string;
  type: BaseQuestionGroup["type"];
  description: string;
  createdAt: string;
  updatedAt: string;
  deviceId: string;
  syncEventId?: string;
}
export type SyncFile = BaseSyncFile;
export type SyncMeta = BaseSyncMeta;
export interface Tombstone {
  key: string;
  entityType: BaseSyncTombstone["entityType"] | "membership" | "imageAsset" | "note" | "attempt";
  entityId: string;
  deletedAt: string;
  deviceId: string;
  eventId: string;
  /**
   * Causal-stability anchor: the deleting device's localSequence for the
   * deletion event. A tombstone is reclaimable once every known device's
   * reported watermark for the deleting device reaches this sequence.
   */
  sequence: number;
}

export type QuestionType = BaseQuestionType;
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
export interface Question {
  id: string;
  type: QuestionType;
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

export interface Attempt {
  id: string;
  runId: string;
  questionId: string;
  reviewRoundId?: string;
  selected: string;
  correct: boolean;
  elapsedMs: number;
  createdAt: string;
  deviceId: string;
  sourceBankId?: string;
  response?: PracticeResponse;
  outcome?: AttemptOutcome;
}

export interface AttemptStats {
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

export interface AttemptDailyStats {
  key: string;
  date: string;
  questionId: string;
  total: number;
  correct: number;
  wrong: number;
  giveUps: number;
  totalElapsedMs: number;
}

export interface PracticeRunStats {
  key: string;
  bankId: string;
  total: number;
  completed: number;
  inProgress: number;
  abandoned: number;
  latestUpdatedAt: string;
}

/** Device-local projection; rebuilt from practiceRuns + practiceRunSources. */
export interface BankPracticeStats {
  bankId: string;
  total: number;
  completed: number;
  inProgress: number;
  abandoned: number;
  latestActivityAt: string;
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

export interface ReviewRoundRecord {
  id: string;
  name: string;
  startedAt: string;
  status: ReviewRoundStatus;
  completedAt?: string;
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

export type PracticeRun = BasePracticeRun & { reviewRoundId?: string };

export interface PracticeRunRecord {
  id: string;
  mode: BasePracticeRun["mode"];
  modeLabel: string;
  shuffleOptions: boolean;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  abandonedAt?: string;
  status: BasePracticeRun["status"];
  revision: number;
  lastAnsweredIndex?: number;
  syncDeviceId?: string;
  syncEventId?: string;
  definitionSynced?: boolean;
  reviewRoundId?: string;
  bankNameSnapshot: string;
  activityAt: string;
}

export interface PracticeRunSource {
  runId: string;
  bankId: string;
  bankNameSnapshot: string;
  position: number;
}

export interface PracticeRunItem {
  runId: string;
  questionId: string;
  position: number;
  questionTypeSnapshot: QuestionType;
  optionOrder: number[];
  submittedAttemptId?: string;
}

/** Device-local, unsynchronized practice navigation state. */
export interface PracticeDraft {
  runId: string;
  questionId: string;
  selected: string[];
  response?: PracticeResponse;
  updatedAt: string;
}

export interface QuestionGroupItem {
  groupId: string;
  questionId: string;
  position: number;
  note?: string;
}

export interface ReviewRoundBank {
  roundId: string;
  bankId: string;
  position: number;
}

export interface ReviewRoundItem {
  roundId: string;
  questionId: string;
  position: number;
}

export interface ImageAsset {
  id: string;
  mimeType: "image/webp" | "image/jpeg" | "image/png";
  size: number;
  width: number;
  height: number;
  blob?: Blob;
}

/** Canonical/sync-visible image metadata. Blob bytes live only in imageBlobs. */
export interface ImageAssetDescriptor {
  id: string;
  mimeType: ImageAsset["mimeType"];
  size: number;
  width: number;
  height: number;
}

export interface ImageBlob {
  assetId: string;
  blob: Blob;
  cachedAt?: string;
  lastUsedAt?: string;
}

/**
 * The single complete envelope of synchronized/persisted canonical facts.
 * Local projections, drafts, caches and sync infrastructure are deliberately absent.
 */
export interface CanonicalState {
  banks: Bank[];
  bankFolders: BankFolder[];
  questions: Question[];
  memberships: BankQuestionMembership[];
  imageAssets: ImageAssetDescriptor[];
  attempts: Attempt[];
  notes: Note[];
  practiceRuns: PracticeRunRecord[];
  practiceRunSources: PracticeRunSource[];
  practiceRunItems: PracticeRunItem[];
  questionGroups: QuestionGroupRecord[];
  questionGroupItems: QuestionGroupItem[];
  reviewRounds: ReviewRoundRecord[];
  reviewRoundBanks: ReviewRoundBank[];
  reviewRoundItems: ReviewRoundItem[];
  tombstones: Tombstone[];
}
