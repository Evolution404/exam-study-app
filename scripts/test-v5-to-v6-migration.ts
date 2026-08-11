import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  convertV5ToV6,
  type V5ToV6Input,
} from "../lib/v5-to-v6-converter";
import { runV5ToV6Migration, validateLegacyImageUrl } from "./migrate-cloud-v5-to-v6";
import { validateSyncHeadV6 } from "../lib/sync-v6-head";
import { createSyncArchiveCatalogV5 } from "../lib/sync-v5-catalog";
import type {
  Attempt,
  Bank,
  PracticeRun,
  Question,
  SyncCheckpointV5,
  SyncEvent,
  SyncHeadV5,
} from "../lib/types";

const generatedAt = "2026-08-11T00:00:00.000Z";
const json = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const gitBlobSha = (bytes: Uint8Array) => {
  const hash = createHash("sha1");
  hash.update(Buffer.from(`blob ${bytes.byteLength}\0`, "utf8"));
  hash.update(bytes);
  return hash.digest("hex");
};

const bank = (id: string): Bank => ({ id, name: `题库-${id}`, questionCount: 0, importedAt: generatedAt, deviceId: "device-a" });
const question = (id: string, bankId: string, stem: string, sortOrder: number, imageUrl?: string): Question => ({
  id, bankId, bankName: bankId, sortOrder, stem, normalizedStem: stem.trim(), answer: "A", options: ["正确", "错误"], type: "单选", tags: [id], ...(imageUrl ? { imageUrl } : {}),
});
const attempt = (id: string, questionId: string, bankId: string, createdAt: string, correct = true): Attempt => ({ id, runId: "run-1", questionId, bankId, selected: "A", correct, elapsedMs: 100, createdAt, deviceId: "device-a" });
const run = (questionIds: string[]): PracticeRun => ({
  id: "run-1", bankId: "bank-a", bankIds: ["bank-a"], bankName: "题库-bank-a", mode: "sequential", modeLabel: "顺序", questionIds, questionTypes: Object.fromEntries(questionIds.map((id) => [id, "单选"])), answers: Object.fromEntries(questionIds.map((id, index) => [id, { selected: [index ? "B" : "A"], submitted: true, correct: index === 0, updatedAt: `${generatedAt.slice(0, -5)}${String(index).padStart(2, "0")}.000Z`, deviceId: "device-a" }])), shuffleOptions: false, optionOrders: {}, startedAt: generatedAt, updatedAt: generatedAt, status: "in_progress", revision: 1,
});

function checkpoint(questions: Question[], attempts: Attempt[] = [], runs: PracticeRun[] = []): SyncCheckpointV5 {
  return {
    formatVersion: 5,
    generatedAt,
    state: {
      banks: [bank("bank-a"), bank("bank-b")], bankFolders: [], questions,
      attemptStats: questions.map((item, index) => ({ questionId: item.id, bankId: item.bankId, total: 1, correct: index % 2 ? 0 : 1, wrong: index % 2 ? 1 : 0, giveUps: 0, totalElapsedMs: 100, firstAttemptAt: generatedAt, firstAttemptCorrect: index % 2 === 0, latestAttemptAt: generatedAt, hasBeenWrong: index % 2 === 1, correctStreakAfterWrong: 0, currentCorrectStreak: index % 2 === 0 ? 1 : 0, recentOutcomes: [{ id: `outcome-${item.id}`, createdAt: generatedAt, correct: index % 2 === 0 }] })),
      recentAttemptDailyStats: [], recentAttempts: attempts, notes: [], recentPracticeRuns: runs, practiceRunStats: [], questionGroups: [], tombstones: [],
    },
    cursors: { "device-a": 1 },
    retention: { recentAttemptLimit: 2_000, recentPracticeRunLimit: 100, dailyStatsDays: 35, oldestRecentAttemptAt: attempts[0]?.createdAt ?? null },
    counts: { banks: 2, bankFolders: 0, questions: questions.length, totalAttempts: questions.length, recentAttempts: attempts.length, notes: 0, totalPracticeRuns: runs.length, recentPracticeRuns: runs.length, questionGroups: 0, tombstones: 0 },
  };
}

// Exact content duplicates merge while merely similar text remains separate.
const duplicateInput: V5ToV6Input = {
  checkpoint: checkpoint([question("q-a", "bank-a", "  同一道题  ", 0), question("q-b", "bank-b", "同一道题", 0), question("q-c", "bank-a", "同一道题（相似但不同）", 1)], [attempt("a-a", "q-a", "bank-a", generatedAt), attempt("a-b", "q-b", "bank-b", "2026-08-11T00:00:01.000Z", false)], [run(["q-a", "q-b", "q-a"])]),
  archiveAttempts: [],
  archivePracticeRuns: [],
};
const duplicateConversion = convertV5ToV6(duplicateInput);
assert.equal(duplicateConversion.report.sourceQuestions, 3);
assert.equal(duplicateConversion.report.uniqueQuestions, 2, "exact fingerprint duplicate should merge");
assert.equal(duplicateConversion.report.memberships, 3, "bank ownership should become memberships");
assert.notEqual(duplicateConversion.oldQuestionIdToNewId["q-a"], duplicateConversion.oldQuestionIdToNewId["q-c"], "similar question must not merge");
assert.equal(duplicateConversion.checkpoint.state.attemptStats.find((stats) => stats.questionId === duplicateConversion.oldQuestionIdToNewId["q-a"])?.total, 2, "merged stats should add");
assert.equal(duplicateConversion.checkpoint.state.recentPracticeRuns[0]?.questionIds.length, 1, "duplicate run question should fold");
validateSyncHeadV6(duplicateConversion.head);
const duplicateHot = convertV5ToV6({
  ...duplicateInput,
  hotEvents: [{ id: "duplicate-attempt-event", type: "attempt.created", payload: attempt("a-a", "q-a", "bank-a", generatedAt), deviceId: "device-a", sequence: 2, createdAt: generatedAt, synced: 1 }],
});
assert.equal(duplicateHot.checkpoint.state.attemptStats.find((stats) => stats.questionId === duplicateHot.oldQuestionIdToNewId["q-a"])?.total, 2, "checkpoint + hot duplicate attempt must not double count");

const hotUpdated = question("q-a", "bank-a", "新版题干", 0);
hotUpdated.answer = "B";
const hotBank: Bank = { ...bank("bank-c"), name: "新增题库" };
const hotNewQuestion = question("q-new", "bank-c", "热事件新增", 0);
const hotEntityEvents: SyncEvent[] = [
  { id: "event-update", type: "question.updated", payload: hotUpdated, deviceId: "device-a", sequence: 2, createdAt: "2026-08-11T00:00:01.000Z", synced: 1 },
  { id: "event-bank", type: "bank.updated", payload: { ...bank("bank-a"), name: "重命名题库" }, deviceId: "device-a", sequence: 3, createdAt: "2026-08-11T00:00:02.000Z", synced: 1 },
  { id: "event-import", type: "bank.imported", payload: { bank: hotBank, questions: [hotNewQuestion] }, deviceId: "device-a", sequence: 4, createdAt: "2026-08-11T00:00:03.000Z", synced: 1 },
  { id: "event-delete-q", type: "question.deleted", payload: { id: "q-b" }, deviceId: "device-a", sequence: 5, createdAt: "2026-08-11T00:00:04.000Z", synced: 1 },
  { id: "event-delete-bank", type: "bank.deleted", payload: { id: "bank-b" }, deviceId: "device-a", sequence: 6, createdAt: "2026-08-11T00:00:05.000Z", synced: 1 },
];
const hotConversion = convertV5ToV6({ checkpoint: duplicateInput.checkpoint, hotEvents: hotEntityEvents });
assert.equal(hotConversion.checkpoint.state.banks.some((item) => item.id === "bank-b"), false, "hot bank delete must win");
assert.equal(hotConversion.checkpoint.state.banks.find((item) => item.id === "bank-a")?.name, "重命名题库");
assert.ok(hotConversion.checkpoint.state.questions.some((item) => item.answer === "B" && item.content.some((block) => block.type === "text" && block.text === "新版题干")), "hot question update must replace old content");
assert.ok(hotConversion.checkpoint.state.questions.some((item) => item.content.some((block) => block.type === "text" && block.text === "热事件新增")), "hot imported question must enter conversion");
assert.equal(hotConversion.checkpoint.state.questions.some((item) => item.id === hotConversion.oldQuestionIdToNewId["q-b"]), false, "hot question delete must not enter conversion");
assert.ok(hotConversion.checkpoint.state.memberships.every((item) => item.key === `${item.bankId}:${item.questionId}`));

// Six thousand questions still leave the mutable event tail under four MiB.
const manyQuestions = Array.from({ length: 6_000 }, (_, index) => question(`q-${index}`, "bank-a", `题目 ${index}`, index));
const many = convertV5ToV6({ checkpoint: checkpoint(manyQuestions) });
assert.ok(many.report.sixThousandQuestionHeadWithinHotWindow);
assert.ok(many.report.estimated6000QuestionBytes > 0);
assert.ok(many.head.eventPages.reduce((sum, page) => sum + page.size, 0) <= 4 * 1024 * 1024);
assert.ok(many.head.eventPages.every((page) => page.size <= 256 * 1024));

const dryRemote = makeFakeRemote();
const dry = await runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: dryRemote.fakeFetch, apiBaseUrl: "https://api.test" });
assert.equal(dry.dryRun, true);
assert.equal(dryRemote.puts.length, 0, "default dry-run must perform zero PUT requests");

assert.throws(() => validateLegacyImageUrl("file:///tmp/x"), /http/);
assert.throws(() => validateLegacyImageUrl("http://127.0.0.1/image.png"), /环回/);
assert.throws(() => validateLegacyImageUrl("https://example.com:8443/image.png"), /默认端口/);

interface FakeFile { bytes: Uint8Array; sha: string }
function makeFakeRemote(image: false | "gif" | "png" = false, deleteImage = false) {
  const files = new Map<string, FakeFile>();
  const puts: string[] = [];
  let imageGets = 0;
  let v6Exists = false;
  let changeV5OnNextRead = false;
  let v5HeadReads = 0;
  const bytesFor = (value: unknown) => json(value);
  const add = (path: string, value: unknown) => files.set(path, { bytes: bytesFor(value), sha: gitBlobSha(bytesFor(value)) });
  const imageUrl = image ? `https://example.com/image.${image === "png" ? "png" : "gif"}` : undefined;
  const checkpointValue = checkpoint([question("q-a", "bank-a", "迁移题", 0, imageUrl)]);
  const checkpointBytes = bytesFor(checkpointValue);
  const checkpointSha = digest(checkpointBytes);
  const catalogValue = createSyncArchiveCatalogV5(generatedAt);
  const catalogBytes = bytesFor(catalogValue);
  const catalogSha = digest(catalogBytes);
  add(`sync/v5/checkpoints/${checkpointSha}.json`, checkpointValue);
  add(`sync/v5/archive/catalogs/${catalogSha}.json`, catalogValue);
  const eventPages: SyncHeadV5["eventPages"] = [];
  if (deleteImage && imageUrl) {
    const eventPayload = { formatVersion: 5, events: [{ id: "delete-image", type: "question.deleted", payload: { id: "q-a" }, deviceId: "device-a", sequence: 2, createdAt: "2026-08-11T00:00:01.000Z", synced: 1 }] };
    const eventBytes = bytesFor(eventPayload);
    const eventSha = digest(eventBytes);
    const eventPath = `sync/v5/events/${eventSha}.json`;
    add(eventPath, eventPayload);
    eventPages.push({ path: eventPath, blobSha: gitBlobSha(eventBytes), sha256: eventSha, size: eventBytes.byteLength, count: 1, deviceCursors: { "device-a": 2 } });
  }
  const head: SyncHeadV5 = {
    formatVersion: 5,
    generatedAt,
    checkpoint: { path: `sync/v5/checkpoints/${checkpointSha}.json`, blobSha: gitBlobSha(checkpointBytes), sha256: checkpointSha, size: checkpointBytes.byteLength },
    archiveCatalog: { path: `sync/v5/archive/catalogs/${catalogSha}.json`, blobSha: gitBlobSha(catalogBytes), sha256: catalogSha, size: catalogBytes.byteLength },
    eventPages,
  };
  const headBytes = bytesFor(head);
  files.set("sync/v5/head.json", { bytes: headBytes, sha: gitBlobSha(headBytes) });
  const existingV6Head = {
    formatVersion: 6,
    generatedAt,
    checkpoint: { path: `sync/v6/checkpoints/${"d".repeat(64)}.json`, blobSha: "a".repeat(40), sha256: "d".repeat(64), size: 0 },
    archiveCatalog: { path: `sync/v6/archive/catalogs/${"e".repeat(64)}.json`, blobSha: "a".repeat(40), sha256: "e".repeat(64), size: 0 },
    eventPages: [],
  };
  const fakeFetch: typeof fetch = async (input, init = {}) => {
    const request = new URL(String(input));
    const method = String(init.method ?? "GET").toUpperCase();
    const marker = "/contents/";
    const contentIndex = request.pathname.indexOf(marker);
    const path = contentIndex >= 0 ? request.pathname.slice(contentIndex + marker.length).split("/").map((part) => decodeURIComponent(part)).join("/") : "";
    if (request.pathname.includes("/git/blobs/")) {
      const sha = decodeURIComponent(request.pathname.split("/git/blobs/")[1]);
      const file = [...files.values()].find((candidate) => candidate.sha === sha);
      return file ? new Response(file.bytes, { status: 200 }) : new Response("missing", { status: 404 });
    }
    if (path === "sync/v6/head.json" && method === "GET") {
      if (!v6Exists) return new Response("missing", { status: 404 });
      const file = files.get(path)!;
      return new Response(JSON.stringify({ content: Buffer.from(file.bytes).toString("base64"), encoding: "base64", sha: file.sha }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (path === "sync/v5/head.json" && method === "GET") {
      v5HeadReads += 1;
      if (changeV5OnNextRead && v5HeadReads > 1) {
        changeV5OnNextRead = false;
        const changed = { ...head, generatedAt: "2026-08-11T00:00:01.000Z" };
        const changedBytes = bytesFor(changed);
        return new Response(JSON.stringify({ content: Buffer.from(changedBytes).toString("base64"), encoding: "base64", sha: "b".repeat(40) }), { status: 200 });
      }
      const file = files.get(path)!;
      return new Response(JSON.stringify({ content: Buffer.from(file.bytes).toString("base64"), encoding: "base64", sha: file.sha }), { status: 200 });
    }
    if (method === "GET" && files.has(path)) {
      const file = files.get(path)!;
      return new Response(JSON.stringify({ content: Buffer.from(file.bytes).toString("base64"), encoding: "base64", sha: file.sha }), { status: 200 });
    }
    if (method === "PUT") {
      const body = JSON.parse(String(init.body ?? "{}")) as { content?: string };
      const bytes = Uint8Array.from(Buffer.from(body.content ?? "", "base64"));
      files.set(path, { bytes, sha: gitBlobSha(bytes) });
      puts.push(path);
      if (path === "sync/v6/head.json") v6Exists = true;
      return new Response(JSON.stringify({ content: { sha: gitBlobSha(bytes) } }), { status: path === "sync/v6/head.json" ? 201 : 201 });
    }
    if (request.hostname === "example.com") {
      imageGets += 1;
      const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0]);
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1]);
      const bytes = image === "png" ? png : gif;
      return new Response(bytes, { status: 200, headers: { "content-type": image === "png" ? "image/png" : "image/gif", "content-length": String(bytes.byteLength) } });
    }
    return new Response("missing", { status: 404 });
  };
  return { fakeFetch, puts, imageGets: () => imageGets, setChange: () => { changeV5OnNextRead = true; }, setV6: () => { v6Exists = true; files.set("sync/v6/head.json", { bytes: bytesFor(existingV6Head), sha: "a".repeat(40) }); } };
}

const applyRemote = makeFakeRemote();
const applied = await runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: applyRemote.fakeFetch, apiBaseUrl: "https://api.test", apply: true });
assert.equal(applied.applied, true);
assert.deepEqual(applyRemote.puts.at(-1), "sync/v6/head.json");
assert.ok(applyRemote.puts.indexOf("sync/v6/head.json") > applyRemote.puts.indexOf(applied.conversion.head.checkpoint.path));
assert.equal(applyRemote.puts.some((path) => path.startsWith("sync/v5/")), false, "migration never writes v5 paths");

const imageRemote = makeFakeRemote("gif");
await assert.rejects(() => runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: imageRemote.fakeFetch, apiBaseUrl: "https://api.test", apply: true }), /首个 PUT/);
assert.equal(imageRemote.imageGets(), 1, "final GIF image should be fetched before rejection");
assert.equal(imageRemote.puts.length, 0, "image preflight failure must happen before every PUT");

const pngRemote = makeFakeRemote("png");
const pngApplied = await runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: pngRemote.fakeFetch, apiBaseUrl: "https://api.test", apply: true });
assert.equal(pngRemote.imageGets(), 1, "final PNG image should be fetched");
assert.ok(pngRemote.puts[0]?.startsWith("sync/v6/assets/"), "asset PUT must precede checkpoint/catalog/head");
assert.ok(pngApplied.conversion.assets.length === 1);
const pngQuestion = pngApplied.conversion.checkpoint.state.questions.find((item) => item.content.some((block) => block.type === "image"));
const pngImageBlock = pngQuestion?.content.find((block): block is Extract<typeof block, { type: "image" }> => block.type === "image");
const pngDescriptor = pngApplied.conversion.checkpoint.state.imageAssets.find((asset) => asset.id === pngImageBlock?.assetId);
assert.ok(pngDescriptor && pngImageBlock, "every image block must have a descriptor");
assert.equal(pngDescriptor?.remote?.path, `sync/v6/assets/${pngDescriptor?.id}.png`);
assert.equal(pngDescriptor?.remote?.sha256, pngDescriptor?.id);
assert.equal(pngDescriptor?.remote?.size, pngDescriptor?.size);
assert.equal(pngDescriptor?.blob, undefined, "checkpoint image descriptor must not retain Blob bytes");

const deletedImageRemote = makeFakeRemote("gif", true);
const deletedImageDryRun = await runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: deletedImageRemote.fakeFetch, apiBaseUrl: "https://api.test" });
assert.equal(deletedImageDryRun.conversion.report.images, 0);
assert.equal(deletedImageRemote.imageGets(), 0, "deleted question image must not be fetched");

const changedRemote = makeFakeRemote();
changedRemote.setChange();
await assert.rejects(() => runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: changedRemote.fakeFetch, apiBaseUrl: "https://api.test", apply: true }), /v5 head/);
assert.equal(changedRemote.puts.some((path) => path === "sync/v6/head.json"), false, "v5 head change must prevent final head PUT");

const existingRemote = makeFakeRemote();
existingRemote.setV6();
await assert.rejects(() => runV5ToV6Migration({ owner: "owner", repo: "repo", token: "test-token", fetch: existingRemote.fakeFetch, apiBaseUrl: "https://api.test", apply: true }), /v6 head 已存在/);
assert.equal(existingRemote.puts.length, 0, "existing v6 head must refuse before writes");

console.log("v5→v6 migration tests passed: pure dedupe/remap, image SSRF/preflight, fake GET-only dry-run, publish ordering, CAS safety and v5 read-only");
