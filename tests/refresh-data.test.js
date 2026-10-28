// tests/refresh-data.test.js - regression tests for the weekly refresh.
//
//   npm test          (node --test, no dependencies)
//
// The refresh is the one thing in this repo that writes to main unattended: the
// weekly workflow regenerates the committed data files, and the commit deploys.
// These tests pin the rules that keep that safe, with no network anywhere:
//
//   - the commit decision (a quiet run must commit nothing - including a run that
//     only re-stamped a scrape timestamp, which would otherwise deploy every
//     Friday for no reason);
//   - a read that FAILED must never be read as "the repo has no such file", or
//     fetch-all would refetch 40 weeks and clobber the file it could not read;
//   - what a commit carries and what it says;
//   - the history merges the refactor moved, because they are where a careless
//     edit would silently drop data (a DII-only row erasing the FII split).
//
// The driver takes its io and its steps through parameters, so these tests
// exercise the real driver and the real merge functions against a fake io.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { runRefresh, commitMessage, comparable, STEPS } = require("../netlify/functions/refresh-data.js");
const { mergeFiiHistory } = require("../scripts/snapshot-fii-dii.js");
const { mergeSentimentHistory } = require("../scripts/snapshot-sentiment.js");
const { buildFeed } = require("../scripts/make-rss.js");
const { buildRbiDataFile } = require("../scripts/fetch-all.js");

const RBI = "public/rbi-data.json";

/** An io over an in-memory repo: records commits instead of pushing them. */
function fakeIo(initial = {}, { unreadable = [] } = {}) {
  const repo = { ...initial };
  const commits = [];
  return {
    repo,
    commits,
    async read(path) {
      if (unreadable.includes(path)) return { ok: false, text: null, error: "HTTP 500 - upstream is having a day" };
      return { ok: true, text: path in repo ? repo[path] : null };
    },
    async commit({ files, message }) {
      commits.push({ files, message });
      for (const f of files) repo[f.path] = f.content;
      return { ok: true, commit: "c".repeat(40), files: files.length };
    },
  };
}

const step = (id, path, run) => ({ id, path, label: id, run });

test("a run that finds nothing new commits nothing", async () => {
  const io = fakeIo({ [RBI]: '{"fetched_at":"2026-10-01T00:00:00.000Z","records":[1]}' });
  const summary = await runRefresh({
    io,
    steps: [step("rbi-data", RBI, async ({ priorText }) => ({ text: priorText, detail: "1 week" }))],
  });
  assert.equal(summary.ok, true);
  assert.equal(io.commits.length, 0);
  assert.equal(summary.steps[0].status, "unchanged");
  assert.equal(summary.message, null);
});

test("a scrape timestamp is not content: re-stamping fetched_at does not commit", async () => {
  const before = '{"fetched_at":"2026-10-01T00:00:00.000Z","records":[1]}';
  const after = '{"fetched_at":"2026-10-09T11:00:00.000Z","records":[1]}';
  const io = fakeIo({ [RBI]: before });
  const summary = await runRefresh({ io, steps: [step("rbi-data", RBI, async () => ({ text: after, detail: "1 week" }))] });
  assert.equal(summary.steps[0].status, "unchanged");
  assert.equal(io.commits.length, 0);

  // …and the same for the histories' updated_at.
  assert.equal(comparable('{"updated_at":"a","series":[1]}'), comparable('{"updated_at":"b","series":[1]}'));
  assert.notEqual(comparable('{"records":[1]}'), comparable('{"records":[2]}'));
});

test("every changed file lands in one commit, and a failed step does not stop it", async () => {
  const io = fakeIo({ [RBI]: "old", "public/external-debt.json": "old" });
  const summary = await runRefresh({
    io,
    steps: [
      step("rbi-data", RBI, async () => ({ text: "new", detail: "41 weeks" })),
      step("sentiment", "public/sentiment-history.json", async () => { throw new Error("Yahoo is down"); }),
      step("debt", "public/external-debt.json", async () => ({ text: "newer", detail: "12 lenders" })),
    ],
  });
  assert.equal(io.commits.length, 1, "two changed files, one commit");
  assert.deepEqual(io.commits[0].files.map(f => f.path).sort(), ["public/external-debt.json", RBI]);
  assert.equal(summary.steps.map(s => s.status).join(","), "updated,failed,updated");
  assert.equal(summary.ok, false, "a failed step is reported even though the commit succeeded");
  assert.deepEqual(summary.failed, ["sentiment: Yahoo is down"]);
  assert.match(io.commits[0].message, /^chore\(data\): weekly refresh - rbi-data\.json, external-debt\.json\n/);
  assert.match(io.commits[0].message, /- public\/rbi-data\.json: 41 weeks/);
});

test("a read that failed skips the step instead of emptying its file", async () => {
  const io = fakeIo({ [RBI]: "the committed 40 weeks" }, { unreadable: [RBI] });
  let ran = false;
  const summary = await runRefresh({
    io,
    steps: [step("rbi-data", RBI, async () => { ran = true; return { text: "should never be built", detail: "" }; })],
  });
  assert.equal(ran, false, "a step whose baseline is unreadable must not run");
  assert.equal(summary.steps[0].status, "skipped");
  assert.match(summary.steps[0].detail, /could not read public\/rbi-data\.json/);
  assert.equal(io.commits.length, 0);
  assert.equal(io.repo[RBI], "the committed 40 weeks", "the file it could not read is left alone");
});

test("a missing file is a null baseline, not an error, and steps on one path see each other", async () => {
  const io = fakeIo({ "netlify/functions/fx.js": "const FWD_SERIES = [a];" });
  let saw = null;
  const summary = await runRefresh({
    io,
    steps: [
      step("first", "netlify/functions/fx.js", async ({ priorText }) => ({ text: priorText + " // half-yearly", detail: "anchor" })),
      step("second", "netlify/functions/fx.js", async ({ priorText }) => {
        saw = priorText;
        return { text: priorText + " // bulletin", detail: "table 4A" };
      }),
      step("brand-new", "public/feed.xml", async ({ priorText }) => {
        assert.equal(priorText, null, "no committed file reads as an empty baseline");
        return { text: "<rss/>", detail: "1 item" };
      }),
    ],
  });
  assert.equal(saw, "const FWD_SERIES = [a]; // half-yearly", "the second editor of a path sees the first's output");
  assert.equal(io.commits.length, 1);
  assert.deepEqual(io.commits[0].files.map(f => f.path).sort(), ["netlify/functions/fx.js", "public/feed.xml"]);
  const fx = io.commits[0].files.find(f => f.path === "netlify/functions/fx.js");
  assert.equal(fx.content, "const FWD_SERIES = [a]; // half-yearly // bulletin", "both edits are in the one commit");
  assert.equal(summary.ok, true);
});

test("a failed commit is reported as such", async () => {
  const io = fakeIo({ [RBI]: "old" });
  io.commit = async () => ({ ok: false, error: "ref: HTTP 422 - Update is not a fast forward" });
  const summary = await runRefresh({ io, steps: [step("rbi-data", RBI, async () => ({ text: "new", detail: "" }))] });
  assert.equal(summary.ok, false);
  assert.match(summary.commitError, /not a fast forward/);
});

test("commitMessage names the files and lists what each step did", () => {
  const msg = commitMessage(
    [{ path: "public/rbi-data.json" }, { path: "netlify/functions/fetch-fx-intervention.js" }],
    [{ status: "updated", path: "public/rbi-data.json", detail: "41 weeks · 1 new" }, { status: "unchanged", path: "public/feed.xml", detail: "" }],
  );
  assert.match(msg, /^chore\(data\): weekly refresh - rbi-data\.json, fetch-fx-intervention\.js$/m);
  assert.match(msg, /^- public\/rbi-data\.json: 41 weeks · 1 new$/m);
  assert.ok(!msg.includes("public/feed.xml"), "unchanged files stay out of the body");
});

// ── The crawlable snapshot ──────────────────────────────────────────────────
// The static HTML a crawler sees (head meta, the hidden #snapshot-metrics block,
// the Dataset JSON-LD) is baked from rbi-data.json. These pin the two ways that
// used to fall out of sync: the builder stripping the metadata the snapshot reads,
// and the snapshot itself not being rebuilt by the plan.
test("an unchanged RBI run keeps the SEO metadata instead of stripping it", async () => {
  const prior = JSON.stringify({
    fetched_at: "2026-10-17T00:00:00.000Z",
    data_updated_at: "2026-10-17T00:00:00.000Z",
    date_modified: "2026-10-17",
    temporal_coverage: "2099-12-31/2099-12-31",
    source: "RBI Weekly Statistical Supplement (Excel) + Yahoo Finance",
    generated_by: "scripts/fetch-all.js",
    count: 1,
    records: [{ date: "2099-12-31", total_usd: 1 }],
  }, null, 2);
  const built = await buildRbiDataFile({ priorText: prior, limit: 8, log: () => {} });
  const doc = JSON.parse(built.text);
  assert.equal(built.fresh, 0, "a future-dated record leaves nothing to fetch");
  assert.equal(doc.data_updated_at, "2026-10-17T00:00:00.000Z", "the update stamp survives a quiet run");
  assert.equal(doc.date_modified, "2026-10-17");
  assert.equal(doc.temporal_coverage, "2099-12-31/2099-12-31");
  assert.equal(comparable(built.text), comparable(prior), "only fetched_at moves, so nothing would commit");
});

test("the refresh rebuilds the crawlable snapshot from the run's own records", () => {
  const template = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "public", "rbi-data.json"), "utf8"));
  data.date_modified = "2027-01-01";
  data.temporal_coverage = "2025-12-26/2027-01-01";
  data.records.push({ date: "2027-01-01", total_usd: 900000, gold_usd: 120000, usd_inr: 99.5, nifty: 25000, sensex: 80000 });

  const seo = STEPS.find(s => s.id === "seo");
  assert.ok(seo, "public/index.html is part of the plan");
  const out = seo.run({ priorText: template, texts: new Map([[RBI, JSON.stringify(data)]]), options: {}, log: () => {} });

  assert.match(out.text, /<time id="snapshot-observation">1 January 2027<\/time>/);
  assert.match(out.text, /<div class="mc-val" id="m-res-usd">9,00,000<\/div>/);
  const schema = JSON.parse(out.text.match(/<script type="application\/ld\+json" id="seo-dataset-schema">([\s\S]*?)<\/script>/)[1]);
  const dataset = schema["@graph"].find(n => n["@type"] === "Dataset");
  assert.equal(dataset.dateModified, "2027-01-01");
  assert.equal(dataset.temporalCoverage, "2025-12-26/2027-01-01");
});

// ── The merges the refactor moved ───────────────────────────────────────────
test("a DII-only row never erases the FII split stored for that date", () => {
  const prev = JSON.stringify({
    updated_at: "2026-10-01T00:00:00.000Z",
    source: "NSDL + NSE",
    series: [{ date: "2026-10-01", fii_equity_cr: -9231.88, fii_debt_cr: -199.02, dii_equity_cr: 100 }],
  });
  const merged = mergeFiiHistory(prev, {
    source: "NSDL + NSE",
    series: [{ date: "2026-10-01", dii_equity_cr: 112.5 }, { date: "2026-10-02", dii_equity_cr: 55 }],
  });
  const rows = JSON.parse(merged.text).series;
  assert.equal(merged.changed, true);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].fii_equity_cr, -9231.88, "the split survived the DII-only overlay");
  assert.equal(rows[0].dii_equity_cr, 112.5, "and the newer DII figure won");
  assert.equal(rows[1].date, "2026-10-02");
});

test("a FII/DII merge that changes nothing hands the file back untouched", () => {
  const prev = JSON.stringify({
    updated_at: "2026-10-01T00:00:00.000Z",
    source: "NSDL + NSE",
    series: [{ date: "2026-10-01", fii_equity_cr: -1, dii_equity_cr: 2 }],
  });
  const merged = mergeFiiHistory(prev, { source: "NSDL + NSE", series: [{ date: "2026-10-01", dii_equity_cr: 2 }] });
  assert.equal(merged.changed, false);
  assert.equal(merged.text, prev, "no timestamp-only diff for a later run the same day");
});

test("today's sentiment reading is replaced in place, and an unchanged rerun is a no-op", () => {
  const today = new Date().toISOString().slice(0, 10);
  const prev = JSON.stringify({ updated_at: "2026-01-01T00:00:00.000Z", source: "Yahoo", points: [{ date: today, score: 23, label: "Extreme fear" }] });
  const repainted = mergeSentimentHistory(prev, { score: 41, label: "Fear", source: "Yahoo" });
  assert.equal(repainted.changed, true);
  assert.deepEqual(JSON.parse(repainted.text).points, [{ date: today, score: 41, label: "Fear" }], "one row for the day, not two");

  const same = mergeSentimentHistory(repainted.text, { score: 41, label: "Fear", source: "Yahoo" });
  assert.equal(same.changed, false);
  assert.equal(same.text, repainted.text);
});

// ── The feed ────────────────────────────────────────────────────────────────
test("the feed is a function of its records, so an unchanged week cannot churn it", () => {
  const records = [
    { date: "2026-09-25", total_usd: 700000, gold_usd: 100000, usd_inr: 91.2 },
    { date: "2026-10-02", total_usd: 705000, gold_usd: 101000, usd_inr: 91.5 },
  ];
  const a = buildFeed(records, { siteUrl: "https://example.test/" });
  const b = buildFeed(records.map(r => ({ ...r })), { siteUrl: "https://example.test/" });
  assert.equal(a.text, b.text);
  assert.match(a.text, new RegExp(`<lastBuildDate>${new Date(Date.UTC(2026, 9, 9, 6, 0, 0)).toUTCString()}<`), "lastBuildDate is the newest item's pubDate, not the clock");
  assert.equal(a.newest, "2026-10-02");
  assert.match(a.text, /Reserves rose/);
  assert.throws(() => buildFeed([]), /no records/);
});
