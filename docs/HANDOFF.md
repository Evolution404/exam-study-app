# 项目交接文档

> 更新时间：2026-08-21（Asia/Shanghai）
> 项目：`/Users/zhangyuxi/Desktop/exam-study-app`
> 接手前先完整阅读本文，并运行 `git status --short`、`git log -5 --oneline`、`npm run typecheck`。

## 1. 当前基线

- 分支：`main`；远端：`https://github.com/Evolution404/exam-study-app.git`
- 线上：<https://evolution404.github.io/exam-study-app/>
- 技术栈：React 19、Vite 8、Dexie、PWA、GitHub Pages / Cloudflare Pages。
- 公开客户端数据层：独立 IndexedDB `shijuan-study-v7`（首次启动自动从旧 `shijuan-study-v6` 迁移）。
- 公开同步协议：Sync v8，唯一可变入口 `sync/v8/head.json`；UI 只通过 `src/lib/sync/github-sync.ts` 门面访问同步。
- Service Worker 缓存版本：`shijuan-v10`。
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
  shell/        # 应用外壳：app-shell, helpers, views
  hooks/       # use-app-environment
  styles/      # theme-tokens.css, components.css, controls.css, content-blocks.css,
               # review-scope.css, sync-events.css, hint.css
src/lib/       # 领域逻辑：db / sync / question / io / practice
proxy/         # GitHub API 转发代理源码
functions/     # 构建生成：functions/api-github/[[path]].js（不要手写，由 emit-pages-relay 生成）
scripts/
  tools/       # 构建/检查/生成工具
  tests/       # 所有测试脚本
src/types/      # 全局类型声明
public/        # 静态资源与 PWA
docs/          # 项目文档
```

## 3. 数据模型与同步边界

- `QuestionV7` 是全局实体；题库归属通过 `BankQuestionMembership` 保存。
- 删除题库只删除成员关系；无成员的题显示在“未归档题目”。
- 进度口径：滚动 90 天、永久、30/90/180 天、自定义天数、命名轮次。
- 一次答题只写一条 `practice.answer.submitted`，同一事务更新作答、终身统计、练习答案和当前轮次进度。
- 个人难度以有效作答时间、作答间隔和本机成熟历史校准；后台、编辑器、题目总览不计时，速度基线只吸收有效正确作答。未作答固定为 50。
- `difficulty` 是个人掌握风险；“复习优先”排序使用独立 `reviewPriority`（个人难度 70% + 距上次作答风险 30%）。新轮次进度保存最近作答证据，与普通练习使用同一难度口径。
- 图片为私有资产：本地只存 Blob，不保存公开 URL；远端路径为 `sync/v8/assets/<sha256>.<ext>`。
- 同步固定 head：`sync/v8/head.json`；检查点、分段、对象、图片均为内容寻址不可变对象。
- 会产生 change set 的领域写事务必须把 `syncMeta` 放进同一个 Dexie `rw` 事务；同步序号在当前事务内分配。禁止从领域写事务中另开 `syncMeta` 写事务，否则 Safari 会因 IndexedDB 写事务相互等待而卡住导入、作答等写操作。
- 冷启动恢复同时下载检查点和热窗口分段，总并发上限保持为 6；检查点按响应流字节持续上报下载进度，全部下载完成后仍按检查点再分段的确定顺序安装。
- `GitHubSettings.historySyncStart` 是设备本地的练习历史同步起点（`YYYY-MM-DD`）：题库内容始终完整同步，v8 历史索引按 `firstAt/lastAt` 跳过更早分块；本地缓存记录覆盖起点，配置变化必须重新安装相应窗口。远端历史不删除，扩大范围可重新补回。部分历史设备触发远端压实时必须另读完整投影生成检查点，禁止用局部投影覆盖远端档案。
- head 使用 ETag/SHA CAS；冲突时拉取、合并后重试，不覆盖并发设备数据。
- `src/lib/sync/github-sync.ts` 是 UI 唯一公开同步门面；本地投影仍为 v7，远端 transport 已完整升级为 v8。
- 一次性远端迁移使用 `npm run migrate:vault:v8 -- --owner <owner> --repo <repo> --branch main`；先加 `--verify` 预检。迁移固定旧 v7 head SHA、严格回放热分段、复制资产、发布 v8 有界检查点，并保留旧 `sync/v7` 数据。
- GitHub API 代理源码在 `proxy/`；`functions/api-github/[[path]].js` 由构建自动生成，不手写。

## 4. 关键文件

- 数据模型：`src/lib/db/v7-types.ts`, `src/lib/db/db-v7.ts`, `src/lib/db/app-data-v7.ts`
- 同步协议：`src/lib/sync/sync-v7-head.ts`, `src/lib/sync/sync-v7-codec.ts`, `src/lib/sync/sync-v7-payload.ts`,
  `src/lib/sync/change-set-v7.ts`, `src/lib/sync/change-set-v7-projection.ts`, `src/lib/sync/change-set-v7-queue.ts`,
  `src/lib/sync/github-v7-remote.ts`, `src/lib/sync/github-sync-v7.ts`, `src/lib/sync/github-sync.ts`
- 进度与轮次：`src/lib/practice/progress-scope.ts`, `src/app/practice/progress-scope-setting.tsx`,
  `src/app/practice/review-round-manager.tsx`, `src/app/practice/practice-setup.tsx`
- 难度与有效计时：`src/lib/practice/practice-metrics.ts`, `src/lib/practice/active-elapsed-time.ts`,
  `src/app/shell/views/practice.tsx`
- 富内容与图片：`src/lib/io/image-assets.ts`, `src/lib/sync/image-asset-cache.ts`, `src/lib/io/image-dimensions.ts`,
  `src/app/bank/content-block-editor.tsx`, `src/app/bank/content-block-renderer.tsx`, `src/app/ui/asset-image.tsx`
- 导入导出：`src/lib/io/xlsx-import.ts`, `src/lib/io/xlsx-export.ts`, `src/lib/question/question-bank-file-import.ts`,
  `src/lib/question/question-bank-export.ts`, `src/lib/question/question-bank-bundle.ts`

## 5. 代理与部署

- Pages Function 同源代理：Cloudflare Pages 默认 `同步中转地址 = /api-github`，源码 `proxy/pages-function.js`，构建生成 `functions/api-github/[[path]].js`。
- 独立 Worker 跨域代理：GitHub Pages 默认 `同步中转地址 = https://sync.980923.xyz`，源码 `proxy/worker.js`，部署命令：
  `npx wrangler deploy --config proxy/wrangler.toml`。
- 两个代理共用 `proxy/github-relay-common.js`，剥除头清单、上游地址、`redirect: manual` 和 `set-cookie` 处理必须保持一致。
- GitHub Pages 只部署 `dist/`，不包含 Pages Function；Cloudflare Pages 部署 `dist/` + `functions/`。

## 6. 架构约束

`scripts/tools/check-architecture.mjs` 会检查：

1. 公开页面只使用 `shijuan-study-v7`，不导入旧 `lib/db.ts`。
2. 公开同步只读写 `sync/v8/*`；旧 `sync/v7/*` 只能由隔离的一次性迁移工具读取。
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
make release-check           # 发布预检：全量测试 + PWA smoke，不提交、不推送
make release MSG="fix: ..." # 一键验证、提交、推送 main、等待 Actions 并核验线上版本
```

`make release` 会自动选择未占用的浏览器/PWA 测试端口，只暂存执行前展示的精确文件列表；若本地 `main` 落后远端、测试失败、部署失败或线上构建版本未更新，流程会停止并给出明确原因。常规发布优先使用该入口，不再手工拼接测试、提交、推送和部署检查命令。

推送 `main` 会触发 `.github/workflows/deploy-pages.yml`。如果只需独立核验线上缓存，可运行：

```bash
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/'
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/sw.js'
```

GitHub Actions 的发布顺序是“先部署、后验证”：`build` 只安装依赖、构建并上传带 `current` 名称的产物，GitHub Pages 部署完成后，`fast-check` 与 `pwa_smoke` 两个 job 并行执行。验证失败且当前 Pages 部署已成功时，工作流从 push 的 `github.event.before`（手动触发则使用 `HEAD^`）重新检出旧提交，注入旧提交 SHA 构建 `rollback` 产物并重新部署；如果构建或首次部署失败，则不会误触发回退。工作流仍保持 `pages` 并发组和 `cancel-in-progress: true`，旧任务不会覆盖新提交。

Cloudflare Pages 部署前会尽力记录当前 production deployment ID。若配置了 `CLOUDFLARE_API_TOKEN` 与 `CLOUDFLARE_ACCOUNT_ID`，验证失败时通过官方 `/deployments/{deployment_id}/rollback` API 恢复此前版本，并清理边缘缓存；缺少凭据或无法取得旧 ID 时安全跳过 Cloudflare 回退，不影响 GitHub Pages 的回退判断。

## 8. 已知非阻断项

- 构建已通过 vendor 分包将主入口降至 352 KiB（gzip 约 110 KiB），当前无 500 KiB 警告；后续若再增长，优先继续拆分大页面，不要只调高阈值。
- 自动化覆盖 Chromium 桌面/手机视口；Safari、Firefox、HEIC/GIF/SVG、透明图片和极端设备存储配额仍需单独矩阵。
- 浏览器 QA 默认 headless，截图仍输出到 `artifacts/browser-qa/`；需要肉眼观看时使用 `make test-browser-visible` 或 `BROWSER_HEADLESS=0`。
- GitHub API 首次图片获取在中国大陆网络下仍取决于 GitHub 可达性；成功缓存后答题不再访问 GitHub。

## 9. 新任务第一步

> 请先完整阅读 `docs/HANDOFF.md`，运行 `git status --short`、`git log -5 --oneline` 和 `npm run typecheck`。公开应用只使用 v7 DB / v7 Sync；保持一题一次提交事件、全局题目/成员关系、默认滚动 90 天和本地 Blob 图片边界。
