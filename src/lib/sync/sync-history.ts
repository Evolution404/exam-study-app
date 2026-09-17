import type { Attempt, PracticeRun } from "../db/types";
import type { ChangeSetProjection } from "./change-set-projection";
import { finalizeRebasedProjection } from "./change-set-projection";
import { filterProjectionHistory, historyTimestampIncluded, normalizeHistorySyncStart } from "./history-sync-range";
import type { GitHubRemote, SyncHeadCache } from "./github-remote";
import { descriptorPath, sha256 } from "./sync-context";
import { checkpointFromProjection } from "./sync-checkpoint-bridge";
import { type SyncCheckpoint, type SyncCheckpointCounts, type SyncCheckpointState } from "./sync-checkpoint-types";
import { validateSyncCheckpoint } from "./sync-checkpoint-validation";
import { SYNC_HISTORY_PREFIX, type SyncHead, type SyncDescriptor } from "./sync-head-types";

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
  counts: {
    attempts: number;
    practiceRuns: number;
  };
}

export interface SyncHistoryChunk<T> {
  formatVersion: typeof REMOTE_HISTORY_FORMAT;
  kind: "attempts" | "practiceRuns";
  generatedAt: string;
  items: T[];
}

export interface RemoteHistoryCheckpoint {
  formatVersion: typeof REMOTE_HISTORY_FORMAT;
  generatedAt: string;
  /**
   * Bounded restore seed. Historical attempts/runs live in immutable history
   * chunks. Derived arrays are deliberately empty on the wire and rebuilt only
   * after all history chunks have been hydrated.
   */
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

function cloneBoundedState(full: SyncCheckpointState, attempts: Attempt[], practiceRuns: PracticeRun[]): SyncCheckpointState {
  return {
    banks: full.banks.map((item) => ({ ...item })),
    bankFolders: full.bankFolders.map((item) => ({ ...item })),
    questions: full.questions.map((item) => ({ ...item, content: item.content.map((block) => ({ ...block })), options: item.options.map((option) => option.map((block) => ({ ...block }))), tags: [...item.tags] })),
    memberships: full.memberships.map((item) => ({ ...item })),
    imageAssets: full.imageAssets.map((item) => ({ id: item.id, mimeType: item.mimeType, size: item.size, width: item.width, height: item.height })),
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

function chronologicalAttempts(items: readonly Attempt[]): Attempt[] {
  return [...items].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function chronologicalRuns(items: readonly PracticeRun[]): PracticeRun[] {
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

async function putHistoryObject(client: GitHubRemote, value: unknown): Promise<SyncDescriptor> {
  const bytes = encodeJson(value);
  const digest = await sha256(bytes);
  const path = descriptorPath(SYNC_HISTORY_PREFIX, digest);
  const uploaded = await client.putImmutable({ path, bytes, kind: "history" });
  return {
    path: uploaded.path,
    blobSha: uploaded.blobSha,
    sha256: uploaded.sha256,
    size: uploaded.size,
    storedSize: uploaded.storedSize,
  };
}

async function archiveChunks<T extends Attempt | PracticeRun>(
  client: GitHubRemote,
  kind: "attempts" | "practiceRuns",
  items: readonly T[],
  chunkCount: number,
  generatedAt: string,
): Promise<SyncHistoryDescriptor[]> {
  const descriptors: SyncHistoryDescriptor[] = [];
  for (const chunkItems of chunked(items, chunkCount)) {
    const envelope: SyncHistoryChunk<T> = { formatVersion: REMOTE_HISTORY_FORMAT, kind, generatedAt, items: chunkItems };
    const descriptor = await putHistoryObject(client, envelope);
    const timestamps = chunkItems.map((item) => kind === "attempts" ? (item as Attempt).createdAt : (item as PracticeRun).startedAt).sort();
    descriptors.push({ ...descriptor, kind, count: chunkItems.length, firstAt: timestamps[0], lastAt: timestamps.at(-1) });
  }
  return descriptors;
}

function boundedCounts(full: SyncCheckpoint, state: SyncCheckpointState): SyncCheckpointCounts {
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

export function validateRemoteHistoryCheckpoint(value: unknown): asserts value is RemoteHistoryCheckpoint {
  if (!isRecord(value) || value.formatVersion !== REMOTE_HISTORY_FORMAT) throw new Error("invalid v9 checkpoint: formatVersion must be 9");
  assertDate(value.generatedAt, "generatedAt");
  if (!isRecord(value.state)) throw new Error("invalid v9 checkpoint: state must be an object");
  if (!isRecord(value.cursors) || !isRecord(value.counts)) throw new Error("invalid v9 checkpoint: cursors/counts are required");
  if (!isRecord(value.retention) || !isRecord(value.history)) throw new Error("invalid v9 checkpoint: retention/history are required");
  assertSafeInt(value.retention.recentAttemptLimit, "retention.recentAttemptLimit");
  assertSafeInt(value.retention.recentPracticeRunLimit, "retention.recentPracticeRunLimit");
  if (value.retention.oldestRecentAttemptAt !== null) assertDate(value.retention.oldestRecentAttemptAt, "retention.oldestRecentAttemptAt");
  assertSafeInt(value.history.archivedAttempts, "history.archivedAttempts");
  assertSafeInt(value.history.archivedPracticeRuns, "history.archivedPracticeRuns");
  if (value.history.index !== null) assertDescriptor(value.history.index, "history.index");

  // Reuse the structural validator for the bounded state. Derived
  // arrays are empty, so it validates entity/relation integrity without
  // requiring archive-resident attempt ids.
  const surrogate = {
    formatVersion: 7,
    generatedAt: value.generatedAt,
    state: value.state,
    cursors: value.cursors,
    counts: value.counts,
    retention: value.retention,
  } as unknown as SyncCheckpoint;
  validateSyncCheckpoint(surrogate);
  const state = surrogate.state;
  if ((value.counts as unknown as SyncCheckpointCounts).totalAttempts !== state.attempts.length + value.history.archivedAttempts) {
    throw new Error("invalid v9 checkpoint: totalAttempts does not match recent + archived");
  }
  if ((value.counts as unknown as SyncCheckpointCounts).totalPracticeRuns !== state.practiceRuns.length + value.history.archivedPracticeRuns) {
    throw new Error("invalid v9 checkpoint: totalPracticeRuns does not match recent + archived");
  }
  if ((value.history.archivedAttempts > 0 || value.history.archivedPracticeRuns > 0) && value.history.index === null) {
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

function parseHistoryChunk<T>(bytes: Uint8Array, kind: "attempts" | "practiceRuns"): T[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error(`远程 v9 ${kind} 历史分块不是有效 JSON。`); }
  if (!isRecord(value) || value.formatVersion !== REMOTE_HISTORY_FORMAT || value.kind !== kind || !Array.isArray(value.items)) throw new Error(`远程 v9 ${kind} 历史分块格式无效。`);
  return value.items as T[];
}

async function readHistoryItems<T extends Attempt | PracticeRun>(client: GitHubRemote, descriptors: readonly SyncHistoryDescriptor[], kind: "attempts" | "practiceRuns", historySyncStart?: string): Promise<{ items: T[]; skipped: number }> {
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
      if (items.length !== descriptor.count) throw new Error(`远程 v9 ${kind} 历史分块计数不匹配。`);
      if (!historySyncStart) return items;
      const kept = items.filter((item) => historyTimestampIncluded(kind === "attempts" ? (item as Attempt).createdAt : (item as PracticeRun).startedAt, historySyncStart));
      skipped += items.length - kept.length;
      return kept;
    }));
    chunks.forEach((items) => result.push(...items));
  }
  return { items: result, skipped };
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

  const attempts = chronologicalAttempts(full.state.attempts);
  const practiceRuns = chronologicalRuns(full.state.practiceRuns);
  const archivedAttempts = attempts.slice(0, Math.max(0, attempts.length - recentAttemptLimit));
  const recentAttempts = attempts.slice(archivedAttempts.length);
  const archivedPracticeRuns = practiceRuns.slice(0, Math.max(0, practiceRuns.length - recentPracticeRunLimit));
  const recentPracticeRuns = practiceRuns.slice(archivedPracticeRuns.length);

  const attemptDescriptors = await archiveChunks(client, "attempts", archivedAttempts, chunkCount, full.generatedAt);
  const runDescriptors = await archiveChunks(client, "practiceRuns", archivedPracticeRuns, chunkCount, full.generatedAt);
  let indexDescriptor: SyncDescriptor | null = null;
  if (attemptDescriptors.length || runDescriptors.length) {
    const index: SyncHistoryIndex = {
      formatVersion: REMOTE_HISTORY_FORMAT,
      generatedAt: full.generatedAt,
      attempts: attemptDescriptors,
      practiceRuns: runDescriptors,
      counts: { attempts: archivedAttempts.length, practiceRuns: archivedPracticeRuns.length },
    };
    indexDescriptor = await putHistoryObject(client, index);
  }

  const state = cloneBoundedState(full.state, recentAttempts, recentPracticeRuns);
  const checkpoint: RemoteHistoryCheckpoint = {
    formatVersion: REMOTE_HISTORY_FORMAT,
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
  validateRemoteHistoryCheckpoint(checkpoint);
  return checkpoint;
}

async function hydrateRemoteHistoryCheckpointWithStats(client: GitHubRemote, checkpoint: RemoteHistoryCheckpoint, options: SyncHistoryReadOptions = {}): Promise<{ checkpoint: SyncCheckpoint; archivedAttempts: number; archivedPracticeRuns: number; skippedArchivedAttempts: number; skippedArchivedPracticeRuns: number }> {
  validateRemoteHistoryCheckpoint(checkpoint);
  const historySyncStart = normalizeHistorySyncStart(options.historySyncStart);
  let archivedAttempts: Attempt[] = [];
  let archivedPracticeRuns: PracticeRun[] = [];
  let skippedArchivedAttempts = 0;
  let skippedArchivedPracticeRuns = 0;
  if (checkpoint.history.index) {
    const index = parseHistoryIndex(await client.readBlob(checkpoint.history.index));
    if (index.counts.attempts !== checkpoint.history.archivedAttempts || index.counts.practiceRuns !== checkpoint.history.archivedPracticeRuns) {
      throw new Error("远程 v9 历史索引总数与检查点不一致。");
    }
    const [attemptResult, runResult] = await Promise.all([
      readHistoryItems<Attempt>(client, index.attempts, "attempts", historySyncStart),
      readHistoryItems<PracticeRun>(client, index.practiceRuns, "practiceRuns", historySyncStart),
    ]);
    archivedAttempts = attemptResult.items;
    archivedPracticeRuns = runResult.items;
    skippedArchivedAttempts = attemptResult.skipped;
    skippedArchivedPracticeRuns = runResult.skipped;
  }

  const attemptMap = new Map<string, Attempt>();
  for (const item of [...archivedAttempts, ...checkpoint.state.attempts]) attemptMap.set(item.id, item);
  const runMap = new Map<string, PracticeRun>();
  for (const item of [...archivedPracticeRuns, ...checkpoint.state.practiceRuns]) runMap.set(item.id, item);
  if (!historySyncStart && (attemptMap.size !== checkpoint.counts.totalAttempts || runMap.size !== checkpoint.counts.totalPracticeRuns)) {
    throw new Error("远程 v9 历史水合后记录数与检查点不一致。");
  }

  const projection: ChangeSetProjection = {
    ...checkpoint.state,
    attempts: chronologicalAttempts([...attemptMap.values()]),
    practiceRuns: chronologicalRuns([...runMap.values()]),
  };
  const finalized = filterProjectionHistory(finalizeRebasedProjection(projection), historySyncStart);
  const full = await checkpointFromProjection(finalized, checkpoint.cursors);
  full.generatedAt = checkpoint.generatedAt;
  validateSyncCheckpoint(full);
  return { checkpoint: full, archivedAttempts: archivedAttempts.length, archivedPracticeRuns: archivedPracticeRuns.length, skippedArchivedAttempts, skippedArchivedPracticeRuns };
}

export async function hydrateRemoteHistoryCheckpoint(client: GitHubRemote, checkpoint: RemoteHistoryCheckpoint, options: SyncHistoryReadOptions = {}): Promise<SyncCheckpoint> {
  return (await hydrateRemoteHistoryCheckpointWithStats(client, checkpoint, options)).checkpoint;
}

export async function decodeRemoteCheckpoint(client: GitHubRemote, bytes: Uint8Array, options: SyncHistoryReadOptions = {}): Promise<HydratedRemoteCheckpoint> {
  let header: unknown;
  try { header = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error("远程检查点不是有效 JSON。"); }
  // Current clients accept only the v9 checkpoint envelope.
  if (!isRecord(header) || header.formatVersion !== REMOTE_HISTORY_FORMAT) {
    throw new Error("远程检查点格式不是 v9；当前客户端只接受 v9 数据。");
  }
  const checkpoint = parseRemoteHistoryCheckpoint(bytes);
  return hydrateRemoteHistoryCheckpointWithStats(client, checkpoint, options);
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
