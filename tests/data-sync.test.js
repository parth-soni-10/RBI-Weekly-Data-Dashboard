// tests/data-sync.test.js — regression tests for the data-sync write path.
//
//   npm test          (node --test, no dependencies)
//
// data-sync is a public, shared cache: whatever it accepts is what every
// visitor's browser renders. These tests pin the three things that keep that
// safe — shape validation, the write guards, and the cleaning applied to
// values read back out of the store — so a future edit cannot quietly reopen
// the hole that let a record's "date" execute as markup.
//
// @netlify/blobs is replaced with an in-memory stub before the function is
// required, so no Netlify runtime is needed.
const test = require("node:test");
const assert = require("node:assert/strict");

let saved = null;
const fakeStore = {
  async get() { return saved; },
  async setJSON(_key, value) { saved = value; },
};
const blobsPath = require.resolve("@netlify/blobs");
require.cache[blobsPath] = {
  id: blobsPath,
  filename: blobsPath,
  loaded: true,
  exports: { getStore: () => fakeStore },
};

const { handler } = require("../netlify/functions/data-sync.js");

const HOST = "rbi-dashboard.example.netlify.app";
const post = (body, headers = {}) => handler({
  httpMethod: "POST",
  headers: { host: HOST, ...headers },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const get = () => handler({ httpMethod: "GET", headers: { host: HOST } });
const record = (date = "2026-09-04") => ({ date, total_usd: 785706, gold_usd: 113816, usd_inr: 94.49 });

test("a record whose date is markup is refused and nothing is written", async () => {
  saved = null;
  const res = await post({ records: [{ date: "<img src=x onerror=alert(1)>", total_usd: 1 }] });
  assert.equal(res.statusCode, 400);
  assert.equal(saved, null, "a rejected write must not reach the store");
});

test("a well-formed record round-trips", async () => {
  saved = null;
  const res = await post({ records: [record()] });
  assert.equal(res.statusCode, 200);
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].date, "2026-09-04");

  const back = await get();
  assert.equal(back.statusCode, 200);
  assert.deepEqual(JSON.parse(back.body).records, [record()]);
});

test("angle brackets in any stored string are stripped", async () => {
  saved = null;
  const res = await post({
    records: [{ ...record(), note: "<script>alert(1)</script>ok" }],
    pmcares: { rows: [{ fy: "2019-20", note: "<b>x</b>", close: 1 }], checkedAt: "2026-09-04T00:00:00.000Z" },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(saved.records[0].note, "scriptalert(1)/scriptok");
  assert.equal(saved.pmcares.rows[0].note, "bx/b");
});

test("cross-origin writes are refused, same-origin writes pass", async () => {
  saved = null;
  const cross = await post({ records: [record()] }, { origin: "https://evil.example", host: HOST });
  assert.equal(cross.statusCode, 403);
  assert.equal(saved, null);

  const same = await post({ records: [record()] }, { origin: `https://${HOST}` });
  assert.equal(same.statusCode, 200);
});

test("a request with no Origin (curl, CI) is validated, not blocked", async () => {
  saved = null;
  const res = await post({ records: [record()] });
  assert.equal(res.statusCode, 200);
});

test("the optional write token is enforced when configured", async () => {
  saved = null;
  process.env.SYNC_WRITE_TOKEN = "s3cret-token";
  try {
    const missing = await post({ records: [record()] });
    assert.equal(missing.statusCode, 401);
    assert.equal(JSON.parse(missing.body).code, "SYNC_TOKEN_REQUIRED");

    const wrong = await post({ records: [record()] }, { "x-sync-token": "nope" });
    assert.equal(wrong.statusCode, 401);

    const right = await post({ records: [record()] }, { "x-sync-token": "s3cret-token" });
    assert.equal(right.statusCode, 200);
  } finally {
    delete process.env.SYNC_WRITE_TOKEN;
  }
});

test("read-side cleaning defuses a blob written before validation existed", async () => {
  saved = {
    savedAt: "2026-09-04T00:00:00.000Z",
    records: [
      { date: "2026-09-04", total_usd: 1 },
      { date: "<img src=x onerror=alert(1)>", total_usd: 2 },
      { date: "2026-09-11", note: "<script>alert(2)</script>" },
    ],
    forward: { date: "2026-08-01", net_fwd: 1.5, source: "<b>evil</b>" },
    pmcares: { rows: [{ fy: "2019-20", note: "<iframe src=//evil>" }], checkedAt: "2026-09-04T00:00:00.000Z" },
    em: { "6mo": { peers: [{ code: "BRL", points: [1, 2], dates: ["2026-09-04"] }], fetchedAt: "2026-09-04T00:00:00.000Z" } },
  };
  const res = await get();
  assert.equal(res.statusCode, 200);
  const body = res.body;
  assert.ok(!body.includes("<") && !body.includes(">"), `no markup may survive a read: ${body}`);
  const parsed = JSON.parse(body);
  assert.equal(parsed.records.length, 2, "the record with a non-date is dropped");
  assert.equal(parsed.records[0].date, "2026-09-04");
  assert.equal(parsed.forward.date, "2026-08-01");
});

test("caps and shape checks reject oversized or malformed writes", async () => {
  saved = null;
  const tooMany = await post({ records: Array.from({ length: 501 }, (_, i) => ({ date: `2026-01-01`, i })) });
  assert.equal(tooMany.statusCode, 400);

  const badForward = await post({ records: [record()], forward: { date: "not-a-date", net_fwd: 1 } });
  assert.equal(badForward.statusCode, 400);

  const badEm = await post({ records: [record()], em: { "6mo": { peers: [{ code: "BRL" }] } } });
  assert.equal(badEm.statusCode, 400);

  const oversize = await post({ records: [record()], pad: "x".repeat(1100 * 1024) });
  assert.equal(oversize.statusCode, 413);
  assert.equal(saved, null);
});

test("GET on an empty store reports no records rather than failing", async () => {
  saved = null;
  const res = await get();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).records, null);
});
