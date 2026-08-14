import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manager = await readFile(new URL("../app/sync-event-manager.tsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("../app/sync-event-drawer.tsx", import.meta.url), "utf8");
const syncView = await readFile(new URL("../app/sync-view.tsx", import.meta.url), "utf8");
const studyApp = await readFile(new URL("../app/study-app.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/sync-events.css", import.meta.url), "utf8");

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
assert.match(styles, /\.sync-event-toolbar\s*\{[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\) 168px;[\s\S]*gap:\s*12px;/, "desktop toolbar keeps consistent spacing and a compact status selector");
assert.match(styles, /\.sync-event-search,[\s\S]*\.sync-event-filter\s*\{[\s\S]*height:\s*44px;/, "search and status controls share the standard control height");
assert.match(styles, /\.settings-card \.sync-event-search input\s*\{[\s\S]*border:\s*0;[\s\S]*padding:\s*0;/, "sync search resists generic settings-card input styles");

assert.match(manager, /onCreateAction/, "business action creation is callback-controlled");
assert.match(manager, /onRefresh/, "refresh is callback-controlled");
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
assert.doesNotMatch(syncView, /onCreateAction/, "sync page no longer hosts the misleading '新建业务操作' button (it only jumped to banks); creation stays in the contextual drawer");
assert.match(studyApp, /onCreateAction=\{\(\) => \{ setSyncDrawerOpen\(false\); setView\("banks"\); \}\}/, "top drawer routes creation through the normal business UI");

assert.match(styles, /@media \(max-width: 760px\)/, "drawer has a mobile layout");
assert.match(styles, /@media \(max-width: 430px\)/, "drawer adapts to narrow phones");
assert.match(styles, /prefers-reduced-motion/, "motion respects user preferences");
assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "new UI uses semantic theme tokens only");
assert.doesNotMatch(styles, /\.sync-event-drawer\s*\{[^}]*border-top/si, "drawer has no decorative colored top edge");

console.log("sync event UI tests passed: controlled v7 manager, typed editing, batch drawer, cascade confirmation and responsive ARIA surface");
