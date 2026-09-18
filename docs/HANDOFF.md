# 项目交接文档

> 更新时间：2026-09-18（Asia/Tokyo）
>
> 仓库：`Evolution404/exam-study-app`
>
> 当前工作方式：**只使用 GitHub / 云端环境；不要连接用户 Mac。**
>
> PR：#62 `refactor: harden canonical database architecture`
>
> 分支：`refactor/database-architecture-hardening-20260918`
>
> 完整实施记录：`docs/DATABASE-ARCHITECTURE-HARDENING-PLAN-2026-09-18.md`

## 0. 当前状态

数据库架构 hardening Phase 0–9 已全部完成。

生产 Sync v11 已于 2026-09-18 完成 head-last cutover并回读验证：

- 最终 cutover App SHA：`2c2523d43b3281b77e77b62955b53e4a1f10078a`
- vault：`Evolution404/exam-study-vault@main`
- v10 source head：`89df24b80a02392827f2c2771845904e04fe5f46`
- v11 formatVersion：11
- v11 generation：1
- v11 checkpoint：`sync/v11/checkpoints/c27a6495dc4031909f1c3c66c78b31a7db254d65517bc0a5dab56f509c2480d6.json`
- cutover workflow run：`35337199397`，SUCCESS
- v10 namespace 保留为不可变回退基线，当前 runtime 不读取。

真实生产转换事实：

- 10 个题库
- 4117 道题
- 4410 条题库关系
- 320 个图片资产
- 9707 条作答
- 914 条笔记
- 96 个练习
- 255 条练习来源关系
- 13068 条练习题目关系
- 12 个题组
- 105 条题组关系
- 623 条 tombstone

## 1. 本轮最终架构

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

关键约束已经落实：

1. `CanonicalState` 是唯一完整 canonical state；
2. Bank 不再持久化/同步 `questionCount`；
3. `PracticeRunItem` 不再保存 draft；
4. `practiceDrafts`、`imageBlobs` 都是 local-only；
5. reducer/change-set/checkpoint/history/reconcile 使用 normalized canonical records；
6. projection 使用 `ProjectionImpact` dependency planner；
7. projection model revision 已建立，可识别算法升级后的 stale projection；
8. `bankPracticeRunIndex` 提供 `[bankId+activityAt]` 精确查询；
9. 当前 runtime 只认 Sync v11；禁止 v10 fallback / dual read / dual write；
10. Dexie 仍只有唯一当前 `version(1)`，禁止 migration chain。

## 2. 本轮修复的重要问题

- 修复 `deleteBankWithExclusiveQuestions()` 父事务遗漏 `practiceDrafts`；
- 修复 `setQuestionMemberships()` 父事务遗漏 `bankQuestionStats`；
- 修复较早 `practice.answer.*` 回放覆盖已完成 run 生命周期状态的问题；
- 修复 `bankPracticeStats.latestActivityAt` 删除最新 run 后不可逆；
- exact streak 不再受 32 条 recentOutcomes 窗口截断；
- recent bank practice runs 不再扫描全局 run；
- canonical lookup cache 避免稳定 ID 重复全扫；
- dirty incremental install、projection crash recovery、model revision rebuild 均已门禁；
- 删除 dead `syncFiles` store 与旧 aggregate/兼容性残留。

## 3. 验收状态

切换前最终完整 CI 已通过：

- Governance Audit：PASS
- Sync storage CI：PASS
- PR Preview：PASS
- Pull request CI：PASS
- Chromium Browser smoke：PASS
- WebKit Browser smoke：PASS
- TypeScript typecheck：PASS
- ESLint / Stylelint / dead-code：PASS

关键性能/正确性门禁：

- canonical replay：批量回放显著快于逐条回放，且稳定 lookup 不反复全扫；
- 2000 questions / 10000 attempts incremental install：单题 dirty install 只写目标行；
- 500-item run draft / answer：单题操作保持 targeted reads；
- cold-bank recent history：只 materialize 请求页；
- 10k/100k 级统计与搜索门禁通过；
- multi-device / CAS / tombstone / compaction / restore / Safari IndexedDB 全通过。

## 4. 后续规则

- 不要恢复 v10 runtime compatibility；v10 只作为远端不可变备份。
- 不要增加 Dexie `version(2+)` 或 `.upgrade()`，除非用户明确改变当前开发阶段策略。
- 不要把 derived/local-only 数据重新塞进 CanonicalState。
- 不要提高性能、code-size、export 或 architecture baseline 来掩盖失败。
- 继续测试先行、小 commit、及时 push。
- 禁止连接用户 Mac，除非用户以后明确改变这一约束。

## 5. 当前剩余动作

当前 PR #62 只剩发布收尾：

1. 删除一次性 v10→v11 converter/test；
2. 完整 CI 再跑一遍；
3. PR Ready；
4. merge main；
5. 等待 GitHub Pages / Cloudflare / SideStore 自动发布；
6. 执行发布后 smoke；
7. 若全部成功，PR #62 与本轮数据库架构任务正式关闭。
