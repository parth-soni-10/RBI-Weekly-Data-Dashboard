// tests/refresh-workflow.test.js - the two halves of "the data stays current".
//
//   1. The weekly GitHub Actions workflow. It is the ONLY thing that can fetch
//      RBI's WSS Excel (the site runs on Cloudflare Pages, whose egress RBI's
//      document CDN refuses), so when the workflow is broken the committed
//      snapshot goes stale and every visitor's live check fails with "reserves
//      Excel download failed". These pins cover the mistakes that actually
//      broke it: a cron that fired on the wrong day, a missing `npm ci`
//      (node-xlsx is a dependency - the refresh cannot even start without it),
//      a missing `permissions: contents: write` (the bot's token cannot push),
//      and a `git add` of a path that does not exist (the commit stages
//      nothing, so the run reports success and ships the same stale data).
//
//   2. The live check's error codes. The dashboard's Reload asks the deployed
//      function for weeks newer than the committed snapshot; what the function
//      answers must distinguish "RBI has not published this week yet" and
//      "this edge cannot reach RBI's file host" from a real failure, because
//      the first two are normal states that the user cannot fix by retrying.
//      No network: global fetch is stubbed.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const WORKFLOW = path.join(ROOT, ".github", "workflows", "refresh-data.yml");

const workflow = fs.readFileSync(WORKFLOW, "utf8");

test("the weekly refresh runs on Friday 22:00 UTC, not on a day RBI has not published yet", () => {
  assert.match(workflow, /cron:\s*["']0 22 \* \* 5["']/, "Friday 22:00 UTC (Saturday 03:30 IST)");
});

test("the workflow can push its data commit", () => {
  assert.match(workflow, /permissions:\s*\n\s+contents:\s*write/);
  assert.match(workflow, /git push/);
});

test("dependencies are installed before the refresh runs", () => {
  const install = workflow.indexOf("npm ci");
  const refresh = workflow.indexOf("node scripts/refresh-static.js");
  assert.ok(install !== -1, "npm ci is present");
  assert.ok(refresh !== -1, "the refresh plan is present");
  assert.ok(install < refresh, "npm ci comes before the refresh (node-xlsx is needed to parse the Excel)");
});

test("the commit stages the files the plan writes", () => {
  assert.match(workflow, /git add -u/, "every tracked file the run modified is staged");
  assert.ok(!workflow.includes("public/data/"), "no path that does not exist in this repo");
});

test("the workflow carries the decomposition backfill as its own step", () => {
  assert.match(workflow, /node scripts\/backfill-decomp\.js/);
});

// ── The live check's error codes ───────────────────────────────────────────
const PAGE_WITH_LINKS = `<html><body><table>
  <tr><td>Foreign Exchange Reserves</td><td><a href="https://rbidocs.rbi.org.in/rdocs/Wss/DOCs/WSS23102026_X.XLSX">XLSX</a></td></tr>
</table></body></html>`;
const PAGE_WITHOUT_LINKS = `<html><body><table><tr><td>Some other table</td></tr></table></body></html>`;

async function withStubbedFetch(stub, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("a week RBI has not published yet is reported as such, not as a failure", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  const out = await withStubbedFetch(
    async () => new Response(PAGE_WITHOUT_LINKS, { status: 200, headers: { "Content-Type": "text/html" } }),
    () => fetchData._processOne(new Date("2026-10-23T00:00:00Z")),
  );
  assert.equal(out.iso, "2026-10-16", "the publication Friday's as-on week");
  assert.equal(out.code, "not_published");
  assert.equal(out.record, undefined);
});

test("an edge that cannot reach RBI's file host says so, with a stable code", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  const out = await withStubbedFetch(
    async (url) => {
      if (String(url).includes("WSSViewDetail")) {
        return new Response(PAGE_WITH_LINKS, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      throw new Error("fetch failed"); // the CDN refuses this network outright
    },
    () => fetchData._processOne(new Date("2026-10-23T00:00:00Z")),
  );
  assert.equal(out.code, "source_unreachable");
  assert.match(out.error, /unreachable/i);
  assert.ok(out.hint, "the response carries a hint the dashboard can show");
});

test("the handler ships the error code on the wire", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  const res = await withStubbedFetch(
    async (url) => {
      if (String(url).includes("WSSViewDetail")) {
        return new Response(PAGE_WITHOUT_LINKS, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      throw new Error("fetch failed");
    },
    () => fetchData.handler({ queryStringParameters: { after: "2026-10-01", weekOffset: "0" } }),
  );
  assert.equal(res.statusCode, 200, "scrapers never throw to the client");
  const body = JSON.parse(res.body);
  assert.equal(body.errorCode, "not_published");
  assert.equal(body.record, null);
});
