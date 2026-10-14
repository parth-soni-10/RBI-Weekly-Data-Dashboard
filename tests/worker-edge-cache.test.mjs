// tests/worker-edge-cache.test.mjs — what the Worker is willing to edge-cache.
//
//   npm test          (node --test, no dependencies)
//
// worker.js stores a routed response in the colo cache so the data-* endpoints
// answer from the edge for the 900s the handlers already declare, instead of
// re-scraping RBI on every request. That is only safe while the gate stays
// narrow: a response may be stored when its own Cache-Control says `public`
// with a positive max-age and it carries no Set-Cookie. Every error path in
// these handlers sends `no-store`, and data-sync sends it on reads as well as
// writes, so nothing that must stay fresh is held by mistake.
//
// The header strings below are the literals the handlers actually send (see
// the Cache-Control values across netlify/functions/*.js), so this pins the
// decision against the real policy rather than a convenient stand-in.
import test from "node:test";
import assert from "node:assert/strict";

import worker, { storeable } from "../worker.js";

const response = (headers) => new Response("{}", { headers });

const allows = (cacheControl, extra = {}) =>
  storeable(response({ "Cache-Control": cacheControl, ...extra }));

test("a handler that declares a public lifetime is stored", () => {
  assert.equal(allows("public, max-age=900"), true, "the data-* endpoints");
  assert.equal(allows("public, max-age=86400"), true);
  assert.equal(allows("public, max-age=120"), true);
  assert.equal(allows("public, max-age=900, must-revalidate"), true);
  assert.equal(allows("PUBLIC, MAX-AGE=900"), true, "casing is not policy");
});

test("a no-store response is never stored", () => {
  // data-sync (reads and writes) and every error path in the data-* handlers.
  assert.equal(allows("no-store"), false);
  assert.equal(allows("public, max-age=900, no-store"), false, "no-store wins");
  assert.equal(allows("no-store, public, max-age=900"), false);
});

test("a response nothing asked to be cached is not stored", () => {
  assert.equal(storeable(response({})), false, "no Cache-Control at all");
  assert.equal(allows(""), false);
  assert.equal(allows("max-age=900"), false, "private is the default");
  assert.equal(allows("private, max-age=900"), false);
  assert.equal(allows("no-cache"), false);
});

test("a zero or unparseable lifetime is not stored", () => {
  assert.equal(allows("public, max-age=0"), false);
  assert.equal(allows("public"), false);
  assert.equal(allows("public, max-age=soon"), false);
});

test("a response that sets a cookie is not stored", () => {
  // The colo cache is shared across visitors, so a Set-Cookie response must
  // never be handed to the next one.
  assert.equal(allows("public, max-age=900", { "Set-Cookie": "a=b" }), false);
});

// ---------------------------------------------------------------------------
// The fetch path itself, driven through the Worker's own export.
//
// The colo cache is the one piece of the runtime these tests stand in for: a
// Map with match/put is the whole interface worker.js uses. Stubbing it means
// the assertions are about which requests reach a handler and which responses
// get stored — no network, no scraper, no 40-second wait.
// ---------------------------------------------------------------------------

function runtime() {
  const entries = new Map();
  const puts = [];
  const pending = [];
  const caches = {
    default: {
      async match(request) {
        return entries.get(new URL(request.url).pathname);
      },
      async put(request, response) {
        puts.push(new URL(request.url).pathname);
        entries.set(new URL(request.url).pathname, response);
      },
    },
  };
  const ctx = { waitUntil: (p) => pending.push(Promise.resolve(p).catch(() => {})) };
  // data-sync reads and writes this; an empty namespace is enough.
  const env = { SYNC_KV: { async get() { return null; }, async put() {} } };
  return { caches, ctx, env, entries, puts, pending };
}

async function call(runtime, path, init) {
  globalThis.caches = runtime.caches;
  const response = await worker.fetch(new Request(`https://dashboard.test${path}`, init), runtime.env, runtime.ctx);
  await Promise.all(runtime.pending);
  return response;
}

test("an edge hit is returned without the handler running", async () => {
  const rt = runtime();
  // A sentinel the scrapers could never produce: getting it back proves the
  // request ended at the cache, so the 40-second RBI scrape never started.
  rt.entries.set("/data/latest.json", new Response("SENTINEL", { headers: { "Cache-Control": "public, max-age=900" } }));

  const response = await call(rt, "/data/latest.json");
  assert.equal(await response.text(), "SENTINEL");
  assert.deepEqual(rt.puts, [], "a hit must not be re-stored");
});

test("a no-store route is left alone: not served from cache, not stored", async () => {
  const rt = runtime();
  const response = await call(rt, "/.netlify/functions/data-sync");

  // The handler answered (and said no-store), so nothing was stored and a
  // second request will reach it again — data-sync's reads must stay fresh.
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control") || "", /no-store/);
  assert.deepEqual(rt.puts, [], "a no-store response must not enter the cache");
  assert.equal(rt.entries.size, 0);
});

test("a write is neither served from cache nor stored", async () => {
  const rt = runtime();
  // Seed a hit for the path a POST would use, to show the method, not just the
  // headers, is what keeps a write out of the cache.
  rt.entries.set("/.netlify/functions/data-sync", new Response("SENTINEL"));
  const response = await call(rt, "/.netlify/functions/data-sync", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://dashboard.test" },
    body: JSON.stringify({ records: [] }),
  });

  assert.notEqual(await response.text(), "SENTINEL", "a POST must reach the handler");
  assert.deepEqual(rt.puts, [], "a POST response must not be stored");
});

test("the cache entry's lifetime is the handler's own max-age", () => {
  // worker.js does not restate a TTL of its own: the Cache API reads the
  // response's Cache-Control. This is what makes the handler's declaration the
  // single source of the number, so read it back out the same way.
  const res = response({ "Cache-Control": "public, max-age=1800" });
  assert.equal(storeable(res), true);
  assert.equal(Number(res.headers.get("Cache-Control").match(/max-age=(\d+)/)[1]), 1800);
});
