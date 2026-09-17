# 数据库架构重构执行计划（2026-09-17）

> 状态：Phase 0–2 已实施并完成收口；Phase 3+ 未开始，等待用户明确授权。本文继续作为数据库重构执行基线。
>
> 目标分支：`refactor/database-facts-projections-20260917`
>
> 前置条件已满足：PR #57 已合并，实施分支已从当时最新 `origin/main`（`863b1a8`）创建。当前停在 PR #58 Phase 2 收口边界。

## 0. Phase 0 执行记录

2026-09-17 已完成 Phase 0 基线冻结与语义审计：

- PR #57 已先合并，实施分支 `refactor/database-facts-projections-20260917` 从最新 `origin/main` merge commit `863b1a8` 创建，没有从旧 main 开工。
- 改动前 `make test` 通过（84/84），`make test-browser-headless` 通过全部浏览器组。
- `attempt.update` / `practice.answer.updated` 在产品运行时代码中没有真实写入入口。当前 `recordPracticeAnswer` 每次提交都会生成新的 attempt ID，并只发出 `practice.answer.submitted`；两种 update mutation 只残留于 sync 类型、codec、reducer、dirty-install、事件文案和测试夹具。因此本轮 cutover **直接删除这两种兼容 mutation，不引入 supersede 模型，也不保留 runtime 兼容分支**。如果未来产品需要“修正历史作答”，必须作为新的独立领域需求重新设计。
- 新 schema contract 已由 `scripts/tests/test-database-schema-contract.ts` 锁定，并已确认旧 schema 会失败。该测试明确要求：关系表使用复合主键；`PracticeRun` 拆为 run/source/item；图片 descriptor/blob cache 分表；attempt 增加 round provenance 与关键复合时间索引；旧 `attemptStats` / `attemptDailyStats` / `practiceRunActivity` / `practiceRunStats` store 退出当前 schema。
- Draft PR #58 已创建；Phase 0 的 contract commit 为 `e6c8bdd`。在 Phase 1 完成前，该新 contract 测试预期为红，不得通过削弱 contract 或恢复旧 store 来让它变绿。

Phase 0 已完成；Phase 1 与 Phase 2 也已在 PR #58 完成。当前必须停在 Phase 2 边界，未经用户明确授权不得进入 Phase 3。

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
- 新建 `refactor/database-facts-projections-20260917`。
- 测试先行；每个阶段先写能让旧实现失败的 contract/performance/integrity test。
- 小 commit，单一主题，测试通过即 push。
- 整个数据库/wire cutover 使用一个 Draft PR；不得把半套 schema 合并进 `main`。
- 不通过提高 code-size / export-surface / architecture baseline 来掩盖失败。

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

新同步 wire 使用新的当前 namespace/format（建议 `sync/v10`），不与 v9 双栈运行。

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

前置：当前审计 PR 合并到 `main`。

执行：

1. 从最新 `origin/main` 创建 `refactor/database-facts-projections-20260917`。
2. `make test` + `make test-browser-headless` 建立绿基线。
3. 读取当前 v9 checkpoint/history 数据模型。
4. 审计 `attempt.update` / `practice.answer.updated` 的真实调用路径，决定删除还是显式建模 supersede。
5. 把目标 store/index contract 写成测试，旧 schema 应失败。
6. 尽早创建 Draft PR，后续每个小 commit push 到同一 PR。

退出条件：领域语义无未决项，schema contract 已锁定。

### Phase 1 — Canonical schema/types

执行：

- 改 `v7-types.ts`/后续重命名后的 current types。
- 改唯一 Dexie `version(1)`。
- 新增 group/round/run relationship tables。
- attempts 增加 round provenance 与复合时间索引。
- image descriptor/blob cache 分表。
- 删除 derived table 的 sync/canonical 身份。

此阶段只让 schema/types 可编译，不允许用 temporary compatibility adapter 把旧业务全部糊过去。

退出条件：schema contract、architecture guard、typecheck 通过。

### Phase 2 — Domain write path 原子化切换

按风险顺序：

1. question/group/membership writes。
2. review round create/update/complete/archive。
3. practice run create/progress/status。
4. answer submit：`attempt + runItem.submittedAttemptId + projection update + changeSet` 同一写事务。
5. delete cascades 按新关系表实现。
6. image descriptor/blob cache writes 分离。

每个入口必须测试：事务边界、并发删除、Safari IndexedDB、change-set sequence。

退出条件：所有领域写路径不再写旧数组/Map schema。

#### Phase 2 收口记录（2026-09-17）

- current schema/types 与领域写路径已切换到正常化模型；group/review/run 关系不再以内嵌数组或大 Map 作为持久化事实。
- PracticeRun/source/item 已拆分，已提交答案事实归 `Attempt`；Attempt 已持有 round provenance；图片 descriptor/blob cache 已分离。
- 旧 `attempt.update` / `practice.answer.updated` 兼容 mutation 与 V7/V8 业务 API/type/source filename 已删除，不保留 alias 或 runtime compatibility 分支。
- architecture guard 已加入 version-neutral 命名门禁，并继续强制单一 Dexie `version(1)`、禁止 `.upgrade()` 与历史 schema compatibility。
- Sync v9 仍是当前真实 remote wire；`sync/v9/...` / `formatVersion: 9` 不改写成业务名称，也不作为兼容层。
- Phase 2 最终验收要求：`make test`、Chromium、WebKit、Sync storage CI、Governance Audit、PR Preview 在同一最新 HEAD 全绿。
- 已验证代码基线 `1402459`：上述全部门禁通过，依赖审计 0 vulnerabilities；后续仅允许文档性收尾，仍不得进入 Phase 3。

> **STOP：Phase 3 尚未开始。等待用户明确授权后才能继续。**

### Phase 3 — Projection engine

建立统一 projection service：

- full rebuild：restore/repair/test 使用。
- incremental apply：正常 submit/delete/run status 使用。

要求：

- full rebuild 与 incremental 最终结果逐字段等价。
- projection 表完全可删除后重建。
- rebuild 不产生 sync change set。
- checkpoint 不携带 projection 数据。

退出条件：随机数据集 differential test 全绿。

### Phase 4 — UI read-model 全量切换

优先切换当前已证明的热点：

- Dashboard scope stats。
- Bank Detail lifetime/rolling/round/activity/recent runs。
- Practice Setup / Practice Start。
- Practice History / ResultQuestionDetail。
- Search filters / question manager。

禁止保留“旧 reader + 新 reader fallback”。切完一个领域就删除旧 reader。

性能门禁至少覆盖：

- 100k attempts。
- 10k practice runs。
- 大量 unrelated questions/rounds。
- rolling 查询只 materialize index window。
- lifetime 查询不得扫描 immutable attempts。
- round 查询不得扫描其他 round。

### Phase 5 — Sync canonical-only 重写

执行：

- 新 change-set mutation 只描述 canonical facts。
- reducer 不再维护 derived arrays。
- checkpoint validator 只验证 canonical state。
- history chunk 明确承载 attempts 与 practice-run bundle（run + sources + items）。
- restore hydration 后统一 rebuild projections。
- 删除 reducer-only `attemptRoundIds`。
- 删除 derived dirty-install/checkpoint counts/bridge 字段。

退出条件：双设备 replay、conflict、tombstone、history hydration、partial-history 语义全绿。

### Phase 6 — 一次性 v9 → v10 数据转换

若远端数据要保留：

- 先对真实数据只读导出/快照。
- converter 生成 v10 shadow data。
- 比较以下不变量：
  - question ID/fingerprint 数。
  - bank/membership 数。
  - attempt ID 总数与每题统计。
  - practice run 总数/状态分布。
  - review round 数与最终题目集合。
  - note/group 内容。
  - image asset ID/size。
- 对 lifetime/90d/round 指标做 old-vs-new differential check。

任何 mismatch 都停止 cutover，不加 fallback。

### Phase 7 — 技术债删除

必须在同一个重构 PR 内删除：

- `practiceRun.answers/questionIds/questionTypes/optionOrders` 旧结构。
- `practiceRunActivity`。
- canonical/sync 身份的 `attemptStats/attemptDailyStats/practiceRunStats/reviewRoundProgress`。
- reducer `attemptRoundIds`。
- 旧 derived checkpoint validator/bridge/counts。
- 为旧 schema 服务的 read helper。
- 本轮未提交过的“多索引 count 后择优”补丁路线。

更新 architecture guard，禁止这些旧结构重新出现。

### Phase 8 — 完整验收与 cutover

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

不得在用户授权前升级生产 remote head 或发布应用。

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
9. `test: verify v9 to v10 conversion parity`（如需要保留远端数据）
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
- 工作区 clean，HEAD 已 push。

## 10. 当前审计成果与本计划的关系

本轮已提交的正确性/性能修复不要回滚。它们既是当前生产模型的修复，也是下一版模型的行为基线：

- 写事务原子性与 stale-write 防护。
- 删除 cascade checkpoint safety。
- practice run map invariant。
- lifetime/rolling/round scope 统计语义。
- practice history paging。
- Bank Detail scoped history 与 recent-run 限流。
- Practice result scoped history。

重构后的模型必须让这些测试“因为结构天然正确而通过”，而不是删除测试规避问题。

