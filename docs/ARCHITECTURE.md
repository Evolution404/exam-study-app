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
├── study-app.tsx          # 应用路由状态与跨页面编排，不承载同步实现和浏览器环境细节
├── ui/                    # 通用 UI：app-select, confirm-dialog, hint, modal-portal,
│                          # scope-summary-chips, shortcut-setting, asset-image, math-text, note-markdown
├── practice/              # 练习：practice-setup, practice-history, review-round-manager,
│                          # progress-scope-setting, use-smooth-progress
├── search/                # 搜索：search-view, search-filter-drawer, quick-search
├── bank/                  # 题库：bank-library-view, question-editor, question-detail,
│                          # content-block-editor, content-block-renderer, excel-import, knowledge-view
├── sync/                  # 同步 UI：sync-view, sync-event-manager, sync-event-drawer, sync-hot-window
├── hooks/                 # 跨页面浏览器能力；主题解析和移动端可视区域统一由 use-app-environment 管理
└── styles/                # 全局与组件样式；theme-tokens.css 是日间/夜间唯一的语义颜色来源
```

## 平台适配层 `src/platform/`

平台差异集中在 adapter，不向 React 业务页面扩散：

```text
src/platform/
├── environment.ts          # Web / Capacitor native / iOS 检测
├── runtime.ts              # native 启动、Status Bar、Service Worker 边界
├── github-transport.ts     # 统一 GitHub 请求入口（Web 与 WKWebView 共用）
├── secure-credentials.ts   # Web 存储与 iOS Keychain 的凭据适配
├── persistent-config.ts    # Preferences / UserDefaults mirror
├── lifecycle.ts            # iOS 前后台事件与同步 catch-up
├── haptics.ts              # 震动反馈适配
└── files.ts                # Filesystem 导入与 Share Sheet 导出适配
```

Web/PWA 使用浏览器能力；iOS 使用 Capacitor 插件，但业务层仍只依赖抽象接口。iOS 工程固定由 `capacitor.config.ts` 声明为 `com.evolution404.shijuan` / `拾卷`，不包含独立的 iOS React 页面。`npm run build:ios` 以 `APP_TARGET=ios` 构建相对资源基路径 `./`，再由 `npx cap sync ios` 将产物复制到 WKWebView 壳中。

平台边界有三条硬规则：

- native WKWebView 不注册 Service Worker；PWA 缓存只属于浏览器 Web 构建。
- iOS 同步使用 WKWebView 可用的 `fetch` 兼容路径；Native HTTP 未启用，不能绕过统一 transport 或 Relay。
- 只有 adapter 读取 Keychain、Preferences、App lifecycle、Haptics、Filesystem 和 Share；Dexie、Sync v9、题型与练习领域代码不分叉。

## 领域层 `src/lib/`

```text
src/lib/
├── db/        # db-v7（barrel）+ db-v7-core/change-sets/bank/question/
│              # practice/practice-stats/images/restore + app-data-v7 + v7-types
├── sync/      # github-sync（门面）+ github-sync-v7（barrel）+
│              # sync-v7-context/cache/checkpoint-bridge/download/upload/
│              # coalesce/watermark/orchestrator/tools + image-asset-cache/image-asset-pack +
│              # sync-v7-head/codec/payload/checkpoint + change-set-v7 及
│              # change-set-v7-projection（barrel）/core/cascade/derived/reducer
├── question/  # question-content, question-utils, question-overview, question-bank-*
├── io/        # xlsx-import, xlsx-export, image-assets, image-dimensions
└── practice/  # practice-metrics, practice-resume, progress-scope, answer-submission,
               # keyboard-shortcuts, press-intent, notice-tone, display-typography, note-markdown
```

所有领域计算不依赖 React 页面。

## 类型声明 `src/types/`

```text
src/types/
├── build-info.d.ts   # Vite 构建注入的全局常量声明（__APP_COMMIT_SHA__ / __APP_COMMIT_TIME__）
└── types.ts          # 全局共享领域类型（QuestionType, Bank, GitHubSettings 等）
```

`v7-types.ts` 仍留在 `src/lib/db/`，因为它描述的是 v7 数据模型；`db-v7.ts` 现在只是 barrel，实现分布在 `db-v7-*` 子模块中。

## 入口与启动恢复 `src/main.tsx`

- 挂载 React 应用 `StudyApp`
- 引入 `src/app/globals.css` 和 `src/generated/title-font.css`
- 等待 `dbV7Ready` 后挂载 `AppErrorBoundary`；数据库迁移或懒加载失败时显示 `AppRecoveryScreen`，只提供重试和导出/清除提示，不会自动删除 IndexedDB、Storage 或 Cookie。
- 生产 Web 环境注册 `/sw.js`，使用 `updateViaCache: "none"` 让新部署的 worker 尽快生效；native 环境由 `src/platform/runtime.ts` gate 掉 Service Worker 注册。

Web 端 GitHub 令牌由 `src/lib/sync/github-credentials.ts` 持久保存在当前设备浏览器的 `localStorage`，直到用户主动清除；iOS native 端由 `src/platform/secure-credentials.ts` 转存 Keychain，不让令牌落入 `localStorage`。令牌不进入题库快照或同步对象。非秘密配置可由 `src/platform/persistent-config.ts` 镜像到 Preferences / UserDefaults，但业务数据仍只写 Dexie。共享设备应在“同步”页清除本机数据，外部中转地址也应只使用可信部署。

## 代理层 `proxy/`

两个 GitHub API 转发入口共用同一份公共逻辑：

```text
proxy/
├── github-relay-common.js   # 公共转发逻辑：GitHub API 白名单、剥除头、流式 Request、响应回传
├── pages-function.js        # 同域名转发入口（Cloudflare Pages Function，/api-github/*）
├── worker.js                # 跨域名转发入口（Cloudflare Worker，sync.980923.xyz）
└── wrangler.toml            # Worker 部署配置
```

Relay 不是通用 GitHub API 代理。除既有 Contents/Blob 同步面外，Asset Pack 只额外开放 branch ref/commit read、blob/tree/commit create 和非强制 heads ref fast-forward PATCH；请求体上限保持 20 MiB。`functions/api-github/[[path]].js` 由 `npm run build`（或 `npm run relay:pages`）自动生成，不手写。

## 测试与工具

```text
scripts/
├── tools/   # subset-title-font, emit-pages-relay, check-architecture,
│            # check-test-registration, check-no-native-tooltip-titles,
│            # check-export-surface, check-css-architecture, chrome-executable,
│            # mock-github-server, generate-xlsx-template
└── tests/   # 所有 test-*.ts / test-browser-visible.mjs
```

## 当前数据与同步格式

- 客户端只使用 IndexedDB v7（`shijuan-study-v7`）。
- 客户端无论是浏览器还是 iOS WKWebView，都使用同一个 `shijuan-study-v7`；iOS 不迁移到 SQLite，也不另建业务数据库。
- 公开同步协议为 Sync v9：head 固定为 `sync/v9/head.json`，检查点、分段、对象、历史与资产全部位于 `sync/v9/`，统一 GitHub transport 通过 `proxy/` 或用户配置的中转地址访问。
- 图片逻辑身份固定为 `assetId = SHA-256(image bytes)`；本地仍以 Blob 缓存图片，不保存公开 URL。
- 图片远端物理布局只使用 Asset Pack：`sync/v9/assets/index.json` 是固定入口，只保存 4 个 shard descriptor；shard 保存 `assetId -> pack + offset/length + mime/size/dimensions`；约 8 MiB、最多 64 图的 Pack 与 shard 均按内容寻址存储为不可变 `.bin`。
- 一轮图片发布通过 Git Data API 创建 pack/shard/index tree，并只生成 1 个 Git commit + 1 次 ref fast-forward；禁止恢复 `N 张图 = N 次 Contents PUT = N 个 commit`。
- 如果仓库仍只有旧的 `sync/v9/assets/<sha256>.<ext>` 单图布局，首次需要图片发布的同步会执行一次性 Pack 化：优先使用本地 Blob，本地缺失时允许把旧 Git blob 作为迁移源读取一次；新 Pack、shard、index 和旧单图路径删除在同一个 Git commit 中安装。迁移成功后运行时不再读取旧单图路径，也不保留双栈兼容。
- 单图懒加载、全量图片缓存和题库导出都复用 Asset Pack resolver；批量场景先按 assetId 聚合 shard 与 unique pack，并发下载每个 Pack 一次，不逐图建立远端请求链。
- Relay 默认按部署环境选择：Cloudflare Pages 使用 `/api-github`；GitHub Pages 与 iOS native 默认使用 `https://sync.980923.xyz`。iOS 可以显式配置自定义 Relay，但 Relay 失败不会静默切换到 `https://api.github.com`。
- 正常同步不保留 v1/v2/v5/v6/v7/v8 远端传输回退；本地领域模型命名保持 v7，不代表远端协议仍兼容旧版本。
- 旧 `shijuan-study-v6` 本地库会在启动时一次性迁移到 `shijuan-study-v7`；本地领域模型保持 v7，远端公开 namespace 只允许 Sync v9。

## iOS 文件、生命周期与反馈

- App 前后台事件由 lifecycle adapter 触发有限的前台 catch-up pull；后台不启动持续同步，也不因切换产生并发 sync 风暴。
- 练习反馈的 haptics 由 Capacitor Haptics adapter 提供；没有插件或在 Web 环境时退回浏览器/无震动行为，不能影响答题事务。
- JSON/XLSX/ZIP 导入和导出继续复用现有领域解析与 Dexie 写事务；iOS 导入第一版继续使用 WKWebView 的 `<input type="file">` 与系统 Files picker，导出才由 Filesystem adapter 写入临时文件并打开 Share Sheet。
- 这些原生能力只处理设备边界，不改变题库模型、Sync v9 wire format、head CAS 或 Asset Pack 物理布局；图片始终以本地 Blob + 远端 Pack 索引解析，不为 iOS 分叉第二套图片存储协议。

## 主题规则

新组件必须使用 `--color-*` 语义令牌，不得在新样式文件中硬编码颜色，也不得新增 `html[data-theme="dark"]` 页面补丁。`npm test` 会先执行架构检查，防止主题覆盖再次退化。

## iOS 构建与重新签名边界

```text
make ios-setup              # 检查 Xcode、构建并同步 Capacitor 工程
make ios-open               # 构建后打开 Xcode
make ios-run IOS_TARGET=…   # 运行到明确指定的模拟器/设备
make ios-build-simulator    # CODE_SIGNING_ALLOWED=NO 的模拟器编译
make verify-ios             # iOS 构建、平台专项测试与模拟器编译
```

首次使用 `make ios-open` 后，在 Xcode 的 Signing & Capabilities 选择用户自己的 Apple ID / Personal Team，保持 Automatically manage signing，再选择 iPhone Run。Team ID 和证书不提交仓库。当前没有经过验证的 unsigned IPA / SideStore 目标，稳定支持路径是 Xcode Personal Team；真机行为仍需按 `docs/TESTING.md` 的 checklist 手工验收。
