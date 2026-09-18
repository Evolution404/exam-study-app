# 项目交接文档

> 更新时间：2026-09-18（Asia/Tokyo）
>
> 仓库：`Evolution404/exam-study-app`
>
> 当前工作方式：**只使用 GitHub / 云端环境；不要连接用户 Mac。**
>
> 当前 Draft PR：#62 `refactor: harden canonical database architecture`
>
> 当前分支：`refactor/database-architecture-hardening-20260918`
>
> 完整实施计划：`docs/DATABASE-ARCHITECTURE-HARDENING-PLAN-2026-09-18.md`

## 0. 当前状态

上一轮运行时热点/数据库安装边界优化已经在 PR #61 完成并合并：

- PR #61：`perf: remove runtime scaling hotspots`
- 最终 HEAD：`c449a8563880661fb698220c587067722f53ade9`
- merge commit：`5c83d6412a18c96594aa0c5a9295737cf1419290`
- Pull request CI / Full make test / Chromium / WebKit / Sync storage / Governance / PR Preview：全部 PASS。

PR #61 已完成：

- PracticeRun checkpoint/reconcile 批量拆解；
- targeted draft / answer write；
- projection crash recovery marker；
- Practice Setup / Bank Detail / Dashboard targeted reads；
- Bank Detail round/daily 精确查询；
- pending queue O(P²) 清理；
- image Blob lazy hydration；
- reducer table-level copy-on-write + lookup index；
- normalized restore/checkpoint/cache restore/reconcile 边界。

不要重新处理这些已完成内容。

## 1. PR #62 的目的

本轮不是继续零散查询优化，而是把数据库架构彻底统一为：

```text
CanonicalState
  -> ChangeSet / Checkpoint / History / Reconcile
  -> Projection Dependency Planner
       -> Local Projections
            -> UI Read Models

PracticeDrafts / ImageBlobs
  -> local only
  -> never sync
```

深审已确认的核心问题：

1. `ChangeSetProjection` 仍同时包含 canonical、aggregate 和 derived arrays；
2. change-set mutation 仍携带 aggregate PracticeRun / QuestionGroup / ReviewRound；
3. `PracticeRunItem.draftSelected/draftResponse` 所有权错误，local draft 混在 canonical relation；
4. `Bank.questionCount` 仍是可重建值，却被持久化/同步；
5. dirty-install 仍残留 `attemptStats/attemptDailyStats/practiceRunStats/reviewRoundProgress` derived keys；
6. canonical record type 仍依赖 UI aggregate type 的 `Omit<...>`；
7. projection 只有 crash pending marker，没有 model revision；
8. `bankPracticeStats.latestActivityAt` 删除最新 run 时增量更新不完全可逆；
9. streak exact counter 与 32 条 `recentOutcomes` window 存在语义耦合风险；
10. cold-bank recent runs 缺少 `[bankId+activityAt]` 本地索引 projection。

完整证据、目标 schema、阶段和验收标准全部写在新的 hardening plan 中；不要以旧的 2026-09-17 文档覆盖它。

## 2. 强制约束

1. 测试先行；每个 Phase 先提交能让旧实现失败的 contract/correctness/performance test。
2. 小 commit、单一主题、及时 push。
3. 禁止 `git reset` / `git clean`。
4. Dexie 继续只有当前唯一 `version(1)`。
5. 禁止 `version(2+)`、`.upgrade()`、migration chain、旧 schema adapter。
6. 所有客户端统一升级；本地 IndexedDB 可清空并从远端重建。
7. 禁止 runtime sync 双栈、fallback、dual read/write compatibility。
8. canonical fact 只能有一个 owner；projection/local transient/cache 不得进入 sync wire。
9. 不允许提高性能/code-size/export/architecture baseline 掩盖失败。
10. 不连接用户 Mac。
11. PR #62 未经用户明确授权，不得 merge、release 或执行真实生产 sync cutover。

## 3. 当前生产同步事实

- 当前 production runtime：Sync v10。
- v10 已完成生产 head-last cutover并稳定运行。
- v9 namespace 保留为不可变历史备份，当前 runtime 不读取。
- 下一轮如果 normalized mutation / Bank schema 改变 wire，计划使用一次性新 namespace cutover，而不是 runtime 双栈。
- 真正 cutover 必须放在实现后期：先 dry-run + parity + 全 CI，之后再使用用户明确授权。

## 4. Phase 顺序

严格按以下顺序：

### Phase 0 — 契约冻结

只写测试/门禁，不先改实现：

- CanonicalState 单一事实 envelope；
- reducer 禁止 derived arrays；
- normalized mutation payload；
- Bank canonical 禁止 questionCount；
- PracticeRunItem canonical 禁止 draft；
- DirtyInstallKeys 禁止 derived keys；
- explicit canonical record types；
- projection model revision；
- latestActivityAt delete differential；
- >32 streak exactness；
- cold-bank recent runs performance；
- schema exact contract。

### Phase 1 — CanonicalState / 类型所有权

- explicit persisted record types；
- 删除 persisted type 对 aggregate `Omit` 依赖；
- checkpoint/restore/reconcile/reducer 收敛到 CanonicalState；
- 删除 RestoreState 这种第二完整状态类型。

### Phase 2 — canonical reducer / normalized change-set

- 退役 ChangeSetProjection aggregate+derived 模型；
- reducer 只处理 CanonicalState；
- normalise run/group/round mutation bundle；
- dirty install 只表达 canonical dirty keys。

### Phase 3 — PracticeDrafts

- 新增 local-only `practiceDrafts`；
- PracticeRunItem 删除 draft 字段；
- submit 同事务删除 draft；
- hydration 只在 read-model overlay draft。

### Phase 4 — Bank.questionCount 派生化

- canonical Bank 删除 questionCount；
- 新增 local `bankQuestionStats`；
- 删除 refreshBankQuestionCountInTx / derived bank dirty closure。

### Phase 5 — Projection dependency / correctness

- ProjectionImpact planner；
- projection model revision；
- normalized full rebuild；
- 修复 bankPracticeStats latestActivityAt；
- exact streak 与 recentOutcomes 解耦。

### Phase 6 — bankPracticeRunIndex

- 新增 `[bankId+activityAt]` projection；
- recent runs 精确索引读取；
- cold-bank 大规模门禁。

### Phase 7 — identity/cache/dead store cleanup

- relation duplicate identity 审计；
- local projection redundant key 清理；
- `syncFiles` owner 审计；
- imageBlobs wire guard；
- unused aggregate helpers/types 清理。

### Phase 8 — 新 wire dry-run

只有本轮确实改变 wire 后执行；一次性工具隔离在 `scripts/tools/`。

### Phase 9 — cutover/release

仅用户明确授权后执行。

## 5. 立即下一步

下一个 AI 从 **Phase 0** 开始。

先核对：

- PR #62 最新 HEAD / CI；
- `AGENTS.md`；
- 本文；
- `docs/DATABASE-ARCHITECTURE-HARDENING-PLAN-2026-09-18.md`；
- `git status`（若未来恢复本地环境时仍禁止 reset/clean）。

然后先新增 contract tests，不能直接重构实现。

优先测试顺序：

1. CanonicalState / reducer derived-state ban；
2. Bank.questionCount canonical ban；
3. draft wire ban；
4. dirty-key derived ban；
5. explicit persisted record type contract；
6. bankPracticeStats delete-latest differential；
7. 64+ streak exactness；
8. cold-bank recent run materialization gate。

Phase 0 红灯必须是预期架构红灯；不要通过放宽门禁让它变绿。
