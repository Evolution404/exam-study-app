import assert from "node:assert/strict";
import { initializeLifecycle, lifecycleListenerAttached, shutdownLifecycle } from "../../src/platform/lifecycle";
import { syncRuntime } from "../../src/lib/sync/sync-runtime";

const native = { platform: "ios" as const, native: true, ios: true };
let stateListener: ((state: { isActive: boolean }) => void) | undefined;
let removed = false;
const app = {
  async addListener(_eventName: "appStateChange", listener: (state: { isActive: boolean }) => void) {
    stateListener = listener;
    return { remove: async () => { removed = true; } };
  },
  async getState() { return { isActive: true }; },
};

await initializeLifecycle(native, app);
assert.equal(lifecycleListenerAttached(), true);
assert.equal(syncRuntime.isAppActive(), true);
stateListener?.({ isActive: false });
assert.equal(syncRuntime.isAppActive(), false, "inactive must pause the runtime");
stateListener?.({ isActive: true });
assert.equal(syncRuntime.isAppActive(), true, "active must resume the runtime");

const cleanup = syncRuntime.startPeriodicPull({ enabled: true, seconds: 30, blocked: () => true });
stateListener?.({ isActive: false });
assert.equal(syncRuntime.isAppActive(), false);
stateListener?.({ isActive: true });
cleanup();
await shutdownLifecycle();
assert.equal(removed, true);
assert.equal(lifecycleListenerAttached(), false);
assert.equal(syncRuntime.isAppActive(), true);

console.log("lifecycle tests passed: active/inactive/active timer gating and listener cleanup");
