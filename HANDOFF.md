# 项目交接文档

> 生成时间：2026-08-11（Asia/Shanghai）  
> 项目路径：`/Users/zhangyuxi/Desktop/exam-study-app`  
> 接手窗口开始工作前，请完整阅读本文，然后运行 `git status --short` 与 `git log -5 --oneline` 重新确认现场。

## 1. 当前基线

- 当前分支：`main`
- 本轮起始提交：`e8a2648 feat: upgrade sync protocol and refine practice controls`；当前发布提交请以 `git log -1 --oneline` 为准。
- 当前基线包含 Sync v5，以及图片题、计算题、结果详情、解析自动保存、构建版本显示和移动端体验改进。
- 远端：`origin https://github.com/Evolution404/exam-study-app.git`
- `origin/main` 与本地 `main` 在创建本文前一致。
- 线上地址：<https://evolution404.github.io/exam-study-app/>
- Pages 工作流：`.github/workflows/deploy-pages.yml`
- 最近一次已验证的 Pages 运行：`31455332754`，build/deploy 均成功。
- Service Worker 缓存版本：`shijuan-v7`。
- 数据库版本：IndexedDB/Dexie `v10`。
- 同步协议：只允许 Sync `v5`；公开客户端没有 v2/v3 回退。

交接时请始终以 `git status --short` 和 GitHub Pages 工作流状态重新确认工作区与线上版本。

## 2. 产品定位与数据边界

这是一个 React + Vite 的本地优先刷题 PWA，项目名称“拾卷”。

- 程序代码部署在公开 GitHub Pages。
- 题库、答题记录、统计和练习进度首先保存在浏览器 IndexedDB。
- 跨设备数据写入用户自己的私有 GitHub 仓库。
- 真实题库不得提交到本公开仓库。
- 项目所有者当前使用的私有资料库是 `Evolution404/exam-study-vault`。
- GitHub 令牌由 `lib/github-credentials.ts` 保存到当前浏览器的 `localStorage`；不要把令牌打印、写进代码、测试夹具或交接文档。

注意：`README.md` 仍写着“令牌只保存在当前浏览器会话”，这已经落后于当前实现。以后改文档时应修正为“保存在当前浏览器本地存储，不同步到题库或云端”。

## 3. 已完成的主要需求

### 答题与练习

- 答案提交后的勾/叉使用绝对定位固定在选项右侧，不再挤压或改变选项正文排版。
- 正确反馈只显示答案字母，例如 `正确答案：A`，不重复完整选项。
- 错误反馈按 `正确答案：B｜你的选择：A` 的顺序显示，同样不重复完整选项。
- 桌面端选项正文可用鼠标选择和复制；只有非文字区域保留按钮点击行为。
- 中文题目在显示层转换中文标点，包括中文括号；题库底层仍保持英文标点。
- “选择后立即提交”默认开启；关闭后单选/判断题需要点击确认答案。
- 手机端可选择题目切换方式：`立即` 或 `滑动`。
- 今日页与练习页使用同一个最新 `PracticeRun`，继续练习、已答数量和进入后的答案状态一致。
- 今日页的上次练习卡片位于题库选择之前；继续按钮右侧有放弃按钮。
- 练习页的最近练习卡片也有继续、放弃和查看记录入口。
- 练习中心新增“随机指定题数”：题数只作用于本次练习，不修改配置页的全局每组题数。
- 手动同步、自动同步和定期拉取都不会重建正在显示的 `ActivePractice`，因此同步完成后当前题目、滚动位置和答题界面保持不变；远端合并仍直接写入 IndexedDB。
- 滑动切题动画作用于完整练习布局，以整页宽度进出场，而不是题卡局部轻微位移。
- 题目解析采用 650ms 防抖自动保存；切题或卸载时会立即补写未保存内容。
- 题目支持完整 `http/https` 图片地址，并在题库编辑、搜索详情、练习和结果详情中显示。
- 新增计算题：标准答案为有限数值，按配置页的允许误差百分比判定；标准答案为 0 时，百分比数值换算为同量级绝对误差，例如 1% 等于 ±0.01。

### PracticeRun 单一数据源与多设备合并

- `practiceRuns` 是唯一持久化练习进度来源。
- 旧的 active session 数据表和双写路径已经删除。
- `ActivePractice` 类型仍存在，但它只是 React 当前界面的临时状态，见 `lib/types.ts` 注释；不要误认为它是第二套持久化 session。
- 同一个练习跨设备按题合并：每个 `PracticeAnswerState` 有 `updatedAt/deviceId/eventId`，不同题取并集，同一题按确定性时钟决胜。
- 练习答案仍按题使用独立时钟合并，不再出现整份快照覆盖另一设备已答题目的问题。
- 新建空练习只保存在本地，不创建同步事件；每次提交只产生一条 `practice.answer.submitted` 领域事件，同时重建不可变作答历史和可继续练习答案两个本地投影。
- 第一条 `practice.answer.submitted` 同时携带练习定义；上传时定义会被抽取为内容寻址对象，事件页只保留描述符，因此第一题也只有一个待同步事件。
- 练习状态使用 `practice.run.status.changed` 小事件；不得恢复整份 `practice.run.saved` 快照事件。
- 未提交的选择和单纯翻页不产生同步事件。
- 练习定义只发布一次；完成或放弃状态仍按练习合并待同步事件，避免重复状态操作产生无界事件。
- 空练习被放弃/删除时不发布无意义墓碑。

核心位置：

- `lib/db.ts`：`savePracticeProgress`、`setPracticeRunStatus`、`deletePracticeRun`、`mergePracticeRuns`
- `app/study-app.tsx`：`activePracticeFromRun`、继续练习、当前 React 状态刷新
- `scripts/test-sync-data-model.ts`
- `scripts/test-sync-entity-conflicts.ts`
- `scripts/test-practice-answer-feedback.ts`

### 同步 v5

- 固定可变入口只有 `sync/v5/head.json`。
- 检查点、事件页、归档目录和归档段都是内容寻址的不可变文件。
- GitHub head 更新使用 CAS；发生 409/422 时重新读取并合并，不覆盖其他设备刚发布的事件页。
- 单事件页最多 250 条、256 KiB；热事件总下载窗口最多 4 MiB；head 最多引用 1024 个事件页。
- 256 KiB 只是事件传输颗粒度，不是业务对象上限。练习定义或其他大载荷会先写入内容寻址对象，安全上限 32 MiB，事件只携带描述符。
- 热检查点默认保留最近 2,000 条作答、最近 100 次练习、最近 35 天日统计。
- 更早历史按月归档；快速恢复只恢复热检查点，完整恢复通过 staging 表分段下载并原子提交。
- 完整恢复失败时，本地正式数据不被半包覆盖，staging 会清空。
- 顶部快捷同步和同步页面都有进度显示；快速恢复、完整恢复使用模态框进度。
- 自动同步默认关闭，可按待同步事件数量触发。
- 定期拉取默认关闭，只下载、合并其他设备数据，不主动上传本机事件。
- GitHub 同步模块通过动态导入离开首屏主包。

核心位置：

- `lib/github-sync.ts`：UI 使用的精简 v5-only 门面
- `lib/github-sync-v5.ts`：同步、拉取、快速/完整恢复实现
- `lib/github-v5-remote.ts`：GitHub Contents/blob 读写、ETag、CAS
- `lib/sync-v5-head.ts`：head 协议、路径与大小约束
- `lib/sync-v5-catalog.ts`：归档目录和分段
- `lib/db.ts`：检查点、staging、原子恢复和事件应用
- `scripts/test-sync-v5-integration.ts`：端到端协议回归

私有资料库已于 2026-08-11 从 v4 完整转换到 v5：4 个题库、2,294 道题、1,045 条作答、21 次练习和 94 条热事件均已合并到 v5 检查点。旧 v4 head 仅作为回滚备份，公开客户端不读取。转换工具默认只做 dry-run，并会拒绝覆盖已存在的 v5 head：

```bash
# 默认只做 dry-run
npx tsx scripts/migrate-cloud-v4-to-v5.ts Evolution404 exam-study-vault main

# 会修改远端，仅在明确需要并确认 gh 登录身份后使用
npx tsx scripts/migrate-cloud-v4-to-v5.ts Evolution404 exam-study-vault main --apply
```

不要无故再次运行 `--apply`。脚本通过 `gh auth token` 取令牌，不会把令牌写入仓库。

### 配置、快捷键与移动端

- 快捷键按“功能 -> 多个按键组合”保存。
- 支持监听用户按键、组合键、多个绑定、删除、恢复默认和冲突替换。
- 回车只是“确认答案”的默认绑定，不再是硬编码，可以删除或绑定到其他功能。
- 手机端隐藏电脑快捷键配置和快捷键行为。
- 手机底部导航为今日、题库、练习、整理、配置；同步已合并到手机配置页。
- 自动同步、定期拉取、题目切换方式都位于配置页。
- 桌面同步页和手机配置页的同步区域都有“清除本机所有数据”入口。二次确认后会清除题库、作答、练习、配置、GitHub 凭据、可访问 Cookie、local/session storage、全部 IndexedDB、Cache Storage 和 Service Worker，再以无查询参数/片段的站点地址重新载入；远端私有仓库不受影响。
- 全部原生 `<select>` 已替换为 `app/app-select.tsx` 的 Radix Select，处理长文本、省略、换行、Portal 层级和移动端视口限高。
- 夜间模式下数字输入框统一使用配置卡片底色，不再出现纯黑或亮色输入框；外观主题的勾选标记已垂直居中。
- 配置页显示构建所对应的 Git 提交哈希和提交时间；构建时由 `vite.config.ts` 注入，便于客户端核对版本。

### 练习记录与结果

- 练习中心的最近练习卡片只显示真正处于 `in_progress` 状态的练习；全部完成或放弃后不再回退显示旧记录。
- 已完成结果列表中的题目行可以点击，打开题干、图片、选项、正确答案、用户答案和个人解析详情。
- “重练本次题目”仍复用同一组题，但开启随机选项顺序时会重新洗牌，并避免与上次顺序完全相同。

### 导入、UI 与性能

- 支持 JSON 导入。
- 支持 Excel `.xlsx` 导入和模板下载。
- 模板文件：`public/题库模板.xlsx`
- Excel 解析和严格校验：`lib/xlsx-import.ts`
- Excel UI：`app/excel-import.tsx`
- 当前 Excel 列为 `题干、题型、答案、图片地址、标签、A...`；模板说明已改为本项目的单选、多选、判断、计算、图片题格式，并可通过 `scripts/generate-xlsx-template.mjs` 重建。
- 手机端下载模板优先使用系统文件分享，普通浏览器回退到 Blob 下载；下载不会把 PWA 导航到模板文件，页面可正常继续使用。
- KaTeX 只在遇到公式时动态加载；CSS/字体也离开首屏资源。
- 题库、练习、搜索、整理、同步、历史/结果页面均已按路由延迟加载。
- 题目具有永久 `sortOrder`，DB v10 用 `[bankId+sortOrder]` 索引。
- 进行中练习使用 `[status+updatedAt]` 复合索引读取最新记录。
- Service Worker 对哈希静态资源 cache-first，对导航使用带超时的 network-first 和缓存回退。
- 恢复成功不再整页 reload，而是在 React 内重置界面状态；下拉刷新仍会在有界 SW update 后 reload。

## 4. 关键架构约束

这些约束由 `scripts/check-architecture.mjs` 检查，修改时不要绕过：

1. Dexie 只能声明当前 DB v10，不能在构造器中重新堆叠旧版本 schema。
2. 练习进度只能持久化到 `practiceRuns`，不得重建 `sessions` 表或双写 API。
3. 公开同步入口必须只委托 v5。
4. 固定 head 路径必须是 `sync/v5/head.json`。
5. 不得重新加入 v2/v3 读写或迁移回退。
6. 页面 CSS 优先使用主题令牌；不要增加页面级 dark mode 补丁或扩大硬编码颜色预算。
7. `tsconfig.json` 已开启 `noUnusedLocals` 和 `noUnusedParameters`。
8. 真实题库、GitHub 令牌和私有资料库内容不得进入公开仓库。
9. 工作区可能包含用户或另一窗口的未提交改动；编辑前先看 `git status`，不要 reset/checkout 覆盖。

## 5. 常用命令

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run test:sync
npm run test:browser
```

`npm run test:browser`：

- 使用真实可见 Chrome，不是 headless。
- 默认 Chrome 路径：`/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
- 可用 `CHROME_PATH` 覆盖。
- 默认启动本地 Vite。
- 直接验证已部署 Pages：

```bash
BASE_URL='https://evolution404.github.io/exam-study-app' npm run test:browser
```

- 会测试桌面 1440×960 和手机 390×844。
- 覆盖 JSON/Excel 导入、图片与计算题、快捷键录入、配置、答对/答错、解析自动保存、练习结果详情、同步错误反馈、自动同步和手机布局。
- GitHub API 在浏览器测试中使用 401 stub，避免写真实远端。
- 截图写入被忽略的 `artifacts/browser-qa/<timestamp>/`。
- 最近一次线上可见浏览器回归：`artifacts/browser-qa/2026-08-09T14-59-51-204Z/`，19 张截图，全部通过页面横向溢出断言。
- 上一轮本地可见浏览器回归：`artifacts/browser-qa/2026-08-11T03-23-39-849Z/`，20 张截图；覆盖随机指定题数，以及桌面/手机清除数据入口。
- 本轮本地可见浏览器回归：`artifacts/browser-qa/2026-08-11T04-34-17-962Z/`，21 张截图；覆盖整页切题动画、夜间数字输入、主题勾选居中、版本信息、正确答案优先、解析自动保存、图片/计算题、结果详情、最近练习隐藏及手机模板下载留在应用内。
- 单事件协议改造后的本地可见浏览器回归：`artifacts/browser-qa/2026-08-11T05-29-00-185Z/`，21 张截图；额外直接读取 IndexedDB 断言一次提交只增加一条待同步事件。

## 6. 发布流程

推送 `main` 会触发 GitHub Pages：

```bash
git status --short
npm run lint
npm test
git add -A
git commit -m "..."
git push origin main
gh run list --repo Evolution404/exam-study-app --workflow deploy-pages.yml --limit 5
```

部署后至少检查：

```bash
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/'
curl -fsS -H 'Cache-Control: no-cache' 'https://evolution404.github.io/exam-study-app/sw.js'
```

上次发布时线上资源已经与本地 `dist/index.html` 的哈希一致，`sw.js` 首行为 `const CACHE = "shijuan-v7";`。

## 7. 当前已知边界与后续可优化项

这些不是当前阻断问题，但新窗口应知道：

- `README.md` 的 GitHub 令牌存储说明已过时，见本文第 2 节。
- Vite 构建仍提示主入口约 502 KiB（原始、gzip 约 160 KiB）略高于 500 KiB 警戒线；KaTeX、同步和大页面已经拆包，若继续优化可从 `app/study-app.tsx` 拆分更多设置/练习组件，而不是简单调高 warning 阈值。
- `app/study-app.tsx` 与 `app/styles/components.css` 仍然较大；可继续按领域拆文件，但必须先跑完整 UI/同步测试，避免纯整理引入行为变化。
- `README.md` 只展示 JSON 格式，尚未补充 Excel 导入说明。
- 浏览器自动化不使用真实 GitHub 写入；真实同步正确性由 v5 transport/integration 测试和私有仓库格式验证覆盖。
- 拖拽排序、浏览器音效/震动权限和不同浏览器/DPR 没有做完整自动化矩阵；涉及这些功能时需要单独增加可见浏览器用例。
- `public/file.svg`、`globe.svg`、`window.svg` 看起来像旧模板资源，尚未确认是否完全未引用；删除前先用构建产物和全仓检索确认，不要凭文件名直接删。
- GitHub Actions 曾提示部分官方 Pages action 内部 Node 20 已弃用，但运行成功；这是 action 上游提示，不是应用 Node 版本问题。

## 8. 新窗口建议的第一步

新窗口可以直接使用下面的开场指令：

> 请先完整阅读项目根目录 `HANDOFF.md`，再运行 `git status --short`、`git log -5 --oneline` 和 `npm run typecheck` 核对现场。把 `PracticeRun` 作为唯一持久化练习进度，保持 Sync v5-only，不要恢复 active session 双写或 v2/v3 兼容层。之后根据我的新需求继续工作，并在修改前说明会触及哪些文件和测试。
