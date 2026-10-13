// Tiny in-memory, time-to-live (TTL) memoization for the scrapers.
//
// Function instances are hot-launched and reused across invocations as long as
// the process/isolate stays warm, so a module-level Map can serve many repeat
// requests without re-scraping RBI/Yahoo/PIB/NSDL/etc. on every call. Combined
// with the `Cache-Control` headers the functions already send, this cuts both
// server-side scrape time (repeat calls hit memory) and client/CDN latency
// (browser + edge caches).
//
// Fail-open design: if the producer fn throws, the error propagates to the
// caller's normal try/catch, and we never store a value that wasn't resolved.
// Behaviour is identical to not caching, minus the repeated network work.

const store = new Map(); // key -> { t: epochMs, value }

const DAY_MS = 24 * 60 * 60 * 1000;

// Entries older than a day are dropped so the map cannot grow without bound
// across a long-lived warm instance.
//
// This used to be a module-level `setInterval(...).unref()` — Node's way of
// keeping the process free to exit. The Workers runtime refuses both halves of
// that: it has no `unref()`, and creating a timer in global scope is a
// *disallowed operation* there, so importing this file failed the whole Worker
// ("Disallowed operation called within global scope"). Sweeping when the cache is
// written needs no timer at all, gives the same bound, and behaves identically
// under Node.
function sweep(now) {
  for (const [k, v] of store) if (now - v.t >= DAY_MS) store.delete(k);
}

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
      sweep(now);
      store.set(key, { t: now, value });
      return value;
    });
}

module.exports = { withCache };
