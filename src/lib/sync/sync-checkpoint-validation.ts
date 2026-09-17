import { QUESTION_TYPE_ORDER } from "../../types/types";
import type { BankQuestionMembership, Bank, ImageAsset, QuestionSolution, Question } from "../db/types";
import { SYNC_CHECKPOINT_FORMAT, type SyncCheckpoint, type SyncCheckpointCounts, type SyncCheckpointState } from "./sync-checkpoint-types";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256 = /^[a-f0-9]{64}$/;
const QUESTION_TYPES = new Set<string>(QUESTION_TYPE_ORDER);
const STATE_FIELDS = [
  "banks",
  "bankFolders",
  "questions",
  "memberships",
  "imageAssets",
  "attempts",
  "notes",
  "practiceRuns",
  "practiceRunSources",
  "practiceRunItems",
  "questionGroups",
  "questionGroupItems",
  "reviewRounds",
  "reviewRoundBanks",
  "reviewRoundItems",
  "tombstones",
] as const satisfies readonly (keyof SyncCheckpointState)[];
const COUNT_FIELDS = [
  ...STATE_FIELDS,
  "totalAttempts",
  "totalPracticeRuns",
] as const satisfies readonly (keyof SyncCheckpointCounts)[];

function fail(message: string): never {
  throw new Error(`invalid checkpoint: ${message}`);
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

function assertOptionalString(value: unknown, field: string, allowEmpty = false): void {
  if (value !== undefined) assertString(value, field, allowEmpty);
}

function assertSha(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !SHA256.test(value)) fail(`${field} must be a lowercase digest`);
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

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) if (!allowedSet.has(key)) fail(`${field}.${key} is not part of the current canonical wire`);
}

function assertImageAsset(asset: unknown, assets: Map<string, Omit<ImageAsset, "blob">>, index: number): void {
  if (!isRecord(asset)) fail(`state.imageAssets[${index}] must be an object`);
  assertSha(asset.id, `state.imageAssets[${index}].id`);
  if (asset.mimeType !== "image/webp" && asset.mimeType !== "image/jpeg" && asset.mimeType !== "image/png") fail(`state.imageAssets[${index}].mimeType is not supported`);
  assertSafeInt(asset.size, `state.imageAssets[${index}].size`);
  assertSafeInt(asset.width, `state.imageAssets[${index}].width`, 1);
  assertSafeInt(asset.height, `state.imageAssets[${index}].height`, 1);
  if ("blob" in asset && asset.blob !== undefined) fail(`state.imageAssets[${index}] must not contain a Blob`);
  if ("remote" in asset) fail(`state.imageAssets[${index}] must not contain retired remote metadata`);
  if (assets.has(asset.id)) fail(`duplicate image asset ${asset.id}`);
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
      assertOptionalString(block.alt, `${field}[${index}].alt`, true);
      assertOptionalString(block.caption, `${field}[${index}].caption`, true);
    } else fail(`${field}[${index}].type is invalid`);
  }
}

function validateSolution(value: unknown, field: string, type: Question["type"]): asserts value is QuestionSolution {
  if (!isRecord(value)) fail(`${field} must be an object`);
  if (value.kind === "choice") {
    if (type === "计算" || type === "填空" || type === "简答") fail(`${field}.kind does not match question type`);
    assertArray(value.correctOptionIds, `${field}.correctOptionIds`);
    if (!value.correctOptionIds.length) fail(`${field}.correctOptionIds must not be empty`);
    value.correctOptionIds.forEach((id, index) => assertString(id, `${field}.correctOptionIds[${index}]`));
    return;
  }
  if (value.kind === "calculation") {
    if (type !== "计算") fail(`${field}.kind does not match question type`);
    assertArray(value.blanks, `${field}.blanks`);
    if (!value.blanks.length) fail(`${field}.blanks must not be empty`);
    value.blanks.forEach((blank, index) => {
      if (!isRecord(blank)) fail(`${field}.blanks[${index}] must be an object`);
      assertString(blank.id, `${field}.blanks[${index}].id`);
      if (typeof blank.expected !== "number" || !Number.isFinite(blank.expected)) fail(`${field}.blanks[${index}].expected must be finite`);
      if (blank.tolerancePercent !== undefined && (typeof blank.tolerancePercent !== "number" || !Number.isFinite(blank.tolerancePercent) || blank.tolerancePercent < 0)) fail(`${field}.blanks[${index}].tolerancePercent is invalid`);
    });
    return;
  }
  if (value.kind === "fill") {
    if (type !== "填空") fail(`${field}.kind does not match question type`);
    assertArray(value.blanks, `${field}.blanks`);
    if (!value.blanks.length) fail(`${field}.blanks must not be empty`);
    value.blanks.forEach((blank, index) => {
      if (!isRecord(blank)) fail(`${field}.blanks[${index}] must be an object`);
      assertString(blank.id, `${field}.blanks[${index}].id`);
      assertArray(blank.acceptedAnswers, `${field}.blanks[${index}].acceptedAnswers`);
      if (!blank.acceptedAnswers.length) fail(`${field}.blanks[${index}].acceptedAnswers must not be empty`);
      blank.acceptedAnswers.forEach((answer, answerIndex) => assertString(answer, `${field}.blanks[${index}].acceptedAnswers[${answerIndex}]`));
    });
    return;
  }
  if (value.kind === "short") {
    if (type !== "简答") fail(`${field}.kind does not match question type`);
    assertString(value.referenceText, `${field}.referenceText`);
    return;
  }
  fail(`${field}.kind is invalid`);
}

function validateQuestion(value: unknown, assets: Map<string, Omit<ImageAsset, "blob">>, index: number): asserts value is Question {
  if (!isRecord(value)) fail(`state.questions[${index}] must be an object`);
  assertEntityId(value.id, `state.questions[${index}].id`);
  if (!QUESTION_TYPES.has(String(value.type))) fail(`state.questions[${index}].type is invalid`);
  validateContentBlocks(value.content, assets, `state.questions[${index}].content`);
  assertArray(value.options, `state.questions[${index}].options`);
  for (let optionIndex = 0; optionIndex < value.options.length; optionIndex += 1) validateContentBlocks(value.options[optionIndex], assets, `state.questions[${index}].options[${optionIndex}]`);
  if (value.optionIds !== undefined) {
    assertArray(value.optionIds, `state.questions[${index}].optionIds`);
    if (value.optionIds.length !== value.options.length) fail(`state.questions[${index}].optionIds must align with options`);
    value.optionIds.forEach((id, optionIndex) => assertString(id, `state.questions[${index}].optionIds[${optionIndex}]`));
    if (new Set(value.optionIds as string[]).size !== value.optionIds.length) fail(`state.questions[${index}].optionIds must be unique`);
  }
  validateSolution(value.solution, `state.questions[${index}].solution`, value.type as Question["type"]);
  if (value.solution.kind === "choice") {
    if (!Array.isArray(value.optionIds)) fail(`state.questions[${index}].optionIds are required for choice questions`);
    const validOptionIds = new Set(value.optionIds as string[]);
    if (new Set(value.solution.correctOptionIds).size !== value.solution.correctOptionIds.length) fail(`state.questions[${index}].solution.correctOptionIds must be unique`);
    value.solution.correctOptionIds.forEach((id) => { if (!validOptionIds.has(id)) fail(`state.questions[${index}].solution references missing option id ${id}`); });
  }
  assertArray(value.tags, `state.questions[${index}].tags`);
  value.tags.forEach((tag, tagIndex) => assertString(tag, `state.questions[${index}].tags[${tagIndex}]`, true));
  assertString(value.contentFingerprint, `state.questions[${index}].contentFingerprint`);
  assertDate(value.updatedAt, `state.questions[${index}].updatedAt`);
  assertString(value.deviceId, `state.questions[${index}].deviceId`);
}

function validateBank(value: unknown, folders: Set<string>, index: number): asserts value is Bank {
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

function validateCanonicalState(state: SyncCheckpointState): void {
  const folders = new Set<string>();
  state.bankFolders.forEach((folder, index) => {
    if (!isRecord(folder)) fail(`state.bankFolders[${index}] must be an object`);
    assertEntityId(folder.id, `state.bankFolders[${index}].id`);
    assertString(folder.name, `state.bankFolders[${index}].name`);
    assertSafeInt(folder.sortOrder, `state.bankFolders[${index}].sortOrder`);
    assertDate(folder.createdAt, `state.bankFolders[${index}].createdAt`);
    assertDate(folder.updatedAt, `state.bankFolders[${index}].updatedAt`);
    assertString(folder.deviceId, `state.bankFolders[${index}].deviceId`);
    if (folders.has(folder.id)) fail(`duplicate bank folder ${folder.id}`);
    folders.add(folder.id);
  });

  const banks = new Set<string>();
  state.banks.forEach((bank, index) => {
    validateBank(bank, folders, index);
    if (banks.has(bank.id)) fail(`duplicate bank ${bank.id}`);
    banks.add(bank.id);
  });

  const assets = new Map<string, Omit<ImageAsset, "blob">>();
  state.imageAssets.forEach((asset, index) => assertImageAsset(asset, assets, index));

  const questions = new Set<string>();
  state.questions.forEach((question, index) => {
    validateQuestion(question, assets, index);
    if (questions.has(question.id)) fail(`duplicate question ${question.id}`);
    questions.add(question.id);
  });

  const memberships = new Set<string>();
  state.memberships.forEach((membership, index) => {
    validateMembership(membership, banks, questions, index);
    if (memberships.has(membership.key)) fail(`duplicate membership ${membership.key}`);
    memberships.add(membership.key);
  });
  for (const bank of state.banks) {
    const expected = state.memberships.filter((membership) => membership.bankId === bank.id).length;
    if (bank.questionCount !== expected) fail(`bank ${bank.id} questionCount does not match memberships`);
  }

  const rounds = new Set<string>();
  state.reviewRounds.forEach((round, index) => {
    if (!isRecord(round)) fail(`state.reviewRounds[${index}] must be an object`);
    assertEntityId(round.id, `state.reviewRounds[${index}].id`);
    assertString(round.name, `state.reviewRounds[${index}].name`, true);
    if (!["active", "completed", "archived"].includes(String(round.status))) fail(`state.reviewRounds[${index}].status is invalid`);
    assertDate(round.startedAt, `state.reviewRounds[${index}].startedAt`);
    assertDate(round.createdAt, `state.reviewRounds[${index}].createdAt`);
    assertDate(round.updatedAt, `state.reviewRounds[${index}].updatedAt`);
    assertString(round.deviceId, `state.reviewRounds[${index}].deviceId`);
    if (round.completedAt !== undefined) assertDate(round.completedAt, `state.reviewRounds[${index}].completedAt`);
    if (rounds.has(round.id)) fail(`duplicate review round ${round.id}`);
    rounds.add(round.id);
  });

  const roundBanks = new Set<string>();
  state.reviewRoundBanks.forEach((relation, index) => {
    if (!isRecord(relation)) fail(`state.reviewRoundBanks[${index}] must be an object`);
    assertEntityId(relation.roundId, `state.reviewRoundBanks[${index}].roundId`);
    assertEntityId(relation.bankId, `state.reviewRoundBanks[${index}].bankId`);
    assertSafeInt(relation.position, `state.reviewRoundBanks[${index}].position`);
    if (!rounds.has(relation.roundId)) fail(`state.reviewRoundBanks[${index}] references missing round`);
    if (!banks.has(relation.bankId)) fail(`state.reviewRoundBanks[${index}] references missing bank`);
    const key = `${relation.roundId}:${relation.bankId}`;
    if (roundBanks.has(key)) fail(`duplicate review round bank ${key}`);
    roundBanks.add(key);
  });

  const roundItems = new Set<string>();
  state.reviewRoundItems.forEach((relation, index) => {
    if (!isRecord(relation)) fail(`state.reviewRoundItems[${index}] must be an object`);
    assertEntityId(relation.roundId, `state.reviewRoundItems[${index}].roundId`);
    assertEntityId(relation.questionId, `state.reviewRoundItems[${index}].questionId`);
    assertSafeInt(relation.position, `state.reviewRoundItems[${index}].position`);
    if (!rounds.has(relation.roundId)) fail(`state.reviewRoundItems[${index}] references missing round`);
    if (!questions.has(relation.questionId)) fail(`state.reviewRoundItems[${index}] references missing question`);
    const key = `${relation.roundId}:${relation.questionId}`;
    if (roundItems.has(key)) fail(`duplicate review round item ${key}`);
    roundItems.add(key);
  });

  const runs = new Set<string>();
  state.practiceRuns.forEach((run, index) => {
    if (!isRecord(run)) fail(`state.practiceRuns[${index}] must be an object`);
    assertEntityId(run.id, `state.practiceRuns[${index}].id`);
    assertString(run.mode, `state.practiceRuns[${index}].mode`);
    assertString(run.modeLabel, `state.practiceRuns[${index}].modeLabel`, true);
    assertString(run.bankNameSnapshot, `state.practiceRuns[${index}].bankNameSnapshot`, true);
    if (!["in_progress", "completed", "abandoned"].includes(String(run.status))) fail(`state.practiceRuns[${index}].status is invalid`);
    assertDate(run.startedAt, `state.practiceRuns[${index}].startedAt`);
    assertDate(run.updatedAt, `state.practiceRuns[${index}].updatedAt`);
    assertDate(run.activityAt, `state.practiceRuns[${index}].activityAt`);
    assertSafeInt(run.revision, `state.practiceRuns[${index}].revision`);
    if (run.lastAnsweredIndex !== undefined) assertSafeInt(run.lastAnsweredIndex, `state.practiceRuns[${index}].lastAnsweredIndex`);
    if (run.reviewRoundId !== undefined) {
      assertEntityId(run.reviewRoundId, `state.practiceRuns[${index}].reviewRoundId`);
      if (!rounds.has(run.reviewRoundId)) fail(`state.practiceRuns[${index}] references missing round ${run.reviewRoundId}`);
    }
    if (runs.has(run.id)) fail(`duplicate practice run ${run.id}`);
    runs.add(run.id);
  });

  const runSources = new Set<string>();
  state.practiceRunSources.forEach((source, index) => {
    if (!isRecord(source)) fail(`state.practiceRunSources[${index}] must be an object`);
    assertEntityId(source.runId, `state.practiceRunSources[${index}].runId`);
    assertEntityId(source.bankId, `state.practiceRunSources[${index}].bankId`);
    assertString(source.bankNameSnapshot, `state.practiceRunSources[${index}].bankNameSnapshot`, true);
    assertSafeInt(source.position, `state.practiceRunSources[${index}].position`);
    if (!runs.has(source.runId)) fail(`state.practiceRunSources[${index}] references missing run`);
    const key = `${source.runId}:${source.bankId}`;
    if (runSources.has(key)) fail(`duplicate practice run source ${key}`);
    runSources.add(key);
  });

  const runItems = new Set<string>();
  state.practiceRunItems.forEach((item, index) => {
    if (!isRecord(item)) fail(`state.practiceRunItems[${index}] must be an object`);
    assertEntityId(item.runId, `state.practiceRunItems[${index}].runId`);
    assertEntityId(item.questionId, `state.practiceRunItems[${index}].questionId`);
    assertSafeInt(item.position, `state.practiceRunItems[${index}].position`);
    if (!QUESTION_TYPES.has(String(item.questionTypeSnapshot))) fail(`state.practiceRunItems[${index}].questionTypeSnapshot is invalid`);
    assertArray(item.optionOrder, `state.practiceRunItems[${index}].optionOrder`);
    item.optionOrder.forEach((position, positionIndex) => assertSafeInt(position, `state.practiceRunItems[${index}].optionOrder[${positionIndex}]`));
    if (!runs.has(item.runId)) fail(`state.practiceRunItems[${index}] references missing run`);
    if (!questions.has(item.questionId)) fail(`state.practiceRunItems[${index}] references missing question`);
    assertOptionalString(item.submittedAttemptId, `state.practiceRunItems[${index}].submittedAttemptId`);
    const key = `${item.runId}:${item.questionId}`;
    if (runItems.has(key)) fail(`duplicate practice run item ${key}`);
    runItems.add(key);
  });

  const attempts = new Set<string>();
  state.attempts.forEach((attempt, index) => {
    if (!isRecord(attempt)) fail(`state.attempts[${index}] must be an object`);
    assertEntityId(attempt.id, `state.attempts[${index}].id`);
    assertEntityId(attempt.runId, `state.attempts[${index}].runId`);
    assertEntityId(attempt.questionId, `state.attempts[${index}].questionId`);
    // runId is durable historical attribution, not a live foreign key. Deleting a
    // PracticeRun intentionally preserves Attempts and records a practiceRun tombstone.
    if (!questions.has(attempt.questionId)) fail(`state.attempts[${index}] references missing question ${attempt.questionId}`);
    assertString(attempt.selected, `state.attempts[${index}].selected`, true);
    if (typeof attempt.correct !== "boolean") fail(`state.attempts[${index}].correct must be boolean`);
    assertSafeInt(attempt.elapsedMs, `state.attempts[${index}].elapsedMs`);
    assertDate(attempt.createdAt, `state.attempts[${index}].createdAt`);
    assertString(attempt.deviceId, `state.attempts[${index}].deviceId`);
    if (attempt.reviewRoundId !== undefined) {
      assertEntityId(attempt.reviewRoundId, `state.attempts[${index}].reviewRoundId`);
      if (!rounds.has(attempt.reviewRoundId)) fail(`state.attempts[${index}] references missing round`);
    }
    assertOptionalString(attempt.sourceBankId, `state.attempts[${index}].sourceBankId`);
    if (attempts.has(attempt.id)) fail(`duplicate attempt ${attempt.id}`);
    attempts.add(attempt.id);
  });
  state.practiceRunItems.forEach((item, index) => {
    if (item.submittedAttemptId !== undefined && !attempts.has(item.submittedAttemptId)) fail(`state.practiceRunItems[${index}] references missing submitted attempt ${item.submittedAttemptId}`);
  });

  state.notes.forEach((note, index) => {
    if (!isRecord(note)) fail(`state.notes[${index}] must be an object`);
    assertEntityId(note.questionId, `state.notes[${index}].questionId`);
    if (!questions.has(note.questionId)) fail(`state.notes[${index}] references missing question`);
    assertString(note.content, `state.notes[${index}].content`, true);
    assertSafeInt(note.revision, `state.notes[${index}].revision`);
    assertDate(note.updatedAt, `state.notes[${index}].updatedAt`);
    assertString(note.deviceId, `state.notes[${index}].deviceId`);
  });

  const groups = new Set<string>();
  state.questionGroups.forEach((group, index) => {
    if (!isRecord(group)) fail(`state.questionGroups[${index}] must be an object`);
    assertEntityId(group.id, `state.questionGroups[${index}].id`);
    assertString(group.name, `state.questionGroups[${index}].name`);
    assertString(group.type, `state.questionGroups[${index}].type`);
    assertString(group.description, `state.questionGroups[${index}].description`, true);
    assertDate(group.createdAt, `state.questionGroups[${index}].createdAt`);
    assertDate(group.updatedAt, `state.questionGroups[${index}].updatedAt`);
    assertString(group.deviceId, `state.questionGroups[${index}].deviceId`);
    if (groups.has(group.id)) fail(`duplicate question group ${group.id}`);
    groups.add(group.id);
  });
  const groupItems = new Set<string>();
  state.questionGroupItems.forEach((item, index) => {
    if (!isRecord(item)) fail(`state.questionGroupItems[${index}] must be an object`);
    assertEntityId(item.groupId, `state.questionGroupItems[${index}].groupId`);
    assertEntityId(item.questionId, `state.questionGroupItems[${index}].questionId`);
    assertSafeInt(item.position, `state.questionGroupItems[${index}].position`);
    assertOptionalString(item.note, `state.questionGroupItems[${index}].note`, true);
    if (!groups.has(item.groupId)) fail(`state.questionGroupItems[${index}] references missing group`);
    if (!questions.has(item.questionId)) fail(`state.questionGroupItems[${index}] references missing question`);
    const key = `${item.groupId}:${item.questionId}`;
    if (groupItems.has(key)) fail(`duplicate question group item ${key}`);
    groupItems.add(key);
  });

  state.tombstones.forEach((tombstone, index) => {
    if (!isRecord(tombstone)) fail(`state.tombstones[${index}] must be an object`);
    assertString(tombstone.key, `state.tombstones[${index}].key`);
    assertString(tombstone.entityType, `state.tombstones[${index}].entityType`);
    if (!["bank", "bankFolder", "question", "practiceRun", "questionGroup", "membership", "imageAsset", "note", "attempt"].includes(tombstone.entityType)) fail(`state.tombstones[${index}].entityType is invalid`);
    assertEntityId(tombstone.entityId, `state.tombstones[${index}].entityId`);
    assertDate(tombstone.deletedAt, `state.tombstones[${index}].deletedAt`);
    assertString(tombstone.deviceId, `state.tombstones[${index}].deviceId`);
    assertString(tombstone.eventId, `state.tombstones[${index}].eventId`);
    assertSafeInt(tombstone.sequence, `state.tombstones[${index}].sequence`);
  });
}

/** Strictly validate an unknown value as a complete current checkpoint. */
export function validateSyncCheckpoint(value: unknown): asserts value is SyncCheckpoint {
  if (!isRecord(value) || value.formatVersion !== SYNC_CHECKPOINT_FORMAT) fail(`formatVersion must be ${SYNC_CHECKPOINT_FORMAT}`);
  assertDate(value.generatedAt, "generatedAt");
  if (!isRecord(value.state)) fail("state must be an object");
  assertExactKeys(value.state, STATE_FIELDS, "state");
  for (const field of STATE_FIELDS) assertArray(value.state[field], `state.${field}`);
  const state = value.state as unknown as SyncCheckpointState;
  validateCanonicalState(state);

  if (!isRecord(value.cursors)) fail("cursors must be an object");
  for (const [deviceId, sequence] of Object.entries(value.cursors)) {
    assertString(deviceId, "cursor device id");
    assertSafeInt(sequence, `cursors.${deviceId}`);
  }

  if (!isRecord(value.counts)) fail("counts must be an object");
  assertExactKeys(value.counts, COUNT_FIELDS, "counts");
  const expected: SyncCheckpointCounts = {
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
  for (const [field, number] of Object.entries(expected)) {
    assertSafeInt(value.counts[field], `counts.${field}`);
    if (value.counts[field] !== number) fail(`counts.${field} does not match state`);
  }
}

export function isSyncCheckpoint(value: unknown): value is SyncCheckpoint {
  try {
    validateSyncCheckpoint(value);
    return true;
  } catch {
    return false;
  }
}
