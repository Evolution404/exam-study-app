# 项目交接文档

> 更新时间：2026-08-11（Asia/Shanghai）
> 项目：`/Users/zhangyuxi/Desktop/exam-study-app`
> 接手前先完整阅读本文，并运行 `git status --short`、`git log -5 --oneline`。

## 1. 当前基线

- 分支：`main`；远端：`https://github.com/Evolution404/exam-study-app.git`
- 线上：<https://evolution404.github.io/exam-study-app/>
- 技术栈：React、Vite、Dexie、PWA、GitHub Pages。
- 公开客户端数据层：独立 IndexedDB `shijuan-study-v6`，schema version `1`。
- 公开同步协议：Sync v6，唯一可变入口 `sync/v6/head.json`。
- `lib/db.ts`、`lib/github-sync-v5.ts` 等 v5 文件只用于迁移源和回归测试；应用页面不得导入旧 DB，公开同步门面不得写 v5。
- Service Worker 缓存版本：`shijuan-v7`。
- 页面仍保留此前已验收的整页切题动画、夜间输入框、快捷键、计算题、结果详情、解析自动保存、随机指定题数、静默同步和清除站点数据。

## 2. v6 数据模型

### 全局题目与题库成员关系

- `QuestionV6` 是全局实体；不再保存 `bankId`、`bankName`、`sortOrder` 或公开 `imageUrl`。
- `BankQuestionMembership` 保存 `${bankId}:${questionId}`、题库归属和排序。
- 多题库选择时按全局 `questionId` 去重。
- 删除题库只删除成员关系；无成员的题显示在“未归档题目”。
- 题库内可“从当前题库移除”或“全局删除题目及学习记录”。
- 编辑共享题时必须选择同步修改或分裂到指定题库；分裂复制题目、标签、收藏和解析，不复制历史。
- 导入按题型、规范化文字块、选项、答案和图片资产指纹精确合并，指纹不含题库名。

核心文件：

- `lib/v6-types.ts`
- `lib/db-v6.ts`
- `lib/app-data-v6.ts`
- `lib/question-content.ts`
- `app/question-editor.tsx`

### 周期进度与命名轮次

- 默认进度口径为滚动 90 天；另有永久、30/90/180 天、自定义天数和命名轮次。
- 口径只影响已做/未做和完成度；正确率、难度、累计作答继续使用终身统计。
- 命名轮次可并行，绑定多个题库，进行中动态读取成员并按题去重。
- `PracticeRunV6.reviewRoundId` 决定一次练习推进哪个轮次；普通练习不推进命名轮次。
- 完成轮次保存 `finalQuestionIds`，以后题库成员变化不改变历史快照。
- 一次答题仍只写一条 `practice.answer.submitted`，同一事务更新作答、终身统计、练习答案和当前轮次进度。
- 未提交选择、翻页和 `savePracticeProgressV6` 不产生同步事件。

核心文件：

- `lib/progress-scope.ts`
- `app/progress-scope-setting.tsx`
- `app/review-round-manager.tsx`
- `app/practice-setup.tsx`
- `app/study-app.tsx`

### 富内容与私有图片

- 题干与每个选项均为 `ContentBlock[]`，支持文字/公式和任意位置的图片块。
- 编辑器通过本地文件选择插图，可在光标位置拆分文字块，并支持移动、替换、删除、替代文本和说明。
- 图片会修正方向、限制最长边 2048px，优先 WebP 并逐步降低质量/尺寸，最终不超过约 2 MiB。
- 优化后字节的 SHA-256 是 `assetId`；相同图片只存一次。
- 本地只在 IndexedDB 保存 Blob；题目中不保存 URL。远端路径为 `sync/v6/assets/<sha256>.<ext>`。
- 同步顺序为图片资产、其他不可变对象、事件页、最后 v6 head CAS。
- 另一设备按需通过带鉴权的 Git Blob API 下载、校验 SHA-256/大小并缓存；渲染只使用 Blob URL。
- 配置页提供缓存全部、清除缓存和缓存占用；离线未缓存显示缺图及重试状态。
- Excel/普通 JSON 继续导入纯文字题；当前模板没有“图片地址”列。

核心文件：

- `lib/image-assets.ts`
- `app/content-block-editor.tsx`
- `app/content-block-renderer.tsx`
- `app/asset-image.tsx`
- `lib/xlsx-import.ts`

## 3. Sync v6

- 固定 head：`sync/v6/head.json`。
- 检查点、事件页、归档目录、练习定义和图片均为内容寻址不可变对象。
- head 使用 ETag/SHA CAS；冲突时拉取、合并后重试，不覆盖并发设备数据。
- 单事件上限 256 KiB、每页最多 250 条；超大领域状态进入检查点/描述符，不通过放大单事件解决。
- 6,000 道长题目的合成检查点约 13.67 MiB，低于 32 MiB 检查点上限；迁移和集成测试均覆盖该规模。
- GitHub 大检查点请求默认超时为 60 秒；不要恢复为 12 秒，否则真实 5 MiB 检查点在正常网络下可能安全超时。
- 恢复先校验全部描述符与哈希，再通过 staging 原子替换正式投影；图片仍按需获取。
- `lib/github-sync.ts` 是 UI 唯一公开同步门面，只委托 v6。

核心文件：

- `lib/sync-v6-head.ts`
- `lib/sync-v6-checkpoint.ts`
- `lib/github-v6-remote.ts`
- `lib/github-sync-v6.ts`
- `lib/github-sync.ts`
- `scripts/test-sync-v6-integration.ts`

## 4. 远端迁移现场

私有仓库 `Evolution404/exam-study-vault` 已于 2026-08-11 完成 v5→v6：

- v5 head blob SHA：`5a56d08150a6bd59c66905b570aea2819287e353`
- v6 head Git blob SHA：`0e9e13c95928e0c7e010c49f4021c3884f0c7118`
- v6 checkpoint：2,288 道全局题、2,294 条题库成员关系、833 条全局统计。
- 旧远端没有图片，因此迁移图片数为 0；失败项为空。
- v6 checkpoint JSON 为 5,125,271 bytes；迁移已把 93 条 v5 热事件归并进最终投影和游标，初始 v6 热事件页为 0，避免重复重放旧载荷。
- v5 head 在迁移前后 SHA 完全相同，`sync/v5/*` 保持只读备份。
- v6 head 的 `source` 记录上述 v5 head SHA；迁移脚本会拒绝覆盖已经存在的 v6 head。
- 已使用隔离的 fake IndexedDB 从真实私有仓库执行 v6 恢复：成功落库 2,288 道题、2,294 条成员关系、833 条统计；检查点还包含 1,270 次作答、23 次练习、28 条解析和 4 个题组。

迁移工具默认 dry-run，纯 GET、无本地 DB 写入；`--apply` 先完成全部预检和不可变对象上传，最后才创建 v6 head：

```bash
npx tsx scripts/migrate-cloud-v5-to-v6.ts Evolution404 exam-study-vault main
npx tsx scripts/migrate-cloud-v5-to-v6.ts Evolution404 exam-study-vault main --apply
```

当前远端 v6 已存在，不要再次执行 `--apply`。工具会拒绝覆盖，但不应把拒绝当作日常同步方式。

## 5. 本地数据边界

- v6 客户端不读取、不转换 `memory-line-study` 旧数据库；升级后从远端 v6 恢复。
- 旧数据库可以继续留在浏览器中作为现场，不影响 v6。
- “清除本机所有数据”会清除 v6/旧 IndexedDB、local/session storage、可访问 Cookie、Cache Storage 和 Service Worker，然后以首次加载状态重载；不修改远端私有仓库。
- GitHub 凭据只保存在当前浏览器本地存储，不进入题库、检查点或公开仓库。
- 真实题库和令牌不得提交到本公开仓库或测试夹具。

## 6. 架构约束

`scripts/check-architecture.mjs` 会检查：

1. 公开页面只使用 `shijuan-study-v6`，不导入旧 `lib/db.ts`。
2. 公开同步只写 `sync/v6/head.json`，不得加入 v5 回退写入。
3. 页面不得重新使用 `Question.imageUrl` 或“图片地址”导入列。
4. `practiceRuns` 是唯一持久化练习进度；不得恢复 active session 双写。
5. 页面 CSS 使用主题令牌，不扩大硬编码颜色和 dark-mode 补丁预算。
6. `tsconfig.json` 的 unused 检查必须保持开启。
7. 修改前先看工作区，禁止 reset/checkout 覆盖用户或其他任务的改动。

## 7. 验证与发布

常用命令：

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run test:browser
```

本轮验收：

- `npm test` 全通过，覆盖 v5 只读源回归、v5→v6 迁移、v6 传输/CAS/恢复、DB 事务、周期/轮次、共享题/分裂、图片管线、单答一事件、PWA 和 UI 静态约束。
- 本地可见浏览器：`artifacts/browser-qa/2026-08-11T15-21-10-990Z/`，桌面 1440×960 + 手机 390×844，共 21 张截图。
- 浏览器链路包含 JSON/Excel 导入、本地图片选择与富内容插入、计算题、整页切题动画、答案反馈、结果详情、解析自动保存、配置/版本、单答一事件和手机同步页。
- 浏览器同步请求使用 GitHub API 401 stub，不写真实远端；真实远端只由已完成的迁移命令创建 v6。

推送 `main` 会触发 `.github/workflows/deploy-pages.yml`：

```bash
git status --short
npm test
git add -A
git commit -m "..."
git push origin main
gh run list --repo Evolution404/exam-study-app --workflow deploy-pages.yml --limit 5
```

部署后应运行：

```bash
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/'
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/sw.js'
BASE_URL='https://evolution404.github.io/exam-study-app' npm run test:browser
```

## 8. 已知非阻断项

- Vite 仍提示主入口约 550 KiB（gzip 约 174 KiB）略高于 500 KiB；同步、KaTeX 和大页面已拆包，后续应拆分设置/练习组件，不要只调高阈值。
- 旧 v5 实现和测试继续保留用于远端迁移源回归；不要误删，也不要让公开页面重新引用。
- 自动化覆盖 Chromium 桌面/手机视口；Safari、Firefox、HEIC/GIF/SVG、透明图片和极端设备存储配额仍需单独矩阵。
- GitHub API 首次图片获取在中国大陆网络下仍取决于 GitHub 可达性；成功缓存后答题不再访问 GitHub。本项目没有引入公开 CDN、OSS 或临时图片 URL。

## 9. 新任务第一步

> 请先完整阅读 `HANDOFF.md`，运行 `git status --short`、`git log -5 --oneline` 和 `npm run typecheck`。公开应用只使用 v6 DB/Sync；v5 仅作只读迁移源。保持一题一次提交事件、全局题目/成员关系、默认滚动 90 天和本地 Blob 图片边界。
