import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  bootstrapSecureCredentials,
  clearSecureCredentials,
  loadSecureCredential,
  resetSecureCredentialsForTests,
  saveSecureCredential,
  setSecureCredentialsPlugin,
} from "../../src/platform/secure-credentials";

class StorageMock {
  private values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void { this.values.delete(key); }
  clear(): void { this.values.clear(); }
}

Object.defineProperty(globalThis, "localStorage", { configurable: true, value: new StorageMock() });
Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: new StorageMock() });
const native = { platform: "ios" as const, native: true, ios: true };
const keychain = new Map<string, string>();
let failWrites = false;
const plugin = {
  async get({ key }: { key: string }) { return { value: keychain.get(key) ?? null }; },
  async set({ key, value }: { key: string; value: string }) { if (failWrites) throw new Error("Keychain unavailable"); keychain.set(key, value); },
  async remove({ key }: { key: string }) { keychain.delete(key); },
};

resetSecureCredentialsForTests();
setSecureCredentialsPlugin(plugin);
localStorage.setItem("github-token", "legacy-token");
sessionStorage.setItem("github-token", "legacy-session-token");
await bootstrapSecureCredentials(native);
assert.equal(loadSecureCredential(), "legacy-token");
assert.equal(keychain.get("github-token"), "legacy-token");
assert.equal(localStorage.getItem("github-token"), null, "legacy token is removed only after Keychain migration succeeds");
assert.equal(sessionStorage.getItem("github-token"), null);

localStorage.setItem("github-token", "stale-web-token");
sessionStorage.setItem("github-token", "stale-session-token");
await bootstrapSecureCredentials(native);
assert.equal(loadSecureCredential(), "legacy-token");
assert.equal(localStorage.getItem("github-token"), null, "native bootstrap removes stale localStorage even when Keychain already has a token");
assert.equal(sessionStorage.getItem("github-token"), null);

await saveSecureCredential("new-token");
assert.equal(loadSecureCredential(), "new-token");
assert.equal(keychain.get("github-token"), "new-token");
await saveSecureCredential("");
assert.equal(loadSecureCredential(), "");
assert.equal(keychain.has("github-token"), false);

resetSecureCredentialsForTests();
setSecureCredentialsPlugin(plugin);
localStorage.setItem("github-token", "must-survive-failure");
failWrites = true;
await assert.rejects(bootstrapSecureCredentials(native), /Keychain unavailable/);
assert.equal(localStorage.getItem("github-token"), "must-survive-failure", "failed migration must not delete the old token");
failWrites = false;

resetSecureCredentialsForTests();
setSecureCredentialsPlugin(plugin);
await bootstrapSecureCredentials(native);
await saveSecureCredential("clear-me");
await clearSecureCredentials();
assert.equal(keychain.has("github-token"), false);

const swiftPlugin = readFileSync(new URL("../../ios/App/App/SecureCredentialsPlugin.swift", import.meta.url), "utf8");
const bridgeController = readFileSync(new URL("../../ios/App/App/BridgeViewController.swift", import.meta.url), "utf8");
const sceneDelegate = readFileSync(new URL("../../ios/App/App/SceneDelegate.swift", import.meta.url), "utf8");
assert.match(swiftPlugin, /kSecAttrAccessibleWhenUnlockedThisDeviceOnly/, "Keychain values must remain device-local and unavailable while locked");
assert.match(bridgeController, /registerPluginInstance\(SecureCredentialsPlugin\(\)\)/, "the Capacitor bridge must register the Keychain plugin");
assert.match(sceneDelegate, /rootViewController = BridgeViewController\(\)/, "the active scene must instantiate the bridge that registers Keychain");
assert.doesNotMatch(sceneDelegate, /rootViewController = CAPBridgeViewController\(\)/, "the active scene must not bypass the custom bridge");

console.log("secure credentials tests passed: Keychain load/save/remove, failure-safe migration and active native registration");
