const CACHE = "shijuan-v9";
const CACHE_PREFIX = "shijuan-";
const NAVIGATION_TIMEOUT_MS = 1200;
const BASE = new URL("./", self.registration.scope).pathname;
const PRECACHE_URLS = [
  BASE,
  `${BASE}manifest.webmanifest`,
  `${BASE}icons/app-icon-192.png`,
  `${BASE}icons/app-icon-512.png`,
  `${BASE}icons/apple-touch-icon.png`,
];

function isAppRequest(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return false;
  // The same-origin GitHub API proxy must bypass the worker entirely: caching
  // its responses (or falling back to a stale head.json offline) would corrupt
  // the sync protocol's ETag/digest assumptions.
  return !url.pathname.startsWith(`${BASE}api-github/`);
}

function isNavigationRequest(request) {
  return request.mode === "navigate" || request.destination === "document";
}

// Vite places content-hashed JavaScript, CSS and imported images in this directory.
// Those URLs never need to be revalidated: a new build produces a new filename.
function isHashedAsset(request) {
  const url = new URL(request.url);
  return url.pathname.startsWith(`${BASE}assets/`);
}

async function putInCache(request, response) {
  if (!response || (!response.ok && response.type !== "opaque")) return;
  try {
    const cache = await caches.open(CACHE);
    await cache.put(request, response.clone());
  } catch {
    // A response with an unsuitable Vary header or a full storage quota should
    // not prevent the page from being served.
  }
}

function isExpectedAssetResponse(request, response) {
  if (!response || !response.ok) return false;
  const contentType = (response.headers.get("content-type") || "").toLowerCase();
  // Some SPA hosts answer a temporarily missing hashed asset with index.html and
  // status 200. Caching that fallback forever makes the next app shell load with
  // no styles or scripts, so reject it before it reaches the immutable cache.
  if (contentType.includes("text/html")) return false;
  if (request.destination === "style") return contentType.includes("text/css");
  if (request.destination === "script") return contentType.includes("javascript");
  if (request.destination === "image") return contentType.startsWith("image/");
  if (request.destination === "font") {
    return contentType.startsWith("font/") || contentType.includes("application/octet-stream");
  }
  return true;
}

function fetchWithTimeout(request, timeoutMs = NAVIGATION_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(request, { signal: controller.signal, cache: "no-cache" }).finally(() => clearTimeout(timer));
}

async function navigationNetworkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetchWithTimeout(request);
    if (!response.ok && response.type !== "opaque") throw new Error(`navigation returned ${response.status}`);
    await putInCache(request, response);
    return response;
  } catch {
    return (await cache.match(request))
      || (await cache.match(BASE))
      || Response.error();
  }
}

async function assetCacheFirst(request) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(request);
  if (cached && isExpectedAssetResponse(request, cached)) return cached;
  if (cached) await cache.delete(request);
  const response = await fetch(request, { cache: "no-cache" });
  if (!isExpectedAssetResponse(request, response)) {
    throw new Error(`unexpected asset response for ${request.url}`);
  }
  await putInCache(request, response);
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetchWithTimeout(request);
    if (!response.ok && response.type !== "opaque") throw new Error(`request returned ${response.status}`);
    await putInCache(request, response);
    return response;
  } catch {
    return (await cache.match(request)) || Response.error();
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Keep the old worker active when the shell itself cannot be downloaded;
    // optional icons and metadata may be populated by a later network request.
    await cache.add(BASE);
    await Promise.allSettled(PRECACHE_URLS.slice(1).map((url) => cache.add(url)));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE)
      .map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || !isAppRequest(event.request)) return;
  if (isNavigationRequest(event.request)) {
    event.respondWith(navigationNetworkFirst(event.request));
  } else if (isHashedAsset(event.request)) {
    event.respondWith(assetCacheFirst(event.request));
  } else {
    event.respondWith(networkFirst(event.request));
  }
});
