import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const serviceWorker = read("public/sw.js");
const studyApp = read("app/study-app.tsx");
const syncView = read("app/sync-view.tsx");
const siteDataReset = read("lib/site-data-reset.ts");
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
assert.match(studyApp, /className="mobile-sync-settings"><SyncView/, "mobile preferences must reuse the complete sync view");
assert.match(syncView, /<h2>清除本机所有数据<\/h2>/, "sync view must expose the site-data reset action");
assert.match(syncView, /confirmLabel="清除并重新载入"/, "site-data reset must require explicit confirmation");
assert.match(syncView, /await clearAllSiteData\(\)/, "confirmed reset must clear data before reloading");
assert.match(siteDataReset, /navigator\.serviceWorker\.getRegistrations\(\)/, "reset must unregister service workers");
assert.match(siteDataReset, /caches\.keys\(\)/, "reset must clear offline caches");
assert.match(siteDataReset, /indexedDB\.databases\(\)/, "reset must discover IndexedDB databases");
assert.match(siteDataReset, /indexedDB\.deleteDatabase\(name\)/, "reset must delete IndexedDB databases");
assert.match(siteDataReset, /localStorage\.clear\(\)/, "reset must clear local storage");
assert.match(siteDataReset, /sessionStorage\.clear\(\)/, "reset must clear session storage");
assert.match(siteDataReset, /document\.cookie =/, "reset must expire site cookies");
assert.match(siteDataReset, /window\.location\.replace/, "reset must reload at a fresh site URL");

console.log("PWA cache tests passed: versioned shell, bounded SW update, cache strategies, restore and full site reset");
