import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const localStorageValues = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => localStorageValues.get(key) ?? null,
    setItem: (key: string, value: string) => localStorageValues.set(key, value),
    removeItem: (key: string) => localStorageValues.delete(key),
  },
});

const {
  createSyncCheckpoint,
  db,
  resetLocalDatabase,
} = await import("../lib/db");
const { addAttemptToDailyStats, attemptDailyKey, buildAttemptStats } = await import("../lib/practice-metrics");
const {
  initializeGitHubVaultV4,
  restoreFromGitHubV4,
  restoreFullHistoryFromGitHubV4,
  syncWithGitHubV4,
} = await import("../lib/github-sync-v4");
import {
  SYNC_V4_ARCHIVE_CATALOG_PREFIX,
  SYNC_V4_CHECKPOINT_PREFIX,
  SYNC_V4_EVENT_PREFIX,
} from "../lib/sync-v4-head";
import {
  appendSyncArchiveSegmentsV4,
  createSyncArchiveCatalogV4,
  createSyncArchiveSegmentV4,
  SYNC_V4_ARCHIVE_PREFIX,
} from "../lib/sync-v4-catalog";
import type {
  Attempt,
  Bank,
  PracticeRun,
  Question,
  SyncArchiveSegmentV4,
  SyncCheckpointV3,
  SyncEvent,
  SyncEventPageDescriptorV4,
  SyncHeadDescriptorV4,
  SyncHeadV4,
} from "../lib/types";

const settings = { owner: "v4-integration-owner", repo: "v4-integration-repo", branch: "main" };
const token = "v4-integration-token";
const bank: Bank = {
  id: "v4-bank",
  name: "送电线路工-初级工",
  questionCount: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
};
const question: Question = {
  id: "v4-question",
  bankId: bank.id,
  bankName: bank.name,
  stem: "v4 集成测试题",
  normalizedStem: "v4集成测试题",
  answer: "A",
  options: ["甲", "乙"],
  type: "单选",
  tags: [],
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
const encodeBase64 = (value: Uint8Array) => Buffer.from(value).toString("base64");
const decodeBase64 = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const jsonBytes = (value: unknown) => textEncoder.encode(JSON.stringify(value));

function event(id: string, sequence: number, deviceId = "v4-device", synced: 0 | 1 = 0): SyncEvent {
  const createdAt = new Date(Date.UTC(2026, 7, 9, 0, 0, sequence % 60)).toISOString();
  return {
    id,
    type: "note.upserted",
    payload: { questionId: question.id, content: id, revision: sequence, updatedAt: createdAt, deviceId },
    deviceId,
    sequence,
    createdAt,
    synced,
  };
}

function attempt(id: string, index: number): Attempt {
  return {
    id,
    runId: `v4-run-${id}`,
    questionId: question.id,
    bankId: bank.id,
    selected: index % 2 ? "B" : "A",
    correct: index % 2 === 0,
    elapsedMs: index + 1,
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, index % 60, Math.floor(index / 60))).toISOString(),
    deviceId: "archive-device",
  };
}

function practiceRun(id: string, index: number): PracticeRun {
  const updatedAt = new Date(Date.UTC(2024, 0, 1, 0, index % 60, Math.floor(index / 60))).toISOString();
  return {
    id,
    bankId: bank.id,
    bankIds: [bank.id],
    bankName: bank.name,
    mode: "random30",
    modeLabel: "随机练习",
    questionIds: [question.id],
    questionTypes: { [question.id]: "单选" },
    answers: { [question.id]: { selected: ["A"], submitted: true, correct: true } },
    shuffleOptions: false,
    optionOrders: {},
    startedAt: updatedAt,
    updatedAt,
    completedAt: updatedAt,
    status: "completed",
    revision: 1,
  };
}

interface StoredFile {
  bytes: Uint8Array;
  sha: string;
}

interface HeadConflict {
  status: 409 | 422;
  mutate?: () => void | Promise<void>;
}

/**
 * A small Contents/blob API double. It intentionally exposes only the v4
 * endpoints, so a test cannot accidentally pass by using the old tree API.
 */
class V4RemoteDouble {
  readonly files = new Map<string, StoredFile>();
  readonly blobPaths = new Map<string, string>();
  readonly requests: Array<{ method: string; path: string; headers: Headers }> = [];
  readonly rawReads: string[] = [];
  readonly headGetStatuses: number[] = [];
  readonly headPutStatuses: number[] = [];
  readonly immutablePutPaths: string[] = [];
  readonly immutableGetPaths: string[] = [];
  private counter = 0;
  private headEtag = '"head-0"';
  private conflicts: HeadConflict[] = [];
  private missingBlobs = new Set<string>();
  private headBytes?: Uint8Array;
  private headSha?: string;
  afterImmutablePut?: (path: string) => void | Promise<void>;

  private newSha() {
    this.counter += 1;
    return this.counter.toString(16).padStart(40, "0");
  }

  private response(value: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
  }

  private pathFromContents(pathname: string) {
    const marker = "/contents/";
    const offset = pathname.indexOf(marker);
    if (offset < 0) return undefined;
    return pathname.slice(offset + marker.length).split("/").map((part) => decodeURIComponent(part)).join("/");
  }

  private putStored(path: string, bytes: Uint8Array, status = 201) {
    const sha = this.newSha();
    const stored = { bytes: bytes.slice(), sha };
    this.files.set(path, stored);
    this.blobPaths.set(sha, path);
    return { stored, status };
  }

  putText(path: string, value: string) {
    return this.putStored(path, textEncoder.encode(value));
  }

  putJson(path: string, value: unknown) {
    return this.putText(path, JSON.stringify(value));
  }

  queueHeadConflict(status: 409 | 422, mutate?: () => void | Promise<void>) {
    this.conflicts.push({ status, mutate });
  }

  hideBlobForNextRead(blobSha: string) {
    this.missingBlobs.add(blobSha);
  }

  head(): SyncHeadV4 | undefined {
    return this.headBytes ? JSON.parse(textDecoder.decode(this.headBytes)) as SyncHeadV4 : undefined;
  }

  setHead(head: SyncHeadV4) {
    const bytes = jsonBytes(head);
    const stored = this.putStored("sync/v4/head.json", bytes, 200);
    this.headBytes = stored.stored.bytes;
    this.headSha = stored.stored.sha;
    this.headEtag = `"head-${this.counter}"`;
    // `putStored` stores head in files for diagnostics, but head writes use
    // the special Contents response path below.
    this.files.delete("sync/v4/head.json");
    this.blobPaths.delete(stored.stored.sha);
  }

  clearHead() {
    this.headBytes = undefined;
    this.headSha = undefined;
    this.files.delete("sync/v4/head.json");
  }

  install() {
    globalThis.fetch = this.fetch.bind(this) as typeof fetch;
  }

  resetLogs() {
    this.requests.length = 0;
    this.rawReads.length = 0;
    this.headGetStatuses.length = 0;
    this.headPutStatuses.length = 0;
    this.immutablePutPaths.length = 0;
    this.immutableGetPaths.length = 0;
  }

  async fetch(input: RequestInfo | URL, init: RequestInit = {}) {
    const url = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    this.requests.push({ method, path: url.pathname, headers });

    if (url.pathname.endsWith("/contents/sync/v4/head.json")) {
      if (method === "GET") {
        if (!this.headBytes || !this.headSha) {
          this.headGetStatuses.push(404);
          return new Response("missing", { status: 404 });
        }
        if (headers.get("If-None-Match") === this.headEtag) {
          this.headGetStatuses.push(304);
          return new Response(null, { status: 304, headers: { ETag: this.headEtag } });
        }
        this.headGetStatuses.push(200);
        return this.response({ type: "file", encoding: "base64", content: encodeBase64(this.headBytes), sha: this.headSha }, 200, { ETag: this.headEtag });
      }
      if (method === "PUT") {
        const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
        const conflict = this.conflicts.shift();
        if (conflict) {
          await conflict.mutate?.();
          this.headPutStatuses.push(conflict.status);
          return new Response("head CAS conflict", { status: conflict.status });
        }
        if (!body.sha && this.headSha) {
          this.headPutStatuses.push(422);
          return new Response("head already exists", { status: 422 });
        }
        if (body.sha && body.sha !== this.headSha) {
          this.headPutStatuses.push(409);
          return new Response("head CAS conflict", { status: 409 });
        }
        const bytes = decodeBase64(body.content);
        const stored = this.putStored("sync/v4/head.json", bytes, this.headSha ? 200 : 201);
        this.headBytes = stored.stored.bytes;
        this.headSha = stored.stored.sha;
        this.headEtag = `"head-${this.counter}"`;
        this.files.delete("sync/v4/head.json");
        this.blobPaths.delete(stored.stored.sha);
        this.headPutStatuses.push(stored.status);
        return this.response({ content: { path: "sync/v4/head.json", sha: stored.stored.sha } }, stored.status, { ETag: this.headEtag });
      }
    }

    const contentPath = this.pathFromContents(url.pathname);
    if (contentPath && method === "PUT") {
      this.immutablePutPaths.push(contentPath);
      if (this.files.has(contentPath)) return new Response("already exists", { status: 422 });
      const body = JSON.parse(String(init.body)) as { content: string };
      const stored = this.putStored(contentPath, decodeBase64(body.content));
      await this.afterImmutablePut?.(contentPath);
      return this.response({ content: { path: contentPath, sha: stored.stored.sha } }, stored.status);
    }
    if (contentPath && method === "GET") {
      this.immutableGetPaths.push(contentPath);
      const stored = this.files.get(contentPath);
      if (!stored) return new Response("missing", { status: 404 });
      return this.response({ type: "file", encoding: "base64", content: encodeBase64(stored.bytes), sha: stored.sha });
    }

    const blobMarker = "/git/blobs/";
    if (url.pathname.includes(blobMarker) && method === "GET") {
      const blobSha = decodeURIComponent(url.pathname.slice(url.pathname.lastIndexOf("/") + 1));
      const path = this.blobPaths.get(blobSha);
      this.rawReads.push(path ?? blobSha);
      if (!path || this.missingBlobs.delete(blobSha)) return new Response("missing", { status: 404 });
      const stored = this.files.get(path);
      if (!stored) return new Response("missing", { status: 404 });
      return new Response(stored.bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
    }
    throw new Error(`Unexpected ${method} ${url.pathname}`);
  }
}

async function descriptorForText(client: V4RemoteDouble, path: string, text: string): Promise<SyncHeadDescriptorV4> {
  const stored = client.putText(path, text).stored;
  return { path, blobSha: stored.sha, sha256: sha256(text), size: byteLength(text) };
}

async function eventPage(client: V4RemoteDouble, rows: SyncEvent[], deviceId = rows[0]?.deviceId ?? "remote-device"): Promise<SyncEventPageDescriptorV4> {
  const text = JSON.stringify({ formatVersion: 4, events: rows });
  const digest = sha256(text);
  const descriptor = await descriptorForText(client, `${SYNC_V4_EVENT_PREFIX}${digest}.json`, text);
  const deviceCursors: Record<string, number> = {};
  for (const row of rows) deviceCursors[row.deviceId] = Math.max(deviceCursors[row.deviceId] ?? 0, row.sequence);
  return { ...descriptor, count: rows.length, deviceCursors: { ...deviceCursors, ...(deviceCursors[deviceId] === undefined ? { [deviceId]: 0 } : {}) } };
}

async function archiveSegment<T extends { id: string }>(client: V4RemoteDouble, kind: "attempts" | "practice-runs", rows: T[], month = "2024-01"): Promise<SyncArchiveSegmentV4> {
  const text = JSON.stringify({ formatVersion: 4, kind, rows });
  const digest = sha256(text);
  const path = `${SYNC_V4_ARCHIVE_PREFIX}${kind}/${month}/${digest}.json`;
  const descriptor = await descriptorForText(client, path, text);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const timestamp = (row: T) => ("createdAt" in row ? String((row as T & { createdAt: string }).createdAt) : String((row as T & { updatedAt: string }).updatedAt));
  return createSyncArchiveSegmentV4(kind, {
    ...descriptor,
    month,
    count: rows.length,
    firstId: first.id,
    lastId: last.id,
    firstCreatedAt: timestamp(first),
    lastCreatedAt: timestamp(last),
  });
}

async function publishPackage(
  client: V4RemoteDouble,
  checkpoint: SyncCheckpointV3,
  options: { events?: SyncEvent[]; attemptSegments?: SyncArchiveSegmentV4[]; practiceRunSegments?: SyncArchiveSegmentV4[] } = {},
) {
  const checkpointText = JSON.stringify(checkpoint);
  const checkpointDescriptor = await descriptorForText(client, `${SYNC_V4_CHECKPOINT_PREFIX}${sha256(checkpointText)}.json`, checkpointText);
  const catalog = appendSyncArchiveSegmentsV4(createSyncArchiveCatalogV4(checkpoint.generatedAt), {
    attemptSegments: options.attemptSegments ?? [],
    practiceRunSegments: options.practiceRunSegments ?? [],
  });
  const catalogText = JSON.stringify(catalog);
  const catalogDescriptor = await descriptorForText(client, `${SYNC_V4_ARCHIVE_CATALOG_PREFIX}${sha256(catalogText)}.json`, catalogText);
  const pages = options.events?.length ? [await eventPage(client, options.events)] : [];
  const head: SyncHeadV4 = {
    formatVersion: 4,
    generatedAt: checkpoint.generatedAt,
    checkpoint: checkpointDescriptor,
    archiveCatalog: catalogDescriptor,
    eventPages: pages,
  };
  client.setHead(head);
  return { head, catalog };
}

async function seedMinimalLocal() {
  await resetLocalDatabase();
  await db.banks.put(bank);
  await db.questions.put(question);
  return createSyncCheckpoint();
}

async function seedArchiveLocal() {
  await resetLocalDatabase();
  await db.banks.put(bank);
  await db.questions.put(question);
  const attempts = Array.from({ length: 2_501 }, (_, index) => attempt(`v4-attempt-${String(index).padStart(4, "0")}`, index));
  const stats = buildAttemptStats(attempts);
  assert.ok(stats);
  await db.attempts.bulkPut(attempts);
  await db.attemptStats.put(stats);
  const daily = new Map<string, import("../lib/types").AttemptDailyStats>();
  for (const row of attempts) {
    const key = attemptDailyKey(row);
    daily.set(key, addAttemptToDailyStats(daily.get(key), row));
  }
  await db.attemptDailyStats.bulkPut([...daily.values()]);
  const runs = Array.from({ length: 601 }, (_, index) => practiceRun(`v4-run-${String(index).padStart(4, "0")}`, index));
  await db.practiceRuns.bulkPut(runs);
  await db.practiceRunStats.bulkPut([
    { bankId: "__all__", total: runs.length, completed: runs.length, inProgress: 0, abandoned: 0, latestUpdatedAt: runs.at(-1)!.updatedAt },
    { bankId: bank.id, total: runs.length, completed: runs.length, inProgress: 0, abandoned: 0, latestUpdatedAt: runs.at(-1)!.updatedAt },
  ]);
  const checkpoint = await createSyncCheckpoint();
  const recentAttemptIds = new Set(checkpoint.state.recentAttempts.map((row) => row.id));
  const recentRunIds = new Set(checkpoint.state.recentPracticeRuns.map((row) => row.id));
  const oldAttempts = attempts.filter((row) => !recentAttemptIds.has(row.id));
  const oldRuns = runs.filter((row) => !recentRunIds.has(row.id));
  return { checkpoint, attempts, runs, oldAttempts, oldRuns };
}

const remote = new V4RemoteDouble();
remote.install();

// The first initialization publishes one canonical, fixed head.json. A
// repeated initializer only observes that head and never replaces it.
await seedMinimalLocal();
remote.clearHead();
remote.resetLogs();
const initialized = await initializeGitHubVaultV4(settings, token);
assert.equal(initialized.initialized, true);
assert.equal(remote.headPutStatuses.length, 1);
assert.ok(remote.head());
assert.equal(remote.head()?.formatVersion, 4);
const initialHeadBytes = JSON.stringify(remote.head());
const repeated = await initializeGitHubVaultV4(settings, token);
assert.equal(repeated.initialized, false);
assert.equal(remote.headPutStatuses.length, 1, "re-initializing must not replace the fixed head");
assert.equal(JSON.stringify(remote.head()), initialHeadBytes);

// A no-op sync sends one conditional head GET and receives one 304. It does
// not fetch any immutable object and does not create a second head write.
await syncWithGitHubV4(settings, token);
remote.resetLogs();
const noChange = await syncWithGitHubV4(settings, token);
assert.equal(noChange.pushed, 0);
assert.equal(remote.headGetStatuses.length, 1);
assert.equal(remote.headGetStatuses[0], 304);
assert.equal(remote.rawReads.length, 0);
assert.equal(remote.headPutStatuses.length, 0);

async function prepareUploadCase() {
  const checkpoint = await seedMinimalLocal();
  remote.files.clear();
  remote.blobPaths.clear();
  remote.clearHead();
  await publishPackage(remote, checkpoint);
  remote.resetLogs();
}

// Uploading a local event first creates an immutable page and then CAS-publishes
// the new head. The event is marked synced only after the CAS succeeds.
await prepareUploadCase();
const localEvent = event("upload-event", 10);
await db.events.put(localEvent);
const uploaded = await syncWithGitHubV4(settings, token);
assert.equal(uploaded.pushed, 1);
assert.equal((await db.events.get(localEvent.id))?.synced, 1);
assert.equal(remote.immutablePutPaths.filter((path) => path.startsWith(SYNC_V4_EVENT_PREFIX)).length, 1);
assert.equal(remote.headPutStatuses.at(-1), 200);
assert.equal(remote.head()?.eventPages.length, 1);

async function runCasMergeCase(status: 409 | 422, eventId: string, sequence: number) {
  await prepareUploadCase();
  const pending = event(eventId, sequence);
  await db.events.put(pending);
  const concurrent = event(`${eventId}-remote`, sequence + 1, "other-device", 1);
  remote.queueHeadConflict(status, async () => {
    const latest = remote.head();
    assert.ok(latest);
    const page = await eventPage(remote, [concurrent]);
    remote.setHead({ ...latest!, eventPages: [...latest!.eventPages, page] });
  });
  const result = await syncWithGitHubV4(settings, token);
  assert.equal(result.pushed, 1);
  assert.equal((await db.events.get(eventId))?.synced, 1, `${status} CAS must not lose the local event`);
  assert.equal(remote.headPutStatuses.includes(status), true);
  const pages = remote.head()?.eventPages ?? [];
  assert.equal(pages.length, 2, `${status} CAS must retain both immutable pages`);
}

await runCasMergeCase(409, "cas-409-local", 20);
await runCasMergeCase(422, "cas-422-local", 30);

// An event inserted after page upload is outside the pending-at-start snapshot
// and must remain unsynced for the next run.
await prepareUploadCase();
const firstEvent = event("during-sync-first", 40);
const lateEvent = event("during-sync-late", 41);
await db.events.put(firstEvent);
let insertedLate = false;
remote.afterImmutablePut = async (path) => {
  if (!insertedLate && path.startsWith(SYNC_V4_EVENT_PREFIX)) {
    insertedLate = true;
    await db.events.put(lateEvent);
  }
};
const during = await syncWithGitHubV4(settings, token);
remote.afterImmutablePut = undefined;
assert.equal(during.pushed, 1);
assert.equal(during.remaining, 1);
assert.equal((await db.events.get(firstEvent.id))?.synced, 1);
assert.equal((await db.events.get(lateEvent.id))?.synced, 0);
const secondDuring = await syncWithGitHubV4(settings, token);
assert.equal(secondDuring.pushed, 1);
assert.equal((await db.events.get(lateEvent.id))?.synced, 1);

// Build a large remote package with two attempt and two practice-run archive
// segments. Quick restore reads only the checkpoint and hot pages.
const archiveSeed = await seedArchiveLocal();
remote.files.clear();
remote.blobPaths.clear();
remote.clearHead();
const attemptSegments = [
  await archiveSegment(remote, "attempts", archiveSeed.oldAttempts.slice(0, 500)),
  await archiveSegment(remote, "attempts", archiveSeed.oldAttempts.slice(500)),
];
const runSegments = [
  await archiveSegment(remote, "practice-runs", archiveSeed.oldRuns.slice(0, 500)),
  await archiveSegment(remote, "practice-runs", archiveSeed.oldRuns.slice(500)),
];
await publishPackage(remote, archiveSeed.checkpoint, { attemptSegments, practiceRunSegments: runSegments });
await resetLocalDatabase();
remote.resetLogs();
const quick = await restoreFromGitHubV4(settings, token);
assert.equal(quick.formatVersion, 4);
assert.equal(await db.attempts.count(), archiveSeed.checkpoint.state.recentAttempts.length);
assert.equal(await db.practiceRuns.count(), archiveSeed.checkpoint.state.recentPracticeRuns.length);
assert.equal(remote.rawReads.some((path) => path.startsWith(`${SYNC_V4_ARCHIVE_PREFIX}attempts/`) || path.startsWith(`${SYNC_V4_ARCHIVE_PREFIX}practice-runs/`)), false, "quick restore must not download archive segments");

// Full restore downloads every archive segment into staging, then atomically
// promotes checkpoint + stage. A missing segment leaves the pre-existing local
// database untouched; a retry restores all rows and archive rows are split by
// the catalog's segment boundaries.
await resetLocalDatabase();
await db.banks.put({ ...bank, id: "sentinel-before-full-restore" });
const missingSegment = attemptSegments[0];
remote.hideBlobForNextRead(missingSegment.blobSha);
await assert.rejects(() => restoreFullHistoryFromGitHubV4(settings, token));
assert.ok(await db.banks.get("sentinel-before-full-restore"), "failed full restore must preserve local data");
assert.equal(await db.syncRestoreAttempts.count(), 0, "failed archive download must clear staging rows");
assert.equal(await db.syncRestorePracticeRuns.count(), 0, "failed archive download must clear practice-run staging rows");

remote.resetLogs();
const full = await restoreFullHistoryFromGitHubV4(settings, token);
assert.equal(full.formatVersion, 4);
assert.equal(full.archivedAttempts, archiveSeed.oldAttempts.length);
assert.equal(full.archivedPracticeRuns, archiveSeed.oldRuns.length);
assert.equal(await db.attempts.count(), archiveSeed.attempts.length);
assert.equal(await db.practiceRuns.count(), archiveSeed.runs.length);
assert.equal(remote.rawReads.filter((path) => path.startsWith(`${SYNC_V4_ARCHIVE_PREFIX}attempts/`)).length, attemptSegments.length);
assert.equal(remote.rawReads.filter((path) => path.startsWith(`${SYNC_V4_ARCHIVE_PREFIX}practice-runs/`)).length, runSegments.length);

await db.delete();
console.log("sync v4 integration tests passed: fixed head, 304 no-op, upload/CAS merge, late events, quick restore and atomic segmented full restore");
