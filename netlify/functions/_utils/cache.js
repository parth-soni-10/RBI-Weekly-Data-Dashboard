// Tiny in-memory, time-to-live (TTL) memoization for the scrapers.
//
// Netlify functions are hot-launched and reused across invocations as long as
// the process stays warm, so a module-level Map can serve many repeat requests
// without re-scraping RBI/Yahoo/PIB/NSDL/etc. on every call. Combined with the
// `Cache-Control` headers the functions already send, this cuts both server-side
// scrape time (repeat calls hit memory) and client/CDN latency (browser + edge
// caches).
//
// Fail-open design: if the producer fn throws, the error propagates to the
// caller's normal try/catch, and we never store a value that wasn't resolved.
// Behaviour is identical to not caching, minus the repeated network work.

const store = new Map(); // key -> { t: epochMs, value }

/**
 * Memoize `fn`'s resolved value under `key` for `ttlMs`.
 * @param {string} key   global per-function cache key (include params if any)
 * @param {number} ttlMs time-to-live in milliseconds
 * @param {() => Promise<any>} fn producer
 * @returns {Promise<any>}
 */
function withCache(key, ttlMs, fn) {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && now - hit.t < ttlMs) {
    return Promise.resolve(hit.value);
  }
  return Promise.resolve()
    .then(fn)
    .then(value => {
      store.set(key, { t: now, value });
      return value;
    });
}

// Periodically drop entries older than a day so the module map can't grow
// without bound across a long-lived warm instance.
setInterval(() => {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [k, v] of store) if (now - v.t >= DAY) store.delete(k);
}, 30 * 60 * 1000).unref();

module.exports = { withCache };