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
import { countsForHistoryState } from "../../src/lib/sync/sync-history-state";
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

function attemptForSubmittedAnswer(run: LegacyPracticeRun, questionId: string, attempts: readonly Attempt[]): Attempt | undefined {
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
    uniqueStrings(run.bankIds.length ? run.bankIds : [run.bankId]).forEach((bankId, position) => {
      sources.push({ runId: run.id, bankId, bankNameSnapshot: position === 0 ? run.bankName : bankId, position });
    });
    const seenQuestions = new Set<string>();
    run.questionIds.forEach((questionId, position) => {
      if (seenQuestions.has(questionId)) throw new Error(`legacy run ${run.id} contains duplicate question ${questionId}`);
      seenQuestions.add(questionId);
      const answer = run.answers[questionId];
      const attempt = attemptForSubmittedAnswer(run, questionId, attempts);
      if (answer?.submitted && !attempt) throw new Error(`legacy run ${run.id} question ${questionId} has a submitted answer without an Attempt`);
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

function convertQuestionGroups(groups: readonly QuestionGroup[]): { records: QuestionGroupRecord[]; items: QuestionGroupItem[] } {
  const records: QuestionGroupRecord[] = [];
  const items: QuestionGroupItem[] = [];
  for (const group of groups) {
    const { items: legacyItems, ...record } = group;
    records.push(record);
    legacyItems.forEach((item, position) => items.push({
      groupId: group.id,
      questionId: item.questionId,
      position,
      ...(item.note ? { note: item.note } : {}),
    }));
  }
  return { records, items };
}

function convertReviewRounds(rounds: readonly LegacyReviewRound[]): { records: ReviewRoundRecord[]; banks: ReviewRoundBank[]; items: ReviewRoundItem[] } {
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
    counts: countsForHistoryState(state),
    ...(legacy.retention ? { retention: {
      ...(legacy.retention.recentAttemptLimit !== undefined ? { recentAttemptLimit: legacy.retention.recentAttemptLimit } : {}),
      ...(legacy.retention.recentPracticeRunLimit !== undefined ? { recentPracticeRunLimit: legacy.retention.recentPracticeRunLimit } : {}),
      ...(legacy.retention.oldestRecentAttemptAt !== undefined ? { oldestRecentAttemptAt: legacy.retention.oldestRecentAttemptAt } : {}),
    } } : {}),
  };
  validateSyncCheckpoint(checkpoint);
  return checkpoint;
}

function sorted(values: readonly string[]): string[] { return [...values].sort(); }
function stableRows<T>(rows: readonly T[], key: (row: T) => string): string[] {
  return rows.map((row) => `${key(row)}\u0000${JSON.stringify(row)}`).sort();
}

export function verifyLegacySyncConversion(legacy: LegacySyncCheckpoint, converted: SyncCheckpoint): LegacySyncConversionReport {
  const errors: string[] = [];
  try { validateSyncCheckpoint(converted); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
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
  expectEqual("practice run sources",
    legacy.state.practiceRuns.flatMap((run) => uniqueStrings(run.bankIds.length ? run.bankIds : [run.bankId]).map((bankId, position) => `${run.id}:${position}:${bankId}`)),
    converted.state.practiceRunSources.map((row) => `${row.runId}:${row.position}:${row.bankId}`));
  expectEqual("practice run items",
    legacy.state.practiceRuns.flatMap((run) => run.questionIds.map((questionId, position) => `${run.id}:${position}:${questionId}`)),
    converted.state.practiceRunItems.map((row) => `${row.runId}:${row.position}:${row.questionId}`));
  expectEqual("question groups", legacy.state.questionGroups.map((row) => row.id), converted.state.questionGroups.map((row) => row.id));
  expectEqual("question group items",
    legacy.state.questionGroups.flatMap((group) => group.items.map((item, position) => `${group.id}:${position}:${item.questionId}:${item.note}`)),
    converted.state.questionGroupItems.map((item) => `${item.groupId}:${item.position}:${item.questionId}:${item.note ?? ""}`));
  expectEqual("review rounds", legacy.state.reviewRounds.map((row) => `${row.id}:${row.status}`), converted.state.reviewRounds.map((row) => `${row.id}:${row.status}`));
  expectEqual("review round banks",
    legacy.state.reviewRounds.flatMap((round) => uniqueStrings(round.bankIds).map((bankId, position) => `${round.id}:${position}:${bankId}`)),
    converted.state.reviewRoundBanks.map((row) => `${row.roundId}:${row.position}:${row.bankId}`));
  expectEqual("review round items",
    legacy.state.reviewRounds.flatMap((round) => uniqueStrings(round.finalQuestionIds ?? []).map((questionId, position) => `${round.id}:${position}:${questionId}`)),
    converted.state.reviewRoundItems.map((row) => `${row.roundId}:${row.position}:${row.questionId}`));
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
