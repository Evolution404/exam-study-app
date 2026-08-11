import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import "fake-indexeddb/auto";
import { readFileSync } from "node:fs";
import {
  clearImageCacheV6,
  createQuestionV6,
  createPracticeRunV6,
  deletePracticeRunV6,
  dbV6,
  importQuestionBankV6,
  putImageAssetV6,
  recordPracticeAnswerV6,
  resetV6Database,
} from "../lib/db-v6";
import { createSyncCheckpointV6, applySyncCheckpointV6, encodeSyncCheckpointV6, parseSyncCheckpointV6 } from "../lib/sync-v6-checkpoint";
import { downloadImageAssetV6, restoreFullHistoryFromGitHubV6, syncWithGitHubV6 } from "../lib/github-sync-v6";
import type { SyncHeadV6 } from "../lib/sync-v6-head";
import { sha256Blob } from "../lib/image-assets";
import type { ImageAsset, V6Event } from "../lib/v6-types";
import type { GitHubSettings } from "../lib/types";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const owner = "integration-owner";
const repo = "integration-repo";
const branch = "main";
const settings: GitHubSettings = { owner, repo, branch };
const token = "integration-token";
const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

interface Stored { bytes: Uint8Array; sha: string }
const files = new Map<string, Stored>();
const blobs = new Map<string, Uint8Array>();
const calls: Array<{ method: string; path: string }> = [];
let shaCounter = 0;
let head: Stored | undefined;
let conflictNext = false;
let alwaysConflict = false;

function nextSha(): string {
  shaCounter += 1;
  return shaCounter.toString(16).padStart(40, "0");
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const fakeFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method ?? "GET").toUpperCase();
  calls.push({ method, path: url.pathname });
  const path = decodeURIComponent(url.pathname.split(`/repos/${owner}/${repo}/contents/`)[1] ?? "");
  if (url.pathname.endsWith("/contents/sync/v6/head.json")) {
    if (method === "GET") {
      if (!head) return new Response("missing", { status: 404 });
      return json({ type: "file", encoding: "base64", content: encode(head.bytes), sha: head.sha }, 200, { ETag: `"${head.sha}"` });
    }
    if (method === "PUT") {
      const request = JSON.parse(String(init.body)) as { content: string; sha?: string };
      if (alwaysConflict || conflictNext) {
        conflictNext = false;
        return new Response("changed", { status: 409 });
      }
      if (request.sha !== undefined && (!head || request.sha !== head.sha)) return new Response("changed", { status: 409 });
      if (request.sha === undefined && head) return new Response("exists", { status: 422 });
      const bytes = decode(request.content);
      const stored = { bytes, sha: nextSha() };
      head = stored;
      blobs.set(stored.sha, bytes);
      return json({ content: { path: "sync/v6/head.json", sha: stored.sha } }, 201, { ETag: `"${stored.sha}"` });
    }
  }
  const contentsPrefix = `/repos/${owner}/${repo}/contents/`;
  if (url.pathname.startsWith(contentsPrefix)) {
    if (method === "GET") {
      const existing = files.get(path);
      if (!existing) return new Response("missing", { status: 404 });
      return json({ type: "file", encoding: "base64", content: encode(existing.bytes), sha: existing.sha });
    }
    if (method === "PUT") {
      const request = JSON.parse(String(init.body)) as { content: string };
      const existing = files.get(path);
      if (existing) return json({ existingSha: existing.sha }, 422);
      const bytes = decode(request.content);
      const stored = { bytes, sha: nextSha() };
      files.set(path, stored);
      blobs.set(stored.sha, bytes);
      return json({ content: { path, sha: stored.sha } }, 201);
    }
  }
  const blobPrefix = `/repos/${owner}/${repo}/git/blobs/`;
  if (url.pathname.startsWith(blobPrefix) && method === "GET") {
    const bytes = blobs.get(decodeURIComponent(url.pathname.slice(blobPrefix.length)));
    return bytes ? new Response(bytes, { status: 200 }) : new Response("missing", { status: 404 });
  }
  return new Response("not found", { status: 404 });
};

const originalFetch = globalThis.fetch;
globalThis.fetch = fakeFetch;
try {
  await resetV6Database();
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const blob = new Blob([bytes as unknown as BlobPart], { type: "image/png" });
  const assetId = await sha256Blob(blob);
  const asset: ImageAsset = { id: assetId, mimeType: "image/png", size: blob.size, width: 1, height: 1, blob };
  await putImageAssetV6(asset);
  const bank = await importQuestionBankV6("integration.json", [{ q: "题目", type: "单选", a: ["甲", "乙"], ans: "A" }]);

  await syncWithGitHubV6(settings, token);
  const firstHeadPut = calls.findIndex((call) => call.method === "PUT" && call.path.endsWith("/head.json"));
  const firstAssetPut = calls.findIndex((call) => call.method === "PUT" && call.path.includes("/assets/"));
  const firstImmutablePut = calls.findIndex((call) => call.method === "PUT" && (call.path.includes("/checkpoints/") || call.path.includes("/archive/")));
  assert.ok(firstAssetPut >= 0 && firstImmutablePut > firstAssetPut && firstHeadPut > firstImmutablePut, "publish order must be assets -> immutable -> head");

  const question = (await dbV6.bankQuestionMemberships.where("bankId").equals(bank.id).first())!;
  const run = await createPracticeRunV6({ bankId: bank.id, questionIds: [question.questionId] });
  const result = await recordPracticeAnswerV6({ runId: run.id, questionId: question.questionId, selected: ["A"], correct: true });
  assert.equal(await dbV6.events.where("type").equals("practice.answer.submitted").count(), 1, "one answer emits one event");

  conflictNext = true;
  await syncWithGitHubV6(settings, token);
  assert.equal((await dbV6.events.get(result.event.id))?.synced, 1, "event is marked synced only after CAS success");

  // Runs are removable history cards; attempts and global learning stats must
  // survive that deletion and still form a valid sync checkpoint.
  assert.equal(await deletePracticeRunV6(run.id), true, "answered run can be removed");
  const checkpointAfterRunDeletion = await createSyncCheckpointV6();
  assert.ok(checkpointAfterRunDeletion.state.attempts.some((attempt) => attempt.runId === run.id), "attempt survives run deletion");
  assert.ok(!checkpointAfterRunDeletion.state.practiceRuns.some((item) => item.id === run.id), "deleted run is absent from checkpoint");
  encodeSyncCheckpointV6(checkpointAfterRunDeletion);

  // The original remote v5→v6 migration used a NUL separator in daily-stat
  // keys.  Reading that checkpoint must upgrade the key, and a local row
  // restored from it must never make the next ordinary sync fail validation.
  const daily = checkpointAfterRunDeletion.state.attemptDailyStats[0]!;
  const legacyDailyCheckpoint = structuredClone(checkpointAfterRunDeletion);
  legacyDailyCheckpoint.state.attemptDailyStats[0] = { ...daily, key: `${daily.date}\u0000${daily.questionId}` };
  const normalizedDailyCheckpoint = parseSyncCheckpointV6(JSON.stringify(legacyDailyCheckpoint));
  assert.equal(normalizedDailyCheckpoint.state.attemptDailyStats[0].key, `${daily.date}:${daily.questionId}`);
  await dbV6.attemptDailyStats.delete(daily.key);
  await dbV6.attemptDailyStats.bulkPut([
    { ...daily, key: `${daily.date}\u0000${daily.questionId}` },
    { ...daily, key: `${daily.date}:${daily.questionId}`, total: 2, correct: 2 },
  ]);
  const republishedDailyCheckpoint = await createSyncCheckpointV6();
  const republishedDaily = republishedDailyCheckpoint.state.attemptDailyStats.filter((row) => row.questionId === daily.questionId && row.date === daily.date);
  assert.equal(republishedDaily.length, 1, "legacy and canonical daily rows merge into one canonical row");
  assert.equal(republishedDaily[0].key, `${daily.date}:${daily.questionId}`);
  assert.equal(republishedDaily[0].total, daily.total + 2);

  await createQuestionV6(bank.id, { type: "单选", stem: "CAS failure", options: ["A", "B"], answer: "A" });
  alwaysConflict = true;
  await assert.rejects(() => syncWithGitHubV6(settings, token));
  assert.ok((await dbV6.events.where("synced").equals(0).count()) > 0, "CAS failure keeps pending events");
  alwaysConflict = false;

  // A large question projection is still covered by the immutable checkpoint;
  // its oversized domain event must not enter a hot page, but all pending ids
  // are acknowledged only after the checkpoint head CAS succeeds.
  const largeQuestion = await createQuestionV6(bank.id, { type: "单选", stem: "x".repeat(300_000), options: ["A", "B"], answer: "A" });
  const largeEvent = (await dbV6.events.toArray()).find((event) => event.type === "question.upserted" && (event.payload as { id?: string }).id === largeQuestion.id)!;
  alwaysConflict = true;
  await assert.rejects(() => syncWithGitHubV6(settings, token));
  assert.equal((await dbV6.events.get(largeEvent.id))?.synced, 0, "oversized event remains pending after CAS failure");
  alwaysConflict = false;
  await syncWithGitHubV6(settings, token);
  assert.equal((await dbV6.events.get(largeEvent.id))?.synced, 1, "checkpoint-covered oversized event is acknowledged after CAS");
  assert.equal(await dbV6.events.where("synced").equals(0).count(), 0, "successful checkpoint CAS drains all pending events");
  const publishedHead = JSON.parse(new TextDecoder().decode(head!.bytes)) as SyncHeadV6;
  const publishedPages = publishedHead.eventPages.map((page) => new TextDecoder().decode(files.get(page.path)?.bytes ?? new Uint8Array()));
  assert.ok(publishedPages.every((page) => !page.includes(largeEvent.id)), "oversized event is omitted from event pages");
  const publishedCheckpoint = JSON.parse(new TextDecoder().decode(files.get(publishedHead.checkpoint.path)!.bytes)) as { state: { questions: Array<{ id: string }> } };
  assert.ok(publishedCheckpoint.state.questions.some((question) => question.id === largeQuestion.id), "checkpoint contains oversized question projection");

  const checkpoint = await createSyncCheckpointV6();
  const beforeBanks = await dbV6.banks.count();
  const malformed: V6Event = { id: "bad-asset", type: "image.asset.saved", payload: { id: "bad" }, deviceId: "remote", sequence: 1, createdAt: checkpoint.generatedAt, synced: 1 };
  await assert.rejects(() => applySyncCheckpointV6(checkpoint, [malformed]));
  assert.equal(await dbV6.banks.count(), beforeBanks, "restore failure rolls back atomically");

  await clearImageCacheV6();
  assert.equal(await downloadImageAssetV6(settings, token, assetId).then((downloaded) => downloaded.size), blob.size, "lazy asset download validates and caches blob");

  // Full restore must consume a non-empty v6 archive catalog/segment, not
  // merely replay the hot checkpoint.  Add one content-addressed archived
  // attempt to the fake vault and point the mutable head at the new catalog.
  const currentAttempt = (await dbV6.attempts.toArray())[0]!;
  const archivedAttempt = { ...currentAttempt, id: "archived-attempt" };
  const segmentBytes = new TextEncoder().encode(JSON.stringify({ formatVersion: 6, kind: "attempts", rows: [archivedAttempt] }));
  const segmentSha = sha256(segmentBytes);
  const segmentPath = `sync/v6/archive/attempts/2026-08/${segmentSha}.json`;
  const segmentBlobSha = nextSha();
  files.set(segmentPath, { bytes: segmentBytes, sha: segmentBlobSha });
  blobs.set(segmentBlobSha, segmentBytes);
  const catalogValue = { formatVersion: 6, generatedAt: new Date().toISOString(), attemptSegments: [{ path: segmentPath, blobSha: segmentBlobSha, sha256: segmentSha, size: segmentBytes.byteLength, month: "2026-08", count: 1, firstId: archivedAttempt.id, lastId: archivedAttempt.id, firstCreatedAt: archivedAttempt.createdAt, lastCreatedAt: archivedAttempt.createdAt }], practiceRunSegments: [], counts: { attempts: 1, practiceRuns: 0 } };
  const catalogBytes = new TextEncoder().encode(JSON.stringify(catalogValue));
  const catalogSha = sha256(catalogBytes);
  const catalogPath = `sync/v6/archive/catalogs/${catalogSha}.json`;
  const catalogBlobSha = nextSha();
  files.set(catalogPath, { bytes: catalogBytes, sha: catalogBlobSha });
  blobs.set(catalogBlobSha, catalogBytes);
  const remoteHeadValue = JSON.parse(new TextDecoder().decode(head!.bytes)) as Record<string, unknown>;
  const nextHeadValue = { ...remoteHeadValue, archiveCatalog: { path: catalogPath, blobSha: catalogBlobSha, sha256: catalogSha, size: catalogBytes.byteLength } };
  const nextHeadBytes = new TextEncoder().encode(JSON.stringify(nextHeadValue));
  const nextHeadStored = { bytes: nextHeadBytes, sha: nextSha() };
  head = nextHeadStored;
  blobs.set(nextHeadStored.sha, nextHeadBytes);
  const full = await restoreFullHistoryFromGitHubV6(settings, token);
  assert.equal(full.archivedAttempts, 1, "full restore reads archive attempts");
  assert.ok(await dbV6.attempts.get(archivedAttempt.id));

  // A 6,000-question checkpoint is complete and remains a single immutable
  // object; no mutable head event tail is needed for the imported questions.
  await resetV6Database();
  const manyBank = { id: "many-bank", name: "many", questionCount: 6_000, sortOrder: 0, importedAt: "2026-08-11T00:00:00.000Z", updatedAt: "2026-08-11T00:00:00.000Z", deviceId: "device-many" };
  const manyQuestions = Array.from({ length: 6_000 }, (_, index) => ({ id: `many-${index}`, type: "单选" as const, content: [{ id: "stem", type: "text" as const, text: `题目 ${index}` }], options: [[{ id: "a", type: "text" as const, text: "甲" }], [{ id: "b", type: "text" as const, text: "乙" }]], answer: "A", tags: [], contentFingerprint: `fingerprint-${index}`, updatedAt: manyBank.updatedAt, deviceId: manyBank.deviceId }));
  await dbV6.banks.put(manyBank);
  await dbV6.questions.bulkPut(manyQuestions);
  await dbV6.bankQuestionMemberships.bulkPut(manyQuestions.map((question, index) => ({ key: `${manyBank.id}:${question.id}`, bankId: manyBank.id, questionId: question.id, sortOrder: index, addedAt: manyBank.importedAt, updatedAt: manyBank.updatedAt, deviceId: manyBank.deviceId })));
  const manyCheckpoint = await createSyncCheckpointV6();
  const manyBytes = encodeSyncCheckpointV6(manyCheckpoint);
  assert.equal(manyCheckpoint.state.questions.length, 6_000);
  assert.equal(manyCheckpoint.state.memberships.length, 6_000);
  assert.equal(manyCheckpoint.state.events?.length ?? 0, 0, "question import is checkpoint-covered instead of a 6,000-event head tail");
  assert.ok(manyBytes.byteLength <= 32 * 1024 * 1024, "6,000-question checkpoint stays below immutable descriptor limit");

  const publicFacade = readFileSync(new URL("../lib/github-sync.ts", import.meta.url), "utf8");
  assert.ok(publicFacade.includes("syncWithGitHubV6 as syncWithGitHub"));
  assert.ok(!publicFacade.includes("github-sync-v5"));
  console.log("sync v6 integration tests passed: asset ordering, CAS retry/failure, atomic rollback, lazy image cache, public v6 facade and one-answer event");
} finally {
  globalThis.fetch = originalFetch;
  await dbV6.delete();
}
