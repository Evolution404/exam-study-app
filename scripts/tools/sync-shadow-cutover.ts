import { sha256DigestHex } from "../../src/lib/crypto/sha256";
import type { Attempt } from "../../src/lib/db/types";
import type { GitHubRemote } from "../../src/lib/sync/github-remote";
import type { SyncCheckpoint, SyncCheckpointState } from "../../src/lib/sync/sync-checkpoint-types";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import {
  REMOTE_HISTORY_FORMAT,
  SYNC_HISTORY_CHUNK_COUNT,
  SYNC_HISTORY_RECENT_ATTEMPT_LIMIT,
  SYNC_HISTORY_RECENT_PRACTICE_RUN_LIMIT,
  decodeRemoteCheckpoint,
  validateRemoteHistoryCheckpoint,
  type RemoteHistoryCheckpoint,
} from "../../src/lib/sync/sync-history";
import {
  boundedCanonicalHistoryState,
  chronologicalHistoryAttempts,
  countsForHistoryState,
} from "../../src/lib/sync/sync-history-state";
import {
  SYNC_CHECKPOINT_PREFIX,
  SYNC_FORMAT_VERSION,
  SYNC_HEAD_PATH,
  SYNC_HISTORY_PREFIX,
  type SyncDescriptor,
  type SyncDescriptorKind,
  type SyncHead,
} from "../../src/lib/sync/sync-head-types";
import { validateSyncDescriptor, validateSyncHead } from "../../src/lib/sync/sync-head-validation";

const SOURCE_REMOTE_FORMAT = 9 as const;
const SHA1 = /^[0-9a-f]{40}$/;

export interface SyncShadowPlan {
  sourceFormatVersion: typeof SOURCE_REMOTE_FORMAT;
  targetFormatVersion: typeof SYNC_FORMAT_VERSION;
  vaultId: string;
  sourceHeadSha: string;
  checkpoint: SyncCheckpoint;
  cutoverHead: { path: typeof SYNC_HEAD_PATH; authorized: false };
}

export interface SyncShadowRemote {
  putImmutable(input: { path: string; bytes: Uint8Array; kind: SyncDescriptorKind }): Promise<SyncDescriptor>;
  readBlob(descriptor: SyncDescriptor): Promise<Uint8Array>;
}

export interface SyncShadowBuildOptions {
  recentAttemptLimit?: number;
  recentPracticeRunLimit?: number;
  chunkCount?: number;
}

export interface StagedSyncShadow {
  sourceFormatVersion: typeof SOURCE_REMOTE_FORMAT;
  targetFormatVersion: typeof SYNC_FORMAT_VERSION;
  vaultId: string;
  sourceHeadSha: string;
  checkpointDescriptor: SyncDescriptor;
  historyObjects: SyncDescriptor[];
  head: SyncHead;
  cutoverHead: { path: typeof SYNC_HEAD_PATH; authorized: false };
}

export interface SyncCutoverPublisher {
  readSourceHeadSha(): Promise<string>;
  publishHead(path: typeof SYNC_HEAD_PATH, content: string): Promise<void>;
}

interface HistoryDescriptor extends SyncDescriptor {
  kind: "attempts" | "practiceRuns";
  count: number;
  firstAt?: string;
  lastAt?: string;
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function chunks<T>(rows: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
  return result;
}

async function putLogical(
  remote: SyncShadowRemote,
  prefix: string,
  kind: SyncDescriptorKind,
  value: unknown,
): Promise<SyncDescriptor> {
  const bytes = jsonBytes(value);
  const digest = await sha256DigestHex(bytes);
  const path = `${prefix}${digest}.json`;
  const descriptor = await remote.putImmutable({ path, bytes, kind });
  validateSyncDescriptor(descriptor, kind);
  if (descriptor.path !== path || descriptor.sha256 !== digest || descriptor.size !== bytes.byteLength) {
    throw new Error(`shadow ${kind} descriptor mismatch`);
  }
  const readBack = await remote.readBlob(descriptor);
  if (readBack.byteLength !== bytes.byteLength || await sha256DigestHex(readBack) !== digest) {
    throw new Error(`shadow ${kind} read-back verification failed`);
  }
  return descriptor;
}

export function buildSyncShadowPlan(input: {
  vaultId: string;
  sourceHeadSha: string;
  checkpoint: SyncCheckpoint;
}): SyncShadowPlan {
  validateSyncCheckpoint(input.checkpoint);
  if (!input.vaultId) throw new Error("sync conversion requires vaultId");
  if (!SHA1.test(input.sourceHeadSha)) throw new Error("sync conversion requires the source head SHA");
  return {
    sourceFormatVersion: SOURCE_REMOTE_FORMAT,
    targetFormatVersion: SYNC_FORMAT_VERSION,
    vaultId: input.vaultId,
    sourceHeadSha: input.sourceHeadSha,
    checkpoint: structuredClone(input.checkpoint),
    cutoverHead: { path: SYNC_HEAD_PATH, authorized: false },
  };
}

export async function stageSyncShadow(
  plan: SyncShadowPlan,
  remote: SyncShadowRemote,
  options: SyncShadowBuildOptions = {},
): Promise<StagedSyncShadow> {
  if (plan.cutoverHead.authorized !== false) throw new Error("shadow conversion must not authorize cutover");
  validateSyncCheckpoint(plan.checkpoint);
  const recentAttemptLimit = Math.max(0, options.recentAttemptLimit ?? SYNC_HISTORY_RECENT_ATTEMPT_LIMIT);
  const recentPracticeRunLimit = Math.max(0, options.recentPracticeRunLimit ?? SYNC_HISTORY_RECENT_PRACTICE_RUN_LIMIT);
  const chunkCount = Math.max(1, options.chunkCount ?? SYNC_HISTORY_CHUNK_COUNT);
  const bounded = boundedCanonicalHistoryState(plan.checkpoint.state, recentAttemptLimit, recentPracticeRunLimit);
  const historyObjects: SyncDescriptor[] = [];
  const attemptDescriptors: HistoryDescriptor[] = [];

  for (const items of chunks(bounded.archivedAttempts, chunkCount)) {
    const descriptor = await putLogical(remote, SYNC_HISTORY_PREFIX, "history", {
      formatVersion: REMOTE_HISTORY_FORMAT,
      kind: "attempts",
      generatedAt: plan.checkpoint.generatedAt,
      items,
    });
    historyObjects.push(descriptor);
    const dates = items.map((item) => item.createdAt).sort();
    attemptDescriptors.push({ ...descriptor, kind: "attempts", count: items.length, firstAt: dates[0], lastAt: dates.at(-1) });
  }

  const runDescriptors: HistoryDescriptor[] = [];
  const attemptsByRun = new Map<string, Attempt[]>();
  for (const attempt of plan.checkpoint.state.attempts) {
    const bucket = attemptsByRun.get(attempt.runId) ?? [];
    bucket.push(attempt);
    attemptsByRun.set(attempt.runId, bucket);
  }
  for (const practiceRuns of chunks(bounded.archivedPracticeRuns, chunkCount)) {
    const runIds = new Set(practiceRuns.map((run) => run.id));
    const descriptor = await putLogical(remote, SYNC_HISTORY_PREFIX, "history", {
      formatVersion: REMOTE_HISTORY_FORMAT,
      kind: "practiceRuns",
      generatedAt: plan.checkpoint.generatedAt,
      practiceRuns,
      practiceRunSources: plan.checkpoint.state.practiceRunSources.filter((row) => runIds.has(row.runId)),
      practiceRunItems: plan.checkpoint.state.practiceRunItems.filter((row) => runIds.has(row.runId)),
    });
    historyObjects.push(descriptor);
    const dates = practiceRuns
      .flatMap((run) => [run.startedAt, ...(attemptsByRun.get(run.id) ?? []).map((attempt) => attempt.createdAt)])
      .sort();
    runDescriptors.push({ ...descriptor, kind: "practiceRuns", count: practiceRuns.length, firstAt: dates[0], lastAt: dates.at(-1) });
  }

  let historyIndex: SyncDescriptor | null = null;
  if (attemptDescriptors.length || runDescriptors.length) {
    historyIndex = await putLogical(remote, SYNC_HISTORY_PREFIX, "history", {
      formatVersion: REMOTE_HISTORY_FORMAT,
      generatedAt: plan.checkpoint.generatedAt,
      attempts: attemptDescriptors,
      practiceRuns: runDescriptors,
      counts: { attempts: bounded.archivedAttempts.length, practiceRuns: bounded.archivedPracticeRuns.length },
    });
    historyObjects.push(historyIndex);
  }

  const remoteCheckpoint: RemoteHistoryCheckpoint = {
    formatVersion: REMOTE_HISTORY_FORMAT,
    generatedAt: plan.checkpoint.generatedAt,
    state: bounded.state,
    cursors: structuredClone(plan.checkpoint.cursors),
    counts: countsForHistoryState(bounded.state, {
      attempts: plan.checkpoint.state.attempts.length,
      practiceRuns: plan.checkpoint.state.practiceRuns.length,
    }),
    retention: {
      recentAttemptLimit,
      recentPracticeRunLimit,
      oldestRecentAttemptAt: chronologicalHistoryAttempts(bounded.state.attempts)[0]?.createdAt ?? null,
    },
    history: {
      index: historyIndex,
      archivedAttempts: bounded.archivedAttempts.length,
      archivedPracticeRuns: bounded.archivedPracticeRuns.length,
    },
  };
  validateRemoteHistoryCheckpoint(remoteCheckpoint);
  const checkpointDescriptor = await putLogical(remote, SYNC_CHECKPOINT_PREFIX, "checkpoint", remoteCheckpoint);
  const head: SyncHead = {
    formatVersion: SYNC_FORMAT_VERSION,
    vaultId: plan.vaultId,
    generatedAt: plan.checkpoint.generatedAt,
    generation: 1,
    metadata: { vaultId: plan.vaultId, producer: "sync-converter" },
    checkpoint: checkpointDescriptor,
    segments: [],
    cursors: structuredClone(plan.checkpoint.cursors),
  };
  validateSyncHead(head);
  return {
    sourceFormatVersion: plan.sourceFormatVersion,
    targetFormatVersion: plan.targetFormatVersion,
    vaultId: plan.vaultId,
    sourceHeadSha: plan.sourceHeadSha,
    checkpointDescriptor,
    historyObjects,
    head,
    cutoverHead: plan.cutoverHead,
  };
}

function normalizedRows<T>(rows: readonly T[]): string[] {
  return rows.map((row) => JSON.stringify(row)).sort();
}

export async function verifyStagedSyncShadow(
  expected: SyncCheckpoint,
  staged: StagedSyncShadow,
  remote: SyncShadowRemote,
): Promise<SyncCheckpoint> {
  validateSyncCheckpoint(expected);
  validateSyncHead(staged.head);
  const bytes = await remote.readBlob(staged.checkpointDescriptor);
  const hydrated = await decodeRemoteCheckpoint(remote as GitHubRemote, bytes);
  validateSyncCheckpoint(hydrated.checkpoint);
  for (const key of Object.keys(expected.state) as Array<keyof SyncCheckpointState>) {
    if (JSON.stringify(normalizedRows(expected.state[key])) !== JSON.stringify(normalizedRows(hydrated.checkpoint.state[key]))) {
      throw new Error(`staged shadow changed canonical state.${key}`);
    }
  }
  const expectedCursors = Object.entries(expected.cursors).sort(([left], [right]) => left.localeCompare(right));
  const hydratedCursors = Object.entries(hydrated.checkpoint.cursors).sort(([left], [right]) => left.localeCompare(right));
  if (JSON.stringify(expectedCursors) !== JSON.stringify(hydratedCursors)) throw new Error("staged shadow changed cursors");
  return hydrated.checkpoint;
}

export async function publishSyncCutover(staged: StagedSyncShadow, publisher: SyncCutoverPublisher): Promise<void> {
  validateSyncHead(staged.head);
  const sourceHeadSha = await publisher.readSourceHeadSha();
  if (sourceHeadSha !== staged.sourceHeadSha) throw new Error("source sync head changed after conversion; cutover aborted");
  await publisher.publishHead(SYNC_HEAD_PATH, JSON.stringify(staged.head));
}
