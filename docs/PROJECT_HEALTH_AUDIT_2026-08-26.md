# 项目健康度审计与下一阶段收口计划（2026-08-26）

基线：`main@08b9d980e19c54c05c262fc0882f26182532b9b7`

本文件是下一轮实现的执行契约。当前分支创建时**只提交诊断文档，不包含功能改动**；后续实现会直接继续追加到同一分支/PR。

## 结论

当前项目的主要风险已经不是“某个功能明显坏掉”，而是以下六类工程风险：

1. `main` 缺少分支保护 / ruleset，完整 CI 可以被直接 push 绕过。
2. Web 端 GitHub PAT 长期保存于 `localStorage`，但当前 Web 入口没有 CSP，凭据防护与 iOS Keychain 路径不对称。
3. 仓库仍有 PR3 / Sync v8 阶段的一次性 acceptance workflow 与 `.preview` 状态文件残留。
4. 架构文档已经与当前入口、SideStore 发布事实分叉。
5. App 编排、Sync 核心与 Browser E2E 出现明显“大文件 + 多职责”集中，后续修改的回归半径过大。
6. 生产发布流水线已具备完整部署、验证、回退能力，但全部集中在单个 workflow，维护成本与误改风险继续上升。

这轮治理的目标不是重写项目，而是**降低高风险集中点、删掉历史残留、补齐安全/仓库边界，并把已经可靠的行为固化成更易维护的结构**。

---

## P0：仓库合并门禁必须真正不可绕过

### 现状

- `main` 当前 `protected=false`。
- 仓库 ruleset 为空。
- PR 已经有 Production build、Fast checks、Chromium/WebKit smoke、Sync storage、Governance Audit、PR Preview 等门禁，但这些门禁目前依赖开发流程自觉执行。

### 风险

任何直接 push 到 `main` 的提交都可能绕过 PR exact-head 验证，随后立即触发三端生产发布。现有 CI 越完整，这个治理缺口反而越明显。

### 实施要求

此项分两部分：

1. **代码侧**：确认所有必须门禁的 check 名称稳定，不依赖一次性 workflow；必要时统一/简化 workflow 名称。
2. **仓库设置侧**：为 `main` 启用 GitHub Ruleset 或 Branch Protection，至少要求：
   - 必须通过 PR 合并；
   - 禁止 force push；
   - 禁止删除 `main`；
   - 必须通过正式 PR CI / Sync storage / Governance Audit；
   - 是否要求 PR Preview 可根据其外部 Cloudflare 凭据稳定性决定，不要让预览服务故障永久锁死主分支。

### 验收

- 普通直接 push 无法绕过合并门禁。
- 合并仍能由当前正常 PR 流程完成。
- 不使用“降低测试要求”来换取 ruleset 可用性。

> 仓库保护属于 GitHub 设置，不应伪装成代码改动；若当前执行环境无法修改仓库规则，应在 PR 中保留明确的待办并要求合并前人工完成。

---

## P1：补齐 Web PAT 的 XSS 防护边界

### 现状

- Web/PWA GitHub Token 会持续保存在 `localStorage`，直到用户清除。
- iOS native 使用 Keychain，不把 Token 写入 `localStorage`。
- `public/_headers` 当前只声明缓存策略，没有 CSP / `X-Content-Type-Options` / `Referrer-Policy` 等安全头。
- `index.html` 目前有内联 theme bootstrap `<script>` 和一小段内联 `<style>`，这会影响严格 CSP 的落地方式。
- 项目允许用户配置自定义 GitHub Relay，因此 CSP 的 `connect-src` 不能简单锁死到单一固定域名而破坏现有功能。

### 风险

`localStorage` 不是“加密存储”。只要同源页面未来出现可执行 XSS，持久 PAT 就可能被读取并外传。当前没有证据表明项目已经存在可利用 XSS；这里要修的是**高价值凭据 + 缺少浏览器级第二道防线**这一组合风险。

### 实施要求

优先采用不破坏自定义 Relay 的最小严格策略：

1. 为 Cloudflare Pages 增加安全响应头；GitHub Pages 无法依赖 `_headers`，因此关键 CSP 需要有静态站点可生效的方案（例如 meta CSP，或等价的双目标方案）。
2. `script-src` 禁止任意内联脚本，优先把 theme bootstrap 移出 HTML 内联脚本；不要用宽泛 `unsafe-inline` 抵消 CSP 价值。
3. `object-src 'none'`、`base-uri`、`frame-ancestors`（能用响应头的目标）等基础边界补齐。
4. `connect-src` 必须保留当前 Cloudflare/GitHub Pages/native relay 与用户自定义 HTTPS relay 的能力；若必须允许广泛 `https:`，在 PR 中明确说明这是为自定义 Relay 做的权衡。
5. 增加自动测试，验证生产构建后的 CSP/安全头存在且不会阻断：
   - App 启动；
   - KaTeX；
   - Worker；
   - PWA；
   - GitHub Relay；
   - 自定义 Relay 配置。

### 不做

- 不把 Token 从 `localStorage` 挪到 IndexedDB 后宣称“更安全”；同源 XSS 仍可读取。
- 不在本轮引入自建账号/后端密钥托管系统。

---

## P1：删除历史 acceptance 残留，并让文档重新可信

### 已确认残留

- `.github/workflows/deploy-pr3-acceptance-preview.yml`
  - 只监听旧 base `sync/v7-live-gc`；
  - 又只允许旧 head `sync/v8-history-archive`；
  - preview branch 固定为 `acceptance-v8`。
- `.preview/acceptance-url.txt`
- `.preview/deploy-status.txt`
  - 两者仍指向旧 commit `4be880ff0ffbcc8a91c97a358528419639f7a810` / `acceptance-v8`。

### 实施要求

- 删除上述一次性 workflow 与 `.preview` 历史状态文件；若 `.preview` 目录没有其他正式用途，一并移除。
- 增加轻量治理检查，防止未来把 `prN`、具体历史分支名、一次性 acceptance 状态文件长期提交进正式 workflow 目录。
- 不删除当前通用 `deploy-pr-preview.yml`。

### 文档漂移

当前 `docs/ARCHITECTURE.md` 至少有两处明确失真：

1. 仍描述 `src/app/study-app.tsx`，实际入口已是 `src/app/shell/app-shell.tsx` / `AppShell`。
2. 仍写“当前没有经过验证的 unsigned IPA / SideStore 目标”，但生产 Deploy 已能构建 unsigned IPA、生成 SideStore source、发布不可变 Release assets，并在发布后校验 Cloudflare SideStore endpoints。

### 实施要求

同步校准：

- `docs/ARCHITECTURE.md`
- `docs/TESTING.md`
- `README.md`
- `docs/HANDOFF.md`（如仍承担当前交接入口）

文档只描述当前真实路径，不保留已完成迁移阶段的旧结论。

---

## P1：拆解 `AppShell`，降低 UI 编排回归半径

### 现状

`src/app/shell/app-shell.tsx` 约 56.8 KiB，当前同一组件同时承担：

- 顶层 view / sidebar / scroll 状态；
- 搜索状态与搜索跳转；
- 练习创建、恢复、进行中 session、结果页；
- 题目/题库删除后的活动练习自愈；
- quick sync / long-press restore / progress；
- sync drawer / hot window；
- import；
- 多组 Dexie `useLiveQuery`；
- notice / confirmation / transient UI；
- 顶层页面选择和大量 action wiring。

这已经超过“shell 只做跨页面编排”的合理边界。

### 实施原则

不要做大爆炸重写。按可验证边界渐进拆：

1. `useShellNavigationState`：view、scroll restore、sidebar、搜索跳转。
2. `usePracticeSessionController`：活动 run/session、题目删除/题库删除自愈、resume/finish/discard。
3. `useQuickSyncController`：普通 quick sync、长按完整恢复、progress、press lifecycle。
4. `useDashboardData`（或等价 query hook）：首页统计/live queries。
5. AppShell 最终只保留：顶层 composition、controller 组合、页面 props wiring。

### 验收

- 不改变现有路由/视觉/键盘/触控行为。
- 不改变练习事务语义。
- 不改变同步调用顺序。
- 新 controller 必须有行为测试，而不是只靠 source-shape 断言。
- `AppShell` 目标显著缩小；不以“把 56 KiB 挪到一个新的 55 KiB 文件”算完成。

---

## P1：拆分 Browser E2E 单体测试，但保持严格几何门禁

### 现状

`scripts/tests/test-browser-visible.mjs` 约 145 KiB，已经同时包含：

- fixture 构建；
- dev server 生命周期；
- Chromium/WebKit 启动；
- 通用 locator/helper；
- 导入；
- 练习；
- 搜索；
- sync；
- modal；
- layout；
- screenshot；
- strict search-pin geometry；
- PWA/浏览器差异相关场景。

### 问题

- 任一功能改动都可能修改同一个巨型文件，review ownership 很差。
- helper 与业务场景耦合，容易形成“为了某个回归再往单文件追加几百行”的趋势。
- 失败定位粒度不够清晰。

### 实施要求

推荐结构（命名可调整）：

```text
scripts/tests/browser/
  harness.mjs
  fixtures.mjs
  helpers/
  specs/
    import.mjs
    practice.mjs
    search.mjs
    sync.mjs
    layout.mjs
```

顶层保留一个兼容 runner，PR CI 的命令尽量不变。

### 硬约束

- **严格 `search-pin` geometry assertion 不得删除、放宽容差或改成纯截图测试。**
- Chromium 中 PWA preview smoke 仍必须运行。
- WebKit 中按当前 workflow 设计跳过仅 Chromium 支持/要求的 Search pin / PWA 步骤，不把“skip”伪装成覆盖。
- 拆分后每个 spec 失败应能明确显示 feature 名称。

---

## P2：逐步拆分 Sync 高复杂度模块，不改协议

### 现状

当前同步测试覆盖已经很强，但核心实现仍有多个约 30–38 KiB 的集中模块，例如：

- `change-set-v7.ts`
- `sync-v7-checkpoint.ts`
- `sync-v7-head.ts`
- `sync-v7-orchestrator.ts`
- `github-v7-remote.ts`
- `image-asset-pack.ts`

### 原则

这一项属于**结构治理，不是 Sync v10**。

严禁借拆文件之名改变：

- `sync/v9/*` wire format；
- head CAS；
- content addressing；
- checkpoint / segment / object / history 语义；
- Asset Pack shard/index/pack 物理布局；
- tombstone / GC / replay 规则；
- 本地 IndexedDB v7 schema；
- full restore / history range 语义。

### 推荐顺序

1. 先按纯函数/codec/validation/remote IO/plan/apply 边界抽出低风险模块。
2. 再把 orchestrator 的 phase 拆成具名步骤，但保持原调用顺序。
3. 最后才考虑 `head` / checkpoint 内部大模块切分。

### 验收

- 所有现有 Sync storage + Fast + PR29 新增深层回归必须原样通过。
- 不通过改测试期望来掩盖协议行为变化。
- 不新增旧协议兼容层。

---

## P2：模块化生产发布 workflow，保留现有回退语义

### 现状

`.github/workflows/deploy-pages.yml` 约 18 KiB，单文件同时包含：

- production build；
- GitHub Pages deploy；
- Cloudflare Pages build/deploy/cache purge；
- SideStore IPA build/source/release；
- post-deploy Fast checks；
- PWA smoke；
- SideStore endpoint smoke；
- GitHub Pages rollback；
- Cloudflare rollback；
- SideStore latest rollback。

当前行为是可靠的，不能为了“文件短”破坏它。

### 实施要求

优先用 reusable workflow 或 composite action 提取稳定重复单元：

- Node setup + npm ci；
- Web build；
- Cloudflare cache purge；
- SideStore release helpers；
- rollback helpers。

主 workflow 保留完整 dependency graph，让一眼仍能看出：

`build -> 三端并行发布 -> 三类 post-deploy gate -> 条件 rollback`

### 硬约束

- 三端发布仍并行，不退化成无必要串行。
- post-deploy gate 仍针对刚发布的 exact commit。
- 验证失败后原三类 rollback 行为保持。
- Release asset 不可变语义保持。

---

## P2：建立“大文件增长”观察线，不用武断阈值阻塞功能

当前已经有 CSS size ratchet，但 TS/TSX/测试/Workflow 没有类似可见性。建议增加**报告型** project-health 输出：

- top 20 largest source files；
- top 20 largest test files；
- workflow 行数/大小；
- `AppShell`、Browser E2E、Sync 核心几个重点文件的趋势。

第一阶段只报告，不直接设一个拍脑袋的 16 KiB 硬阈值。待拆分完成后，再为重点入口设置“不得重新长回去”的 ratchet。

---

## 实施顺序

建议另一个会话严格按以下顺序推进，每阶段独立提交并实时更新 PR 描述：

### Phase A — 风险低、收益高

1. 删除 PR3 / acceptance-v8 残留。
2. 修正文档与 SideStore 当前事实。
3. 补 project-health 报告。
4. 补 Web CSP / security headers 与自动回归。
5. 明确并配置 `main` ruleset / protection。

### Phase B — 测试基础设施

6. 拆 `test-browser-visible.mjs`，保持 exact browser coverage 与 search-pin strict assertion。

### Phase C — UI 编排

7. 渐进拆 `AppShell` controller/hooks，每个抽取都要求行为不变并有测试。

### Phase D — Sync 结构

8. 仅做无协议变化的模块边界拆分，逐步运行 Sync storage 深测。

### Phase E — 发布流水线

9. 模块化 deploy workflow，最终必须做一次完整发布验证，确认 GitHub Pages / Cloudflare / SideStore / post-deploy / rollback condition graph 未退化。

---

## 全局不可破坏约束

后续实现期间以下内容视为“红线”：

- 不放宽 CSS governance / export surface / dependency audit ratchet。
- 不弱化 strict search-pin geometry assertion。
- 不把 source-shape 测试当成行为测试的替代品。
- 不改变 Sync v9 wire format、head CAS 或 Asset Pack 布局。
- 不把增量 reconcile 退回 destructive projection clear。
- 不改变完整恢复“恢复全部历史”的现有语义。
- 不改变六种正式题型：`判断 / 单选 / 多选 / 计算 / 填空 / 简答`。
- 不牺牲 GitHub Pages、Cloudflare Pages、SideStore 任一生产目标。
- 不删除 rollback，只允许等价模块化。
- 不以“测试通过”为理由降低现有覆盖范围。

## 完成定义

本 PR 最终从 Draft 转 Ready 前必须满足：

1. PR 描述中的实际完成项与代码一致，不保留虚假勾选。
2. 所有临时诊断 workflow 在最终 head 删除。
3. Production build / Fast checks / Governance / Sync storage 全部成功。
4. Chromium browser smoke + strict search-pin geometry + PWA preview smoke 成功。
5. WebKit browser smoke 成功；设计性 skip 保持显式。
6. PR Preview 成功。
7. exact-head 全绿后再合并。
8. 合并后完整 Deploy 成功：GitHub Pages、Cloudflare Pages、SideStore IPA/source/release、PWA post-deploy smoke、SideStore endpoint smoke、Fast checks post-deploy 全部成功。
9. 若修改了 rollback 实现，应补一个不会污染 production 的结构/模拟验证，证明触发条件和回退目标仍正确。

本文件在实施过程中可以更新，但不得为了让实现“看起来完成”而删除尚未解决的诊断项。