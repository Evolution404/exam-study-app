import assert from "node:assert/strict";
import {
  GITHUB_V5_RAW_MEDIA_TYPE,
  GitHubV5Remote,
  SyncV5BlobIntegrityError,
  SyncV5ImmutableConflictError,
} from "../lib/github-v5-remote";
import { SYNC_V5_ARCHIVE_CATALOG_PREFIX, SYNC_V5_CHECKPOINT_PREFIX, SYNC_V5_EVENT_PREFIX } from "../lib/sync-v5-head";
import type { SyncHeadV5 } from "../lib/types";

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function jsonFile(bytes: Uint8Array, sha: string, etag: string): Response {
  return new Response(JSON.stringify({ type: "file", encoding: "base64", content: encodeBase64(bytes), sha }), {
    status: 200,
    headers: { "Content-Type": "application/json", ETag: etag },
  });
}

const token = "test-token-never-logged";
const owner = "exam-owner";
const repo = "exam-repo";
const branch = "main";
const calls: Array<{ method: string; url: string; headers: Headers; body?: string }> = [];
let headBytes: Uint8Array | undefined;
let headSha: string | undefined;
let headEtag = '"head-1"';
const immutable = new Map<string, { bytes: Uint8Array; sha: string }>();
const blobs = new Map<string, Uint8Array>();
let generatedSha = 0;

const generatedAt = "2026-08-09T00:00:00.000Z";
const head: SyncHeadV5 = {
  formatVersion: 5,
  generatedAt,
  checkpoint: {
    path: `${SYNC_V5_CHECKPOINT_PREFIX}checkpoint.json`,
    blobSha: "a".repeat(40),
    sha256: "b".repeat(64),
    size: 1,
  },
  archiveCatalog: {
    path: `${SYNC_V5_ARCHIVE_CATALOG_PREFIX}${"c".repeat(64)}.json`,
    blobSha: "d".repeat(40),
    sha256: "e".repeat(64),
    size: 1,
  },
  eventPages: [],
};

function newSha(): string {
  generatedSha += 1;
  return generatedSha.toString(16).padStart(40, "0");
}

function parseRequestBody(init: RequestInit): Record<string, unknown> {
  assert.equal(typeof init.body, "string");
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

const fakeFetch: typeof fetch = async (input, init = {}) => {
  const requestUrl = String(input);
  const url = new URL(requestUrl);
  const headers = new Headers(init.headers);
  const method = (init.method ?? "GET").toString().toUpperCase();
  calls.push({ method, url: requestUrl, headers, ...(typeof init.body === "string" ? { body: init.body } : {}) });
  const path = url.pathname;

  if (path.endsWith("/contents/sync/v5/head.json")) {
    if (method === "GET") {
      if (!headBytes || !headSha) return new Response("missing", { status: 404 });
      if (headers.get("If-None-Match") === headEtag) return new Response(null, { status: 304, headers: { ETag: headEtag } });
      return jsonFile(headBytes, headSha, headEtag);
    }
    if (method === "PUT") {
      const request = parseRequestBody(init);
      if (request.sha !== undefined && request.sha !== headSha) return new Response("cas conflict", { status: 409 });
      if (request.sha === undefined && headSha) return new Response("already exists", { status: 422 });
      const bytes = decodeBase64(String(request.content));
      headBytes = bytes;
      headSha = newSha();
      headEtag = `"head-${generatedSha + 1}"`;
      return new Response(JSON.stringify({ content: { path: "sync/v5/head.json", sha: headSha } }), {
        status: headSha === "0000000000000000000000000000000000000001" ? 201 : 200,
        headers: { ETag: headEtag },
      });
    }
  }

  const contentPrefix = `/repos/${owner}/${repo}/contents/`;
  if (path.startsWith(contentPrefix)) {
    const contentPath = decodeURIComponent(path.slice(contentPrefix.length));
    const existing = immutable.get(contentPath);
    if (method === "PUT") {
      if (existing) return new Response("already exists", { status: 422 });
      const request = parseRequestBody(init);
      const bytes = decodeBase64(String(request.content));
      const sha = newSha();
      immutable.set(contentPath, { bytes, sha });
      blobs.set(sha, bytes);
      return new Response(JSON.stringify({ content: { path: contentPath, sha } }), { status: 201 });
    }
    if (method === "GET") {
      if (!existing) return new Response("missing", { status: 404 });
      return new Response(JSON.stringify({ type: "file", encoding: "base64", content: encodeBase64(existing.bytes), sha: existing.sha }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  const blobPrefix = `/repos/${owner}/${repo}/git/blobs/`;
  if (path.startsWith(blobPrefix) && method === "GET") {
    const sha = decodeURIComponent(path.slice(blobPrefix.length));
    const bytes = blobs.get(sha);
    if (!bytes) return new Response("missing", { status: 404 });
    assert.equal(headers.get("Accept"), GITHUB_V5_RAW_MEDIA_TYPE);
    return new Response(bytes, { status: 200, headers: { "Content-Type": "application/octet-stream" } });
  }
  return new Response("not found", { status: 404 });
};

const remote = new GitHubV5Remote({ owner, repo, branch, token, apiBaseUrl: "https://fake.github.test", fetch: fakeFetch, retryDelayMs: 0 });

// A missing head is the expected uninitialised state, and creating it is a PUT.
const missing = await remote.readHead();
assert.equal(missing.status, "missing");
const created = await remote.putHead(head);
assert.equal(created.ok, true);
if (!created.ok) throw new Error("head creation unexpectedly conflicted");
assert.equal(created.status, 201);

// A conditional read that has not changed is exactly one request and reuses cache.
const first = await remote.readHead();
assert.equal(first.status, "ok");
const beforeNotModified = calls.length;
const unchanged = await remote.readHead(first.cache);
assert.equal(unchanged.status, "not-modified");
assert.equal(calls.length - beforeNotModified, 1);
assert.equal(unchanged.fromCache, true);

// A stale blob SHA is a CAS conflict and does not trigger a read/retry.
const beforeCas = calls.length;
const conflict = await remote.putHead({ ...head, generatedAt: "2026-08-09T00:00:01.000Z" }, "f".repeat(40));
assert.deepEqual(conflict.ok, false);
assert.equal(calls.length - beforeCas, 1);

// Immutable files are created once; 422 is reconciled by a single same-content GET.
const immutableBytes = new TextEncoder().encode('{"events":[]}');
const immutablePath = `${SYNC_V5_EVENT_PREFIX}page-1.json`;
const firstFile = await remote.putImmutable(immutablePath, immutableBytes, { kind: "eventPage" });
assert.equal(firstFile.created, true);
const beforeIdempotent = calls.length;
const secondFile = await remote.putImmutable(immutablePath, immutableBytes, { kind: "eventPage" });
assert.equal(secondFile.idempotent, true);
assert.equal(calls.length - beforeIdempotent, 2);
await assert.rejects(
  remote.putImmutable(immutablePath, new TextEncoder().encode("different"), { kind: "eventPage" }),
  SyncV5ImmutableConflictError,
);

// Raw blob reads require the media type and reject both bad size and bad digest.
const rawSha = "1".repeat(40);
const rawBytes = new TextEncoder().encode("raw blob bytes");
blobs.set(rawSha, rawBytes);
const rawDigest = await sha256(rawBytes);
const loaded = await remote.readBlob(rawSha, { size: rawBytes.byteLength, sha256: rawDigest });
assert.deepEqual([...loaded], [...rawBytes]);
await assert.rejects(remote.readBlob(rawSha, { size: rawBytes.byteLength + 1, sha256: rawDigest }), SyncV5BlobIntegrityError);
await assert.rejects(remote.readBlob(rawSha, { size: rawBytes.byteLength, sha256: "f".repeat(64) }), SyncV5BlobIntegrityError);

const rawRequest = calls.find((call) => call.url.includes(`/git/blobs/${rawSha}`));
assert.equal(rawRequest?.headers.get("Accept"), GITHUB_V5_RAW_MEDIA_TYPE);

// GETs are bounded and retry one transient 503; the retry still carries an AbortSignal.
let retryCalls = 0;
const retryFetch: typeof fetch = async (_input, init = {}) => {
  assert.ok(init.signal, "GET request must carry an AbortSignal");
  retryCalls += 1;
  if (retryCalls === 1) return new Response("temporary", { status: 503 });
  return jsonFile(headBytes as Uint8Array, headSha as string, headEtag);
};
const retryRemote = new GitHubV5Remote({ owner, repo, branch, token, apiBaseUrl: "https://fake.github.test", fetch: retryFetch, timeoutMs: 100, retryDelayMs: 0 });
assert.equal((await retryRemote.readHead()).status, "ok");
assert.equal(retryCalls, 2);

console.log("github v5 remote tests passed: 1-request 304 cache, create/CAS, immutable idempotency, raw integrity");
