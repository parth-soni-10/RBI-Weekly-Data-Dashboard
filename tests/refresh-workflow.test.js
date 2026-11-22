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

test("the weekly run builds the dated week pages, and stages the new ones", () => {
  assert.match(workflow, /node scripts\/make-week-pages\.js/);
  const build = workflow.indexOf("node scripts/make-week-pages.js");
  const refresh = workflow.indexOf("node scripts/refresh-static.js");
  const commit = workflow.indexOf("git add -u");
  const add = workflow.indexOf("git add public/forex-reserves");
  assert.ok(refresh < build, "the pages are built from the data this run wrote");
  assert.ok(build < commit, "and before the commit that ships them");
  assert.ok(add > commit, "`-u` stages only tracked files, so a new week page needs its own add");
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

// A minimal real xlsx (node-xlsx round-trips it) whose first row carries a
// "Total Reserves" label followed by INR cr then US$ mn numerics, so
// parseReservesExcel can extract total_usd.
const XLSX = require("node-xlsx");
const XLSX_BUFFER = XLSX.build([{ name: "Sheet1", data: [["Total Reserves", 734606, 726027]] }]);

test("download retries against repeated F5 challenges before giving up", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  let calls = 0;
  const out = await withStubbedFetch(
    async (url) => {
      calls++;
      if (String(url).includes("WSSViewDetail")) {
        return new Response(PAGE_WITH_LINKS, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      // F5 challenges 4 times, then serves the real spreadsheet on the 5th try.
      if (calls < 6) {
        return new Response("<!DOCTYPE html><title>F5 bot check</title>", {
          status: 200,
          headers: { "Content-Type": "text/html" },
        });
      }
      return new Response(XLSX_BUFFER, { status: 200, headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" } });
    },
    () => fetchData._processOne(new Date("2026-10-23T00:00:00Z")),
  );
  assert.equal(out.code, undefined, "no error code on success");
  assert.equal(out.iso, "2026-10-16");
  assert.ok(out.record, "parsed a record after retries");
  assert.equal(out.record.total_usd, 726027, "parsed total_usd from the retried spreadsheet");
  assert.ok(calls >= 6, "at least one page fetch + 5 download attempts (plus Yahoo quote fetches)");
});

test("download gives up after MAX_ATTEMPTS challenges instead of retrying forever", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  let calls = 0;
  const out = await withStubbedFetch(
    async (url) => {
      calls++;
      if (String(url).includes("WSSViewDetail")) {
        return new Response(PAGE_WITH_LINKS, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      // Always challenges - never serves the spreadsheet.
      calls++;
      return new Response("<!DOCTYPE html><title>F5 bot check</title>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    },
    () => fetchData._processOne(new Date("2026-10-23T00:00:00Z")),
  );
  assert.equal(out.code, "download_blocked", "stable code after exhausting retries");
  assert.match(out.error, /challenge/i);  // page fetch (1) + MAX_ATTEMPTS download attempts (5), each Excel attempt
  // double-increments calls, + the archive form lookup that follows when
  // neither the detail page nor the file yields a usable issue (this stub
  // counts every non-detail fetch twice as well). No POST: a challenge page
  // has no __VIEWSTATE, so the archive is not replayed against it.
  assert.equal(calls, 1 + 5 * 2 + 2, "attempted the download MAX_ATTEMPTS times then stopped");
});

// ── The HTML view: the same issue, from the host the edge CAN reach ─────────
// RBI publishes each WSS issue twice - the .XLSX on rbidocs (refused outright
// to Cloudflare's egress) and the same table as HTML on www.rbi.org.in. When
// the download is blocked the live check reads the HTML table instead, so a
// Reload can still merge the week RBI published. These are the real figures
// from the issue published 20 Nov 2026 (as on 13 Nov 2026).
const WSS_HTML_VIEW = `<html><body><table>
  <tr><td colspan="2"><span class="head">As on November 13, 2026</span></td></tr>
  <tr><td>1 Total Reserves</td><td align="right">6647812</td><td align="right">705342</td><td align="right">-111173</td><td align="right">-14205</td></tr>
  <tr><td>1.1 Foreign Currency Assets #</td><td align="right">5499031</td><td align="right">583452</td><td align="right">-55669</td><td align="right">-7897</td></tr>
  <tr><td>1.2 Gold</td><td align="right">929430</td><td align="right">98613</td><td align="right">-54947</td><td align="right">-6183</td></tr>
  <tr><td>1.3 SDRs</td><td align="right">174527</td><td align="right">18517</td><td align="right">-281</td><td align="right">-92</td></tr>
  <tr><td>1.4 Reserve Position in the IMF</td><td align="right">44824</td><td align="right">4758</td><td align="right">-277</td><td align="right">-32</td></tr>
</table></body></html>`;

// The date listing RBI renders beside every issue: the HTML view's id and the
// spreadsheet link travel together in the same row.
const PAGE_WITH_HTML_VIEW = `<html><body><table>
  <tr><th colspan="4" align="left">20 Nov 2026</th></tr>
  <tr><td><a class='link2' href=WSSView.aspx?Id=28849>Foreign Exchange Reserves</a></td>
      <td><a href="https://rbidocs.rbi.org.in/rdocs/Wss/DOCs/2T_201120267605AEDD664A485885A51B04C5FB854B.XLSX">XLSX</a></td></tr>
</table></body></html>`;

test("the HTML view of an issue parses into the same fields as the Excel", () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  const parsed = fetchData._parseWssHtml(WSS_HTML_VIEW);
  assert.equal(parsed.as_on, "2026-11-13", "the page's own as-on line, as ISO");
  assert.equal(parsed.total_inr, 6647812);
  assert.equal(parsed.total_usd, 705342);
  assert.equal(parsed.fca_usd, 583452);
  assert.equal(parsed.gold_usd, 98613);
  assert.equal(parsed.sdr_usd, 18517);
  assert.equal(parsed.imf_reserve_usd, 4758);
});

test("an unreachable file host falls back to the HTML view and still merges the week", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  const out = await withStubbedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("WSSViewDetail")) return new Response(PAGE_WITH_HTML_VIEW, { status: 200, headers: { "Content-Type": "text/html" } });
      if (u.includes("WSSView.aspx?Id=28849")) return new Response(WSS_HTML_VIEW, { status: 200, headers: { "Content-Type": "text/html" } });
      if (u.includes("rbidocs")) throw new Error("fetch failed"); // the CDN refuses this network
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }); // Yahoo
    },
    () => fetchData._processOne(new Date("2026-11-20T00:00:00Z")),
  );
  assert.equal(out.code, undefined, "the refusal is no longer the end of the week");
  assert.equal(out.iso, "2026-11-13");
  assert.equal(out.via, "html");
  assert.equal(out.record.date, "2026-11-13");
  assert.equal(out.record.total_usd, 705342);
  assert.equal(out.record.gold_usd, 98613);
});

test("an HTML view for a different week is refused, never merged", async () => {
  const fetchData = require("../netlify/functions/fetch-data.js");
  const out = await withStubbedFetch(
    async (url) => {
      const u = String(url);
      if (u.includes("WSSViewDetail")) return new Response(PAGE_WITH_HTML_VIEW, { status: 200, headers: { "Content-Type": "text/html" } });
      if (u.includes("WSSView.aspx?Id=28849")) {
        const wrongWeek = WSS_HTML_VIEW.replace("November 13, 2026", "November 6, 2026");
        return new Response(wrongWeek, { status: 200, headers: { "Content-Type": "text/html" } });
      }
      if (u.includes("rbidocs")) throw new Error("fetch failed");
      return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
    },
    () => fetchData._processOne(new Date("2026-11-20T00:00:00Z")),
  );
  assert.equal(out.code, "source_unreachable", "the honest failure stands rather than a wrong week slipping in");
  assert.equal(out.record, undefined);
});

// ── The guards that make a silent breakage loud ─────────────────────────────
// A failing scrape used to surface only as "the numbers look a week old":
// nothing failed, so nothing told anyone. The weekly run now asks both
// questions after it commits - is the snapshot recent, and can the DEPLOYED
// live check still produce a week from the edge.
const guards = require("../scripts/verify-live.js");

test("the weekly run guards freshness and the live check after committing", () => {
  assert.match(workflow, /node scripts\/verify-live\.js/);
  const commit = workflow.indexOf("git add -u");
  const guard = workflow.indexOf("node scripts/verify-live.js");
  assert.ok(commit !== -1 && guard > commit, "the guards run after the data commit, so what did change still ships");
});

test("freshness: a healthy run leaves the newest week ~7 days old, a missed one 14", () => {
  const now = new Date("2026-11-20T22:30:00Z");
  assert.equal(guards.MAX_AGE_DAYS, 9);
  assert.equal(guards.ageDays("2026-11-13", now), 7, "the WSS published tonight is as on last Friday");
  assert.equal(guards.ageDays("2026-11-06", now), 14, "a week of failed scrapes");
});

test("the live smoke check accepts only healthy answers", () => {
  assert.equal(guards.judgeLive(200, { record: { date: "2026-11-13" }, via: "html" }).ok, true);
  assert.equal(guards.judgeLive(404, { done: true }).ok, true);
  assert.equal(guards.judgeLive(200, { errorCode: "not_published" }).ok, true, "a late RBI week is not a broken path");
  const broken = guards.judgeLive(200, { errorCode: "source_unreachable", error: "unreachable", hint: "x" });
  assert.equal(broken.ok, false);
  assert.match(broken.message, /source_unreachable/);
  assert.equal(guards.judgeLive(502, null).ok, false);
});

test("the smoke check anchors on the publication Friday of the newest committed week", () => {
  assert.equal(guards.publicationOf("2026-11-13"), "2026-11-20");
  assert.equal(
    guards.newestWeek({ records: [{ date: "2026-11-06" }, { date: "2026-11-13" }, { date: "not-a-date" }] }),
    "2026-11-13",
  );
});
