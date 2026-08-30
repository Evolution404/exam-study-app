# Sync v9 本地安装与写入性能治理计划

基线：`main@6fa0c0ad154a07fbd7c5487e3d11dbef8b809883`

目标：解决 v9 数据下载完成后，本地 projection 安装/恢复阶段明显偏慢的问题。在不改变 Sync v9 wire format、CAS、history archive、queue guard、tombstone、完整恢复和多设备一致性语义的前提下，将日常同步成本从接近全库规模收敛到本次实际变化规模。

## Phase 1 — 基准与阶段计时

- 建立接近真实 vault 规模的 IndexedDB install benchmark。
- 将 install 拆分并记录：projection planning、本地读取/比较、真正 IndexedDB mutation、restore post-install cache rebuild。
- 指标至少包含阶段耗时、扫描/比较行数、put/delete 行数和 fast-path/dirty-path 命中情况。
- 性能测试不使用脆弱的绝对毫秒阈值作为唯一门禁；同时使用 I/O 次数/扫描行数等确定性断言。

验收：可以明确回答“慢在比较还是写入”，CI 能防止重新引入全表 clear/rebuild 或无界扫描。

## Phase 2 — Fresh Install Fast Path

- 本机 projection 确认为首次安装/空库时，跳过 `primaryKeys → bulkGet → equivalent` 全量比较。
- 直接在受 queue guard 保护的事务内分批写入目标 projection。
- 保留 image asset descriptor、本地 Blob cache、change-set clear 和事务 watchdog 语义。

验收：fresh install 的 planning scan 接近 0；写入行数等于目标 projection 行数；完整现有测试通过。

## Phase 3 — Restore 去除二次全库读取

- `restoreFullHistoryFromGitHub()` 在 install 成功后，不再调用 `createSyncCheckpointV7()` 重新读取所有 IndexedDB store。
- 直接从已经在内存中的最终 projection 构建 checkpoint/cache/counts。
- 保持 remote cache、queue base、installed head/cursors、committed change-set 和 prune 顺序不变。

验收：restore install 后不再发生 projection stores 的全量 `toArray()`；恢复结果和 counts 与原路径一致。

## Phase 4 — Dirty-Key Installer

- 从本轮 remote unseen change-sets、本地 pending rebase 和必要的派生更新中提取 dirty entity keys。
- ordinary sync 在 checkpoint identity 未改变、不是首次安装/恢复时，只读取/比较/写入 dirty keys。
- 删除必须精确覆盖；membership、tombstone、attempt stats/daily stats、practice/review derived tables 必须纳入 dirty closure。
- checkpoint identity 变化、compaction、无法证明 dirty set 完整等情况回退到 full reconcile。

验收：单条远端题目变更不会扫描所有 questions/attempts；普通增量成本随本次变化量增长，而不是随整个数据库增长；多设备/CAS/history/restore 全部回归通过。

## 不做

- 不升级 IndexedDB schema。
- 不改变 v9 checkpoint/segment/history archive 格式。
- 不削弱 Sync v9 完整性、CAS、queue guard、tombstone 或 restore 语义。
- 不通过单纯增大 bulkPut batch size 掩盖全库扫描问题。
