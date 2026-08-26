import type { V7RestoreState } from "../db/db-v7";
import type { BankQuestionMembership, ImageAsset } from "../db/v7-types";

export const SYNC_V7_CHECKPOINT_FORMAT = 7 as const;

export interface SyncCheckpointV7State extends V7RestoreState {
  memberships: BankQuestionMembership[];
  imageAssets: Array<Omit<ImageAsset, "blob">>;
}

export interface SyncCheckpointV7Counts {
  banks: number; bankFolders: number; questions: number; memberships: number; imageAssets: number; attempts: number;
  attemptStats: number; attemptDailyStats: number; notes: number; practiceRuns: number; practiceRunStats: number; questionGroups: number;
  reviewRounds: number; reviewRoundProgress: number; tombstones: number; totalAttempts: number; totalPracticeRuns: number;
}

export interface SyncCheckpointV7 {
  formatVersion: typeof SYNC_V7_CHECKPOINT_FORMAT;
  generatedAt: string;
  state: SyncCheckpointV7State;
  cursors: Record<string, number>;
  counts: SyncCheckpointV7Counts;
  retention?: { recentAttemptLimit?: number; recentPracticeRunLimit?: number; dailyStatsDays?: number; oldestRecentAttemptAt?: string | null; };
}

export type V7Checkpoint = SyncCheckpointV7;
