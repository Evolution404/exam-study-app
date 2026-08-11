import { createHash } from "node:crypto";
import type {
  Attempt,
  AttemptDailyStats,
  AttemptStats,
  Bank,
  BankFolder,
  Note,
  PracticeAnswerState,
  PracticeRun,
  Question,
  QuestionGroup,
  SyncCheckpointV5,
  SyncEvent,
  SyncTombstone,
} from "./types";
import type {
  BankQuestionMembership,
  ContentBlock,
  ImageAsset,
  ImageAssetRemoteDescriptor,
  QuestionV6,
  PracticeRunV6,
  AttemptV6,
} from "./v6-types";
import type { ImageMimeType } from "./image-assets";
import { normalizeContentText, questionContentFingerprint } from "./question-content";
import {
  SYNC_V6_ARCHIVE_CATALOG_PREFIX,
  SYNC_V6_ARCHIVE_PREFIX,
  SYNC_V6_ASSET_PREFIX,
  SYNC_V6_CHECKPOINT_PREFIX,
  SYNC_V6_EVENT_PREFIX,
  SYNC_V6_MAX_EVENT_BYTES,
  SYNC_V6_MAX_HOT_EVENT_BYTES,
  planSyncV6HotTail,
  type SyncHeadV6,
  type SyncV6Descriptor,
  type SyncV6EventPageDescriptor,
  type SyncV6PublicationFile,
} from "./sync-v6-head";

/**
 * The migration code intentionally has no IndexedDB dependency.  Its input is
 * a complete, already downloaded v5 snapshot and its output is a deterministic
 * publication package.  The command-line reader in migrate-cloud-v5-to-v6.ts
 * is responsible for downloading and hydrating the input.
 */

export interface HydratedV5Event extends SyncEvent {
  /** v5 practice events may carry the downloaded practice definition here. */
  resolvedPayload?: unknown;
}

export interface PreparedMigrationImage {
  sourceUrl: string;
  id: string;
  mimeType: ImageMimeType;
  bytes: Uint8Array;
  width: number;
  height: number;
}

export interface V5ToV6Input {
  checkpoint: SyncCheckpointV5;
  archiveAttempts?: readonly Attempt[];
  archivePracticeRuns?: readonly PracticeRun[];
  hotEvents?: readonly HydratedV5Event[];
  /** SHA-1 blob id returned while reading sync/v5/head.json. */
  sourceHeadBlobSha?: string;
  imageAssets?: ReadonlyMap<string, PreparedMigrationImage> | Readonly<Record<string, PreparedMigrationImage>>;
  generatedAt?: string;
}

export interface V6AttemptStats extends Omit<AttemptStats, "questionId" | "bankId" | "recentOutcomes"> {
  questionId: string;
  bankId: string;
  recentOutcomes: Array<{ id: string; createdAt: string; correct: boolean }>;
}

export interface V6DailyStats extends Omit<AttemptDailyStats, "questionId" | "bankId" | "key"> {
  key: string;
  questionId: string;
  bankId: string;
}

export interface V6QuestionGroup extends Omit<QuestionGroup, "items"> {
  items: Array<{ questionId: string; note: string }>;
}

export interface V6Checkpoint {
  formatVersion: 6;
  generatedAt: string;
  state: {
    banks: Bank[];
    bankFolders: BankFolder[];
    questions: QuestionV6[];
    memberships: BankQuestionMembership[];
    attemptStats: V6AttemptStats[];
    recentAttemptDailyStats: V6DailyStats[];
    recentAttempts: AttemptV6[];
    notes: Note[];
    recentPracticeRuns: PracticeRunV6[];
    practiceRunStats: Array<Record<string, unknown>>;
    questionGroups: V6QuestionGroup[];
    tombstones: SyncTombstone[];
    imageAssets: ImageAsset[];
    reviewRounds: [];
    reviewRoundProgress: [];
    /** Hydrated hot events are retained in the checkpoint before pagination. */
    events: V6Event[];
  };
  cursors: Record<string, number>;
  retention: {
    recentAttemptLimit: number;
    recentPracticeRunLimit: number;
    oldestRecentAttemptAt: string | null;
  };
  counts: {
    banks: number;
    questions: number;
    memberships: number;
    totalAttempts: number;
    recentAttempts: number;
    totalPracticeRuns: number;
    recentPracticeRuns: number;
    notes: number;
    stats: number;
    questionGroups: number;
    imageAssets: number;
    reviewRounds: number;
    reviewRoundProgress: number;
  };
}

export interface V6Event {
  id: string;
  type: string;
  payload: unknown;
  deviceId: string;
  sequence: number;
  createdAt: string;
}

export interface V6ArchiveSegmentPayload {
  formatVersion: 6;
  kind: "attempts" | "practice-runs";
  rows: AttemptV6[] | PracticeRunV6[];
}

export interface V6ArchiveSegment extends SyncV6Descriptor {
  month: string;
  count: number;
  firstId: string;
  lastId: string;
  firstCreatedAt: string;
  lastCreatedAt: string;
}

export interface V6ArchiveCatalog {
  formatVersion: 6;
  generatedAt: string;
  attemptSegments: V6ArchiveSegment[];
  practiceRunSegments: V6ArchiveSegment[];
  counts: { attempts: number; practiceRuns: number };
}

export interface MigrationReport {
  sourceQuestions: number;
  uniqueQuestions: number;
  memberships: number;
  banks: number;
  attempts: number;
  archivedAttempts: number;
  practiceRuns: number;
  archivedPracticeRuns: number;
  stats: number;
  notes: number;
  questionGroups: number;
  images: number;
  imageBytes: number;
  hotEvents: number;
  eventPages: number;
  estimatedCheckpointBytes: number;
  estimatedArchiveBytes: number;
  estimatedBytes: number;
  estimated6000QuestionBytes: number;
  sixThousandQuestionHeadWithinHotWindow: boolean;
  failures: string[];
}

export interface V5ToV6Conversion {
  checkpoint: V6Checkpoint;
  archiveCatalog: V6ArchiveCatalog;
  assets: SyncV6PublicationFile[];
  immutable: SyncV6PublicationFile[];
  head: SyncHeadV6;
  archiveSegments: V6ArchiveSegment[];
  eventPages: SyncV6EventPageDescriptor[];
  oldQuestionIdToNewId: Record<string, string>;
  report: MigrationReport;
}

const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const RECENT_ATTEMPT_LIMIT = 2_000;
const RECENT_RUN_LIMIT = 100;
const ARCHIVE_SEGMENT_ROWS = 500;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return normalizeContentText(typeof value === "string" ? value : String(value ?? ""));
}

function maxIso(...values: Array<string | undefined>): string {
  return values.filter(Boolean).sort((left, right) => String(left).localeCompare(String(right))).at(-1) ?? new Date(0).toISOString();
}

function minIso(...values: Array<string | undefined>): string {
  return values.filter(Boolean).sort((left, right) => String(left).localeCompare(String(right)))[0] ?? new Date(0).toISOString();
}

function sha256(bytes: Uint8Array | string): string {
  const hash = createHash("sha256");
  hash.update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : bytes);
  return hash.digest("hex");
}

function gitBlobSha(bytes: Uint8Array): string {
  const header = Buffer.from(`blob ${bytes.byteLength}\0`, "utf8");
  const hash = createHash("sha1");
  hash.update(header);
  hash.update(bytes);
  return hash.digest("hex");
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function descriptor(path: string, bytes: Uint8Array): SyncV6Descriptor {
  const digest = sha256(bytes);
  return { path, blobSha: gitBlobSha(bytes), sha256: digest, size: bytes.byteLength };
}

function publication(path: string, bytes: Uint8Array, kind: SyncV6PublicationFile["kind"]): SyncV6PublicationFile {
  return { path, bytes, kind };
}

function assetMapLookup(
  assets: V5ToV6Input["imageAssets"],
  url: string,
): PreparedMigrationImage | undefined {
  if (!assets) return undefined;
  if (assets instanceof Map) return assets.get(url);
  return (assets as Readonly<Record<string, PreparedMigrationImage>>)[url];
}

function questionFingerprint(question: Question): string {
  return questionContentFingerprint({
    type: question.type,
    content: [{ id: "stem", type: "text", text: text(question.stem) }],
    options: question.options.map((option, index) => [{ id: `option-${index}`, type: "text", text: text(option) }]),
    answer: text(question.answer),
  });
}

function imageBlock(question: Question, assets: V5ToV6Input["imageAssets"], failures: string[]): { block?: ContentBlock; asset?: PreparedMigrationImage } {
  const imageUrl = typeof question.imageUrl === "string" ? question.imageUrl.trim() : "";
  if (!imageUrl) return {};
  const prepared = assetMapLookup(assets, imageUrl);
  if (!prepared) {
    failures.push(`图片未完成预检：${imageUrl}`);
    return {};
  }
  let valid = true;
  if (!/^[a-f0-9]{64}$/.test(prepared.id)) {
    failures.push(`图片摘要无效：${imageUrl}`);
    valid = false;
  }
  if (!Number.isSafeInteger(prepared.bytes.byteLength) || prepared.bytes.byteLength <= 0 || prepared.bytes.byteLength > MAX_ASSET_BYTES) {
    failures.push(`图片超过 2MiB 或为空：${imageUrl}`);
    valid = false;
  }
  if (!["image/webp", "image/jpeg", "image/png"].includes(prepared.mimeType)) {
    failures.push(`图片输出格式无效：${imageUrl}`);
    valid = false;
  }
  if (!valid) return {};
  return {
    block: { id: "image-0", type: "image", assetId: prepared.id },
    asset: prepared,
  };
}

function mapQuestionId(map: ReadonlyMap<string, string>, value: unknown): string {
  return typeof value === "string" ? map.get(value) ?? value : String(value ?? "");
}

function mapQuestionIds(map: ReadonlyMap<string, string>, values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((value) => mapQuestionId(map, value)).filter(Boolean))];
}

function answerTime(answer: PracticeAnswerState | undefined, fallback: string): string {
  return answer?.updatedAt ?? fallback;
}

function answerWins(current: PracticeAnswerState | undefined, candidate: PracticeAnswerState, fallbackCurrent: string, fallbackCandidate: string): boolean {
  if (!current) return true;
  const currentTime = answerTime(current, fallbackCurrent);
  const candidateTime = answerTime(candidate, fallbackCandidate);
  if (candidateTime !== currentTime) return candidateTime > currentTime;
  const currentDevice = current.deviceId ?? "";
  const candidateDevice = candidate.deviceId ?? "";
  if (candidateDevice !== currentDevice) return candidateDevice > currentDevice;
  return (candidate.eventId ?? "") > (current.eventId ?? "");
}

function mapRun(run: PracticeRun, map: ReadonlyMap<string, string>, fallbackUpdatedAt: string): PracticeRunV6 {
  const questionIds = mapQuestionIds(map, run.questionIds);
  const answers: Record<string, PracticeAnswerState> = {};
  for (const [oldId, answer] of Object.entries(run.answers ?? {})) {
    const id = mapQuestionId(map, oldId);
    const prior = answers[id];
    if (!prior || answerWins(prior, answer, fallbackUpdatedAt, fallbackUpdatedAt)) answers[id] = { ...answer, selected: [...(answer.selected ?? [])] };
  }
  const questionTypes: Record<string, Question["type"]> = {};
  for (const [oldId, type] of Object.entries(run.questionTypes ?? {})) questionTypes[mapQuestionId(map, oldId)] = type;
  const optionOrders: Record<string, number[]> = {};
  for (const [oldId, order] of Object.entries(run.optionOrders ?? {})) optionOrders[mapQuestionId(map, oldId)] = [...order];
  return {
    ...run,
    questionIds,
    answers,
    questionTypes,
    optionOrders,
    updatedAt: run.updatedAt || fallbackUpdatedAt,
  };
}

function mergeRun(target: PracticeRunV6, candidate: PracticeRunV6): PracticeRunV6 {
  const merged: PracticeRunV6 = {
    ...target,
    ...(candidate.updatedAt >= target.updatedAt ? candidate : {}),
    questionIds: [...new Set([...target.questionIds, ...candidate.questionIds])],
    answers: { ...target.answers },
    questionTypes: { ...target.questionTypes },
    optionOrders: { ...target.optionOrders },
  };
  for (const questionId of Object.keys(candidate.answers)) {
    const answer = candidate.answers[questionId];
    const prior = merged.answers[questionId];
    if (!prior || answerWins(prior, answer, target.updatedAt, candidate.updatedAt)) merged.answers[questionId] = answer;
  }
  Object.assign(merged.questionTypes, candidate.questionTypes);
  Object.assign(merged.optionOrders, candidate.optionOrders);
  return merged;
}

function mapAttempt(attempt: Attempt, map: ReadonlyMap<string, string>): AttemptV6 {
  return { ...attempt, questionId: mapQuestionId(map, attempt.questionId), sourceBankId: attempt.bankId };
}

function mergeStats(rows: readonly AttemptStats[], map: ReadonlyMap<string, string>, extraAttempts: readonly AttemptV6[]): V6AttemptStats[] {
  const byQuestion = new Map<string, V6AttemptStats>();
  const add = (row: V6AttemptStats) => {
    const current = byQuestion.get(row.questionId);
    if (!current) {
      byQuestion.set(row.questionId, {
        ...row,
        recentOutcomes: row.recentOutcomes.map((outcome) => ({ ...outcome })),
      });
      return;
    }
    const outcomes = new Map(current.recentOutcomes.map((outcome) => [outcome.id, outcome]));
    for (const outcome of row.recentOutcomes) outcomes.set(outcome.id, { ...outcome });
    const firstCurrent = current.firstAttemptAt;
    const firstCandidate = row.firstAttemptAt;
    const firstIsCandidate = firstCandidate < firstCurrent;
    current.total += row.total;
    current.correct += row.correct;
    current.wrong += row.wrong;
    current.giveUps += row.giveUps;
    current.totalElapsedMs += row.totalElapsedMs;
    current.firstAttemptAt = firstIsCandidate ? firstCandidate : firstCurrent;
    current.firstAttemptCorrect = firstIsCandidate ? row.firstAttemptCorrect : current.firstAttemptCorrect;
    current.latestAttemptAt = maxIso(current.latestAttemptAt, row.latestAttemptAt);
    current.hasBeenWrong = current.hasBeenWrong || row.hasBeenWrong;
    current.recentOutcomes = [...outcomes.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    current.currentCorrectStreak = current.recentOutcomes.slice().reverse().reduce((streak, outcome) => outcome.correct ? streak + 1 : 0, 0);
    current.correctStreakAfterWrong = current.recentOutcomes.slice().reverse().reduce((streak, outcome) => outcome.correct ? streak + 1 : (streak ? streak : 0), 0);
  };
  for (const stats of rows) {
    const questionId = mapQuestionId(map, stats.questionId);
    if (!questionId) continue;
    add({ ...stats, questionId, bankId: stats.bankId });
  }
  for (const attempt of extraAttempts) {
    const prior = byQuestion.get(attempt.questionId);
    const outcome = { id: attempt.id, createdAt: attempt.createdAt, correct: attempt.correct };
    if (!prior) {
      byQuestion.set(attempt.questionId, {
        questionId: attempt.questionId,
        bankId: attempt.sourceBankId ?? "",
        total: 1,
        correct: attempt.correct ? 1 : 0,
        wrong: attempt.correct ? 0 : 1,
        giveUps: 0,
        totalElapsedMs: attempt.elapsedMs,
        firstAttemptAt: attempt.createdAt,
        firstAttemptCorrect: attempt.correct,
        latestAttemptAt: attempt.createdAt,
        hasBeenWrong: !attempt.correct,
        correctStreakAfterWrong: attempt.correct ? 0 : 0,
        currentCorrectStreak: attempt.correct ? 1 : 0,
        recentOutcomes: [outcome],
      });
      continue;
    }
    if (prior.recentOutcomes.some((item) => item.id === attempt.id)) continue;
    prior.total += 1;
    prior.correct += attempt.correct ? 1 : 0;
    prior.wrong += attempt.correct ? 0 : 1;
    prior.totalElapsedMs += attempt.elapsedMs;
    prior.firstAttemptAt = minIso(prior.firstAttemptAt, attempt.createdAt);
    if (attempt.createdAt === prior.firstAttemptAt) prior.firstAttemptCorrect = attempt.correct;
    prior.latestAttemptAt = maxIso(prior.latestAttemptAt, attempt.createdAt);
    prior.hasBeenWrong = prior.hasBeenWrong || !attempt.correct;
    prior.recentOutcomes = [...prior.recentOutcomes, outcome].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    prior.currentCorrectStreak = prior.recentOutcomes.slice().reverse().reduce((streak, item) => item.correct ? streak + 1 : 0, 0);
  }
  return [...byQuestion.values()].sort((left, right) => left.questionId.localeCompare(right.questionId));
}

function mapPayload(value: unknown, map: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => mapPayload(item, map));
  const record = asRecord(value);
  if (!record) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (key === "questionId") result[key] = mapQuestionId(map, item);
    else if (key === "questionIds") result[key] = mapQuestionIds(map, item);
    else if (key === "answers" && asRecord(item)) {
      const answerRecord = asRecord(item)!;
      const answers: Record<string, unknown> = {};
      for (const [oldId, answer] of Object.entries(answerRecord)) answers[mapQuestionId(map, oldId)] = mapPayload(answer, map);
      result[key] = answers;
    } else if (key === "questionTypes" && asRecord(item)) {
      const typeRecord = asRecord(item)!;
      const types: Record<string, unknown> = {};
      for (const [oldId, type] of Object.entries(typeRecord)) types[mapQuestionId(map, oldId)] = type;
      result[key] = types;
    } else if (key === "optionOrders" && asRecord(item)) {
      const orderRecord = asRecord(item)!;
      const orders: Record<string, unknown> = {};
      for (const [oldId, order] of Object.entries(orderRecord)) orders[mapQuestionId(map, oldId)] = order;
      result[key] = orders;
    } else result[key] = mapPayload(item, map);
  }
  return result;
}

function convertEvent(event: HydratedV5Event, map: ReadonlyMap<string, string>): V6Event {
  const payload = mapPayload(event.payload, map);
  return {
    id: event.id,
    type: event.type,
    payload,
    deviceId: event.deviceId,
    sequence: event.sequence,
    createdAt: event.createdAt,
  };
}

function collectEventAttempts(events: readonly HydratedV5Event[], map: ReadonlyMap<string, string>): AttemptV6[] {
  const byId = new Map<string, AttemptV6>();
  for (const event of events) {
    const payload = asRecord(event.payload);
    const candidate = event.type === "attempt.created" ? payload : event.type === "practice.answer.submitted" ? asRecord(payload?.attempt) : undefined;
    if (!candidate || typeof candidate.id !== "string" || typeof candidate.questionId !== "string") continue;
    const attempt = mapAttempt(candidate as unknown as Attempt, map);
    if (!attempt.questionId) continue;
    if (!byId.has(attempt.id)) byId.set(attempt.id, attempt);
  }
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
}

function collectEventRuns(events: readonly HydratedV5Event[], map: ReadonlyMap<string, string>): Map<string, PracticeRunV6> {
  const runs = new Map<string, PracticeRunV6>();
  const upsert = (run: PracticeRun, updatedAt: string) => {
    const mapped = mapRun(run, map, updatedAt);
    const prior = runs.get(mapped.id);
    runs.set(mapped.id, prior ? mergeRun(prior, mapped) : mapped);
  };
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.type === "practice.run.created") {
      const run = asRecord(event.resolvedPayload) ?? payload;
      if (run?.id && run.questionIds) upsert(run as unknown as PracticeRun, event.createdAt);
    } else if (event.type === "practice.answer.submitted") {
      const resolved = asRecord(event.resolvedPayload);
      if (resolved?.id && resolved.questionIds) upsert(resolved as unknown as PracticeRun, event.createdAt);
      const attempt = asRecord(payload?.attempt);
      const answer = asRecord(payload?.answer);
      if (typeof attempt?.runId === "string" && typeof attempt.questionId === "string") {
        let run = runs.get(attempt.runId);
        if (!run) {
          run = {
            id: attempt.runId,
            bankId: typeof attempt.bankId === "string" ? attempt.bankId : "",
            bankIds: typeof attempt.bankId === "string" ? [attempt.bankId] : [],
            bankName: "",
            mode: "sequential",
            modeLabel: "",
            questionIds: [mapQuestionId(map, attempt.questionId)],
            questionTypes: {},
            answers: {},
            shuffleOptions: false,
            optionOrders: {},
            startedAt: event.createdAt,
            updatedAt: event.createdAt,
            status: "in_progress",
            revision: 1,
          };
        }
        const questionId = mapQuestionId(map, attempt.questionId);
        if (!run.questionIds.includes(questionId)) run.questionIds.push(questionId);
        const candidate: PracticeAnswerState = {
          selected: Array.isArray(answer?.selected) ? answer.selected.map(String) : [String(attempt.selected ?? "")],
          submitted: answer?.submitted !== false,
          ...(typeof answer?.correct === "boolean" ? { correct: answer.correct } : { correct: Boolean(attempt.correct) }),
          updatedAt: typeof answer?.updatedAt === "string" ? answer.updatedAt : event.createdAt,
          deviceId: typeof answer?.deviceId === "string" ? answer.deviceId : event.deviceId,
          eventId: typeof answer?.eventId === "string" ? answer.eventId : event.id,
        };
        const current = run.answers[questionId];
        if (!current || answerWins(current, candidate, run.updatedAt, event.createdAt)) run.answers[questionId] = candidate;
        run.updatedAt = maxIso(run.updatedAt, event.createdAt);
        runs.set(run.id, run);
      }
    } else if (event.type === "practice.run.status.changed") {
      if (typeof payload?.id !== "string") continue;
      const run = runs.get(payload.id);
      if (run) {
        if (typeof payload.status === "string") run.status = payload.status as PracticeRun["status"];
        if (typeof payload.updatedAt === "string") run.updatedAt = maxIso(run.updatedAt, payload.updatedAt);
        if (typeof payload.completedAt === "string") run.completedAt = payload.completedAt;
        if (typeof payload.abandonedAt === "string") run.abandonedAt = payload.abandonedAt;
        if (Number.isSafeInteger(payload.revision)) run.revision = Math.max(run.revision, payload.revision as number);
      }
    }
  }
  return runs;
}

function mapGroups(groups: readonly QuestionGroup[], map: ReadonlyMap<string, string>): V6QuestionGroup[] {
  return groups.map((group) => ({
    ...group,
    items: group.items.map((item) => ({ ...item, questionId: mapQuestionId(map, item.questionId) }))
      .filter((item) => Boolean(item.questionId))
      .filter((item, index, all) => all.findIndex((candidate) => candidate.questionId === item.questionId) === index),
  }));
}

function mapDailyStats(rows: readonly AttemptDailyStats[], map: ReadonlyMap<string, string>): V6DailyStats[] {
  const byKey = new Map<string, V6DailyStats>();
  for (const row of rows) {
    const questionId = mapQuestionId(map, row.questionId);
    if (!questionId) continue;
    const key = `${row.date}:${questionId}`;
    const prior = byKey.get(key);
    if (!prior) byKey.set(key, { ...row, key, questionId });
    else {
      prior.total += row.total;
      prior.correct += row.correct;
      prior.wrong += row.wrong;
      prior.giveUps += row.giveUps;
      prior.totalElapsedMs += row.totalElapsedMs;
    }
  }
  return [...byKey.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function buildPracticeRunStats(runs: readonly PracticeRunV6[]): Array<Record<string, unknown>> {
  const byBank = new Map<string, Record<string, unknown>>();
  for (const run of runs) {
    const bankId = run.bankId || "";
    const current = byBank.get(bankId) ?? { bankId, total: 0, completed: 0, inProgress: 0, abandoned: 0, latestUpdatedAt: run.updatedAt };
    current.total = Number(current.total) + 1;
    if (run.status === "completed") current.completed = Number(current.completed) + 1;
    else if (run.status === "abandoned") current.abandoned = Number(current.abandoned) + 1;
    else current.inProgress = Number(current.inProgress) + 1;
    current.latestUpdatedAt = maxIso(String(current.latestUpdatedAt), run.updatedAt);
    byBank.set(bankId, current);
  }
  const all = [...byBank.values()].reduce((summary, row) => {
    summary.total = Number(summary.total) + Number(row.total);
    summary.completed = Number(summary.completed) + Number(row.completed);
    summary.inProgress = Number(summary.inProgress) + Number(row.inProgress);
    summary.abandoned = Number(summary.abandoned) + Number(row.abandoned);
    summary.latestUpdatedAt = maxIso(String(summary.latestUpdatedAt), String(row.latestUpdatedAt));
    return summary;
  }, { bankId: "__all__", total: 0, completed: 0, inProgress: 0, abandoned: 0, latestUpdatedAt: new Date(0).toISOString() } as Record<string, unknown>);
  return [...byBank.values(), all];
}

interface EffectiveV5Entities {
  banks: Bank[];
  questions: Question[];
  tombstones: SyncTombstone[];
}

function entityClock(event: HydratedV5Event): string {
  return `${event.createdAt}\u0000${event.deviceId}\u0000${String(event.sequence).padStart(12, "0")}\u0000${event.id}`;
}

function payloadEntity(value: unknown, key: string): Record<string, unknown> | undefined {
  const record = asRecord(value);
  const nested = record && asRecord(record[key]);
  return nested ?? record;
}

/** Apply the entity-bearing v5 hot events before content fingerprinting. */
function reduceV5Entities(input: V5ToV6Input): EffectiveV5Entities {
  const banks = new Map<string, Bank>(input.checkpoint.state.banks.map((bank) => [bank.id, { ...bank }]));
  const questions = new Map<string, Question>(input.checkpoint.state.questions.map((question) => [question.id, { ...question }]));
  const removedBanks = new Set(input.checkpoint.state.tombstones.filter((tombstone) => tombstone.entityType === "bank").map((tombstone) => tombstone.entityId));
  const removedQuestions = new Set(input.checkpoint.state.tombstones.filter((tombstone) => tombstone.entityType === "question").map((tombstone) => tombstone.entityId));
  const clocks = new Map<string, string>();
  const tombstones = input.checkpoint.state.tombstones.map((tombstone) => ({ ...tombstone }));
  const events = [...(input.hotEvents ?? [])].sort((left, right) => entityClock(left).localeCompare(entityClock(right)));
  const accept = (key: string, event: HydratedV5Event): boolean => {
    const clock = entityClock(event);
    const prior = clocks.get(key);
    if (prior && prior >= clock) return false;
    clocks.set(key, clock);
    return true;
  };
  for (const event of events) {
    const payload = asRecord(event.payload);
    if (event.type === "bank.imported") {
      const bankValue = payloadEntity(payload, "bank");
      if (bankValue && typeof bankValue.id === "string" && accept(`bank:${bankValue.id}`, event)) {
        banks.set(bankValue.id, { ...(banks.get(bankValue.id) ?? {} as Bank), ...(bankValue as unknown as Bank) });
        removedBanks.delete(bankValue.id);
      }
      const importedQuestions = payload && Array.isArray(payload.questions) ? payload.questions : [];
      for (const value of importedQuestions) {
        const question = value as Partial<Question>;
        if (typeof question.id !== "string" || !accept(`question:${question.id}`, event)) continue;
        questions.set(question.id, { ...(questions.get(question.id) ?? {} as Question), ...(question as Question) });
        removedQuestions.delete(question.id);
      }
    } else if (event.type === "bank.updated") {
      const bankValue = payloadEntity(payload, "bank");
      if (bankValue && typeof bankValue.id === "string" && accept(`bank:${bankValue.id}`, event)) {
        banks.set(bankValue.id, { ...(banks.get(bankValue.id) ?? {} as Bank), ...(bankValue as unknown as Bank) });
        removedBanks.delete(bankValue.id);
      }
    } else if (event.type === "bank.deleted") {
      const id = typeof payload?.id === "string" ? payload.id : typeof payload?.bankId === "string" ? payload.bankId : "";
      if (!id || !accept(`bank:${id}`, event)) continue;
      banks.delete(id);
      removedBanks.add(id);
      for (const question of questions.values()) if (question.bankId === id) removedQuestions.add(question.id);
      tombstones.push({ key: `bank:${id}`, entityType: "bank", entityId: id, deletedAt: event.createdAt, deviceId: event.deviceId, eventId: event.id });
    } else if (event.type === "question.created" || event.type === "question.updated") {
      const questionValue = payloadEntity(payload, "question");
      if (!questionValue || typeof questionValue.id !== "string" || !accept(`question:${questionValue.id}`, event)) continue;
      const prior = questions.get(questionValue.id);
      questions.set(questionValue.id, { ...(prior ?? {} as Question), ...(questionValue as unknown as Question) });
      removedQuestions.delete(questionValue.id);
    } else if (event.type === "question.deleted") {
      const id = typeof payload?.id === "string" ? payload.id : typeof payload?.questionId === "string" ? payload.questionId : "";
      if (!id || !accept(`question:${id}`, event)) continue;
      questions.delete(id);
      removedQuestions.add(id);
      tombstones.push({ key: `question:${id}`, entityType: "question", entityId: id, deletedAt: event.createdAt, deviceId: event.deviceId, eventId: event.id });
    }
  }
  const liveBanks = [...banks.values()].filter((bank) => !removedBanks.has(bank.id));
  const liveBankIds = new Set(liveBanks.map((bank) => bank.id));
  const liveQuestions = [...questions.values()].filter((question) => liveBankIds.has(question.bankId) && !removedQuestions.has(question.id));
  return { banks: liveBanks, questions: liveQuestions, tombstones };
}

/** Return only legacy image URLs that survive the v5 hot-entity reducer. */
export function collectFinalV5ImageUrls(input: V5ToV6Input): string[] {
  const effective = reduceV5Entities(input);
  return [...new Set(effective.questions.map((question) => question.imageUrl?.trim() ?? "").filter(Boolean))];
}

function archiveFiles<T extends AttemptV6 | PracticeRunV6>(kind: "attempts" | "practice-runs", rows: readonly T[]): { files: SyncV6PublicationFile[]; segments: V6ArchiveSegment[] } {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const timestamp = kind === "attempts" ? (row as AttemptV6).createdAt : (row as PracticeRunV6).updatedAt;
    const month = timestamp.slice(0, 7);
    grouped.set(month, [...(grouped.get(month) ?? []), row]);
  }
  const files: SyncV6PublicationFile[] = [];
  const segments: V6ArchiveSegment[] = [];
  for (const [month, monthRows] of [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (let offset = 0; offset < monthRows.length; offset += ARCHIVE_SEGMENT_ROWS) {
      const chunk = monthRows.slice(offset, offset + ARCHIVE_SEGMENT_ROWS);
      const payload: V6ArchiveSegmentPayload = {
        formatVersion: 6,
        kind,
        rows: (kind === "attempts" ? chunk as AttemptV6[] : chunk as PracticeRunV6[]),
      };
      const bytes = jsonBytes(payload);
      const digest = sha256(bytes);
      const path = `${SYNC_V6_ARCHIVE_PREFIX}${kind}/${month}/${digest}.json`;
      files.push(publication(path, bytes, "archiveSegment"));
      const fileDescriptor = descriptor(path, bytes);
      const first = chunk[0];
      const last = chunk.at(-1)!;
      const firstCreatedAt = kind === "attempts" ? (first as AttemptV6).createdAt : (first as PracticeRunV6).updatedAt;
      const lastCreatedAt = kind === "attempts" ? (last as AttemptV6).createdAt : (last as PracticeRunV6).updatedAt;
      segments.push({ ...fileDescriptor, month, count: chunk.length, firstId: first.id, lastId: last.id, firstCreatedAt, lastCreatedAt });
    }
  }
  return { files, segments };
}

function eventPageFiles(events: readonly V6Event[]): { files: SyncV6PublicationFile[]; descriptors: SyncV6EventPageDescriptor[]; archived: V6Event[]; hotBytes: number } {
  const pages = planSyncV6HotTail(events);
  const files: SyncV6PublicationFile[] = [];
  const descriptors: SyncV6EventPageDescriptor[] = [];
  for (const page of pages.pages) {
    if (page.size > SYNC_V6_MAX_EVENT_BYTES) throw new Error("v6 event page exceeds the 256KiB limit");
    const bytes = page.bytes;
    const digest = sha256(bytes);
    const path = `${SYNC_V6_EVENT_PREFIX}${digest}.json`;
    const cursor: Record<string, number> = {};
    for (const event of page.events) cursor[event.deviceId] = Math.max(cursor[event.deviceId] ?? 0, event.sequence);
    files.push(publication(path, bytes, "eventPage"));
    descriptors.push({ ...descriptor(path, bytes), count: page.count, deviceCursors: cursor });
  }
  return { files, descriptors, archived: pages.archived, hotBytes: pages.hotBytes };
}

function createHead(
  generatedAt: string,
  checkpoint: SyncV6Descriptor,
  archiveCatalog: SyncV6Descriptor,
  eventPages: readonly SyncV6EventPageDescriptor[],
  sourceHeadBlobSha?: string,
): SyncHeadV6 {
  return {
    formatVersion: 6,
    generatedAt,
    checkpoint,
    archiveCatalog,
    eventPages: [...eventPages].sort((left, right) => left.path.localeCompare(right.path)),
    ...(sourceHeadBlobSha && /^[a-f0-9]{40}$/.test(sourceHeadBlobSha)
      ? { source: { protocol: 5 as const, headPath: "sync/v5/head.json" as const, headBlobSha: sourceHeadBlobSha, generatedAt } }
      : {}),
  };
}

/** Convert a complete v5 package into a deterministic v6 publication package. */
export function convertV5ToV6(input: V5ToV6Input): V5ToV6Conversion {
  if (!input?.checkpoint || input.checkpoint.formatVersion !== 5) throw new TypeError("v5 checkpoint is required");
  const generatedAt = input.generatedAt ?? input.checkpoint.generatedAt;
  const failures: string[] = [];
  const effective = reduceV5Entities(input);
  const sourceQuestions = effective.questions;
  const oldToNew = new Map<string, string>();
  const byFingerprint = new Map<string, QuestionV6>();
  const imageAssets = new Map<string, PreparedMigrationImage>();
  const memberships: BankQuestionMembership[] = [];
  for (const question of sourceQuestions) {
    const fingerprint = questionFingerprint(question);
    oldToNew.set(question.id, fingerprint);
    const preparedImage = imageBlock(question, input.imageAssets, failures);
    if (preparedImage.asset) imageAssets.set(preparedImage.asset.id, preparedImage.asset);
    const current = byFingerprint.get(fingerprint);
    const content: ContentBlock[] = [
      { id: "text-0", type: "text", text: text(question.stem) },
      ...(preparedImage.block ? [preparedImage.block] : []),
    ];
    if (!current) {
      byFingerprint.set(fingerprint, {
        id: fingerprint,
        type: question.type,
        content,
        options: question.options.map((option, index) => [{ id: `option-${index}`, type: "text", text: text(option) }]),
        answer: text(question.answer),
        tags: [...new Set(question.tags.map(text).filter(Boolean))],
        ...(question.favorite ? { favorite: true } : {}),
        contentFingerprint: fingerprint,
        updatedAt: question.userUpdatedAt ?? generatedAt,
        deviceId: question.userUpdatedBy ?? "migration-v5",
      });
    } else {
      current.tags = [...new Set([...current.tags, ...question.tags.map(text).filter(Boolean)])];
      if (question.favorite) current.favorite = true;
      if (!current.content.some((block) => block.type === "image") && preparedImage.block) current.content.push(preparedImage.block);
      if (question.userUpdatedAt && question.userUpdatedAt > current.updatedAt) {
        current.updatedAt = question.userUpdatedAt;
        current.deviceId = question.userUpdatedBy ?? current.deviceId;
      }
    }
    const bank = effective.banks.find((candidate) => candidate.id === question.bankId);
    const addedAt = bank?.importedAt ?? generatedAt;
    memberships.push({
      key: `${question.bankId}:${fingerprint}`,
      bankId: question.bankId,
      questionId: fingerprint,
      sortOrder: Number.isFinite(question.sortOrder) ? question.sortOrder : memberships.filter((item) => item.bankId === question.bankId).length,
      addedAt,
      updatedAt: question.userUpdatedAt ?? addedAt,
      deviceId: question.userUpdatedBy ?? bank?.deviceId ?? "migration-v5",
    });
  }
  for (const question of input.checkpoint.state.questions) {
    if (!oldToNew.has(question.id)) oldToNew.set(question.id, "");
  }
  const uniqueMemberships = [...new Map(memberships.map((item) => [item.key, item])).values()]
    .sort((left, right) => left.bankId.localeCompare(right.bankId) || left.sortOrder - right.sortOrder || left.questionId.localeCompare(right.questionId));
  const questionMap = new Map(oldToNew);
  const archivedAttempts = input.archiveAttempts ?? [];
  const archivedRuns = input.archivePracticeRuns ?? [];
  const allAttemptsById = new Map<string, AttemptV6>();
  for (const attempt of [...archivedAttempts, ...input.checkpoint.state.recentAttempts]) {
    const mapped = mapAttempt(attempt, questionMap);
    if (mapped.questionId) allAttemptsById.set(attempt.id, mapped);
  }
  const hotAttempts = collectEventAttempts(input.hotEvents ?? [], questionMap);
  for (const attempt of hotAttempts) if (!allAttemptsById.has(attempt.id)) allAttemptsById.set(attempt.id, attempt);
  const allAttempts = [...allAttemptsById.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const recentAttempts = allAttempts.slice(-RECENT_ATTEMPT_LIMIT);
  const archivedAttemptRows = allAttempts.slice(0, Math.max(0, allAttempts.length - RECENT_ATTEMPT_LIMIT));
  const runMap = new Map<string, PracticeRunV6>();
  for (const run of [...archivedRuns, ...input.checkpoint.state.recentPracticeRuns]) {
    const mapped = mapRun(run, questionMap, generatedAt);
    runMap.set(mapped.id, runMap.has(mapped.id) ? mergeRun(runMap.get(mapped.id)!, mapped) : mapped);
  }
  for (const [id, run] of collectEventRuns(input.hotEvents ?? [], questionMap)) runMap.set(id, runMap.has(id) ? mergeRun(runMap.get(id)!, run) : run);
  const allRuns = [...runMap.values()].sort((left, right) => left.updatedAt.localeCompare(right.updatedAt) || left.id.localeCompare(right.id));
  const recentRuns = allRuns.slice(-RECENT_RUN_LIMIT);
  const archivedRunRows = allRuns.slice(0, Math.max(0, allRuns.length - RECENT_RUN_LIMIT));
  const eventAttemptsAfterCheckpoint = hotAttempts.filter((attempt) => !input.checkpoint.state.recentAttempts.some((row) => row.id === attempt.id));
  const baselineAttempts = allAttempts.filter((attempt) => !hotAttempts.some((candidate) => candidate.id === attempt.id));
  const baselineStatsTotal = input.checkpoint.state.attemptStats.reduce((sum, stats) => sum + stats.total, 0);
  const baselineGap = Math.max(0, baselineAttempts.length - baselineStatsTotal);
  const statsExtras = [...baselineAttempts.slice(0, baselineGap), ...eventAttemptsAfterCheckpoint];
  const attemptStats = mergeStats(input.checkpoint.state.attemptStats, questionMap, statsExtras);
  const dailyStats = mapDailyStats(input.checkpoint.state.recentAttemptDailyStats, questionMap);
  const notesByQuestion = new Map<string, Note>();
  for (const note of input.checkpoint.state.notes) {
    const questionId = mapQuestionId(questionMap, note.questionId);
    if (questionId) notesByQuestion.set(questionId, { ...note, questionId });
  }
  for (const event of input.hotEvents ?? []) {
    if (event.type !== "note.upserted") continue;
    const note = asRecord(event.payload);
    if (!note || typeof note.questionId !== "string") continue;
    const mapped = { ...(note as unknown as Note), questionId: mapQuestionId(questionMap, note.questionId) };
    if (!mapped.questionId) continue;
    const prior = notesByQuestion.get(mapped.questionId);
    if (!prior || mapped.updatedAt > prior.updatedAt || (mapped.updatedAt === prior.updatedAt && mapped.deviceId > prior.deviceId)) notesByQuestion.set(mapped.questionId, mapped);
  }
  const groups = mapGroups(input.checkpoint.state.questionGroups, questionMap);
  for (const event of input.hotEvents ?? []) {
    if (event.type !== "questionGroup.saved") continue;
    const group = asRecord(event.payload);
    if (!group || typeof group.id !== "string" || !Array.isArray(group.items)) continue;
    const mapped = mapGroups([group as unknown as QuestionGroup], questionMap)[0];
    const index = groups.findIndex((candidate) => candidate.id === mapped.id);
    if (index >= 0) groups[index] = mapped;
    else groups.push(mapped);
  }
  const mappedEvents = (input.hotEvents ?? []).map((event) => convertEvent(event, questionMap)).sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const checkpointCursors = { ...input.checkpoint.cursors };
  for (const event of mappedEvents) {
    checkpointCursors[event.deviceId] = Math.max(checkpointCursors[event.deviceId] ?? 0, event.sequence);
  }
  // The migration checkpoint already contains the fully reduced result of
  // every v5 hot event. Replaying those events after restoring the projection
  // can replace complete runs with legacy partial payloads or double-apply
  // statistics. Record their cursors as incorporated, but start the v6 hot
  // tail empty; only events created by v6 clients are paged from this point.
  const pages = eventPageFiles([]);
  const attemptsArchive = archiveFiles("attempts", archivedAttemptRows);
  const runsArchive = archiveFiles("practice-runs", archivedRunRows);
  const usedAssetIds = new Set([...byFingerprint.values()].flatMap((question) => question.content.filter((block): block is Extract<typeof block, { type: "image" }> => block.type === "image").map((block) => block.assetId)));
  const usedImages = [...imageAssets.values()].filter((asset) => usedAssetIds.has(asset.id));
  const assets: SyncV6PublicationFile[] = usedImages.sort((left, right) => left.id.localeCompare(right.id)).map((asset) => publication(`${SYNC_V6_ASSET_PREFIX}${asset.id}.${asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType.slice("image/".length)}`, asset.bytes, "asset"));
  const archiveCatalogPayload: V6ArchiveCatalog = {
    formatVersion: 6,
    generatedAt,
    attemptSegments: attemptsArchive.segments,
    practiceRunSegments: runsArchive.segments,
    counts: { attempts: archivedAttemptRows.length, practiceRuns: archivedRunRows.length },
  };
  const checkpoint: V6Checkpoint = {
    formatVersion: 6,
    generatedAt,
    state: {
      banks: effective.banks.map((bank) => ({ ...bank })),
      bankFolders: input.checkpoint.state.bankFolders.map((folder) => ({ ...folder })),
      questions: [...byFingerprint.values()].sort((left, right) => left.id.localeCompare(right.id)),
      memberships: uniqueMemberships,
      attemptStats,
      recentAttemptDailyStats: dailyStats,
      recentAttempts,
      notes: [...notesByQuestion.values()],
      recentPracticeRuns: recentRuns,
      practiceRunStats: buildPracticeRunStats(allRuns),
      questionGroups: groups,
      tombstones: effective.tombstones.map((tombstone) => ({ ...tombstone, entityId: tombstone.entityType === "question" ? mapQuestionId(questionMap, tombstone.entityId) : tombstone.entityId })),
      imageAssets: usedImages.map(imageAssetForV6),
      reviewRounds: [],
      reviewRoundProgress: [],
      events: [],
    },
    cursors: checkpointCursors,
    retention: { recentAttemptLimit: RECENT_ATTEMPT_LIMIT, recentPracticeRunLimit: RECENT_RUN_LIMIT, oldestRecentAttemptAt: recentAttempts[0]?.createdAt ?? null },
    counts: {
      banks: effective.banks.length,
      questions: byFingerprint.size,
      memberships: uniqueMemberships.length,
      totalAttempts: allAttempts.length,
      recentAttempts: recentAttempts.length,
      totalPracticeRuns: allRuns.length,
      recentPracticeRuns: recentRuns.length,
      notes: notesByQuestion.size,
      stats: attemptStats.length,
      questionGroups: groups.length,
      imageAssets: usedImages.length,
      reviewRounds: 0,
      reviewRoundProgress: 0,
    },
  };
  const checkpointBytes = jsonBytes(checkpoint);
  const checkpointDescriptor = descriptor(`${SYNC_V6_CHECKPOINT_PREFIX}${sha256(checkpointBytes)}.json`, checkpointBytes);
  const catalogBytes = jsonBytes(archiveCatalogPayload);
  const catalogDescriptor = descriptor(`${SYNC_V6_ARCHIVE_CATALOG_PREFIX}${sha256(catalogBytes)}.json`, catalogBytes);
  const immutable: SyncV6PublicationFile[] = [
    publication(checkpointDescriptor.path, checkpointBytes, "checkpoint"),
    ...attemptsArchive.files,
    ...runsArchive.files,
    publication(catalogDescriptor.path, catalogBytes, "archiveCatalog"),
    ...pages.files,
  ];
  const head = createHead(generatedAt, checkpointDescriptor, catalogDescriptor, pages.descriptors, input.sourceHeadBlobSha);
  const estimatedCheckpointBytes = checkpointBytes.byteLength;
  const estimatedArchiveBytes = [...attemptsArchive.files, ...runsArchive.files].reduce((sum, file) => sum + (file.bytes instanceof Uint8Array ? file.bytes.byteLength : new TextEncoder().encode(String(file.bytes)).byteLength), 0) + catalogBytes.byteLength;
  const estimatedBytes = estimatedCheckpointBytes + estimatedArchiveBytes + assets.reduce((sum, file) => sum + (file.bytes instanceof Uint8Array ? file.bytes.byteLength : new TextEncoder().encode(String(file.bytes)).byteLength), 0) + pages.files.reduce((sum, file) => sum + (file.bytes instanceof Uint8Array ? file.bytes.byteLength : new TextEncoder().encode(String(file.bytes)).byteLength), 0);
  const estimated6000QuestionBytes = Math.ceil(estimatedCheckpointBytes * (6_000 / Math.max(1, byFingerprint.size)));
  const report: MigrationReport = {
    sourceQuestions: sourceQuestions.length,
    uniqueQuestions: byFingerprint.size,
    memberships: uniqueMemberships.length,
    banks: input.checkpoint.state.banks.length,
    attempts: allAttempts.length,
    archivedAttempts: archivedAttemptRows.length,
    practiceRuns: allRuns.length,
    archivedPracticeRuns: archivedRunRows.length,
    stats: attemptStats.length,
    notes: notesByQuestion.size,
    questionGroups: groups.length,
    images: usedImages.length,
    imageBytes: usedImages.reduce((sum, asset) => sum + asset.bytes.byteLength, 0),
    hotEvents: mappedEvents.length,
    eventPages: pages.descriptors.length,
    estimatedCheckpointBytes,
    estimatedArchiveBytes,
    estimatedBytes,
    estimated6000QuestionBytes,
    sixThousandQuestionHeadWithinHotWindow: pages.hotBytes <= SYNC_V6_MAX_HOT_EVENT_BYTES,
    failures: [...new Set(failures)],
  };
  return {
    checkpoint,
    archiveCatalog: archiveCatalogPayload,
    assets,
    immutable,
    head,
    archiveSegments: [...attemptsArchive.segments, ...runsArchive.segments],
    eventPages: pages.descriptors,
    oldQuestionIdToNewId: Object.fromEntries([...questionMap.entries()].filter(([, questionId]) => questionId)),
    report,
  };
}

/** Small helper used by tests and the CLI to inspect source image mappings. */
export function imageAssetRemoteDescriptor(asset: PreparedMigrationImage): ImageAssetRemoteDescriptor {
  return {
    path: `${SYNC_V6_ASSET_PREFIX}${asset.id}.${asset.mimeType === "image/jpeg" ? "jpg" : asset.mimeType.slice("image/".length)}`,
    blobSha: gitBlobSha(asset.bytes),
    sha256: asset.id,
    size: asset.bytes.byteLength,
  };
}

/** Convert a prepared image to the v6 domain shape without retaining a Blob. */
export function imageAssetForV6(asset: PreparedMigrationImage): ImageAsset {
  return {
    id: asset.id,
    mimeType: asset.mimeType,
    size: asset.bytes.byteLength,
    width: asset.width,
    height: asset.height,
    remote: imageAssetRemoteDescriptor(asset),
  };
}
