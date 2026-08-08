const CACHE = "shijuan-v3";
const BASE = "/exam-study-app/";
self.addEventListener("install", (event) => event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([
  BASE,
  `${BASE}manifest.webmanifest`,
  `${BASE}icons/app-icon-192.png`,
  `${BASE}icons/app-icon-512.png`,
  `${BASE}icons/apple-touch-icon.png`,
]))));
self.addEventListener("activate", (event) => event.waitUntil(Promise.all([
  caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))),
  self.clients.claim(),
])));
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(fetch(event.request).then((response) => {
    const copy = response.clone();
    caches.open(CACHE).then((cache) => cache.put(event.request, copy));
    return response;
  }).catch(() => caches.match(event.request)));
});
