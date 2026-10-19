// Raiders VB PWA service worker — offline-first app shell.
// All data lives on-device in localStorage; this cache only makes the
// app itself load without a network connection after the first visit.
//
// v3: the app is a single inlined index.html (no external JS/CSS assets),
// so there is nothing fingerprinted to go stale. Navigations are
// network-first so a new deploy reaches the user on the next visit;
// everything else is cache-first with network fallback.
const CACHE = "raiders-vb-v3";
const SCOPE = "/stadium-slugger-cage/volleyball";
const APP_SHELL = [
  `${SCOPE}/`,
  `${SCOPE}/index.html`,
  `${SCOPE}/manifest.json`,
  `${SCOPE}/icon-192.png`,
  `${SCOPE}/icon-512.png`,
  `${SCOPE}/apple-touch-icon.png`,
];
const SHELL_HTML = `${SCOPE}/index.html`;

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // cache:"reload" bypasses the HTTP cache so a new shell really is new.
      .then((cache) => cache.addAll(APP_SHELL.map((u) => new Request(u, { cache: "reload" }))))
      .then(() => self.skipWaiting()),
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

  // Navigations: network-first so a deploy reaches the user on the next
  // visit; fall back to the cached shell when offline.
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(new Request(event.request, { cache: "reload" }))
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(SHELL_HTML, copy));
          return res;
        })
        .catch(() => caches.match(SHELL_HTML)),
    );
    return;
  }

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
          .catch(() => caches.match(SHELL_HTML)),
    ),
  );
});
