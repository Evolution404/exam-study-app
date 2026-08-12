/**
 * sync-proxy — 把 api.github.com 的 v6 vault 请求转发到 Cloudflare 边缘节点。
 *
 * 目的：中国大陆访问 api.github.com 慢/不稳定；把同步请求改走 Cloudflare
 * 的边缘网络（香港/东京节点），让 checkpoint 等大对象下载从几十秒降到秒级。
 *
 * 部署（一次性）：
 *   cd sync-proxy
 *   npx wrangler login                # 浏览器授权 Cloudflare 账号
 *   npx wrangler deploy               # 同时创建 sync.980923.xyz 的 route + DNS 记录
 *
 * 客户端在「连接私有仓库」设置里填 https://sync.980923.xyz 作为同步中转地址。
 *
 * 安全模型：GitHub token 由用户在 app 设置里配置，客户端请求自带
 * `Authorization: Bearer <token>`，Worker 无状态原样透传，不存储任何令牌。
 * Vault 仍是私有仓库，读写都经过用户自己的令牌。
 */
export default {
  async fetch(request) {
    // 浏览器跨域 PUT + Authorization 会先发 OPTIONS 预检。
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const upstream = new URL(`https://api.github.com${url.pathname}${url.search}`);

    // 客户端 Authorization 头原样透传；只去掉可能干扰上游的 hop-by-hop /
    // Cloudflare 附加头（不含 authorization）。
    const headers = new Headers(request.headers);
    for (const name of [
      "host", "content-length",
      "cf-connecting-ip", "cf-ray", "cf-ipcountry", "cf-visitor",
      "x-forwarded-for", "x-forwarded-proto", "x-real-ip",
    ]) headers.delete(name);

    const upstreamRequest = new Request(upstream, {
      method: request.method,
      headers,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : request.body,
      redirect: "manual",
    });

    const upstreamResponse = await fetch(upstreamRequest);

    // 透传客户端依赖的头；其余（ETag/304 缓存、rate limit、raw 二进制类型）保留。
    const out = new Headers(corsHeaders());
    for (const name of ["etag", "content-type", "last-modified", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
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
