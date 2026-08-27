# 代码量治理审计与执行计划（2026-08-27）

基线：`main@7e2d8013b5606dace24147637b3a33e55916b993`

## 目标

本轮只做代码量与复杂度治理，不改变产品行为、Sync v9 协议、IndexedDB schema、Asset Pack wire layout、恢复/GC/replay 语义，也不通过删测试或放宽断言换取行数下降。

代码量治理按三个指标判断是否有效：

1. **净代码是否下降**：删除重复实现、无价值 wrapper、重复 fixture/helper 优先于纯拆文件。
2. **职责集中度是否下降**：确有多职责的大文件允许拆分，但拆分本身不计作“净减量”。
3. **增长是否被约束**：既有热点只能缩小，新增模块不得重新形成新的巨型文件。

## 当前真实状态

上一轮治理已经完成两个旧热点，本轮不重复：

- `src/app/shell/app-shell.tsx` 已由旧审计约 56.8 KiB 降到约 15.7 KiB；
- `scripts/tests/test-browser-visible.mjs` 已由约 145 KiB 单体测试降为 31 B 兼容入口，浏览器场景拆入 `scripts/tests/browser/`。

因此当前热点已经转移到 Sync、搜索/练习 UI、I/O、题库编辑/导出及部分测试。

## 当前主要生产热点

| 文件 | 当前约大小 | 判断 |
| --- | ---: | --- |
| `src/lib/sync/github-v7-remote.ts` | 32.3 KiB | transport 职责集中，且被 Asset Pack 越界复用 |
| `src/lib/sync/image-asset-pack.ts` | 32.1 KiB | pack codec/index/cache + Git transport orchestration 混合 |
| `src/app/search/search-view.tsx` | 30.6 KiB | 搜索状态、数据、编辑、practice wiring 集中 |
| `src/lib/sync/sync-v7-checkpoint-validation.ts` | 29.2 KiB | 主要是必要 schema / reference validation |
| `src/app/practice/practice-setup.tsx` | 27.9 KiB | setup 表单与策略逻辑集中 |
| `src/lib/sync/sync-v7-orchestrator.ts` | 27.8 KiB | 多阶段同步 orchestration |
| `src/app/shell/views/practice.tsx` | 27.5 KiB | presentation + interaction wiring 集中 |
| `src/lib/io/xlsx-import.ts` | 25.4 KiB | parse / validation / normalization 混合 |

## 已确认结构问题

### Asset Pack 越过 GitHub transport 边界

`image-asset-pack.ts` 自己重复实现了：

- base64 encode/decode；
- GitHub Contents/Git API path；
- response JSON 解析；
- branch/ref/tree/commit 原语。

更关键的是，它通过类型强转访问 `GitHubV7Remote` 的 private `request()`。这说明 transport abstraction 已泄漏，也是 `github-v7-remote.ts` 与 `image-asset-pack.ts` 同时膨胀的原因之一。

治理顺序：先为 GitHub transport 建立公开但受控的原子 Git 数据操作边界，再删除 Asset Pack 内的 API/path/response 重复实现。不得改变 Asset Pack pack/index/shard 物理格式和 fast-forward CAS 行为。

### Checkpoint validation 大，但不是首要净减量目标

`sync-v7-checkpoint-validation.ts` 的大部分体积来自 current schema 的 question/bank/membership/attempt/run/stats 校验及跨引用完整性验证。它适合按 entity validator 抽职责、复用 primitive validation，但不能把“拆成多个文件”虚报成代码量下降。

### 薄 facade 必须按边界价值判断

例如 `db-v7-question.ts`、`github-sync.ts` 虽然很薄，但承担稳定 domain/public facade。不能仅按字节数机械删除 barrel；必须先证明它既无 import 边界价值、又无兼容/public API 作用。

## Phase A：建立可观测基线 — 已完成

`report-project-health.mjs` 已扩展为输出：

- source / tests / tools / CSS / workflows 的文件数、bytes、lines；
- >=15 KiB / >=20 KiB 热点数量；
- 一级/二级目录体积集中度；
- 最大 source/test/CSS 文件；
- 当前 refactor focus。

这一步 report-only，不用任意全仓硬上限阻塞合理代码。

## Phase B：增量代码量 ratchet — 已完成

已新增：

- `scripts/tools/code-size-baseline.json`
- `scripts/tools/check-code-size-growth.mjs`
- Governance Audit 中的 `Code size growth ratchet`

当前规则：

- 18 个已知生产热点以当前 `main` 大小为上限，**可以缩小，不允许继续增长**；
- 新的 source/test 单文件不得超过 32 KiB；
- CSS 单文件不得新增长到 15 KiB 以上；
- baseline 本身必须 committed，CI 不允许通过运行脚本后偷偷改 baseline。

这不是“所有文件必须很短”的武断限制，而是只阻止技术债继续扩散。后续每完成一批真实减量，就把该文件更低的新值固化到 baseline。

## Phase C：优先真实净减量

顺序：

1. 收口 GitHub transport / Asset Pack 重复实现；
2. 删除可证明无边界价值的 alias / wrapper；
3. 抽取并合并重复 validation / base64 / response / path helper；
4. 合并重复测试 fixture/builder/assert helper；
5. 只在上述净减量之后再拆高职责文件。

## Phase D：UI / I/O 热点

重点审计：

- `search-view.tsx`
- `practice-setup.tsx`
- `views/practice.tsx`
- `xlsx-import.ts`
- `question-editor.tsx`
- `question-bank-export.ts`

原则：优先把纯 domain logic 移出 React component，并确认是否能与已有 lib helper 合并；不能只把 JSX 从 A 文件搬到 B 文件。

## Phase E：测试体积治理

当前最大测试约 20–31 KiB。目标：

- fixture/builder/assert helper 去重；
- browser shared helper 继续收敛；
- 不删除场景覆盖；
- strict search-pin geometry 不降低；
- Sync storage 深层回归保持原样。

## 验收

最终要求：

- Production build；
- Fast checks；
- Governance Audit；
- Sync storage；
- Chromium/WebKit smoke；
- exact-head 全绿。

同时 PR 必须能给出基线与最终的 source/test/CSS bytes、lines、热点数对比；仅拆文件但净量不降，不算完整代码量治理。
