import type { AttemptV7, PracticeRunV7 } from "../db/v7-types";
import type { ChangeSetProjectionV7 } from "./change-set-v7-projection";
import { finalizeRebasedProjectionV7 } from "./change-set-v7-projection";
import { filterProjectionHistoryV7, historyTimestampIncluded, normalizeHistorySyncStart } from "./history-sync-range";
import type { GitHubV7Remote, SyncV7HeadCache } from "./github-v7-remote";
import { descriptorPath, sha256 } from "./sync-v7-context";
import { checkpointFromProjection } from "./sync-v7-checkpoint-bridge";
import {
  parseSyncCheckpointV7,
  validateSyncCheckpointV7,
  type SyncCheckpointV7,
  type SyncCheckpointV7Counts,
  type SyncCheckpointV7State,
} from "./sync-v7-checkpoint";
import {
  SYNC_V8_HISTORY_PREFIX,
  type SyncHeadV7,
  type SyncV7Descriptor,
} from "./sync-v7-head";

export const SYNC_V8_CHECKPOINT_FORMAT = 8 as const;
export const SYNC_V8_RECENT_ATTEMPT_LIMIT = 5_000;
export const SYNC_V8_RECENT_PRACTICE_RUN_LIMIT = 500;
export const SYNC_V8_HISTORY_CHUNK_COUNT = 1_000;

export interface SyncV8HistoryDescriptor extends SyncV7Descriptor {
  kind: "attempts" | "practiceRuns";
  count: number;
  firstAt?: string;
  lastAt?: string;
}

export interface SyncV8HistoryIndex {
  formatVersion: typeof SYNC_V8_CHECKPOINT_FORMAT;
  generatedAt: string;
  attempts: SyncV8HistoryDescriptor[];
  practiceRuns: SyncV8HistoryDescriptor[];
  counts: {
    attempts: number;
    practiceRuns: number;
  };
}

export interface SyncV8HistoryChunk<T> {
  formatVersion: typeof SYNC_V8_CHECKPOINT_FORMAT;
  kind: "attempts" | "practiceRuns";
  generatedAt: string;
  items: T[];
}

export interface SyncCheckpointV8 {
  formatVersion: typeof SYNC_V8_CHECKPOINT_FORMAT;
  generatedAt: string;
  /**
   * Bounded restore seed. Historical attempts/runs live in immutable history
   * chunks. Derived arrays are deliberately empty on the wire and rebuilt only
   * after all history chunks have been hydrated.
   */
  state: SyncCheckpointV7State;
  cursors: Record<string, number>;
  counts: SyncCheckpointV7Counts;
  retention: {
    recentAttemptLimit: number;
    recentPracticeRunLimit: number;
    oldestRecentAttemptAt: string | null;
  };
  history: {
    index: SyncV7Descriptor | null;
    archivedAttempts: number;
    archivedPracticeRuns: number;
  };
}

export interface SyncV8BuildOptions {
  recentAttemptLimit?: number;
  recentPracticeRunLimit?: number;
  chunkCount?: number;
}

export interface HydratedRemoteCheckpoint {
  checkpoint: SyncCheckpointV7;
  archivedAttempts: number;
  archivedPracticeRuns: number;
  skippedArchivedAttempts: number;
  skippedArchivedPracticeRuns: number;
  remoteFormatVersion: 7 | 8;
}

export interface SyncHistoryReadOptions {
  historySyncStart?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HISTORY_PATH = /^sync\/v8\/history\/[a-f0-9]{64}\.json$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeInt(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid v8 checkpoint: ${field} must be a non-negative safe integer`);
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`invalid v8 checkpoint: ${field} must be an ISO timestamp`);
}

function assertDescriptor(value: unknown, field: string): asserts value is SyncV7Descriptor {
  if (!isRecord(value)) throw new Error(`invalid v8 checkpoint: ${field} must be a descriptor`);
  if (typeof value.path !== "string" || !HISTORY_PATH.test(value.path)) throw new Error(`invalid v8 checkpoint: ${field}.path must be a v8 history path`);
  if (typeof value.blobSha !== "string" || !SHA1.test(value.blobSha)) throw new Error(`invalid v8 checkpoint: ${field}.blobSha is invalid`);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error(`invalid v8 checkpoint: ${field}.sha256 is invalid`);
  assertSafeInt(value.size, `${field}.size`);
  if (value.storedSize !== undefined) assertSafeInt(value.storedSize, `${field}.storedSize`);
  if (!value.path.includes(value.sha256)) throw new Error(`invalid v8 checkpoint: ${field}.path digest mismatch`);
}

function cloneBoundedState(full: SyncCheckpointV7State, attempts: AttemptV7[], practiceRuns: PracticeRunV7[]): SyncCheckpointV7State {
  return {
    banks: full.banks.map((item) => ({ ...item })),
    bankFolders: full.bankFolders.map((item) => ({ ...item })),
    questions: full.questions.map((item) => ({ ...item, content: item.content.map((block) => ({ ...block })), options: item.options.map((option) => option.map((block) => ({ ...block }))), tags: [...item.tags] })),
    memberships: full.memberships.map((item) => ({ ...item })),
    imageAssets: full.imageAssets.map((item) => ({ ...item, remote: item.remote ? { ...item.remote } : undefined })),
    attempts: attempts.map((item) => ({ ...item })),
    // These are authoritative only after history hydration. Keeping them empty
    // prevents recent-only data from masquerading as lifetime aggregates.
    attemptStats: [],
    attemptDailyStats: [],
    notes: full.notes.map((item) => ({ ...item })),
    practiceRuns: practiceRuns.map((item) => ({
      ...item,
      bankIds: [...item.bankIds],
      questionIds: [...item.questionIds],
      questionTypes: { ...item.questionTypes },
      answers: { ...item.answers },
      optionOrders: Object.fromEntries(Object.entries(item.optionOrders).map(([key, value]) => [key, [...value]])),
    })),
    practiceRunStats: [],
    questionGroups: full.questionGroups.map((item) => ({ ...item, items: item.items.map((entry) => ({ ...entry })) })),
    reviewRounds: full.reviewRounds.map((item) => ({ ...item, bankIds: [...item.bankIds], finalQuestionIds: item.finalQuestionIds ? [...item.finalQuestionIds] : undefined })),
    reviewRoundProgress: [],
    tombstones: full.tombstones.map((item) => ({ ...item })),
  };
}

function chronologicalAttempts(items: readonly AttemptV7[]): AttemptV7[] {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function chronologicalRuns(items: readonly PracticeRunV7[]): PracticeRunV7[] {
  return [...items].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
}

function chunked<T>(items: readonly T[], chunkCount: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += chunkCount) result.push(items.slice(index, index + chunkCount));
  return result;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function putHistoryObject(client: GitHubV7Remote, value: unknown): Promise<SyncV7Descriptor> {
  const bytes = encodeJson(value);
  const digest = await sha256(bytes);
  const path = descriptorPath(SYNC_V8_HISTORY_PREFIX, digest);
  const uploaded = await client.putImmutable({ path, bytes, kind: "history" });
  return {
    path: uploaded.path,
    blobSha: uploaded.blobSha,
    sha256: uploaded.sha256,
    size: uploaded.size,
    storedSize: uploaded.storedSize,
  };
}

async function archiveChunks<T extends AttemptV7 | PracticeRunV7>(
  client: GitHubV7Remote,
  kind: "attempts" | "practiceRuns",
  items: readonly T[],
  chunkCount: number,
  generatedAt: string,
): Promise<SyncV8HistoryDescriptor[]> {
  const descriptors: SyncV8HistoryDescriptor[] = [];
  for (const chunkItems of chunked(items, chunkCount)) {
    const envelope: SyncV8HistoryChunk<T> = { formatVersion: 8, kind, generatedAt, items: chunkItems };
    const descriptor = await putHistoryObject(client, envelope);
    const timestamps = chunkItems.map((item) => kind === "attempts" ? (item as AttemptV7).createdAt : (item as PracticeRunV7).startedAt).sort();
    descriptors.push({ ...descriptor, kind, count: chunkItems.length, firstAt: timestamps[0], lastAt: timestamps.at(-1) });
  }
  return descriptors;
}

function boundedCounts(full: SyncCheckpointV7, state: SyncCheckpointV7State): SyncCheckpointV7Counts {
  return {
    banks: state.banks.length,
    bankFolders: state.bankFolders.length,
    questions: state.questions.length,
    memberships: state.memberships.length,
    imageAssets: state.imageAssets.length,
    attempts: state.attempts.length,
    attemptStats: 0,
    attemptDailyStats: 0,
    notes: state.notes.length,
    practiceRuns: state.practiceRuns.length,
    practiceRunStats: 0,
    questionGroups: state.questionGroups.length,
    reviewRounds: state.reviewRounds.length,
    reviewRoundProgress: 0,
    tombstones: state.tombstones.length,
    totalAttempts: full.state.attempts.length,
    totalPracticeRuns: full.state.practiceRuns.length,
  };
}

export function validateSyncCheckpointV8(value: unknown): asserts value is SyncCheckpointV8 {
  if (!isRecord(value) || value.formatVersion !== SYNC_V8_CHECKPOINT_FORMAT) throw new Error("invalid v8 checkpoint: formatVersion must be 8");
  assertDate(value.generatedAt, "generatedAt");
  if (!isRecord(value.state)) throw new Error("invalid v8 checkpoint: state must be an object");
  if (!isRecord(value.cursors) || !isRecord(value.counts)) throw new Error("invalid v8 checkpoint: cursors/counts are required");
  if (!isRecord(value.retention) || !isRecord(value.history)) throw new Error("invalid v8 checkpoint: retention/history are required");
  assertSafeInt(value.retention.recentAttemptLimit, "retention.recentAttemptLimit");
  assertSafeInt(value.retention.recentPracticeRunLimit, "retention.recentPracticeRunLimit");
  if (value.retention.oldestRecentAttemptAt !== null) assertDate(value.retention.oldestRecentAttemptAt, "retention.oldestRecentAttemptAt");
  assertSafeInt(value.history.archivedAttempts, "history.archivedAttempts");
  assertSafeInt(value.history.archivedPracticeRuns, "history.archivedPracticeRuns");
  if (value.history.index !== null) assertDescriptor(value.history.index, "history.index");

  // Reuse the mature v7 structural validator for the bounded state. Derived
  // arrays are empty, so it validates entity/relation integrity without
  // requiring archive-resident attempt ids.
  const surrogate = {
    formatVersion: 7,
    generatedAt: value.generatedAt,
    state: value.state,
    cursors: value.cursors,
    counts: value.counts,
    retention: value.retention,
  } as unknown as SyncCheckpointV7;
  validateSyncCheckpointV7(surrogate);
  const state = surrogate.state;
  if ((value.counts as unknown as SyncCheckpointV7Counts).totalAttempts !== state.attempts.length + value.history.archivedAttempts) {
    throw new Error("invalid v8 checkpoint: totalAttempts does not match recent + archived");
  }
  if ((value.counts as unknown as SyncCheckpointV7Counts).totalPracticeRuns !== state.practiceRuns.length + value.history.archivedPracticeRuns) {
    throw new Error("invalid v8 checkpoint: totalPracticeRuns does not match recent + archived");
  }
  if ((value.history.archivedAttempts > 0 || value.history.archivedPracticeRuns > 0) && value.history.index === null) {
    throw new Error("invalid v8 checkpoint: archived history requires an index descriptor");
  }
}

export function encodeSyncCheckpointV8(checkpoint: SyncCheckpointV8): Uint8Array {
  validateSyncCheckpointV8(checkpoint);
  return encodeJson(checkpoint);
}

export function parseSyncCheckpointV8(bytes: Uint8Array | string): SyncCheckpointV8 {
  let value: unknown;
  try { value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程 v8 检查点不是有效 JSON。"); }
  validateSyncCheckpointV8(value);
  return value;
}

function parseHistoryIndex(bytes: Uint8Array): SyncV8HistoryIndex {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程 v8 历史索引不是有效 JSON。"); }
  if (!isRecord(value) || value.formatVersion !== 8 || !Array.isArray(value.attempts) || !Array.isArray(value.practiceRuns) || !isRecord(value.counts)) {
    throw new Error("远程 v8 历史索引格式无效。");
  }
  assertDate(value.generatedAt, "history.generatedAt");
  assertSafeInt(value.counts.attempts, "history.counts.attempts");
  assertSafeInt(value.counts.practiceRuns, "history.counts.practiceRuns");
  for (const [kind, descriptors] of [["attempts", value.attempts], ["practiceRuns", value.practiceRuns]] as const) {
    descriptors.forEach((descriptor, index) => {
      assertDescriptor(descriptor, `history.${kind}[${index}]`);
      if (!isRecord(descriptor) || descriptor.kind !== kind) throw new Error(`远程 v8 历史索引 ${kind}[${index}] 类型无效。`);
      assertSafeInt(descriptor.count, `history.${kind}[${index}].count`);
    });
  }
  return value as unknown as SyncV8HistoryIndex;
}

function parseHistoryChunk<T>(bytes: Uint8Array, kind: "attempts" | "practiceRuns"): T[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`远程 v8 ${kind} 历史分块不是有效 JSON。`); }
  if (!isRecord(value) || value.formatVersion !== 8 || value.kind !== kind || !Array.isArray(value.items)) throw new Error(`远程 v8 ${kind} 历史分块格式无效。`);
  return value.items as T[];
}

async function readHistoryItems<T extends AttemptV7 | PracticeRunV7>(client: GitHubV7Remote, descriptors: readonly SyncV8HistoryDescriptor[], kind: "attempts" | "practiceRuns", historySyncStart?: string): Promise<{ items: T[]; skipped: number }> {
  const result: T[] = [];
  let skipped = 0;
  const selected = descriptors.filter((descriptor) => {
    if (!historySyncStart || !descriptor.lastAt || descriptor.lastAt.slice(0, 10) >= historySyncStart) return true;
    skipped += descriptor.count;
    return false;
  });
  // Keep archive downloads bounded even for very old vaults.
  const concurrency = 4;
  for (let offset = 0; offset < selected.length; offset += concurrency) {
    const batch = selected.slice(offset, offset + concurrency);
    const chunks = await Promise.all(batch.map(async (descriptor) => {
      const items = parseHistoryChunk<T>(await client.readBlob(descriptor), kind);
      if (items.length !== descriptor.count) throw new Error(`远程 v8 ${kind} 历史分块计数不匹配。`);
      if (!historySyncStart) return items;
      const kept = items.filter((item) => historyTimestampIncluded(kind === "attempts" ? (item as AttemptV7).createdAt : (item as PracticeRunV7).startedAt, historySyncStart));
      skipped += items.length - kept.length;
      return kept;
    }));
    chunks.forEach((items) => result.push(...items));
  }
  return { items: result, skipped };
}

export async function createRemoteCheckpointV8(
  client: GitHubV7Remote,
  full: SyncCheckpointV7,
  options: SyncV8BuildOptions = {},
): Promise<SyncCheckpointV8> {
  validateSyncCheckpointV7(full);
  const recentAttemptLimit = Math.max(0, options.recentAttemptLimit ?? SYNC_V8_RECENT_ATTEMPT_LIMIT);
  const recentPracticeRunLimit = Math.max(0, options.recentPracticeRunLimit ?? SYNC_V8_RECENT_PRACTICE_RUN_LIMIT);
  const chunkCount = Math.max(1, options.chunkCount ?? SYNC_V8_HISTORY_CHUNK_COUNT);

  const attempts = chronologicalAttempts(full.state.attempts);
  const practiceRuns = chronologicalRuns(full.state.practiceRuns);
  const archivedAttempts = attempts.slice(0, Math.max(0, attempts.length - recentAttemptLimit));
  const recentAttempts = attempts.slice(archivedAttempts.length);
  const archivedPracticeRuns = practiceRuns.slice(0, Math.max(0, practiceRuns.length - recentPracticeRunLimit));
  const recentPracticeRuns = practiceRuns.slice(archivedPracticeRuns.length);

  const attemptDescriptors = await archiveChunks(client, "attempts", archivedAttempts, chunkCount, full.generatedAt);
  const runDescriptors = await archiveChunks(client, "practiceRuns", archivedPracticeRuns, chunkCount, full.generatedAt);
  let indexDescriptor: SyncV7Descriptor | null = null;
  if (attemptDescriptors.length || runDescriptors.length) {
    const index: SyncV8HistoryIndex = {
      formatVersion: 8,
      generatedAt: full.generatedAt,
      attempts: attemptDescriptors,
      practiceRuns: runDescriptors,
      counts: { attempts: archivedAttempts.length, practiceRuns: archivedPracticeRuns.length },
    };
    indexDescriptor = await putHistoryObject(client, index);
  }

  const state = cloneBoundedState(full.state, recentAttempts, recentPracticeRuns);
  const checkpoint: SyncCheckpointV8 = {
    formatVersion: 8,
    generatedAt: full.generatedAt,
    state,
    cursors: { ...full.cursors },
    counts: boundedCounts(full, state),
    retention: {
      recentAttemptLimit,
      recentPracticeRunLimit,
      oldestRecentAttemptAt: recentAttempts[0]?.createdAt ?? null,
    },
    history: {
      index: indexDescriptor,
      archivedAttempts: archivedAttempts.length,
      archivedPracticeRuns: archivedPracticeRuns.length,
    },
  };
  validateSyncCheckpointV8(checkpoint);
  return checkpoint;
}

async function hydrateSyncCheckpointV8WithStats(client: GitHubV7Remote, checkpoint: SyncCheckpointV8, options: SyncHistoryReadOptions = {}): Promise<{ checkpoint: SyncCheckpointV7; archivedAttempts: number; archivedPracticeRuns: number; skippedArchivedAttempts: number; skippedArchivedPracticeRuns: number }> {
  validateSyncCheckpointV8(checkpoint);
  const historySyncStart = normalizeHistorySyncStart(options.historySyncStart);
  let archivedAttempts: AttemptV7[] = [];
  let archivedPracticeRuns: PracticeRunV7[] = [];
  let skippedArchivedAttempts = 0;
  let skippedArchivedPracticeRuns = 0;
  if (checkpoint.history.index) {
    const index = parseHistoryIndex(await client.readBlob(checkpoint.history.index));
    if (index.counts.attempts !== checkpoint.history.archivedAttempts || index.counts.practiceRuns !== checkpoint.history.archivedPracticeRuns) {
      throw new Error("远程 v8 历史索引总数与检查点不一致。");
    }
    const [attemptResult, runResult] = await Promise.all([
      readHistoryItems<AttemptV7>(client, index.attempts, "attempts", historySyncStart),
      readHistoryItems<PracticeRunV7>(client, index.practiceRuns, "practiceRuns", historySyncStart),
    ]);
    archivedAttempts = attemptResult.items;
    archivedPracticeRuns = runResult.items;
    skippedArchivedAttempts = attemptResult.skipped;
    skippedArchivedPracticeRuns = runResult.skipped;
  }

  const attemptMap = new Map<string, AttemptV7>();
  for (const item of [...archivedAttempts, ...checkpoint.state.attempts]) attemptMap.set(item.id, item);
  const runMap = new Map<string, PracticeRunV7>();
  for (const item of [...archivedPracticeRuns, ...checkpoint.state.practiceRuns]) runMap.set(item.id, item);
  if (!historySyncStart && (attemptMap.size !== checkpoint.counts.totalAttempts || runMap.size !== checkpoint.counts.totalPracticeRuns)) {
    throw new Error("远程 v8 历史水合后记录数与检查点不一致。");
  }

  const projection: ChangeSetProjectionV7 = {
    ...checkpoint.state,
    attempts: chronologicalAttempts([...attemptMap.values()]),
    practiceRuns: chronologicalRuns([...runMap.values()]),
  };
  const finalized = filterProjectionHistoryV7(finalizeRebasedProjectionV7(projection), historySyncStart);
  const full = await checkpointFromProjection(finalized, checkpoint.cursors);
  full.generatedAt = checkpoint.generatedAt;
  validateSyncCheckpointV7(full);
  return { checkpoint: full, archivedAttempts: archivedAttempts.length, archivedPracticeRuns: archivedPracticeRuns.length, skippedArchivedAttempts, skippedArchivedPracticeRuns };
}

export async function hydrateSyncCheckpointV8(client: GitHubV7Remote, checkpoint: SyncCheckpointV8, options: SyncHistoryReadOptions = {}): Promise<SyncCheckpointV7> {
  return (await hydrateSyncCheckpointV8WithStats(client, checkpoint, options)).checkpoint;
}

export async function decodeRemoteCheckpoint(client: GitHubV7Remote, bytes: Uint8Array, options: SyncHistoryReadOptions = {}): Promise<HydratedRemoteCheckpoint> {
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程检查点不是有效 JSON。"); }
  if (isRecord(header) && header.formatVersion === 8) {
    const checkpoint = parseSyncCheckpointV8(bytes);
    const hydrated = await hydrateSyncCheckpointV8WithStats(client, checkpoint, options);
    return {
      ...hydrated,
      remoteFormatVersion: 8,
    };
  }
  const checkpoint = parseSyncCheckpointV7(bytes);
  const historySyncStart = normalizeHistorySyncStart(options.historySyncStart);
  if (!historySyncStart) return { checkpoint, archivedAttempts: 0, archivedPracticeRuns: 0, skippedArchivedAttempts: 0, skippedArchivedPracticeRuns: 0, remoteFormatVersion: 7 };
  const filtered = filterProjectionHistoryV7({ ...checkpoint.state, memberships: checkpoint.state.memberships, imageAssets: checkpoint.state.imageAssets }, historySyncStart);
  return { checkpoint: await checkpointFromProjection(filtered, checkpoint.cursors), archivedAttempts: 0, archivedPracticeRuns: 0, skippedArchivedAttempts: checkpoint.state.attempts.length - filtered.attempts.length, skippedArchivedPracticeRuns: checkpoint.state.practiceRuns.length - filtered.practiceRuns.length, remoteFormatVersion: 7 };
}

async function collectHistoryReachability(client: GitHubV7Remote, checkpointDescriptor: SyncV7Descriptor | null, keep: Set<string>): Promise<void> {
  if (!checkpointDescriptor) return;
  const bytes = await client.readBlob(checkpointDescriptor);
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  if (!isRecord(header) || header.formatVersion !== 8) return;
  const checkpoint = parseSyncCheckpointV8(bytes);
  if (!checkpoint.history.index) return;
  keep.add(checkpoint.history.index.path);
  const index = parseHistoryIndex(await client.readBlob(checkpoint.history.index));
  for (const descriptor of [...index.attempts, ...index.practiceRuns]) keep.add(descriptor.path);
}

/** Best-effort GC for the dedicated v8 history namespace. */
export async function gcSyncV8HistoryRemote(client: GitHubV7Remote, previous: SyncHeadV7, committed: SyncV7HeadCache): Promise<{ deleted: number; skipped: number }> {
  const keep = new Set<string>();
  try {
    const latest = await client.readHead();
    if (!latest.initialized || latest.head.vaultId !== committed.head.vaultId) return { deleted: 0, skipped: 1 };
    const descriptors = [latest.head.checkpoint, committed.head.checkpoint, previous.checkpoint];
    const unique = new Map(descriptors.filter(Boolean).map((descriptor) => [descriptor!.path, descriptor!]));
    for (const descriptor of unique.values()) await collectHistoryReachability(client, descriptor, keep);
    const entries = await client.listImmutableDirectory(SYNC_V8_HISTORY_PREFIX);
    let deleted = 0;
    let skipped = 0;
    for (const entry of entries) {
      if (keep.has(entry.path)) continue;
      try {
        if (await client.deleteImmutablePath(entry.path, entry.blobSha)) deleted += 1;
        else skipped += 1;
      } catch { skipped += 1; }
    }
    return { deleted, skipped };
  } catch {
    return { deleted: 0, skipped: 1 };
  }
}
