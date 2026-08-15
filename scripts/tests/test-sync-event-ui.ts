import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manager = await readFile(new URL("../../app/sync/sync-event-manager.tsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("../../app/sync/sync-event-drawer.tsx", import.meta.url), "utf8");
const syncView = await readFile(new URL("../../app/sync/sync-view.tsx", import.meta.url), "utf8");
const studyApp = await readFile(new URL("../../app/study-app.tsx", import.meta.url), "utf8");
const hotWindowPanel = await readFile(new URL("../../app/sync/sync-hot-window.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../../app/styles/sync-events.css", import.meta.url), "utf8");
const siteReset = await readFile(new URL("../../lib/site-data-reset.ts", import.meta.url), "utf8");
const hintSource = await readFile(new URL("../../app/ui/hint.tsx", import.meta.url), "utf8");
const globalsCss = await readFile(new URL("../../app/globals.css", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

assert.match(manager, /import type \{ ChangeSetMutationV7, ChangeSetV7 \} from "@\/lib\/change-set-v7"/, "UI consumes the immutable v7 type contract without owning persistence");
for (const state of ["pending", "claimed", "blocked", "committed"]) {
  assert.match(manager, new RegExp(`${state}:`), `manager presents ${state} state`);
}
assert.match(manager, /搜索类型、对象或编号/, "manager exposes search");
assert.match(manager, /按状态筛选/, "manager exposes an accessible status filter");
assert.match(manager, /<AppSelect className="sync-event-filter"/, "status filter reuses the shared AppSelect component");
assert.doesNotMatch(manager, /<select[^>]*sync-event-filter|sync-event-filter[\s\S]*<select/, "status filter does not introduce another native select skin");
assert.match(manager, /sync-event-detail-/, "change-set details are expandable and linked with aria-controls");

for (const editableKind of ["note.upserted", "bank.update", "question.upsert"]) {
  assert.match(manager, new RegExp(`mutation\\.kind === \\"${editableKind.replace(".", "\\.")}\\"`), `typed form exists for ${editableKind}`);
}
assert.doesNotMatch(manager, /JSON\.stringify|contentEditable|原始 JSON|raw JSON/i, "manager never exposes a raw event editor");
assert.match(manager, /删除整个 change-set/, "deletion is whole-change-set only");
assert.match(manager, /cascadeDependents/, "dependency cascade decision is returned to the controller");
assert.match(manager, /dependentChangeSetIds/, "dependent operations are shown before cascade deletion");
assert.match(manager, /deleteError/, "delete dialog surfaces rejected deletions inline instead of silently failing");
assert.match(manager, /error=\{deleteError\}/, "manager passes the inline delete error to the confirm dialog");
assert.match(styles, /\.sync-event-toolbar\s*\{[\s\S]*display:\s*flex;[\s\S]*gap:\s*10px;/, "desktop toolbar lays out search, filter and sync actions as one row");
assert.match(styles, /\.sync-event-toolbar \.sync-event-filter\s*\{[\s\S]*width:\s*168px;/, "status filter keeps a compact fixed width");
assert.match(styles, /\.sync-event-search,[\s\S]*\.sync-event-filter\s*\{[\s\S]*height:\s*44px;/, "search and status controls share the standard control height");
assert.match(styles, /\.settings-card \.sync-event-search input\s*\{[\s\S]*border:\s*0;[\s\S]*padding:\s*0;/, "sync search resists generic settings-card input styles");

assert.doesNotMatch(manager, /onCreateAction|新建业务操作/, "misleading '新建业务操作' button was removed; creation lives in the normal business UI");
assert.doesNotMatch(manager, /onRefresh|刷新/, "no-op refresh button was removed; only the sync action remains");
assert.match(manager, /onSyncNow/, "sync is callback-controlled");
assert.match(manager, /role="progressbar"/, "sync progress is accessible");
assert.match(manager, /正在同步/, "syncing (claimed) batch has a named section");
assert.match(manager, /等待同步/, "pending batch has a named section");
assert.match(manager, /已同步/, "committed history has a named section");
assert.doesNotMatch(manager, /batchFor/, "sections derive from record state, not a stale batch snapshot");
assert.match(manager, /is-history|historyExpanded/, "committed history collapses into a summary by default");
assert.doesNotMatch(studyApp, /syncBatchIds/, "study-app no longer keeps a stale sync-batch snapshot");

assert.match(drawer, /role="dialog" aria-modal="true"/, "drawer exposes modal dialog semantics");
assert.match(drawer, /aria-labelledby="sync-event-drawer-title"/, "drawer has an accessible title");
assert.match(drawer, /event\.key === "Escape"/, "drawer closes with Escape");
assert.match(drawer, /previouslyFocused\?\.focus\(\)/, "drawer restores focus when closed");
assert.match(drawer, /showBatchSections/, "top drawer enables current/next batch grouping");
assert.match(syncView, /showBatchSections/, "sync page groups events into sections like the top drawer (已同步 collapsed by default)");
assert.doesNotMatch(syncView, /onCreateAction/, "sync page no longer hosts the misleading '新建业务操作' button (it only jumped to banks)");
assert.match(hotWindowPanel, /<dt>检查点<\/dt>[\s\S]*<dt>当前头<\/dt>[\s\S]*<dt>分段<\/dt>[\s\S]*<dt>检查点体积<\/dt>[\s\S]*<dt>热窗口事件<\/dt>[\s\S]*<dt>上次同步<\/dt>[\s\S]*<dt>热窗口<\/dt>/, "hot window exposes checkpoint, head, segments, checkpoint size, hot-window events, last sync and hot bytes in order");
assert.match(hotWindowPanel, /segmentEvents/, "hot window exposes the pending event count (sum of segment counts)");
assert.match(hotWindowPanel, /<dt>热窗口事件<\/dt><dd>\{hotWindow\.segmentEvents\}<\/dd>/, "hot window events cell renders the segment-event sum");
// 上次同步只显示本地上次成功同步时间（语义明确，不再显示设备/水位信息）。
assert.match(hotWindowPanel, /<dt>上次同步<\/dt><dd>\{syncedAt \? formatSyncedAt\(syncedAt\) : "—"\}<\/dd>/, "last sync shows only the local sync time");
assert.ok(!/latestSync|本设备|shortDeviceId|deviceCount/.test(hotWindowPanel), "panel carries no device-watermark display");
// 检查点体积格内简洁（无「解压」文字），完整信息放统一悬浮提示（Hint，跟随鼠标）。
assert.match(hotWindowPanel, /checkpointStoredSize \?\? hotWindow\.checkpointSize/, "checkpoint volume cell shows a single value (stored size preferred)");
assert.doesNotMatch(hotWindowPanel, /<dd[^>]*title=/, "checkpoint volume cell no longer uses a native title attribute");
assert.match(hotWindowPanel, /<Hint label=\{checkpointTitle\(hotWindow\)\}><dd>/, "checkpoint volume full detail moves to the unified Hint tooltip");
assert.match(hotWindowPanel, /实际 \$\{formatBytes\(state\.checkpointStoredSize\)\} · 解压/, "hint label explains actual vs decompressed bytes");
assert.match(hotWindowPanel, /检查点体积 \$\{formatBytes\(state\.checkpointSize\)\}/, "checkpoint hint also shows a value when stored equals logical size (hover always pops)");
assert.match(hotWindowPanel, /尚未建立检查点，首次同步后自动生成/, "checkpoint hint explains when no checkpoint exists yet (hover always pops)");
// 全项目统一提示机制：Radix Tooltip + Hint 封装、跟随指针、全局样式挂载。
assert.ok(packageJson.dependencies["@radix-ui/react-tooltip"], "unified hint depends on @radix-ui/react-tooltip");
assert.match(hintSource, /Tooltip\.Trigger\s+asChild/, "hint keeps the trigger element in place (Slot, no wrapper node)");
assert.match(hintSource, /createPortal\(/, "hint renders the popover via createPortal (synchronous mount, no Presence delay)");
assert.match(hintSource, /useLayoutEffect/, "hint measures the popover and clamps it inside the viewport after mount");
assert.match(hintSource, /spaceAbove/, "hint flips to the opposite side when the preferred side has no room (no trigger-covering flicker)");
assert.match(globalsCss, /@import "\.\/styles\/hint\.css"/, "hint styles are wired into the global stylesheet");
// 进度条单行：dt | 弹性 bar | 数值，不再独占两行。
assert.match(hotWindowPanel, /<dt>热窗口<\/dt><dd><span>[\s\S]*?<\/span><i aria-hidden="true">/, "hot window fill row keeps label, value and bar on one line (text before the bar)");
// 抽屉与同步页共用同一面板：管理器提供 statusPanel 槽，抽屉传入热窗口数据。
assert.match(manager, /statusPanel\?: ReactNode;/, "manager offers a status panel slot below the toolbar");
assert.match(drawer, /statusPanel=\{<SyncHotWindowPanel hotWindow=\{hotWindow\} syncedAt=\{syncedAt\} \/>/, "drawer feeds the shared panel through the status slot");
assert.match(studyApp, /hotWindow=\{drawerHotWindow\} syncedAt=\{drawerSyncedAt\}/, "study-app passes hot window state to the drawer");
assert.match(studyApp, /getSyncHotWindowState\(settings\)/, "drawer hot window state is loaded from the cached head");
// 热窗口 3+1 布局在手机端同样成立：检查点/当前头/分段 一行三项 + 热窗口进度独占一行，
// 任何地方都不得再出现单列覆盖（曾因 760px 媒体查询漏改回退过一次）。
const componentsCss = await readFile(new URL("../../app/styles/components.css", import.meta.url), "utf8");
assert.match(componentsCss, /\.sync-hot-window\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/, "hot window base layout is 3 columns");
// 热窗口底色必须与 settings-card 同底（--color-surface），不得用 muted 色形成色差。
assert.match(componentsCss, /\.sync-hot-window\{[^}]*background:var\(--color-surface\)/, "hot window background matches the settings card surface");
// 进度条单行样式：fill 行横向排布、bar 弹性伸展。
assert.match(componentsCss, /\.sync-hot-window \.sync-hot-window-fill\{grid-column:1\/-1;flex-direction:row;align-items:center/, "hot window fill row lays out horizontally");
assert.match(componentsCss, /\.sync-hot-window-fill dd\{flex:1;display:flex;align-items:center/, "fill row dd flexes bar and value inline");
assert.match(componentsCss, /\.sync-hot-window-fill dd>i\{flex:1;/, "the progress bar itself flexes to fill the row");
// 上次同步保持 3 列格子布局（不在全宽行），靠短设备 id 单行放下。
assert.ok(!/sync-last-sync/.test(componentsCss), "last sync stays in the 3-column grid (no full-width row)");
// 「清除数据并保留配置」必须保留设备 id（设备身份属配置而非数据）：
// 否则每次清库都会换一个新设备 id，水位表残留旧条目并虚增设备数。
assert.match(siteReset, /CONFIG_LOCAL_STORAGE_KEYS = \[[^\]]*"shijuan-study-v6-device-id"/, "clear-data keep-config preserves the device id");
// 同步页状态面板直接 live 订阅本地 head/checkpoint 缓存（syncMeta 表）：
// 本页或外部快速同步把水位/新代数写入本地缓存后，live 查询自动重跑，无需
// 轮询，也无需依赖 changeSets 队列（prune 保留近期 committed 记录，不是可靠信号）。
assert.match(syncView, /const hotWindow = useLiveQuery\(\(\) => \(settings\.owner && settings\.repo \? getSyncHotWindowState\(settings\)/, "hot window panel is a live query over the local head cache");
assert.match(syncView, /const lastCache = useLiveQuery\(\(\) => \(settings\.owner && settings\.repo \? getLastRemoteCache\(settings\)/, "last cache panel is a live query over the local checkpoint cache");
assert.ok(!/setInterval/.test(syncView), "sync page refreshes reactively, not by polling");
assert.ok(!/\.sync-hot-window\{[^}]*grid-template-columns:1fr/.test(componentsCss), "任何规则（含媒体查询）不得把热窗口覆盖回单列");
assert.doesNotMatch(studyApp, /onCreateAction=/, "top drawer no longer hosts the removed '新建业务操作' button");

assert.match(styles, /@media \(max-width: 760px\)/, "drawer has a mobile layout");
assert.match(styles, /@media \(max-width: 430px\)/, "drawer adapts to narrow phones");
assert.match(styles, /prefers-reduced-motion/, "motion respects user preferences");
assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "new UI uses semantic theme tokens only");
assert.doesNotMatch(styles, /\.sync-event-drawer\s*\{[^}]*border-top/si, "drawer has no decorative colored top edge");

console.log("sync event UI tests passed: controlled v7 manager, typed editing, batch drawer, cascade confirmation and responsive ARIA surface");
