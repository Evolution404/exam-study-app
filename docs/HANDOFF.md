# 项目交接文档

> 更新时间：2026-09-17（Asia/Tokyo）
> 仓库：`Evolution404/exam-study-app`
> 当前工作方式：只使用 GitHub / 云端环境；不要连接用户 Mac。
> 完整数据库重构基线见 `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md`。

## 0. 当前工作面

- Draft PR：#59 `refactor: rebuildable projections and canonical sync v10`
- 分支：`refactor/database-projection-sync-v10-20260917`
- base：PR #58 merge 后的 `main@0e74cb10d5ba469d0e501828523ea85cf30e05d9`
- Phase 0–2：PR #58 已完成并合并。
- Phase 3：已完成并收口。
- Phase 4：已完成并在 `ab85baf` 上全门禁通过。
- Phase 5：当前进行中，目标是让 sync/checkpoint/history wire 只承载 canonical facts。
- Phase 6–8：未开始。

**禁止回退到本文旧版本中的“Phase 3 未开始”状态。** PR #59 当前代码和 CI 是事实基线。

未经用户明确授权：

- 不执行生产 remote cutover。
- 不合并 `main`。
- 不发布。

## 1. 强制约束

1. 测试先行，小 commit，单一主题，验证通过及时 push。
2. 禁止 `git reset` / `git clean`。
3. Dexie 只允许当前 `version(1)`；禁止 `version(2+)`、`.upgrade()`、migration chain。
4. 所有客户端统一升级；本地数据可清空重新同步，不需要旧客户端兼容。
5. 禁止旧 store、旧 API alias、runtime 双栈、fallback reader、双读双写 compatibility layer。
6. canonical fact 只能有一个事实源；projection 必须可删除、可重建、不得同步。
7. 已提交答案只以 `Attempt` 为事实；不得把 `PracticeRun` 恢复为 `answers/questionIds/questionTypes/optionOrders` 大对象双写模型。
8. 不允许通过提高 baseline、放宽 architecture/performance guard 掩盖失败。
9. 性能回退先找根因；不能为了“架构正确”接受 N+1、全表扫描或无关数据 materialize。
10. 真实 Sync v9 → v10 只允许一次性 converter；禁止 v9/v10 runtime 双栈和长期兼容层。

## 2. Phase 3 收口：统一 projection engine

当前 local projections：

- `questionProgress`
- `questionDailyProgress`
- `reviewRoundProgress`
- `bankPracticeStats`

它们全部是 device-local derived state，只能由 canonical facts 重建。

已完成：

- canonical facts → local projections 的统一 projection engine。
- full rebuild / dirty incremental rebuild。
- full 与 incremental differential 等价测试。
- projection deletion + rebuild recovery。
- idempotence。
- rebuild sync-silence：重建 projection 不产生 change set。
- restore/reconcile 使用已 materialize 的 canonical snapshot 直接批量重建，避免写完 canonical 后再逐行从 IndexedDB 读回。

性能要求：

- 10k attempts rebuild 已控制为“内存聚合 + 每个 projection table 批量写入”。
- 禁止恢复逐 attempt `get/put` 的 IndexedDB N+1 路径。

关键文件：

- `src/lib/db/projection-engine.ts`
- `src/lib/db/db-attempt-projections.ts`
- `scripts/tests/test-projection-rebuild.ts`
- `scripts/tests/test-projection-edge-cases.ts`

## 3. Phase 4 收口：read-model / targeted indexes

已完成主要热点：

- Dashboard scope stats。
- Bank Detail rolling/lifetime/round/recent history。
- PracticeRun / Practice History 关键索引读取门禁。

### Dashboard

指定题集 rolling 不再：

```text
createdAt 时间窗全读
→ JS filter(questionId)
```

而是：

```text
readAttemptsForQuestionIdsInWindow(ids, from, to)
→ [questionId+createdAt] compound index
```

性能门禁：加入同窗口 2,000 条无关 attempts 后，目标读取约 `2001 → 1` 行。

### Bank Detail

rolling 统计按 `questionId + createdAt` 定向读取，不 materialize 同时间窗其他题目的 attempts。

性能门禁：加入同窗口 2,000 条无关 attempts 后，目标读取约 `2003 → 3` 行。

### UI/data-flow guard

`scripts/tests/test-ui-data-flow.ts` 已锁定：

- 指定题集必须调用 `readAttemptsForQuestionIdsInWindow(ids, from, to)`。
- 必须使用 `[questionId+createdAt]`。
- 禁止恢复 `rows.filter(row => idSet.has(row.questionId))` 的时间窗全量读取路径。

`1fbe9ab` 已更新该契约；随后发现测试文件自身少一个右括号，`ab85baf` 只修了这个语法错误，没有改变查询策略。

## 4. Phase 4 最终验证

`ab85bafad0ad33091c5004cce33274af34ea8cec`：

- `make test`：PASS
- Chromium browser smoke：PASS
- WebKit browser smoke：PASS
- Sync storage CI：PASS
- Governance Audit：PASS
- PR Preview：PASS

不要重新处理已经完成的 Phase 0–4。

## 5. 当前 Phase 5 审计结果

目标：sync/change-set/checkpoint/history 只承载 canonical facts；projection/cache/read-model 不进入远端 wire。

已经确认一个明确残余：`src/lib/sync/sync-checkpoint-store.ts` 当前仍读取并序列化 derived projections：

- `studyDb.questionProgress`
- `studyDb.questionDailyProgress`
- `studyDb.bankPracticeStats`
- `studyDb.reviewRoundProgress`

`src/lib/sync/sync-checkpoint-types.ts` 当前 `SyncCheckpointCounts` 也仍保留：

- `attemptStats`
- `attemptDailyStats`
- `practiceRunStats`
- `reviewRoundProgress`

这些都必须在 Phase 5 删除，而不是改名后继续同步。

`imageBlobs` 是纯本地 cache，永远不得进入 checkpoint/change-set/history wire。

`db-restore.ts` 已经具备正确方向：canonical install 后调用 `rebuildProjectionsFromFacts(...)`，并明确忽略旧 payload 中的 projection rows。Phase 5 应继续收紧类型和 validator，让新 wire 根本不允许这些 derived 字段存在。

## 6. Phase 5 执行顺序

按以下顺序继续，测试先行：

1. 新增/收紧 canonical-only checkpoint contract：新 checkpoint state/counts 不得出现 projection/cache 字段；测试应先让当前实现失败。
2. 改 `sync-checkpoint-types.ts` / `sync-checkpoint-store.ts`：snapshot transaction 只读取 canonical tables + queue/cursor 所需基础设施；不再读取 projection tables。
3. 改 `sync-checkpoint-validation.ts`：只校验 canonical facts 与 canonical referential integrity，删除 derived stats/progress validator。
4. 审计 change-set reducer/projection：mutation 只描述 canonical facts；删除 derived arrays / reducer-only bridge state。
5. 审计 history chunk：明确只携带 attempts + practice-run bundle 所需 canonical facts。
6. restore/hydration 完成后统一调用 projection rebuild。
7. 删除 `attemptRoundIds`、derived dirty-install fields、derived checkpoint counts/bridge。
8. 跑双设备 replay、conflict、tombstone、history hydration、partial-history、sync storage、完整 `make test`。
9. Phase 5 全绿后更新本文和数据库计划，再进入 Phase 6。

## 7. Phase 6 要求：v9 → v10 一次性 converter

Phase 5 收口后才开始。

- converter 只能在 `scripts/tools/` 或隔离的实施环境中存在；runtime 不得 import。
- 先读取 v9 数据做 dry-run/shadow conversion。
- 必须校验：questions/fingerprints、banks/memberships、attempt IDs/totals、practice runs/status、review rounds/items、notes/groups、image asset IDs/size、lifetime/90d/round 指标。
- converter 必须可重复执行；失败不得破坏或修改生产 v9 remote。
- 不保留 v9 reader、v10 fallback、双栈协议。
- 未经用户授权，不做生产 cutover。

## 8. Phase 7–8

Phase 7：删除剩余旧结构、旧命名和兼容技术债，并加强 architecture guards。重点包括：

- 旧 PracticeRun 大对象持久化残余。
- `practiceRunActivity`。
- canonical/sync 身份的 derived stats/progress。
- `attemptRoundIds`。
- derived checkpoint validator/counts/bridge。
- 旧 reader/helper。

Phase 8：最终全量验证、converter dry-run/cutover、发布和生产 smoke。只有用户明确授权后才能执行生产 cutover / merge / release。

## 9. 关键架构边界

### Local database

- 唯一 IndexedDB：`shijuan-study`。
- 唯一 Dexie schema version：`version(1)`。
- `Attempt` 是提交答案事实。
- `practiceRunSources` / `practiceRunItems` 是正常化关系事实。
- `imageAssets` 是 canonical descriptor；`imageBlobs` 是 local cache。

### Sync

当前生产事实仍是 Sync v9。PR #59 的目标是一次性切到 Sync v10；在 cutover 前不要把半套 v10 发布到生产。

运行时代码不允许通过“为了兼容”同时支持 v9/v10。

### Git / CI

- 保持 PR #59 Draft，直到 Phase 5–8 与最终验收完成。
- 每个阶段拆小 commit。
- GitHub CI 是云端验证基线；不要连接用户 Mac。

## 10. 相关文档

- `AGENTS.md`
- `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md`
- `docs/HANDOFF-BUG-PERFORMANCE-AUDIT-2026-09-17.md`
- `docs/HANDOFF-PERFORMANCE-AUDIT-2026-09-16.md`

后续接手者先核对 PR #59 最新 HEAD / commits / CI / diff，再按本文 Phase 5 顺序继续；不要以历史文档中的旧 HEAD 或“Phase 3 未开始”描述覆盖当前实现。
