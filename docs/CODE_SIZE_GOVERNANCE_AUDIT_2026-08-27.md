# 代码量治理审计（2026-08-27）

基线：`main@7e2d8013b5606dace24147637b3a33e55916b993`

## 结论

当前项目已经完成上一轮 AppShell 与 Browser E2E 单体拆分，因此代码量风险不再集中于单个入口文件，而是转为 **Sync 子系统总体积过大、若干 25–32 KiB 生产模块、多组 20–31 KiB 测试文件，以及样式/页面实现的横向膨胀**。

本轮治理目标不是“为了行数而拆文件”，而是：

1. 删除确实无用的代码、兼容壳、重复 helper 与重复测试 fixture；
2. 合并同职责但分散的薄 wrapper / barrel / alias；
3. 对仍然多职责的大模块按协议边界拆分；
4. 建立代码量可观测与增量 ratchet，防止治理完成后重新膨胀；
5. 不改变 Sync v9 wire format、数据库 schema、恢复语义、Asset Pack 布局、搜索几何门禁和发布语义。

## 当前热点

### P0：Sync 子系统

当前最大生产文件几乎都集中在 `src/lib/sync`：

- `github-v7-remote.ts`：32,278 B
- `image-asset-pack.ts`：32,126 B
- `sync-v7-checkpoint-validation.ts`：29,185 B
- `sync-v7-orchestrator.ts`：27,806 B
- `sync-v8-history.ts`：22,844 B
- `change-set-v7-reducer.ts`：22,163 B
- `sync-v7-head-operations.ts`：18,471 B
- `change-set-v7-planning.ts`：15,171 B

这些文件大多不是单纯“长”，而是同时承担 codec/validation/remote IO/planning/apply/cache 等职责。优先抽取纯函数与协议无关的机械逻辑，不修改 wire format 和调用顺序。

### P0：生产 UI / I/O 大文件

- `search-view.tsx`：30,598 B
- `practice-setup.tsx`：27,850 B
- `shell/views/practice.tsx`：27,479 B
- `xlsx-import.ts`：25,358 B
- `image-assets.ts`：22,825 B
- `bank-detail.tsx`：22,769 B
- `question-editor.tsx`：22,749 B
- `question-bank-export.ts`：22,073 B
- `db-v7-practice.ts`：22,230 B
- `knowledge-view.tsx`：22,210 B
- `sync-event-manager.tsx`：21,333 B
- `use-practice-session-controller.ts`：20,296 B

这些模块应逐个判断：是否存在可删除重复逻辑、是否可以抽共享纯函数、是否只是 JSX 体积大。只有职责真正混杂时才拆文件。

### P1：测试体量

当前测试代码也有明显热点：

- `test-question-images.ts`：31,381 B
- `test-sync-question-management.ts`：28,688 B
- `browser/specs/desktop.mjs`：24,743 B
- `test-progress-metrics-boundaries.ts`：24,340 B
- `test-db-v7.ts`：22,083 B
- `browser/specs/management.mjs`：21,739 B
- `test-sync-coalescing.ts`：20,919 B
- `browser/helpers.mjs`：20,925 B

测试治理原则：优先抽 fixture/builders/assertion helpers，不能通过删覆盖、合并断言或放宽严格 geometry 来“减代码”。

### P1：CSS 横向体积

CSS 已经有 architecture ratchet，但仍存在大量 8–14 KiB 文件以及 `*-1.css` / `*-2.css` / `*-3.css` 人工分片。代码量治理不应再次按文件大小机械切片；后续应按 component/domain ownership 合并重复 selector/token，并保持现有 CSS governance baseline。

## 已完成，不重复做

- `AppShell` 当前约 15.7 KiB，上一轮 controller 拆分已经生效。
- `scripts/tests/test-browser-visible.mjs` 已缩为 31 B 兼容入口，Browser E2E 已拆到 `scripts/tests/browser/`。
- 不恢复旧单体结构。

## 执行阶段

### Phase A — 建立真实代码量基线

改造 `report-project-health.mjs`：

- 输出 `src`、`scripts/tests`、`scripts/tools`、CSS 的文件数/bytes/lines 总量；
- 输出按一级/二级目录聚合；
- 输出 >20 KiB、>15 KiB 热点数量；
- 保持 report-only，不用一个全仓硬上限阻止正常重构。

同时新增增量治理检查：只阻止 **新出现的超大文件** 和 **既有热点继续显著增长**，不要求一次性把所有历史大文件清零。

### Phase B — 删除/合并低风险冗余

全仓检查：

- 仅 re-export 的无价值 barrel；
- 单调用点 alias / wrapper；
- 重复 normalize/parse/helper；
- 重复 test fixture / fake remote builder；
- 已无调用的 source files / exports；
- 历史命名残留（v8 名称但实际是 current-only 语义）仅在不影响持久协议路径时处理。

所有删除必须由 `knip`、typecheck、Fast checks 与对应行为测试证明安全。

### Phase C — Sync 分批瘦身

顺序：

1. `github-v7-remote.ts`：拆 transport/request/object/history API，保持同一 remote facade；
2. `image-asset-pack.ts`：拆 index/shard/pack codec 与 remote orchestration；
3. `sync-v7-checkpoint-validation.ts`：按 descriptor/content/reference validation 拆纯函数；
4. `sync-v7-orchestrator.ts`：只拆具名 phase，不改执行顺序；
5. `change-set-v7-reducer.ts` / planning：抽 mutation-family reducer。

每一步独立 commit，并跑 Sync storage CI。

### Phase D — UI / I/O 瘦身

优先 `search-view.tsx`、`practice-setup.tsx`、`practice.tsx`、`xlsx-import.ts`、`question-editor.tsx`。

要求：

- 优先删除重复 derived state / adapters；
- 公共 UI 只在至少两个稳定调用点存在时抽取；
- 不为了让文件短而创建几十个 1–2 KiB 无语义文件。

### Phase E — 测试基础设施去重

把重复 fixture/builders/assert helpers 合并到领域 helper；测试名称和 feature ownership 保持清晰。

## 验收指标

本轮最终验收同时看“净代码量”和“复杂度热点”：

- `src` 总 bytes/lines 相比本 PR 初始基线有实质下降；
- `src/lib/sync` 总体积下降，而不是把代码移到别的目录；
- >20 KiB 生产文件数量下降；
- 不新增新的 >20 KiB 生产文件；
- tests 若因更强覆盖增长可以接受，但重复 fixture/helper 应下降；
- `npm run build`、`npm run test:fast`、Sync storage CI、Governance Audit、Chromium/WebKit smoke 全绿；
- 不修改协议/数据/恢复/发布语义来换取代码量下降。
