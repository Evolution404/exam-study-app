# 项目交接文档

> 更新时间：2026-08-15（Asia/Shanghai）
> 项目：`/Users/zhangyuxi/Desktop/exam-study-app`
> 接手前先完整阅读本文，并运行 `git status --short`、`git log -5 --oneline`、`npm run typecheck`。

## 1. 当前基线

- 分支：`main`；远端：`https://github.com/Evolution404/exam-study-app.git`
- 线上：<https://evolution404.github.io/exam-study-app/>
- 技术栈：React 19、Vite 8、Dexie、PWA、GitHub Pages / Cloudflare Pages。
- 公开客户端数据层：独立 IndexedDB `shijuan-study-v6`。
- 公开同步协议：Sync v7，唯一可变入口 `sync/v7/head.json`；UI 只通过 `src/lib/sync/github-sync.ts` 门面访问同步。
- Service Worker 缓存版本：`shijuan-v9`。
- 页面已验收：整页切题动画、夜间输入框、快捷键、计算题、结果详情、解析自动保存、随机指定题数、静默同步、清除站点数据、热窗口可视化。

## 2. 目录结构

```text
src/app/
  ui/          # 通用 UI：app-select, confirm-dialog, hint, modal-portal, scope-summary-chips,
               # shortcut-setting, asset-image, math-text, note-markdown
  practice/    # practice-setup, practice-history, review-round-manager,
               # progress-scope-setting, use-smooth-progress
  search/      # search-view, search-filter-drawer, quick-search
  bank/        # bank-library-view, question-editor, question-detail,
               # content-block-editor, content-block-renderer, excel-import, knowledge-view
  sync/        # sync-view, sync-event-manager, sync-event-drawer, sync-hot-window
  study-app.tsx
  hooks/       # use-app-environment
  styles/      # theme-tokens.css, components.css, controls.css, content-blocks.css,
               # review-scope.css, sync-events.css, hint.css
src/lib/       # 领域逻辑：db / sync / question / io / practice
proxy/         # GitHub API 转发代理源码
functions/     # 构建生成：functions/api-github/[[path]].js（不要手写，由 emit-pages-relay 生成）
scripts/
  tools/       # 构建/检查/生成工具
  tests/       # 所有测试脚本
src/           # 应用源码：app / lib / types / main.tsx / generated
public/        # 静态资源与 PWA
docs/          # 项目文档
```

## 3. 数据模型与同步边界

- `QuestionV6` 是全局实体；题库归属通过 `BankQuestionMembership` 保存。
- 删除题库只删除成员关系；无成员的题显示在“未归档题目”。
- 进度口径：滚动 90 天、永久、30/90/180 天、自定义天数、命名轮次。
- 一次答题只写一条 `practice.answer.submitted`，同一事务更新作答、终身统计、练习答案和当前轮次进度。
- 图片为私有资产：本地只存 Blob，不保存公开 URL；远端路径为 `sync/v7/assets/<sha256>.<ext>`。
- 同步固定 head：`sync/v7/head.json`；检查点、分段、对象、图片均为内容寻址不可变对象。
- head 使用 ETag/SHA CAS；冲突时拉取、合并后重试，不覆盖并发设备数据。
- `src/lib/sync/github-sync.ts` 是 UI 唯一公开同步门面，只委托 v7 transport。
- GitHub API 代理源码在 `proxy/`；`functions/api-github/[[path]].js` 由构建自动生成，不手写。

## 4. 关键文件

- 数据模型：`src/lib/db/v6-types.ts`, `src/lib/db/db-v6.ts`, `src/lib/db/app-data-v6.ts`
- 同步协议：`src/lib/sync/sync-v7-head.ts`, `src/lib/sync/sync-v7-codec.ts`, `src/lib/sync/sync-v7-payload.ts`,
  `src/lib/sync/change-set-v7.ts`, `src/lib/sync/change-set-v7-projection.ts`, `src/lib/sync/change-set-v7-queue.ts`,
  `src/lib/sync/github-v7-remote.ts`, `src/lib/sync/github-sync-v7.ts`, `src/lib/sync/github-sync.ts`
- 进度与轮次：`src/lib/practice/progress-scope.ts`, `src/app/practice/progress-scope-setting.tsx`,
  `src/app/practice/review-round-manager.tsx`, `src/app/practice/practice-setup.tsx`
- 富内容与图片：`src/lib/io/image-assets.ts`, `src/lib/sync/image-asset-cache.ts`, `src/lib/io/image-dimensions.ts`,
  `src/app/bank/content-block-editor.tsx`, `src/app/bank/content-block-renderer.tsx`, `src/app/ui/asset-image.tsx`
- 导入导出：`src/lib/io/xlsx-import.ts`, `src/lib/io/xlsx-export.ts`, `src/lib/question/question-bank-file-import.ts`,
  `src/lib/question/question-bank-export.ts`, `src/lib/question/question-bank-bundle.ts`

## 5. 代理与部署

- Pages Function 同源代理：应用默认 `同步中转地址 = /api-github`，源码 `proxy/pages-function.js`，构建生成 `functions/api-github/[[path]].js`。
- 独立 Worker 跨域代理：`proxy/worker.js`，域名 `sync.980923.xyz`，部署命令：
  `npx wrangler deploy --config proxy/wrangler.toml`。
- 两个代理共用 `proxy/github-relay-common.js`，剥除头清单、上游地址、`redirect: manual` 和 `set-cookie` 处理必须保持一致。
- GitHub Pages 只部署 `dist/`，不包含 Pages Function；Cloudflare Pages 部署 `dist/` + `functions/`。

## 6. 架构约束

`scripts/tools/check-architecture.mjs` 会检查：

1. 公开页面只使用 `shijuan-study-v6`，不导入旧 `lib/db.ts`。
2. 公开同步只写 `sync/v7/head.json`，不保留 v1/v2/v5/v6 传输回退。
3. 页面不得重新使用 `Question.imageUrl` 或“图片地址”导入列。
4. `practiceRuns` 是唯一持久化练习进度；不得恢复 active session 双写。
5. 页面 CSS 使用主题令牌，不扩大硬编码颜色和 dark-mode 补丁预算。
6. `tsconfig.json` 的 unused 检查必须保持开启。
7. 修改前先看工作区，禁止 reset/checkout 覆盖用户或其他任务的改动。

`scripts/tools/check-no-native-tooltip-titles.mjs` 会检查 `src/` 中不得出现原生 `title=` 悬浮提示；统一使用 `src/app/ui/hint.tsx` 的 `Hint` 组件。

## 7. 验证与发布

常用命令：

```bash
make help                    # 全部命令
make dev                     # 启动开发服务器
make mock                    # 启动 mock GitHub 服务器
make test-fast               # 日常快测（不含构建）
make test                    # 完整 CI（含构建，不含浏览器）
make test-full               # 全量测试（含浏览器全部场景，默认 headless）
make test-browser-visible    # 可见 Chrome 跑全部浏览器场景
make test-browser-search     # 只跑搜索场景
```

推送 `main` 会触发 `.github/workflows/deploy-pages.yml`：

```bash
git status --short
make test-full
git add -A
git commit -m "..."
git push origin main
```

部署后应运行：

```bash
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/'
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/sw.js'
```

## 8. 已知非阻断项

- 构建仍提示主入口约 714 KiB（gzip 约 221 KiB）高于 500 KiB；同步、KaTeX 和大页面已拆包，后续应拆分设置/练习组件，不要只调高阈值。
- 自动化覆盖 Chromium 桌面/手机视口；Safari、Firefox、HEIC/GIF/SVG、透明图片和极端设备存储配额仍需单独矩阵。
- 浏览器 QA 默认 headless，截图仍输出到 `artifacts/browser-qa/`；需要肉眼观看时使用 `make test-browser-visible` 或 `BROWSER_HEADLESS=0`。
- GitHub API 首次图片获取在中国大陆网络下仍取决于 GitHub 可达性；成功缓存后答题不再访问 GitHub。

## 9. 新任务第一步

> 请先完整阅读 `docs/HANDOFF.md`，运行 `git status --short`、`git log -5 --oneline` 和 `npm run typecheck`。公开应用只使用 v6 DB / v7 Sync；保持一题一次提交事件、全局题目/成员关系、默认滚动 90 天和本地 Blob 图片边界。
