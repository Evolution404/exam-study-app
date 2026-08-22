import assert from "node:assert/strict";
import { detectPlatform, isIOSApp, isNativeApp } from "../../src/platform/environment";

assert.deepEqual(
  detectPlatform({ isNativePlatform: () => false, getPlatform: () => "web" }),
  { platform: "web", native: false, ios: false },
  "browser runtime must be detected as web",
);
assert.deepEqual(
  detectPlatform({ isNativePlatform: () => true, getPlatform: () => "ios" }),
  { platform: "ios", native: true, ios: true },
  "Capacitor iOS runtime must be detected as native iOS",
);
assert.deepEqual(
  detectPlatform({ isNativePlatform: () => true, getPlatform: () => "android" }),
  { platform: "web", native: true, ios: false },
  "unsupported native platforms must not be mistaken for iOS",
);
assert.equal(typeof isNativeApp(), "boolean");
assert.equal(typeof isIOSApp(), "boolean");

console.log("platform environment tests passed: web/native iOS detection and injected bridge");
