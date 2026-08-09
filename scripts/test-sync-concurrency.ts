import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
});

const {
  applySyncCheckpoint,
  applyRemoteEvents,
  createSyncCheckpoint,
  db,
  resetLocalDatabase,
  validateSyncCheckpoint,
} = await import("../lib/db");
const { syncWithGitHubLegacyV3: syncWithGitHub } = await import("../lib/github-sync");
type SyncCheckpointV3 = import("../lib/types").SyncCheckpointV3;
type SyncEvent = import("../lib/types").SyncEvent;

const settings = { owner: "test", repo: "vault", branch: "main" };
const bank = {
  id: "bank-1",
  name: "送电线路工-初级工",
  questionCount: 1,
  importedAt: "2026-01-01T00:00:00.000Z",
};
const question = {
  id: "question-1",
  bankId: bank.id,
  bankName: bank.name,
  stem: "测试题",
  normalizedStem: "测试题",
  answer: "A",
  options: ["甲", "乙"],
  type: "单选" as const,
  tags: [],
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const encoded = (value: string) => Buffer.from(value).toString("base64");
const decoded = (value: string) => Buffer.from(value, "base64").toString("utf8");
const byteLength = (value: string) => Buffer.byteLength(value, "utf8");

function asEvent(input: Omit<SyncEvent, "synced">): SyncEvent {
  return { ...input, synced: 1 };
}

function bankImportedEvent(id = "bank-seed", sequence = 1): SyncEvent {
  return asEvent({
    id,
    type: "bank.imported",
    payload: { bank, questions: [question] },
    deviceId: "remote-device",
    sequence,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

function noteEvent(id: string, sequence: number, content = "remote", createdAt?: string): SyncEvent {
  const timestamp = createdAt ?? new Date(Date.UTC(2026, 1, 1, 0, 0, sequence)).toISOString();
  return asEvent({
    id,
    type: "note.upserted",
    payload: {
      questionId: question.id,
      content,
      revision: sequence,
      updatedAt: timestamp,
      deviceId: "remote-device",
    },
    deviceId: "remote-device",
    sequence,
    createdAt: timestamp,
  });
}

function uploadNoteEvent(id: string, sequence: number, content: string): SyncEvent {
  const timestamp = new Date(Date.UTC(2026, 3, 1, 0, 0, sequence % 60)).toISOString();
  return {
    id,
    type: "note.upserted",
    payload: {
      questionId: question.id,
      content,
      revision: sequence,
      updatedAt: timestamp,
      deviceId: "upload-device",
    },
    deviceId: "upload-device",
    sequence,
    createdAt: timestamp,
    synced: 0,
  };
}

interface RemotePage {
  path: string;
  sha: string;
  content: string;
}

/**
 * Small GitHub API double. It models the endpoints used by github-sync.ts and
 * retains PUT pages so a failed response can be retried against the same
 * remote tree. No production network is used by this script.
 */
class GitHubDouble {
  readonly blobs = new Map<string, string>();
  readonly pages: RemotePage[] = [];
  readonly uploadedPages: SyncEvent[][] = [];
  readonly readSha: string[] = [];
  readonly requests: Array<{ method: string; url: string }> = [];
  readonly treeBodies: Array<Record<string, unknown>> = [];
  readonly commitBodies: Array<Record<string, unknown>> = [];
  private blobCounter = 0;
  private pageCounter = 0;
  private commitCounter = 0;
  private readonly manifestPath = "sync/manifest.json";
  private readonly checkpointPath = "sync/v3/checkpoints/current.json";
  private readonly catalogPath = "sync/v3/archive/catalog.json";
  private manifestSha = "manifest-sha";
  private checkpointSha = "checkpoint-sha";
  private catalogSha = "catalog-sha";
  private checkpointText = "";
  private manifestText = "";
  private catalogText = "";
  private readonly failReads = new Set<string>();
  private failNextPut = false;
  patchRefStatus: number | null = null;
  mutateRefBeforePatch = false;
  exposeUploadedPages = true;
  afterSuccessfulPut?: () => void | Promise<void>;

  configure(checkpoint: SyncCheckpointV3, pages: RemotePage[] = []) {
    validateSyncCheckpoint(checkpoint);
    this.checkpointText = JSON.stringify(checkpoint);
    this.checkpointSha = "checkpoint-sha";
    this.catalogText = JSON.stringify({
      formatVersion: 3,
      generatedAt: checkpoint.generatedAt,
      attemptSegments: [],
      practiceRunSegments: [],
      counts: { attempts: 0, practiceRuns: 0 },
    });
    this.catalogSha = "catalog-sha";
    this.manifestText = JSON.stringify({
      formatVersion: 3,
      generatedAt: checkpoint.generatedAt,
      checkpoint: { path: this.checkpointPath, sha256: sha256(this.checkpointText) },
      eventPrefix: "sync/v3/events/",
      archiveCatalog: { path: this.catalogPath, sha256: sha256(this.catalogText) },
    });
    this.blobs.set(this.manifestSha, this.manifestText);
    this.blobs.set(this.checkpointSha, this.checkpointText);
    this.blobs.set(this.catalogSha, this.catalogText);
    this.pages.splice(0, this.pages.length, ...pages);
    for (const page of pages) this.blobs.set(page.sha, page.content);
  }

  addReadFailure(sha: string) {
    this.failReads.add(sha);
  }

  failPutOnce() {
    this.failNextPut = true;
  }

  private tree() {
    const eventEntries = this.pages.map((page) => ({
      path: page.path,
      type: "blob",
      sha: page.sha,
      size: byteLength(page.content),
    }));
    return [
      { path: this.manifestPath, type: "blob", sha: this.manifestSha, size: byteLength(this.manifestText) },
      { path: this.checkpointPath, type: "blob", sha: this.checkpointSha, size: byteLength(this.checkpointText) },
      { path: this.catalogPath, type: "blob", sha: this.catalogSha, size: byteLength(this.catalogText) },
      ...(this.exposeUploadedPages ? eventEntries : []),
    ];
  }

  private response(value: unknown, status = 200) {
    return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
  }

  async fetch(input: RequestInfo | URL, init?: RequestInit) {
    const url = String(input);
    const method = init?.method ?? "GET";
    this.requests.push({ method, url });

    if (url.includes("/git/trees/main?recursive=1") || url.includes("/git/trees/base-tree?recursive=1")) {
      return this.response({ tree: this.tree(), truncated: false });
    }
    if (url.includes("/git/blobs/") && method === "GET") {
      const sha = decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
      this.readSha.push(sha);
      if (this.failReads.delete(sha)) return this.response({ message: "temporary download failure" }, 503);
      const content = this.blobs.get(sha);
      if (content === undefined) return this.response({ message: `unknown blob ${sha}` }, 404);
      return this.response({ content: encoded(content) });
    }
    if (url.includes("/contents/sync/v3/events/") && method === "GET") {
      const encodedPath = url.slice(url.indexOf("/contents/") + "/contents/".length).split("?")[0];
      const path = encodedPath.split("/").map(decodeURIComponent).join("/");
      const page = this.pages.find((candidate) => candidate.path === path);
      if (!page) return this.response({ message: "not found" }, 404);
      return this.response({ sha: page.sha, content: encoded(page.content) });
    }
    if (url.includes("/contents/sync/v3/events/") && method === "PUT") {
      const body = JSON.parse(String(init?.body)) as { content: string };
      const content = decoded(body.content);
      const events = JSON.parse(content) as SyncEvent[];
      const path = decodeURIComponent(url.slice(url.indexOf("/contents/") + "/contents/".length));
      if (this.pages.some((page) => page.path === path)) return this.response({ message: "sha wasn't supplied" }, 422);
      this.uploadedPages.push(events);
      const sha = `uploaded-page-${++this.pageCounter}`;
      this.pages.push({ path, sha, content });
      this.blobs.set(sha, content);
      await this.afterSuccessfulPut?.();
      if (this.failNextPut) {
        this.failNextPut = false;
        return this.response({ message: "temporary upload failure" }, 503);
      }
      return this.response({ content: { sha } });
    }
    if (url.endsWith("/git/ref/heads/main") && method === "GET") return this.response({ object: { sha: "head" } });
    if (url.includes("/git/commits/head") && method === "GET") return this.response({ tree: { sha: "base-tree" } });
    if (url.endsWith("/git/blobs") && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { content: string };
      const sha = `blob-${++this.blobCounter}`;
      this.blobs.set(sha, body.content);
      return this.response({ sha });
    }
    if (url.endsWith("/git/trees") && method === "POST") {
      this.treeBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return this.response({ sha: `tree-${++this.commitCounter}` });
    }
    if (url.endsWith("/git/commits") && method === "POST") {
      this.commitBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return this.response({ sha: `commit-${++this.commitCounter}` });
    }
    if (url.endsWith("/git/refs/heads/main") && method === "PATCH") {
      if (this.mutateRefBeforePatch) {
        // Simulate another device moving the branch after getHeadTree() took
        // its (headSha, treeSha) snapshot but before the conditional update.
        this.mutateRefBeforePatch = false;
        this.patchRefStatus = 422;
      }
      if (this.patchRefStatus) return this.response({ message: "stale ref" }, this.patchRefStatus);
      return this.response({ object: { sha: "new-commit" } });
    }
    throw new Error(`Unexpected ${method} ${url}`);
  }
}

function installFetch(server: GitHubDouble) {
  globalThis.fetch = server.fetch.bind(server) as typeof fetch;
}

async function seedCheckpoint() {
  await resetLocalDatabase();
  await applyRemoteEvents([bankImportedEvent()]);
  const checkpoint = await createSyncCheckpoint();
  validateSyncCheckpoint(checkpoint);
  return checkpoint;
}

function makePage(index: number, events: SyncEvent[]): RemotePage {
  const content = JSON.stringify(events);
  return { path: `sync/v3/events/remote-device/2026-02/${String(index).padStart(4, "0")}.json`, sha: `remote-page-${index}`, content };
}

async function testEventPageAndUploadBudget() {
  const checkpoint = await seedCheckpoint();
  const server = new GitHubDouble();
  server.configure(checkpoint);
  installFetch(server);
  await applySyncCheckpoint(checkpoint);

  // Large enough to require many pages. Every page must obey both limits,
  // and one foreground sync must stop before its 2 MiB upload budget.
  const payload = "x".repeat(700);
  const pending = Array.from({ length: 2_400 }, (_, index) => uploadNoteEvent(`upload-${index}`, index + 1, payload));
  await db.events.bulkPut(pending);
  const progress: Array<{ phase: string; percent: number }> = [];
  const result = await syncWithGitHub(settings, "token", (update) => progress.push(update));
  const uploadedBytes = server.uploadedPages.reduce((sum, page) => sum + byteLength(JSON.stringify(page)), 0);
  assert.ok(server.uploadedPages.length > 1, "upload must split events into pages");
  assert.ok(server.uploadedPages.every((page) => page.length <= 250), "event page count exceeded 250");
  assert.ok(server.uploadedPages.every((page) => byteLength(JSON.stringify(page)) <= 256 * 1024), "event page exceeded 256 KiB");
  assert.ok(uploadedBytes <= 2 * 1024 * 1024, `single sync uploaded ${uploadedBytes} bytes (> 2 MiB)`);
  assert.ok(result.remaining > 0, "large pending queue should be deferred after the upload budget");
  assert.equal(progress.at(-1)?.percent, 100, "foreground sync progress must finish at 100%");
  assert.ok(progress.some((update) => update.phase === "download"), "sync progress must report downloads");
  assert.ok(progress.some((update) => update.phase === "upload"), "sync progress must report uploads");
  assert.ok(progress.every((update, index) => index === 0 || update.percent >= progress[index - 1].percent), "sync progress must be monotonic");

  // A second run is the retry path. It uploads the remaining event IDs once;
  // already acknowledged local pages are not sent again.
  const firstIds = new Set(server.uploadedPages.flat().map((event) => event.id));
  const beforeSecond = server.uploadedPages.length;
  const retry = await syncWithGitHub(settings, "token");
  const secondPages = server.uploadedPages.slice(beforeSecond);
  assert.ok(retry.remaining === 0, "second bounded upload should drain the remaining queue");
  assert.ok(secondPages.length > 0, "retry should upload deferred pages");
  assert.equal(secondPages.flat().filter((event) => firstIds.has(event.id)).length, 0, "successful pages must not be uploaded twice");
  assert.equal(await db.events.where("synced").equals(0).count(), 0, "all acknowledged events must become synced");

  return { uploadedPages: beforeSecond, firstUploadedBytes: uploadedBytes, retryPages: secondPages.length };
}

async function testStrictPageBoundaries() {
  const checkpoint = await seedCheckpoint();
  const oversizedContent = "x".repeat(300 * 1024);

  // A single local event larger than the page budget must fail before PUT;
  // otherwise the 2 MiB aggregate cap could be bypassed by one huge page.
  await resetLocalDatabase();
  await applySyncCheckpoint(checkpoint);
  const oversizedLocal = uploadNoteEvent("oversized-local", 2, oversizedContent);
  await db.events.put(oversizedLocal);
  const uploadServer = new GitHubDouble();
  uploadServer.configure(checkpoint);
  installFetch(uploadServer);
  await assert.rejects(() => syncWithGitHub(settings, "token"), /超过 256 KiB/);
  assert.equal(uploadServer.uploadedPages.length, 0, "oversized local event must not be PUT");
  const localPending = await db.events.where("synced").equals(0).count();
  assert.equal(localPending, 1, "oversized local event must remain pending");

  // A malicious/incorrect remote page must be rejected using both the tree
  // size and the downloaded payload size, before checkpoint or event markers
  // are written and before any partial event is applied.
  await resetLocalDatabase();
  const oversizedRemote = makePage(9, [noteEvent("oversized-remote", 2, oversizedContent)]);
  const remoteServer = new GitHubDouble();
  remoteServer.configure(checkpoint, [oversizedRemote]);
  installFetch(remoteServer);
  await assert.rejects(() => syncWithGitHub(settings, "token"), /超过 256 KiB/);
  assert.equal(await db.events.count(), 0, "oversized remote page must not apply events");
  assert.equal(await db.syncFiles.count(), 0, "oversized remote page must not write markers");
  return {
    localPending,
    remoteReads: remoteServer.readSha.length,
    pageBytes: byteLength(oversizedRemote.content),
  };
}

async function testDownloadBudget() {
  const checkpoint = await seedCheckpoint();
  await resetLocalDatabase();
  const pages: RemotePage[] = [];
  // Keep each page below the 256 KiB event-page limit but make the complete
  // remote queue larger than the 4 MiB foreground download budget.
  for (let index = 0; index < 20; index += 1) {
    pages.push(makePage(index, [noteEvent(`download-${index}`, index + 1, "d".repeat(220_000))]));
  }
  const server = new GitHubDouble();
  server.configure(checkpoint, pages);
  installFetch(server);
  const result = await syncWithGitHub(settings, "token");
  const eventReads = server.readSha.filter((sha) => sha.startsWith("remote-page-")).length;
  assert.ok(eventReads < pages.length, "download must defer event files after 4 MiB");
  assert.ok(result.deferred > 0, "sync result must report deferred event files");
  assert.ok(eventReads >= 1, "download should still make progress under the budget");
  const declaredBytes = pages.slice(0, eventReads).reduce((sum, page) => sum + byteLength(page.content), 0);
  assert.ok(declaredBytes <= 4 * 1024 * 1024, `foreground download selected ${declaredBytes} bytes (> 4 MiB)`);
  return { eventReads, deferred: result.deferred, selectedBytes: declaredBytes };
}

async function testDownloadFailureRetryAndDuplicateEvents() {
  const checkpoint = await seedCheckpoint();
  await resetLocalDatabase();
  const duplicate = noteEvent("same-event", 2, "duplicate-safe");
  const pages = [makePage(1, [duplicate]), makePage(2, [duplicate])];
  const server = new GitHubDouble();
  server.configure(checkpoint, pages);
  server.addReadFailure(pages[0].sha);
  installFetch(server);

  await assert.rejects(() => syncWithGitHub(settings, "token"), /GitHub 503/);
  assert.equal(await db.events.count(), 0, "failed download must not commit a partial event");
  assert.equal(await db.syncFiles.count(), 0, "failed download must not mark remote files as applied");

  const first = await syncWithGitHub(settings, "token");
  assert.equal(first.deferred, 0, "small retry should download all pages");
  // The checkpoint marker is not an event; only one of the two duplicate IDs
  // may be present in the event table even though both files were downloaded.
  const sameEventRows = await db.events.where("id").equals("same-event").count();
  assert.equal(sameEventRows, 1, "repeated event download must be idempotent");

  const beforeReads = server.readSha.length;
  const second = await syncWithGitHub(settings, "token");
  assert.equal(second.pulled, 0, "a repeated sync with unchanged pages should pull nothing");
  assert.equal(await db.events.where("id").equals("same-event").count(), 1, "repeated sync must not duplicate events");
  assert.equal(server.readSha.length, beforeReads + 1, "unchanged pages should not be downloaded again (manifest is read once for the package)");
  assert.equal(server.requests.filter((request) => request.url.includes("/git/ref/heads/")).length, 0, "small event trees must skip the head-tree compaction probe");
  return { firstPulled: first.pulled, secondPulled: second.pulled, eventReads: server.readSha.length };
}

async function testPutFailureRetry() {
  const checkpoint = await seedCheckpoint();
  await resetLocalDatabase();
  await applySyncCheckpoint(checkpoint);
  const pending = [uploadNoteEvent("retry-1", 1, "retry-1"), uploadNoteEvent("retry-2", 2, "retry-2")];
  await db.events.bulkPut(pending);
  const server = new GitHubDouble();
  server.configure(checkpoint);
  server.failPutOnce();
  installFetch(server);

  // The simulated PUT committed a page remotely but returned 503. The local
  // events must stay unsynced so a later invocation can retry safely.
  await assert.rejects(() => syncWithGitHub(settings, "token"), /GitHub 503/);
  assert.equal(await db.events.where("synced").equals(0).count(), 2, "failed PUT must retain local pending events");

  const firstRemoteIds = server.uploadedPages.flat().map((event) => event.id);
  assert.deepEqual(firstRemoteIds.sort(), ["retry-1", "retry-2"], "failed PUT should have a complete idempotency candidate page");
  const retry = await syncWithGitHub(settings, "token");
  assert.equal(retry.remaining, 0, "retry should drain events after a transient PUT failure");
  assert.equal(await db.events.where("synced").equals(0).count(), 0);
  const allRemoteIds = server.uploadedPages.flat().map((event) => event.id);
  assert.ok(allRemoteIds.includes("retry-1") && allRemoteIds.includes("retry-2"));
  // The retry uses the same content-addressed path. GitHub returns 422 because
  // the first PUT already exists; matching content is verified and no second
  // physical page is created.
  assert.equal(server.pages.length, 1, "uncertain PUT retry must reuse the existing physical page");
  await applyRemoteEvents(server.uploadedPages.flat());
  assert.equal(await db.events.where("id").equals("retry-1").count(), 1);
  assert.equal(await db.events.where("id").equals("retry-2").count(), 1);
  return { attempts: server.requests.filter((request) => request.method === "PUT").length, physicalPages: server.pages.length };
}

async function testEventCreatedDuringSync() {
  const checkpoint = await seedCheckpoint();
  await resetLocalDatabase();
  await applySyncCheckpoint(checkpoint);
  await db.events.put(uploadNoteEvent("during-sync-first", 1, "first"));
  const server = new GitHubDouble();
  server.configure(checkpoint);
  let inserted = false;
  server.afterSuccessfulPut = async () => {
    if (inserted) return;
    inserted = true;
    await db.events.put(uploadNoteEvent("during-sync-late", 2, "late"));
  };
  installFetch(server);

  const result = await syncWithGitHub(settings, "token");
  const uploadedIds = server.uploadedPages.flat().map((event) => event.id);
  assert.equal(result.remaining, 0, "an event created before the next upload sweep should join the active sync");
  assert.ok(uploadedIds.includes("during-sync-first"));
  assert.ok(uploadedIds.includes("during-sync-late"), "an event created during upload must not be lost");
  return { pushed: result.pushed, pages: server.uploadedPages.length };
}

async function testGitRefConflictPreservesLocalData() {
  const checkpoint = await seedCheckpoint();
  await resetLocalDatabase();
  const pages = Array.from({ length: 10 }, (_, index) => makePage(index, [noteEvent(`conflict-${index}`, index + 2, `conflict-${index}`)]));
  const server = new GitHubDouble();
  server.configure(checkpoint, pages);
  server.mutateRefBeforePatch = true;
  installFetch(server);
  const before = await db.events.count();
  const result = await syncWithGitHub(settings, "token");
  assert.equal(result.compacted, false, "a stale Git ref must report compaction conflict");
  assert.ok(server.treeBodies.length >= 1, "compaction must create a tree from a head snapshot");
  assert.ok(server.commitBodies.length >= 1, "compaction must create a commit from a head snapshot");
  assert.equal(server.treeBodies.at(-1)?.base_tree, "base-tree", "tree base_tree must match the captured head tree");
  assert.deepEqual(server.commitBodies.at(-1)?.parents, ["head"], "commit parent must match the captured head commit");
  assert.equal(await db.events.count(), before + pages.length, "422 must not delete local applied events");
  assert.equal((await db.notes.get(question.id))?.content, "conflict-9", "conflict must not roll back downloaded data");
  assert.equal(await db.syncFiles.count(), pages.length + 3, "remote markers remain available for the next retry");
  return { compacted: result.compacted, localEvents: await db.events.count() };
}

const results = {
  pageAndUpload: await testEventPageAndUploadBudget(),
  strictBounds: await testStrictPageBoundaries(),
  download: await testDownloadBudget(),
  downloadRetry: await testDownloadFailureRetryAndDuplicateEvents(),
  putRetry: await testPutFailureRetry(),
  eventDuringSync: await testEventCreatedDuringSync(),
  refConflict: await testGitRefConflictPreservesLocalData(),
};

await db.delete();
console.log("sync concurrency tests passed", JSON.stringify(results));
