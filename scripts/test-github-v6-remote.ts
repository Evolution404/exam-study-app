import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import assertNode from "node:assert/strict";
import {
  GITHUB_V6_RAW_MEDIA_TYPE,
  GitHubV6Remote,
  SyncV6BlobIntegrityError,
} from "../lib/github-v6-remote";
import { SYNC_V6_ASSET_PREFIX, SYNC_V6_CHECKPOINT_PREFIX, SYNC_V6_EVENT_PREFIX } from "../lib/sync-v6-head";
import type { SyncHeadV6 } from "../lib/sync-v6-head";

if (!globalThis.crypto) Object.defineProperty(globalThis, "crypto", { value: webcrypto });

const encode = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const decode = (value: string) => new Uint8Array(Buffer.from(value, "base64"));
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha1 = (digit: string) => digit.repeat(40);
const sha256 = (digit: string) => digit.repeat(64);

const owner = "v6-owner";
const repo = "v6-repo";
const token = "token-must-never-appear-in-errors";
const branch = "main";
const generatedAt = "2026-08-11T00:00:00.000Z";
const checkpointPath = `${SYNC_V6_CHECKPOINT_PREFIX}${sha256("a")}.json`;
const head: SyncHeadV6 = {
  formatVersion: 6,
  generatedAt,
  checkpoint: { path: checkpointPath, blobSha: sha1("a"), sha256: sha256("a"), size: 1 },
  archiveCatalog: { path: `sync/v6/archive/catalogs/${sha256("b")}.json`, blobSha: sha1("b"), sha256: sha256("b"), size: 1 },
  eventPages: [],
};

interface Stored { bytes: Uint8Array; sha: string }
const calls: Array<{ method: string; path: string; headers: Headers; body?: string }> = [];
const files = new Map<string, Stored>();
const blobs = new Map<string, Uint8Array>();
let counter = 0;
let headSha: string | undefined;
let headEtag = '"head-1"';
let headBytes: Uint8Array | undefined;

function nextSha(): string {
  counter += 1;
  return counter.toString(16).padStart(40, "0");
}

function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json", ...headers } });
}

const fakeFetch: typeof fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  const method = String(init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  calls.push({ method, path: url.pathname, headers, ...(typeof init.body === "string" ? { body: init.body } : {}) });

  if (url.pathname.endsWith("/contents/sync/v6/head.json")) {
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
      return json({ content: { path: "sync/v6/head.json", sha: headSha } }, counter === 1 ? 201 : 200, { ETag: headEtag });
    }
  }

  const contentsMarker = `/repos/${owner}/${repo}/contents/`;
  if (url.pathname.startsWith(contentsMarker)) {
    const path = decodeURIComponent(url.pathname.slice(contentsMarker.length));
    if (method === "PUT") {
      const request = JSON.parse(String(init.body)) as Record<string, unknown>;
      const existing = files.get(path);
      if (existing) {
        // Large Contents responses can omit inline bytes and the SHA in the
        // 422 body; the client must perform a metadata-only GET then Blob GET.
        if (path.startsWith(SYNC_V6_ASSET_PREFIX)) return json({ message: "already exists" }, 422);
        return json({ existingSha: existing.sha }, 422);
      }
      const bytes = decode(String(request.content));
      const sha = nextSha();
      files.set(path, { bytes, sha });
      blobs.set(sha, bytes);
      return json({ content: { path, sha } }, 201);
    }
    if (method === "GET") {
      const existing = files.get(path);
      if (!existing) return new Response("missing", { status: 404 });
      if (path.startsWith(SYNC_V6_ASSET_PREFIX)) {
        return json({ type: "file", encoding: "none", content: "", size: existing.bytes.byteLength, sha: existing.sha });
      }
      return json({ type: "file", encoding: "base64", content: encode(existing.bytes), sha: existing.sha });
    }
  }

  const blobMarker = `/repos/${owner}/${repo}/git/blobs/`;
  if (url.pathname.startsWith(blobMarker) && method === "GET") {
    const sha = decodeURIComponent(url.pathname.slice(blobMarker.length));
    const bytes = blobs.get(sha);
    if (!bytes) return new Response("missing", { status: 404 });
    assertNode.equal(headers.get("Accept"), GITHUB_V6_RAW_MEDIA_TYPE);
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  return new Response("not found", { status: 404 });
};

const remote = new GitHubV6Remote({ owner, repo, branch, token, apiBaseUrl: "https://fake.github.test", fetch: fakeFetch, retryDelayMs: 0 });
const missing = await remote.readHead();
assert.equal(missing.status, "missing");
const created = await remote.putHead(head);
assert.equal(created.ok, true);
if (!created.ok) throw new Error("head creation unexpectedly conflicted");
assert.equal(created.status, 201);
const first = await remote.readHead();
assert.equal(first.status, "ok");
const unchanged = await remote.readHead(first.cache);
assert.equal(unchanged.status, "not-modified");
const conflict = await remote.putHead(head, sha1("f"));
assert.deepEqual(conflict.ok, false);
if (!conflict.ok) {
  assert.equal(conflict.status, 409);
  assert.equal(conflict.classification, "head-advanced");
}

const bytes = new TextEncoder().encode("v6 immutable page");
const pagePath = `${SYNC_V6_EVENT_PREFIX}${digest(bytes)}.json`;
const uploaded = await remote.putImmutable({ path: pagePath, bytes, kind: "eventPage", size: bytes.byteLength, sha256: digest(bytes) });
assert.equal(uploaded.created, true);
const beforeRetry = calls.length;
const idempotent = await remote.putImmutable({ path: pagePath, bytes, kind: "eventPage", size: bytes.byteLength, sha256: digest(bytes) });
assert.equal(idempotent.idempotent, true);
assert.equal(calls.slice(beforeRetry).filter((call) => call.path.includes("/git/blobs/")).length, 1, "idempotent read validates through Git blob API");
await assert.rejects(remote.putImmutable({ path: pagePath, bytes: new TextEncoder().encode("different"), kind: "eventPage" }), SyncV6BlobIntegrityError);

const loaded = await remote.readBlob(uploaded.blobSha, { size: bytes.byteLength, sha256: digest(bytes) });
assert.deepEqual([...loaded], [...bytes]);
await assert.rejects(remote.readBlob(uploaded.blobSha, { size: bytes.byteLength + 1, sha256: digest(bytes) }), SyncV6BlobIntegrityError);
await assert.rejects(remote.readBlob(uploaded.blobSha, { size: bytes.byteLength, sha256: sha256("f") }), SyncV6BlobIntegrityError);

// A >1 MiB asset exercises GitHub's `encoding: none` Contents metadata
// response. Idempotency still succeeds only after authenticated Blob GET.
const largeAsset = new Uint8Array(1_100_000);
largeAsset.fill(0x5a);
const largeAssetDigest = digest(largeAsset);
const largeAssetPath = `${SYNC_V6_ASSET_PREFIX}${largeAssetDigest}.webp`;
const firstAsset = await remote.putImmutable({ path: largeAssetPath, bytes: largeAsset, kind: "asset", size: largeAsset.byteLength, sha256: largeAssetDigest });
assert.equal(firstAsset.created, true);
const beforeLargeAssetRetry = calls.length;
const secondAsset = await remote.putImmutable({ path: largeAssetPath, bytes: largeAsset, kind: "asset", size: largeAsset.byteLength, sha256: largeAssetDigest });
assert.equal(secondAsset.idempotent, true);
const retryCallsForAsset = calls.slice(beforeLargeAssetRetry);
assert.equal(retryCallsForAsset.filter((call) => call.method === "GET" && call.path.includes("/git/blobs/")).length, 1);
assert.equal(retryCallsForAsset.filter((call) => call.method === "GET" && call.path.includes("/contents/")).length, 1);
assert.ok(retryCallsForAsset.every((call) => !/raw|download/i.test(call.path)), "asset reads must not use raw/download URLs");

const tokenErrorFetch: typeof fetch = async () => new Response(`server says ${token}`, { status: 500 });
const tokenRemote = new GitHubV6Remote({ owner, repo, token, apiBaseUrl: "https://fake.github.test", fetch: tokenErrorFetch, retryDelayMs: 0 });
await assert.rejects(tokenRemote.readHead(), (error: unknown) => {
  assert.ok(error instanceof Error);
  return !error.message.includes(token);
});
assert.ok(calls.every((call) => call.headers.get("Authorization") === `Bearer ${token}`));

console.log("github v6 remote tests passed: ETag/304, CAS classification, immutable idempotency, authenticated blob integrity and token-safe errors");
