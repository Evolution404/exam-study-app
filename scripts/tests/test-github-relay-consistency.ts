import assert from "node:assert/strict";
import fs from "node:fs";
import { GITHUB_PAGES_RELAY, resolveDefaultGitHubApiBaseUrl } from "../../src/lib/sync/github-credentials";
import workerRelay from "../../proxy/worker.js";
import { MAX_RELAY_BODY_BYTES, relayRequestPolicy } from "../../proxy/github-relay-common.js";

const read = (file: string) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const common = read("proxy/github-relay-common.js");
const pages = read("proxy/pages-function.js");
const worker = read("proxy/worker.js");
const routes = JSON.parse(read("public/_routes.json")) as { include: string[]; exclude: string[] };

// 两个入口必须共用同一份公共逻辑，不能各自内联一套。
assert.match(pages, /from "\.\/github-relay-common\.js"/, "pages relay must import the shared relay module");
assert.match(worker, /from "\.\/github-relay-common\.js"/, "worker relay must import the shared relay module");
assert.doesNotMatch(pages, /https:\/\/api\.github\.com/, "pages relay must not duplicate the upstream origin");
assert.doesNotMatch(worker, /https:\/\/api\.github\.com/, "worker relay must not duplicate the upstream origin");

// 上游、剥除头清单、redirect 语义、set-cookie 处理都只定义在公共模块里。
assert.match(common, /GITHUB_API_UPSTREAM\s*=\s*"https:\/\/api\.github\.com"/, "upstream must target the GitHub API");
for (const header of [
  "cookie",
  "host",
  "content-length",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]) {
  assert.match(common, new RegExp(`"${header}"`), `request header strip list must include ${header}`);
}
assert.match(common, /for \(const name of REQUEST_HEADERS_TO_STRIP\) out\.delete\(name\)/, "shared request builder must apply the strip list");
assert.match(common, /redirect: "manual"/, "shared request builder must preserve redirect semantics");
assert.match(common, /headers\.delete\("set-cookie"\)/, "shared response helper must drop upstream cookies");

// Pages Function：同源代理，剥 /api-github 前缀，响应全量透传但去掉 set-cookie。
assert.match(pages, /buildUpstreamRequest\(context\.request, \{ pathPrefix: "\/api-github" \}\)/, "pages relay must strip the /api-github prefix");
assert.match(pages, /withoutSetCookie\(response\)/, "pages relay must drop set-cookie on the way back");

// Worker：跨域代理，自行处理 OPTIONS 预检，GET/HEAD 不带 body，响应头走白名单。
assert.match(worker, /if \(request\.method === "OPTIONS"\)/, "worker relay must answer CORS preflight");
assert.match(worker, /buildUpstreamRequest\(request, \{ omitBodyForGetHead: true \}\)/, "worker relay must omit GET/HEAD bodies");
for (const header of ["etag", "content-type", "last-modified", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
  assert.match(worker, new RegExp(`"${header}"`), `worker relay must expose ${header}`);
}
assert.match(worker, /Access-Control-Allow-Origin": "\*"/, "worker relay must allow cross-origin browser clients");
assert.match(worker, /Access-Control-Allow-Methods": "GET, HEAD, PUT, DELETE, OPTIONS"/, "worker relay must allow the complete method set");
assert.match(worker, /Access-Control-Expose-Headers": "etag, last-modified, content-length, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset"/, "worker relay must expose every sync response header");

const sha256 = "a".repeat(64);
const sha1 = "b".repeat(40);
const relayRequest = (path: string, init?: RequestInit): Request => new Request(`https://sync.example${path}`, init);

// The policy matrix is intentionally explicit: all ordinary reads/writes stay
// available, while DELETE is limited to one content-addressed object at a time.
assert.equal(relayRequestPolicy(relayRequest("/user")).allowed, true, "/user GET");
assert.equal(relayRequestPolicy(relayRequest("/repos/me/vault/contents/sync/v8/head.json")).allowed, true, "contents GET");
assert.equal(relayRequestPolicy(relayRequest(`/repos/me/vault/git/blobs/${sha1}`)).allowed, true, "blob GET");
assert.equal(relayRequestPolicy(relayRequest("/repos/me/vault/contents/sync/v8/head.json", { method: "HEAD" })).allowed, true, "head HEAD");
assert.equal(relayRequestPolicy(relayRequest("/repos/me/vault/contents/sync/v8/head.json", { method: "PUT" })).allowed, true, "contents PUT");
for (const namespace of ["checkpoints", "segments", "objects", "history"]) {
  assert.deepEqual(
    relayRequestPolicy(relayRequest(`/repos/me/vault/contents/sync/v8/${namespace}/${sha256}.json`, { method: "DELETE" })),
    { allowed: true, status: 200 },
    `v8 ${namespace} DELETE`,
  );
}

// DELETE must never become a general Contents API proxy.
for (const path of [
  "/repos/me/vault/contents/sync/v8/head.json",
  `/repos/me/vault/contents/sync/v8/assets/${sha256}.png`,
  "/repos/me/vault/contents/sync/v8/checkpoints/not-a-hash.json",
  `/repos/me/vault/contents/sync/v8/checkpoints/${sha256}.json/extra`,
  "/repos/me/vault/contents/other.json",
]) {
  assert.deepEqual(relayRequestPolicy(relayRequest(path, { method: "DELETE" })), { allowed: false, status: 404 }, `DELETE must reject ${path}`);
}
assert.deepEqual(relayRequestPolicy(new Request("https://sync.example/repos/me/vault/issues", { method: "POST" })), { allowed: false, status: 405 });
assert.deepEqual(relayRequestPolicy(relayRequest("/repos/me/vault/issues")), { allowed: false, status: 404 }, "unrelated GitHub API must be rejected");
assert.deepEqual(relayRequestPolicy(new Request("https://pages.example/api-github/repos/me/vault/issues"), { pathPrefix: "/api-github" }), { allowed: false, status: 404 });
assert.deepEqual(
  relayRequestPolicy(relayRequest("/repos/me/vault/contents/sync/v8/head.json", { method: "PUT", headers: { "content-length": String(MAX_RELAY_BODY_BYTES + 1) } })),
  { allowed: false, status: 413 },
  "relay must reject bodies over 20 MiB",
);
assert.equal(relayRequestPolicy(relayRequest("/repos/me/vault/contents/sync/v8/head.json", { method: "PUT", headers: { "content-length": String(MAX_RELAY_BODY_BYTES) } })).allowed, true, "20 MiB body is the inclusive limit");

interface WorkerForwardResult {
  response: Response;
  forwarded: Request | undefined;
}

async function invokeWorker(request: Request, upstreamResponse: Response): Promise<WorkerForwardResult> {
  let forwarded: Request | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    forwarded = input instanceof Request ? input : new Request(input, init);
    return upstreamResponse;
  };
  try {
    return { response: await workerRelay.fetch(request), forwarded };
  } finally {
    globalThis.fetch = originalFetch;
  }
}

// /user, contents, blob and head traffic all use the same upstream transport;
// this head response also verifies ETag and streamed-header forwarding.
const headResult = await invokeWorker(
  relayRequest("/repos/me/vault/contents/sync/v8/head.json?ref=main", { method: "HEAD", headers: { authorization: "Bearer test-token" } }),
  new Response(null, { status: 304, headers: { etag: '"head-etag"', "last-modified": "Wed, 20 Aug 2026 00:00:00 GMT", "content-length": "0" } }),
);
assert.equal(headResult.response.status, 304, "head status must pass through");
assert.equal(headResult.response.headers.get("etag"), '"head-etag"', "head ETag must pass through");
assert.equal(headResult.response.headers.get("content-length"), "0", "content-length must pass through when upstream supplies it");
assert.equal(headResult.forwarded?.url, "https://api.github.com/repos/me/vault/contents/sync/v8/head.json?ref=main", "head must target GitHub API");
assert.equal(headResult.forwarded?.body, null, "Worker must not send a HEAD body upstream");

// A missing upstream Content-Length is left absent; the relay must not invent
// a value for streamed Cloudflare responses.
const missingLengthResult = await invokeWorker(relayRequest("/user"), new Response("ok", { status: 200, headers: { etag: '"user-etag"' } }));
assert.equal(missingLengthResult.response.status, 200, "/user status must pass through");
assert.equal(missingLengthResult.response.headers.get("etag"), '"user-etag"', "/user ETag must pass through");
assert.equal(missingLengthResult.response.headers.get("content-length"), null, "relay must not fabricate content-length");

// CAS failures are part of sync conflict handling and must retain both status
// and body instead of being translated into a generic relay error.
for (const status of [409, 422]) {
  const casBody = JSON.stringify({ message: `CAS ${status}` });
  const casResult = await invokeWorker(
    relayRequest("/repos/me/vault/contents/sync/v8/head.json", { method: "PUT", headers: { authorization: "Bearer test-token", "content-type": "application/json" } }),
    new Response(casBody, { status, headers: { "content-type": "application/json" } }),
  );
  assert.equal(casResult.response.status, status, `CAS ${status} status must pass through`);
  assert.equal(await casResult.response.text(), casBody, `CAS ${status} body must pass through`);
}

// Authorization is forwarded verbatim, while edge/proxy hop headers are
// removed from the request sent to GitHub.  Redirect handling stays manual.
const headerResult = await invokeWorker(
  relayRequest("/repos/me/vault/contents/sync/v8/head.json", {
    method: "PUT",
    headers: {
      authorization: "Bearer secret-token",
      "x-github-api-version": "2022-11-28",
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      cookie: "session=should-not-forward",
      host: "attacker.example",
      "content-length": "7",
      "cf-connecting-ip": "192.0.2.1",
      "cf-ray": "ray-id",
      "cf-ipcountry": "CN",
      "cf-visitor": "{\"scheme\":\"https\"}",
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-proto": "https",
      "x-real-ip": "192.0.2.1",
    },
  }),
  new Response(null, { status: 200 }),
);
assert.equal(headerResult.forwarded?.headers.get("authorization"), "Bearer secret-token", "Authorization must be forwarded verbatim");
assert.equal(headerResult.forwarded?.headers.get("x-github-api-version"), "2022-11-28", "GitHub API version must be forwarded");
for (const header of [
  "cookie",
  "host",
  "content-length",
  "cf-connecting-ip",
  "cf-ray",
  "cf-ipcountry",
  "cf-visitor",
  "x-forwarded-for",
  "x-forwarded-proto",
  "x-real-ip",
]) {
  assert.equal(headerResult.forwarded?.headers.get(header), null, `${header} must be stripped before GitHub`);
}
assert.equal(headerResult.forwarded?.redirect, "manual", "upstream redirect mode must remain manual");

const deleteResult = await invokeWorker(
  relayRequest(`/repos/me/vault/contents/sync/v8/objects/${sha256}.json`, { method: "DELETE", headers: { authorization: "Bearer test-token" } }),
  new Response(null, { status: 204 }),
);
assert.equal(deleteResult.response.status, 204, "allowed immutable DELETE must reach upstream");
assert.equal(deleteResult.forwarded?.method, "DELETE", "immutable DELETE method must pass through");

const corsPreflight = await workerRelay.fetch(relayRequest("/user", { method: "OPTIONS", headers: { origin: "https://app.example" } }));
assert.equal(corsPreflight.status, 204, "Worker must answer CORS OPTIONS");
assert.equal(corsPreflight.headers.get("access-control-allow-methods"), "GET, HEAD, PUT, DELETE, OPTIONS", "CORS must allow the full relay method set");
assert.equal(corsPreflight.headers.get("access-control-allow-headers"), "authorization, x-github-api-version, accept, content-type, if-none-match", "CORS request-header allowlist must stay minimal");
assert.equal(corsPreflight.headers.get("access-control-expose-headers"), "etag, last-modified, content-length, x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset", "CORS expose list must include all sync response headers");

// Pages 路由只覆盖同步 API 与公开 SideStore 发行资产代理。
assert.deepEqual(routes.include, ["/api-github/*", "/sidestore/*"], "functions route only the API and SideStore proxy paths");
assert.deepEqual(routes.exclude, [], "no other path runs as a function");

// GitHub Pages cannot run Functions, so its advertised public build must use
// the dedicated Worker instead of the same-origin path that would return 404.
assert.equal(resolveDefaultGitHubApiBaseUrl("evolution404.github.io"), GITHUB_PAGES_RELAY);
assert.equal(resolveDefaultGitHubApiBaseUrl("exam-study-app.pages.dev"), "/api-github");
assert.equal(resolveDefaultGitHubApiBaseUrl("localhost"), "/api-github");

console.log("GitHub relay consistency tests passed: shared upstream/strip-list/redirect, deploy-specific defaults, worker CORS, pages routes");
