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
- Phase 5：功能实现已完成，当前做最终 CI / 文档收口；checkpoint/history 已是 canonical-only。
- Phase 6：下一阶段，一次性 Sync v9 → v10 converter；只允许 dry-run/shadow conversion，未经授权不得生产 cutover。
- Phase 7–8：未开始。

**禁止回退到本文旧版本中的“Phase 3 未开始 / Phase 5 仍在设计”状态。** PR #59 当前代码和 CI 是事实基线。

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

`1fbe9ab` 已更新该契约；`ab85baf` 只修了测试文件自身的语法错误，没有改变查询策略。

## 4. Phase 4 最终验证

`ab85bafad0ad33091c5004cce33274af34ea8cec`：

- `make test`：PASS
- Chromium browser smoke：PASS
- WebKit browser smoke：PASS
- Sync storage CI：PASS
- Governance Audit：PASS
- PR Preview：PASS

不要重新处理已经完成的 Phase 0–4。

## 5. Phase 5 收口：canonical-only sync/checkpoint/history

目标已经落地：sync/checkpoint/history wire 只承载 canonical facts；projection/cache/read-model 不进入远端 payload。

### 已完成

- `sync-checkpoint-store` snapshot transaction 不再读取：
  - `questionProgress`
  - `questionDailyProgress`
  - `bankPracticeStats`
  - `reviewRoundProgress`
  - `imageBlobs`
- `SyncCheckpointState/Counts` 已改为 canonical fact 集合；validator 使用 exact-key contract，旧 derived 字段不能静默混入。
- current checkpoint canonical facts 包括正常化关系：
  - `practiceRuns`
  - `practiceRunSources`
  - `practiceRunItems`
  - `questionGroups`
  - `questionGroupItems`
  - `reviewRounds`
  - `reviewRoundBanks`
  - `reviewRoundItems`
- `Attempt.elapsedMs` 等提交事实继续由 canonical Attempt validator 校验；已删除旧 `recentOutcomes` projection checkpoint 断言。
- history practice-run chunk 不再保存旧聚合 PracticeRun 大对象，改为：
  - `PracticeRunRecord[]`
  - `PracticeRunSource[]`
  - `PracticeRunItem[]`
- partial-history hydration 保证引用闭包：
  - retained Attempt 会带入其 run；
  - retained run 会带入对应 source/item；
  - run item 的 `submittedAttemptId` 会带入被引用 Attempt。
- history merge/filter 只处理 canonical facts，不重新生成旧 `bankIds/questionIds/answers/optionOrders` 聚合结构。
- `test-sync-integrity` 已改为 canonical relation round-trip，并明确禁止 derived projection/cache 字段重新进入 wire。

### 结构治理

Phase 5 改造一度使 `sync-history.ts` 增长到 30,572 B，触发 code-size ratchet。没有提高 baseline，而是拆出 `src/lib/sync/sync-history-state.ts` 承担纯状态算法；主文件已降到 22,818 B，低于原 22,844 B 门禁。

Export surface 同步收紧：

- unused exports：`107 → 104`
- unused exported types：`36 → 33`

这两项只能继续下降，禁止反向抬高预算。

### Phase 5 当前验证

在 `bbd0c1c`：

- 完整 Pull request CI：PASS
  - `make test`：PASS
  - Chromium browser smoke：PASS
  - WebKit browser smoke：PASS
- Sync storage CI：PASS
- PR Preview：PASS
- Governance：code-size / dependency audit / dead-code / export-surface 本体均 PASS；只要求把自动收紧后的 unused-type baseline `36 → 33` 提交。

该 baseline 已在 `79e3237` 提交。确认最新 Governance 全绿后，Phase 5 可标记完成。

## 6. Phase 6 要求：v9 → v10 一次性 converter

Phase 5 全绿后立即进入，但只能做代码、测试和 dry-run/shadow conversion；未经用户授权不得写生产 v10 head。

### 强制实现边界

- converter 只能位于 `scripts/tools/` 或隔离实施代码；runtime 不得 import。
- 读取 v9 remote 必须只读；先完整 hydrate 当前 v9 canonical projection。
- 输出 v10 shadow data，不能覆盖/删除生产 v9 namespace。
- converter 必须可重复执行、结果确定；失败后再次执行不能产生额外副作用。
- 不允许 App runtime 同时理解 v9/v10；不保留 fallback reader、协议协商、旧 wire alias。
- converter 成功不等于 cutover 获授权。

### dry-run 必须核对的不变量

- question ID / fingerprint。
- bank / membership。
- Attempt ID、总数、按 question/run/round 归属。
- practice run ID、状态、source/item 关系。
- review round / bank / item 关系。
- note / group / group item。
- image asset ID / size descriptor。
- tombstone/cursor 必要一致性。
- lifetime / 90d / review-round 指标 old-vs-new differential。

任何 mismatch 都必须 fail closed；不得靠 fallback 或兼容层继续。

## 7. Phase 7–8

Phase 7：删除剩余旧结构、旧命名和兼容技术债，并加强 architecture guards。重点包括：

- 旧 PracticeRun 大对象持久化/转换残余。
- `practiceRunActivity` 残余。
- canonical/sync 身份的 derived stats/progress 残余。
- `attemptRoundIds` 残余。
- derived checkpoint validator/counts/bridge 残余。
- 旧 reader/helper 与版本号式业务命名。
- 加门禁阻止旧 wire/store/API/compatibility 结构重新出现。

Phase 8：最终全量验证、converter dry-run/cutover、发布和生产 smoke。只有用户明确授权后才能执行生产 cutover / merge / release。

## 8. 关键架构边界

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

## 9. 相关文档

- `AGENTS.md`
- `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md`
- `docs/HANDOFF-BUG-PERFORMANCE-AUDIT-2026-09-17.md`
- `docs/HANDOFF-PERFORMANCE-AUDIT-2026-09-16.md`

后续接手者先核对 PR #59 最新 HEAD / commits / CI / diff，再按本文当前阶段继续；不要以历史文档中的旧 HEAD、旧 projection-wire 设计或“Phase 3 未开始”描述覆盖当前实现。
