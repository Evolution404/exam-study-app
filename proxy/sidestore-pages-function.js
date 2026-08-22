const RELEASE_BASE = "https://github.com/Evolution404/exam-study-app/releases/latest/download";

const ASSETS = new Map([
  ["/sidestore/source.json", {
    name: "sidestore-source.json",
    contentType: "application/json; charset=utf-8",
    cacheControl: "no-cache, no-store, must-revalidate",
    disposition: "inline",
  }],
  ["/sidestore/shijuan.ipa", {
    name: "shijuan.ipa",
    contentType: "application/octet-stream",
    cacheControl: "public, max-age=300, must-revalidate",
    disposition: 'attachment; filename="shijuan.ipa"',
  }],
]);

function responseHeaders(upstream, asset) {
  const headers = new Headers();
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("content-type", asset.contentType);
  headers.set("content-disposition", asset.disposition);
  headers.set("cache-control", asset.cacheControl);
  headers.set("access-control-allow-origin", "*");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

/**
 * Cloudflare Pages Function：为 SideStore 提供稳定同域更新源，并流式反代
 * GitHub 最新 iOS Release 资产。只允许两个公开 GET/HEAD 端点。
 */
export async function onRequest(context) {
  const method = context.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }

  const pathname = new URL(context.request.url).pathname;
  const asset = ASSETS.get(pathname);
  if (!asset) return new Response("Not Found", { status: 404 });

  const requestHeaders = new Headers({
    accept: asset.name.endsWith(".json") ? "application/json" : "application/octet-stream",
    "user-agent": "exam-study-app-sidestore-relay",
  });
  for (const name of ["range", "if-none-match", "if-modified-since"]) {
    const value = context.request.headers.get(name);
    if (value) requestHeaders.set(name, value);
  }

  const upstream = await fetch(`${RELEASE_BASE}/${asset.name}`, {
    method,
    redirect: "follow",
    headers: requestHeaders,
  });

  return new Response(method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders(upstream, asset),
  });
}

export { ASSETS, RELEASE_BASE };
