import { sha256DigestHex } from "../../src/lib/crypto/sha256";
import type { Attempt, PracticeRun } from "../../src/lib/db/types";
import { canonicalSerialize } from "../../src/lib/sync/change-set-codec";
import type { ChangeSet, ChangeSetMutation } from "../../src/lib/sync/change-set-types";
import {
  applyChangeSetToOwnedProjection,
  finalizeRebasedProjection,
  type ChangeSetProjection,
} from "../../src/lib/sync/change-set-projection";
import type { SyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-types";
import { validateSyncCheckpoint } from "../../src/lib/sync/sync-checkpoint-validation";
import {
  convertLegacySyncCheckpoint,
  type LegacySyncCheckpoint,
} from "./sync-v9-to-v10-converter";

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const LEGACY_CHECKPOINT_PREFIX = "sync/v9/checkpoints/";
const LEGACY_SEGMENT_PREFIX = "sync/v9/segments/";
const LEGACY_OBJECT_PREFIX = "sync/v9/objects/";
const LEGACY_HISTORY_PREFIX = "sync/v9/history/";
const LEGACY_CHANGE_SET_FORMAT = 7;
const LEGACY_REMOTE_FORMAT = 9;

export interface LegacySyncDescriptor {
  path: string;
  blobSha: string;
  sha256: string;
  size: number;
  storedSize: number;
  generation?: number;
}

export interface LegacySyncImmutableRef {
  path: string;
  sha256: string;
  size: number;
  kind?: string;
  blobSha?: string;
}

export interface LegacySyncSegmentDescriptor extends LegacySyncDescriptor {
  generation: number;
  ordinal: number;
  count: number;
  cursors: Record<string, number>;
  metadata: {
    vaultId: string;
    createdAt?: string;
    deviceId?: string;
    producer?: string;
  };
}

export interface LegacySyncHead {
  formatVersion: 9;
  vaultId: string;
  generatedAt: string;
  generation: number;
  metadata: {
    vaultId: string;
    createdAt?: string;
    deviceId?: string;
    producer?: string;
  };
  checkpoint: LegacySyncDescriptor | null;
  segments: LegacySyncSegmentDescriptor[];
  cursors: Record<string, number>;
}

export interface LegacySyncRemoteSource {
  readHead(): Promise<{ head: LegacySyncHead; headSha: string }>;
  /** Returns logical/decompressed object bytes. */
  readDescriptor(descriptor: LegacySyncDescriptor): Promise<Uint8Array>;
  /** Returns logical/decompressed immutable payload bytes. */
  readImmutable(ref: LegacySyncImmutableRef): Promise<Uint8Array>;
}

export interface LegacyRemoteSnapshotResult {
  checkpoint: SyncCheckpoint;
  sourceHeadSha: string;
  archivedAttempts: number;
  archivedPracticeRuns: number;
  hotChangeSets: number;
}

interface LegacyHistoryDescriptor extends LegacySyncDescriptor {
  kind: "attempts" | "practiceRuns";
  count: number;
  firstAt?: string;
  lastAt?: string;
}

interface LegacyHistoryIndex {
  formatVersion: 9;
  generatedAt: string;
  attempts: LegacyHistoryDescriptor[];
  practiceRuns: LegacyHistoryDescriptor[];
  counts: { attempts: number; practiceRuns: number };
}

interface LegacyRemoteHistoryCheckpoint {
  formatVersion: 9;
  generatedAt: string;
  state: LegacySyncCheckpoint["state"];
  cursors: Record<string, number>;
  counts: Record<string, number> & { totalAttempts: number; totalPracticeRuns: number };
  retention?: LegacySyncCheckpoint["retention"];
  history: {
    index: LegacySyncDescriptor | null;
    archivedAttempts: number;
    archivedPracticeRuns: number;
  };
}

interface LegacyChangeSetEnvelope {
  formatVersion: 7;
  id: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind: string;
  mutations: Array<Record<string, unknown> & { kind: string }>;
  entityRefs: Array<{ type: string; id: string }>;
  payloadRefs?: LegacySyncImmutableRef[];
  digest: string;
}

interface OffloadedEventStub {
  payloadRef: LegacySyncImmutableRef;
  formatVersion: number;
  id: string;
  deviceId: string;
  localSequence: number;
  createdAt: string;
  kind: string;
  digest: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`legacy sync ${field} must be a non-empty string`);
}

function assertSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`legacy sync ${field} must be a safe integer >= ${minimum}`);
}

function assertIso(value: unknown, field: string): asserts value is string {
  assertString(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`legacy sync ${field} must be an ISO timestamp`);
}

function assertArray(value: unknown, field: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`legacy sync ${field} must be an array`);
}

function pathDigest(path: string): string | undefined {
  return /\/([0-9a-f]{64})\.json$/.exec(path)?.[1];
}

function assertDescriptor(
  value: unknown,
  field: string,
  prefix: string,
): asserts value is LegacySyncDescriptor {
  if (!isRecord(value)) throw new Error(`legacy sync ${field} must be a descriptor`);
  assertString(value.path, `${field}.path`);
  if (!(value.path as string).startsWith(prefix)) throw new Error(`legacy sync ${field}.path must start with ${prefix}`);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error(`legacy sync ${field}.sha256 is invalid`);
  if (typeof value.blobSha !== "string" || !SHA1.test(value.blobSha)) throw new Error(`legacy sync ${field}.blobSha is invalid`);
  assertSafeInteger(value.size, `${field}.size`);
  assertSafeInteger(value.storedSize, `${field}.storedSize`);
  const digest = pathDigest(value.path as string);
  if (!digest || digest !== value.sha256) throw new Error(`legacy sync ${field}.path digest does not match sha256`);
}

function assertImmutableRef(value: unknown, field: string): asserts value is LegacySyncImmutableRef {
  if (!isRecord(value)) throw new Error(`legacy sync ${field} must be an immutable ref`);
  assertString(value.path, `${field}.path`);
  if (!(value.path as string).startsWith(LEGACY_OBJECT_PREFIX)) throw new Error(`legacy sync ${field}.path must be in the v9 object namespace`);
  if (typeof value.sha256 !== "string" || !SHA256.test(value.sha256)) throw new Error(`legacy sync ${field}.sha256 is invalid`);
  assertSafeInteger(value.size, `${field}.size`);
  const digest = pathDigest(value.path as string);
  if (!digest || digest !== value.sha256) throw new Error(`legacy sync ${field}.path digest does not match sha256`);
  if (value.blobSha !== undefined && (typeof value.blobSha !== "string" || !SHA1.test(value.blobSha))) throw new Error(`legacy sync ${field}.blobSha is invalid`);
}

function assertCursorMap(value: unknown, field: string): asserts value is Record<string, number> {
  if (!isRecord(value)) throw new Error(`legacy sync ${field} must be a cursor map`);
  for (const [deviceId, sequence] of Object.entries(value)) {
    assertString(deviceId, `${field}.deviceId`);
    assertSafeInteger(sequence, `${field}.${deviceId}`);
  }
}

function assertHead(value: unknown): asserts value is LegacySyncHead {
  if (!isRecord(value) || value.formatVersion !== LEGACY_REMOTE_FORMAT) throw new Error("legacy sync head formatVersion must be 9");
  assertString(value.vaultId, "head.vaultId");
  assertIso(value.generatedAt, "head.generatedAt");
  assertSafeInteger(value.generation, "head.generation");
  if (!isRecord(value.metadata) || value.metadata.vaultId !== value.vaultId) throw new Error("legacy sync head metadata vaultId mismatch");
  assertCursorMap(value.cursors, "head.cursors");
  if (value.checkpoint !== null) assertDescriptor(value.checkpoint, "head.checkpoint", LEGACY_CHECKPOINT_PREFIX);
  assertArray(value.segments, "head.segments");
  let previous: LegacySyncSegmentDescriptor | undefined;
  const paths = new Set<string>();
  for (let index = 0; index < value.segments.length; index += 1) {
    const segment = value.segments[index];
    assertDescriptor(segment, `head.segments[${index}]`, LEGACY_SEGMENT_PREFIX);
    if (!isRecord(segment)) throw new Error(`legacy sync head.segments[${index}] is invalid`);
    assertSafeInteger(segment.generation, `head.segments[${index}].generation`);
    assertSafeInteger(segment.ordinal, `head.segments[${index}].ordinal`);
    assertSafeInteger(segment.count, `head.segments[${index}].count`, 1);
    assertCursorMap(segment.cursors, `head.segments[${index}].cursors`);
    if (!isRecord(segment.metadata) || segment.metadata.vaultId !== value.vaultId) throw new Error(`legacy sync head.segments[${index}] vaultId mismatch`);
    if (paths.has(segment.path)) throw new Error(`legacy sync duplicate segment path ${segment.path}`);
    paths.add(segment.path);
    if (previous && (previous.generation > segment.generation || (previous.generation === segment.generation && previous.ordinal >= segment.ordinal))) {
      throw new Error("legacy sync segments are not strictly ordered by generation/ordinal");
    }
    previous = segment as LegacySyncSegmentDescriptor;
  }
}

async function verifyBytes(bytes: Uint8Array, expected: { size: number; sha256: string }, field: string): Promise<void> {
  if (bytes.byteLength !== expected.size) throw new Error(`legacy sync ${field} size integrity mismatch`);
  const digest = await sha256DigestHex(bytes);
  if (digest !== expected.sha256) throw new Error(`legacy sync ${field} sha256 integrity mismatch`);
}

async function readDescriptor(
  source: LegacySyncRemoteSource,
  descriptor: LegacySyncDescriptor,
  field: string,
  prefix: string,
): Promise<Uint8Array> {
  assertDescriptor(descriptor, field, prefix);
  const bytes = await source.readDescriptor(descriptor);
  await verifyBytes(bytes, descriptor, field);
  return bytes;
}

async function readImmutable(
  source: LegacySyncRemoteSource,
  ref: LegacySyncImmutableRef,
  field: string,
): Promise<Uint8Array> {
  assertImmutableRef(ref, field);
  const bytes = await source.readImmutable(ref);
  await verifyBytes(bytes, ref, field);
  return bytes;
}

function parseJson(bytes: Uint8Array, field: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new Error(`legacy sync ${field} is not valid JSON`);
  }
}

function assertLegacyState(value: unknown, field: string): asserts value is LegacySyncCheckpoint["state"] {
  if (!isRecord(value)) throw new Error(`legacy sync ${field} must be an object`);
  for (const key of [
    "banks", "bankFolders", "questions", "memberships", "imageAssets", "attempts",
    "attemptStats", "attemptDailyStats", "notes", "practiceRuns", "practiceRunStats",
    "questionGroups", "reviewRounds", "reviewRoundProgress", "tombstones",
  ]) assertArray(value[key], `${field}.${key}`);
}

function parseRemoteCheckpoint(bytes: Uint8Array): LegacyRemoteHistoryCheckpoint {
  const value = parseJson(bytes, "checkpoint");
  if (!isRecord(value) || value.formatVersion !== LEGACY_REMOTE_FORMAT) throw new Error("legacy sync checkpoint formatVersion must be 9");
  assertIso(value.generatedAt, "checkpoint.generatedAt");
  assertLegacyState(value.state, "checkpoint.state");
  assertCursorMap(value.cursors, "checkpoint.cursors");
  if (!isRecord(value.counts)) throw new Error("legacy sync checkpoint.counts must be an object");
  assertSafeInteger(value.counts.totalAttempts, "checkpoint.counts.totalAttempts");
  assertSafeInteger(value.counts.totalPracticeRuns, "checkpoint.counts.totalPracticeRuns");
  if (!isRecord(value.history)) throw new Error("legacy sync checkpoint.history must be an object");
  assertSafeInteger(value.history.archivedAttempts, "checkpoint.history.archivedAttempts");
  assertSafeInteger(value.history.archivedPracticeRuns, "checkpoint.history.archivedPracticeRuns");
  if (value.history.index !== null) assertDescriptor(value.history.index, "checkpoint.history.index", LEGACY_HISTORY_PREFIX);
  return value as unknown as LegacyRemoteHistoryCheckpoint;
}

function parseHistoryIndex(bytes: Uint8Array): LegacyHistoryIndex {
  const value = parseJson(bytes, "history index");
  if (!isRecord(value) || value.formatVersion !== LEGACY_REMOTE_FORMAT) throw new Error("legacy sync history index formatVersion must be 9");
  assertIso(value.generatedAt, "history.generatedAt");
  assertArray(value.attempts, "history.attempts");
  assertArray(value.practiceRuns, "history.practiceRuns");
  if (!isRecord(value.counts)) throw new Error("legacy sync history.counts must be an object");
  assertSafeInteger(value.counts.attempts, "history.counts.attempts");
  assertSafeInteger(value.counts.practiceRuns, "history.counts.practiceRuns");
  for (const [kind, entries] of [["attempts", value.attempts], ["practiceRuns", value.practiceRuns]] as const) {
    for (let index = 0; index < entries.length; index += 1) {
      const descriptor = entries[index];
      assertDescriptor(descriptor, `history.${kind}[${index}]`, LEGACY_HISTORY_PREFIX);
      if (!isRecord(descriptor) || descriptor.kind !== kind) throw new Error(`legacy sync history.${kind}[${index}].kind mismatch`);
      assertSafeInteger(descriptor.count, `history.${kind}[${index}].count`);
    }
  }
  return value as unknown as LegacyHistoryIndex;
}

function parseHistoryChunk<T>(bytes: Uint8Array, kind: "attempts" | "practiceRuns", expectedCount: number): T[] {
  const value = parseJson(bytes, `${kind} history chunk`);
  if (!isRecord(value) || value.formatVersion !== LEGACY_REMOTE_FORMAT || value.kind !== kind || !Array.isArray(value.items)) {
    throw new Error(`legacy sync ${kind} history chunk envelope is invalid`);
  }
  if (value.items.length !== expectedCount) throw new Error(`legacy sync ${kind} history chunk count mismatch`);
  return value.items as T[];
}

async function hydrateHistory(
  source: LegacySyncRemoteSource,
  checkpoint: LegacyRemoteHistoryCheckpoint,
): Promise<{ attempts: Attempt[]; runs: PracticeRun[] }> {
  if (!checkpoint.history.index) {
    if (checkpoint.history.archivedAttempts || checkpoint.history.archivedPracticeRuns) throw new Error("legacy sync checkpoint declares archived history without an index");
    return { attempts: [], runs: [] };
  }
  const indexBytes = await readDescriptor(source, checkpoint.history.index, "history index", LEGACY_HISTORY_PREFIX);
  const index = parseHistoryIndex(indexBytes);
  if (index.counts.attempts !== checkpoint.history.archivedAttempts || index.counts.practiceRuns !== checkpoint.history.archivedPracticeRuns) {
    throw new Error("legacy sync history index totals do not match checkpoint");
  }
  const attempts: Attempt[] = [];
  const runs: PracticeRun[] = [];
  for (const descriptor of index.attempts) {
    attempts.push(...parseHistoryChunk<Attempt>(await readDescriptor(source, descriptor, "attempt history chunk", LEGACY_HISTORY_PREFIX), "attempts", descriptor.count));
  }
  for (const descriptor of index.practiceRuns) {
    runs.push(...parseHistoryChunk<PracticeRun>(await readDescriptor(source, descriptor, "practice-run history chunk", LEGACY_HISTORY_PREFIX), "practiceRuns", descriptor.count));
  }
  if (attempts.length !== index.counts.attempts || runs.length !== index.counts.practiceRuns) throw new Error("legacy sync hydrated history totals do not match index");
  return { attempts, runs };
}

function mergeById<T extends { id: string }>(archived: readonly T[], recent: readonly T[], expected: number, field: string): T[] {
  const map = new Map<string, T>();
  for (const row of archived) map.set(row.id, structuredClone(row));
  for (const row of recent) map.set(row.id, structuredClone(row));
  if (map.size !== expected) throw new Error(`legacy sync hydrated ${field} count does not match checkpoint total`);
  return [...map.values()];
}

function projectionFromLegacyCheckpoint(checkpoint: LegacySyncCheckpoint): ChangeSetProjection {
  return {
    banks: structuredClone(checkpoint.state.banks),
    bankFolders: structuredClone(checkpoint.state.bankFolders),
    questions: structuredClone(checkpoint.state.questions),
    memberships: structuredClone(checkpoint.state.memberships),
    imageAssets: structuredClone(checkpoint.state.imageAssets),
    attempts: structuredClone(checkpoint.state.attempts),
    attemptStats: structuredClone(checkpoint.state.attemptStats) as ChangeSetProjection["attemptStats"],
    attemptDailyStats: structuredClone(checkpoint.state.attemptDailyStats) as ChangeSetProjection["attemptDailyStats"],
    notes: structuredClone(checkpoint.state.notes),
    practiceRuns: structuredClone(checkpoint.state.practiceRuns) as ChangeSetProjection["practiceRuns"],
    practiceRunStats: structuredClone(checkpoint.state.practiceRunStats) as ChangeSetProjection["practiceRunStats"],
    questionGroups: structuredClone(checkpoint.state.questionGroups) as ChangeSetProjection["questionGroups"],
    reviewRounds: structuredClone(checkpoint.state.reviewRounds) as ChangeSetProjection["reviewRounds"],
    reviewRoundProgress: structuredClone(checkpoint.state.reviewRoundProgress) as ChangeSetProjection["reviewRoundProgress"],
    tombstones: structuredClone(checkpoint.state.tombstones),
  };
}

function isOffloadedEvent(value: unknown): value is OffloadedEventStub {
  if (!isRecord(value) || !isRecord(value.payloadRef)) return false;
  return typeof value.id === "string" && typeof value.deviceId === "string" && Number.isSafeInteger(value.localSequence)
    && typeof value.createdAt === "string" && typeof value.kind === "string" && typeof value.digest === "string";
}

async function hydrateSegmentEvent(source: LegacySyncRemoteSource, value: unknown): Promise<unknown> {
  if (!isOffloadedEvent(value)) return value;
  assertImmutableRef(value.payloadRef, "segment event payloadRef");
  const hydrated = parseJson(await readImmutable(source, value.payloadRef, "segment event payload"), "segment event payload");
  if (!isRecord(hydrated)) throw new Error("legacy sync offloaded change-set is not an object");
  for (const field of ["formatVersion", "id", "deviceId", "localSequence", "createdAt", "kind", "digest"] as const) {
    if (hydrated[field] !== value[field]) throw new Error(`legacy sync offloaded change-set ${field} does not match its stub`);
  }
  return hydrated;
}

function parseSegment(bytes: Uint8Array, descriptor: LegacySyncSegmentDescriptor, vaultId: string): unknown[] {
  const value = parseJson(bytes, "segment");
  if (!isRecord(value) || value.formatVersion !== LEGACY_REMOTE_FORMAT || value.vaultId !== vaultId || !Array.isArray(value.events)) {
    throw new Error("legacy sync segment envelope is invalid");
  }
  if (value.generation !== descriptor.generation || value.ordinal !== descriptor.ordinal) throw new Error("legacy sync segment replay key mismatch");
  if (value.events.length !== descriptor.count) throw new Error("legacy sync segment event count mismatch");
  return value.events;
}

async function parseLegacyChangeSet(value: unknown): Promise<LegacyChangeSetEnvelope> {
  if (!isRecord(value) || value.formatVersion !== LEGACY_CHANGE_SET_FORMAT) throw new Error("legacy sync change-set formatVersion must be 7");
  assertString(value.id, "change-set.id");
  assertString(value.deviceId, "change-set.deviceId");
  assertSafeInteger(value.localSequence, "change-set.localSequence");
  assertIso(value.createdAt, "change-set.createdAt");
  assertString(value.kind, "change-set.kind");
  assertArray(value.mutations, "change-set.mutations");
  if (!value.mutations.length) throw new Error("legacy sync change-set must contain mutations");
  for (let index = 0; index < value.mutations.length; index += 1) {
    if (!isRecord(value.mutations[index]) || typeof (value.mutations[index] as Record<string, unknown>).kind !== "string") throw new Error(`legacy sync change-set mutation ${index} is invalid`);
  }
  assertArray(value.entityRefs, "change-set.entityRefs");
  for (let index = 0; index < value.entityRefs.length; index += 1) {
    const ref = value.entityRefs[index];
    if (!isRecord(ref)) throw new Error(`legacy sync change-set.entityRefs[${index}] is invalid`);
    assertString(ref.type, `change-set.entityRefs[${index}].type`);
    assertString(ref.id, `change-set.entityRefs[${index}].id`);
  }
  if (value.payloadRefs !== undefined) {
    assertArray(value.payloadRefs, "change-set.payloadRefs");
    for (let index = 0; index < value.payloadRefs.length; index += 1) assertImmutableRef(value.payloadRefs[index], `change-set.payloadRefs[${index}]`);
  }
  if (typeof value.digest !== "string" || !SHA256.test(value.digest)) throw new Error("legacy sync change-set digest is invalid");
  const content = { ...value };
  delete content.digest;
  const digest = await sha256DigestHex(new TextEncoder().encode(canonicalSerialize(content)));
  if (digest !== value.digest) throw new Error(`legacy sync change-set ${value.id} digest integrity mismatch`);
  const expectedKind = value.mutations.length > 1 ? "batch" : (value.mutations[0] as Record<string, unknown>).kind;
  if (value.kind !== expectedKind) throw new Error(`legacy sync change-set ${value.id} kind does not match mutations`);
  return value as unknown as LegacyChangeSetEnvelope;
}

function tombstoned(projection: ChangeSetProjection, entityType: string, entityId: string): boolean {
  return projection.tombstones.some((row) => row.entityType === entityType && row.entityId === entityId);
}

function replaceAttempt(projection: ChangeSetProjection, attempt: Attempt, reviewRoundId?: string): void {
  if (!projection.questions.some((row) => row.id === attempt.questionId)) throw new Error(`legacy sync attempt references missing question ${attempt.questionId}`);
  if (tombstoned(projection, "attempt", attempt.id)) throw new Error(`legacy sync attempt ${attempt.id} is tombstoned`);
  const index = projection.attempts.findIndex((row) => row.id === attempt.id);
  if (index < 0) throw new Error(`legacy sync attempt ${attempt.id} does not exist`);
  if (!Number.isSafeInteger(attempt.elapsedMs) || attempt.elapsedMs < 0) throw new Error(`legacy sync attempt ${attempt.id} elapsedMs is invalid`);
  const current = projection.attempts[index];
  const inheritedRoundId = attempt.reviewRoundId ?? reviewRoundId ?? current.reviewRoundId;
  projection.attempts[index] = structuredClone(inheritedRoundId ? { ...attempt, reviewRoundId: inheritedRoundId } : attempt);
}

function applyRetiredMutation(
  projection: ChangeSetProjection,
  mutation: LegacyChangeSetEnvelope["mutations"][number],
): void {
  if (mutation.kind === "attempt.update") {
    if (!isRecord(mutation.attempt)) throw new Error("legacy sync attempt.update has no attempt");
    replaceAttempt(projection, mutation.attempt as unknown as Attempt, typeof mutation.reviewRoundId === "string" ? mutation.reviewRoundId : undefined);
    return;
  }
  if (mutation.kind !== "practice.answer.updated") throw new Error(`legacy sync unsupported retired mutation ${mutation.kind}`);
  if (!isRecord(mutation.attempt) || !isRecord(mutation.answer)) throw new Error("legacy sync practice.answer.updated payload is invalid");
  assertString(mutation.runId, "practice.answer.updated.runId");
  assertString(mutation.questionId, "practice.answer.updated.questionId");
  const runIndex = projection.practiceRuns.findIndex((row) => row.id === mutation.runId);
  if (runIndex < 0) throw new Error(`legacy sync run ${mutation.runId} does not exist`);
  if (!projection.questions.some((row) => row.id === mutation.questionId)) throw new Error(`legacy sync question ${mutation.questionId} does not exist`);
  const run = projection.practiceRuns[runIndex];
  if (!run.questionIds.includes(mutation.questionId)) throw new Error(`legacy sync run ${run.id} does not contain question ${mutation.questionId}`);
  const attempt = mutation.attempt as unknown as Attempt;
  if (attempt.runId !== run.id || attempt.questionId !== mutation.questionId) throw new Error("legacy sync updated answer attempt does not match run/question");
  replaceAttempt(projection, attempt, typeof mutation.reviewRoundId === "string" ? mutation.reviewRoundId : run.reviewRoundId);
  const answer = structuredClone(mutation.answer) as PracticeRun["answers"][string];
  const answers = { ...run.answers, [mutation.questionId]: answer };
  const submittedIndex = run.questionIds.reduce((last, questionId, index) => answers[questionId]?.submitted ? index : last, -1);
  projection.practiceRuns[runIndex] = {
    ...run,
    answers,
    updatedAt: answer.updatedAt && answer.updatedAt > run.updatedAt ? answer.updatedAt : run.updatedAt,
    revision: run.revision + 1,
    ...(submittedIndex >= 0 ? { lastAnsweredIndex: submittedIndex } : {}),
  };
  projection.tombstones = projection.tombstones.filter((row) => !(row.entityType === "practiceRun" && row.entityId === run.id));
}

function currentMutationChangeSet(
  change: LegacyChangeSetEnvelope,
  mutation: LegacyChangeSetEnvelope["mutations"][number],
): ChangeSet {
  return {
    formatVersion: 7,
    id: change.id,
    deviceId: change.deviceId,
    localSequence: change.localSequence,
    createdAt: change.createdAt,
    kind: mutation.kind as ChangeSet["kind"],
    mutations: [mutation as unknown as ChangeSetMutation],
    entityRefs: structuredClone(change.entityRefs),
    digest: change.digest,
  };
}

function replayLegacyChangeSet(projection: ChangeSetProjection, change: LegacyChangeSetEnvelope): ChangeSetProjection {
  let working = structuredClone(projection);
  for (const mutation of change.mutations) {
    if (mutation.kind === "attempt.update" || mutation.kind === "practice.answer.updated") applyRetiredMutation(working, mutation);
    else working = applyChangeSetToOwnedProjection(working, currentMutationChangeSet(change, mutation));
  }
  return finalizeRebasedProjection(working);
}

function legacyCheckpointFromProjection(
  projection: ChangeSetProjection,
  generatedAt: string,
  cursors: Record<string, number>,
): LegacySyncCheckpoint {
  return {
    formatVersion: 7,
    generatedAt,
    cursors: structuredClone(cursors),
    counts: {},
    state: {
      banks: structuredClone(projection.banks),
      bankFolders: structuredClone(projection.bankFolders),
      questions: structuredClone(projection.questions),
      memberships: structuredClone(projection.memberships),
      imageAssets: projection.imageAssets.map(({ blob: _blob, ...asset }) => structuredClone(asset)),
      attempts: structuredClone(projection.attempts),
      attemptStats: structuredClone(projection.attemptStats),
      attemptDailyStats: structuredClone(projection.attemptDailyStats),
      notes: structuredClone(projection.notes),
      practiceRuns: structuredClone(projection.practiceRuns) as LegacySyncCheckpoint["state"]["practiceRuns"],
      practiceRunStats: structuredClone(projection.practiceRunStats),
      questionGroups: structuredClone(projection.questionGroups),
      reviewRounds: structuredClone(projection.reviewRounds) as LegacySyncCheckpoint["state"]["reviewRounds"],
      reviewRoundProgress: structuredClone(projection.reviewRoundProgress),
      tombstones: structuredClone(projection.tombstones),
    },
  };
}

export async function hydrateLegacyRemoteSnapshot(source: LegacySyncRemoteSource): Promise<LegacyRemoteSnapshotResult> {
  const { head, headSha } = await source.readHead();
  assertHead(head);
  if (!SHA1.test(headSha)) throw new Error("legacy sync source head sha is invalid");
  if (!head.checkpoint) throw new Error("legacy sync remote has no checkpoint");

  const checkpointBytes = await readDescriptor(source, head.checkpoint, "checkpoint", LEGACY_CHECKPOINT_PREFIX);
  const remoteCheckpoint = parseRemoteCheckpoint(checkpointBytes);
  const history = await hydrateHistory(source, remoteCheckpoint);
  const fullAttempts = mergeById(history.attempts, remoteCheckpoint.state.attempts as unknown as Attempt[], remoteCheckpoint.counts.totalAttempts, "attempts");
  const fullRuns = mergeById(history.runs, remoteCheckpoint.state.practiceRuns as unknown as PracticeRun[], remoteCheckpoint.counts.totalPracticeRuns, "practice runs");
  const fullLegacy: LegacySyncCheckpoint = {
    formatVersion: 7,
    generatedAt: remoteCheckpoint.generatedAt,
    cursors: structuredClone(remoteCheckpoint.cursors),
    counts: structuredClone(remoteCheckpoint.counts),
    retention: remoteCheckpoint.retention ? structuredClone(remoteCheckpoint.retention) : undefined,
    state: {
      ...structuredClone(remoteCheckpoint.state),
      attempts: fullAttempts,
      practiceRuns: fullRuns as LegacySyncCheckpoint["state"]["practiceRuns"],
    },
  };

  let projection = finalizeRebasedProjection(projectionFromLegacyCheckpoint(fullLegacy));
  let hotChangeSets = 0;
  for (const descriptor of head.segments) {
    const segmentBytes = await readDescriptor(source, descriptor, `segment ${descriptor.generation}:${descriptor.ordinal}`, LEGACY_SEGMENT_PREFIX);
    const events = parseSegment(segmentBytes, descriptor, head.vaultId);
    for (const event of events) {
      const change = await parseLegacyChangeSet(await hydrateSegmentEvent(source, event));
      projection = replayLegacyChangeSet(projection, change);
      hotChangeSets += 1;
    }
  }

  const target = convertLegacySyncCheckpoint(legacyCheckpointFromProjection(projection, head.generatedAt, head.cursors));
  validateSyncCheckpoint(target);
  return {
    checkpoint: target,
    sourceHeadSha: headSha,
    archivedAttempts: history.attempts.length,
    archivedPracticeRuns: history.runs.length,
    hotChangeSets,
  };
}
