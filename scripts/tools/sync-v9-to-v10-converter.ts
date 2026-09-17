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
} from "../../src/lib/db/types";
import type { SyncCheckpoint, SyncCheckpointState } from "../../src/lib/sync/sync-checkpoint-types";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import type { PracticeAnswerState, PracticeMode, QuestionGroup, QuestionType } from "../../src/types/types";

interface LegacyPracticeRun {
  id: string;
  bankId: string;
  bankIds: string[];
  bankName: string;
  mode: PracticeMode;
  modeLabel: string;
  questionIds: string[];
  questionTypes: Record<string, QuestionType>;
  answers: Record<string, PracticeAnswerState>;
  shuffleOptions: boolean;
  optionOrders: Record<string, number[]>;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  abandonedAt?: string;
  status: "in_progress" | "completed" | "abandoned";
  revision: number;
  lastAnsweredIndex?: number;
  syncDeviceId?: string;
  syncEventId?: string;
  definitionSynced?: boolean;
  reviewRoundId?: string;
}

interface LegacyReviewRound extends ReviewRoundRecord {
  bankIds: string[];
  finalQuestionIds?: string[];
}

interface LegacyState {
  banks: Bank[];
  bankFolders: BankFolder[];
  questions: Question[];
  memberships: BankQuestionMembership[];
  imageAssets: ImageAssetDescriptor[];
  attempts: Attempt[];
  attemptStats: unknown[];
  attemptDailyStats: unknown[];
  notes: Note[];
  practiceRuns: LegacyPracticeRun[];
  practiceRunStats: unknown[];
  questionGroups: QuestionGroup[];
  reviewRounds: LegacyReviewRound[];
  reviewRoundProgress: unknown[];
  tombstones: Tombstone[];
}

export interface LegacySyncCheckpoint {
  formatVersion: 7;
  generatedAt: string;
  state: LegacyState;
  cursors: Record<string, number>;
  counts: Record<string, number>;
  retention?: {
    recentAttemptLimit?: number;
    recentPracticeRunLimit?: number;
    dailyStatsDays?: number;
    oldestRecentAttemptAt?: string | null;
  };
}

export interface LegacySyncConversionReport {
  ok: boolean;
  errors: string[];
  counts: {
    questions: number;
    banks: number;
    memberships: number;
    attempts: number;
    practiceRuns: number;
    reviewRounds: number;
    notes: number;
    questionGroups: number;
    imageAssets: number;
    tombstones: number;
  };
}

export interface SyncV10ShadowFile {
  path: string;
  content: string;
}

export interface SyncV10ShadowPlan {
  sourceFormatVersion: 9;
  targetFormatVersion: 10;
  vaultId: string;
  sourceHeadSha: string;
  files: SyncV10ShadowFile[];
  cutoverHead: {
    path: "sync/v10/head.json";
    authorized: false;
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function latestSubmittedAnswerAt(run: LegacyPracticeRun): string | undefined {
  let latest: string | undefined;
  for (const answer of Object.values(run.answers)) {
    if (!answer.submitted || !answer.updatedAt) continue;
    if (!latest || answer.updatedAt > latest) latest = answer.updatedAt;
  }
  return latest;
}

function runActivityAt(run: LegacyPracticeRun): string {
  if (run.status === "completed") return run.completedAt ?? run.updatedAt;
  const latestAnswer = latestSubmittedAnswerAt(run);
  if (latestAnswer) return latestAnswer;
  if (run.status === "abandoned") return run.abandonedAt ?? run.updatedAt;
  return run.startedAt;
}

function attemptForSubmittedAnswer(
  run: LegacyPracticeRun,
  questionId: string,
  attempts: readonly Attempt[],
): Attempt | undefined {
  const answer = run.answers[questionId];
  if (!answer?.submitted) return undefined;
  if (answer.eventId) {
    const exact = attempts.find((attempt) => attempt.id === answer.eventId && attempt.runId === run.id && attempt.questionId === questionId);
    if (exact) return exact;
  }
  return attempts
    .filter((attempt) => attempt.runId === run.id && attempt.questionId === questionId)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))[0];
}

function convertPracticeRuns(
  runs: readonly LegacyPracticeRun[],
  attempts: readonly Attempt[],
): { records: PracticeRunRecord[]; sources: PracticeRunSource[]; items: PracticeRunItem[] } {
  const records: PracticeRunRecord[] = [];
  const sources: PracticeRunSource[] = [];
  const items: PracticeRunItem[] = [];

  for (const run of runs) {
    records.push({
      id: run.id,
      mode: run.mode,
      modeLabel: run.modeLabel,
      shuffleOptions: run.shuffleOptions,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      status: run.status,
      revision: run.revision,
      bankNameSnapshot: run.bankName,
      activityAt: runActivityAt(run),
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(run.abandonedAt !== undefined ? { abandonedAt: run.abandonedAt } : {}),
      ...(run.lastAnsweredIndex !== undefined ? { lastAnsweredIndex: run.lastAnsweredIndex } : {}),
      ...(run.syncDeviceId !== undefined ? { syncDeviceId: run.syncDeviceId } : {}),
      ...(run.syncEventId !== undefined ? { syncEventId: run.syncEventId } : {}),
      ...(run.definitionSynced !== undefined ? { definitionSynced: run.definitionSynced } : {}),
      ...(run.reviewRoundId !== undefined ? { reviewRoundId: run.reviewRoundId } : {}),
    });

    const bankIds = uniqueStrings(run.bankIds.length ? run.bankIds : [run.bankId]);
    bankIds.forEach((bankId, position) => {
      sources.push({
        runId: run.id,
        bankId,
        bankNameSnapshot: position === 0 ? run.bankName : bankId,
        position,
      });
    });

    run.questionIds.forEach((questionId, position) => {
      const answer = run.answers[questionId];
      const attempt = attemptForSubmittedAnswer(run, questionId, attempts);
      if (answer?.submitted && !attempt) {
        throw new Error(`legacy run ${run.id} question ${questionId} has a submitted answer without an Attempt`);
      }
      const questionTypeSnapshot = run.questionTypes[questionId];
      if (!questionTypeSnapshot) throw new Error(`legacy run ${run.id} question ${questionId} has no question type snapshot`);
      items.push({
        runId: run.id,
        questionId,
        position,
        questionTypeSnapshot,
        optionOrder: [...(run.optionOrders[questionId] ?? [])],
        ...(attempt ? { submittedAttemptId: attempt.id } : {}),
        ...(!answer?.submitted && answer?.selected?.length ? { draftSelected: [...answer.selected] } : {}),
        ...(!answer?.submitted && answer?.response ? { draftResponse: structuredClone(answer.response) } : {}),
      });
    });
  }

  return { records, sources, items };
}

function convertQuestionGroups(groups: readonly QuestionGroup[]): {
  records: QuestionGroupRecord[];
  items: QuestionGroupItem[];
} {
  const records: QuestionGroupRecord[] = [];
  const items: QuestionGroupItem[] = [];
  for (const group of groups) {
    const { items: legacyItems, ...record } = group;
    records.push(record);
    legacyItems.forEach((item, position) => {
      items.push({
        groupId: group.id,
        questionId: item.questionId,
        position,
        ...(item.note ? { note: item.note } : {}),
      });
    });
  }
  return { records, items };
}

function convertReviewRounds(rounds: readonly LegacyReviewRound[]): {
  records: ReviewRoundRecord[];
  banks: ReviewRoundBank[];
  items: ReviewRoundItem[];
} {
  const records: ReviewRoundRecord[] = [];
  const banks: ReviewRoundBank[] = [];
  const items: ReviewRoundItem[] = [];
  for (const round of rounds) {
    const { bankIds, finalQuestionIds, ...record } = round;
    records.push(record);
    uniqueStrings(bankIds).forEach((bankId, position) => banks.push({ roundId: round.id, bankId, position }));
    uniqueStrings(finalQuestionIds ?? []).forEach((questionId, position) => items.push({ roundId: round.id, questionId, position }));
  }
  return { records, banks, items };
}

function currentCounts(state: SyncCheckpointState) {
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

export function convertLegacySyncCheckpoint(legacy: LegacySyncCheckpoint): SyncCheckpoint {
  if (legacy.formatVersion !== 7) throw new Error(`unsupported legacy checkpoint format: ${legacy.formatVersion}`);
  const runs = convertPracticeRuns(legacy.state.practiceRuns, legacy.state.attempts);
  const groups = convertQuestionGroups(legacy.state.questionGroups);
  const rounds = convertReviewRounds(legacy.state.reviewRounds);
  const state: SyncCheckpointState = {
    banks: structuredClone(legacy.state.banks),
    bankFolders: structuredClone(legacy.state.bankFolders),
    questions: structuredClone(legacy.state.questions),
    memberships: structuredClone(legacy.state.memberships),
    imageAssets: structuredClone(legacy.state.imageAssets),
    attempts: structuredClone(legacy.state.attempts),
    notes: structuredClone(legacy.state.notes),
    practiceRuns: runs.records,
    practiceRunSources: runs.sources,
    practiceRunItems: runs.items,
    questionGroups: groups.records,
    questionGroupItems: groups.items,
    reviewRounds: rounds.records,
    reviewRoundBanks: rounds.banks,
    reviewRoundItems: rounds.items,
    tombstones: structuredClone(legacy.state.tombstones),
  };
  const checkpoint: SyncCheckpoint = {
    formatVersion: 7,
    generatedAt: legacy.generatedAt,
    state,
    cursors: structuredClone(legacy.cursors),
    counts: currentCounts(state),
    ...(legacy.retention ? {
      retention: {
        ...(legacy.retention.recentAttemptLimit !== undefined ? { recentAttemptLimit: legacy.retention.recentAttemptLimit } : {}),
        ...(legacy.retention.recentPracticeRunLimit !== undefined ? { recentPracticeRunLimit: legacy.retention.recentPracticeRunLimit } : {}),
        ...(legacy.retention.oldestRecentAttemptAt !== undefined ? { oldestRecentAttemptAt: legacy.retention.oldestRecentAttemptAt } : {}),
      },
    } : {}),
  };
  validateSyncCheckpoint(checkpoint);
  return checkpoint;
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort();
}

function stableRows<T>(rows: readonly T[], key: (row: T) => string): string[] {
  return rows.map((row) => `${key(row)}\u0000${JSON.stringify(row)}`).sort();
}

export function verifyLegacySyncConversion(
  legacy: LegacySyncCheckpoint,
  converted: SyncCheckpoint,
): LegacySyncConversionReport {
  const errors: string[] = [];
  try {
    validateSyncCheckpoint(converted);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const expectEqual = (label: string, left: readonly string[], right: readonly string[]) => {
    if (JSON.stringify(sorted(left)) !== JSON.stringify(sorted(right))) errors.push(`${label} changed during conversion`);
  };

  expectEqual("question ids/fingerprints", legacy.state.questions.map((row) => `${row.id}:${row.contentFingerprint}`), converted.state.questions.map((row) => `${row.id}:${row.contentFingerprint}`));
  expectEqual("banks", legacy.state.banks.map((row) => row.id), converted.state.banks.map((row) => row.id));
  expectEqual("memberships", legacy.state.memberships.map((row) => row.key), converted.state.memberships.map((row) => row.key));
  expectEqual("attempt identity", stableRows(legacy.state.attempts, (row) => row.id), stableRows(converted.state.attempts, (row) => row.id));
  expectEqual("practice runs", legacy.state.practiceRuns.map((row) => `${row.id}:${row.status}`), converted.state.practiceRuns.map((row) => `${row.id}:${row.status}`));
  expectEqual("notes", stableRows(legacy.state.notes, (row) => row.questionId), stableRows(converted.state.notes, (row) => row.questionId));
  expectEqual("image descriptors", legacy.state.imageAssets.map((row) => `${row.id}:${row.size}`), converted.state.imageAssets.map((row) => `${row.id}:${row.size}`));
  expectEqual("tombstones", stableRows(legacy.state.tombstones, (row) => row.key), stableRows(converted.state.tombstones, (row) => row.key));
  expectEqual("cursors", Object.entries(legacy.cursors).map(([device, sequence]) => `${device}:${sequence}`), Object.entries(converted.cursors).map(([device, sequence]) => `${device}:${sequence}`));

  const legacyRunSources = legacy.state.practiceRuns.flatMap((run) => uniqueStrings(run.bankIds.length ? run.bankIds : [run.bankId]).map((bankId, position) => `${run.id}:${position}:${bankId}`));
  const convertedRunSources = converted.state.practiceRunSources.map((row) => `${row.runId}:${row.position}:${row.bankId}`);
  expectEqual("practice run sources", legacyRunSources, convertedRunSources);

  const legacyRunItems = legacy.state.practiceRuns.flatMap((run) => run.questionIds.map((questionId, position) => `${run.id}:${position}:${questionId}`));
  const convertedRunItems = converted.state.practiceRunItems.map((row) => `${row.runId}:${row.position}:${row.questionId}`);
  expectEqual("practice run items", legacyRunItems, convertedRunItems);

  expectEqual("question groups", legacy.state.questionGroups.map((row) => row.id), converted.state.questionGroups.map((row) => row.id));
  const legacyGroupItems = legacy.state.questionGroups.flatMap((group) => group.items.map((item, position) => `${group.id}:${position}:${item.questionId}:${item.note}`));
  const convertedGroupItems = converted.state.questionGroupItems.map((item) => `${item.groupId}:${item.position}:${item.questionId}:${item.note ?? ""}`);
  expectEqual("question group items", legacyGroupItems, convertedGroupItems);

  expectEqual("review rounds", legacy.state.reviewRounds.map((row) => `${row.id}:${row.status}`), converted.state.reviewRounds.map((row) => `${row.id}:${row.status}`));
  const legacyRoundBanks = legacy.state.reviewRounds.flatMap((round) => uniqueStrings(round.bankIds).map((bankId, position) => `${round.id}:${position}:${bankId}`));
  const convertedRoundBanks = converted.state.reviewRoundBanks.map((row) => `${row.roundId}:${row.position}:${row.bankId}`);
  expectEqual("review round banks", legacyRoundBanks, convertedRoundBanks);
  const legacyRoundItems = legacy.state.reviewRounds.flatMap((round) => uniqueStrings(round.finalQuestionIds ?? []).map((questionId, position) => `${round.id}:${position}:${questionId}`));
  const convertedRoundItems = converted.state.reviewRoundItems.map((row) => `${row.roundId}:${row.position}:${row.questionId}`);
  expectEqual("review round items", legacyRoundItems, convertedRoundItems);

  return {
    ok: errors.length === 0,
    errors,
    counts: {
      questions: converted.state.questions.length,
      banks: converted.state.banks.length,
      memberships: converted.state.memberships.length,
      attempts: converted.state.attempts.length,
      practiceRuns: converted.state.practiceRuns.length,
      reviewRounds: converted.state.reviewRounds.length,
      notes: converted.state.notes.length,
      questionGroups: converted.state.questionGroups.length,
      imageAssets: converted.state.imageAssets.length,
      tombstones: converted.state.tombstones.length,
    },
  };
}

export function buildSyncV10ShadowPlan(input: {
  vaultId: string;
  sourceHeadSha: string;
  checkpoint: SyncCheckpoint;
}): SyncV10ShadowPlan {
  validateSyncCheckpoint(input.checkpoint);
  const checkpointPath = `sync/v10/checkpoints/from-${input.sourceHeadSha}.json`;
  const manifestPath = `sync/v10/conversions/from-${input.sourceHeadSha}.json`;
  const checkpointContent = JSON.stringify(input.checkpoint);
  const manifestContent = JSON.stringify({
    sourceFormatVersion: 9,
    targetFormatVersion: 10,
    vaultId: input.vaultId,
    sourceHeadSha: input.sourceHeadSha,
    checkpointPath,
    counts: input.checkpoint.counts,
  });
  return {
    sourceFormatVersion: 9,
    targetFormatVersion: 10,
    vaultId: input.vaultId,
    sourceHeadSha: input.sourceHeadSha,
    files: [
      { path: checkpointPath, content: checkpointContent },
      { path: manifestPath, content: manifestContent },
    ],
    cutoverHead: { path: "sync/v10/head.json", authorized: false },
  };
}
