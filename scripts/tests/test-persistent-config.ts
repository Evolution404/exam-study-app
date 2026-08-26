import assert from "node:assert/strict";
import { Preferences } from "@capacitor/preferences";
import {
  clearPersistentConfig,
  getPersistentConfigMirror,
  hydratePersistentConfig,
  persistConfigValue,
  setPersistentPreferencesBridge,
} from "../../src/platform/persistent-config";

class StorageMock {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new StorageMock() });
const native = { platform: "ios" as const, native: true, ios: true };
const values = new Map<string, string>([
  ["github-settings", JSON.stringify({ owner: "owner", repo: "repo", branch: "main", apiBaseUrl: "/api-github" })],
  ["study-v7-preferences", JSON.stringify({ themeMode: "dark" })],
  ["shijuan-study-v7-device-id", "device-persisted"],
]);
let failSet = false;
const bridge = {
  async get({ key }: { key: string }) { return { value: values.get(key) ?? null }; },
  async set({ key, value }: { key: string; value: string }) { if (failSet) throw new Error("Preferences unavailable"); values.set(key, value); },
  async remove({ key }: { key: string }) { values.delete(key); },
};

setPersistentPreferencesBridge(bridge);
await hydratePersistentConfig(native);
assert.equal(JSON.parse(localStorage.getItem("github-settings") ?? "{}").apiBaseUrl, "/api-github", "native hydration preserves the authoritative current value");
assert.equal(getPersistentConfigMirror("study-v7-preferences"), JSON.stringify({ themeMode: "dark" }));
assert.equal(getPersistentConfigMirror("shijuan-study-v7-device-id"), "device-persisted");

await persistConfigValue("study-v7-preferences", JSON.stringify({ themeMode: "light" }));
assert.equal(values.get("study-v7-preferences"), JSON.stringify({ themeMode: "light" }));
failSet = true;
await assert.rejects(persistConfigValue("github-settings", "{}"), /Preferences unavailable/, "critical preference writes must propagate failures");
failSet = false;

await clearPersistentConfig();
assert.equal(values.size, 0);
setPersistentPreferencesBridge(Preferences);

console.log("persistent config tests passed: bootstrap hydration, mirror writes, failure propagation and clear");
