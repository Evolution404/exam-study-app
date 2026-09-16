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

## 3. 当前本地尚未推送的进一步优化

### practiceRuns 索引

当前唯一 Dexie `version(1)` 中，`practiceRuns` 直接使用最终索引：

```text
id, status, updatedAt, startedAt, *bankIds, *questionIds
```

用途：

- 题库详情按 `bankIds` 定向查相关练习；
- 删除题库按 `bankIds` 定向查 run；
- 删除题目按 `questionIds` 定向查受影响 run；
- 避免 `practiceRuns.toArray()` 后前端过滤。

已新增 `scripts/tests/test-practice-run-index-performance.ts`，10,000 条无关 run 场景只 materialize 目标 run，避免全表扫描。

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

## 5. 已完成验证

本地最新代码已通过：

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
- 当前修改文件 ESLint
- `node scripts/tools/check-code-size-growth.mjs`

同步 transport 拆分期间测试曾抓到一次 `githubVaultIdentitiesEqual` 只 re-export、未本地 import 的 `ReferenceError`，已修复，并重新跑过 protocol / progress / fault / typecheck / lint。不要回退这一修复。

交接前的 headless 定向回归又抓到两处真实生命周期竞态，并已修复：

- 搜索批量“加入题组”后，题组页在 `activeQuestionViews()` 尚未就绪时先渲染空编辑器，导致预填题目短暂为 0；现改为题组数据就绪后再显示可操作编辑器。修后 `search(6)` PASS。
- Practice Setup 在 `readPracticeSetupDatasetV7()` 尚未就绪时先渲染空数据快捷卡，随后 Dexie 查询完成导致按钮被替换，首击可能失效；现改为 dataset 就绪后再显示可操作练习配置。修后 `management(20) + practice-combo(3) + inflight(5)` PASS。

这两处不要通过放宽 Playwright 等待或增加 sleep 回退，产品侧的“数据未就绪不暴露可操作控件”就是回归修复本身。

## 6. 下一步优先级

### P0：先把当前 WIP 做完并推到 PR #55

1. headless browser 定向回归在本次交接前已完成：

```bash
BROWSER_GROUPS=management,search,practice-combo,inflight node scripts/tests/test-browser-visible.mjs
```

当前结果：`search(6)`、`management(20)`、`practice-combo(3)`、`inflight(5)` 全部 PASS。后续若继续修改对应路径，需要重新运行。禁止真实浏览器。

2. 审查 `git diff`，按职责拆成小提交，建议至少分为：
   - schema/index + no-compat guard；
   - IndexedDB/read-model performance；
   - controller/UI owner decomposition；
   - sync transport utility decomposition；
   - docs/handoff。

3. 每个提交前跑对应定向测试；全部提交后运行：

```bash
npm run test:fast
```

4. push `perf/performance-audit-20260916`，确认 PR #55 新 CI 全部重跑。旧 Governance Audit 红灯来自旧提交，不要引用旧结果判断当前状态。

### P1：继续性能审计

继续搜索真实规模相关热点，优先：

- `practice-history.tsx` 的 `practiceRuns.toArray()` 是否可用现有索引 / 有界 recent query 替代；
- 仍然存在的 `.toArray()` 是否是明确“全局统计”需求，还是可以按 questionId/bankId/status/index 收窄；
- 大数组里重复 `.find()` / `.includes()` 是否随 Q/R 增长形成 O(n²)；
- AppShell 常驻 `useLiveQuery` 是否在非所属 view 仍响应频繁写入；
- 搜索、题库详情、练习历史是否重复 materialize 同一大对象；
- 首屏是否加载用户可能不用的重模块/数据。

只做能量化、可回归的优化，不做无意义微优化。

## 7. 完成标准

本 PR 合并前至少满足：

- `npm run test:fast` 全绿；
- 完整 headless Browser QA 全绿；
- PWA smoke 通过；
- code-size ratchet PASS，不抬 baseline；
- architecture guard PASS；
- PR #55 GitHub CI / Governance Audit / Chromium / WebKit / storage 全绿；
- 工作区干净，分支已 push；
- 未经用户明确授权不要合并 main、不要发布生产。

