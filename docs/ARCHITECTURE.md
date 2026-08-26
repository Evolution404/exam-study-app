# 工程结构

## 顶层目录

```text
src/         # 应用源码（app + lib + 入口 + 类型声明）
ios/         # Capacitor 生成的 iOS 原生壳（不承载业务页面）
proxy/       # GitHub API 转发代理源码（Pages Function + Worker 共用）
functions/   # 构建生成：Cloudflare Pages Function（由 scripts/tools/emit-pages-relay.mjs 生成）
scripts/
  tools/     # 构建/检查/生成等工具脚本
  tests/     # node/tsx + playwright-core 测试脚本
public/      # 静态资源
docs/        # 项目文档
```

## 应用层 `src/app/`

```text
src/app/
├── shell/                  # AppShell 顶层 composition、导航/topbar、页面 wiring 与渐进抽取的 controller/hooks
│   ├── app-shell.tsx       # 当前真实应用外壳入口
│   ├── navigation.tsx
│   ├── topbar.tsx
│   └── views/
├── ui/                     # 通用 UI
├── practice/               # 练习与复习轮次
├── search/                 # 搜索、筛选与 quick search
├── bank/                   # 题库、题目、富内容、导入导出 UI
├── sync/                   # 同步 UI、事件与热窗口
├── hooks/                  # 跨页面环境能力
└── styles/                 # 语义主题令牌与拆分样式域
```

`src/app/study-app.tsx` 已不是当前入口。顶层跨页面编排由 `src/app/shell/app-shell.tsx` 的 `AppShell` 承担；本轮 project-health 治理继续按 navigation、practice session、quick sync、dashboard/live-query 数据边界把可独立验证的职责抽成 controller/hooks，而不是把单体文件整体搬家。

## 平台适配层 `src/platform/`

平台差异集中在 adapter，不向 React 业务页面扩散：

```text
src/platform/
├── environment.ts
├── runtime.ts
├── github-transport.ts
├── secure-credentials.ts
├── persistent-config.ts
├── lifecycle.ts
├── haptics.ts
└── files.ts
```

Web/PWA 使用浏览器能力；iOS 使用 Capacitor 插件，但业务层仍只依赖抽象接口。iOS 工程固定由 `capacitor.config.ts` 声明为 `com.evolution404.shijuan` / `拾卷`，不包含独立的 iOS React 页面。`npm run build:ios` 以 `APP_TARGET=ios` 构建相对资源基路径 `./`，再由 `npx cap sync ios` 将产物复制到 WKWebView 壳中。

平台边界硬规则：

- native WKWebView 不注册 Service Worker；PWA 缓存只属于浏览器 Web 构建。
- iOS 同步使用 WKWebView `fetch` 兼容路径；Native HTTP 未启用，不能绕过统一 transport 或 Relay。
- 只有 adapter 读取 Keychain、Preferences、App lifecycle、Haptics、Filesystem 和 Share；Dexie、Sync v9、题型与练习领域代码不分叉。

## 领域层 `src/lib/`

```text
src/lib/
├── db/        # IndexedDB v7 数据模型、事务与恢复
├── sync/      # github-sync 门面、Sync v9 transport/codec/checkpoint/head/orchestrator、Asset Pack
├── question/  # 题目内容、题库导入导出、概览
├── io/        # XLSX/ZIP、图片资产与尺寸
└── practice/  # 作答、进度、难度、快捷键、提示等领域逻辑
```

所有领域计算不依赖 React 页面。UI 只通过 `src/lib/sync/github-sync.ts` 的公开门面进入同步。

## 入口与启动恢复 `src/main.tsx`

- 挂载 `AppShell`。
- 引入全局 CSS 与生成字体。
- 等待 `dbV7Ready` 后挂载错误边界；数据库迁移或懒加载失败时只提供重试/导出/清除提示，不自动破坏本地数据。
- 生产 Web 环境注册 `/sw.js`，native 由平台 runtime gate 掉 Service Worker。

## 当前数据与同步格式

- 客户端只使用 IndexedDB v7（`shijuan-study-v7`）；iOS 仍使用 WKWebView IndexedDB，不迁移 SQLite。
- 公开远端协议为 Sync v9：head 固定为 `sync/v9/head.json`，检查点、分段、对象、历史和资产位于 `sync/v9/`。
- head 使用 ETag/SHA CAS；冲突时拉取、合并后重试，不覆盖并发设备数据。
- 完整恢复保持“恢复全部历史”的既有语义；设备本地 `historySyncStart` 只影响日常历史窗口安装，不允许截断远端档案。
- 图片逻辑身份为 `assetId = SHA-256(image bytes)`；本地 Blob，远端只使用 `index → shard → immutable Asset Pack`。
- 一轮 Asset Pack 发布通过 Git Data API 创建 pack/shard/index tree，只生成 1 个 commit + 1 次 heads ref fast-forward；禁止恢复逐图 Contents PUT。
- IndexedDB v7 schema、tombstone/GC/replay、checkpoint/history 与 content addressing 都是当前协议合同，结构重构不得改变这些语义。

## 代理层 `proxy/`

`proxy/github-relay-common.js` 是 Pages Function 与独立 Worker 的公共 GitHub Relay 逻辑。Cloudflare Pages 使用 `/api-github`，GitHub Pages 与 iOS 默认使用 `https://sync.980923.xyz`。Relay 只开放同步所需白名单；Asset Pack 仅增加 branch ref/commit read、blob/tree/commit create、heads ref fast-forward PATCH，不得扩成任意 Git API 代理。

## 测试与治理

- `scripts/tools/check-css-architecture.mjs`：CSS 总量、最大文件、硬编码颜色、dark selector、`!important` 等只降不升 ratchet。
- `scripts/tools/check-export-surface.mjs`：Knip unused export/type ratchet。
- `scripts/tools/check-test-registration.mjs`：测试文件与 test group 注册完整性。
- `scripts/tools/check-workflow-hygiene.mjs`：禁止把一次性 PR 编号/acceptance workflow 与旧 Sync v7/v8 分支标记长期留在正式 workflow 目录。
- `scripts/tools/report-project-health.mjs`：报告 top source/test/workflow 与重点大文件趋势；当前仅报告，不用武断大小阈值替代既有 ratchet。

Browser E2E 使用 Playwright Chromium/WebKit。strict `search-pin` geometry 是行为门禁，不能改成截图或放宽容差；Chromium PWA preview smoke 与 WebKit 设计性 skip 也属于固定覆盖合同。

## iOS 构建与 SideStore 发布边界

本地 Xcode 路径：

```text
make ios-setup
make ios-open
make ios-run IOS_TARGET=…
make ios-build-simulator
make verify-ios
```

SideStore 已是正式生产发布目标，而不是“尚未验证”的设想：

- `make ios-ipa` 可生成 SideStore 可重签的无签名 IPA；
- `deploy-pages.yml` 的 iOS job 在 macOS runner 上为 `main` exact commit 构建 IPA，并生成 `sidestore-source.json`；
- GitHub Release assets 保持不可变；Cloudflare 提供稳定 source/IPA endpoint；
- `sidestore_smoke` 发布后必须读回当前版本；
- 设备端最终签名仍由 SideStore + 用户 Apple ID 完成，CI 不持有 Apple 证书。

## 生产发布图

主 workflow 的合同保持：

```text
build
├─> GitHub Pages
├─> Cloudflare Pages
└─> SideStore IPA/source/release
      ↓
post-deploy gates (Fast / PWA / SideStore endpoint)
      ↓ on verification failure
conditional rollback (GitHub Pages / Cloudflare / SideStore latest)
```

三端发布应保持并行，post-deploy 必须验证刚发布的 exact commit，Release asset 不可变语义与三类 rollback 不能为了缩短 YAML 被删除。
