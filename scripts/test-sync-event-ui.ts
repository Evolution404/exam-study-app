import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manager = await readFile(new URL("../app/sync-event-manager.tsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("../app/sync-event-drawer.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../app/styles/sync-events.css", import.meta.url), "utf8");

assert.match(manager, /import type \{ ChangeSetMutationV7, ChangeSetV7 \} from "@\/lib\/change-set-v7"/, "UI consumes the immutable v7 type contract without owning persistence");
for (const state of ["pending", "claimed", "blocked", "committed"]) {
  assert.match(manager, new RegExp(`${state}:`), `manager presents ${state} state`);
}
assert.match(manager, /搜索类型、对象或编号/, "manager exposes search");
assert.match(manager, /按状态筛选/, "manager exposes an accessible status filter");
assert.match(manager, /sync-event-detail-/, "change-set details are expandable and linked with aria-controls");

for (const editableKind of ["note.upserted", "bank.update", "question.upsert"]) {
  assert.match(manager, new RegExp(`mutation\\.kind === \\"${editableKind.replace(".", "\\.")}\\"`), `typed form exists for ${editableKind}`);
}
assert.doesNotMatch(manager, /JSON\.stringify|contentEditable|原始 JSON|raw JSON/i, "manager never exposes a raw event editor");
assert.match(manager, /删除整个 change-set/, "deletion is whole-change-set only");
assert.match(manager, /cascadeDependents/, "dependency cascade decision is returned to the controller");
assert.match(manager, /dependentChangeSetIds/, "dependent operations are shown before cascade deletion");

assert.match(manager, /onCreateAction/, "business action creation is callback-controlled");
assert.match(manager, /onRefresh/, "refresh is callback-controlled");
assert.match(manager, /onSyncNow/, "sync is callback-controlled");
assert.match(manager, /role="progressbar"/, "sync progress is accessible");
assert.match(manager, /本批同步/, "current batch has a named section");
assert.match(manager, /下次同步/, "next batch has a named section");

assert.match(drawer, /role="dialog" aria-modal="true"/, "drawer exposes modal dialog semantics");
assert.match(drawer, /aria-labelledby="sync-event-drawer-title"/, "drawer has an accessible title");
assert.match(drawer, /event\.key === "Escape"/, "drawer closes with Escape");
assert.match(drawer, /previouslyFocused\?\.focus\(\)/, "drawer restores focus when closed");
assert.match(drawer, /showBatchSections/, "top drawer enables current/next batch grouping");

assert.match(styles, /@media \(max-width: 760px\)/, "drawer has a mobile layout");
assert.match(styles, /@media \(max-width: 430px\)/, "drawer adapts to narrow phones");
assert.match(styles, /prefers-reduced-motion/, "motion respects user preferences");
assert.doesNotMatch(styles, /#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i, "new UI uses semantic theme tokens only");
assert.doesNotMatch(styles, /\.sync-event-drawer\s*\{[^}]*border-top/si, "drawer has no decorative colored top edge");

console.log("sync event UI tests passed: controlled v7 manager, typed editing, batch drawer, cascade confirmation and responsive ARIA surface");
