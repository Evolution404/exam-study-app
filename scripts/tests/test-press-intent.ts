import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyPressIntent, QUICK_RESTORE_HOLD_MS, QUICK_SYNC_TAP_MAX_MS } from "../../src/lib/practice/press-intent";

assert.equal(classifyPressIntent(80, false, false), "tap");
assert.equal(classifyPressIntent(QUICK_SYNC_TAP_MAX_MS, false, false), "tap");
assert.equal(classifyPressIntent(QUICK_SYNC_TAP_MAX_MS + 1, false, false), "tap");
assert.equal(classifyPressIntent(700, false, false), "tap", "a medium-length mobile press must still trigger sync");
assert.equal(classifyPressIntent(QUICK_RESTORE_HOLD_MS - 1, false, false), "tap", "one millisecond short of the hold threshold is still sync");
assert.equal(classifyPressIntent(80, true, false), "cancel", "moving away or receiving pointercancel must cancel the action");
assert.equal(classifyPressIntent(QUICK_RESTORE_HOLD_MS, false, false), "complete");
assert.equal(classifyPressIntent(400, false, true), "complete");

const styles = await readFile(new URL("../../src/app/styles/components.css", import.meta.url), "utf8");
const controls = await readFile(new URL("../../src/app/styles/controls.css", import.meta.url), "utf8");
const shell = await readFile(new URL("../../src/app/shell/app-shell.tsx", import.meta.url), "utf8");
assert.match(styles, /\.quick-sync-split \.quick-sync\.holding\{color:#fff;background:var\(--color-danger\)\}/, "holding the quick-sync button uses an unmistakable red danger surface");
// 进度环动画时长必须等于长按阈值（常量派生，改阈值不改 CSS 会在此失败）。
assert.match(styles, new RegExp(`quick-sync-hold-progress \\.?${QUICK_RESTORE_HOLD_MS / 1000}s`), "hold-progress ring duration must equal QUICK_RESTORE_HOLD_MS");
// 交互控件共用主题聚焦：非文本输入保留浅色圆角聚焦环，文本输入只靠边框变色（统一输入框样式，不套外部环）。
assert.match(controls, /\.app-shell :where\(button, a, select, \[tabindex\]\):focus-visible/, "interactive controls share the theme focus treatment instead of browser-blue outlines");
assert.match(controls, /\.app-shell :where\(input, textarea\):focus-visible/, "text inputs must not get the external focus ring");
assert.match(shell, /if \(document\.visibilityState === "hidden"\) resetQuickSyncPress\(\)/, "quick-sync press is cancelled when the document is hidden");
assert.match(shell, /window\.addEventListener\("pagehide", cancelOnLifecycle\)/, "quick-sync press is cancelled on pagehide");
assert.match(shell, /window\.addEventListener\("blur", cancelOnLifecycle\)/, "quick-sync press is cancelled when the window loses focus");
assert.match(shell, /onLostPointerCapture=\{cancelQuickSyncPress\}/, "lost pointer capture cannot leave the button in holding state");
assert.match(shell, /const dy = event\.clientY - press\.startY/, "movement cancellation considers the direction of a scroll gesture");

console.log("press intent tests passed: short/medium/slow sync, cancelled pointer, completed hold, lifecycle cleanup");
