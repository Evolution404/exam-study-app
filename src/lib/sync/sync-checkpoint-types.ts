import type { RestoreState } from "../db/db";
import type { BankQuestionMembership, ImageAssetDescriptor } from "../db/types";

export const SYNC_CHECKPOINT_FORMAT = 7 as const;

export interface SyncCheckpointState extends RestoreState {
  memberships: BankQuestionMembership[];
  imageAssets: ImageAssetDescriptor[];
}

export interface SyncCheckpointCounts {
  banks: number; bankFolders: number; questions: number; memberships: number; imageAssets: number; attempts: number;
  attemptStats: number; attemptDailyStats: number; notes: number; practiceRuns: number; practiceRunStats: number; questionGroups: number;
  reviewRounds: number; reviewRoundProgress: number; tombstones: number; totalAttempts: number; totalPracticeRuns: number;
}

export interface SyncCheckpoint {
  formatVersion: typeof SYNC_CHECKPOINT_FORMAT;
  generatedAt: string;
  state: SyncCheckpointState;
  cursors: Record<string, number>;
  counts: SyncCheckpointCounts;
  retention?: { recentAttemptLimit?: number; recentPracticeRunLimit?: number; dailyStatsDays?: number; oldestRecentAttemptAt?: string | null; };
}

export type LocalCheckpoint = SyncCheckpoint;
