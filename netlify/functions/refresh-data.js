// refresh-data.js — the weekly data refresh, as one ordered plan.
//
// WHAT THIS REPLACES
//
// Netlify ran its build command on every deploy —
//
//   npm run fetch:data && npm run update:fwd && npm run update:fwd-monthly &&
//   npm run fetch:debt && npm run snapshot:fng && npm run snapshot:fii
//
// — so every deploy regenerated the committed data files and shipped freshly
// scraped numbers whatever the repository held. A Cloudflare deploy has no build
// step: a deploy ships the files as committed, which turned "the data is current"
// into a manual step someone had to remember. This module is that chain, written
// once, and .github/workflows/refresh-data.yml runs it on a schedule: Friday
// 22:00 UTC, regenerate, commit what changed. The commit is what closes the
// loop — the Pages project is connected to this repo, so the push deploys a site
// carrying the new data.
//
// (While the site ran on a Worker this same plan ran from the Worker's cron
// trigger, over the GitHub API, because a Worker has no filesystem. Pages has no
// cron triggers; a runner has both the schedule and the checkout, so the
// API-backed io and the Worker secret it needed are gone.)
//
// THE PLAN
//
//   id            file                                built by
//   rbi-data      public/rbi-data.json                scripts/fetch-all.js
//   feed          public/feed.xml                     scripts/make-rss.js
//   seo           public/index.html                   scripts/inject-snapshot.js
//   fwd-series    netlify/functions/fetch-fx-..js     scripts/update-fwd-series.js
//   fwd-monthly   (the same file, second edit)        scripts/update-fwd-monthly.js
//   debt          public/external-debt.json           scripts/fetch-debt-rankings.js
//   sentiment     public/sentiment-history.json       scripts/snapshot-sentiment.js
//   fii-dii       public/fii-dii-history.json         scripts/snapshot-fii-dii.js
//
// Every step calls the builder that its CLI calls, so `npm run refresh` and the
// scheduled run write the same bytes — the reason those builders were split out
// of the scripts instead of being reimplemented here.
//
// The two forward-book steps edit the same file on purpose: the half-yearly
// anchor and the monthly Bulletin table are different official disclosures, and
// they must be applied in that order, each seeing what the other left.
//
// HOW IT RUNS SOMEWHERE ELSE
//
// The plan is driven through an `io` seam — read(path), commit({ files, message })
// — which is the whole reason it can run over a filesystem it did not create:
//
//   npm run refresh                     scripts/refresh-static.js passes a
//                                       filesystem io and reports to the console
//   the weekly workflow                 the same entry point, on a runner
//
// `steps` is an injection point for the same reason data-sync takes its store
// through setStore(): the tests drive this exact driver with fake steps, so the
// commit rules below are pinned without a network.
//
// THE COMMIT RULES
//
//   - One commit for every changed file (the Git Data API writes them together),
//     not one per file: the deploy that follows is a single build.
//   - A step that finds nothing to do returns no text and is reported skipped.
//   - A step whose file the repository does not have yet returns null text from a
//     successful read: that is "no baseline", which is fine for a file that
//     rebuilds itself wholesale (debt, feed) and a reason to skip for the
//     incremental ones. A read that FAILED is never treated as "no file" — an
//     unreadable baseline would make fetch-all treat 40 weeks as missing and
//     refetch them, so it skips the step instead.
//   - Scrape timestamps are not content: `fetched_at`/`updated_at` are blanked on
//     both sides of the comparison, so a quiet Friday commits nothing and deploys
//     nothing. The stamp is still written whenever the file really does change.
//   - Steps fail open, one at a time: a dead source costs its own file and
//     nothing else, and the rest of the plan still commits.
//
// This module is not routed — functions/_router.js has no HTTP path to it. The only thing
// that runs it is the weekly workflow (or a developer running `npm run refresh`).

const { buildRbiDataFile } = require("../../scripts/fetch-all.js");
const { buildFeedFile } = require("../../scripts/make-rss.js");
const { buildFwdSeriesFile } = require("../../scripts/update-fwd-series.js");
const { buildFwdMonthlyFile } = require("../../scripts/update-fwd-monthly.js");
const { buildExternalDebtFile } = require("../../scripts/fetch-debt-rankings.js");
const { buildSentimentFile } = require("../../scripts/snapshot-sentiment.js");
const { buildFiiHistoryFile } = require("../../scripts/snapshot-fii-dii.js");
const { injectSnapshot } = require("../../scripts/inject-snapshot.js");

const RBI = "public/rbi-data.json";
const FEED = "public/feed.xml";
const INDEX = "public/index.html";
const FX_INTERVENTION = "netlify/functions/fetch-fx-intervention.js";
const DEBT = "public/external-debt.json";
const SENTIMENT = "public/sentiment-history.json";
const FII_DII = "public/fii-dii-history.json";

// How many weeks one invocation may fetch. fetch-all is incremental, so in a
// normal Friday this is 0 or 1; the cap exists for the other case — a cold or
// badly lagged file — because every host this has run on bounds a run somehow
// (a Worker invocation on wall clock, a CI job on its own timeout, and RBI's
// upstream in patience) and being killed mid-scrape commits nothing. The
// remainder drains on the next run.
const DEFAULT_WEEK_LIMIT = 8;

const STEPS = [
  {
    id: "rbi-data",
    path: RBI,
    label: "RBI weekly records",
    run: async ({ priorText, options, log }) => {
      const built = await buildRbiDataFile({ priorText, limit: options.weekLimit, log });
      const left = built.pending - built.fresh;
      return {
        text: built.text,
        detail: `${built.count} weeks · ${built.fresh} new${left > 0 ? ` · ${left} left for the next run` : ""}`,
      };
    },
  },
  {
    id: "feed",
    path: FEED,
    label: "RSS feed",
    run: async ({ texts, options }) => {
      // The feed describes the record set, so it is built from rbi-data.json as
      // this run has left it — the text the step above just produced, else the
      // committed file.
      const source = texts.get(RBI);
      if (source == null) return { text: null, detail: `skipped — ${RBI} unavailable this run` };
      return buildFeedFile({ priorText: source, siteUrl: options.siteUrl });
    },
  },
  {
    id: "seo",
    path: INDEX,
    label: "Static SEO snapshot",
    run: ({ priorText, texts }) => {
      // The crawlable snapshot baked into index.html (head meta + the hidden
      // #snapshot-metrics block + the Dataset JSON-LD) is a function of
      // rbi-data.json. Rebuild it from the text this run produced so a crawler
      // that runs no JS sees the same newest week the dashboard renders.
      if (priorText == null) return { text: null, detail: `skipped — ${INDEX} unavailable this run` };
      const source = texts.get(RBI);
      if (source == null) return { text: null, detail: `skipped — ${RBI} unavailable this run` };
      const text = injectSnapshot(priorText, source);
      return { text, detail: "latest WSS figures + Dataset JSON-LD synchronized" };
    },
  },
  {
    id: "fwd-series",
    path: FX_INTERVENTION,
    label: "Forward-book half-yearly anchor",
    run: ({ priorText }) => buildFwdSeriesFile(priorText),
  },
  {
    id: "fwd-monthly",
    path: FX_INTERVENTION,
    label: "Forward-book Bulletin Table 4A",
    run: ({ priorText }) => buildFwdMonthlyFile(priorText),
  },
  {
    id: "debt",
    path: DEBT,
    label: "World Bank biggest-borrower ranking",
    run: async () => {
      const built = await buildExternalDebtFile();
      return { text: built.text, detail: built.detail };
    },
  },
  {
    id: "sentiment",
    path: SENTIMENT,
    label: "Fear & Greed history",
    run: ({ priorText }) => buildSentimentFile({ priorText }),
  },
  {
    id: "fii-dii",
    path: FII_DII,
    label: "FII/DII flow history",
    run: ({ priorText }) => buildFiiHistoryFile({ priorText }),
  },
];

// Values that move on every scrape without saying anything about the data.
const VOLATILE = /("(?:fetched_at|updated_at|generated_at)"\s*:\s*)"[^"]*"/g;

/** Text with scrape timestamps blanked, for the "did this really change?" test. */
function comparable(text) {
  if (text == null) return null;
  return String(text).replace(VOLATILE, '$1""');
}

function commitMessage(files, results) {
  const names = files.map(f => f.path.split("/").pop());
  const detail = results.filter(r => r.status === "updated").map(r => `- ${r.path}: ${r.detail}`);
  return [
    `chore(data): weekly refresh — ${names.join(", ")}`,
    "",
    ...detail,
    "",
    "Regenerated and committed by the weekly data refresh (GitHub Actions).",
  ].join("\n") + "\n";
}

/** One readable block for the Worker log / CLI output. */
function summarise(summary) {
  const icon = { updated: "✎", unchanged: "=", skipped: "·", failed: "✗" };
  // `check: true` is the local dry run: the io collected the files instead of
  // writing them, so claiming a commit there would be a lie.
  const did = summary.commit && summary.commit.check ? "would write" : "committed";
  const head = summary.commit && summary.commit.ok
    ? `✓ ${did} ${summary.files.length} file${summary.files.length === 1 ? "" : "s"}${summary.commit.commit ? ` (${String(summary.commit.commit).slice(0, 7)})` : ""}`
    : summary.files.length
      ? `✗ ${summary.files.length} file(s) changed but the commit failed: ${summary.commitError}`
      : "✓ nothing changed — no commit";
  const lines = summary.steps.map(r => `  ${icon[r.status] || "·"} ${r.id} (${r.path}): ${r.detail}`);
  return [head, ...lines].join("\n");
}

/**
 * Run the plan. { ok, steps, files, commit, message, failed, commitError }.
 *
 * `io.read(path)`    → { ok, text }        (ok:false on a failed read)
 * `io.commit({ files, message })` → { ok, commit, error }
 */
async function runRefresh({ io, steps = STEPS, options = {}, log = () => {} }) {
  if (!io || typeof io.read !== "function" || typeof io.commit !== "function") {
    throw new Error("runRefresh needs an io with read() and commit()");
  }

  const texts = new Map();   // path → the text this run last produced
  const entries = new Map(); // path → { ok, text, error, changed }
  const results = [];

  async function entryFor(path) {
    if (entries.has(path)) return entries.get(path);
    let entry;
    try {
      const read = await io.read(path);
      entry = read && read.ok
        ? { ok: true, text: read.text, error: null }
        : { ok: false, text: null, error: (read && read.error) || "read failed" };
    } catch (e) {
      entry = { ok: false, text: null, error: String((e && e.message) || e) };
    }
    entries.set(path, entry);
    if (entry.ok) texts.set(path, entry.text); // null = the repository has no such file yet
    return entry;
  }

  for (const step of steps) {
    const entry = await entryFor(step.path);
    if (!entry.ok) {
      results.push({ id: step.id, path: step.path, status: "skipped", detail: `could not read ${step.path} (${entry.error})` });
      continue;
    }

    // `handed` is the file as it stands *now* — the committed text, or what an
    // earlier step on this path just produced. The two forward-book steps share a
    // file and must compose, not overwrite each other.
    const handed = texts.get(step.path);
    let out;
    try {
      out = await step.run({ priorText: handed, texts, options, log });
    } catch (e) {
      results.push({ id: step.id, path: step.path, status: "failed", detail: String((e && e.message) || e) });
      continue;
    }

    if (!out || out.text == null) {
      results.push({ id: step.id, path: step.path, status: "skipped", detail: (out && out.detail) || "nothing to do" });
      continue;
    }

    const changed = comparable(out.text) !== comparable(handed);
    texts.set(step.path, out.text);
    results.push({ id: step.id, path: step.path, status: changed ? "updated" : "unchanged", detail: out.detail || "" });
  }

  // What to commit is decided once, on the finished text: a step that changed a
  // file and a later step that changed it back leave nothing to commit.
  const files = [...texts]
    .filter(([path, text]) => text != null && comparable(text) !== comparable(entries.get(path).text))
    .map(([path, text]) => ({ path, content: text }));
  const message = files.length ? commitMessage(files, results) : null;

  let commit = null;
  if (files.length) {
    try {
      commit = await io.commit({ files, message });
    } catch (e) {
      commit = { ok: false, error: String((e && e.message) || e) };
    }
  }

  const failed = results.filter(r => r.status === "failed");
  return {
    ok: failed.length === 0 && (!commit || commit.ok === true),
    steps: results,
    files: files.map(f => f.path),
    commit,
    message,
    failed: failed.map(r => `${r.id}: ${r.detail}`),
    commitError: commit && commit.ok !== true ? commit.error || "commit failed" : null,
  };
}

module.exports = {
  runRefresh,
  summarise,
  commitMessage,
  comparable,
  STEPS,
  DEFAULT_WEEK_LIMIT,
  PATHS: { RBI, FEED, INDEX, FX_INTERVENTION, DEBT, SENTIMENT, FII_DII },
};
