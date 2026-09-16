# 性能审计交接 — PR #55

> 日期：2026-09-16
> 仓库：`Evolution404/exam-study-app`
> 本地：`/Users/zhangyuxi/Desktop/exam-study-app`
> 分支：`perf/performance-audit-20260916`
> PR：#55 `perf: reduce IndexedDB and search overhead`

## 1. 接手规则

先阅读：

- `AGENTS.md`
- `docs/HANDOFF.md`
- 本文

然后执行：

```bash
git status --short --branch
git log --oneline -12
npm run typecheck
```

禁止：

- `git reset` / `git clean`；
- 覆盖当前未提交 WIP；
- 操作用户真实浏览器，浏览器验证只能使用项目 headless Playwright；
- 为通过测试降低断言、增加任意 sleep、扩大性能/代码体积 baseline；
- 恢复旧数据库 schema、Dexie `.upgrade()`、`version(2+)`、旧 DB namespace、旧同步 namespace 或旧客户端兼容分支。

用户明确会让所有客户端同步升级，并清空本地数据后从远端重新同步。开发阶段只维护当前 schema / 当前 Sync v9，不背历史客户端兼容债务。

## 2. 当前 PR 已完成的性能优化

已推送的前 10 个提交主要包括：

- 多题库读取从逐题库多次 IndexedDB 查询改成批量读取；
- 首页历史数据按当前题库范围读取；
- Quick Search 空输入不再预加载全量搜索索引；
- 搜索主页空状态不再提前加载 attempts / stats / notes / round progress；
- 开始练习只读取候选题相关历史；
- 知识整理只读取启用题目的统计；
- 首页完成度只读取 membership/questionId，不 materialize 题目正文；
- 完成状态判断从逐题 `.find()` 的 O(Q²) 改为一次建集合后 O(1) 查询；
- 标签聚合从“每标签扫描全题”改为单遍累计；
- 离开首页后停止首页大统计订阅，并删除首页无消费者的 lifetime 全量聚合。

量化结果：10,000 题完成状态判断由约 `249.8ms` 降至约 `5.7ms`，约 `43.6×`，结果数量一致。

## 3. 最终追加优化

### practiceRuns 索引

当前唯一 Dexie `version(1)` 中，`practiceRuns` 直接使用最终索引：

```text
id, status, updatedAt, startedAt, *bankIds, *questionIds, [status+updatedAt]
```

用途：

- 题库详情按 `bankIds` 定向查相关练习；
- 删除题库按 `bankIds` 定向查 run；
- 删除题目按 `questionIds` 定向查受影响 run；
- 最近进行中练习通过 `[status+updatedAt]` 直接 `.last()`，不再把全部进行中记录读出后排序；
- 避免 `practiceRuns.toArray()` 后前端过滤。

`scripts/tests/test-practice-run-index-performance.ts` 已覆盖 10,000 条无关 run 与 2,000 条进行中 run：bank/question 查询只 materialize 目标 run，最近进行中练习只 materialize 1 条。

### Dashboard / Search / Practice Setup

- Dashboard 新增 scope-aware read-model：近 N 天按 `attempts.createdAt` 时间窗口读，指定复习轮次只读该 `roundId` 的 progress，只有 lifetime 全题库口径才允许读取全部 attempts；
- 新增 `test-dashboard-read-performance.ts`：10,000 条窗口外 attempts 不会被首页近 90 天统计 materialize，轮次统计读取 0 条 attempts；
- Search 空页面不再读取完整题目视图，只有实际搜索或打开筛选时才加载；数据未就绪时显示“正在搜索…”，禁止闪现假的“找到 0 道题”；
- Search / 题库管理 / 未归档列表的大规模 selected-id 判断改为 `Set`；大型练习结果的 question→membership→bank join 改为 Map；知识题组排除集合改为 Set；
- 未归档题目先读主键求差集，再 `bulkGet` 真正未归档题目，避免先 materialize 全部题目正文；
- 开始练习时只有“错题 + 非轮次口径”才读取逐条 attempts；普通/未做/收藏/复习优先等启动路径不再重复 materialize attempts；
- Practice Setup 快捷预设移到 `practice-setup-presets.ts`，code-size ratchet 恢复 PASS，没有上调 baseline。

### Sync / 技术债

- 单题删除级联的 `attemptRoundIds × attempts` 线性嵌套改为一次构建 Set；
- 删除无人使用、会先同步再全量 `attempts.toArray()` 的 `loadAttemptHistory` 死接口；
- 删除运行时 `study-v6-preferences` fallback，并在 architecture guard 中禁止旧本地配置 namespace 回潮；当前稳定的 `study-v7-preferences` / `shijuan-study-v7-device-id` 仍是正式键，不要机械改名。

### read-model / 纯逻辑拆分

新增或继续拆分：

- `src/lib/db/practice-run-read-v7.ts`
- `src/app/bank/bank-library/bank-detail-read.ts`
- `src/app/bank/knowledge-model.ts`
- `src/app/search/search-data.ts`
- `src/app/shell/practice-start-data.ts`
- `src/app/shell/views/practice-view-types.ts`
- `src/lib/sync/github-v7-remote-utils.ts`

目的是把 IndexedDB 读取、聚合、筛选、排序和纯类型从大型 React owner / transport owner 移出去，减少 React 重算和技术债，不新增第二套持久状态。

### 大文件技术债已收敛

没有上调 code-size baseline，当前 `scripts/tools/check-code-size-growth.mjs` 已 PASS。

关键变化：

- `use-practice-session-controller.ts`: main 约 `23,799B` → 当前约 `19,450B`；
- `practice.tsx`: `25,560B` → 约 `25,019B`；
- `github-v7-remote.ts`: `33,659B` → 约 `31,223B`；
- `search-view.tsx`、`bank-detail.tsx`、`knowledge-view.tsx` 也均比 main 更小。

`github-v7-remote.ts` 只把纯字节/摘要/校验/仓库身份 helper 移到 `github-v7-remote-utils.ts`，请求、重试、CAS、同步 84% 修复语义不应改变。

## 4. 历史兼容性策略与门禁

用户已明确：所有客户端同步升级，清空本地数据重新同步，**不要保留历史兼容性代码**。

已经完成：

- 删除临时 v1→v2 `.upgrade()` 与 schema migration 测试；
- Dexie 只保留一个 `version(1)` 当前最终 schema；
- `scripts/tools/check-architecture.mjs` 增强门禁：
  - 禁止 `.upgrade()`；
  - 禁止第二个 Dexie version；
  - 禁止 schema migration / compat 文件；
  - 禁止恢复旧 DB namespace；
  - Sync 继续只允许当前 v9 namespace；
- `AGENTS.md`、`docs/HANDOFF.md`、`docs/ARCHITECTURE.md`、`docs/TESTING.md` 已更新该策略。

注意：不要机械删除“当前远端数据恢复所必需的解码容错”。例如当前 v9 远端已有历史数据若仍可能包含缺字段记录，必须先用 checkpoint/history 回归证明可以删除，才能删。目标是消除旧客户端双栈，不是破坏远端数据恢复能力。

## 5. 最终本地验证

本地最终代码已通过：

- `npm run test:architecture`
- `npm run test:db-v7`
- `npm run test:practice-setup-model`
- `npm run test:practice-setup-performance`
- `npm run test:progress-boundaries`
- `npm run test:search-filters`
- `npm run test:v7-ui`
- `npm run test:sync-v7-protocol`
- `npm run test:sync-progress`
- `npm run test:sync-fault`，12/12 场景 PASS
- `npm run typecheck`
- `npm run test:fast`：84/84 PASS，ESLint / CSS lint / dead-code 全绿；
- `node scripts/tools/check-code-size-growth.mjs`
- 完整 `npm run test:browser`：desktop(22)、topbar-mobile(1)、select-toggle-mobile(1)、mobile(11)、management(20)、review(5)、search(6)、search-pin(2)、history(12)、practice-combo(3)、inflight(5)、sync-refresh(3)、dark(4)、dark-editor-selection(1) 全部 PASS；
- `npm run test:pwa-smoke` PASS；production build 正常、Service Worker 成功控制页面。

同步 transport 拆分期间测试曾抓到一次 `githubVaultIdentitiesEqual` 只 re-export、未本地 import 的 `ReferenceError`，已修复，并重新跑过 protocol / progress / fault / typecheck / lint。不要回退这一修复。

交接前的 headless 定向回归又抓到两处真实生命周期竞态，并已修复：

- 搜索批量“加入题组”后，题组页在 `activeQuestionViews()` 尚未就绪时先渲染空编辑器，导致预填题目短暂为 0；现改为题组数据就绪后再显示可操作编辑器。修后 `search(6)` PASS。
- Practice Setup 在 `readPracticeSetupDatasetV7()` 尚未就绪时先渲染空数据快捷卡，随后 Dexie 查询完成导致按钮被替换，首击可能失效；现改为 dataset 就绪后再显示可操作练习配置。修后 `management(20) + practice-combo(3) + inflight(5)` PASS。

这两处不要通过放宽 Playwright 等待或增加 sleep 回退，产品侧的“数据未就绪不暴露可操作控件”就是回归修复本身。

## 6. 审计结论与保留边界

本轮规模级热点已完成收口，不再为追求“零 `.toArray()` / 零 `.find()`”机械改写。以下路径经审计后有意保留：

- 练习历史完整列表仍按 `runActivityAt()` 排序，不能偷换成 `updatedAt` 索引，否则排序语义改变；
- Asset Pack 图片全量检查承担远端索引自愈，不以 pending-only 优化牺牲恢复能力；
- bootstrap / checkpoint / compaction 的全投影读取属于明确全局操作，不是普通增量同步热点；
- Practice Setup 为精确计算当前时间窗口内错题/连对阈值仍需要逐条 attempts；不能用 lifetime `attemptStats` 近似。

因此 PR #55 后续只允许修 CI/回归问题，不再新增性能功能。

## 7. 完成标准

本 PR 合并前至少满足：

- `npm run test:fast` 全绿；
- 完整 headless Browser QA 全绿；
- PWA smoke 通过；
- code-size ratchet PASS，不抬 baseline；
- architecture guard PASS；
- PR #55 GitHub CI / Governance Audit / Chromium / WebKit / storage 全绿；
- 工作区干净，分支已 push；
- 用户已明确授权：PR #55 CI 全绿后合并 `main`，随后通过统一 `make release` 发布生产。

