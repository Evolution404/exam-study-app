# 数据库架构重构执行计划（2026-09-17）

> 状态：Phase 0–8 已实施；生产 Sync v10 head-last cutover 已完成；最终代码/技术债清理 HEAD `75d901b977802ca468671d340d8165b47f57719b` 已全 CI PASS。当前仅剩交接文档提交后的 docs-only CI、PR #59 ready/merge 与正式发布 smoke。
>
> 当前 Draft PR：#59 `refactor: rebuildable projections and canonical sync v10`
>
> 当前分支：`refactor/database-projection-sync-v10-20260917`
>
> PR #58 已完成 Phase 0–2 并合并到 `main`；PR #59 完成 Phase 3–8。用户已明确授权完成后合并并发布；生产 v10 cutover 已执行成功。

## 0. 当前执行状态（2026-09-17）

- Phase 0–2：已在 PR #58 完成并合并。
- Phase 3：统一 projection engine 已完成。canonical facts 可 full rebuild / dirty incremental rebuild 为本地 projections；full/incremental differential、idempotence、sync-silence、projection-loss recovery 均有测试覆盖。
- Phase 3 性能基线：10k attempts rebuild 已改为内存聚合后按 projection table 批量写入，禁止退化为逐 attempt IndexedDB get/put 的 N+1 路径。
- Phase 4：主要热点 read-model 已切换到 projections 或 targeted canonical indexes；Dashboard、Bank Detail、PracticeRun/history 等性能门禁已建立。
- Dashboard 指定题集 rolling 查询使用 `[questionId+createdAt]` compound index；同一时间窗加入 2,000 条无关 attempts 后，materialize 从约 2,001 行降为 1 行。
- Bank Detail rolling 查询使用 questionId + createdAt 定向读取；同一时间窗加入 2,000 条无关 attempts 后，materialize 从约 2,003 行降为 3 行。
- `scripts/tests/test-ui-data-flow.ts` 已明确锁定新契约：指定题集必须走 `readAttemptsForQuestionIdsInWindow(ids, from, to)`，禁止恢复“按 createdAt 全读时间窗后再 filter(questionId)”的旧实现。
- Phase 4 收口 HEAD `ab85baf`：`make test`、Chromium、WebKit、Sync storage CI、Governance Audit、PR Preview 全部 PASS。
- 下一步：等待本次交接文档提交后的 docs-only CI；若全绿，直接将 PR #59 标记 ready、merge main、触发正式发布并完成生产 smoke。不要再扩展数据库重构范围。

## 1. 为什么现在要重构

当前 IndexedDB 已经证明存在系统性结构问题，不再继续通过页面级查询补丁处理：

1. `attemptStats`、`attemptDailyStats`、`practiceRunStats`、`reviewRoundProgress` 都能从 canonical facts 重建，却同时存在于本地持久化、projection、checkpoint 校验等多层状态中。
2. `PracticeRun` 同时保存 `questionIds`、`questionTypes`、`answers`、`optionOrders` 大型映射，而 `attempts` 又保存已提交答案事实，形成双事实源和删除/同步竞态。
3. `ReviewRound.bankIds`、`ReviewRound.finalQuestionIds`、`QuestionGroup.items` 等关系以内嵌数组存在，删除一个实体会迫使系统扫描并改写大量父对象。
4. `Attempt` 过去未直接建模复习轮次归属，reducer 通过 reducer-only `attemptRoundIds` 补充 provenance，说明 canonical model 缺字段。
5. 查询需要的复合维度没有直接建模，例如 `questionId + createdAt`，导致运行时只能在单列索引之间选择或全量 materialize 后过滤。
6. `imageAssets` 同时承担同步 descriptor 和本地 Blob cache，事实与缓存生命周期耦合。
7. 远端 Sync v9 已经在 bounded checkpoint 中主动清空 derived arrays，历史 hydration 后再重建统计。这证明同步层本身已经把这些统计视为派生数据，本地模型应与这一事实统一。

本轮重构目标不是“让几个页面更快”，而是让：

```text
Canonical Facts
    ↓
Local Materialized Projections
    ↓
UI Read Models

Canonical Facts
    ↓
Sync Change Sets / Checkpoint / History
```

成为明确、单向的数据流。

## 2. 强制约束

### 2.1 开发阶段 cutover 规则

- 所有客户端统一升级。
- 本地 IndexedDB 可清空并从远端重新同步。
- Dexie 继续只允许一个 `version(1)`。
- 禁止 `version(2+)`、`.upgrade()`、旧 schema adapter、双读/双写兼容层、fallback reader。
- 不保留“为了旧客户端还能运行”的 runtime 代码。
- schema 切换前必须明确客户端清库/重同步步骤；未经用户授权不得发布生产。

### 2.2 Git / 实施纪律

- 禁止 `git reset` / `git clean`。
- 当前施工分支固定为 `refactor/database-projection-sync-v10-20260917`。
- 测试先行；每个阶段先写能让旧实现失败的 contract/performance/integrity test。
- 小 commit，单一主题，测试通过即 push。
- 数据库/wire cutover 继续在 Draft PR #59 内完成，不得把半套 wire/schema 合并进 `main`。
- 不通过提高 code-size / export-surface / architecture/performance baseline 来掩盖失败。
- 发现性能回退先定位根因；架构正确不能成为接受 N+1 / 全表扫描的理由。

## 3. 目标分层

### 3.1 Canonical Facts：唯一业务事实

只同步这一层。任何可以从这些事实确定性重建的数据，都不得进入 canonical checkpoint。

#### A. 题库与题目

`bankFolders`

- 保留当前语义。

`banks`

- 保留题库元数据。
- 删除持久化 `questionCount`；题量由 membership count 或本地 projection 提供。

`questions`

- 保留题目 canonical 内容、solution、tags、favorite、fingerprint。

`bankQuestionMemberships`

- 继续作为题库 ↔ 题目关系的唯一事实。
- canonical key：`[bankId+questionId]` 或等价稳定 key。
- 必须保留 `sortOrder`。

`notes`

- 继续以 `questionId` 为主键保存个人解析。

#### B. 题组正常化

`questionGroups`

- 只保存组元数据：`id/name/type/description/createdAt/updatedAt/deviceId`。
- 不再内嵌 `items[]`。

`questionGroupItems`

- 一行一个关系：`groupId/questionId/position/note?`。
- 推荐主键：`[groupId+questionId]`。
- 索引：`groupId`、`questionId`、`[groupId+position]`。

结果：删题只按 `questionId` 删除关系，不再扫描所有 group JSON。

#### C. 复习轮次正常化

`reviewRounds`

- 只保存轮次元数据与状态：`id/name/status/startedAt/completedAt?/createdAt/updatedAt/deviceId`。
- 不再内嵌 `bankIds` / `finalQuestionIds`。

`reviewRoundBanks`

- 保存轮次来源题库：`roundId/bankId/position`。
- 主键：`[roundId+bankId]`。
- `bankId` 是来源关系；删除当前题库时不得强制删除历史轮次。

`reviewRoundItems`

- 仅保存完成轮次的最终题目快照，或明确的固定题目集合。
- 字段：`roundId/questionId/position`。
- 主键：`[roundId+questionId]`。
- active round 若仍按当前题库 membership 动态解析题目，则不要提前复制整套 items；完成时一次性固化 snapshot。

结果：删 bank/question 不再改写 round 的数组字段。

#### D. 练习记录正常化

`practiceRuns`

只保存练习会话元数据：

- `id`
- `mode` / `modeLabel`
- `status`
- `startedAt`
- `updatedAt`
- `activityAt`
- `completedAt?`
- `abandonedAt?`
- `revision`
- `reviewRoundId?`
- 必要的不可变展示 snapshot（例如 `bankNameSnapshot`），但不保存大题目/答案 Map。

`practiceRunSources`

- 保存本次练习来自哪些题库。
- 字段：`runId/bankId/bankNameSnapshot/position`。
- 历史 attribution 可在 bank 被删除后继续保留，不要求 parent bank 仍存在。

`practiceRunItems`

- 一题一行：`runId/questionId/position/questionTypeSnapshot/optionOrder/draftResponse?/submittedAttemptId?`。
- 主键：`[runId+questionId]`。
- 索引：`runId`、`questionId`、`[runId+position]`。
- `draftResponse` 只用于未提交 UI 状态；提交后已提交答案事实由 `submittedAttemptId -> attempts` 决定。
- 不再在 run 上保存 `answers/questionTypes/optionOrders/questionIds` 大 Map。

**强制事实所有权：**

- 已提交答案的 `selected/response/correct/outcome/elapsedMs` 只以 attempt 为事实。
- run item 只保存到 attempt 的引用和必要的 UI draft。
- 禁止再次形成 `practiceRun.answers` 与 `attempts` 双写事实源。

#### E. 作答事实

`attempts`

目标字段至少包括：

- `id`
- `runId`
- `questionId`
- `reviewRoundId?`
- `sourceBankId?`
- `response`
- `selected`（仅在当前 UI/导出仍需要时保留；不得与 response 产生语义冲突）
- `outcome`
- `correct`
- `elapsedMs`
- `createdAt`
- `deviceId`

目标索引至少包括：

```text
id
runId
questionId
reviewRoundId
createdAt
[questionId+createdAt]
[runId+createdAt]
[reviewRoundId+createdAt]
[reviewRoundId+questionId+createdAt]
```

`attemptRoundIds` reducer-only metadata 必须删除；轮次 provenance 进入 canonical attempt。

实施前先审计 `attempt.update` / `practice.answer.updated` 是否仍有真实产品入口：

- 若不可达：删除 mutation、codec、reducer、测试夹具中的该兼容路径。
- 若可达：必须明确“修正一次作答”的领域语义后再建模，禁止继续隐式覆盖 immutable history。优先建模为新 attempt + supersedes relation，而不是静默改旧事实。

#### F. 图片事实与缓存分离

`imageAssets`

- 只保存 descriptor：`id/mimeType/size/width/height`。
- canonical/sync 可见。

`imageBlobs`

- 仅本地 cache：`assetId/blob/cachedAt?/lastUsedAt?`。
- 不同步。
- descriptor write 与 blob cache write 不再共享同一 row。

### 3.2 Local Materialized Projections：可丢弃、可重建

以下表均为 device-local，可在 restore/reconcile 后从 canonical facts 全量或增量重建，不进入远端 checkpoint/change set：

`questionProgress`

- 替代 `attemptStats`。
- 主键 `questionId`。
- 由 attempts 计算 lifetime total/correct/wrong/giveUps/streak/recent outcomes/latestAttemptAt。

`questionDailyProgress`

- 替代 `attemptDailyStats`。
- 主键 `[date+questionId]`。
- 索引 `date`、`questionId`。

`reviewRoundProgress`

- 保留表名可以，但明确为 local projection。
- 100% 从 `attempt.reviewRoundId` 重建。
- 不同步、不进 checkpoint。

`bankPracticeStats`

- 替代 `practiceRunStats`。
- 从 `practiceRuns + practiceRunSources` 重建。

不再需要 `practiceRunActivity`：

- `activityAt` 直接属于 `practiceRuns`。
- 练习历史直接使用 `activityAt` / `[status+activityAt]` 索引分页。

是否新增 `bankMetrics` 只在有性能证据后决定；不要为了“可能更快”复制更多投影。

### 3.3 Sync Infrastructure：只同步 canonical facts

保留职责：

- `changeSets`
- `tombstones`
- `syncMeta`
- `syncFiles`

新同步 wire 使用新的当前 namespace/format（`sync/v10`），不与 v9 双栈运行。

**新 checkpoint 不得包含：**

- `questionProgress`
- `questionDailyProgress`
- `reviewRoundProgress`
- `bankPracticeStats`
- `imageBlobs`
- 任何 UI cache/read-model 表

restore 顺序：

```text
install canonical checkpoint
→ hydrate archived attempts / practice-run bundles
→ validate canonical referential integrity
→ rebuild all local projections
→ build local query indexes
→ expose dbReady
```

## 4. 历史数据与删除语义

数据库重构必须同时修正“当前主数据”和“历史事实”之间不必要的强 FK。

### 删除题库

目标语义：

- 删除当前 bank + current memberships。
- 历史 `practiceRunSources` / completed review round attribution 保留 snapshot。
- 不因为 bank 已不存在而删除历史练习。

### 全局删除题目

继续视为明确 destructive operation：

- 删除 question 与当前 memberships/note/group relations。
- 删除该题 attempts 与 run items（因为用户明确要求“题目及学习记录”全局删除）。
- projection 随 canonical delete 重建/增量修正。

### 从题库移除题目

- 只删除 membership。
- 不动全局 question、attempts、run history。

这些语义必须写成独立 domain tests，不能只靠 UI 文案。

## 5. Sync v10 cutover

### 5.1 不允许 runtime 兼容

- 不在 App 中读取 v9 再写 v10。
- 不保留 v9 fallback。
- 新客户端只识别当前 wire。

### 5.2 默认保留现有远端数据

除非用户明确授权清空远端，默认通过**一次性离线转换**保存当前 v9 数据：

1. 从 v9 head/checkpoint/history 完整 hydrate 当前 canonical projection。
2. 转换为新 schema canonical facts。
3. 重建本地 projection，校验统计等价。
4. 生成 v10 checkpoint/history/assets descriptor。
5. 对 counts、IDs、attempt totals、practice run totals、question fingerprints、asset IDs 做校验。
6. 在独立临时 remote prefix 或测试仓库完成 dry-run。
7. 用户授权 cutover 后一次性发布 v10 head。

转换工具：

- 只能放在 `scripts/tools/` 或临时实施 worktree。
- 不得被 runtime import。
- cutover 完成后优先删除临时 converter；如果因审计需要保留，则 architecture gate 必须保证它不进入构建/运行时代码。

## 6. 本地 schema cutover

继续遵守项目策略：只维护当前 `version(1)`。

推荐流程：

1. 直接编辑当前 `version(1).stores(...)` 为目标 schema。
2. 当前开发客户端在首次验证新 schema 前全部清空本地站点/App 数据。
3. 从新 v10 remote 重建。
4. architecture gate 明确禁止旧 store 名、旧 run-map schema、旧 derived sync state 再出现。

不要新增任何 `version(2)` 或 upgrade migration。

## 7. 分阶段执行顺序

### Phase 0 — 基线冻结与语义审计

状态：**完成（PR #58）**。

退出结果：领域语义、schema contract、单一 `version(1)` 与兼容层禁令已锁定。

### Phase 1 — Canonical schema/types

状态：**完成（PR #58）**。

current schema/types 已切换到正常化 canonical facts 与关系表；attempt round provenance、关键复合索引、image descriptor/blob cache 分离均已落地。

### Phase 2 — Domain write path 原子化切换

状态：**完成（PR #58）**。

- question/group/membership、review round、practice run、answer submit、delete cascade、image descriptor/blob cache 写路径已切到新模型。
- 已提交答案只以 `Attempt` 为事实。
- 旧 `attempt.update` / `practice.answer.updated` 兼容 mutation 与 V7/V8 业务 API/type/source filename 已删除。
- Dexie 继续只有一个 `version(1)`，无 `.upgrade()`、无旧 store compatibility。

### Phase 3 — Projection engine

状态：**完成（PR #59）**。

建立统一 projection service：

- full rebuild：restore/repair/test 使用。
- incremental apply：正常 submit/delete/run status 使用。
- full rebuild 与 incremental 最终结果逐字段等价。
- projection 表可删除后从 canonical facts 重建。
- rebuild 不产生 sync change set。
- 大数据 rebuild 先内存聚合，再按 projection table 批量写入；10k attempts 性能门禁禁止逐条 IndexedDB get/put N+1 回退。

已覆盖 differential / idempotence / sync-silence / dirty rebuild / edge cases。

### Phase 4 — UI read-model 全量切换

状态：**完成并于 `ab85baf` 收口（PR #59）**。

已切换/加固：

- Dashboard scope stats。
- Bank Detail lifetime/rolling/round/activity/recent runs。
- PracticeRun / Practice History 关键索引读取。
- rolling 指定题集使用 `[questionId+createdAt]` targeted compound-index reader。

性能门禁：

- Dashboard：同窗口 2,000 条无关 attempts 存在时，指定题集 rolling materialize 约 `2001 → 1`。
- Bank Detail：同窗口 2,000 条无关 attempts 存在时，rolling materialize 约 `2003 → 3`。
- PracticeRun/history 继续保留索引性能门禁。
- `test:ui-data-flow` 禁止“时间窗全量读取后 JS filter(questionId)”旧实现复活。

收口验证：`make test`、Chromium、WebKit、Sync storage CI、Governance Audit、PR Preview 全 PASS。

### Phase 5 — Sync canonical-only 重写

状态：**完成（PR #59）**。

执行：

- 新 change-set mutation 只描述 canonical facts。
- reducer 不再维护 derived arrays。
- checkpoint validator 只验证 canonical state。
- history chunk 明确承载 attempts 与 practice-run bundle（run + sources + items）。
- restore hydration 后统一 rebuild projections。
- 删除 reducer-only `attemptRoundIds`。
- 删除 derived dirty-install/checkpoint counts/bridge 字段。
- checkpoint builder 不得读取或序列化 `questionProgress`、`questionDailyProgress`、`bankPracticeStats`、`reviewRoundProgress`；`imageBlobs` 永远不得进入 wire。

退出条件：双设备 replay、conflict、tombstone、history hydration、partial-history 语义全绿，且 canonical-only payload contract 有明确测试。

### Phase 6 — 一次性 v9 → v10 数据转换

状态：**完成**。

真实生产执行结果：

- 首次 dry-run 正确 fail-closed：发现生产历史中 Attempt 引用已删除 PracticeRun。
- 领域核对确认 `Attempt.runId` 是历史归属 ID；删除 PracticeRun 正式语义保留 Attempt，并写 practiceRun tombstone。
- 补回归测试并修正 checkpoint validator 后，全 CI PASS。
- 第二次真实 dry-run PASS：4,117 questions / 9,706 attempts / 96 practiceRuns / 320 imageAssets；indexedAssets=320。
- 4,367 archived attempts、345 hot change sets 均被 hydrate/转换。
- 正式 cutover PASS：v9 source head SHA `35666d08c74a272e307915c82a0a1402a5f4c104` 未变化后才发布 v10 head。
- v10 checkpoint：`sync/v10/checkpoints/8638bea95c74872834527b4a5ba44282fcde9b7ddaba542091d5ed57bd00df3b.json`。
- v9 namespace 完整保留作为历史备份；runtime 不提供 fallback。
- 一次性 converter 在成功 cutover 后删除。

### Phase 7 — 技术债删除

状态：**完成**。

必须在同一个重构 PR 内删除：

- `practiceRun.answers/questionIds/questionTypes/optionOrders` 旧持久化结构残余。
- `practiceRunActivity`。
- canonical/sync 身份的 `attemptStats/attemptDailyStats/practiceRunStats/reviewRoundProgress`。
- reducer `attemptRoundIds`。
- 旧 derived checkpoint validator/bridge/counts。
- 为旧 schema 服务的 read helper。
- 本轮未提交过的“多索引 count 后择优”补丁路线。

更新 architecture guard，禁止这些旧结构重新出现。

### Phase 8 — 完整验收与 cutover

状态：**生产 cutover 与最终代码验收均已完成；只剩 docs-only CI → ready/merge/release smoke**。

代码验收：

```bash
make test
make test-browser-headless
```

额外必须通过：

- Safari/IndexedDB transaction tests。
- 100k history performance tests。
- sync mock multi-device tests。
- checkpoint/history restore tests。
- projection rebuild differential tests。
- code-size/export/architecture ratchets。
- `git diff --check`。

发布前：

1. 用户明确授权 cutover/发布。
2. 完成 v10 remote 数据验证。
3. 按约定清空所有客户端本地数据。
4. 发布新客户端。
5. 每个平台执行 cold restore + sync + practice submit + relaunch smoke。

用户已授权完成后合并/发布；生产 v10 remote head 已完成安全 cutover。`75d901b9` 已通过最终代码 CI；本次交接文档提交后的 docs-only CI 全绿后即可直接 ready/merge main 并发布。

## 8. 建议 commit 边界

一个 Draft PR，按以下主题小提交：

1. `test: lock next database schema contract`
2. `refactor: normalize canonical relationships`
3. `refactor: split practice run state`
4. `refactor: make attempt round provenance canonical`
5. `refactor: rebuild local progress projections`
6. `refactor: switch read models to indexed projections`
7. `refactor: make sync checkpoint canonical-only`
8. `refactor: cut sync wire to v10`
9. `test: verify v9 to v10 conversion parity`
10. `chore: remove retired database model`
11. `docs: finalize database cutover`

任何 commit 不得靠保留旧路径才能通过下一阶段测试。

## 9. 验收标准

以下条件全部满足才允许把数据库重构 PR 标为 ready：

- Canonical facts 只有一份事实所有权。
- 已提交答案不再复制到 run JSON Map。
- group/round/run 关系已正常化。
- attempts 有直接 round provenance 和关键复合时间索引。
- derived projection 不进入同步 checkpoint/change set。
- 删除 projection 表后可从 canonical facts 100% 重建。
- full rebuild 与 incremental projection 等价。
- bank 删除不再被迫销毁历史 practice attribution。
- global question delete 仍按明确产品语义删除学习记录。
- v9 runtime fallback 为 0。
- Dexie 仍只有 `version(1)`。
- 所有性能门禁、完整 CI、browser headless 全绿。
- HEAD 已 push。

## 10. 当前审计成果与本计划的关系

已提交的正确性/性能修复不要回滚。它们既是当前模型的修复，也是新模型的行为基线：

- 写事务原子性与 stale-write 防护。
- 删除 cascade checkpoint safety。
- practice run invariant。
- lifetime/rolling/round scope 统计语义。
- practice history paging。
- Bank Detail scoped history 与 recent-run 限流。
- Practice result scoped history。
- Projection full/incremental differential、idempotence、sync-silence。
- Dashboard / Bank Detail targeted compound-index read 性能门禁。

重构后的模型必须让这些测试“因为结构天然正确而通过”，而不是删除测试、抬高 baseline 或恢复全表扫描来规避问题。
