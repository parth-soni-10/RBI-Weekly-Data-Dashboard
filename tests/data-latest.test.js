// tests/data-latest.test.js - the public /data/*.json endpoints.
//
//   npm test          (node --test, no dependencies)
//
// These two endpoints used to scrape RBI on every request, which on Cloudflare
// (no implicit CDN cache in front of a Worker) made a cold request walk up to six
// Fridays and time out instead of answering. They now read the committed weekly
// snapshot through the ASSETS binding. These pin that: the newest record is
// served, a requested window is sliced, and a missing snapshot is a prompt 503 -
// never a hang.
const test = require("node:test");
const assert = require("node:assert/strict");

const latest = require("../netlify/functions/data-latest.js");
const forexWeekly = require("../netlify/functions/data-forex-weekly.js");

const SNAPSHOT = {
  fetched_at: "2026-10-17T11:03:11.647Z",
  data_updated_at: "2026-10-17T11:03:11.647Z",
  records: [
    { date: "2026-09-25", total_usd: 740000, gold_usd: 107000 },
    { date: "2026-10-02", total_usd: 734606, gold_usd: 106413 },
    { date: "2026-10-09", total_usd: 726027, gold_usd: 105094 },
  ],
};

/** A stand-in for the Pages ASSETS binding. */
function fakeAssets(payload, status = 200) {
  return {
    async fetch() {
      return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
    },
  };
}

test("data-latest serves the newest committed record without scraping RBI", async () => {
  latest.setAssets(fakeAssets(SNAPSHOT));
  const res = await latest.handler({ httpMethod: "GET", rawUrl: "https://example.test/data/latest.json" });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.status, "ok");
  assert.equal(body.iso, "2026-10-09");
  assert.equal(body.record.date, "2026-10-09");
  assert.equal(body.record.total_usd, 726027);
  assert.equal(body.snapshot_updated_at, "2026-10-17T11:03:11.647Z");
  assert.match(res.headers["Cache-Control"], /max-age=900/);
});

test("data-latest answers OPTIONS with 204", async () => {
  latest.setAssets(fakeAssets(SNAPSHOT));
  const res = await latest.handler({ httpMethod: "OPTIONS" });
  assert.equal(res.statusCode, 204);
});

test("data-forex-weekly slices the committed records to ?weeks", async () => {
  forexWeekly.setAssets(fakeAssets(SNAPSHOT));
  const res = await forexWeekly.handler({
    httpMethod: "GET",
    rawUrl: "https://example.test/data/forex-weekly.json?weeks=2",
    queryStringParameters: { weeks: "2" },
  });
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.weeks, 2);
  assert.equal(body.records.length, 2);
  assert.deepEqual(body.records.map(r => r.date), ["2026-10-02", "2026-10-09"]);
  assert.equal(body.records[1].iso, "2026-10-09", "each row keeps the iso alias the old scrape returned");
});

test("a missing or unreadable snapshot is a clear 503, never a hang", async () => {
  latest.setAssets(fakeAssets({ error: "gone" }, 404));
  const res = await latest.handler({ httpMethod: "GET", rawUrl: "https://example.test/data/latest.json" });
  assert.equal(res.statusCode, 503);
  const body = JSON.parse(res.body);
  assert.equal(body.status, "unavailable");
  assert.match(res.headers["Cache-Control"], /no-store/);

  // No store wired at all (e.g. a non-Pages caller) must fail the same way.
  latest.setAssets(null);
  const bare = await latest.handler({ httpMethod: "GET", rawUrl: "https://example.test/data/latest.json" });
  assert.equal(bare.statusCode, 503);
});

test("an empty snapshot is reported, not thrown", async () => {
  latest.setAssets(fakeAssets({ records: [] }));
  const res = await latest.handler({ httpMethod: "GET", rawUrl: "https://example.test/data/latest.json" });
  assert.equal(res.statusCode, 503);
  assert.equal(JSON.parse(res.body).status, "no_recent_data");
});
