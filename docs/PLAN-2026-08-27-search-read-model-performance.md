# 搜索 Read-model 与 IndexedDB 性能优化计划（2026-08-27）

基线：`main@dc621f57419d07bebd697c36a84c43cb43454038`

## 目标

继续优化搜索架构与本地数据读取性能。本计划不以拆文件或减少单文件字节数为主要目标，而是解决三个已经确认的结构问题：

1. Quick Search 与完整 Search 重复构造 `SearchIndexQuestion`，同一 searchable field 规则存在双入口；
2. 搜索读取路径对 notes / attempts / attemptStats / reviewRoundProgress 存在全表 `toArray()` 后再内存过滤；
3. 当前 answer 搜索投影仅显式覆盖简答 `referenceText`，没有统一复用 current-schema canonical answer formatter。

保持 current-only 数据模型；不新增旧格式兼容；不改变 Sync v9 wire format、IndexedDB schema、Asset Pack、restore/replay/GC 语义；不削弱 strict search-pin geometry 或浏览器覆盖。

## 已确认现状

### 搜索索引投影重复

`src/app/search/quick-search.tsx` 与 `src/app/search/search-view.tsx` 分别手写 `Question -> SearchIndexQuestion` 映射。PR #35 修复简答答案搜索时必须同时改两处，说明 searchable field ownership 尚未单一化。

目标：建立 canonical search document/index builder，Quick Search 与完整 Search 只提供各自上下文（note / stats / progress），不再各自决定 stem/options/answer/tags 等 canonical 内容字段。

### canonical answer 已存在但搜索未统一使用

`src/lib/db/app-data-v7.ts` 已有 `questionAnswerTextV7()`，能够按 current solution schema 生成 choice / calculation / fill / short 的 canonical answer text。

目标：搜索索引的 answer 字段统一通过 current-schema canonical formatter 生成，并补测试证明：

- 简答 reference text 可搜索；
- 填空 accepted answers 可在 all scope 搜索；
- 计算 expected answers 可在 all scope 搜索；
- choice answer 的行为必须先确认产品语义，避免把不应暴露的答案文本错误加入聚焦 scope；
- stem/options/explanation focused scope 仍严格只搜索各自字段。

### 搜索路径存在全表扫描

当前已确认：

- Quick Search 使用 `dbV7.notes.toArray()`；
- Search View 使用 `attemptStats.toArray()`、`attempts.toArray()`、`notes.toArray()`、`reviewRoundProgress.toArray()`，之后再按当前 questionIds 过滤。

现有 Dexie schema 已有可用索引/主键：

- `notes.questionId` 主键；
- `attemptStats.questionId` 主键；
- `attempts.questionId` 索引；
- `reviewRoundProgress.questionId` 索引。

因此本计划不升级 IndexedDB schema，优先通过 `bulkGet` / `where(...).anyOf(...)` 做定向读取。

## Phase A — 建立搜索 read-model 单一入口

- 新增纯函数/纯数据层的 canonical search document builder；
- 把 stem / options / answer / tags / favorite 等 current question 字段的投影统一到一处；
- Quick Search 与 Search View 删除重复的 canonical content mapping；
- stats / progress / note 等运行时字段通过明确 context 参数注入；
- 保持 `SearchIndexQuestion` worker payload 可序列化且最小化；
- 不把 Dexie / React / Worker transport 依赖塞进纯 builder。

验收：新增 searchable canonical field 时只需修改一个生产入口。

## Phase B — 收口 canonical answer 搜索语义

- 复用或抽象 `questionAnswerTextV7()`，避免 Search 自己理解 solution union；
- current schema 下各题型答案搜索行为必须有显式测试；
- `contentScope=all` 才允许 canonical answer 参与匹配；
- `stem` / `options` / `explanation` focused scope 不得泄漏 answer/tags；
- 更新 fingerprint 覆盖，保证答案变化会使 worker index key 失效。

## Phase C — 消除 Quick Search 全表 note 扫描

- 根据当前 questionIds 使用 `notes.bulkGet(questionIds)` 或等价 indexed read；
- 不加载无关题目的 note；
- 保持 Quick Search 无 stats/progress transfer 的轻量语义；
- 加测试/可观测断言证明读取只针对当前题目集合。

## Phase D — 消除 Search View 历史数据全表扫描

按风险从低到高逐项替换：

1. `attemptStats` -> `bulkGet(questionIds)`；
2. `notes` -> `bulkGet(questionIds)`；
3. `attempts` -> `where("questionId").anyOf(questionIds)`；
4. `reviewRoundProgress` -> `where("questionId").anyOf(questionIds)`。

要求：

- 不改变 rolling / lifetime / current review round 的 progress 语义；
- 不改变 wrong review 判定；
- 不改变 latest / difficulty / total / wrong 指标；
- Safari IndexedDB 路径必须继续通过现有浏览器 smoke。

## Phase E — 大数据性能回归

新增确定性性能/规模回归，重点验证算法和读取规模，而不是依赖不稳定 wall-clock 微基准：

- 10,000 questions 的 search index build/query；
- 大量无关 notes 不应被 Quick Search 读取/投影；
- 100,000 attempts 场景下，搜索当前小题集时不应扫描全部历史；
- worker fingerprint 在 canonical answer 变化时必须失效；
- 保留 regex complexity guard 和 `MAX_SEARCH_FIELD_LENGTH` 边界。

如增加 wall-clock benchmark，只作为 report，不先设脆弱硬阈值；优先对 query/read cardinality 建结构性断言。

## Phase F — UI 复杂度收口

在前述 domain/read-model 落地后再处理 `search-view.tsx`：

- 只把已经有明确 domain ownership 的数据准备逻辑移出 React；
- 不通过把 JSX 机械拆到新文件来虚报优化；
- 如果 `search-view.tsx` 实际缩小，则同步收紧 `code-size-baseline.json`，不得放宽既有 ratchet。

## Phase G — exact-head 验收

完成后必须在最新 base/main 上重新验证：

- Production build；
- Fast checks；
- Governance Audit；
- Sync storage CI；
- Chromium browser smoke；
- strict search-pin geometry；
- WebKit browser smoke；
- PR Preview。

全部 exact-head success 后再转 Ready；本 PR 不自动合并。

## 明确不做

- 不升级 IndexedDB schema，除非后续实证证明现有 `questionId` 索引无法满足定向读取；
- 不引入搜索服务端或远程索引，仍保持 local-first；
- 不修改 Sync v9 / checkpoint / Asset Pack；
- 不删除真实浏览器场景或降低 search-pin geometry；
- 不以拆文件、改测试预期、静态 mock 替代真实数据路径来换取“优化”。

## 完成标准

- Quick Search / Search View 不再各自维护 canonical searchable content mapping；
- canonical answer 搜索由单一 current-schema 入口负责；
- 搜索页面不再对 notes / attemptStats / attempts / reviewRoundProgress 做无条件全表扫描；
- 大量无关历史数据不会线性扩大当前小题集搜索的读取规模；
- 所有现有搜索语义与可访问性行为保持；
- 如热点文件缩小，代码量 ratchet 同步下调；
- exact-head 全绿后转 Ready。
