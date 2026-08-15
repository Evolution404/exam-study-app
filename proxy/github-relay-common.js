export const GITHUB_API_UPSTREAM = "https://api.github.com";

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
