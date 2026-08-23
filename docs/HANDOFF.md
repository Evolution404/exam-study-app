# 项目交接文档

> 更新时间：2026-08-23（Asia/Shanghai）
> 项目：`/Users/zhangyuxi/Desktop/exam-study-app`
> 接手前先完整阅读本文，并运行 `git status --short`、`git log -5 --oneline`、`npm run typecheck`。

## 1. 当前基线

- 分支：`main`；远端：`https://github.com/Evolution404/exam-study-app.git`
- 线上：<https://evolution404.github.io/exam-study-app/>
- 技术栈：React 19、Vite 8、Dexie、PWA、GitHub Pages / Cloudflare Pages。
- 公开客户端数据层：独立 IndexedDB `shijuan-study-v7`（首次启动自动从旧 `shijuan-study-v6` 迁移）。
- 公开同步协议：Sync v9，唯一可变入口 `sync/v9/head.json`；UI 只通过 `src/lib/sync/github-sync.ts` 门面访问同步。
- 图片远端布局：`sync/v9/assets/index.json` + 4 个索引 shard + immutable Asset Pack；运行时不再使用逐图 `sync/v9/assets/<sha256>.<ext>` 布局。
- Service Worker 缓存版本：`shijuan-v10`。
- 支持平台：Desktop Web/PWA 与 Capacitor 8 + WKWebView iOS native App；iOS 复用同一 React/Dexie/Sync v9 业务代码，Bundle ID 固定为 `com.evolution404.shijuan`。
- iOS 构建：`APP_TARGET=ios` 使用 `./` 相对资源基路径；native 不注册 Service Worker，Native HTTP 未启用，网络仍走 WKWebView `fetch` 兼容路径。
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
  shell/       # 应用外壳：app-shell, navigation, topbar, helpers, views
  hooks/       # use-app-environment
  styles/      # components.css 只负责导入顺序；base/primitives/shared/shell/dashboard/search/
               # bank/practice/preferences/responsive/dark-overrides 为拆分后的主样式域；另有
               # theme-tokens, controls, content-blocks, review-scope, sync-events, hint
src/lib/       # 领域逻辑：db / sync / question / io / practice
src/platform/  # Web/iOS 平台适配：环境、运行时、transport、凭据、配置、生命周期、文件与反馈
proxy/         # GitHub API 转发代理源码
ios/           # Capacitor 生成的 iOS 原生壳（不承载业务页面）
functions/     # 构建生成：functions/api-github/[[path]].js（不要手写，由 emit-pages-relay 生成）
scripts/
  tools/       # 构建/检查/生成工具
  tests/       # 所有测试脚本
src/types/     # 全局类型声明
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
- 图片为私有资产：逻辑身份固定为 `assetId = SHA-256(image bytes)`；本地只存 Blob，不保存公开 URL。
- 图片远端物理存储只使用 Asset Pack：`sync/v9/assets/index.json` 只保存固定 4 个 shard descriptor；shard 保存 `assetId -> pack + offset/length + mime/size/dimensions`；Pack 目标约 8 MiB、最多 64 图，Pack 与 shard 都是内容寻址不可变 `.bin`。
- 图片发布禁止恢复逐图 Contents PUT。一轮待发布图片先聚合 Pack，再通过 Git Data API 一次创建 pack/shard/index tree，只生成 1 个 Git commit + 1 次 heads ref fast-forward；请求数按 Pack/shard 数量增长，不按图片张数增长。
- 旧逐图 `sync/v9/assets/<sha256>.<ext>` 不作为运行时兼容层。首次发现 Pack index 不存在时执行一次性迁移：优先使用本地 Blob；本地 Blob 缺失时只允许在迁移阶段从旧 Git blob 读取一次；新 Pack、shard、index 与旧单图路径删除必须在同一个 Git commit 中完成。迁移后本地 `remote` 仅可作为已经退役的迁移元数据被清理，运行时读取只走 Pack index。
- Excel/zip 导入只物化题目实际引用的图片，并在导入完成时把全部图片逻辑描述写进同一个固定 `question.import` 事件；图片物理发布不会按图片上传完成顺序新增 change set。
- 题库 Excel 导出必须从 UI `canonical.content/options` 读取富内容，并以 WPS `DISPIMG` + `xl/cellimages.xml` + `xl/media/*` 嵌入图片；导出先收集当前题库实际引用的 assetId，本地 Blob 缺失时通过 `syncApplication.downloadImageAssets(missingIds)` 一次批量解析 index/shard/unique packs，仍有缺图则中止导出，禁止逐图远端请求和静默生成纯文字文件。
- 题库便携导出无图时生成普通 JSON；只要题干或选项引用图片，就必须生成 `bank.json + images/*` 的 ZIP，并保留原图字节与格式（包括 WebP），以保证内容寻址文件名可校验、可完整回导。任一原图缺失时中止导出，禁止生成不完整压缩包。
- 全量图片缓存同样使用批量 Pack resolver：1 个 index、最多 4 个相关 shard、每个 unique Pack 最多读取一次；单图 UI 懒加载只是这一批量 resolver 的单 ID 包装。
- 同步固定 head：`sync/v9/head.json`；检查点、分段、对象、历史与 Asset Pack 不可变对象均在 v9 namespace 下。
- 会产生 change set 的领域写事务必须把 `syncMeta` 放进同一个 Dexie `rw` 事务；同步序号在当前事务内分配。禁止从领域写事务中另开 `syncMeta` 写事务，否则 Safari 会因 IndexedDB 写事务相互等待而卡住导入、作答等写操作。
- 冷启动恢复同时下载检查点和热窗口分段，总并发上限保持为 6；检查点按响应流字节持续上报下载进度，全部下载完成后仍按检查点再分段的确定顺序安装。
- `GitHubSettings.historySyncStart` 是设备本地的练习历史同步起点（`YYYY-MM-DD`）：题库内容始终完整同步，v9 历史索引按 `firstAt/lastAt` 跳过更早分块；本地缓存记录覆盖起点，配置变化必须重新安装相应窗口。远端历史不删除，扩大范围可重新补回。部分历史设备触发远端压实时必须另读完整投影生成检查点，禁止用局部投影覆盖远端档案。
- head 使用 ETag/SHA CAS；冲突时拉取、合并后重试，不覆盖并发设备数据。Asset Pack 发布独立使用 branch ref 的 fast-forward 检查，并在并发推进时重读后重试，不强推。
- `src/lib/sync/github-sync.ts` 是 UI 唯一公开同步门面；本地投影仍为 v7，远端 transport 已完整升级为 v9。
- 平台 transport 是同步网络的唯一适配入口：Cloudflare Pages 使用同源 `/api-github`，GitHub Pages 与 iOS 默认使用 `https://sync.980923.xyz`；iOS 允许用户显式配置自定义 Relay，但 Relay 失败不得静默直连 `https://api.github.com`。Sync v9 wire、head CAS、Asset Pack 和合并语义不因平台改变。
- iOS 业务数据仍写 `shijuan-study-v7` IndexedDB（不换 SQLite）；GitHub Token 只进 Keychain，少量非秘密配置可镜像到 Preferences / UserDefaults，均不得进入 vault。原生生命周期、haptics、Filesystem 与 Share 通过 `src/platform/` adapter 接入。
- GitHub API 代理源码在 `proxy/`；`functions/api-github/[[path]].js` 由构建自动生成，不手写。

## 4. 关键文件

- 数据模型：`src/lib/db/v7-types.ts`, `src/lib/db/db-v7.ts`, `src/lib/db/app-data-v7.ts`
- 同步协议：`src/lib/sync/sync-v7-head.ts`, `src/lib/sync/sync-v7-codec.ts`, `src/lib/sync/sync-v7-payload.ts`,
  `src/lib/sync/change-set-v7.ts`, `src/lib/sync/change-set-v7-projection.ts`, `src/lib/sync/change-set-v7-queue.ts`,
  `src/lib/sync/github-v7-remote.ts`, `src/lib/sync/github-sync-v7.ts`, `src/lib/sync/github-sync.ts`
- 图片 Pack：`src/lib/sync/image-asset-pack.ts`, `src/lib/sync/image-asset-cache.ts`, `src/lib/sync/sync-v7-upload.ts`,
  `scripts/tools/mock-github-server.mjs`, `scripts/tests/test-sync-mock-backend.ts`
- 进度与轮次：`src/lib/practice/progress-scope.ts`, `src/app/practice/progress-scope-setting.tsx`,
  `src/app/practice/review-round-manager.tsx`, `src/app/practice/practice-setup.tsx`
- 难度与有效计时：`src/lib/practice/practice-metrics.ts`, `src/lib/practice/active-elapsed-time.ts`,
  `src/app/shell/views/practice.tsx`
- 富内容与图片：`src/lib/io/image-assets.ts`, `src/lib/io/image-dimensions.ts`,
  `src/app/bank/content-block-editor.tsx`, `src/app/bank/content-block-renderer.tsx`, `src/app/ui/asset-image.tsx`
- 导入导出：`src/lib/io/xlsx-import.ts`, `src/lib/io/xlsx-export.ts`, `src/lib/question/question-bank-file-import.ts`,
  `src/lib/question/question-bank-export.ts`, `src/lib/question/question-bank-bundle.ts`, `src/app/bank/bank-library/bank-export-dialog.tsx`
- CSS 架构：`src/app/styles/components.css`, `scripts/tools/check-css-architecture.mjs`, `scripts/tools/css-architecture-baseline.json`
- Shell 边界：`src/app/shell/app-shell.tsx`, `src/app/shell/navigation.tsx`, `src/app/shell/topbar.tsx`

## 5. 代理与部署

- Pages Function 同源代理：Cloudflare Pages 默认 `同步中转地址 = /api-github`，源码 `proxy/pages-function.js`，构建生成 `functions/api-github/[[path]].js`。
- 独立 Worker 跨域代理：GitHub Pages 默认 `同步中转地址 = https://sync.980923.xyz`，源码 `proxy/worker.js`，部署命令：
  `npx wrangler deploy --config proxy/wrangler.toml`。
- iOS native 与 GitHub Pages 共用 `https://sync.980923.xyz` 默认 Relay；同步设置仍允许可信的自定义 Relay。Native HTTP 未启用，WKWebView fetch 通过统一 transport 访问 Relay。
- 两个代理共用 `proxy/github-relay-common.js`，剥除头清单、上游地址、`redirect: manual`、流式 body 与 `set-cookie` 处理必须保持一致。
- Relay 不是通用 GitHub API 代理。Asset Pack 只新增严格白名单：branch ref/commit read、blob/tree/commit create、heads ref fast-forward PATCH；不得放宽成任意 `/git/*`。20 MiB 请求体上限继续生效。
- GitHub Pages 只部署 `dist/`，不包含 Pages Function；Cloudflare Pages 部署 `dist/` + `functions/`。

## 6. 架构约束

`scripts/tools/check-architecture.mjs` 会检查：

1. 公开页面只使用 `shijuan-study-v7`，不导入旧 `lib/db.ts`。
2. 公开同步只读写 `sync/v9/*`；运行时代码不得访问已退役的 `sync/v7/*`、`sync/v8/*` 远端命名空间。
3. 页面不得重新使用 `Question.imageUrl` 或“图片地址”导入列。
4. `practiceRuns` 是唯一持久化练习进度；不得恢复 active session 双写。
5. 页面 CSS 使用主题令牌，不扩大硬编码颜色和 dark-mode 补丁预算。
6. `tsconfig.json` 的 unused 检查必须保持开启。
7. 修改前先看工作区，禁止 reset/checkout 覆盖用户或其他任务的改动。
8. iOS native 不注册 Service Worker；业务层不得因为 native 环境复制一套题库、练习或同步实现。
9. iOS Token 不落 `localStorage`；Keychain、Preferences、lifecycle、haptics、Filesystem、Share 只能经 `src/platform/` adapter 使用。
10. Native HTTP 未启用；所有 GitHub 请求仍经统一 `GitHubTransport` 与默认/自定义 Relay，禁止错误时静默直连 GitHub。
11. 图片运行时不得回退到逐图 `putImmutable` / `sync/v9/assets/<sha>.<ext>`；批量缓存和题库导出必须使用 Pack batch resolver。
12. Asset Pack 根索引不得保存不断增长的全量 assetId 列表；根入口只能保存固定 shard 指针，避免把请求优化重新变成单文件无限增长问题。

`scripts/tools/check-css-architecture.mjs` 会强制已拆分 CSS 文件存在、`components.css` 保持为纯导入入口、`:global()` 与 legacy token alias 保持为 0，并对总 CSS 体积、最大单文件、逐文件硬编码颜色、dark selector 与 `!important` 实施只降不升的基线棘轮。新增 CSS 文件默认不得带入这些历史债务。

`scripts/tools/check-export-surface.mjs` 对 Knip unused exports/types 使用只降不升棘轮；当前基线为 unused exports 137、unused exported types 46，CI 会在数字下降时要求提交收紧后的新基线。

`scripts/tools/check-no-native-tooltip-titles.mjs` 会检查 `src/` 中不得出现原生 `title=` 悬浮提示；统一使用 `src/app/ui/hint.tsx` 的 `Hint` 组件。

## 7. 验证与发布

常用命令：

```bash
make help                    # 全部命令
make dev                     # 启动开发服务器
make mock                    # 启动 mock GitHub 服务器
make browser-install         # 安装项目专用 Playwright Chromium
make test-fast               # 日常快测（不含构建）
make test                    # 完整 CI（含构建，不含浏览器）
make test-full               # 全量测试（含浏览器全部场景，默认 headless）
make test-browser-visible    # 可见专用 Chromium 跑全部浏览器场景
make test-browser-search     # 只跑搜索场景
make release-check           # 发布预检：全量测试 + PWA smoke，不提交、不推送
make release MSG="fix: ..." # 一键验证、提交、推送 main、等待 Actions 并核验线上版本
```

iOS 本地验证不依赖发布流程：

```bash
make ios-setup
make ios-open
make ios-run IOS_TARGET="你的模拟器或已连接设备名称"
make ios-build-simulator
make ios-ipa
make verify-ios
```

`ios-run` 要求显式 `IOS_TARGET`；`ios-build-simulator` 使用 `CODE_SIGNING_ALLOWED=NO`。首次 `ios-open` 后在 Xcode 选择自己的 Apple ID / Personal Team 并启用 Automatically manage signing。`make ios-ipa` 生成 `artifacts/ios/shijuan.ipa`，允许通过 `IOS_MARKETING_VERSION` 与 `IOS_BUILD_NUMBER` 覆盖并校验包内版本，供 SideStore 在设备端重新签名。

`make release` 会自动选择未占用的浏览器/PWA 测试端口，只暂存执行前展示的精确文件列表；若本地 `main` 落后远端、测试失败、部署失败或线上构建版本未更新，流程会停止并给出明确原因。常规发布优先使用该入口，不再手工拼接测试、提交、推送和部署检查命令。

推送 `main` 会触发 `.github/workflows/deploy-pages.yml`。如果只需独立核验线上缓存，可运行：

```bash
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/'
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/sw.js'
```

GitHub Actions 的发布顺序是“三端并行发布、统一验证”：公共 `build` 只安装依赖、构建并上传带 `current` 名称的产物；随后 GitHub Pages、Cloudflare Pages 与 `ios_release` 只依赖该公共构建，因此三路并行发布。同一提交的三端发布完成后，`fast-check`、`pwa_smoke` 与 `sidestore_smoke` 三个 job 并行验证。验证失败且当前 Pages 部署已成功时，工作流从 push 的 `github.event.before`（手动触发则使用 `HEAD^`）重新检出旧提交，注入旧提交 SHA 构建 `rollback` 产物并重新部署；如果构建或首次部署失败，则不会误触发回退。工作流仍保持 `pages` 并发组和 `cancel-in-progress: true`，旧任务不会覆盖新提交。

Pages 发布链固定使用原生 Node 24 的 `actions/configure-pages@v6`、`actions/upload-pages-artifact@v5` 与 `actions/deploy-pages@v5`；当前部署和回退部署必须同步升级，禁止退回会触发 Node 20 弃用警告的旧主版本。

`ios_release` 在 `macos-15` Runner 上与两个网页目标并行，为同一提交生成无签名 IPA。版本固定为 `1.0.<main 提交数>`，构建号为提交数；随后创建不可变 GitHub Release，并发布 `shijuan.ipa` 与 `sidestore-source.json`。Cloudflare Pages Function 在 `learn.980923.xyz` 提供稳定反向代理：更新源 `https://learn.980923.xyz/sidestore/source.json`、IPA `https://learn.980923.xyz/sidestore/shijuan.ipa`。三端发布后，`sidestore_smoke` 必须从这两个公网端点读回当前版本，否则发布任务失败。SideStore 只需添加一次更新源，后续每次推送 `main` 都会自动出现新版。

Cloudflare Pages 部署前会尽力记录当前 production deployment ID；IPA 发布前会记录此前最新的非草稿 Release 标签。三项发布后验证任一失败时，GitHub Pages 重建旧提交，Cloudflare 通过官方 `/deployments/{deployment_id}/rollback` API 恢复此前版本并清理边缘缓存，SideStore 则把 GitHub Release 的 `latest` 指针恢复到此前标签。失败 IPA 的不可变资产仍保留用于诊断，不会删除。Cloudflare 缺少凭据/旧 deployment ID 或首次 IPA 发布没有旧标签时，对应目标安全跳过回退，不影响其他目标的回退判断。

## 8. 已知非阻断项

- 构建已通过 vendor 分包将主入口控制在约 224 KiB，当前无 500 KiB 警告；后续若再增长，优先继续拆分大页面，不要只调高阈值。
- PR CI 覆盖 Playwright Chromium 与 WebKit smoke；Firefox、HEIC/GIF/SVG、透明图片和极端设备存储配额仍需单独矩阵，Safari 真机仍不能由 WebKit smoke 完全替代。
- 浏览器与 PWA 测试通过项目 Playwright 安装流程准备浏览器；不得恢复系统 Chrome 自动探测。`CHROME_PATH` 只允许作为显式调试覆盖，启动超时固定为 20 秒。
- 浏览器 QA 默认 headless，截图仍输出到 `artifacts/browser-qa/`；需要肉眼观看时使用 `make test-browser-visible` 或 `BROWSER_HEADLESS=0`。
- GitHub/Relay 首次 Pack 获取在中国大陆网络下仍取决于链路可达性；Pack 成功缓存后，同一运行时会按 pack SHA 复用内存缓存，图片 Blob 成功写入 Dexie 后答题不再访问 GitHub。
- npm 安装当前仍报告 3 个 moderate severity vulnerabilities；本轮 Asset Pack 迁移没有把它们作为阻断项处理，不能宣称依赖安全审计已清零。
- iOS Personal Team 签名、覆盖安装数据保持、深色模式、横竖屏、前后台 catch-up、文件 Share Sheet、真实 haptics 和多设备交叉同步需要连接 Xcode/真机按 `docs/TESTING.md` 手工检查；浏览器 e2e 不能替代它们。
- SideStore IPA 由 GitHub Actions 无签名构建，设备端仍需 SideStore 与用户 Apple ID 完成重新签名；免费账号的签名有效期与可安装 App 数量限制不由本项目改变。

## 9. 新任务第一步

> 请先完整阅读 `docs/HANDOFF.md`，运行 `git status --short`、`git log -5 --oneline` 和 `npm run typecheck`。公开应用使用 v7 本地 DB / v9 远端 Sync；保持一题一次提交事件、全局题目/成员关系、默认滚动 90 天和本地 Blob 图片边界。图片远端只允许 `index → shard → immutable Pack`，不得恢复逐图远端路径或双栈兼容。若涉及 iOS，先确认 `make ios-build` 使用 `APP_TARGET=ios` 与 `./` 基路径，并确认 native 不注册 Service Worker、默认 Relay 为 `https://sync.980923.xyz`。
