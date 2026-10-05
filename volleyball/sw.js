// Raiders VB PWA service worker — offline-first app shell.
// All data lives on-device in localStorage; this cache only makes the
// app itself load without a network connection after the first visit.
const CACHE = "raiders-vb-v1";
const APP_SHELL = [
  "/stadium-slugger-cage/volleyball/",
  "/stadium-slugger-cage/volleyball/index.html",
  "/stadium-slugger-cage/volleyball/manifest.json",
  "/stadium-slugger-cage/volleyball/icon-192.png",
  "/stadium-slugger-cage/volleyball/icon-512.png",
  "/stadium-slugger-cage/volleyball/apple-touch-icon.png",
  "/stadium-slugger-cage/volleyball/assets/index-BfZX8CfT.js",
  "/stadium-slugger-cage/volleyball/assets/index--9hGn9kO.css",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // leave Google Fonts etc. to the network
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(event.request)
          .then((res) => {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(event.request, copy));
            return res;
          })
          .catch(() => caches.match("/stadium-slugger-cage/volleyball/index.html")),
    ),
  );
});
