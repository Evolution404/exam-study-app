import type {
  Attempt,
  Bank,
  BankFolder,
  BankQuestionMembership,
  ImageAssetDescriptor,
  Note,
  PracticeRunItem,
  PracticeRunRecord,
  PracticeRunSource,
  Question,
  QuestionGroupItem,
  QuestionGroupRecord,
  ReviewRoundBank,
  ReviewRoundItem,
  ReviewRoundRecord,
  Tombstone,
} from "../db/types";

export const SYNC_CHECKPOINT_FORMAT = 7 as const;

/**
 * Current checkpoint wire state. Only canonical facts belong here.
 * Device-local projections/caches are rebuilt after restore and are deliberately
 * absent from both the type and serialized payload.
 */
export interface SyncCheckpointState {
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

export interface SyncCheckpointCounts {
  banks: number;
  bankFolders: number;
  questions: number;
  memberships: number;
  imageAssets: number;
  attempts: number;
  notes: number;
  practiceRuns: number;
  practiceRunSources: number;
  practiceRunItems: number;
  questionGroups: number;
  questionGroupItems: number;
  reviewRounds: number;
  reviewRoundBanks: number;
  reviewRoundItems: number;
  tombstones: number;
  totalAttempts: number;
  totalPracticeRuns: number;
}

export interface SyncCheckpoint {
  formatVersion: typeof SYNC_CHECKPOINT_FORMAT;
  generatedAt: string;
  state: SyncCheckpointState;
  cursors: Record<string, number>;
  counts: SyncCheckpointCounts;
  retention?: { recentAttemptLimit?: number; recentPracticeRunLimit?: number; oldestRecentAttemptAt?: string | null };
}

export type LocalCheckpoint = SyncCheckpoint;
