// tests/refresh-data.test.js — regression tests for the weekly refresh.
//
//   npm test          (node --test, no dependencies)
//
// The refresh is the one thing in this repo that writes to main unattended: a
// cron Worker regenerates the committed data files and commits them through the
// GitHub API, and the commit deploys. These tests pin the rules that keep that
// safe, with no network anywhere:
//
//   - the commit decision (a quiet run must commit nothing — including a run that
//     only re-stamped a scrape timestamp, which would otherwise deploy every
//     Friday for no reason);
//   - a read that FAILED must never be read as "the repo has no such file", or
//     fetch-all would refetch 40 weeks and clobber the file it could not read;
//   - the GitHub write sequence: one commit for every changed file, a fast-forward
//     ref update, and one retry when the branch moved under us;
//   - the history merges the refactor moved, because they are where a careless
//     edit would silently drop data (a DII-only row erasing the FII split).
//
// The driver takes its io and its steps through parameters — the same seam the
// scheduled Worker passes a GitHub-backed io through — so these tests exercise the
// real driver, the real GitHub client and the real merge functions.
const test = require("node:test");
const assert = require("node:assert/strict");

const { runRefresh, commitMessage, comparable } = require("../netlify/functions/refresh-data.js");
const { makeGitHubIo, encode, decode } = require("../netlify/functions/_utils/github.js");
const { mergeFiiHistory } = require("../scripts/snapshot-fii-dii.js");
const { mergeSentimentHistory } = require("../scripts/snapshot-sentiment.js");
const { buildFeed } = require("../scripts/make-rss.js");

const RBI = "public/rbi-data.json";

/** An io over an in-memory repo: records commits instead of pushing them. */
function fakeIo(initial = {}, { unreadable = [] } = {}) {
  const repo = { ...initial };
  const commits = [];
  return {
    repo,
    commits,
    async read(path) {
      if (unreadable.includes(path)) return { ok: false, text: null, error: "HTTP 500 — upstream is having a day" };
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
  assert.match(io.commits[0].message, /^chore\(data\): weekly refresh — rbi-data\.json, external-debt\.json\n/);
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
  io.commit = async () => ({ ok: false, error: "ref: HTTP 422 — Update is not a fast forward" });
  const summary = await runRefresh({ io, steps: [step("rbi-data", RBI, async () => ({ text: "new", detail: "" }))] });
  assert.equal(summary.ok, false);
  assert.match(summary.commitError, /not a fast forward/);
});

test("commitMessage names the files and lists what each step did", () => {
  const msg = commitMessage(
    [{ path: "public/rbi-data.json" }, { path: "netlify/functions/fetch-fx-intervention.js" }],
    [{ status: "updated", path: "public/rbi-data.json", detail: "41 weeks · 1 new" }, { status: "unchanged", path: "public/feed.xml", detail: "" }],
  );
  assert.match(msg, /^chore\(data\): weekly refresh — rbi-data\.json, fetch-fx-intervention\.js$/m);
  assert.match(msg, /^- public\/rbi-data\.json: 41 weeks · 1 new$/m);
  assert.ok(!msg.includes("public/feed.xml"), "unchanged files stay out of the body");
});

// ── The GitHub client ───────────────────────────────────────────────────────
// A recording stub for the REST API, so the write sequence can be checked
// without a token, a repo, or a network.
function ghStub({ onRef, blobs = {}, refStatus = 200 } = {}) {
  const calls = [];
  let headCommit = 0;
  const impl = async (url, init) => {
    const method = init.method;
    const path = url.replace("https://api.github.com", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body, headers: init.headers });
    const reply = (status, json) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json || {}) });

    if (path.startsWith("/repos/x/y/contents/public/rbi-data.json")) {
      return reply(200, { content: encode('{"records":[1]}'), sha: "blob-sha-1" });
    }
    if (path.includes("/contents/")) return reply(404, { message: "Not Found" });
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) return reply(200, { object: { sha: "head-1" } });
    if (method === "GET" && path.includes("/git/commits/")) return reply(200, { tree: { sha: "base-tree" } });
    if (method === "POST" && path.endsWith("/git/blobs")) return reply(201, { sha: blobs[body.content] || `blob-${calls.length}` });
    if (method === "POST" && path.endsWith("/git/trees")) {
      assert.equal(body.base_tree, "base-tree");
      return reply(201, { sha: "new-tree" });
    }
    if (method === "POST" && path.endsWith("/git/commits")) {
      headCommit++;
      return reply(201, { sha: `commit-${headCommit}`, html_url: `https://github.com/x/y/commit/commit-${headCommit}` });
    }
    if (method === "PATCH" && path.endsWith("/git/refs/heads/main")) {
      const status = onRef ? onRef(calls) : refStatus;
      return status === 200
        ? reply(200, { object: { sha: body.sha } })
        : reply(status, { message: "Update is not a fast forward" });
    }
    return reply(500, { message: `unexpected ${method} ${path}` });
  };
  return { impl, calls };
}

test("reads a committed file, and treats a 404 as 'no such file yet'", async () => {
  const gh = ghStub();
  const io = makeGitHubIo({ token: "t", repo: "x/y", fetchImpl: gh.impl });
  const found = await io.read("public/rbi-data.json");
  assert.equal(found.ok, true);
  assert.equal(found.text, '{"records":[1]}');
  assert.equal(found.sha, "blob-sha-1");

  const missing = await io.read("public/never-committed.json");
  assert.deepEqual({ ok: missing.ok, text: missing.text }, { ok: true, text: null });
});

test("a failing read is an error, never an absent file", async () => {
  const io = makeGitHubIo({ token: "t", repo: "x/y", fetchImpl: async () => ({ ok: false, status: 500, text: async () => "upstream" }) });
  const res = await io.read("public/rbi-data.json");
  assert.equal(res.ok, false);
  assert.match(res.error, /HTTP 500/);
  assert.equal(res.text, null);
});

test("commits every file in one commit and fast-forwards the branch", async () => {
  const gh = ghStub();
  const io = makeGitHubIo({ token: "t", repo: "x/y", fetchImpl: gh.impl });
  const res = await io.commit({
    files: [{ path: "public/rbi-data.json", content: "one" }, { path: "public/feed.xml", content: "two" }],
    message: "chore(data): weekly refresh",
  });
  assert.equal(res.ok, true);
  assert.equal(res.commit, "commit-1");
  assert.equal(res.attempts, 1);

  const posted = gh.calls.filter(c => c.method === "POST" && c.path.endsWith("/git/commits"));
  assert.equal(posted.length, 1, "one commit for two files");
  assert.deepEqual(posted[0].body.parents, ["head-1"], "the commit is built on the branch head");
  assert.equal(posted[0].body.message, "chore(data): weekly refresh");

  const tree = gh.calls.find(c => c.path.endsWith("/git/trees"));
  assert.deepEqual(tree.body.tree.map(t => [t.path, t.mode, t.type]), [
    ["public/rbi-data.json", "100644", "blob"],
    ["public/feed.xml", "100644", "blob"],
  ]);

  const ref = gh.calls.find(c => c.method === "PATCH");
  assert.equal(ref.path, "/repos/x/y/git/refs/heads/main");
  assert.equal(ref.body.force, false, "a refresh never rewrites history");
  assert.equal(ref.body.sha, "commit-1");
});

test("a ref race is retried once against the new head", async () => {
  let refCalls = 0;
  const gh = ghStub({ onRef: () => (++refCalls === 1 ? 422 : 200) });
  const io = makeGitHubIo({ token: "t", repo: "x/y", fetchImpl: gh.impl });
  const res = await io.commit({ files: [{ path: "public/rbi-data.json", content: "x" }], message: "m" });
  assert.equal(res.ok, true, "the retry is what turns a lost race into a landed commit");
  assert.equal(res.attempts, 2);
  assert.equal(gh.calls.filter(c => c.method === "PATCH").length, 2);
});

test("a rejected credential is not retried, and no commit is attempted", async () => {
  const gh = ghStub();
  const io = makeGitHubIo({
    token: "t",
    repo: "x/y",
    fetchImpl: async (url, init) => (init.method === "POST" && url.endsWith("/git/blobs")
      ? { ok: false, status: 401, text: async () => JSON.stringify({ message: "Bad credentials" }) }
      : gh.impl(url, init)),
  });
  const res = await io.commit({ files: [{ path: "public/rbi-data.json", content: "x" }], message: "m" });
  assert.equal(res.ok, false);
  assert.match(res.error, /Bad credentials/);
  assert.equal(res.attempts, 1);
  assert.equal(gh.calls.filter(c => c.path.endsWith("/git/commits")).length, 0);
});

test("base64 round-trips the characters these files actually carry", () => {
  const text = '{"note":"₹1,234 cr — FII/DII, Δ 8.2%","date":"2026-10-09"}';
  assert.equal(decode(encode(text)), text);
  assert.equal(decode("  " + encode(text) + "  "), text, "the Contents API wraps base64 in whitespace");
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
