# 项目交接文档

> 更新时间：2026-09-18（Asia/Tokyo）
> 仓库：`Evolution404/exam-study-app`
> 当前工作方式：只使用 GitHub / 云端环境；不要连接用户 Mac。
> 完整数据库重构基线见 `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md`。

## 0. 当前工作面

- Draft PR：#59 `refactor: rebuildable projections and canonical sync v10`
- 分支：`refactor/database-projection-sync-v10-20260917`
- Phase 0–2：PR #58 已完成并合并。
- Phase 3–5：projection engine、targeted read-model、canonical-only checkpoint/history 已完成。
- Phase 6：一次性真实生产 v9 → v10 转换已完成；先 dry-run，再 head-last cutover。
- Phase 7：旧 runtime v9 行为、版本号式 runtime 命名和一次性 converter 工具已清理；runtime 只识别当前 v10。
- Phase 8：生产 v10 cutover 已完成；当前只剩最终 docs-only HEAD CI、PR #59 ready/merge 和正式发布/生产 smoke。

用户已明确授权：完成后合并 PR #59 并发布。不要再重复请求 cutover / merge / release 授权。

### 生产 cutover 事实基线

- 真实 dry-run：PASS，使用 App commit `e43a8d21978952d231e9b499b208f8a37ef0a7b6`。
- 生产 v9 source head：generation 907，blob SHA `35666d08c74a272e307915c82a0a1402a5f4c104`。
- v10 head 已发布：formatVersion 10，generation 1。
- v10 checkpoint：`sync/v10/checkpoints/8638bea95c74872834527b4a5ba44282fcde9b7ddaba542091d5ed57bd00df3b.json`。
- 转换事实：10 banks / 3 bankFolders / 4,117 questions / 4,410 memberships / 9,706 attempts / 914 notes / 96 practiceRuns / 255 practiceRunSources / 13,068 practiceRunItems / 12 questionGroups / 105 questionGroupItems / 623 tombstones。
- 历史：4,367 archived attempts，345 hot change sets 均已纳入。
- 图片：320 imageAssets，indexedAssets=320；4 shards，引用 blob SHA 已逐项核对。
- v9 namespace/head 完整保留，不删除、不覆盖；新 runtime 不再读取它。
- 一次性 converter / remote reader / shadow cutover / asset shadow 工具与对应测试、npm scripts 已在 cutover 后删除，避免长期兼容技术债。

### 本次真实数据暴露并修正的领域约束

`Attempt.runId` 是历史归属 ID，不是 live `PracticeRun` 外键。正式 `deletePracticeRun()` 语义是删除练习投影但保留全局 Attempt 学习历史，并写 practiceRun tombstone。checkpoint validator 已据此修正；Attempt → Question、PracticeRunSource/Item → live PracticeRun 等真实约束仍保持严格。

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

## 6. Phase 6–8 收口

Phase 6–8 已完成实现和生产 cutover。

### 一次性转换

- v9 reader/converter 仅在 `scripts/tools/` 隔离存在于实施阶段，runtime 从未 import。
- 首次真实 dry-run 因 validator 错误要求 `Attempt.runId` 必须引用 live run 而 fail-closed；没有写 v10。
- 核对正式删除语义后，补回归并修正 validator：已删除 PracticeRun 的 Attempt 仍是合法全局学习历史。
- 修复后全 CI PASS，再次真实 dry-run PASS。
- 正式 cutover 使用相同 App commit，先 stage/回读验证 immutable v10 数据和 Asset packs，最后 CAS 发布 `sync/v10/head.json`。
- cutover 后再次核对 checkpoint / asset shard Git blob SHA 与 descriptor 一致。
- 一次性转换代码已退役删除，不形成历史 compatibility layer。

### Phase 7 技术债

已完成：

- runtime `sync/v9` 行为残留清零。
- runtime sync protocol 常量统一由当前协议常量驱动；测试不再硬编码旧 namespace。
- 旧 PracticeRun 大对象、derived wire、runtime v9 fallback/dual-read 均没有恢复。
- converter/asset-shadow/remote-reader/shadow-cutover 一次性实施代码已在成功 cutover 后删除。
- Dexie 仍只有 `version(1)`。

### Phase 8 最终状态

已完成：

- `make test`：PASS（真实 cutover 前最终 runtime commit）。
- Chromium browser smoke：PASS。
- WebKit browser smoke：PASS。
- Sync storage CI：PASS。
- Governance Audit：PASS。
- PR Preview：PASS。
- 生产 dry-run：PASS。
- 生产 v10 cutover：PASS。
- v10 checkpoint / Asset index 引用完整性：PASS。
- v9 备份 namespace：保留。

剩余动作仅为：本次 docs/retired-tool 清理后的最终 CI → 将 PR #59 标记 ready → merge main → 触发正式发布并核对生产 smoke。

## 8. 关键架构边界

### Local database

- 唯一 IndexedDB：`shijuan-study`。
- 唯一 Dexie schema version：`version(1)`。
- `Attempt` 是提交答案事实。
- `practiceRunSources` / `practiceRunItems` 是正常化关系事实。
- `imageAssets` 是 canonical descriptor；`imageBlobs` 是 local cache。

### Sync

当前生产事实已经是 Sync v10；`sync/v10/head.json` 已完成 head-last cutover。v9 namespace 仅作为不可变历史备份保留，新 runtime 不读取 v9。

运行时代码不允许通过“为了兼容”同时支持 v9/v10。

### Git / CI

- PR #59 的 Phase 5–8 与生产 cutover 已完成；待本次 docs/retired-tool 最终 CI 全绿后标记 ready 并合并。
- 每个阶段拆小 commit。
- GitHub CI 是云端验证基线；不要连接用户 Mac。

## 9. 相关文档

- `AGENTS.md`
- `docs/DATABASE-ARCHITECTURE-REFACTOR-PLAN-2026-09-17.md`
- `docs/HANDOFF-BUG-PERFORMANCE-AUDIT-2026-09-17.md`
- `docs/HANDOFF-PERFORMANCE-AUDIT-2026-09-16.md`

后续接手者先核对 PR #59 最新 HEAD / commits / CI / diff，再按本文当前阶段继续；不要以历史文档中的旧 HEAD、旧 projection-wire 设计或“Phase 3 未开始”描述覆盖当前实现。
