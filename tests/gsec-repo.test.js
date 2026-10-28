// tests/gsec-repo.test.js - regression tests for the live repo-rate check.
//
//   npm test          (node --test, no dependencies)
//
// fetch-gsec used to answer the repo rate from a curated table alone, so a
// decided-but-unrecorded MPC meeting froze the site on a stale rate no matter
// how often the page refreshed (Oct 7 2026 hiked to 5.50% while the table
// still said 5.25%). These tests pin the two things that keep that fixed -
// the RBI press-release parsing, and the curated table staying current - so a
// future edit cannot quietly reintroduce a refresh-proof rate.
const test = require("node:test");
const assert = require("node:assert/strict");

// The HTTP helper is stubbed before the function is required (same pattern as
// data-sync.test.js stubbing @netlify/blobs): per-test pages make the handler
// tests deterministic with no network. Anything unmapped throws, which is
// exactly the failure mode every live source already handles.
const httpPath = require.resolve("../netlify/functions/_utils/http.js");
// NOTE: fetch-gsec destructures { get } at require time, so this stub function
// itself is never reassigned afterwards - per-test pages go through the
// mutable `servedPages` binding it closes over. Reassigning stub.get per test
// would leave the function holding the original throwing reference.
let servedPages = {};
const httpStub = { get: async (url) => {
  if (Object.hasOwn(servedPages, url)) { const body = servedPages[url]; return { text: async () => body }; }
  for (const key of Object.keys(servedPages)) {
    if (url.includes(key)) { const body = servedPages[key]; return { text: async () => body }; }
  }
  throw new Error("stub: no page for " + url);
} };
require.cache[httpPath] = { id: httpPath, filename: httpPath, loaded: true, exports: httpStub };
function serveHttp(pages) {
// Exact URL first, substring after: the release URL also contains the listing
// path, so a pure substring match would serve the listing twice.
  servedPages = pages;
}

const gsec = require("../netlify/functions/fetch-gsec.js");
const { mpcRangeEndIso, parseRepoDecision, REPO_HISTORY, MPC_SCHEDULE } = gsec;

test("meeting range title resolves to the range's last day", () => {
  assert.equal(
    mpcRangeEndIso("Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee October 5 to 7, 2026"),
    "2026-10-07"
  );
  assert.equal(
    mpcRangeEndIso("Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee (MPC) August 4 to 6, 2026"),
    "2026-08-06"
  );
});

test("single-date title resolves to itself", () => {
  assert.equal(mpcRangeEndIso("Statement dated October 7, 2026"), "2026-10-07");
});

test("garbage titles resolve to null, never to a fake date", () => {
  assert.equal(mpcRangeEndIso("Monetary Policy Statement"), null);
  assert.equal(mpcRangeEndIso("Meeting Smarch 40 to 45, 2026"), null);
  assert.equal(mpcRangeEndIso(null), null);
});

test("hike release parses to the new rate", () => {
  const html = "<p>the MPC voted unanimously to increase the policy repo rate " +
    "under the liquidity adjustment facility (LAF) by 25 bps to 5.50 per cent. Consequently&hellip;</p>";
  assert.deepEqual(parseRepoDecision(html), { pct: 5.5, decision: "hike" });
});

test("hold release parses to the unchanged rate", () => {
  const html = "<p>the MPC voted unanimously to keep the policy repo rate under " +
    "the liquidity adjustment facility (LAF) unchanged at 5.25 per cent. Consequently&hellip;</p>";
  assert.deepEqual(parseRepoDecision(html), { pct: 5.25, decision: "hold" });
});

test("cut release parses to the lowered rate", () => {
  const html = "<p>voted to reduce the policy repo rate by 25 basis points to 5.00 per cent.</p>";
  assert.deepEqual(parseRepoDecision(html), { pct: 5.0, decision: "cut" });
});

test("unparseable or absurd pages resolve to null (curated table stands)", () => {
  assert.equal(parseRepoDecision("<p>No decision here.</p>"), null);
  assert.equal(parseRepoDecision(""), null);
  // A rate outside any plausible policy band is a parse of the wrong number.
  assert.equal(parseRepoDecision("<p>voted to increase the repo rate to 95.50 per cent.</p>"), null);
});

test("curated table head is the Oct 7 2026 hike (fallback path is current)", () => {
  assert.deepEqual(REPO_HISTORY[0], { date: "2026-10-07", pct: 5.5, decision: "hike" });
});

test("resolved meetings leave the schedule (no stale hollow markers)", () => {
  assert.ok(!MPC_SCHEDULE.some((s) => s.date <= "2026-10-07"),
    "Oct 5-7 2026 resolved and must not linger in mpc_schedule");
});

test("handler adopts a live decision newer than the curated table", async () => {
  serveHttp({
    "https://m.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx": "<a class=link2 href=BS_PressReleaseDisplay.aspx?prid=99999>" +
      "Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee December 3 to 5, 2026</a>",
    "https://m.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=99999": "<p>the MPC voted to increase the policy repo rate by 25 bps to 5.75 per cent.</p>",
  });
  const res = await gsec.handler();
  assert.equal(res.statusCode, 200);
  const b = JSON.parse(res.body);
  assert.equal(b.repo_rate_pct, 5.75);
  assert.equal(b.repo_rate_date, "2026-12-05");
  assert.deepEqual(b.repo_history[0], { date: "2026-12-05", pct: 5.75, decision: "hike" });
  assert.match(b.repo_source, /prid=99999/);
});

test("handler keeps the curated table when the live check agrees", async () => {
  serveHttp({
    "https://m.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx": "<a class=link2 href=BS_PressReleaseDisplay.aspx?prid=63742>" +
      "Monetary Policy Statement, 2026-27 Resolution of the Monetary Policy Committee October 5 to 7, 2026</a>",
    "https://m.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=63742": "<p>the MPC voted unanimously to increase the policy repo rate " +
      "under the liquidity adjustment facility (LAF) by 25 bps to 5.50 per cent.</p>",
  });
  const res = await gsec.handler();
  const b = JSON.parse(res.body);
  assert.equal(b.repo_rate_pct, 5.5);
  assert.equal(b.repo_rate_date, "2026-10-07");
  assert.match(b.repo_source, /^curated/);
});

test("handler serves the curated table when RBI is unreachable", async () => {
  serveHttp({});
  const res = await gsec.handler();
  const b = JSON.parse(res.body);
  assert.equal(res.statusCode, 200);
  assert.equal(b.repo_rate_pct, 5.5);
  assert.equal(b.repo_rate_date, "2026-10-07");
});
