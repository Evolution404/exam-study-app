import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPlatformHaptics } from "../../src/platform/haptics";

const webPatterns: Array<number | number[]> = [];
const web = createPlatformHaptics({ isNative: () => false, vibrate: (pattern) => { webPatterns.push(pattern); return true; } });
await web.answer(true);
await web.answer(false);
await web.selection();
assert.deepEqual(webPatterns, [35, [45, 35, 45], 12], "web haptics must preserve vibration feedback");

const nativeCalls: string[] = [];
const native = createPlatformHaptics({
  isNative: () => true,
  bridge: {
    notification: async ({ type }) => { nativeCalls.push(`notification:${type}`); },
    selectionChanged: async () => { nativeCalls.push("selection"); },
    impact: async () => { nativeCalls.push("light"); },
  },
});
await native.answer(true);
await native.answer(false);
await native.selection();
await native.light();
assert.deepEqual(nativeCalls, ["notification:SUCCESS", "notification:ERROR", "selection", "light"], "native haptics must use iOS notification and light APIs");

const failing = createPlatformHaptics({
  isNative: () => true,
  bridge: {
    notification: async () => { throw new Error("native haptics unavailable"); },
    selectionChanged: async () => { throw new Error("native haptics unavailable"); },
    impact: async () => { throw new Error("native haptics unavailable"); },
  },
});
await assert.doesNotReject(() => failing.answer(false), "haptic failures must not reject answer transactions");
await assert.doesNotReject(() => failing.selection(), "selection haptic failures must be ignored");
await assert.doesNotReject(() => failing.light(), "light haptic failures must be ignored");

const helpers = readFileSync(new URL("../../src/app/shell/helpers.ts", import.meta.url), "utf8");
assert.match(helpers, /platformHaptics\.answer\(correct\)/, "answer feedback must use the platform haptics adapter");
assert.match(helpers, /if \(isNativeApp\(\)\) return;/, "service-worker update must be a native no-op");

console.log("native haptics tests passed: web/native routing and failure tolerance");
