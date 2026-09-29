/* Cache the app shell so the iPad still opens it with no internet.
 *
 * The workshop has no connectivity of its own: the only link is the phone's
 * hotspot, and that is there for the alert, not for loading the page. Cache
 * first means the app starts even when the hotspot is off or out of signal.
 */
const CACHE = "tow-monitor-v5";
const SHELL = ["./", "./index.html", "./cv.js", "./manifest.webmanifest"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  // Never cache the alert itself: a stale 200 from the cache would report a
  // notification as delivered when nothing left the building.
  if (url.hostname.endsWith("ntfy.sh")) return;
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match("./index.html"))));
});
