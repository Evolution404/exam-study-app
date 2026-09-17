# Bug / 性能审计交接（2026-09-17）

## 当前状态

- 项目：`/Users/zhangyuxi/Desktop/exam-study-app`
- 当前分支：`audit/bug-performance-20260917`
- 基线：`main` / `origin/main` 的 PR #55 合并提交 `694cb5ecb2edb4eab55da50eaa50af2640a61a61`
- 当前审计 HEAD：`0b5fb42`；相对 `origin/main` 为 8 commits ahead / 0 behind。
- 本轮新增提交：`dea35eb`、`da9b581`、`c53c87d`、`1b87792`、`91b1eae`、`0b5fb42`，均已 push。
- 禁止 `git reset` / `git clean`；接手先检查工作区，不要覆盖后续新增 WIP。
- 本轮目标：继续审计真实 Bug、数据一致性、并发竞态和规模级性能热点；测试先行，小提交推进。不要为了“代码更快”改变统计、同步恢复或数据完整性语义。
- 数据库策略仍是唯一 Dexie `version(1)`；所有客户端统一升级、必要时清空本地后从远端重建，禁止新增 `.upgrade()`、历史 schema migration 或旧客户端兼容层。

### 2026-09-17 后续审计收口补充

后续审计转入 `audit/code-audit-20260917`，并继续完成以下已 push 修复；这些提交属于下一轮数据库重构的行为基线，不要回滚：

- `6680a91`：创建 Practice Run / Review Round 时校验 bank/question/round 引用。
- `243f70c`：更新/完成 Review Round 时校验引用。
- `e5a8e04`：完整保存 Practice Run 时阻止悬空引用。
- `16142b7`：删 bank/question 同步裁剪 Review Round 引用，本地 DB 与 reducer replay 保持 checkpoint-safe。
- `09dc8ab`：删除题库及独占题改为一个父写事务，消除 membership 并发窗口。
- `997c138`：Practice Run 内部 map invariant；状态切换不再用旧 UI snapshot 复活已删题答案；checkpoint/reducer 拒绝越界 map key。
- `f86648c`：Bank Detail lifetime/rolling/round 历史读取按 scope 收窄，活动统计改用日聚合。
- `2b36506`：Bank Detail 最近练习由全量 run materialize 改为只读最近 5 条。
- `b903f9e`：Practice Result 单题详情 rolling/lifetime/round 读取按 scope 收窄。

审计过程中进一步确认当前 schema 的结构性问题：derived stats 被混入 canonical/sync 状态、PracticeRun 与 attempts 双事实源、group/round/run 多值关系以内嵌数组/Map 表示、Attempt 缺少直接 round provenance。用户已明确要求停止“小修小补”，下一阶段按 `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md` 做整体数据库重构。

## 本轮已确认并修复

### 1. 历史练习结果中的共享题题库归属错误

问题：`PracticeRunResult` 原先把全部 membership 直接做 `new Map(questionId -> membership)`。同一道共享题属于多个题库时，最后一条 membership 会覆盖前一条，结果页可能显示本次练习范围之外的题库，编辑题目时 `preferredBankId` 也可能错误。

修复：历史练习结果现在优先在 `run.bankIds` 范围内选择该题 membership；仅在 run 范围内已经没有关系时才回退到现存 membership。不要恢复“最后一条 membership 覆盖”的实现。

涉及：
- `src/app/practice/practice-history.tsx`
- `scripts/tests/test-v7-ui-data-flow.ts`

### 2. 命名复习轮次下，结果详情统计错误

问题：`ResultQuestionDetail` 原先只读取 `attempts`，调用 `buildScopedQuestionStats(..., attempts, [], ...)` 时把 `reviewRoundProgress` 固定传空数组。`progressScope.type === "round"` 时会得到 0/错误统计。

修复：
- round scope：只读取该题对应 `reviewRoundProgress`，不读取无用 attempts；
- rolling/lifetime：继续读取该题 attempts；
- `buildScopedQuestionStats` 同时拿到正确的 attempts / roundProgress。

涉及：
- `src/app/practice/practice-history.tsx`
- `scripts/tests/test-v7-ui-data-flow.ts`

### 3. Search View 已缩小题库范围，但历史数据仍读取所有题库

问题：`SearchView` 已根据 `appliedBankIds` 生成 `appliedQuestions`，但 `readSearchHistoryDataV7()` 仍接收全部 `views`，因此只搜索一个题库时仍 materialize 其他题库的 attempts / attemptStats / notes / reviewRoundProgress。

修复：历史读取改为跟随 `appliedQuestions` 的 questionId 集合；切换题库筛选时，Dexie 定向读取也随之收窄。

涉及：
- `src/app/search/search-data.ts`
- `src/app/search/search-view.tsx`
- `scripts/tests/test-search-filters.ts`

### 4. IndexedDB 启动失败被吞掉

问题：`dbV7Ready` 原实现为 `dbV7.open().then(() => undefined, () => undefined)`，数据库打开失败也会 resolve。`src/main.tsx` 明明已经有 bootstrap `.catch()` 和 `AppRecoveryScreen`，却永远收不到 DB open rejection。

修复：`dbV7Ready` 只在成功时转成 `void`，失败正常 reject，由 `main.tsx` 渲染现有恢复页。禁止重新吞掉启动错误。

涉及：
- `src/lib/db/db-v7-core.ts`
- `scripts/tests/test-pwa-cache.ts`

### 5. `updateQuestionV7()` 存在“删题后陈旧编辑复活题目”竞态

问题：旧实现先在事务外 `questions.get(questionId)`，随后另开写事务。若删除发生在两步之间，陈旧编辑可以重新 `put()` 已删除题目。

已用测试稳定证明旧结构有问题；修复后把“读取当前题目 -> 校验存在 -> 计算 updated -> 写 questions -> enqueue change set”全部放入同一个包含 `questions/changeSets/syncMeta` 的读写事务，由 IndexedDB 写事务串行化封住删除插入窗口。

回归测试不再用会与写事务互锁的 gate，而是直接验证 `questions.get()` 发生在活动 readwrite transaction 中，并验证事务包含 `questions/changeSets/syncMeta`；删除后的后续编辑必须 reject。

涉及：
- `src/lib/db/db-v7-question-core.ts`
- `scripts/tests/test-db-v7.ts`

## 已加强但没有确认产品 Bug 的测试

### 练习记录左滑删除

静态审计曾怀疑 `HistoryRunCard` 的 `pointerup` 可能因 React offset 闭包导致滑动后误开详情。原 browser 测试此前绕过手势，直接 `dispatchEvent("click")` 删除按钮。

本轮把 history browser QA 改成真实 mouse drag 左滑再点击删除按钮；当前实现 `history(12)` PASS，未复现误开详情，因此暂不改产品逻辑。保留真实手势覆盖，后续若 iOS 真机仍复现再针对 touch/pointer 时序处理。

涉及：
- `scripts/tests/browser/specs/history.mjs`

## 第二阶段已完成

### 6. 批量题目属性更新改为单事务 bulk upsert

新增 `updateQuestionsV7`，搜索批量收藏/加标签、知识整理标签重命名/删除不再执行 `N * updateQuestionV7`。整批在同一 `questions/changeSets/syncMeta` 事务内读取最新题目、验证全部存在、计算新状态、`bulkPut`，并只产生一条 `question.bulk.upsert` change set；任一题缺失时整批失败，不产生半更新。

提交：`dea35eb perf: batch question property updates`。

### 7. 破坏性写入与解析/题组写入竞态已封口

已事务化：
- `deleteQuestionsV7`：在取得写事务后确定待删题、membership、pending/blocked change set 与级联对象；事务显式覆盖 `questionGroups`、`syncMeta`。
- `deletePracticeRunV7`：事务内重读最新 run，再依据最新答案状态决定是否写 tombstone / 删除事件。
- `saveNoteV7`：事务内读取旧 note 并递增 revision，避免并发自动保存拿到同一 revision。
- `saveQuestionGroupV7`：题目存在校验、构造题组、写入与 change set 原子提交，避免删题窗口留下悬空引用。
- `deleteBankFolderV7` / `deleteBankV7`：事务内读取 folder/bank、关联 bank/membership/run，并在同一事务分配 sequence，避免并发新增/移动对象漏级联。

提交：`da9b581`、`c53c87d`、`91b1eae`。

### 8. 练习历史规模问题已解决

新增仅本机派生表 `practiceRunActivity`，保存 `runId/status/activityAt`，其中 `activityAt` 继续严格使用 `runActivityAt()` 语义；该表不进入远端 checkpoint/change set，不改变同步 wire。

历史页改为按 `[status+activityAt]` / `activityAt` 索引分页读取；10,000+ 历史记录性能测试中首屏只 materialize 50 条 run，不再 `practiceRuns.toArray()` 全量排序。所有 run 写入/删除统一走 activity-index helper，并有源码门禁阻止未来绕过 helper。restore/reconcile 会从当前 run 重新构建派生索引。

提交：`1b87792 perf: page practice history by activity index`。

### 9. 门禁发现并修正一个非法当前测试夹具

`test-sync-mock-integration.ts` 的超大练习场景手工构造 `status=completed` 却没有 `completedAt`。生产领域逻辑本身会写 `completedAt`；未增加兼容 fallback，只修正当前测试夹具以满足当前领域不变量。

提交：`0b5fb42 test: complete synced run fixture`。

## 最终验证状态

最新 HEAD `0b5fb42` 已完成：

- `make test`：PASS。完整构建 + `test:fast` 全绿；测试汇总 **84 成功 / 0 失败**；typecheck、ESLint、Stylelint、dead-code、架构门禁、Safari IndexedDB、同步集成/故障恢复、checkpoint、PWA、iOS 发布流程断言全部通过。
- `make test-browser-headless`：PASS。Browser QA：`desktop(22), topbar-mobile(1), select-toggle-mobile(1), mobile(11), management(20), review(5), search(6), search-pin(2), history(12), practice-combo(3), inflight(5), sync-refresh(3), dark(4), dark-editor-selection(1)`。
- Browser QA artifact：`artifacts/browser-qa/2026-09-17T01-20-13-298Z`。
- 工作区 clean；本地 HEAD == `origin/audit/bug-performance-20260917`；相对 `origin/main`：0 behind / 8 ahead。

## 后续审计候选

本轮优先项（批量更新、DB 写竞态、练习历史规模）已经完成。后续若继续审计，按真实收益排序：

1. 继续筛查会随题量/历史量明显增长的全表或 N×M 读取；只处理可证明的热点。
2. 对剩余“事务外先读后写”路径逐一判断是否会造成陈旧写、漏级联或半提交；允许 sequence gap 的路径不要机械改写。
3. 不要为了消除 `toArray()` 去削弱 checkpoint/bootstrap、Asset Pack 自愈等正确性路径。
4. 继续保持当前单一 Dexie `version(1)` 策略，不新增历史 schema、migration 或旧客户端兼容层。

## 交接纪律

- 先执行 `git status --short --branch`，继续使用 `audit/bug-performance-20260917`，不要重新从 `main` 开工。
- 不要 reset/clean。
- 先跑当前定向测试确认 WIP，再继续审计。
- 每个真实问题先补能在旧实现失败的回归，再修代码。
- 小 commit、及时 push；截至 `0b5fb42` 工作区 clean、完整门禁和 headless QA 全绿，适合创建 PR；尚未合并、尚未发布。
