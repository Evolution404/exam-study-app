import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { classifyPressIntent, QUICK_RESTORE_HOLD_MS, QUICK_SYNC_TAP_MAX_MS } from "../lib/press-intent";

assert.equal(classifyPressIntent(80, false, false), "tap");
assert.equal(classifyPressIntent(QUICK_SYNC_TAP_MAX_MS, false, false), "tap");
assert.equal(classifyPressIntent(QUICK_SYNC_TAP_MAX_MS + 1, false, false), "cancel");
assert.equal(classifyPressIntent(700, false, false), "cancel", "releasing during hold progress must not trigger sync");
assert.equal(classifyPressIntent(80, true, false), "cancel", "moving away or receiving pointercancel must cancel the action");
assert.equal(classifyPressIntent(QUICK_RESTORE_HOLD_MS, false, false), "complete");
assert.equal(classifyPressIntent(400, false, true), "complete");

const styles = await readFile(new URL("../app/styles/components.css", import.meta.url), "utf8");
assert.match(styles, /\.quick-sync-split \.quick-sync\.holding\{color:#fff;background:var\(--color-danger\)\}/, "holding the quick-sync button uses an unmistakable red danger surface");

console.log("press intent tests passed: tap, interrupted hold, cancelled pointer, completed hold");
