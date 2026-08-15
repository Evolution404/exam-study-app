# 工程结构

## 顶层目录

```text
src/         # 应用源码（app + lib + 入口 + 类型声明）
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

## 领域层 `src/lib/`

```text
src/lib/
├── db/        # db-v6, app-data-v6, v6-types
├── sync/      # github-sync*, github-v7-remote, github-credentials, sync-v6-*, sync-v7-*,
│              # change-set-v7*, image-asset-cache, site-data-reset
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

`v6-types.ts` 仍留在 `src/lib/db/`，因为它描述的是 v6 数据模型，和 `db-v6.ts`、`app-data-v6.ts` 强耦合。

## 入口 `src/main.tsx`

- 挂载 React 应用 `StudyApp`
- 引入 `src/app/globals.css` 和 `src/generated/title-font.css`
- 生产环境注册 `/sw.js`

## 代理层 `proxy/`

两个 GitHub API 转发入口共用同一份公共逻辑：

```text
proxy/
├── github-relay-common.js   # 公共转发逻辑：上游地址、剥除头清单、构造上游 Request、响应回传
├── pages-function.js        # 同域名转发入口（Cloudflare Pages Function，/api-github/*）
├── worker.js                # 跨域名转发入口（Cloudflare Worker，sync.980923.xyz）
└── wrangler.toml            # Worker 部署配置
```

`functions/api-github/[[path]].js` 由 `npm run build`（或 `npm run relay:pages`）自动生成，不手写。

## 测试与工具

```text
scripts/
├── tools/   # subset-title-font, emit-pages-relay, check-architecture,
│            # check-no-native-tooltip-titles, mock-github-server,
│            # migrate-vault-compressed, generate-xlsx-template
└── tests/   # 所有 test-*.ts / test-browser-visible.mjs
```

## 当前数据与同步格式

- 客户端只使用 IndexedDB v6（`shijuan-study-v6`）。
- 公开同步协议为 Sync v7：head 固定为 `sync/v7/head.json`，不可变对象走内容寻址，GitHub transport 通过 `proxy/` 或用户配置的中转地址访问。
- 不保留 v1/v2/v5/v6 传输回退和旧迁移链。

## 主题规则

新组件必须使用 `--color-*` 语义令牌，不得在新样式文件中硬编码颜色，也不得新增 `html[data-theme="dark"]` 页面补丁。`npm test` 会先执行架构检查，防止主题覆盖再次退化。
