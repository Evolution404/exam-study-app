import assert from "node:assert/strict";
import fs from "node:fs";

const read = (file: string) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
const serviceWorker = read("public/sw.js");
const studyApp = read("src/app/shell/app-shell.tsx");
const shellHelpers = read("src/app/shell/helpers.ts");
const preferencesView = read("src/app/shell/views/preferences-view.tsx");
const syncView = read("src/app/sync/sync-view.tsx");
const syncApplication = read("src/lib/sync/sync-application.ts");
const siteDataReset = read("src/lib/sync/site-data-reset.ts");
const main = read("src/main.tsx");
const errorBoundary = read("src/app/error-boundary.tsx");
const headers = read("public/_headers");
const previewSmoke = read("scripts/tests/test-pwa-preview.mjs");

assert.match(serviceWorker, /const CACHE = "shijuan-v10"/);
assert.match(serviceWorker, /const NAVIGATION_TIMEOUT_MS = 1200/);
assert.match(serviceWorker, /const APP_REQUEST_TIMEOUT_MS = 8000/, "non-navigation app requests need a longer network budget than the navigation cut-off");
assert.match(serviceWorker, /`\$\{BASE\}icons\/favicon-64\.png`/, "the favicon must be precached so a cold first load never re-fetches it late");
assert.match(serviceWorker, /networkFirst[\s\S]{0,400}fetchWithTimeout\(request, APP_REQUEST_TIMEOUT_MS\)/, "networkFirst must use the app request budget, not the 1.2 s navigation timeout");
assert.match(serviceWorker, /function navigationNetworkFirst/);
assert.match(serviceWorker, /function assetCacheFirst/);
assert.match(serviceWorker, /function isExpectedAssetResponse/);
assert.match(serviceWorker, /contentType\.includes\("text\/html"\)/, "SPA HTML fallbacks must never enter the immutable asset cache");
assert.match(serviceWorker, /request\.destination === "style"[\s\S]*contentType\.includes\("text\/css"\)/, "stylesheet assets must have a CSS MIME type");
assert.match(serviceWorker, /if \(cached\) await cache\.delete\(request\)/, "invalid cached assets must be evicted and fetched again");
assert.match(serviceWorker, /fetch\(request, \{ cache: "no-cache" \}\)/, "immutable asset recovery must bypass a poisoned HTTP cache entry");
assert.match(serviceWorker, /fetch\(request, \{ signal: controller\.signal, cache: "no-cache" \}\)/, "navigation revalidates the HTML shell instead of accepting a stale HTTP-cache entry");
assert.match(serviceWorker, /return url\.pathname\.startsWith\(`\$\{BASE\}assets\//);
assert.match(serviceWorker, /return !url\.pathname\.startsWith\(`\$\{BASE\}api-github\/`\)/, "the same-origin GitHub API proxy must bypass the service worker (no caching, no stale offline fallback)");
assert.match(serviceWorker, /key\.startsWith\(CACHE_PREFIX\)/);
assert.doesNotMatch(serviceWorker, /keys\.filter\(\(key\) => key !== CACHE/);
assert.match(headers, /\/index\.html[\s\S]*Cache-Control: no-cache, must-revalidate/, "entry HTML must revalidate on every deployment");
assert.match(headers, /\/sw\.js[\s\S]*Cache-Control: no-cache, must-revalidate/, "service worker source must revalidate after deployment");
assert.match(headers, /\/manifest\.webmanifest[\s\S]*Cache-Control: no-cache, must-revalidate/, "manifest must revalidate after deployment");
assert.match(headers, /\/icons\/\*[\s\S]*Cache-Control: no-cache, must-revalidate/, "fixed-name PWA icons must revalidate after deployment");
assert.match(headers, /\/assets\/\*[\s\S]*Cache-Control: public, max-age=31536000, immutable/, "content-hashed assets remain safely immutable");
assert.match(previewSmoke, /npm run build/, "PWA smoke must exercise a production build");
assert.match(previewSmoke, /run", "preview/, "PWA smoke must exercise Vite preview");
assert.match(previewSmoke, /navigator\.serviceWorker\.controller/, "PWA smoke must verify an active service worker controls the preview page");
assert.match(previewSmoke, /shijuan-v10/, "PWA smoke must verify the versioned service-worker cache");

// 代理一致性由 test-github-relay-consistency 专门验证。这里只保留 PWA 边界：
// 同源 /api-github 请求必须绕过 Service Worker，避免被缓存或离线回退。

assert.match(main, /updateViaCache: "none"/);
assert.match(main, /dbV7Ready\.then[\s\S]*\.catch/, "startup failures must render a recovery screen instead of leaving a blank root");
assert.match(errorBoundary, /class AppErrorBoundary/, "render failures must be caught by a top-level error boundary");
assert.match(errorBoundary, /重试加载/, "startup recovery must offer an explicit retry");
assert.match(errorBoundary, /导出 JSON\/Excel/, "startup recovery must direct users to export before any destructive reset");
assert.match(shellHelpers, /function updateServiceWorkerWithinTimeout/);
assert.match(shellHelpers, /await settleWithTimeout\(registration\.update\(\), 700\)/);
assert.doesNotMatch(studyApp, /onConfirm=\{\(\) => window\.location\.reload\(\)\}/);
assert.doesNotMatch(syncView, /window\.location\.reload/);
assert.match(studyApp, /onRestored=\{handleRestoreSuccess\}/);
assert.match(syncView, /onRestored\(`已从本机缓存恢复/);
assert.match(syncView, /<section className="restore-card data-restore-card">/, "local and remote recovery must share one restore card");
assert.match(syncView, /setRestorePrompt\("cache"\)[\s\S]*?"本地恢复"/, "local recovery must use the four-character label");
assert.match(syncView, /setRestorePrompt\("remote"\)[\s\S]*?"远端恢复"/, "remote recovery must use the four-character label");
assert.match(syncView, /syncApplication\.restoreRemote\(setOperationProgress\)/, "UI remote recovery must go through the sync application boundary");
assert.match(syncApplication, /return restoreFullHistoryFromGitHub\(settings, token, callback\)/, "the application boundary must preserve full remote recovery including history archives");
assert.doesNotMatch(syncView, /restoreFullHistoryFromGitHub|github-sync-v7|github-credentials/, "sync view must not bypass the application boundary");
assert.doesNotMatch(syncView, /快速恢复|完整恢复|remoteFull/, "sync view must not expose obsolete fast/full recovery choices");
assert.match(preferencesView, /className="mobile-sync-settings"><SyncView/, "mobile preferences must reuse the complete sync view");
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

console.log("PWA cache tests passed: versioned shell, bounded SW update, cache strategies, restore application boundary and full site reset");
