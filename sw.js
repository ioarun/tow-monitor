/* Cache the app shell so the tablet still opens it with no internet.
 *
 * The workshop has no connectivity of its own: the only link is the phone's
 * hotspot, and that is there for the alert, not for loading the page. Cache
 * first means the app starts even when the hotspot is off or out of signal.
 */
/* Cache-first, so the app starts with no connectivity. The cost is that the
 * device keeps serving this cache until the name changes -- publishing new
 * files without changing it ships nothing to the device. The publish
 * workflow rewrites this line with the source commit, so it cannot be
 * forgotten; the value here is only what a local checkout uses. */
const CACHE = "tow-monitor-9454a98";
/* The icons are in the shell too: an installed app whose icon 404s on a
   workshop with no connectivity is an app with no icon. */
const SHELL = ["./", "./index.html", "./cv.js", "./shift.js", "./manifest.webmanifest",
               "./icon-192.png", "./icon-512.png", "./icon-maskable-512.png",
               "./favicon-32.png"];

/* Nice to have, but not worth failing the install over. cache.addAll is
   atomic: one 404 and NOTHING is cached, so the app loses offline start
   entirely. baseline.json is written by tools/baseline.js and may legitimately
   not exist yet, so it is fetched separately and its failure ignored. */
const EXTRAS = ["./baseline.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(SHELL).then(() => Promise.all(
      EXTRAS.map(u => c.add(u).catch(() => {})))))
    .then(() => self.skipWaiting()));
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
