# sync-proxy — Cloudflare Worker 转发 api.github.com

中国大陆直连 `api.github.com` 慢且不稳定（DNS 污染、国际出口丢包），完整同步一个 5.17MB 的 checkpoint 在弱代理下要 60+ 秒。这个 Worker 把 vault 的所有同步请求转发到 Cloudflare 边缘网络（香港/东京节点），把下载从几十秒压到秒级。

## 工作原理

```
客户端 (exam-study-app) ── https://sync.980923.xyz/repos/... ──▶ Cloudflare Worker
                                                                   │ 原样转发（含 Authorization）
                                                                   ▼
                                                             api.github.com（GitHub 边缘）
```

- 客户端把「同步中转地址」设为 `https://sync.980923.xyz`，`GitHubV6Remote` 的 `apiBaseUrl` 钩子让所有请求走 Worker。
- Worker 无状态转发：URL 重写、CORS 补全、ETag/304、二进制 raw 响应全部透传。
- **GitHub token 由用户在 app 设置里配置**，客户端请求自带 `Authorization: Bearer <token>`，Worker 原样透传、不存储任何令牌。

## 一次性部署

前置：Cloudflare 账号已添加站点 `980923.xyz`（Free 计划），NS 已从 name.com 迁到 Cloudflare。

```bash
cd sync-proxy
npx wrangler login                          # 浏览器授权
npx wrangler deploy                         # 部署 Worker + 创建 sync.980923.xyz route/DNS
```

验证转发是否生效：

```bash
curl -s -D - -o /dev/null -H "Authorization: Bearer github_pat_…" \
  -H "Accept: application/vnd.github.raw+json" \
  https://sync.980923.xyz/repos/Evolution404/exam-study-vault/contents/sync/v6/head.json \
  | grep -iE "^HTTP|etag|content-type"
```

应返回 `200` + 正确的 `etag`。`sync-proxy` 本身无状态、不存 token；谁持有有效的 GitHub 令牌就能读写你自己的 vault，与直连 `api.github.com` 权限一致。

## 限额（Cloudflare Workers Free）

- 100,000 请求/天（一次完整同步约 5 个请求，远远够用）。
- 请求/响应体上限约 100MB（checkpoint 5.17MB 无压力）。
- CPU 10ms/请求（纯转发 <1ms）。

## 客户端配合

应用设置页「连接私有仓库」新增「同步中转地址（可选）」：填 `https://sync.980923.xyz`。
不填则走直连 `api.github.com`（行为不变）。
