# 下一阶段项目健康治理计划（2026-08-27）

基线：`main@4842f68d8a4f7c5bc2030c72d385f258eea2a58d`

## 背景

最近 #27～#36 已连续完成 UI 修复、题型顺序统一、iOS 增量同步、Browser/AppShell/Sync 结构治理、current-only 数据契约、optionId 冲突修复、代码量治理以及搜索 read-model / IndexedDB 定向读取。

当前项目已经不适合继续做大范围“拆文件式治理”。下一阶段只处理有可验证收益的剩余问题：

1. 删除仍然存在的跨层重复实现；
2. 消除仍在 UI 数据路径中的无条件 IndexedDB 全表读取；
3. 把纯领域派生从 React owner 中移出，但不机械拆 JSX；
4. 对确实缩小的热点继续下调 code-size ratchet；
5. 保持 Sync v9、Asset Pack、IndexedDB v7、restore/replay/GC 与发布链语义稳定。

## 当前基线

PR #36 exact-head Governance report：

- `src code`: 178 files / 1,319,787 B / 24,517 lines；
- `tests`: 109 files / 848,348 B / 14,065 lines；
- `tools`: 23 files / 109,849 B / 2,485 lines；
- `src CSS`: 44 files / 297,025 B / 5,458 lines；
- `workflows`: 5 files / 21,664 B / 595 lines。

当前主要生产热点：

- `src/lib/sync/github-v7-remote.ts` — 32,270 B；
- `src/lib/sync/image-asset-pack.ts` — 31,798 B；
- `src/lib/sync/sync-v7-checkpoint-validation.ts` — 29,185 B；
- `src/app/search/search-view.tsx` — 29,033 B；
- `src/app/practice/practice-setup.tsx` — 27,850 B；
- `src/lib/sync/sync-v7-orchestrator.ts` — 27,806 B；
- `src/app/shell/views/practice.tsx` — 27,479 B；
- `src/lib/io/xlsx-import.ts` — 25,358 B。

已有 code-size gate：18 个热点只能缩不能涨；新 source/test 文件不得直接超过 32 KiB；新 CSS 文件不得超过 15 KiB。

## 已确认的剩余问题

### 1. Asset Pack 仍越过 GitHub transport ownership

`image-asset-pack.ts` 目前仍自行实现或拥有：

- `encodeBase64()` / `decodeBase64()`；
- GitHub Contents path；
- Git Data API path；
- branch path encoding；
- `client.request.bind(client)`；
- response JSON / HTTP status 解析。

而 `github-v7-remote.ts` 已有同类 base64、Contents path、GitHub error/response 处理，并且本来就是 GitHub transport owner。

这属于真实重复与 ownership 泄漏，不是“文件太大”本身的问题。

### 2. Practice Setup 仍有历史表全表扫描

`practice-setup.tsx` 当前先并行读取：

- 当前题库 questions；
- `dbV7.attemptStats.toArray()`；
- `dbV7.reviewRoundProgress.toArray()`；

随后只有 attempts 已经按当前 questionIds 使用 `where("questionId").anyOf(...)` 定向读取。

因此当本地累积大量无关题目的统计/轮次进度后，打开练习设置仍会 materialize 整张历史表。搜索路径已在 PR #36 解决同类问题，Practice Setup 应按相同原则收口，但不要复用 Search 专属 read helper 造成错误 domain coupling。

### 3. Practice Setup 仍混合纯 filter/model 派生与 React 状态

当前组件内部同时维护：

- preset → filter 组装；
- mode 推导；
- modeLabel 组合；
- advanced field active 判定；
- metric/date/regex 输入校验；
- scoped done / wrong card count 派生；
- React state 与 JSX。

其中前几类属于可纯测的领域/表单模型，不需要 React/Dexie。应只迁出明确的 pure model，不以拆 UI 组件数量作为成果。

### 4. Practice 主答题 owner 仍较集中，但不预设必须拆

`views/practice.tsx` 仍同时包含答案派生、计时暂停、笔记 autosave、键盘、swipe、编辑/overview 状态等交互；但 PR #31 已经把 presentation 拆出。

下一阶段只允许在发现明确的 pure model 或重复逻辑时继续收口，例如答案状态派生；如果只能把 event handler 从 A 文件搬到 B 文件而没有边界/测试收益，则保持现状。

### 5. Checkpoint validation / XLSX import 暂不按体积强拆

`sync-v7-checkpoint-validation.ts` 的主要体积来自 current schema / reference 完整性校验；`xlsx-import.ts` 的 ZIP/XML/parser 属于独立安全边界。除非 Phase A 能证明存在完全等价、且不会改变错误契约的重复 primitive，否则不以“单文件大”为理由拆分。

## Phase A — 重新建立治理证据基线

- 在最新 `main` 上记录 source/test/tools/CSS/workflow bytes/lines 与热点；
- 扫描 React/UI 数据路径中的 `toArray()`、全表 materialization 与随后按 questionId/filter 的内存过滤；
- 扫描 Sync / Asset Pack 中重复的 GitHub API path、base64、response parsing 与 Git primitive；
- 对 Practice / I/O 热点区分：真实多职责、必要 schema/parser、纯 presentation；
- PR 描述实时记录“确认治理 / 保留不动 / 原因”。

验收：后续每个 Phase 都必须对应一个已确认问题，不做猜测式重构。

### Phase A 执行记录

- exact branch baseline：`8a8e22e32977c52d99fa6a5a1c17281e56825b7e`，`origin/main@4842f68d8a4f7c5bc2030c72d385f258eea2a58d`；工作区起始无未提交改动，`npm run typecheck` 通过。
- size baseline 已复现：`src code` 178 files / 1,319,787 B / 24,517 lines；tests 109 / 848,348 B / 14,065 lines；tools 23 / 109,849 B / 2,485 lines；src CSS 45 / 297,199 B / 5,466 lines；workflows 5 / 21,664 B / 595 lines。当前 source hotspot 为 17 个 `>=20 KiB`、24 个 `>=15 KiB`。
- 确认治理：`image-asset-pack.ts` 重复拥有 base64、Contents/Git Data path、branch encoding、request binding、HTTP status/JSON parsing；这些应收口到 `GitHubV7Remote` transport owner。
- 确认治理：`practice-setup.tsx` 对 `attemptStats`、`reviewRoundProgress` 做全表 `toArray()`；当前 schema 已有 `attemptStats.questionId` 主键与 `reviewRoundProgress.questionId` 索引，Phase C 不需要升级 IndexedDB schema。
- 保留不动：Sync checkpoint/projection 构建路径上的全表读取是完整投影语义，不属于 UI read-cardinality 问题；`sync-v7-checkpoint-validation.ts` 暂未发现可在不改变 current-only schema/error contract 下安全合并的重复 primitive。
- 保留待 Phase D 复核：`views/practice.tsx` 的 choice correctness 在渲染派生与 submit 路径重复，但只在能形成单一 pure answer-state owner、复用既有 question-utils/answer-submission 且测试收益明确时才抽取。
- 保留不动（Phase E 初审）：`xlsx-import.ts` 的 ZIP/XML 解析与安全边界目前未发现与 `image-assets.ts` / `question-bank-export.ts` 完全等价且可净删除的 helper；不因文件体积强拆。

## Phase B — 收口 GitHub transport / Asset Pack 边界

目标：`image-asset-pack.ts` 只理解 Asset Pack domain，不再理解 GitHub HTTP 细节。

实施原则：

- GitHub Contents/Git Data URL/path 构造归 `GitHubV7Remote` 或其明确 transport primitive owner；
- Git blob/tree/commit/ref read/create/fast-forward 形成 typed primitive；
- base64 encode/decode、response status/JSON parsing 不在 Asset Pack 重复维护；
- Asset Pack 保留 pack codec、root/shard/index、cache、publish planning 与 descriptor 语义；
- 删除 Asset Pack 内可证明重复的 helper，而不是把同一代码复制到新文件。

必须保持：

- Asset Pack format version / pack bytes / index/shard 物理布局不变；
- pack 约 8 MiB、最多 64 图语义不变；
- branch ref fast-forward CAS 与并发重试语义不变；
- GitHub Relay Git API 白名单不扩大；
- 请求数不得退化成按图片数量增长；
- Sync v9 head/checkpoint/history 不受影响。

回归：Asset Pack、mock GitHub backend、relay consistency、Sync protocol/GC/history 全部保持。

验收：`image-asset-pack.ts` 中不再出现自有 GitHub REST path 构造和重复 base64/response parsing；如两个热点实际缩小，立即下调 ratchet，不允许提高 baseline。

### Phase B 执行记录

- 新增 `github-v7-transport.ts` 作为明确的低层 GitHub transport primitive owner，统一 base64、Contents/Git Data path、branch/ref encoding、HTTP status/JSON parsing，以及 blob/tree/commit/ref fast-forward primitives。
- `GitHubV7Remote` 继续作为同步 transport façade，并向 Asset Pack 提供 typed delegation；`image-asset-pack.ts` 只保留 pack codec、index/shard validation、cache、publish planning 与 descriptor 领域语义。
- `image-asset-pack.ts` 已无 `encodeBase64` / `decodeBase64`、`/repos/` path、`client.request`、`responseJson` 等 GitHub HTTP 细节；新增结构性测试防止 ownership 回退。
- Asset Pack fast-forward 仍为 `force: false`，409/422 仍触发上层重读重试；pack/index/shard bytes/layout 与请求聚合策略未改变。
- hotspot bytes：`github-v7-remote.ts` 32,270 → 32,095；`image-asset-pack.ts` 31,798 → 27,238；对应 code-size ratchet 同步收紧，不新增 >32 KiB helper。
- 专项验证：typecheck、code-size ratchet、GitHub remote、Asset Pack、mock GitHub backend、relay consistency 均通过。

## Phase C — Practice Setup 定向读取 + canonical setup read-model

### 定向 IndexedDB 读取

先取得当前 questions，再派生去重 `questionIds`，随后：

- `attemptStats` → `bulkGet(questionIds)`；
- `reviewRoundProgress` → `where("questionId").anyOf(questionIds)`；
- `attempts` → 继续 `where("questionId").anyOf(questionIds)`；
- 空题集不触发无意义查询。

不升级 IndexedDB schema；现有 PK/index 足够时不得新增 migration。

### pure setup model

把以下纯逻辑移到 `src/lib/practice/` 或等价 domain owner：

- preset/custom filter 组装；
- mode 推导；
- modeLabel 组合；
- advanced field active 判定；
- 输入范围/日期/regex 校验；
- 如能形成稳定接口，再收口 scoped done/wrong/favorite summary 派生。

React component 只负责 state、interaction 和 rendering。

### 大数据回归

新增结构性 read-cardinality 测试，优先断言读取规模而非 wall-clock：

- 大量无关 `attemptStats` 不应被 Practice Setup materialize；
- 大量无关 `reviewRoundProgress` 不应被读取；
- 100,000 unrelated attempts + 当前小题集时只 materialize 当前 questionIds 对应行；
- rolling/lifetime/review-round 的 done/wrong 语义保持；
- wrong-removal streak 与快捷卡计数保持。

验收：Practice Setup 不再对上述历史表做无条件 `toArray()`；无关历史数据增长不再线性放大本次 setup read cardinality。

### Phase C 执行记录

- 新增 `practice-setup-read-v7.ts`：先解析当前题集，再按去重 `questionIds` 定向读取 `attemptStats`、`reviewRoundProgress` 与 `attempts`；空题集直接返回。
- `practice-setup.tsx` 已移除历史表全表读取；现有主键与 `questionId` 索引足够，本阶段没有 IndexedDB schema migration。
- 新增 `practice-setup-model.ts`，只迁出 filter 组装、mode/modeLabel、advanced filter count、validation 等 pure model；React state、handlers、JSX 保持原 owner。
- read-cardinality 回归覆盖 100,000 条无关 attempts、20,000 条无关 stats、20,000 条无关 round progress；目标小题集仅 materialize 7 / 2 / 3 条对应记录。
- `practice-setup.tsx` 27,850 B → 21,838 B；code-size ratchet 已同步收紧。

## Phase D — Practice 主答题 owner 的证据式收口

仅在 Phase C 后重新审计 `views/practice.tsx`。

优先候选：

- 将 choice/calculation/fill/short 的 selected-answer / correctness / input-valid / reveal-answer 等纯派生形成单一 answer-state model；
- 复用已有 `answer-submission.ts` / question-utils，而不是创建第二套判题规则；
- 如果抽取后不能减少重复或不能增强行为测试，则撤回，不为了字节数保留。

明确不做：

- 不把 keyboard/swipe handler 机械搬到新文件；
- 不改提交/判题时机；
- 不改 ActiveElapsedTimer 计时语义；
- 不改简答自评、自动下一题、note autosave 行为。

验收：只有真实 owner 更清晰且 source ratchet 可下调时才保留该 Phase 的结构修改。

## Phase E — I/O 与测试体积的保守治理

### I/O

审计 `xlsx-import.ts`、`image-assets.ts`、`question-bank-export.ts`：

- 只合并完全等价的 validation / byte / archive helper；
- parser/security boundary 保持独立；
- 不通过弱化 ZIP/XML/图片真实 fixture 测试换行数。

如果没有明确净减量证据，本 Phase 的 I/O 产品代码允许 0 修改。

### tests

- 审计大型测试中的 fixture/builder/assert helper 重复；
- 允许抽公共 helper，但场景数量和行为断言不得减少；
- strict search-pin geometry、Sync storage 深层回归、Browser Chromium/WebKit coverage 不降；
- 新增大数据测试应进入合适的 integration/fast 分组，不重复启动昂贵 runner。

## Phase F — 代码量与 exact-head 收口

最终必须报告：

- `src` / tests / tools / CSS / workflows 的 files / bytes / lines；
- 本 PR additions/deletions 与 production-source 单独净变化；
- >=15 KiB / >=20 KiB hotspot 数变化；
- 每个被修改热点的 before/after bytes；
- 哪些大文件有意保持不动及原因。

规则：

- 已有 code-size baseline 不得放宽；
- 确认缩小的热点必须同步下调；
- 新 helper 不得把技术债从旧大文件转移到新的 >32 KiB 文件；
- 不把测试/文档新增伪装成 production-source 瘦身。

exact-head 必须通过：

- Production build；
- Fast checks；
- Governance Audit；
- Sync storage CI；
- Chromium browser smoke；
- strict search-pin geometry；
- PWA preview smoke；
- WebKit browser smoke；
- PR Preview。

全部成功后再转 Ready。

## 全局红线 / 明确不做

- 不升级 IndexedDB schema，除非现有索引被实证证明无法满足目标；
- 不改变 Sync v9 wire / fixed head / head CAS / content addressing；
- 不改变 checkpoint/history/tombstone/GC/replay；
- 不改变 Asset Pack pack/index/shard 物理格式；
- 不改变 full-history restore 语义；
- 不恢复任何 PR #32 已删除的历史数据兼容；
- 不重复治理 PR #36 已完成的 Search read-model；
- 不重新启动大规模 CSS ownership 迁移；
- 不削弱 browser/search-pin/PWA/Sync 测试；
- 不在本 PR 顺手处理 PAT/CSP/branch protection 等独立安全/仓库配置议题；
- 不通过机械拆 JSX、validator 或 parser 来制造“文件变小”的假优化。

## Ready 标准

本 PR 只有同时满足以下条件才可 Ready：

1. 至少完成一个真实重复删除（优先 GitHub transport / Asset Pack）；
2. Practice Setup 的历史表全表扫描被消除并有大数据 read-cardinality 回归；
3. production-source 复杂度/热点有可量化改善，或对保持不动项给出证据说明；
4. code-size ratchet 只收紧、不放宽；
5. Sync v9 / Asset Pack / restore 与 Browser 行为语义保持；
6. exact-head 全绿。

本 PR 不自动合并。