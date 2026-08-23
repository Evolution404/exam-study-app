/**
 * Sync v7 immutable checkpoint.
 *
 * A checkpoint is the complete v7 projection.  It deliberately contains no
 * event payloads and no image Blob values: blobs are immutable Git objects
 * addressed by the image descriptors.  Keeping the complete projection here
 * means a large import (or a device that was offline for a long time) can be
 * represented by one bounded restore object instead of an unbounded event
 * tail.
 */
import { dbV7, restoreV7Checkpoint, type ChangeSetQueueRecordV7, type V7RestoreState } from "../db/db-v7";
import { IMAGE_EXTENSION_BY_MIME } from "../io/image-assets";
import { SYNC_V7_ASSET_PREFIX } from "./sync-v7-head";
import type {
  AttemptDailyStatsV7,
  AttemptV7,
  BankQuestionMembership,
  BankV7,
  ImageAsset,
  PracticeRunV7,
  QuestionV7,
} from "../db/v7-types";

export const SYNC_V7_CHECKPOINT_FORMAT = 7 as const;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;

export interface SyncCheckpointV7State extends V7RestoreState {
  /** The explicit name used on the wire for bank/question joins. */
  memberships: BankQuestionMembership[];
  /** Image descriptors only; `blob` is forbidden in checkpoint JSON. */
  imageAssets: Array<Omit<ImageAsset, "blob">>;
}

export interface SyncCheckpointV7Counts {
  banks: number;
  bankFolders: number;
  questions: number;
  memberships: number;
  imageAssets: number;
  attempts: number;
  attemptStats: number;
  attemptDailyStats: number;
  notes: number;
  practiceRuns: number;
  practiceRunStats: number;
  questionGroups: number;
  reviewRounds: number;
  reviewRoundProgress: number;
  tombstones: number;
  /** Stable aliases useful to older result cards and diagnostics. */
  totalAttempts: number;
  totalPracticeRuns: number;
}

export interface SyncCheckpointV7 {
  formatVersion: typeof SYNC_V7_CHECKPOINT_FORMAT;
  generatedAt: string;
  state: SyncCheckpointV7State;
  /** Highest local/remote event sequence observed for every device. */
  cursors: Record<string, number>;
  counts: SyncCheckpointV7Counts;
  /** Migration metadata is accepted and preserved, but never required. */
  retention?: {
    recentAttemptLimit?: number;
    recentPracticeRunLimit?: number;
    dailyStatsDays?: number;
    oldestRecentAttemptAt?: string | null;
  };
}

export type V7Checkpoint = SyncCheckpointV7;

function fail(message: string): never {
  throw new Error(`invalid v7 checkpoint: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp`);
}

function assertString(value: unknown, field: string, allowEmpty = false): asserts value is string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) fail(`${field} must be a string`);
}

function assertSha(value: unknown, field: string, pattern = SHA256): asserts value is string {
  if (typeof value !== "string" || !pattern.test(value)) fail(`${field} must be a lowercase digest`);
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
}

function assertSafeInt(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(`${field} must be a safe integer >= ${minimum}`);
}

function assertEntityId(value: unknown, field: string): asserts value is string {
  assertString(value, field);
  if (value.length > 512) fail(`${field} is too long`);
}

function normalizeStateAliases(state: Record<string, unknown>): void {
  // Practice-run statistics are keyed by bank; older rows may omit the key.
  if (Array.isArray(state.practiceRunStats)) {
    state.practiceRunStats = state.practiceRunStats.map((value) => {
      if (!isRecord(value) || value.key !== undefined || typeof value.bankId !== "string") return value;
      return { ...value, key: value.bankId };
    });
  }
}

function assertImageAsset(asset: unknown, assets: Map<string, Omit<ImageAsset, "blob">>, index: number): asserts asset is Omit<ImageAsset, "blob"> {
  if (!isRecord(asset)) fail(`state.imageAssets[${index}] must be an object`);
  assertSha(asset.id, `state.imageAssets[${index}].id`);
  if (asset.mimeType !== "image/webp" && asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png") {
    fail(`state.imageAssets[${index}].mimeType is not supported`);
  }
  assertSafeInt(asset.size, `state.imageAssets[${index}].size`);
  assertSafeInt(asset.width, `state.imageAssets[${index}].width`, 1);
  assertSafeInt(asset.height, `state.imageAssets[${index}].height`, 1);
  if ("blob" in asset && asset.blob !== undefined) fail(`state.imageAssets[${index}] must not contain a Blob`);
  if (asset.remote !== undefined) {
    if (!isRecord(asset.remote)) fail(`state.imageAssets[${index}].remote must be an object`);
    assertString(asset.remote.path, `state.imageAssets[${index}].remote.path`);
    assertSha(asset.remote.sha256, `state.imageAssets[${index}].remote.sha256`);
    assertSha(asset.remote.blobSha, `state.imageAssets[${index}].remote.blobSha`, SHA1);
    assertSafeInt(asset.remote.size, `state.imageAssets[${index}].remote.size`);
    if (asset.remote.sha256 !== asset.id) fail(`state.imageAssets[${index}].remote.sha256 must equal id`);
    if (asset.remote.size !== asset.size) fail(`state.imageAssets[${index}].remote.size must equal size`);
    const extension = IMAGE_EXTENSION_BY_MIME[asset.mimeType];
    const expectedPath = `${SYNC_V7_ASSET_PREFIX}${asset.id}.${extension}`;
    if (asset.remote.path !== expectedPath) {
      fail(`state.imageAssets[${index}].remote.path must be ${expectedPath}`);
    }
  }
  assets.set(asset.id, asset as Omit<ImageAsset, "blob">);
}

function validateContentBlocks(value: unknown, assets: Map<string, Omit<ImageAsset, "blob">>, field: string): void {
  assertArray(value, field);
  for (let index = 0; index < value.length; index += 1) {
    const block = value[index];
    if (!isRecord(block)) fail(`${field}[${index}] must be an object`);
    assertString(block.id, `${field}[${index}].id`);
    if (block.type === "text") assertString(block.text, `${field}[${index}].text`, true);
    else if (block.type === "image") {
      assertString(block.assetId, `${field}[${index}].assetId`);
      if (!assets.has(block.assetId)) fail(`${field}[${index}] references missing image asset ${block.assetId}`);
      if (block.alt !== undefined) assertString(block.alt, `${field}[${index}].alt`, true);
      if (block.caption !== undefined) assertString(block.caption, `${field}[${index}].caption`, true);
    } else fail(`${field}[${index}].type is invalid`);
  }
}

function validateQuestion(value: unknown, assets: Map<string, Omit<ImageAsset, "blob">>, index: number): asserts value is QuestionV7 {
  if (!isRecord(value)) fail(`state.questions[${index}] must be an object`);
  assertEntityId(value.id, `state.questions[${index}].id`);
  if (!["判断", "单选", "多选", "计算"].includes(String(value.type))) fail(`state.questions[${index}].type is invalid`);
  validateContentBlocks(value.content, assets, `state.questions[${index}].content`);
  assertArray(value.options, `state.questions[${index}].options`);
  for (let optionIndex = 0; optionIndex < value.options.length; optionIndex += 1) {
    validateContentBlocks(value.options[optionIndex], assets, `state.questions[${index}].options[${optionIndex}]`);
  }
  assertString(value.answer, `state.questions[${index}].answer`);
  assertArray(value.tags, `state.questions[${index}].tags`);
  value.tags.forEach((tag, tagIndex) => assertString(tag, `state.questions[${index}].tags[${tagIndex}]`, true));
  assertString(value.contentFingerprint, `state.questions[${index}].contentFingerprint`);
  assertDate(value.updatedAt, `state.questions[${index}].updatedAt`);
  assertString(value.deviceId, `state.questions[${index}].deviceId`);
}

function validateBank(value: unknown, folders: Set<string>, index: number): asserts value is BankV7 {
  if (!isRecord(value)) fail(`state.banks[${index}] must be an object`);
  assertEntityId(value.id, `state.banks[${index}].id`);
  assertString(value.name, `state.banks[${index}].name`);
  assertSafeInt(value.sortOrder, `state.banks[${index}].sortOrder`);
  assertSafeInt(value.questionCount, `state.banks[${index}].questionCount`);
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") fail(`state.banks[${index}].enabled must be boolean`);
  assertDate(value.importedAt, `state.banks[${index}].importedAt`);
  assertDate(value.updatedAt, `state.banks[${index}].updatedAt`);
  assertString(value.deviceId, `state.banks[${index}].deviceId`);
  if (value.folderId !== undefined && value.folderId !== null) {
    assertString(value.folderId, `state.banks[${index}].folderId`);
    if (!folders.has(value.folderId)) fail(`state.banks[${index}] references missing folder ${value.folderId}`);
  }
}

function validateMembership(value: unknown, banks: Set<string>, questions: Set<string>, index: number): asserts value is BankQuestionMembership {
  if (!isRecord(value)) fail(`state.memberships[${index}] must be an object`);
  assertString(value.key, `state.memberships[${index}].key`);
  assertEntityId(value.bankId, `state.memberships[${index}].bankId`);
  assertEntityId(value.questionId, `state.memberships[${index}].questionId`);
  if (!banks.has(value.bankId)) fail(`state.memberships[${index}] references missing bank ${value.bankId}`);
  if (!questions.has(value.questionId)) fail(`state.memberships[${index}] references missing question ${value.questionId}`);
  if (value.key !== `${value.bankId}:${value.questionId}`) fail(`state.memberships[${index}].key is not canonical`);
  assertSafeInt(value.sortOrder, `state.memberships[${index}].sortOrder`);
  assertDate(value.addedAt, `state.memberships[${index}].addedAt`);
  assertDate(value.updatedAt, `state.memberships[${index}].updatedAt`);
  assertString(value.deviceId, `state.memberships[${index}].deviceId`);
}

function validateAttempt(value: unknown, questions: Set<string>, index: number): asserts value is AttemptV7 {
  if (!isRecord(value)) fail(`state.attempts[${index}] must be an object`);
  assertEntityId(value.id, `state.attempts[${index}].id`);
  assertEntityId(value.runId, `state.attempts[${index}].runId`);
  assertEntityId(value.questionId, `state.attempts[${index}].questionId`);
  // A practice run is a removable UI/history projection, while attempts are
  // permanent learning history.  Deleting a run deliberately keeps its
  // attempts and global statistics, so runId is provenance rather than a
  // checkpoint foreign key.
  if (!questions.has(value.questionId)) fail(`state.attempts[${index}] references missing question ${value.questionId}`);
  assertString(value.selected, `state.attempts[${index}].selected`, true);
  if (typeof value.correct !== "boolean") fail(`state.attempts[${index}].correct must be boolean`);
  assertSafeInt(value.elapsedMs, `state.attempts[${index}].elapsedMs`);
  assertDate(value.createdAt, `state.attempts[${index}].createdAt`);
  assertString(value.deviceId, `state.attempts[${index}].deviceId`);
  if (value.sourceBankId !== undefined) assertString(value.sourceBankId, `state.attempts[${index}].sourceBankId`);
}

function validateRun(value: unknown, banks: Set<string>, questions: Set<string>, rounds: Set<string>, index: number): asserts value is PracticeRunV7 {
  if (!isRecord(value)) fail(`state.practiceRuns[${index}] must be an object`);
  assertEntityId(value.id, `state.practiceRuns[${index}].id`);
  assertEntityId(value.bankId, `state.practiceRuns[${index}].bankId`);
  if (!banks.has(value.bankId)) fail(`state.practiceRuns[${index}] references missing bank ${value.bankId}`);
  assertArray(value.bankIds, `state.practiceRuns[${index}].bankIds`);
  value.bankIds.forEach((bankId, bankIndex) => {
    assertString(bankId, `state.practiceRuns[${index}].bankIds[${bankIndex}]`);
    if (!banks.has(bankId)) fail(`state.practiceRuns[${index}] references missing bank ${bankId}`);
  });
  assertString(value.bankName, `state.practiceRuns[${index}].bankName`, true);
  assertString(value.mode, `state.practiceRuns[${index}].mode`);
  assertString(value.modeLabel, `state.practiceRuns[${index}].modeLabel`, true);
  assertArray(value.questionIds, `state.practiceRuns[${index}].questionIds`);
  value.questionIds.forEach((questionId, questionIndex) => {
    assertString(questionId, `state.practiceRuns[${index}].questionIds[${questionIndex}]`);
    if (!questions.has(questionId)) fail(`state.practiceRuns[${index}] references missing question ${questionId}`);
  });
  if (!isRecord(value.questionTypes)) fail(`state.practiceRuns[${index}].questionTypes must be an object`);
  if (!isRecord(value.answers)) fail(`state.practiceRuns[${index}].answers must be an object`);
  if (typeof value.shuffleOptions !== "boolean" || !isRecord(value.optionOrders)) fail(`state.practiceRuns[${index}] option state is invalid`);
  assertDate(value.startedAt, `state.practiceRuns[${index}].startedAt`);
  assertDate(value.updatedAt, `state.practiceRuns[${index}].updatedAt`);
  if (!["in_progress", "completed", "abandoned"].includes(String(value.status))) fail(`state.practiceRuns[${index}].status is invalid`);
  assertSafeInt(value.revision, `state.practiceRuns[${index}].revision`);
  if (value.completedAt !== undefined) assertDate(value.completedAt, `state.practiceRuns[${index}].completedAt`);
  if (value.abandonedAt !== undefined) assertDate(value.abandonedAt, `state.practiceRuns[${index}].abandonedAt`);
  if (value.reviewRoundId !== undefined) {
    assertString(value.reviewRoundId, `state.practiceRuns[${index}].reviewRoundId`);
    if (!rounds.has(value.reviewRoundId)) fail(`state.practiceRuns[${index}] references missing round ${value.reviewRoundId}`);
  }
}

function validateStats(state: SyncCheckpointV7State, questions: Set<string>, attempts: Set<string>, rounds: Set<string>): void {
  state.attemptStats.forEach((stats, index) => {
    if (!isRecord(stats)) fail(`state.attemptStats[${index}] must be an object`);
    assertString(stats.questionId, `state.attemptStats[${index}].questionId`);
    if (!questions.has(stats.questionId)) fail(`state.attemptStats[${index}] references missing question`);
    ["total", "correct", "wrong", "giveUps", "totalElapsedMs"].forEach((field) => assertSafeInt(stats[field], `state.attemptStats[${index}].${field}`));
    assertDate(stats.firstAttemptAt, `state.attemptStats[${index}].firstAttemptAt`);
    assertDate(stats.latestAttemptAt, `state.attemptStats[${index}].latestAttemptAt`);
    if (typeof stats.firstAttemptCorrect !== "boolean" || typeof stats.hasBeenWrong !== "boolean") fail(`state.attemptStats[${index}] boolean fields are invalid`);
    assertArray(stats.recentOutcomes, `state.attemptStats[${index}].recentOutcomes`);
    stats.recentOutcomes.forEach((outcome, outcomeIndex) => {
      if (!isRecord(outcome)) fail(`state.attemptStats[${index}].recentOutcomes[${outcomeIndex}] must be an object`);
      assertString(outcome.id, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].id`);
      if (!attempts.has(outcome.id)) fail(`state.attemptStats[${index}] references missing attempt ${outcome.id}`);
      assertDate(outcome.createdAt, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].createdAt`);
      if (typeof outcome.correct !== "boolean") fail(`state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].correct must be boolean`);
      // 作答时间为可选字段（难度 v2 前的旧 checkpoint 没有）；存在则必须是非负安全整数。
      if (outcome.elapsedMs !== undefined) assertSafeInt(outcome.elapsedMs, `state.attemptStats[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);
    });
  });
  state.attemptDailyStats.forEach((stats, index) => {
    if (!isRecord(stats)) fail(`state.attemptDailyStats[${index}] must be an object`);
    assertString(stats.key, `state.attemptDailyStats[${index}].key`);
    assertString(stats.date, `state.attemptDailyStats[${index}].date`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(stats.date)) fail(`state.attemptDailyStats[${index}].date is invalid`);
    assertString(stats.questionId, `state.attemptDailyStats[${index}].questionId`);
    if (!questions.has(stats.questionId)) fail(`state.attemptDailyStats[${index}] references missing question`);
    if (stats.key !== `${stats.date}:${stats.questionId}`) fail(`state.attemptDailyStats[${index}].key is not canonical`);
    ["total", "correct", "wrong", "giveUps", "totalElapsedMs"].forEach((field) => assertSafeInt(stats[field], `state.attemptDailyStats[${index}].${field}`));
  });
  state.reviewRoundProgress.forEach((progress, index) => {
    if (!isRecord(progress)) fail(`state.reviewRoundProgress[${index}] must be an object`);
    assertString(progress.key, `state.reviewRoundProgress[${index}].key`);
    assertString(progress.roundId, `state.reviewRoundProgress[${index}].roundId`);
    assertString(progress.questionId, `state.reviewRoundProgress[${index}].questionId`);
    if (!rounds.has(progress.roundId) || !questions.has(progress.questionId)) fail(`state.reviewRoundProgress[${index}] references missing round/question`);
    if (progress.key !== `${progress.roundId}:${progress.questionId}`) fail(`state.reviewRoundProgress[${index}].key is not canonical`);
    ["attempts", "correct", "wrong"].forEach((field) => assertSafeInt(progress[field], `state.reviewRoundProgress[${index}].${field}`));
    assertDate(progress.firstAttemptAt, `state.reviewRoundProgress[${index}].firstAttemptAt`);
    assertDate(progress.latestAttemptAt, `state.reviewRoundProgress[${index}].latestAttemptAt`);
    for (const field of ["giveUps", "totalElapsedMs", "currentCorrectStreak", "correctStreakAfterWrong"] as const) {
      if (progress[field] !== undefined) assertSafeInt(progress[field], `state.reviewRoundProgress[${index}].${field}`);
    }
    for (const field of ["firstAttemptCorrect", "hasBeenWrong"] as const) {
      if (progress[field] !== undefined && typeof progress[field] !== "boolean") fail(`state.reviewRoundProgress[${index}].${field} must be boolean`);
    }
    if (progress.recentOutcomes !== undefined) {
      assertArray(progress.recentOutcomes, `state.reviewRoundProgress[${index}].recentOutcomes`);
      progress.recentOutcomes.forEach((outcome, outcomeIndex) => {
        if (!isRecord(outcome)) fail(`state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}] must be an object`);
        assertString(outcome.id, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].id`);
        if (!attempts.has(outcome.id)) fail(`state.reviewRoundProgress[${index}] references missing attempt ${outcome.id}`);
        assertDate(outcome.createdAt, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].createdAt`);
        if (typeof outcome.correct !== "boolean") fail(`state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].correct must be boolean`);
        if (outcome.elapsedMs !== undefined) assertSafeInt(outcome.elapsedMs, `state.reviewRoundProgress[${index}].recentOutcomes[${outcomeIndex}].elapsedMs`);
      });
    }
  });
}

/** Strictly validate an unknown value as a complete v7 checkpoint. */
export function validateSyncCheckpointV7(value: unknown): asserts value is SyncCheckpointV7 {
  if (!isRecord(value) || value.formatVersion !== SYNC_V7_CHECKPOINT_FORMAT) fail("formatVersion must be 7");
  assertDate(value.generatedAt, "generatedAt");
  if (!isRecord(value.state)) fail("state must be an object");
  normalizeStateAliases(value.state);
  const state = value.state as unknown as SyncCheckpointV7State;
  const arrayFields: Array<keyof SyncCheckpointV7State> = [
    "banks", "bankFolders", "questions", "memberships", "imageAssets", "attemptStats", "attemptDailyStats", "attempts", "notes", "practiceRuns", "practiceRunStats", "questionGroups", "reviewRounds", "reviewRoundProgress", "tombstones",
  ];
  for (const field of arrayFields) assertArray((state as unknown as Record<string, unknown>)[field], `state.${field}`);

  const folders = new Set<string>();
  state.bankFolders.forEach((folder, index) => {
    if (!isRecord(folder)) fail(`state.bankFolders[${index}] must be an object`);
    assertEntityId(folder.id, `state.bankFolders[${index}].id`);
    assertString(folder.name, `state.bankFolders[${index}].name`);
    assertSafeInt(folder.sortOrder, `state.bankFolders[${index}].sortOrder`);
    assertDate(folder.createdAt, `state.bankFolders[${index}].createdAt`);
    assertDate(folder.updatedAt, `state.bankFolders[${index}].updatedAt`);
    assertString(folder.deviceId, `state.bankFolders[${index}].deviceId`);
    folders.add(folder.id);
  });
  const banks = new Set<string>();
  state.banks.forEach((bank, index) => { validateBank(bank, folders, index); if (banks.has(bank.id)) fail(`duplicate bank ${bank.id}`); banks.add(bank.id); });
  const assets = new Map<string, Omit<ImageAsset, "blob">>();
  state.imageAssets.forEach((asset, index) => { assertImageAsset(asset, assets, index); });
  const questions = new Set<string>();
  state.questions.forEach((question, index) => { validateQuestion(question, assets, index); if (questions.has(question.id)) fail(`duplicate question ${question.id}`); questions.add(question.id); });
  const memberships = new Set<string>();
  state.memberships.forEach((membership, index) => { validateMembership(membership, banks, questions, index); if (memberships.has(membership.key)) fail(`duplicate membership ${membership.key}`); memberships.add(membership.key); });
  for (const bank of state.banks) {
    const expected = state.memberships.filter((membership) => membership.bankId === bank.id).length;
    if (bank.questionCount !== expected) fail(`bank ${bank.id} questionCount does not match memberships`);
  }

  const rounds = new Set<string>();
  state.reviewRounds.forEach((round, index) => {
    if (!isRecord(round)) fail(`state.reviewRounds[${index}] must be an object`);
    assertEntityId(round.id, `state.reviewRounds[${index}].id`);
    assertString(round.name, `state.reviewRounds[${index}].name`, true);
    assertArray(round.bankIds, `state.reviewRounds[${index}].bankIds`);
    round.bankIds.forEach((bankId, bankIndex) => { assertString(bankId, `state.reviewRounds[${index}].bankIds[${bankIndex}]`); if (!banks.has(bankId)) fail(`state.reviewRounds[${index}] references missing bank`); });
    if (!["active", "completed", "archived"].includes(String(round.status))) fail(`state.reviewRounds[${index}].status is invalid`);
    assertDate(round.startedAt, `state.reviewRounds[${index}].startedAt`);
    assertDate(round.createdAt, `state.reviewRounds[${index}].createdAt`);
    assertDate(round.updatedAt, `state.reviewRounds[${index}].updatedAt`);
    assertString(round.deviceId, `state.reviewRounds[${index}].deviceId`);
    if (round.completedAt !== undefined) assertDate(round.completedAt, `state.reviewRounds[${index}].completedAt`);
    if (round.finalQuestionIds !== undefined) {
      assertArray(round.finalQuestionIds, `state.reviewRounds[${index}].finalQuestionIds`);
      round.finalQuestionIds.forEach((questionId, questionIndex) => { assertString(questionId, `state.reviewRounds[${index}].finalQuestionIds[${questionIndex}]`); if (!questions.has(questionId)) fail(`state.reviewRounds[${index}] references missing final question`); });
    }
    if (rounds.has(round.id)) fail(`duplicate review round ${round.id}`);
    rounds.add(round.id);
  });

  const runs = new Set<string>();
  state.practiceRuns.forEach((run, index) => { validateRun(run, banks, questions, rounds, index); if (runs.has(run.id)) fail(`duplicate practice run ${run.id}`); runs.add(run.id); });
  const attempts = new Set<string>();
  state.attempts.forEach((attempt, index) => { validateAttempt(attempt, questions, index); if (attempts.has(attempt.id)) fail(`duplicate attempt ${attempt.id}`); attempts.add(attempt.id); });
  validateStats(state, questions, attempts, rounds);
  state.notes.forEach((note, index) => { if (!isRecord(note)) fail(`state.notes[${index}] must be an object`); assertString(note.questionId, `state.notes[${index}].questionId`); if (!questions.has(note.questionId)) fail(`state.notes[${index}] references missing question`); assertString(note.content, `state.notes[${index}].content`, true); assertSafeInt(note.revision, `state.notes[${index}].revision`); assertDate(note.updatedAt, `state.notes[${index}].updatedAt`); assertString(note.deviceId, `state.notes[${index}].deviceId`); });
  state.questionGroups.forEach((group, index) => { if (!isRecord(group)) fail(`state.questionGroups[${index}] must be an object`); assertEntityId(group.id, `state.questionGroups[${index}].id`); assertString(group.name, `state.questionGroups[${index}].name`); assertArray(group.items, `state.questionGroups[${index}].items`); group.items.forEach((item, itemIndex) => { if (!isRecord(item)) fail(`state.questionGroups[${index}].items[${itemIndex}] must be an object`); assertString(item.questionId, `state.questionGroups[${index}].items[${itemIndex}].questionId`); if (!questions.has(item.questionId)) fail(`state.questionGroups[${index}] references missing question`); assertString(item.note, `state.questionGroups[${index}].items[${itemIndex}].note`, true); }); assertDate(group.createdAt, `state.questionGroups[${index}].createdAt`); assertDate(group.updatedAt, `state.questionGroups[${index}].updatedAt`); assertString(group.deviceId, `state.questionGroups[${index}].deviceId`); });
  state.practiceRunStats.forEach((stats, index) => { if (!isRecord(stats)) fail(`state.practiceRunStats[${index}] must be an object`); if (stats.key !== undefined) assertString(stats.key, `state.practiceRunStats[${index}].key`); assertString(stats.bankId, `state.practiceRunStats[${index}].bankId`); if (stats.bankId !== "__all__" && !banks.has(stats.bankId)) fail(`state.practiceRunStats[${index}] references missing bank`); ["total", "completed", "inProgress", "abandoned"].forEach((field) => assertSafeInt(stats[field], `state.practiceRunStats[${index}].${field}`)); assertDate(stats.latestUpdatedAt, `state.practiceRunStats[${index}].latestUpdatedAt`); });
  state.tombstones.forEach((tombstone, index) => { if (!isRecord(tombstone)) fail(`state.tombstones[${index}] must be an object`); assertString(tombstone.key, `state.tombstones[${index}].key`); assertString(tombstone.entityType, `state.tombstones[${index}].entityType`); if (!["bank", "bankFolder", "question", "practiceRun", "questionGroup", "membership", "imageAsset"].includes(tombstone.entityType)) fail(`state.tombstones[${index}].entityType is invalid`); assertString(tombstone.entityId, `state.tombstones[${index}].entityId`); assertDate(tombstone.deletedAt, `state.tombstones[${index}].deletedAt`); assertString(tombstone.deviceId, `state.tombstones[${index}].deviceId`); assertString(tombstone.eventId, `state.tombstones[${index}].eventId`); });

  if (!isRecord(value.cursors)) fail("cursors must be an object");
  for (const [deviceId, sequence] of Object.entries(value.cursors)) { assertString(deviceId, "cursor device id"); assertSafeInt(sequence, `cursors.${deviceId}`); }
  if (!isRecord(value.counts)) fail("counts must be an object");
  const counts = value.counts;
  const expected: SyncCheckpointV7Counts = {
    banks: state.banks.length, bankFolders: state.bankFolders.length, questions: state.questions.length, memberships: state.memberships.length,
    imageAssets: state.imageAssets.length, attempts: state.attempts.length, attemptStats: state.attemptStats.length, attemptDailyStats: state.attemptDailyStats.length,
    notes: state.notes.length, practiceRuns: state.practiceRuns.length, practiceRunStats: state.practiceRunStats.length, questionGroups: state.questionGroups.length,
    reviewRounds: state.reviewRounds.length, reviewRoundProgress: state.reviewRoundProgress.length, tombstones: state.tombstones.length,
    totalAttempts: state.attempts.length, totalPracticeRuns: state.practiceRuns.length,
  };
  for (const [field, number] of Object.entries(expected)) {
    if (counts[field] !== undefined && counts[field] !== number && field !== "totalAttempts" && field !== "totalPracticeRuns") fail(`counts.${field} does not match state`);
  }
  if (counts.totalAttempts !== undefined) { assertSafeInt(counts.totalAttempts, "counts.totalAttempts"); if ((counts.totalAttempts) < state.attempts.length) fail("counts.totalAttempts is smaller than attempts"); }
  if (counts.totalPracticeRuns !== undefined) { assertSafeInt(counts.totalPracticeRuns, "counts.totalPracticeRuns"); if ((counts.totalPracticeRuns) < state.practiceRuns.length) fail("counts.totalPracticeRuns is smaller than practiceRuns"); }
}

export function isSyncCheckpointV7(value: unknown): value is SyncCheckpointV7 {
  try { validateSyncCheckpointV7(value); return true; } catch { return false; }
}

/** Convert the locked migration shape (`recent*` fields) to canonical v7 names. */
export function normalizeSyncCheckpointV7(value: SyncCheckpointV7): SyncCheckpointV7 {
  const state = value.state as SyncCheckpointV7State & Record<string, unknown>;
  normalizeStateAliases(state);
  return value;
}

function withoutBlobs(asset: ImageAsset): Omit<ImageAsset, "blob"> {
  const descriptor = { ...asset } as Omit<ImageAsset, "blob"> & { blob?: Blob };
  delete descriptor.blob;
  return descriptor;
}

function canonicalAttemptDailyStats(rows: readonly AttemptDailyStatsV7[]): AttemptDailyStatsV7[] {
  const merged = new Map<string, AttemptDailyStatsV7>();
  for (const row of rows) {
    const key = `${row.date}:${row.questionId}`;
    const current = merged.get(key);
    if (!current) merged.set(key, { ...row, key });
    else merged.set(key, {
      ...current,
      total: current.total + row.total,
      correct: current.correct + row.correct,
      wrong: current.wrong + row.wrong,
      giveUps: current.giveUps + row.giveUps,
      totalElapsedMs: current.totalElapsedMs + row.totalElapsedMs,
    });
  }
  return [...merged.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function countsFor(state: SyncCheckpointV7State): SyncCheckpointV7Counts {
  return {
    banks: state.banks.length, bankFolders: state.bankFolders.length, questions: state.questions.length, memberships: state.memberships.length,
    imageAssets: state.imageAssets.length, attempts: state.attempts.length, attemptStats: state.attemptStats.length, attemptDailyStats: state.attemptDailyStats.length,
    notes: state.notes.length, practiceRuns: state.practiceRuns.length, practiceRunStats: state.practiceRunStats.length, questionGroups: state.questionGroups.length,
    reviewRounds: state.reviewRounds.length, reviewRoundProgress: state.reviewRoundProgress.length, tombstones: state.tombstones.length,
    totalAttempts: state.attempts.length, totalPracticeRuns: state.practiceRuns.length,
  };
}

function cloneState(state: V7RestoreState & { memberships?: BankQuestionMembership[]; imageAssets: ImageAsset[] }): SyncCheckpointV7State {
  return {
    banks: state.banks.map((item) => ({ ...item })),
    bankFolders: state.bankFolders.map((item) => ({ ...item })),
    questions: state.questions.map((item) => ({ ...item, content: item.content.map((block) => ({ ...block })), options: item.options.map((option) => option.map((block) => ({ ...block }))), tags: [...item.tags] })),
    memberships: (state.memberships ?? state.bankQuestionMemberships ?? []).map((item) => ({ ...item })),
    imageAssets: state.imageAssets.map(withoutBlobs),
    attempts: state.attempts.map((item) => ({ ...item })),
    attemptStats: state.attemptStats.map((item) => ({ ...item, recentOutcomes: item.recentOutcomes.map((outcome) => ({ ...outcome })) })),
    attemptDailyStats: canonicalAttemptDailyStats(state.attemptDailyStats),
    notes: state.notes.map((item) => ({ ...item })),
    practiceRuns: state.practiceRuns.map((item) => ({ ...item, bankIds: [...item.bankIds], questionIds: [...item.questionIds], questionTypes: { ...item.questionTypes }, answers: { ...item.answers }, optionOrders: { ...item.optionOrders } })),
    practiceRunStats: state.practiceRunStats.map((item) => ({ ...item })),
    questionGroups: state.questionGroups.map((item) => ({ ...item, items: item.items.map((entry) => ({ ...entry })) })),
    reviewRounds: state.reviewRounds.map((item) => ({ ...item, bankIds: [...item.bankIds], finalQuestionIds: item.finalQuestionIds ? [...item.finalQuestionIds] : undefined })),
    reviewRoundProgress: state.reviewRoundProgress.map((item) => ({ ...item, recentOutcomes: item.recentOutcomes?.map((outcome) => ({ ...outcome })) })),
    tombstones: state.tombstones.map((item) => ({ ...item })),
  };
}

export interface SyncCheckpointSnapshotV7 {
  checkpoint: SyncCheckpointV7;
  /** Exact queue rows read by the same IndexedDB transaction as the projection. */
  changeSets: ChangeSetQueueRecordV7[];
}

/** Create a full checkpoint and retain the exact queue rows it covered.
 *
 * Every projection table and change-set cursor is read from one readonly
 * transaction.  A Promise.all over individual Dexie table calls is not a
 * snapshot: a local write can commit between two requests and produce a
 * checkpoint whose projection and cursor describe different moments.
 */
export async function createSyncCheckpointV7Snapshot(generatedAt = new Date().toISOString()): Promise<SyncCheckpointSnapshotV7> {
  const tables = [
    dbV7.banks, dbV7.bankFolders, dbV7.questions, dbV7.bankQuestionMemberships, dbV7.imageAssets,
    dbV7.attempts, dbV7.attemptStats, dbV7.attemptDailyStats, dbV7.notes, dbV7.practiceRuns,
    dbV7.practiceRunStats, dbV7.questionGroups, dbV7.reviewRounds, dbV7.reviewRoundProgress,
    dbV7.tombstones, dbV7.changeSets,
  ] as const;
  const rows = await dbV7.transaction("r", tables, async () => Promise.all([
    dbV7.banks.toArray(), dbV7.bankFolders.toArray(), dbV7.questions.toArray(), dbV7.bankQuestionMemberships.toArray(), dbV7.imageAssets.toArray(),
    dbV7.attempts.toArray(), dbV7.attemptStats.toArray(), dbV7.attemptDailyStats.toArray(), dbV7.notes.toArray(), dbV7.practiceRuns.toArray(), dbV7.practiceRunStats.toArray(),
    dbV7.questionGroups.toArray(), dbV7.reviewRounds.toArray(), dbV7.reviewRoundProgress.toArray(), dbV7.tombstones.toArray(), dbV7.changeSets.toArray(),
  ]));
  const [banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats, questionGroups, reviewRounds, reviewRoundProgress, tombstones, changeSets] = rows;
  // The local checkpoint is a projection, not an event log.  Cursors track the
  // pending change-set tail so concurrent devices can detect coverage.
  const state = cloneState({ banks, bankFolders, questions, memberships, imageAssets, attempts, attemptStats, attemptDailyStats, notes, practiceRuns, practiceRunStats, questionGroups, reviewRounds, reviewRoundProgress, tombstones });
  const cursors: Record<string, number> = {};
  for (const change of changeSets) cursors[change.deviceId] = Math.max(cursors[change.deviceId] ?? 0, change.localSequence);
  const checkpoint: SyncCheckpointV7 = { formatVersion: SYNC_V7_CHECKPOINT_FORMAT, generatedAt, state, cursors, counts: countsFor(state) };
  validateSyncCheckpointV7(checkpoint);
  return { checkpoint, changeSets };
}

/** Create a full checkpoint from the v7 namespace only. */
export async function createSyncCheckpointV7(generatedAt = new Date().toISOString()): Promise<SyncCheckpointV7> {
  return (await createSyncCheckpointV7Snapshot(generatedAt)).checkpoint;
}

export const createV7Checkpoint = createSyncCheckpointV7;
export const buildSyncCheckpointV7 = createSyncCheckpointV7;
export const createCheckpointV7 = createSyncCheckpointV7;

/** JSON bytes used for content-addressed checkpoint paths. */
export function encodeSyncCheckpointV7(checkpoint: SyncCheckpointV7): Uint8Array {
  validateSyncCheckpointV7(checkpoint);
  return new TextEncoder().encode(JSON.stringify(checkpoint));
}

export function parseSyncCheckpointV7(bytes: Uint8Array | string): SyncCheckpointV7 {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)) as unknown; } catch { throw new Error("远程 v7 检查点不是有效 JSON。"); }
  validateSyncCheckpointV7(parsed);
  const checkpoint = normalizeSyncCheckpointV7(parsed);
  return checkpoint;
}

export const decodeSyncCheckpointV7 = parseSyncCheckpointV7;
export const validateV7Checkpoint = validateSyncCheckpointV7;

/** Compatibility helper mirroring the v5 prepared-checkpoint naming. */
export function prepareSyncCheckpointV7(checkpoint: SyncCheckpointV7): SyncCheckpointV7 {
  validateSyncCheckpointV7(checkpoint);
  return normalizeSyncCheckpointV7(checkpoint);
}

/** Restore the complete checkpoint projection in one DB transaction. */
export async function applySyncCheckpointV7(checkpoint: SyncCheckpointV7): Promise<void> {
  validateSyncCheckpointV7(checkpoint);
  await restoreV7Checkpoint(checkpoint.state);
}

export const restoreSyncCheckpointV7 = applySyncCheckpointV7;
export const applyPreparedSyncCheckpointV7 = applySyncCheckpointV7;
