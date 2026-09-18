import type { CanonicalState } from "../../src/lib/db/types";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint, type SyncCheckpointCounts } from "../../src/lib/sync/sync-checkpoint-types";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";

const LEGACY_V10_CHECKPOINT_FORMAT = 7;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function rows(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function countsFor(state: CanonicalState): SyncCheckpointCounts {
  return {
    banks: state.banks.length,
    bankFolders: state.bankFolders.length,
    questions: state.questions.length,
    memberships: state.memberships.length,
    imageAssets: state.imageAssets.length,
    attempts: state.attempts.length,
    notes: state.notes.length,
    practiceRuns: state.practiceRuns.length,
    practiceRunSources: state.practiceRunSources.length,
    practiceRunItems: state.practiceRunItems.length,
    questionGroups: state.questionGroups.length,
    questionGroupItems: state.questionGroupItems.length,
    reviewRounds: state.reviewRounds.length,
    reviewRoundBanks: state.reviewRoundBanks.length,
    reviewRoundItems: state.reviewRoundItems.length,
    tombstones: state.tombstones.length,
    totalAttempts: state.attempts.length,
    totalPracticeRuns: state.practiceRuns.length,
  };
}

/**
 * Phase-8 dry-run converter boundary.
 *
 * Input must already represent the fully hydrated v10 canonical snapshot after
 * replaying its hot segments/history. This tool deliberately does not become a
 * runtime fallback reader: it strips retired v10 fields once, emits current
 * v11 facts, validates them, and leaves the source object untouched.
 */
export function convertHydratedV10CheckpointToV11(input: unknown): SyncCheckpoint {
  const legacy = record(input, "legacy checkpoint");
  if (legacy.formatVersion !== LEGACY_V10_CHECKPOINT_FORMAT) {
    throw new Error(`legacy checkpoint format must be ${LEGACY_V10_CHECKPOINT_FORMAT}`);
  }
  const legacyState = record(legacy.state, "legacy checkpoint state");

  const banks = rows(legacyState.banks, "state.banks").map((value) => {
    const bank = record(value, "bank");
    const { questionCount: _questionCount, ...canonical } = bank;
    void _questionCount;
    return canonical;
  });
  const practiceRunItems = rows(legacyState.practiceRunItems, "state.practiceRunItems").map((value) => {
    const item = record(value, "practiceRunItem");
    const { draftSelected: _draftSelected, draftResponse: _draftResponse, ...canonical } = item;
    void _draftSelected;
    void _draftResponse;
    return canonical;
  });

  const state = {
    banks,
    bankFolders: structuredClone(rows(legacyState.bankFolders, "state.bankFolders")),
    questions: structuredClone(rows(legacyState.questions, "state.questions")),
    memberships: structuredClone(rows(legacyState.memberships, "state.memberships")),
    imageAssets: structuredClone(rows(legacyState.imageAssets, "state.imageAssets")),
    attempts: structuredClone(rows(legacyState.attempts, "state.attempts")),
    notes: structuredClone(rows(legacyState.notes, "state.notes")),
    practiceRuns: structuredClone(rows(legacyState.practiceRuns, "state.practiceRuns")),
    practiceRunSources: structuredClone(rows(legacyState.practiceRunSources, "state.practiceRunSources")),
    practiceRunItems,
    questionGroups: structuredClone(rows(legacyState.questionGroups, "state.questionGroups")),
    questionGroupItems: structuredClone(rows(legacyState.questionGroupItems, "state.questionGroupItems")),
    reviewRounds: structuredClone(rows(legacyState.reviewRounds, "state.reviewRounds")),
    reviewRoundBanks: structuredClone(rows(legacyState.reviewRoundBanks, "state.reviewRoundBanks")),
    reviewRoundItems: structuredClone(rows(legacyState.reviewRoundItems, "state.reviewRoundItems")),
    tombstones: structuredClone(rows(legacyState.tombstones, "state.tombstones")),
  } as CanonicalState;

  const checkpoint: SyncCheckpoint = {
    formatVersion: SYNC_CHECKPOINT_FORMAT,
    generatedAt: typeof legacy.generatedAt === "string" ? legacy.generatedAt : new Date().toISOString(),
    state,
    cursors: legacy.cursors && typeof legacy.cursors === "object" && !Array.isArray(legacy.cursors)
      ? structuredClone(legacy.cursors as Record<string, number>)
      : {},
    counts: countsFor(state),
    ...(legacy.retention && typeof legacy.retention === "object" && !Array.isArray(legacy.retention)
      ? { retention: structuredClone(legacy.retention as SyncCheckpoint["retention"]) }
      : {}),
  };
  validateSyncCheckpoint(checkpoint);
  return checkpoint;
}
