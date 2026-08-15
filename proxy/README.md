# proxy — GitHub API 转发代理

统一维护应用的两个 GitHub API 转发入口。两者的安全模型相同：客户端自带
`Authorization: Bearer <token>`，代理无状态原样透传，不读取、不存储令牌。

## 目录

- `github-relay-common.js`：两个入口共用的转发逻辑（上游地址、剥除边缘/逐跳头、构造上游 Request、响应回传）。
- `pages-function.js`：同域名转发入口（Cloudflare Pages Function，`/api-github/*`）。
- `worker.js`：跨域名转发入口（Cloudflare Worker，`sync.980923.xyz`）。
- `wrangler.toml`：Worker 部署配置。

## 部署

### Pages Function（应用同源）

构建时会自动生成 `functions/api-github/[[path]].js`：

```bash
npm run build
npx wrangler pages deploy dist
```

### Worker（独立域名）

```bash
npx wrangler deploy --config proxy/wrangler.toml
```

## 测试

```bash
npm run test:pwa
```

测试断言两个入口共用同一套转发公共逻辑（上游、剥除头、redirect manual、set-cookie 处理）。
