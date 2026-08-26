import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const manager = await readFile(new URL("../../src/app/sync/sync-event-manager.tsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("../../src/app/sync/sync-event-drawer.tsx", import.meta.url), "utf8");
const syncView = await readFile(new URL("../../src/app/sync/sync-view.tsx", import.meta.url), "utf8");
const studyApp = await readFile(new URL("../../src/app/shell/app-shell.tsx", import.meta.url), "utf8");
const quickSyncController = await readFile(new URL("../../src/app/shell/use-quick-sync-controller.ts", import.meta.url), "utf8");
const hotWindowPanel = await readFile(new URL("../../src/app/sync/sync-hot-window.tsx", import.meta.url), "utf8");
const styles = (await Promise.all(["sync-events-1.css", "sync-events-2.css"].map((file) => readFile(new URL(`../../src/app/styles/${file}`, import.meta.url), "utf8")))).join("\n");
const siteReset = await readFile(new URL("../../src/lib/sync/site-data-reset.ts", import.meta.url), "utf8");
const hintSource = await readFile(new URL("../../src/app/ui/hint.tsx", import.meta.url), "utf8");
const globalStyleManifest = await readFile(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const syncApplication = await readFile(new URL("../../src/lib/sync/sync-application.ts", import.meta.url), "utf8");

assert.match(manager, /ChangeSetMutationV7,[\s\S]*ChangeSetV7,[\s\S]*from "@\/lib\/sync\/sync-application"/, "UI consumes change-set types only through the public sync application contract");
assert.match(syncApplication, /from "\.\/change-set-v7-planning"/, "sync application owns change-set planning through the direct implementation owner");
assert.match(syncApplication, /from "\.\/change-set-v7-types"/, "sync application owns change-set types through the direct implementation owner");
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
assert.match(syncView, /同步时间起点/, "sync settings expose a device-local history synchronization start date");
assert.match(syncView, /type="date"[^>]*max=\{today\}/, "history synchronization start uses a bounded date input");
assert.match(syncView, /historySyncStart: event\.target\.value \|\| undefined/, "changing the date persists the selected device history range");
assert.match(syncView, /更早的练习与作答保留在远端，不下载到本设备/, "UI makes the non-destructive remote retention contract explicit");
assert.doesNotMatch(syncView, /onCreateAction/, "sync page no longer hosts the misleading '新建业务操作' button (it only jumped to banks)");
assert.match(hotWindowPanel, /<dt>检查点<\/dt>[\s\S]*<dt>当前头<\/dt>[\s\S]*<dt>分段<\/dt>[\s\S]*<dt>检查点体积<\/dt>[\s\S]*<dt>热窗口事件<\/dt>[\s\S]*<dt>上次同步<\/dt>[\s\S]*<dt>热窗口<\/dt>/, "hot window exposes checkpoint, head, segments, checkpoint size, hot-window events, last sync and hot bytes in order");
assert.match(hotWindowPanel, /segmentEvents/, "hot window exposes the pending event count (sum of segment counts)");
assert.match(hotWindowPanel, /<dt>热窗口事件<\/dt><dd>\{hotWindow\.segmentEvents\}<\/dd>/, "hot window events cell renders the segment-event sum");
assert.match(hotWindowPanel, /<dt>上次同步<\/dt><dd>\{syncedAt \? formatSyncedAt\(syncedAt\) : "—"\}<\/dd>/, "last sync shows only the local sync time");
assert.ok(!/latestSync|本设备|shortDeviceId|deviceCount/.test(hotWindowPanel), "panel carries no device-watermark display");
assert.match(hotWindowPanel, /checkpointStoredSize \?\? hotWindow\.checkpointSize/, "checkpoint volume cell shows a single value (stored size preferred)");
assert.doesNotMatch(hotWindowPanel, /<dd[^>]*title=/, "checkpoint volume cell no longer uses a native title attribute");
assert.match(hotWindowPanel, /<Hint label=\{checkpointTitle\(hotWindow\)\}><dd>/, "checkpoint volume full detail moves to the unified Hint tooltip");
assert.match(hotWindowPanel, /实际 \$\{formatBytes\(state\.checkpointStoredSize\)\} · 解压/, "hint label explains actual vs decompressed bytes");
assert.match(hotWindowPanel, /检查点体积 \$\{formatBytes\(state\.checkpointSize\)\}/, "checkpoint hint also shows a value when stored equals logical size (hover always pops)");
assert.match(hotWindowPanel, /尚未建立检查点，首次同步后自动生成/, "checkpoint hint explains when no checkpoint exists yet (hover always pops)");
assert.ok(packageJson.dependencies["@radix-ui/react-tooltip"], "unified hint depends on @radix-ui/react-tooltip");
assert.match(hintSource, /Tooltip\.Trigger\s+asChild/, "hint keeps the trigger element in place (Slot, no wrapper node)");
assert.match(hintSource, /createPortal\(/, "hint renders the popover via createPortal (synchronous mount, no Presence delay)");
assert.match(hintSource, /useLayoutEffect/, "hint measures the popover and clamps it inside the viewport after mount");
assert.match(hintSource, /spaceAbove/, "hint flips to the opposite side when the preferred side has no room (no trigger-covering flicker)");
assert.match(globalStyleManifest, /@import "\.\/hint\.css"/, "hint styles are wired into the global style manifest");
assert.match(hotWindowPanel, /<dt>热窗口<\/dt><dd><span>[\s\S]*?<\/span><i aria-hidden="true">/, "hot window fill row keeps label, value and bar on one line (text before the bar)");
assert.match(manager, /statusPanel\?: ReactNode;/, "manager offers a status panel slot below the toolbar");
assert.match(drawer, /statusPanel=\{<SyncHotWindowPanel hotWindow=\{hotWindow\} syncedAt=\{syncedAt\} \/>/, "drawer feeds the shared panel through the status slot");
assert.match(studyApp, /hotWindow=\{drawerHotWindow\} syncedAt=\{drawerSyncedAt\}/, "study-app passes hot window state to the drawer");
assert.match(quickSyncController, /syncApplication\.getHotWindow\(settings\)/, "drawer hot window state is loaded through the sync application boundary owned by the quick-sync controller");
const splitStyleNames = (await readdir(new URL("../../src/app/styles/", import.meta.url))).filter((file) => file.endsWith(".css")).sort();
const componentsCss = (await Promise.all(splitStyleNames.map((file) => readFile(new URL(`../../src/app/styles/${file}`, import.meta.url), "utf8")))).join("\n");
assert.match(componentsCss, /\.sync-hot-window\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/, "hot window base layout is 3 columns");
assert.match(componentsCss, /\.sync-hot-window\{[^}]*background:var\(--color-surface\)/, "hot window background matches the settings card surface");
assert.match(componentsCss, /\.sync-hot-window \.sync-hot-window-fill\{grid-column:1\/-1;flex-direction:row;align-items:center/, "hot window fill row lays out horizontally");
assert.match(componentsCss, /\.sync-hot-window-fill dd\{flex:1;display:flex;align-items:center/, "fill row dd flexes bar and value inline");
assert.match(componentsCss, /\.sync-hot-window-fill dd>i\{flex:1;/, "the progress bar itself flexes to fill the row");
assert.ok(!/sync-last-sync/.test(componentsCss), "last sync stays in the 3-column grid (no full-width row)");
assert.match(siteReset, /CONFIG_LOCAL_STORAGE_KEYS = \[[^\]]*"shijuan-study-device-id"/, "clear-data keep-config preserves the device id");
assert.match(syncView, /const hotWindow = useLiveQuery\(\(\) => syncApplication\.getHotWindow\(settings\)/, "hot window panel is a live query through the application boundary");
assert.match(syncView, /const lastCache = useLiveQuery\(\(\) => syncApplication\.getLastRemoteCache\(settings\)/, "last cache panel is a live query through the application boundary");
assert.ok(!/setInterval/.test(syncView), "sync page refreshes reactively, not by polling");
assert.ok(!/\.sync-hot-window\{[^}]*grid-template-columns:1fr/.test(componentsCss), "任何规则（含媒体查询）不得把热窗口覆盖回单列");
assert.doesNotMatch(studyApp, /onCreateAction=/, "top drawer no longer hosts the removed '新建业务操作' button");

assert.match(styles, /@media \(max-width: 760px\)/, "drawer has a mobile layout");
assert.match(styles, /@media \(max-width: 430px\)/, "drawer adapts to narrow phones");
assert.match(styles, /prefers-reduced-motion/, "motion respects user preferences");
assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "new UI uses semantic theme tokens only");
assert.doesNotMatch(styles, /\.sync-event-drawer\s*\{[^}]*border-top/si, "drawer has no decorative colored top edge");

console.log("sync event UI tests passed: controlled v7 manager, typed editing, batch drawer, cascade confirmation and responsive ARIA surface");