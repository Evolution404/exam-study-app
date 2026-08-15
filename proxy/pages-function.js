import { buildUpstreamRequest, withoutSetCookie } from "./github-relay-common.js";

/**
 * Cloudflare Pages Function：应用同源 /api-github/* 的 GitHub API 转发。
 *
 * 同源请求不会触发 CORS preflight，因此这里不需要处理 OPTIONS。
 * 本文件由 scripts/tools/emit-pages-relay.mjs 打包进 functions/api-github/[[path]].js。
 */
export async function onRequest(context) {
  const proxied = buildUpstreamRequest(context.request, { pathPrefix: "/api-github" });
  const response = await fetch(proxied);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: withoutSetCookie(response),
  });
}
