import { buildUpstreamRequest, relayRequestPolicy } from "./github-relay-common.js";

const RESPONSE_HEADERS_TO_COPY = [
  "etag",
  "content-type",
  "last-modified",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
];

/**
 * 跨域名 GitHub API 转发 Worker（sync.980923.xyz）。
 *
 * 客户端请求自带 `Authorization: Bearer <token>`，Worker 无状态原样透传，
 * 不存储任何令牌。跨域 PUT + Authorization 会先发 OPTIONS 预检，因此这里
 * 需要自行处理 CORS。
 */
export default {
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const policy = relayRequestPolicy(request);
    if (!policy.allowed) return new Response("GitHub relay request rejected", { status: policy.status, headers: corsHeaders() });

    const proxied = buildUpstreamRequest(request, { omitBodyForGetHead: true });
    const upstreamResponse = await fetch(proxied);

    const out = new Headers(corsHeaders());
    for (const name of RESPONSE_HEADERS_TO_COPY) {
      const value = upstreamResponse.headers.get(name);
      if (value) out.set(name, value);
    }

    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: out,
    });
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-github-api-version, accept, content-type, if-none-match",
    "Access-Control-Expose-Headers": "etag, last-modified, x-ratelimit-remaining, x-ratelimit-limit",
    "Access-Control-Max-Age": "86400",
  };
}
