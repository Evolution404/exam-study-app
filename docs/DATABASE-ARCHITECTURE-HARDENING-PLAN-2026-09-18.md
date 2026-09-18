# 数据库架构深度审计与下一阶段重构计划（2026-09-18）

> 状态：**待实施**
>
> 基线：PR #61 已于 2026-09-18 合并，merge commit `5c83d6412a18c96594aa0c5a9295737cf1419290`。
>
> 施工分支：`refactor/database-architecture-hardening-20260918`
>
> Draft PR：#62 `refactor: harden canonical database architecture`
>
> 本文是 `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md` 完成后的下一阶段计划。旧文档保留为 Sync v10 / projection 正常化的历史实施基线；后续数据库架构工作以本文为准。
>
> 当前阶段只做方案冻结与 PR 建立；**不要在没有测试先行的情况下直接改 schema/wire，也不要连接用户 Mac。**

---

## 0. 结论

上一轮数据库重构已经解决了最严重的结构问题：

- IndexedDB 只保留当前唯一 `version(1)`；
- PracticeRun / QuestionGroup / ReviewRound 的持久化关系已正常化；
- 已提交答案以 `Attempt` 为事实；
- checkpoint/history 已是 canonical-only；
- projection 已明确为 device-local、可重建状态；
- restore/reconcile 已开始直接消费 normalized relation tables；
- 图片 descriptor 与 Blob cache 已逻辑分离；
- 关键 read path 已增加 compound index 和性能门禁。

因此**下一轮不应该推翻 schema 重做**，而应该把已经确定的“Canonical Facts → Local Projections → UI Read Models”贯彻到所有边界。

本次深审发现 6 个核心结构问题：

1. **同步 reducer 仍不是 canonical-only**：`ChangeSetProjection` 同时持有 canonical facts、aggregate PracticeRun/QuestionGroup/ReviewRound 和四类 derived arrays。
2. **change-set payload 仍使用 aggregate domain object**：例如 `practice.run.saved` 携带完整 `PracticeRun`，与 normalized DB/checkpoint 不同构。
3. **草稿所有权错误**：`draftSelected/draftResponse` 位于 canonical `practiceRunItems`，但不产生 change-set，属于“长得像 canonical、实际是 local transient”的混合状态。
4. **`Bank.questionCount` 仍被持久化/同步**：它完全由 membership 可确定重建，不应是 canonical Bank 字段。
5. **projection 维护仍缺统一依赖模型**：dirty-install、domain write、full rebuild 各自维护一套影响面，且仍残留已退役的 `attemptStats/attemptDailyStats/practiceRunStats/reviewRoundProgress` dirty keys。
6. **跨表热查询缺少本地索引投影**：例如“某题库最近 5 次练习”仍需 `practiceRunSources → practiceRuns` 跨表筛选，冷门题库会扫描大量全局新 run。

除此之外还有 4 个重要但次一级的问题：

- canonical record type 仍大量从 UI aggregate type 通过 `Omit<...>` 派生，类型所有权方向反了；
- projection crash marker 只能识别“上次写到一半”，无法识别“projection 算法已经变更但表仍非空”；
- `bankPracticeStats.latestActivityAt` 的增量减法不是完全可逆：删除/迁移最新 run 时可能留下过新的 latestActivityAt；
- streak 统计依赖最多 32 条 `recentOutcomes` 重新计数，连续正确超过窗口后存在被窗口上限截断的语义风险。

目标不是继续增加页面级补丁，而是让所有层只存在以下单向数据流：

```text
CanonicalState
   ├─> ChangeSet / Checkpoint / History / Reconcile
   │
   └─> Projection Dependency Planner
            └─> Local Projections
                    └─> UI Read Models

Local-only transient/cache
   ├─> PracticeDrafts
   └─> ImageBlobs

Local-only 数据绝不进入 CanonicalState / ChangeSet / Checkpoint。
```

---

# 1. 深度审计范围

本次审计覆盖：

- `src/lib/db/db-core.ts`
- `src/lib/db/types.ts`
- PracticeRun / ReviewRound / QuestionGroup normalized stores
- attempts / progress projection
- `projection-engine.ts`
- restore / reconcile
- change-set reducer / derived projection
- dirty install
- checkpoint / history / cached restore
- Bank Detail / Practice Setup / Practice History 关键查询
- image descriptor / Blob cache
- database schema contract / architecture guards / performance guards

审计维度：

1. 事实所有权；
2. normalization；
3. 同步 wire 与本地 schema 是否同构；
4. derived state 是否能删除重建；
5. transaction / crash consistency；
6. query/index 是否与真实访问模式一致；
7. 增量 projection 是否与 full rebuild 等价；
8. local-only state 是否可能被 remote reconcile 覆盖；
9. 类型是否准确表达持久化边界；
10. schema/wire 演进是否会再次引入 compatibility debt。

---

# 2. 当前数据分层审计

## 2.1 当前真正的 canonical facts

当前 IndexedDB 中以下表应继续作为 canonical facts：

```text
banks
bankFolders
questions
bankQuestionMemberships
imageAssets
attempts
notes

practiceRuns
practiceRunSources
practiceRunItems

questionGroups
questionGroupItems

reviewRounds
reviewRoundBanks
reviewRoundItems

tombstones
```

其中需要修正：

- `banks.questionCount` 不应继续是 canonical；
- `practiceRunItems.draftSelected/draftResponse` 不应继续是 canonical；
- relation row 上仅为了兼容 string key 的重复 identity 字段要逐项审计，能由 compound PK 确定生成的不要形成第二身份源。

## 2.2 当前 local projections

继续保留：

```text
questionProgress
questionDailyProgress
reviewRoundProgress
bankPracticeStats
```

计划新增：

```text
bankQuestionStats
bankPracticeRunIndex
```

它们全部必须满足：

- 可删除；
- 可由 canonical facts 确定重建；
- 不进 change-set；
- 不进 checkpoint；
- 不进 history；
- 不作为 tombstone 对象；
- rebuild 不产生 sync 事件。

## 2.3 当前 local transient/cache

当前：

```text
imageBlobs
```

计划新增：

```text
practiceDrafts
```

两者都不属于同步事实。

`practiceDrafts` 保留在同一个 StudyDatabase 中，而不是第二个 DB，因为提交答案时需要实现：

```text
Attempt 写入
+ PracticeRun metadata/item 更新
+ draft 删除
+ change-set 入队
```

在一个 IndexedDB transaction 中完成。

`imageBlobs` 本轮只做**逻辑隔离**，不拆第二个 Dexie database。仓库当前治理要求保持唯一 Dexie `version(1)` 声明；为纯 cache 引入第二个 Dexie schema 的收益不足以覆盖复杂度和治理成本。

---

# 3. P0：CanonicalState 目前并不唯一

## 3.1 问题

当前已经存在 normalized checkpoint/restore state，但代码里仍有多个“系统完整状态”的近似表达：

- `RestoreState`
- `SyncCheckpointState`
- `ChangeSetProjection`
- aggregate `PracticeRun`
- aggregate `QuestionGroup`
- aggregate `ReviewRound`

其中最严重的是 `ChangeSetProjection`，当前仍包含：

```text
attemptStats
attemptDailyStats
practiceRunStats
reviewRoundProgress
```

并且 PracticeRun / QuestionGroup / ReviewRound 还是 aggregate object。

结果是：

```text
checkpoint(normalized canonical)
    ↓ assemble
reducer(aggregate + derived)
    ↓ decompose
reconcile(normalized canonical)
```

PR #61 已经开始拆除 restore/reconcile 的 aggregate bounce，但 reducer 本身尚未正常化。

## 3.2 目标

建立**唯一**完整事实类型：

```ts
interface CanonicalState {
  banks: BankRecord[];
  bankFolders: BankFolderRecord[];
  questions: QuestionRecord[];
  memberships: BankQuestionMembership[];

  imageAssets: ImageAssetDescriptor[];
  attempts: Attempt[];
  notes: Note[];

  practiceRuns: PracticeRunRecord[];
  practiceRunSources: PracticeRunSource[];
  practiceRunItems: PracticeRunItem[];

  questionGroups: QuestionGroupRecord[];
  questionGroupItems: QuestionGroupItem[];

  reviewRounds: ReviewRoundRecord[];
  reviewRoundBanks: ReviewRoundBank[];
  reviewRoundItems: ReviewRoundItem[];

  tombstones: Tombstone[];
}
```

以下全部直接使用该结构：

```text
SyncCheckpoint.state
restoreLocalCheckpoint()
reconcileCanonicalState()
queue base
cached restore
change-set reducer base/final state
one-time converter output
```

不再维护第二套完整“RestoreState”。

## 3.3 类型所有权必须反转

当前 `src/lib/db/types.ts` 中存在：

```ts
PracticeRunRecord = Omit<PracticeRun, ...>
QuestionGroupRecord = Omit<QuestionGroup, "items">
ReviewRoundRecord = Omit<ReviewRound, ...>
```

这意味着 persisted canonical type 依赖 UI aggregate type。

应改为：

```text
canonical record type
    ↓ hydrate
aggregate/read-model type
    ↓ UI
```

而不是：

```text
UI aggregate type
    ↓ Omit
canonical persisted type
```

要求：

- canonical record type 明确定义字段；
- aggregate `PracticeRun` 只作为 read model；
- UI 类型不得决定持久化字段；
- 删除 `types.ts` 中“v9 sync wire”等过期注释；
- 修正 “PracticeRun is the only persisted source of truth” 等已经错误的注释。

---

# 4. P0：同步 reducer 必须 canonical-only

## 4.1 当前问题

`ChangeSetProjection` 仍维护：

- aggregate PracticeRun；
- aggregate QuestionGroup；
- aggregate ReviewRound；
- AttemptStats；
- AttemptDailyStats；
- PracticeRunStats；
- ReviewRoundProgress。

`recomputeChangeSetProjection()` 会在 reducer 内重新生成 derived arrays。

`sync-dirty-install.ts` 仍有：

```text
attemptStats
attemptDailyStats
practiceRunStats
reviewRoundProgress
```

dirty keys。

这违反当前已经确定的原则：

> derived projection 不属于同步事实。

## 4.2 目标

change-set reducer 只处理 `CanonicalState`。

删除 reducer 中所有 derived array。

reducer 输出：

```text
CanonicalState
+ skipped/conflict metadata
```

projection rebuild/update 在 IndexedDB install 之后由 Projection Engine 完成。

## 4.3 normalized mutation payload

当前 change-set 仍携带 aggregate payload，例如：

```text
practice.run.saved -> PracticeRun
questionGroup.saved -> QuestionGroup
review.round.saved -> ReviewRound
```

下一阶段 payload 必须与 canonical schema 同构。

建议：

```ts
practice.run.saved {
  record: PracticeRunRecord
  sources: PracticeRunSource[]
  items: PracticeRunItem[]
}

questionGroup.saved {
  record: QuestionGroupRecord
  items: QuestionGroupItem[]
}

review.round.saved {
  record: ReviewRoundRecord
  banks: ReviewRoundBank[]
  items: ReviewRoundItem[]
}
```

`practice.answer.submitted` 不再重复保存一个 UI `PracticeAnswer` 对象。

它只携带真正发生变化的 canonical facts，例如：

```text
Attempt
PracticeRunRecord metadata
PracticeRunItem submittedAttemptId
```

具体 mutation shape 在 Phase 1 先通过 contract test 固定，不允许一边施工一边临时扩大。

## 4.4 不要改成通用 table-op 协议

不要把 change-set 变成：

```text
{ table, op, key, value }
```

通用数据库 patch。

原因：

- 会丢失领域级 conflict/cascade 语义；
- tombstone/replay phase 很难验证；
- UI/domain 写路径会直接绑定存储表名；
- 后续难以演进。

保留 domain mutation，但 payload 必须是 normalized canonical facts。

---

# 5. P0：Practice draft 必须移出 canonical relation

## 5.1 当前问题

`PracticeRunItem` 当前同时包含：

```text
questionTypeSnapshot
optionOrder
submittedAttemptId

draftSelected
draftResponse
```

前三类属于 run definition/submitted attribution。

draft 是：

- device-local；
- 未提交；
- 不产生 change-set；
- 不应进入 checkpoint；
- 不应被另一个设备决定；
- remote reconcile 不应覆盖。

当前结构违反所有权边界。

## 5.2 新表

```text
practiceDrafts
PK: [runId+questionId]
indexes:
  runId
  updatedAt
```

字段：

```ts
interface PracticeDraft {
  runId: string;
  questionId: string;
  selected: string[];
  response?: PracticeResponse;
  updatedAt: string;
}
```

不要保存：

- submitted；
- correct；
- deviceId；
- eventId；
- revision；
- sync metadata。

## 5.3 写入语义

草稿保存：

```text
practiceRuns.get(runId)
practiceRunItems.get([runId, questionId])
practiceDrafts.put(...)
```

无 change-set。

提交答案：

同一 transaction 内：

```text
attempts.put
practiceRuns.put metadata
practiceRunItems.put submittedAttemptId
practiceDrafts.delete
projections update
changeSets.put
```

## 5.4 hydration

`hydratePracticeRunRecords`：

1. 读取 canonical run/source/item；
2. 读取 submitted attempts；
3. 读取 local drafts；
4. 只在 read-model 层组合 `answers`。

remote checkpoint/reducer 永远看不到 draft。

## 5.5 restore/reconcile 后 cleanup

安装新的 canonical state 后：

- 保留仍指向 live run + live item 的 draft；
- 删除 run/item 已不存在的 orphan draft；
- 不因为 remote update 触发无条件清空所有 draft。

增加明确测试：

- remote reconcile 不覆盖同 run/item 的本地 draft；
- remote 删除 run 后 draft 被清理；
- submit 后 draft 原子删除；
- crash/relaunch 后本机 draft 可恢复；
- draft 永不进入 checkpoint/change-set/history。

---

# 6. P0：Bank.questionCount 不是 canonical fact

## 6.1 当前问题

`Bank.questionCount`：

- create 时写 0；
- membership 变化后 count；
- dirty install 还要把 membership 变化扩展到 bank dirty key；
- Bank 对象进入 change-set/checkpoint。

但：

```text
questionCount = count(bankQuestionMemberships where bankId)
```

它完全是 derived state。

同步它会导致：

- Bank update 与 membership update 双事实源；
- replay 顺序增加额外约束；
- dirty-install 必须人为维护 count closure；
- checkpoint 可能存在 count/membership 不一致。

## 6.2 目标

从 canonical `BankRecord` 中删除 `questionCount`。

新增 local projection：

```text
bankQuestionStats
PK: bankId
questionCount
```

Bank UI read model：

```text
BankRecord + bankQuestionStats.questionCount
```

如果页面只显示少量 bank，也允许一次性读取 memberships 后内存 group；但默认以 projection 避免长期 N+1 count。

## 6.3 删除旧维护路径

删除：

- `refreshBankQuestionCountInTx()`
- Bank change-set 中 derived count
- dirty-install 中 membership → banks 仅为了 questionCount 的扩展
- validator 中 questionCount consistency（若存在）
- UI 对 canonical Bank.questionCount 的依赖

---

# 7. P1：Projection Engine 需要统一 dependency planner

## 7.1 当前问题

projection 影响面目前分散在：

- domain write path；
- `projection-engine.ts`；
- dirty install；
- reconcile；
- full rebuild；
- delete cascade。

结果是同一事实变化被多处分别编码。

`DirtyInstallKeys` 甚至还保留上一代：

```text
attemptStats
attemptDailyStats
practiceRunStats
reviewRoundProgress
```

命名。

## 7.2 新模型

引入一个纯函数 dependency planner：

```ts
interface ProjectionImpact {
  questionIds: Set<string>;
  questionDailyKeys: Set<[date, questionId]>;
  reviewRoundQuestionKeys: Set<[roundId, questionId]>;
  bankIds: Set<string>;
  bankRunKeys: Set<[bankId, runId]>;
}
```

输入：

```text
canonical mutation / old+new canonical rows
```

输出：

```text
需要重新计算的 projection keys
```

Projection Engine 根据 impact 从 canonical tables 做**定向重算**，而不是让 sync dirty-install 自己推导 derived table keys。

## 7.3 dirty install 只描述 canonical dirty keys

新的 DirtyInstallKeys 只允许：

```text
banks
bankFolders
questions
memberships
imageAssets
attempts
notes
practiceRuns
practiceRunSources
practiceRunItems
questionGroups
questionGroupItems
reviewRounds
reviewRoundBanks
reviewRoundItems
tombstones
```

禁止：

```text
attemptStats
attemptDailyStats
practiceRunStats
reviewRoundProgress
bankPracticeStats
bankQuestionStats
bankPracticeRunIndex
```

derived impact 必须由 planner 根据 canonical diff 计算。

---

# 8. P1：Projection crash consistency 需要“模型签名”

## 8.1 当前 marker 的能力

当前：

```text
projection:rebuild-pending
```

能解决：

```text
canonical commit
→ app crash
→ projection rebuild 未完成
```

这是正确的。

## 8.2 缺口

如果 projection 算法发生改变，但本地表：

- 非空；
- 没有 pending marker；

启动不会知道“旧 projection 是按旧算法算出来的”。

## 8.3 目标

在 `syncMeta` 增加真正的 projection model revision：

```text
projection:model-revision
```

代码中有一个真实架构常量，例如：

```ts
PROJECTION_MODEL_REVISION = 2
```

这属于真实模型版本，不是业务函数名后缀技术债。

启动：

```text
pending marker exists
OR persisted model revision != current revision
    ↓
full rebuild projections
    ↓
同一 projection transaction:
  clear pending
  write current revision
```

projection 算法语义改变时必须同步提升 revision，并有 architecture test。

---

# 9. P1：bankPracticeStats 的增量算法必须可逆

## 9.1 当前风险

当前 `updatePracticeRunStatsInTx(previous, next)` 通过加减：

- total；
- completed；
- inProgress；
- abandoned。

但 `latestActivityAt` 只向更大的 next.updatedAt 推进。

如果：

- 删除当前最新 run；
- run 从 bank A 移到 bank B；
- 某次 destructive repair 移除最新 run；

旧 bank 的 `latestActivityAt` 可能继续保留已删除 run 的时间。

## 9.2 目标

对于受影响 bank，不做不完全可逆的 arithmetic patch。

使用：

```text
affected bankIds
→ canonical practiceRunSources
→ bulkGet PracticeRunRecord
→ recompute exact bankPracticeStats row
```

受影响 bank 通常很少，定向重算比维护复杂逆操作更可靠。

必须新增 differential test：

- 删除最新 run；
- 删除非最新 run；
- run source 迁移；
- completed ↔ abandoned/status transition；
- incremental 结果逐字段等于 full rebuild。

---

# 10. P1：streak 与 recentOutcomes 必须解耦

## 10.1 当前风险

`recentOutcomes` 最多保留 32 条。

当前 `currentCorrectStreak` / `correctStreakAfterWrong` 的部分实现会从该 bounded window 重新计数。

如果真实连续正确超过 32：

- UI 最近轨迹保留 32 条是合理的；
- streak 统计被限制到 32 则不是同一语义。

## 10.2 目标

明确：

```text
recentOutcomes = bounded display/history cache
currentCorrectStreak = exact aggregate
correctStreakAfterWrong = exact aggregate
```

incremental reducer 用上一行 exact counters 更新，而不是从最近 32 条重新推导 exact streak。

full rebuild 从全部 attempts 计算。

新增至少：

- 连续正确 64 次；
- 错 1 次 + 正确 64 次；
- out-of-order old attempt；
- projection rebuild 与 incremental 等价。

ReviewRoundProgress 同样处理。

---

# 11. P1：新增 bankPracticeRunIndex，解决跨表 recent runs

## 11.1 当前问题

当前某题库最近练习：

```text
practiceRunSources where bankId
→ 得到 runIds
→ practiceRuns 全局 updatedAt 倒序
→ filter(runIds)
→ limit(5)
```

目标 bank 很冷、全局近期 run 很多时，会扫描大量无关 run。

改成“冷 bank bulkGet / 热 bank 全局 scan”的自适应算法虽然可用，但会把数据分布策略散落进 read path。

## 11.2 新 projection

```text
bankPracticeRunIndex
PK: [bankId+runId]
indexes:
  bankId
  [bankId+activityAt]
```

字段：

```ts
{
  bankId
  runId
  activityAt
  status
}
```

如果当前 UI 后续需要 bank + status recent，可以再以真实查询证据增加：

```text
[bankId+status+activityAt]
```

不要预先建立不用的索引。

## 11.3 查询

```text
where [bankId+activityAt]
reverse
limit(5)
→ bulkGet practiceRuns
→ hydrate selected 5
```

全局有多少其他 bank run 都不影响 materialized rows。

必须加入冷门题库规模门禁：

- 1,000+ 更新的其他 bank runs；
- target bank 只有 2 条旧 run；
- practiceRuns materialize 仅 target rows；
- 结果顺序正确。

---

# 12. P1：新增 bankQuestionStats，移除 derived Bank 字段

```text
bankQuestionStats
PK: bankId
questionCount
```

它的 dependency 只有 membership。

新增/移除/split/import membership 时：

- 只重算受影响 bank；
- 不写 Bank canonical row；
- 不产生额外 bank change-set。

Bank list read-model 一次读取：

```text
banks
+ bankQuestionStats
+ bankPracticeStats（需要时）
```

---

# 13. P1：full projection rebuild 必须完全基于 normalized facts

当前 `rebuildAllProjections()` 仍读取：

- PracticeRunRecord
- PracticeRunSource
- PracticeRunItem
- Attempts

然后 assemble aggregate PracticeRun 再投影。

下一阶段删除该 bounce。

full projection reducer 直接输入：

```text
attempts
practiceRunRecords
practiceRunSources
memberships
```

即可计算当前全部 projection。

`practiceRunItems` 只有在某个 projection 真正需要 item 时才读取；不要因为历史 aggregate helper 还存在就默认读取。

---

# 14. P2：关系 identity 去重复

逐项审计：

```text
BankQuestionMembership.key
AttemptDailyStats.key
ReviewRoundProgress.key
```

其中 local projection 的 `key` 字段应优先删除，因为 compound primary key 已经是身份。

对于 canonical membership：

当前：

```text
PK = [bankId+questionId]
同时保存 key = "bankId:questionId"
```

这是双身份表达。

目标优先：

- persisted relation 以 compound PK 为唯一身份；
- sync mutation 使用结构化 `bankId/questionId`；
- tombstone 若仍要求一个 string entityId，通过统一 helper 在边界生成，不把 string key 再持久化进 membership row。

如果实现会明显扩大 tombstone 协议范围，可以把 membership.key 删除放在后续独立 commit，但必须有“不一致 key” architecture test，禁止永久双身份无校验共存。

---

# 15. P2：Image Blob cache 保持单 DB，但进一步隔离

本轮不创建第二个 Dexie DB。

继续保持：

```text
imageAssets = canonical descriptor
imageBlobs  = local cache
```

强化规则：

- `CanonicalState` 不允许 imageBlobs；
- restore 不 clear imageBlobs；
- reconcile descriptor delete 可按产品语义清对应 blob；
- image upload 只为 remote missing asset 按需读取 blob；
- image cache 下载失败不影响 canonical transaction；
- clear cache 永远不能修改 imageAssets/changeSets；
- architecture guard 禁止 `imageBlobs` 出现在 sync/checkpoint/history/reducer state type。

未来只有在：

- Safari/IndexedDB 大 Blob 实测成为主库阻塞瓶颈；
- 或 cache 容量治理必须独立；

时，才重新评估 Cache Storage / 独立 cache store。届时需要用户明确批准修改“一份 Dexie version(1)”治理规则。

---

# 16. P2：查询层进一步审计，不盲目加索引

## 16.1 readAttemptsForQuestionIdsInWindow

当前按每个 questionId 发一个 compound range query。

优点：

- 不 materialize 同时间窗无关题；
- 已有强性能门禁。

风险：

- 题目集合达到几千时 query fan-out 为 O(Q)。

本轮先加观测/规模测试：

- 100 questions；
- 1,000 questions；
- 4,000 questions。

只有证明确实成为主瓶颈后才设计新的 rolling projection 或 chunked query planner。

不要为了减少 request 数又退回：

```text
createdAt 全时间窗读取
→ JS filter questionId
```

## 16.2 listUnfiledQuestions

当前 anti-join 需要：

```text
all question primary keys
+ all memberships
```

如果未来未归档题数量/总题量明显扩大，可以引入 `questionMembershipStats` local projection。

当前不先加表；先建立规模证据。

## 16.3 indexes

每个新增 index 必须回答：

1. 哪个 production read path 使用；
2. 为什么现有 compound index 不够；
3. materialized row / IDB request 能降低多少；
4. 写放大成本是多少。

禁止“可能以后有用”的索引。

---

# 17. Sync wire cutover 方案

## 17.1 为什么这轮很可能需要新 wire

以下修改会改变同步事实形态：

- Bank 去掉 questionCount；
- PracticeRunItem 去掉 drafts；
- change-set mutation 改为 normalized bundle；
- reducer state 改为 canonical-only。

这不是单纯本地 schema 修改。

## 17.2 不做 runtime 双栈

仍遵守：

- 不在 App runtime 同时支持两代 wire；
- 不写 fallback reader；
- 不写 v10/v11 dual-write；
- 不保留历史 decoder 在 app bundle。

## 17.3 推荐新 namespace cutover

建议在实现阶段确认使用下一 current namespace（预期 `sync/v11`），而不是原地让 v10 head 同时接受两种 change-set payload。

一次性工具：

```text
读取 v10 final canonical state
+ hydrate v10 hot segments/history
→ 转为新 CanonicalState
→ strip Bank.questionCount
→ strip PracticeRunItem drafts
→ 生成新 checkpoint/history
→ 校验 counts/IDs/attempt totals/run totals/asset descriptors
→ stage
→ read-back validate
→ head-last publish new namespace
```

v10 namespace：

- 保留；
- runtime 不读取；
- 作为不可变备份。

converter：

- 仅 `scripts/tools/`；
- runtime architecture gate 禁止 import；
- cutover 成功后删除，除非用户要求保留审计工具。

## 17.4 当前阶段不要执行生产 cutover

本 PR 建立与代码实现阶段：

- 先完成本地模型、reducer、tests；
- 新 wire dry-run 工具完成；
- 全 CI 绿；
- 再单独请求/使用用户明确发布授权执行真实 cutover。

不要在中间 commit 改生产 head。

---

# 18. 事务边界

必须保留的原子事务：

## 18.1 Domain canonical write

```text
canonical rows
+ tombstone（如有）
+ changeSet
+ sync sequence reservation
```

同一 transaction。

## 18.2 Answer submit

```text
Attempt
+ PracticeRunRecord metadata
+ PracticeRunItem submittedAttemptId
+ PracticeDraft delete
+ local incremental projections
+ changeSet
```

同一 transaction。

## 18.3 Projection rebuild after remote install

仍允许：

```text
Transaction A:
  install canonical facts
  mark projection rebuild pending

Transaction B:
  replace local projections
  write model revision
  clear pending
```

因为 crash marker + model revision 可以保证恢复。

不要为了“一个超级事务”把大 checkpoint install + full projection rebuild 塞进 Safari 超长 write transaction。

---

# 19. Schema 目标草案

继续唯一：

```ts
version(1)
```

目标表：

## Canonical

```text
banks
bankFolders
questions
bankQuestionMemberships
imageAssets
attempts
notes

practiceRuns
practiceRunSources
practiceRunItems

questionGroups
questionGroupItems

reviewRounds
reviewRoundBanks
reviewRoundItems

tombstones
```

## Local transient/cache

```text
practiceDrafts
imageBlobs
```

## Local projections

```text
questionProgress
questionDailyProgress
reviewRoundProgress
bankQuestionStats
bankPracticeStats
bankPracticeRunIndex
```

## Local sync infrastructure

```text
changeSets
syncFiles   // Phase 0 再确认真实 owner；若无 runtime 用途则删除
syncMeta
```

注意：`syncFiles` 当前是否仍有真实 runtime owner 要在 Phase 0 用静态搜索 + 测试确认。没有证据前不要直接删除，但如果确认为历史遗留，应在本 PR 清理。

---

# 20. 不做的事情

本轮明确禁止：

1. 不新增 Dexie `version(2+)`；
2. 不写 `.upgrade()`；
3. 不保留旧 local schema adapter；
4. 不写 runtime sync 双栈；
5. 不把 projection 再写回 checkpoint；
6. 不把草稿同步；
7. 不把 Blob 放进 CanonicalState；
8. 不把 Question content/options 进一步拆成大量子表；
9. 不按月/题库物理分 attempts；
10. 不引入 ORM / generic repository / CQRS framework；
11. 不用类型断言绕过 normalized boundary；
12. 不提高 performance/code-size/export baseline 掩盖回退；
13. 不为“以后可能用”添加索引；
14. 不因为 indexed query request 多就恢复全窗口 materialize；
15. 不创建第二个 Dexie database，除非用户后续明确修改治理规则。

---

# 21. 实施阶段

## Phase 0 — 冻结新契约与补失败测试

先写测试，不改实现。

必须新增/修改 contract：

- `CanonicalState` 是唯一完整 canonical state；
- reducer state 禁止 derived arrays；
- reducer/change-set normalized bundle contract；
- Bank canonical 禁止 questionCount；
- PracticeRunItem canonical 禁止 draft fields；
- drafts 禁止 checkpoint/change-set/history；
- DirtyInstallKeys 禁止 derived projection names；
- explicit canonical record types 不再通过 aggregate Omit 派生；
- projection model revision contract；
- bankPracticeStats latest delete differential；
- streak >32 exactness；
- cold-bank recent run materialization gate；
- schema expected stores/indexes；
- architecture gate 禁止 old names/aggregate wire 回归。

退出条件：旧实现出现预期红灯，失败原因与计划一致。

## Phase 1 — 类型所有权 + CanonicalState

- 新建/整理 canonical record type owner；
- 删除 persisted type 对 UI aggregate type 的 `Omit` 依赖；
- 引入唯一 `CanonicalState`；
- checkpoint/restore/reconcile 类型统一；
- 删除 `RestoreState`；
- 修正 stale comments / old sync naming；
- 不改变业务行为。

退出条件：

- typecheck；
- checkpoint round-trip；
- restore/reconcile；
- architecture contract 全绿。

## Phase 2 — Canonical reducer + normalized change-set

- `ChangeSetProjection` 退役；
- reducer 只持有 CanonicalState；
- 删除 reducer derived arrays/recompute；
- mutation payload 正常化；
- dirty install 只处理 canonical dirty keys；
- queue base 保存 canonical state；
- conflict/tombstone/replay phase 保持行为等价。

退出条件：

- reducer strict/poison/replay equivalence；
- multi-device sync mock；
- queue edit/discard/rebase；
- 100+ / 10k change-set performance guards。

## Phase 3 — PracticeDrafts local ownership

- schema 加 `practiceDrafts`；
- 从 PracticeRunItem 删除 draft 字段；
- save draft 改写新表；
- hydration overlay local draft；
- submit 原子 delete draft；
- reconcile orphan prune；
- sync-silence/restore tests。

退出条件：

- draft ownership tests；
- crash/relaunch；
- remote reconcile 保留 live draft；
- remote run delete 清 orphan；
- checkpoint exact-key contract 不含 draft。

## Phase 4 — Derived Bank 数据清理

- BankRecord 删除 questionCount；
- 增加 `bankQuestionStats`；
- 删除 refreshBankQuestionCountInTx；
- membership mutation 不再额外写 bank 仅为了 count；
- UI bank read-model join local stats；
- remove stale PracticeRunStats/base derived types。

退出条件：

- bank CRUD/import/split/remove；
- membership multi-bank；
- bank list counts；
- sync replay；
- full rebuild/incremental differential。

## Phase 5 — Projection dependency planner + correctness

- 引入 ProjectionImpact；
- 删除 dirty-install derived keys；
- normalized full rebuild；
- projection model revision；
- 修复 bankPracticeStats latestActivityAt；
- exact streak 独立于 recentOutcomes；
- delete/update/restore differential 加固。

退出条件：

- projection full/incremental byte-equivalent（忽略确定允许的顺序差异）；
- delete latest run；
- 64+ streak；
- pending crash recovery；
- model revision forced rebuild；
- 10k / 100k performance guards。

## Phase 6 — bankPracticeRunIndex 与查询切换

- schema 增加 `bankPracticeRunIndex`；
- rebuild/incremental planner 接入；
- `listRecentPracticeRunsForBank` 改 compound index；
- 删除全局 `orderBy(updatedAt).filter(runIds)` 路径；
- cold-bank performance test。

退出条件：

- 目标 2 行 + 1,000/10,000 unrelated recent runs，只 materialize 目标行；
- recent order 与旧语义一致。

## Phase 7 — Relation identity / cache / dead store 审计

- 删除 local projection 冗余 key；
- 审计 membership.key；
- 审计 syncFiles；
- imageBlobs architecture guard；
- 删除旧 aggregate helpers/exports/unused types；
- export-surface/code-size ratchet 只能下降。

退出条件：

- no duplicate identity without invariant；
- no dead stores；
- no old derived sync type。

## Phase 8 — 新 wire dry-run

如果 Phase 2/4 确认改变当前 wire：

- 构建一次性 v10 → next namespace converter；
- dry-run 真实 remote；
- counts/id/reference/assets parity；
- fail-closed；
- 不发布 head。

退出条件：

- dry-run PASS；
- converter runtime isolation PASS；
- full CI PASS。

## Phase 9 — Cutover / cleanup / release

仅在用户明确授权后：

1. 核对 source head 未变化；
2. stage immutable blobs/checkpoint/history；
3. read-back；
4. head-last publish；
5. 保留 v10 immutable backup；
6. 删除一次性 converter；
7. runtime 只认新 namespace；
8. merge main；
9. release；
10. cold restore + sync + answer submit + relaunch smoke。

---

# 22. 建议 commit 边界

按小 commit 推进，建议：

1. `test: lock canonical database ownership contract`
2. `refactor: make canonical state the single fact envelope`
3. `refactor: normalize sync reducer state`
4. `refactor: normalize change-set relation payloads`
5. `refactor: move practice drafts to local state`
6. `refactor: derive bank question counts locally`
7. `refactor: centralize projection dependencies`
8. `fix: make practice projections exactly reversible`
9. `perf: index recent bank practice runs`
10. `refactor: remove duplicate relation identities`
11. `chore: remove retired database model debt`
12. `test: verify next sync cutover parity`
13. `docs: finalize database architecture cutover`

不要一次大 commit 混合 schema、reducer、UI、sync cutover。

---

# 23. 验收矩阵

## Correctness

- canonical facts 有且只有一个 owner；
- Bank.questionCount 不再 canonical；
- draft 不再 canonical；
- submitted answer 只以 Attempt 为答案事实；
- reducer/checkpoint/restore/reconcile 使用同一 CanonicalState；
- projections 删除后 100% 重建；
- incremental = full rebuild；
- latestActivityAt 删除最新 run 后正确；
- >32 streak 精确；
- tombstone/cascade 语义不变；
- Attempt.runId 仍是历史 attribution，不被重新变成 strict live FK。

## Performance

至少验证：

- 10k attempts projection rebuild；
- 100k attempt history；
- 500/2,000 item run 单题 save/submit；
- 1,000+ unrelated recent runs 的 cold-bank recent lookup；
- 4k question rolling read request/materialization；
- reducer 500/2,000 entities × 100+ changes；
- image idempotent sync 0 Blob materialization。

## Crash / transaction

- canonical committed + projection crash；
- projection model revision mismatch；
- Safari transaction；
- answer submit atomicity；
- queue claim/commit/release；
- restore with pending/claimed guard；
- cache restore；
- app relaunch。

## Sync

- multi-device merge；
- concurrent bootstrap；
- CAS retry；
- tombstone GC；
- partial history；
- checkpoint exact-key；
- image asset packs；
- no local-only table in wire。

## Governance

- 唯一 Dexie `version(1)`；
- no `version(2+)`；
- no upgrade chain；
- no compatibility reader；
- no old aggregate persisted model；
- no derived reducer arrays；
- no draft wire；
- no Blob wire；
- code-size/export/dead-code ratchet 不抬高。

---

# 24. PR 策略

下一阶段全部在一个新的 Draft PR 中推进，但按 Phase 小提交。

原因：

- schema + reducer + wire 必须作为一次一致性重构验收；
- 不能让 main 出现“DB 已 normalized、reducer 仍 aggregate”或“新 mutation 已写、旧 runtime 还读”的半状态。

同时要求：

- 每个 Phase 自己全绿后再进入下一 Phase；
- 不等整个 PR 末尾才跑完整 CI；
- 每次大边界变化都更新本文进度；
- `docs/HANDOFF.md` 始终反映当前 HEAD、Phase、CI 和下一步；
- 未经用户授权不得 merge/release/cutover production。

---

# 25. 最终目标架构

```text
                    ┌──────────────────────────────┐
                    │        CanonicalState        │
                    │                              │
                    │ banks / folders / questions │
                    │ memberships                  │
                    │ attempts / notes             │
                    │ run records + relations      │
                    │ group records + relations    │
                    │ round records + relations    │
                    │ image descriptors            │
                    │ tombstones                   │
                    └──────────────┬───────────────┘
                                   │
             ┌─────────────────────┼─────────────────────┐
             │                     │                     │
             ▼                     ▼                     ▼
       ChangeSet Reducer      Checkpoint/History      IndexedDB install
       canonical-only        canonical-only          canonical-only
             │                                           │
             └───────────────────┬───────────────────────┘
                                 ▼
                    Projection Dependency Planner
                                 │
              ┌──────────────────┼───────────────────┐
              ▼                  ▼                   ▼
       questionProgress   bankQuestionStats   bankPracticeStats
       daily/round        bankPracticeRunIndex
              │                  │
              └──────────────┬───┘
                             ▼
                        UI Read Models

Local-only:
  practiceDrafts ──┐
  imageBlobs     ──┴─> never sync
```

完成后，系统应具备一个非常明确的不变量：

> **远端同步、reducer、restore、reconcile 只认识 CanonicalState；所有统计、索引、草稿和 Blob 都是本地附属状态。**

这就是下一阶段数据库重构的最终验收标准。
