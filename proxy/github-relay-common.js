export const GITHUB_API_UPSTREAM = "https://api.github.com";
export const MAX_RELAY_BODY_BYTES = 20 * 1024 * 1024;

// Cloudflare 边缘注入或 HTTP 逐跳头，转发前必须删除。
// 两个代理入口共用这份清单，避免出现一边删 cookie、另一边删 host 的分叉。
export const REQUEST_HEADERS_TO_STRIP = [
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
];

export function stripRequestHeaders(headers) {
  const out = new Headers(headers);
  for (const name of REQUEST_HEADERS_TO_STRIP) out.delete(name);
  return out;
}

export function buildUpstreamUrl(requestUrl, { pathPrefix } = {}) {
  const url = new URL(requestUrl);
  const upstream = new URL(GITHUB_API_UPSTREAM);
  const pathname = pathPrefix && url.pathname.startsWith(pathPrefix)
    ? url.pathname.slice(pathPrefix.length) || "/"
    : url.pathname;
  upstream.pathname = pathname;
  upstream.search = url.search;
  return upstream;
}

/** Restrict the public relay to the small GitHub API surface used by sync. */
export function relayRequestPolicy(request, { pathPrefix } = {}) {
  const method = request.method.toUpperCase();
  if (!["GET", "HEAD", "PUT", "DELETE", "POST", "PATCH"].includes(method)) return { allowed: false, status: 405 };
  const upstream = buildUpstreamUrl(request.url, { pathPrefix });
  const path = upstream.pathname;
  const userLookup = path === "/user" && (method === "GET" || method === "HEAD");
  const repositoryRead = /^\/repos\/[^/]+\/[^/]+\/(?:contents(?:\/.*)?|git\/blobs\/[a-f0-9]{40})$/i.test(path)
    && (method === "GET" || method === "HEAD");
  const contentsWrite = /^\/repos\/[^/]+\/[^/]+\/contents(?:\/.*)?$/i.test(path) && method === "PUT";

  // Asset Pack publication uses Git Data API so dozens/hundreds of image
  // objects become one tree/commit/ref update instead of one Contents commit
  // per file. Keep this allowlist deliberately narrower than a general Git API
  // proxy: one branch ref, commit/tree reads, blob/tree/commit creates and a
  // non-forced heads ref update are the only additional operations.
  const gitBranchRead = /^\/repos\/[^/]+\/[^/]+\/git\/ref\/heads\/[A-Za-z0-9._~\/-]+$/.test(path) && method === "GET";
  const gitCommitRead = /^\/repos\/[^/]+\/[^/]+\/git\/commits\/[a-f0-9]{40}$/i.test(path) && method === "GET";
  const gitObjectCreate = /^\/repos\/[^/]+\/[^/]+\/git\/(?:blobs|trees|commits)$/i.test(path) && method === "POST";
  const gitHeadUpdate = /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/[A-Za-z0-9._~\/-]+$/.test(path) && method === "PATCH";

  // GC is deliberately narrower than ordinary contents writes. Only
  // content-addressed v9 objects can be removed; head.json is mutable and
  // assets are user data, so neither may be deleted through the public relay.
  const immutableDelete = /^\/repos\/[^/]+\/[^/]+\/contents\/sync\/v9\/(?:checkpoints|segments|objects|history)\/[a-f0-9]{64}\.json$/.test(path)
    && method === "DELETE";
  if (!userLookup && !repositoryRead && !contentsWrite && !gitBranchRead && !gitCommitRead && !gitObjectCreate && !gitHeadUpdate && !immutableDelete) {
    return { allowed: false, status: 404 };
  }
  const declaredBytes = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredBytes) && (declaredBytes < 0 || declaredBytes > MAX_RELAY_BODY_BYTES)) return { allowed: false, status: 413 };
  return { allowed: true, status: 200 };
}

export function buildUpstreamRequest(request, { pathPrefix, omitBodyForGetHead = false } = {}) {
  const upstream = buildUpstreamUrl(request.url, { pathPrefix });
  const headers = stripRequestHeaders(request.headers);
  const method = request.method.toUpperCase();
  const body = omitBodyForGetHead && (method === "GET" || method === "HEAD")
    ? undefined
    : request.body;
  return new Request(upstream, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });
}

export function withoutSetCookie(response) {
  const headers = new Headers(response.headers);
  headers.delete("set-cookie");
  return headers;
}
