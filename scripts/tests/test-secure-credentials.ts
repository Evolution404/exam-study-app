import assert from "node:assert/strict";
import { bootstrapSecureCredentials, clearSecureCredentials, loadSecureCredential, resetSecureCredentialsForTests, saveSecureCredential, setSecureCredentialsPlugin } from "../../src/platform/secure-credentials";

const keychain = new Map<string, string>();
setSecureCredentialsPlugin({
  async get({ key }) { return { value: keychain.get(key) ?? null }; },
  async set({ key, value }) { keychain.set(key, value); },
  async remove({ key }) { keychain.delete(key); },
});
const native = { platform: "ios" as const, native: true, ios: true };
await bootstrapSecureCredentials(native);
assert.equal(loadSecureCredential(), "");
await saveSecureCredential("current-token");
assert.equal(loadSecureCredential(), "current-token");
assert.equal(keychain.get("github-token"), "current-token");
await clearSecureCredentials();
assert.equal(loadSecureCredential(), "");
assert.equal(keychain.has("github-token"), false);
resetSecureCredentialsForTests();
console.log("secure credentials tests passed: Keychain-only load/save/remove");
