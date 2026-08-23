import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import {
  GITHUB_V7_RAW_MEDIA_TYPE,
  GitHubV7Remote,
  githubVaultIdentitiesEqual,
  SyncV7BlobIntegrityError,
  SyncV7ImmutableConflictError,
} from "../../src/lib/sync/github-v7-remote";
import {
  SYNC_V7_ASSET_PREFIX,
  SYNC_V7_CHECKPOINT_PREFIX,
  SYNC_V7_OBJECT_PREFIX,
  SYNC_V7_SEGMENT_PREFIX,
} from "../../src/lib/sync/sync-v7-head";
import type { SyncHeadV7 } from "../../src/lib/sync/sync-v7-head";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64");
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sha1 = (digit: string) => digit.repeat(40);
const bytes = (value: string) => new TextEncoder().encode(value);

assert.equal(githubVaultIdentitiesEqual("Evolution404/Exam-Study-Vault@main", "evolution404/exam-study-vault@main"), true);
assert.equal(githubVaultIdentitiesEqual("Evolution404/exam-study-vault@Main", "evolution404/exam-study-vault@main"), false, "Git branch identity remains case-sensitive");
assert.equal(githubVaultIdentitiesEqual("vault:one", "vault:ONE"), false, "opaque non-GitHub vault identities remain exact");

const owner = "v7-owner";
const repo = "v7-repo";
const vaultId = "vault:remote-v7";
const branch = "main";
const token = "token-must-not-leak";
const generatedAt = "2026-08-13T00:00:00.000Z";
const checkpointBytes = bytes("checkpoint bytes");
const checkpointPath = `${SYNC_V7_CHECKPOINT_PREFIX}${digest(checkpointBytes)}.json`;
const head: SyncHeadV7 = {
  formatVersion: 9,
  vaultId,
  generatedAt,
  generation: 0,
  metadata: { vaultId, deviceId: "device-a" },
  checkpoint: { path: checkpointPath, blobSha: sha1("a"), sha256: digest(checkpointBytes), size: checkpointBytes.byteLength },
  segments: [],
  cursors: {},
};

interface Stored { bytes: Uint8Array; sha: string }
const calls: Array<{ method: string; path: string; headers: Headers; body?: string }> = [];
const files = new Map<string, Stored>();
const blobs = new Map<string, Uint8Array>();
let counter = 0;
let headSha: string | undefined;
let headBytes: Uint8Array | undefined;
let headEtag = '"head-1"';
function nextSha(): string { counter += 1; return counter.toString(16).padStart(40, "0"); }
function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } }); }

const fakeFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  calls.push({ method, path: url.pathname, headers, ...(typeof init.body === "string" ? { body: init.body } : {}) });
  const headPath = `/repos/${owner}/${repo}/contents/sync/v9/head.json`;
  if (url.pathname === headPath) {
    if (method === "GET") {
      if (!headBytes || !headSha) return new Response("missing", { status: 404 });
      if (headers.get("If-None-Match") === headEtag) return new Response(null, { status: 304, headers: { ETag: headEtag } });
      return json({ type: "file", encoding: "base64", content: encode(headBytes), sha: headSha }, 200, { ETag: headEtag });
    }
    if (method === "PUT") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (request.sha !== undefined && request.sha !== headSha) return new Response("changed", { status: 409 });
      if (request.sha === undefined && headSha) return new Response("already exists", { status: 422 });
      headBytes = decode(String(request.content));
      headSha = nextSha();
      headEtag = `"head-${counter + 1}"`;
      return json({ content: { path: "sync/v9/head.json", sha: headSha } }, counter === 1 ? 201 : 200, { ETag: headEtag });
    }
  }
  const contentsMarker = `/repos/${owner}/${repo}/contents/`;
  if (url.pathname.startsWith(contentsMarker)) {
    const path = decodeURIComponent(url.pathname.slice(contentsMarker.length));
    if (method === "PUT") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      const existing = files.get(path);
      if (existing) return json({ message: "already exists" }, 422);
      const stored = decode(String(request.content));
      const sha = nextSha();
      files.set(path, { bytes: stored, sha });
      blobs.set(sha, stored);
      return json({ content: { path, sha } }, 201);
    }
    if (method === "GET") {
      const existing = files.get(path);
      if (!existing) return new Response("missing", { status: 404 });
      return json({ type: "file", encoding: "base64", content: encode(existing.bytes), sha: existing.sha });
    }
  }
  const blobMarker = `/repos/${owner}/${repo}/git/blobs/`;
  if (url.pathname.startsWith(blobMarker) && method === "GET") {
    const sha = decodeURIComponent(url.pathname.slice(blobMarker.length));
    const stored = blobs.get(sha);
    if (!stored) return new Response("missing", { status: 404 });
    assert.equal(headers.get("Accept"), GITHUB_V7_RAW_MEDIA_TYPE);
    return new Response(stored, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  return new Response("not found", { status: 404 });
};

const remote = new GitHubV7Remote({ owner, repo, branch, token, vaultId, apiBaseUrl: "https://fake.github.test", fetch: fakeFetch, retryDelayMs: 0 });
assert.equal((await remote.readHead()).status, "missing");
const created = await remote.putHead(head);
assert.equal(created.ok, true);
if (!created.ok) throw new Error("head creation unexpectedly conflicted");
assert.equal(created.status, 201);
const found = await remote.readHead();
assert.equal(found.status, "ok");
const unchanged = await remote.readHead(found.cache);
assert.equal(unchanged.status, "not-modified");
const conflict = await remote.putHead(head, sha1("f"));
assert.equal(conflict.ok, false);
if (!conflict.ok) assert.deepEqual([conflict.status, conflict.classification], [409, "head-advanced"]);

const segmentBytes = bytes("v7 segment payload");
const segmentPath = `${SYNC_V7_SEGMENT_PREFIX}${digest(segmentBytes)}.json`;
const uploaded = await remote.putImmutable({ path: segmentPath, bytes: segmentBytes, kind: "segment", sha256: digest(segmentBytes), size: segmentBytes.byteLength });
assert.equal(uploaded.created, true);
assert.equal(typeof uploaded.storedSize, "number", "put 结果应携带实际存储字节 storedSize");
assert.ok(uploaded.storedSize > 0, "storedSize 应为正数");
const retry = await remote.putImmutable({ path: segmentPath, bytes: segmentBytes, kind: "segment", sha256: digest(segmentBytes), size: segmentBytes.byteLength });
assert.equal(retry.idempotent, true);
await assert.rejects(remote.putImmutable({ path: segmentPath, bytes: bytes("different"), kind: "segment" }), SyncV7BlobIntegrityError);
await assert.rejects(remote.putImmutable({ path: segmentPath, bytes: bytes("v7 segment payload"), kind: "segment", sha256: digest("different") }), SyncV7BlobIntegrityError);
const loaded = await remote.readBlob(uploaded.blobSha, { size: segmentBytes.byteLength, sha256: digest(segmentBytes), path: segmentPath });
assert.deepEqual([...loaded], [...segmentBytes]);
await assert.rejects(remote.readBlob(uploaded.blobSha, { size: segmentBytes.byteLength + 1, sha256: digest(segmentBytes), path: segmentPath }), SyncV7BlobIntegrityError);

// Streamed blob reads must expose intermediate wire-byte progress instead of
// jumping only after response.arrayBuffer() has consumed the entire payload.
const progressPayload = bytes("checkpoint-progress-is-streamed");
const progressPath = `${SYNC_V7_ASSET_PREFIX}${digest(progressPayload)}.bin`;
const progressReports: Array<[number, number]> = [];
const progressRemote = new GitHubV7Remote({
  owner, repo, branch, token, vaultId, apiBaseUrl: "https://progress.github.test", retryDelayMs: 0,
  fetch: async () => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(progressPayload.slice(0, 5));
      controller.enqueue(progressPayload.slice(5, 17));
      controller.enqueue(progressPayload.slice(17));
      controller.close();
    },
  }), { status: 200, headers: { "Content-Length": String(progressPayload.byteLength) } }),
});
const progressLoaded = await progressRemote.readBlob(sha1("e"), { size: progressPayload.byteLength, storedSize: progressPayload.byteLength, sha256: digest(progressPayload), path: progressPath }, { onProgress: (loadedBytes, totalBytes) => progressReports.push([loadedBytes, totalBytes]) });
assert.deepEqual([...progressLoaded], [...progressPayload]);
assert.deepEqual(progressReports.map(([loadedBytes]) => loadedBytes), [5, 17, progressPayload.byteLength], "流式读取应逐块报告已下载字节");
assert.ok(progressReports.every(([, totalBytes]) => totalBytes === progressPayload.byteLength), "流式进度应携带稳定总字节数");

const largeAsset = new Uint8Array(1_100_000); largeAsset.fill(0x5a);
const assetPath = `${SYNC_V7_ASSET_PREFIX}${digest(largeAsset)}.webp`;
const asset = await remote.putImmutable({ path: assetPath, bytes: largeAsset, kind: "asset", sha256: digest(largeAsset), size: largeAsset.byteLength });
assert.equal((await remote.putImmutable({ path: assetPath, bytes: largeAsset, kind: "asset" })).idempotent, true);
assert.deepEqual([...await remote.readAsset({ path: assetPath, blobSha: asset.blobSha, sha256: digest(largeAsset), size: largeAsset.byteLength })], [...largeAsset]);

const mismatchRemote = new GitHubV7Remote({ owner, repo, token, vaultId: "other-vault", apiBaseUrl: "https://fake.github.test", fetch: fakeFetch, retryDelayMs: 0 });
await assert.rejects(mismatchRemote.putHead(head), /vault identity/);
const tokenErrorRemote = new GitHubV7Remote({ owner, repo, token, vaultId, apiBaseUrl: "https://fake.github.test", fetch: async () => new Response(`server says ${token}`, { status: 500 }), retryDelayMs: 0 });
await assert.rejects(tokenErrorRemote.readHead(), (error: unknown) => error instanceof Error && !error.message.includes(token));
assert.ok(calls.every((call) => call.headers.get("Authorization") === `Bearer ${token}`));

// A conflicting immutable object is detected from authenticated blob bytes,
// never accepted merely because Contents returned 422.
const conflictingObjectPath = `${SYNC_V7_OBJECT_PREFIX}${digest("object")}.json`;
files.set(conflictingObjectPath, { bytes: bytes("bad"), sha: sha1("d") });
blobs.set(sha1("d"), bytes("bad"));
await assert.rejects(remote.putImmutable({ path: conflictingObjectPath, bytes: bytes("object"), kind: "object" }), (error: unknown) => error instanceof SyncV7ImmutableConflictError || error instanceof SyncV7BlobIntegrityError);

console.log("github v7 remote tests passed: explicit vault identity, ETag/CAS, immutable path/blob integrity, idempotency and token-safe errors");
