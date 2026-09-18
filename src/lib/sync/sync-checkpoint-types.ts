import type { CanonicalState } from "../db/types";

export const SYNC_CHECKPOINT_FORMAT = 8 as const;

/**
 * Current checkpoint wire state. Only canonical facts belong here.
 * Device-local projections/caches are rebuilt after restore and are deliberately
 * absent from both the type and serialized payload.
 */
export type SyncCheckpointState = CanonicalState;

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
