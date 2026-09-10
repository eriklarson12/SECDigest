/* SECDigest service worker (roadmap 5.8). Hand-rolled -- no next-pwa, no Serwist.
 *
 * Bump CACHE on any change to this file or to what it precaches. `activate`
 * deletes every other cache, which is what makes a deploy pick up new assets
 * instead of serving last week's shell forever.
 *
 * Requests this worker does not handle MUST fall through without calling
 * respondWith. Two reasons: an unhandled request is then a plain page request
 * with normal browser semantics, and Playwright's page.route -- which every e2e
 * spec mocks the backend with -- does not intercept fetches a worker issues
 * itself.
 */

const CACHE = "secdigest-v1";

/* The app shell. Not opengraph-image.png: it ships under a hashed URL by the
 * Next file convention precisely so unfurl caches miss it, and a fingerprinted
 * path cannot be precached by name. */
const PRECACHE = [
  "/",
  "/watchlist",
  "/offline",
  "/icon-192.png",
  "/icon-512.png",
  "/icon-maskable-512.png",
];

/* The API lives on another origin in production (Heroku) and on localhost:8000
 * in dev, and a file in public/ gets no build-time substitution, so this worker
 * cannot know NEXT_PUBLIC_API_URL. It matches on pathname instead, which is the
 * same on every origin. Safe here because the Next app declares no route
 * handlers of its own, so there is no same-origin /api/* to collide with. */
function isCacheableApi(url) {
  return (
    url.pathname.startsWith("/api/filings/") || url.pathname === "/api/analysis"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

async function cacheFirst(request) {
  const hit = await caches.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

/** `fallback` is used only when the network fails and nothing is cached. */
async function networkFirst(request, fallback) {
  try {
    const response = await fetch(request);
    // Only 200s. Caching a 429 would serve the rate-limit page back for the
    // life of the cache, long after the budget refilled.
    if (response.ok) {
      const cache = await caches.open(CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const hit = await caches.match(request);
    if (hit) return hit;
    if (fallback) {
      const page = await caches.match(fallback);
      if (page) return page;
    }
    throw error;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Hashed by the build, so a hit is always the right file.
  if (
    url.origin === self.location.origin &&
    url.pathname.startsWith("/_next/static/")
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/offline"));
    return;
  }

  // Everything else under /api stays network-only, deliberately: an analysis
  // body or a search result served stale is worse than one that fails.
  if (isCacheableApi(url)) {
    event.respondWith(networkFirst(request));
  }
});
