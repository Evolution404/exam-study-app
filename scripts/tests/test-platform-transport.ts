import assert from "node:assert/strict";
import { createGitHubTransport, GITHUB_RELAY_URL, GITHUB_WEB_RELAY_PATH, resolveGitHubApiBaseUrl } from "../../src/platform/github-transport";
import { getGitHubLogin } from "../../src/lib/sync/sync-v7-tools";
import { remote } from "../../src/lib/sync/sync-v7-context";
import type { SyncHeadV7 } from "../../src/lib/sync/sync-v7-head-types";

const native = { platform: "ios" as const, native: true, ios: true };
const web = { platform: "web" as const, native: false, ios: false };
const calls: string[] = [];
const head: SyncHeadV7 = {
  formatVersion: 9,
  vaultId: "owner/repo@main",
  generatedAt: "2026-08-22T00:00:00.000Z",
  generation: 0,
  metadata: { producer: "test", vaultId: "owner/repo@main" },
  checkpoint: {
    path: "sync/v9/checkpoints/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.json",
    blobSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sha256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    size: 0,
    storedSize: 0,
  },
  segments: [],
  cursors: {},
};
const headBytes = new TextEncoder().encode(JSON.stringify(head));
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));

const fakeFetch: typeof fetch = async (input) => {
  calls.push(String(input));
  const url = new URL(String(input));
  if (url.pathname === "/user") return new Response(JSON.stringify({ login: "owner" }), { status: 200 });
  if (url.pathname.endsWith("/contents/sync/v9/head.json")) {
    return new Response(JSON.stringify({ type: "file", encoding: "base64", content: base64(headBytes), sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), { status: 200, headers: { ETag: '"head"' } });
  }
  return new Response("missing", { status: 404 });
};

const nativeTransport = createGitHubTransport({ environment: native, fetch: fakeFetch });
const webTransport = createGitHubTransport({ environment: web, hostname: "evolution404.github.io", fetch: fakeFetch });
const cloudflareTransport = createGitHubTransport({ environment: web, hostname: "study.pages.dev", fetch: fakeFetch });
assert.equal(nativeTransport.defaultApiBaseUrl, GITHUB_RELAY_URL);
assert.equal(webTransport.defaultApiBaseUrl, GITHUB_RELAY_URL);
assert.equal(cloudflareTransport.defaultApiBaseUrl, GITHUB_WEB_RELAY_PATH);
assert.equal(resolveGitHubApiBaseUrl(GITHUB_WEB_RELAY_PATH, nativeTransport), GITHUB_RELAY_URL);
assert.equal(resolveGitHubApiBaseUrl("https://custom.example", nativeTransport), "https://custom.example");

assert.equal(await getGitHubLogin("test-token", undefined, { transport: nativeTransport }), "owner");
const client = remote({ owner: "owner", repo: "repo", branch: "main" }, "test-token", undefined, nativeTransport);
const result = await client.readHead();
assert.equal(result.status, "ok");
assert.equal(result.head.vaultId, head.vaultId);
assert.ok(calls.every((url) => url.startsWith(GITHUB_RELAY_URL)), "owner/head requests must share the native relay transport");

console.log("platform transport tests passed: native/GitHub Pages/Cloudflare defaults, custom preservation, owner lookup and head injection");
