import type { Attempt, PracticeRunItem, PracticeRunRecord, PracticeRunSource } from "../db/types";
import { historyTimestampIncluded, normalizeHistorySyncStart } from "./history-sync-range";
import type { GitHubRemote, SyncHeadCache } from "./github-remote";
import { descriptorPath, sha256 } from "./sync-context";
import {
  SYNC_CHECKPOINT_FORMAT,
  type SyncCheckpoint,
  type SyncCheckpointCounts,
  type SyncCheckpointState,
} from "./sync-checkpoint-types";
import { validateSyncCheckpoint } from "./sync-checkpoint-validation";
import {
  boundedCanonicalHistoryState,
  chronologicalHistoryAttempts,
  countsForHistoryState,
  filterCanonicalHistoryState,
  mergeCanonicalHistoryState,
  type PracticeRunHistoryFacts,
} from "./sync-history-state";
import { SYNC_HISTORY_PREFIX, type SyncDescriptor, type SyncHead } from "./sync-head-types";

export const REMOTE_HISTORY_FORMAT = 9 as const;
export const SYNC_HISTORY_RECENT_ATTEMPT_LIMIT = 5_000;
export const SYNC_HISTORY_RECENT_PRACTICE_RUN_LIMIT = 500;
export const SYNC_HISTORY_CHUNK_COUNT = 1_000;

export interface SyncHistoryDescriptor extends SyncDescriptor {
  kind: "attempts" | "practiceRuns";
  count: number;
  firstAt?: string;
  lastAt?: string;
}

export interface SyncHistoryIndex {
  formatVersion: typeof REMOTE_HISTORY_FORMAT;
  generatedAt: string;
  attempts: SyncHistoryDescriptor[];
  practiceRuns: SyncHistoryDescriptor[];
  counts: { attempts: number; practiceRuns: number };
}

export interface SyncHistoryChunk<T> {
  formatVersion: typeof REMOTE_HISTORY_FORMAT;
  kind: "attempts";
  generatedAt: string;
  items: T[];
}

export interface SyncPracticeRunHistoryChunk {
  formatVersion: typeof REMOTE_HISTORY_FORMAT;
  kind: "practiceRuns";
  generatedAt: string;
  practiceRuns: PracticeRunRecord[];
  practiceRunSources: PracticeRunSource[];
  practiceRunItems: PracticeRunItem[];
}

export interface RemoteHistoryCheckpoint {
  formatVersion: typeof REMOTE_HISTORY_FORMAT;
  generatedAt: string;
  state: SyncCheckpointState;
  cursors: Record<string, number>;
  counts: SyncCheckpointCounts;
  retention: {
    recentAttemptLimit: number;
    recentPracticeRunLimit: number;
    oldestRecentAttemptAt: string | null;
  };
  history: {
    index: SyncDescriptor | null;
    archivedAttempts: number;
    archivedPracticeRuns: number;
  };
}

export interface SyncHistoryBuildOptions {
  recentAttemptLimit?: number;
  recentPracticeRunLimit?: number;
  chunkCount?: number;
}

export interface HydratedRemoteCheckpoint {
  checkpoint: SyncCheckpoint;
  archivedAttempts: number;
  archivedPracticeRuns: number;
  skippedArchivedAttempts: number;
  skippedArchivedPracticeRuns: number;
}

export interface SyncHistoryReadOptions {
  historySyncStart?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HISTORY_PATH = /^sync\/v9\/history\/[a-f0-9]{64}\.json$/;
const COUNT_KEYS = [
  "banks", "bankFolders", "questions", "memberships", "imageAssets", "attempts", "notes",
  "practiceRuns", "practiceRunSources", "practiceRunItems", "questionGroups", "questionGroupItems",
  "reviewRounds", "reviewRoundBanks", "reviewRoundItems", "tombstones", "totalAttempts", "totalPracticeRuns",
] as const satisfies readonly (keyof SyncCheckpointCounts)[];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertSafeInt(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`invalid v9 checkpoint: ${field} must be a non-negative safe integer`);
}

function assertDate(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value) || Number.isNaN(Date.parse(value))) throw new Error(`invalid v9 checkpoint: ${field} must be an ISO timestamp`);
}

function assertDescriptor(value: unknown, field: string): asserts value is SyncDescriptor {
  if (!isRecord(value)) throw new Error(`invalid v9 checkpoint: ${field} must be a descriptor`);
  if (typeof value.path !== "string" || !HISTORY_PATH.test(value.path)) throw new Error(`invalid v9 checkpoint: ${field}.path must be a v9 history path`);
  if (typeof value.blobSha !== "string" || !SHA1.test(value.blobSha)) throw new Error(`invalid v9 checkpoint: ${field}.blobSha is invalid`);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error(`invalid v9 checkpoint: ${field}.sha256 is invalid`);
  assertSafeInt(value.size, `${field}.size`);
  assertSafeInt(value.storedSize, `${field}.storedSize`);
  if (!value.path.includes(value.sha256)) throw new Error(`invalid v9 checkpoint: ${field}.path digest mismatch`);
}

function chunked<T>(items: readonly T[], chunkCount: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += chunkCount) result.push(items.slice(index, index + chunkCount));
  return result;
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

async function putHistoryObject(client: GitHubRemote, value: unknown): Promise<SyncDescriptor> {
  const bytes = encodeJson(value);
  const digest = await sha256(bytes);
  const path = descriptorPath(SYNC_HISTORY_PREFIX, digest);
  const uploaded = await client.putImmutable({ path, bytes, kind: "history" });
  return { path: uploaded.path, blobSha: uploaded.blobSha, sha256: uploaded.sha256, size: uploaded.size, storedSize: uploaded.storedSize };
}

async function archiveAttemptChunks(
  client: GitHubRemote,
  items: readonly Attempt[],
  chunkCount: number,
  generatedAt: string,
): Promise<SyncHistoryDescriptor[]> {
  const descriptors: SyncHistoryDescriptor[] = [];
  for (const chunkItems of chunked(items, chunkCount)) {
    const envelope: SyncHistoryChunk<Attempt> = { formatVersion: REMOTE_HISTORY_FORMAT, kind: "attempts", generatedAt, items: chunkItems };
    const descriptor = await putHistoryObject(client, envelope);
    const timestamps = chunkItems.map((item) => item.createdAt).sort();
    descriptors.push({ ...descriptor, kind: "attempts", count: chunkItems.length, firstAt: timestamps[0], lastAt: timestamps.at(-1) });
  }
  return descriptors;
}

async function archivePracticeRunChunks(
  client: GitHubRemote,
  full: SyncCheckpointState,
  records: readonly PracticeRunRecord[],
  chunkCount: number,
  generatedAt: string,
): Promise<SyncHistoryDescriptor[]> {
  const descriptors: SyncHistoryDescriptor[] = [];
  const attemptsByRun = new Map<string, Attempt[]>();
  for (const attempt of full.attempts) {
    const bucket = attemptsByRun.get(attempt.runId) ?? [];
    bucket.push(attempt);
    attemptsByRun.set(attempt.runId, bucket);
  }
  for (const practiceRuns of chunked(records, chunkCount)) {
    const runIds = new Set(practiceRuns.map((item) => item.id));
    const envelope: SyncPracticeRunHistoryChunk = {
      formatVersion: REMOTE_HISTORY_FORMAT,
      kind: "practiceRuns",
      generatedAt,
      practiceRuns: structuredClone(practiceRuns),
      practiceRunSources: structuredClone(full.practiceRunSources.filter((item) => runIds.has(item.runId))),
      practiceRunItems: structuredClone(full.practiceRunItems.filter((item) => runIds.has(item.runId))),
    };
    const descriptor = await putHistoryObject(client, envelope);
    const timestamps = practiceRuns.flatMap((run) => [run.startedAt, ...(attemptsByRun.get(run.id) ?? []).map((attempt) => attempt.createdAt)]).sort();
    descriptors.push({ ...descriptor, kind: "practiceRuns", count: practiceRuns.length, firstAt: timestamps[0], lastAt: timestamps.at(-1) });
  }
  return descriptors;
}

function validateBoundedCounts(value: unknown, state: SyncCheckpointState, history: RemoteHistoryCheckpoint["history"]): asserts value is SyncCheckpointCounts {
  if (!isRecord(value)) throw new Error("invalid v9 checkpoint: counts must be an object");
  const keys = Object.keys(value);
  if (keys.length !== COUNT_KEYS.length || keys.some((key) => !COUNT_KEYS.includes(key as keyof SyncCheckpointCounts))) {
    throw new Error("invalid v9 checkpoint: counts must contain only canonical fact counters");
  }
  const expected = countsForHistoryState(state, {
    attempts: state.attempts.length + history.archivedAttempts,
    practiceRuns: state.practiceRuns.length + history.archivedPracticeRuns,
  });
  for (const key of COUNT_KEYS) {
    assertSafeInt(value[key], `counts.${key}`);
    if (value[key] !== expected[key]) throw new Error(`invalid v9 checkpoint: counts.${key} does not match bounded state/history`);
  }
}

export function validateRemoteHistoryCheckpoint(value: unknown): asserts value is RemoteHistoryCheckpoint {
  if (!isRecord(value) || value.formatVersion !== REMOTE_HISTORY_FORMAT) throw new Error("invalid v9 checkpoint: formatVersion must be 9");
  assertDate(value.generatedAt, "generatedAt");
  if (!isRecord(value.state)) throw new Error("invalid v9 checkpoint: state must be an object");
  if (!isRecord(value.cursors)) throw new Error("invalid v9 checkpoint: cursors are required");
  if (!isRecord(value.retention) || !isRecord(value.history)) throw new Error("invalid v9 checkpoint: retention/history are required");
  assertSafeInt(value.retention.recentAttemptLimit, "retention.recentAttemptLimit");
  assertSafeInt(value.retention.recentPracticeRunLimit, "retention.recentPracticeRunLimit");
  if (value.retention.oldestRecentAttemptAt !== null) assertDate(value.retention.oldestRecentAttemptAt, "retention.oldestRecentAttemptAt");
  assertSafeInt(value.history.archivedAttempts, "history.archivedAttempts");
  assertSafeInt(value.history.archivedPracticeRuns, "history.archivedPracticeRuns");
  if (value.history.index !== null) assertDescriptor(value.history.index, "history.index");

  const state = value.state as unknown as SyncCheckpointState;
  validateSyncCheckpoint({
    formatVersion: SYNC_CHECKPOINT_FORMAT,
    generatedAt: value.generatedAt,
    state,
    cursors: value.cursors as Record<string, number>,
    counts: countsForHistoryState(state),
  });
  const history = value.history as unknown as RemoteHistoryCheckpoint["history"];
  validateBoundedCounts(value.counts, state, history);
  if ((history.archivedAttempts > 0 || history.archivedPracticeRuns > 0) && history.index === null) {
    throw new Error("invalid v9 checkpoint: archived history requires an index descriptor");
  }
}

export function encodeRemoteHistoryCheckpoint(checkpoint: RemoteHistoryCheckpoint): Uint8Array {
  validateRemoteHistoryCheckpoint(checkpoint);
  return encodeJson(checkpoint);
}

export function parseRemoteHistoryCheckpoint(bytes: Uint8Array | string): RemoteHistoryCheckpoint {
  let value: unknown;
  try { value = JSON.parse(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程 v9 检查点不是有效 JSON。"); }
  validateRemoteHistoryCheckpoint(value);
  return value;
}

function parseHistoryIndex(bytes: Uint8Array): SyncHistoryIndex {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程 v9 历史索引不是有效 JSON。"); }
  if (!isRecord(value) || value.formatVersion !== REMOTE_HISTORY_FORMAT || !Array.isArray(value.attempts) || !Array.isArray(value.practiceRuns) || !isRecord(value.counts)) {
    throw new Error("远程 v9 历史索引格式无效。");
  }
  assertDate(value.generatedAt, "history.generatedAt");
  assertSafeInt(value.counts.attempts, "history.counts.attempts");
  assertSafeInt(value.counts.practiceRuns, "history.counts.practiceRuns");
  for (const [kind, descriptors] of [["attempts", value.attempts], ["practiceRuns", value.practiceRuns]] as const) {
    descriptors.forEach((descriptor, index) => {
      assertDescriptor(descriptor, `history.${kind}[${index}]`);
      if (!isRecord(descriptor) || descriptor.kind !== kind) throw new Error(`远程 v9 历史索引 ${kind}[${index}] 类型无效。`);
      assertSafeInt(descriptor.count, `history.${kind}[${index}].count`);
    });
  }
  return value as unknown as SyncHistoryIndex;
}

function parseAttemptHistoryChunk(bytes: Uint8Array): Attempt[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程 v9 attempts 历史分块不是有效 JSON。"); }
  if (!isRecord(value) || value.formatVersion !== REMOTE_HISTORY_FORMAT || value.kind !== "attempts" || !Array.isArray(value.items)) {
    throw new Error("远程 v9 attempts 历史分块格式无效。");
  }
  return value.items as Attempt[];
}

function parsePracticeRunHistoryChunk(bytes: Uint8Array): PracticeRunHistoryFacts {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程 v9 practiceRuns 历史分块不是有效 JSON。"); }
  if (!isRecord(value) || value.formatVersion !== REMOTE_HISTORY_FORMAT || value.kind !== "practiceRuns"
    || !Array.isArray(value.practiceRuns) || !Array.isArray(value.practiceRunSources) || !Array.isArray(value.practiceRunItems) || "items" in value) {
    throw new Error("远程 v9 practiceRuns 历史分块格式无效。");
  }
  return {
    practiceRuns: value.practiceRuns as PracticeRunRecord[],
    practiceRunSources: value.practiceRunSources as PracticeRunSource[],
    practiceRunItems: value.practiceRunItems as PracticeRunItem[],
  };
}

async function readAttemptHistory(
  client: GitHubRemote,
  descriptors: readonly SyncHistoryDescriptor[],
  historySyncStart?: string,
): Promise<{ items: Attempt[]; skipped: number }> {
  const result: Attempt[] = [];
  let skipped = 0;
  const selected = descriptors.filter((descriptor) => {
    if (!historySyncStart || !descriptor.lastAt || descriptor.lastAt.slice(0, 10) >= historySyncStart) return true;
    skipped += descriptor.count;
    return false;
  });
  for (let offset = 0; offset < selected.length; offset += 4) {
    const chunks = await Promise.all(selected.slice(offset, offset + 4).map(async (descriptor) => {
      const items = parseAttemptHistoryChunk(await client.readBlob(descriptor));
      if (items.length !== descriptor.count) throw new Error("远程 v9 attempts 历史分块计数不匹配。");
      if (!historySyncStart) return items;
      const kept = items.filter((item) => historyTimestampIncluded(item.createdAt, historySyncStart));
      skipped += items.length - kept.length;
      return kept;
    }));
    chunks.forEach((items) => result.push(...items));
  }
  return { items: result, skipped };
}

async function readPracticeRunHistory(
  client: GitHubRemote,
  descriptors: readonly SyncHistoryDescriptor[],
  historySyncStart?: string,
): Promise<{ facts: PracticeRunHistoryFacts; skipped: number }> {
  const facts: PracticeRunHistoryFacts = { practiceRuns: [], practiceRunSources: [], practiceRunItems: [] };
  let skipped = 0;
  const selected = descriptors.filter((descriptor) => {
    if (!historySyncStart || !descriptor.lastAt || descriptor.lastAt.slice(0, 10) >= historySyncStart) return true;
    skipped += descriptor.count;
    return false;
  });
  for (let offset = 0; offset < selected.length; offset += 4) {
    const chunks = await Promise.all(selected.slice(offset, offset + 4).map(async (descriptor) => {
      const chunk = parsePracticeRunHistoryChunk(await client.readBlob(descriptor));
      if (chunk.practiceRuns.length !== descriptor.count) throw new Error("远程 v9 practiceRuns 历史分块计数不匹配。");
      return chunk;
    }));
    for (const chunk of chunks) {
      facts.practiceRuns.push(...chunk.practiceRuns);
      facts.practiceRunSources.push(...chunk.practiceRunSources);
      facts.practiceRunItems.push(...chunk.practiceRunItems);
    }
  }
  return { facts, skipped };
}

export async function createRemoteHistoryCheckpoint(
  client: GitHubRemote,
  full: SyncCheckpoint,
  options: SyncHistoryBuildOptions = {},
): Promise<RemoteHistoryCheckpoint> {
  validateSyncCheckpoint(full);
  const recentAttemptLimit = Math.max(0, options.recentAttemptLimit ?? SYNC_HISTORY_RECENT_ATTEMPT_LIMIT);
  const recentPracticeRunLimit = Math.max(0, options.recentPracticeRunLimit ?? SYNC_HISTORY_RECENT_PRACTICE_RUN_LIMIT);
  const chunkCount = Math.max(1, options.chunkCount ?? SYNC_HISTORY_CHUNK_COUNT);
  const bounded = boundedCanonicalHistoryState(full.state, recentAttemptLimit, recentPracticeRunLimit);

  const attemptDescriptors = await archiveAttemptChunks(client, bounded.archivedAttempts, chunkCount, full.generatedAt);
  const runDescriptors = await archivePracticeRunChunks(client, full.state, bounded.archivedPracticeRuns, chunkCount, full.generatedAt);
  let indexDescriptor: SyncDescriptor | null = null;
  if (attemptDescriptors.length || runDescriptors.length) {
    indexDescriptor = await putHistoryObject(client, {
      formatVersion: REMOTE_HISTORY_FORMAT,
      generatedAt: full.generatedAt,
      attempts: attemptDescriptors,
      practiceRuns: runDescriptors,
      counts: { attempts: bounded.archivedAttempts.length, practiceRuns: bounded.archivedPracticeRuns.length },
    } satisfies SyncHistoryIndex);
  }

  const checkpoint: RemoteHistoryCheckpoint = {
    formatVersion: REMOTE_HISTORY_FORMAT,
    generatedAt: full.generatedAt,
    state: bounded.state,
    cursors: { ...full.cursors },
    counts: countsForHistoryState(bounded.state, { attempts: full.state.attempts.length, practiceRuns: full.state.practiceRuns.length }),
    retention: {
      recentAttemptLimit,
      recentPracticeRunLimit,
      oldestRecentAttemptAt: chronologicalHistoryAttempts(bounded.state.attempts)[0]?.createdAt ?? null,
    },
    history: {
      index: indexDescriptor,
      archivedAttempts: bounded.archivedAttempts.length,
      archivedPracticeRuns: bounded.archivedPracticeRuns.length,
    },
  };
  validateRemoteHistoryCheckpoint(checkpoint);
  return checkpoint;
}

async function hydrateRemoteHistoryCheckpointWithStats(
  client: GitHubRemote,
  checkpoint: RemoteHistoryCheckpoint,
  options: SyncHistoryReadOptions = {},
): Promise<HydratedRemoteCheckpoint> {
  validateRemoteHistoryCheckpoint(checkpoint);
  const historySyncStart = normalizeHistorySyncStart(options.historySyncStart);
  let archivedAttempts: Attempt[] = [];
  let archivedRuns: PracticeRunHistoryFacts = { practiceRuns: [], practiceRunSources: [], practiceRunItems: [] };
  let skippedArchivedAttempts = 0;
  let skippedArchivedPracticeRuns = 0;
  if (checkpoint.history.index) {
    const index = parseHistoryIndex(await client.readBlob(checkpoint.history.index));
    if (index.counts.attempts !== checkpoint.history.archivedAttempts || index.counts.practiceRuns !== checkpoint.history.archivedPracticeRuns) {
      throw new Error("远程 v9 历史索引总数与检查点不一致。");
    }
    const [attemptResult, runResult] = await Promise.all([
      readAttemptHistory(client, index.attempts, historySyncStart),
      readPracticeRunHistory(client, index.practiceRuns, historySyncStart),
    ]);
    archivedAttempts = attemptResult.items;
    archivedRuns = runResult.facts;
    skippedArchivedAttempts = attemptResult.skipped;
    skippedArchivedPracticeRuns = runResult.skipped;
  }

  let state = mergeCanonicalHistoryState(checkpoint.state, archivedAttempts, archivedRuns);
  state = filterCanonicalHistoryState(state, historySyncStart);
  const full: SyncCheckpoint = {
    formatVersion: SYNC_CHECKPOINT_FORMAT,
    generatedAt: checkpoint.generatedAt,
    state,
    cursors: { ...checkpoint.cursors },
    counts: countsForHistoryState(state),
  };
  validateSyncCheckpoint(full);
  if (!historySyncStart && (state.attempts.length !== checkpoint.counts.totalAttempts || state.practiceRuns.length !== checkpoint.counts.totalPracticeRuns)) {
    throw new Error("远程 v9 历史水合后记录数与检查点不一致。");
  }
  return {
    checkpoint: full,
    archivedAttempts: archivedAttempts.length,
    archivedPracticeRuns: archivedRuns.practiceRuns.length,
    skippedArchivedAttempts,
    skippedArchivedPracticeRuns,
  };
}

export async function hydrateRemoteHistoryCheckpoint(client: GitHubRemote, checkpoint: RemoteHistoryCheckpoint, options: SyncHistoryReadOptions = {}): Promise<SyncCheckpoint> {
  return (await hydrateRemoteHistoryCheckpointWithStats(client, checkpoint, options)).checkpoint;
}

export async function decodeRemoteCheckpoint(client: GitHubRemote, bytes: Uint8Array, options: SyncHistoryReadOptions = {}): Promise<HydratedRemoteCheckpoint> {
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程检查点不是有效 JSON。"); }
  if (!isRecord(header) || header.formatVersion !== REMOTE_HISTORY_FORMAT) throw new Error("远程检查点格式不是 v9；当前客户端只接受 v9 数据。");
  return hydrateRemoteHistoryCheckpointWithStats(client, parseRemoteHistoryCheckpoint(bytes), options);
}

async function collectHistoryReachability(client: GitHubRemote, checkpointDescriptor: SyncDescriptor | null, keep: Set<string>): Promise<void> {
  if (!checkpointDescriptor) return;
  const bytes = await client.readBlob(checkpointDescriptor);
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes)); } catch { return; }
  if (!isRecord(header) || header.formatVersion !== REMOTE_HISTORY_FORMAT) return;
  const checkpoint = parseRemoteHistoryCheckpoint(bytes);
  if (!checkpoint.history.index) return;
  keep.add(checkpoint.history.index.path);
  const index = parseHistoryIndex(await client.readBlob(checkpoint.history.index));
  for (const descriptor of [...index.attempts, ...index.practiceRuns]) keep.add(descriptor.path);
}

/** Best-effort GC for the dedicated v9 history namespace. */
export async function gcRemoteHistory(client: GitHubRemote, previous: SyncHead, committed: SyncHeadCache): Promise<{ deleted: number; skipped: number }> {
  const keep = new Set<string>();
  try {
    const latest = await client.readHead();
    if (!latest.initialized || latest.head.vaultId !== committed.head.vaultId) return { deleted: 0, skipped: 1 };
    const descriptors = [latest.head.checkpoint, committed.head.checkpoint, previous.checkpoint];
    const unique = new Map(descriptors.filter(Boolean).map((descriptor) => [descriptor!.path, descriptor!]));
    for (const descriptor of unique.values()) await collectHistoryReachability(client, descriptor, keep);
    const entries = await client.listImmutableDirectory(SYNC_HISTORY_PREFIX);
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