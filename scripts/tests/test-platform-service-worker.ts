import assert from "node:assert/strict";
import { registerServiceWorker, shouldRegisterServiceWorker } from "../../src/platform/runtime";

const web = { platform: "web" as const, native: false, ios: false };
const native = { platform: "ios" as const, native: true, ios: true };
const registrations: Array<{ scriptURL: string; options?: RegistrationOptions }> = [];
const serviceWorker = {
  register: async (scriptURL: string, options?: RegistrationOptions) => {
    registrations.push({ scriptURL, options });
    return {} as ServiceWorkerRegistration;
  },
};

assert.equal(shouldRegisterServiceWorker(true, web), true, "web production must register a worker");
assert.equal(shouldRegisterServiceWorker(false, web), false, "development web must not register a worker");
assert.equal(shouldRegisterServiceWorker(true, native), false, "native production must never register a worker");

await registerServiceWorker(true, web, "/exam-study-app/sw.js", serviceWorker);
assert.equal(registrations.length, 1, "web production path must invoke registration");
assert.equal(registrations[0]?.scriptURL, "/exam-study-app/sw.js");
assert.deepEqual(registrations[0]?.options, { updateViaCache: "none" });

await registerServiceWorker(true, native, "./sw.js", serviceWorker);
assert.equal(registrations.length, 1, "native path must skip registration entirely");

console.log("platform service-worker tests passed: web production registers, native never registers");
