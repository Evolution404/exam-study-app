import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const serviceWorker = read("public/sw.js");
const studyApp = read("app/study-app.tsx");
const syncView = read("app/sync-view.tsx");
const main = read("src/main.tsx");

assert.match(serviceWorker, /const CACHE = "shijuan-v7"/);
assert.match(serviceWorker, /const NAVIGATION_TIMEOUT_MS = 1200/);
assert.match(serviceWorker, /function navigationNetworkFirst/);
assert.match(serviceWorker, /function assetCacheFirst/);
assert.match(serviceWorker, /return url\.pathname\.startsWith\(`\$\{BASE\}assets\//);
assert.match(serviceWorker, /key\.startsWith\(CACHE_PREFIX\)/);
assert.doesNotMatch(serviceWorker, /keys\.filter\(\(key\) => key !== CACHE/);

assert.match(main, /updateViaCache: "none"/);
assert.match(studyApp, /function updateServiceWorkerWithinTimeout/);
assert.match(studyApp, /await settleWithTimeout\(registration\.update\(\), 700\)/);
assert.doesNotMatch(studyApp, /onConfirm=\{\(\) => window\.location\.reload\(\)\}/);
assert.doesNotMatch(syncView, /window\.location\.reload/);
assert.match(studyApp, /onRestored=\{handleRestoreSuccess\}/);
assert.match(syncView, /onRestored\(`已从本机缓存恢复/);

console.log("PWA cache tests passed: versioned shell, bounded SW update, cache strategies and in-app restore reset");
