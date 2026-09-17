# Bug / 性能审计交接（2026-09-17）

## 当前状态

- 项目：`/Users/zhangyuxi/Desktop/exam-study-app`
- 当前分支：`audit/bug-performance-20260917`
- 基线：`main` / `origin/main` 的 PR #55 合并提交 `694cb5ecb2edb4eab55da50eaa50af2640a61a61`
- 本轮已验证修复提交：`f464ac7`（`fix: harden audit data correctness paths`）
- 禁止 `git reset` / `git clean`；接手先检查工作区，不要覆盖后续新增 WIP。
- 本轮目标：继续审计真实 Bug、数据一致性、并发竞态和规模级性能热点；测试先行，小提交推进。不要为了“代码更快”改变统计、同步恢复或数据完整性语义。
- 数据库策略仍是唯一 Dexie `version(1)`；所有客户端统一升级、必要时清空本地后从远端重建，禁止新增 `.upgrade()`、历史 schema migration 或旧客户端兼容层。

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

## 已完成验证

以下在本轮修改后已通过：

- `npm run test:v7-ui`
- `npm run test:search-filters`
- headless Browser QA：`search(6) + history(12)`
- `npm run test:pwa`
- `npm run test:db-v7`（包含 R5 update/delete 原子事务回归）
- `npm run typecheck`

尚未在最新全部改动上跑：

- `npm run test:fast`
- 全量 headless Browser QA
- PWA production smoke / build
- code-size / export-surface / architecture 全量治理检查（应在准备 PR 前执行）

## 下一步审计优先级

1. **批量题目更新性能**：
   - `src/app/search/search-view.tsx` 的“批量收藏 / 批量加标签”；
   - `src/app/bank/knowledge-view.tsx` 的标签重命名/删除；
   - 当前都是 `Promise.all(N * updateQuestionV7)`，即 N 个 IndexedDB 事务 + N 条 `question.upsert` change set。
   - Sync mutation 已支持 `question.bulk.upsert`，优先设计一个原子 `updateQuestionsV7` / bulk patch API；必须测试一批题只产生一条 bulk change set，且任一题缺失时不要半更新。

2. **继续审计 DB 写事务原子性**：
   - `db-v7-question-core.ts`、`db-v7-question-delete.ts`、`db-v7-bank.ts`、`db-v7-question-notes-groups.ts` 还有多处在事务外 `nextV7Sequence()` 或先读后写；
   - 项目约束是领域写 + `syncMeta` + change set 同事务，先区分“允许 sequence gap 的设计”与真正会造成陈旧写复活/半提交的路径，不要机械重构。

3. **练习历史列表规模问题**：
   - `PracticeHistory` 仍 `practiceRuns.toArray()` 后按 `runActivityAt()` 排序；
   - 之前没有直接换 `updatedAt`，因为 `runActivityAt()` 语义不同。若要优化，应先证明可建立等价可索引 activity 字段，不能偷偷改变排序口径。

4. **全表 / N×M 扫描继续筛查**：只处理会随题量、历史量明显增长的真实热点；图片 Asset Pack 自愈、checkpoint/bootstrap 全投影等正确性路径不要为了消掉 `toArray()` 而削弱。

## 交接纪律

- 先执行 `git status --short --branch`，继续使用 `audit/bug-performance-20260917`，不要重新从 `main` 开工。
- 不要 reset/clean。
- 先跑当前定向测试确认 WIP，再继续审计。
- 每个真实问题先补能在旧实现失败的回归，再修代码。
- 小 commit、及时 push；当前分支尚未创建 PR、尚未合并、尚未发布。
