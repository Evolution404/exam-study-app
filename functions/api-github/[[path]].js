/**
 * Same-origin GitHub API proxy (Cloudflare Pages Function).
 *
 * The sync client sends Authorization + X-GitHub-Api-Version headers on every
 * request, which makes each one a CORS "non-simple" request and doubles the
 * trip count with OPTIONS preflights when the relay lives on another origin.
 * Hosting the proxy under the app's own origin (/api-github/*) removes CORS —
 * and therefore every preflight — entirely.
 *
 * The function is a transparent byte-pipe: method, headers (including
 * Authorization, If-None-Match ETags and the raw-blob Accept type) and body go
 * to api.github.com untouched; the response (including 304 Not Modified) comes
 * back untouched. No token is ever read, stored or logged here.
 *
 * Usage: in the app set 同步中转地址 to `/api-github` (or the full
 * `https://<app-domain>/api-github`). On GitHub Pages this function does not
 * exist — keep pointing that origin at an external relay.
 */

const UPSTREAM = "https://api.github.com";
const PATH_PREFIX = "/api-github";

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const upstream = new URL(UPSTREAM);
  upstream.pathname = url.pathname.replace(new RegExp(`^${PATH_PREFIX}`), "") || "/";
  upstream.search = url.search;

  const headers = new Headers(request.headers);
  // Hop-by-hop / edge-injected headers must not leak upstream.
  headers.delete("cookie");
  headers.delete("x-forwarded-for");
  headers.delete("x-forwarded-proto");
  headers.delete("x-real-ip");
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");

  const proxied = new Request(upstream.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });

  const response = await fetch(proxied);
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}
