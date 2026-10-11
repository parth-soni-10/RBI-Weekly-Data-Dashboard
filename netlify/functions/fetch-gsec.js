// Netlify callable: India 10Y G-Sec yield + RBI policy repo rate.
//
// Yield: try a handful of Yahoo tickers historically used for the India 10Y
// benchmark. Yahoo occasionally renames or retires these tickers, so we try
// several in order and never throw — we always return 200.
//
// Repo rate: a small curated table of recent RBI MPC decisions, LIVE-VERIFIED
// on every invocation against RBI's own press-release listing (see
// fetchLiveRepoDecision below): when the listing names a decision newer than
// the table head, the live figure wins. The table stays as history + fallback,
// and still needs its top entry updated after each meeting for the fallback
// path — but a missed edit can no longer freeze the site on a stale rate.
//
// CORS: open.
//
// Output shape:
//   {
//     fetched_at, source_yield, gsec_10y_yield_pct, gsec_10y_date,
//     repo_rate_pct, repo_rate_date, repo_history, repo_source, mpc_schedule, status
//   }

const { get } = require("./_utils/http");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=900" };

// Yahoo tickers historically used for the India 10Y benchmark. The India 10Y
// Government Bond is officially tracked by RBI; Yahoo's coverage is patchy.
const YIELD_TICKERS = [
  "^IR10",        // historical
  "IN10Y=X",      // yahoo 'indices'
  "IN10.B=X",     // alt symbol
  "IND10Y=X",     // alt symbol
];

// Last-known yield (used only if every Yahoo fetch fails). The number is
// plausible for the current macro regime; the date is intentionally null so
// callers don't see a stale "as of" tag.
const FALLBACK_YIELD = { symbol: "manual fallback", yield_pct: 6.85, date: null };

// RBI MPC meets bi-monthly. Update the top entry after every press release.
const REPO_HISTORY = [
  { date: "2026-10-07", pct: 5.50, decision: "hike" },
  { date: "2026-08-08", pct: 5.25, decision: "hold" },
  { date: "2026-06-06", pct: 5.25, decision: "cut"  },
  { date: "2026-04-09", pct: 5.50, decision: "cut"  },
  { date: "2026-02-06", pct: 5.75, decision: "cut"  },
  { date: "2025-12-05", pct: 6.00, decision: "cut"  },
  { date: "2025-10-01", pct: 6.25, decision: "hold" },
  { date: "2025-08-06", pct: 6.25, decision: "cut"  },
  { date: "2025-06-06", pct: 6.50, decision: "cut"  },
  { date: "2025-04-09", pct: 6.75, decision: "hold" },
  { date: "2025-02-07", pct: 6.75, decision: "cut"  },
  { date: "2024-12-06", pct: 7.00, decision: "hold" },
  { date: "2024-10-09", pct: 7.00, decision: "hold" },
  { date: "2024-08-08", pct: 7.00, decision: "hold" },
  { date: "2024-06-07", pct: 7.00, decision: "hold" },
];

// Upcoming MPC meetings, published by RBI in advance (the FY 2026-27 schedule
// was announced 2026-03-23; the decision lands on the meeting's LAST day).
// Deliberately NOT part of REPO_HISTORY — these are scheduled dates, not
// decisions, so nothing that expects a decided rate ever sees a null. The
// repo chart draws them as hollow diamonds on the in-force plateau. When a
// meeting resolves: append the decision to the top of REPO_HISTORY, drop the
// date from here, and add the matching line to MACRO_EVENTS in index.html.
const MPC_SCHEDULE = [
  { date: "2026-12-04", meeting: "Dec 2–4, 2026" },
  { date: "2027-02-05", meeting: "Feb 3–5, 2027" },
];

async function fetchYahooYield() {
  for (const symbol of YIELD_TICKERS) {
    try {
      const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1y`;
      const res  = await get(url, { timeoutMs: 6000 });
      const json = await res.json();
      const r    = json?.chart?.result?.[0];
      const closes = r?.indicators?.quote?.[0]?.close || [];
      const ts     = r?.timestamp || [];
      // Latest value (sanity: India 10Y typically 5–8.5%).
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          if (closes[i] < 3 || closes[i] > 15) continue;
          // Full cleaned series for the yield-trend chart: [date, yield%]
          // pairs, non-null closes only, same 5–8.5% sanity band.
          const series = [];
          for (let j = 0; j < closes.length; j++) {
            if (closes[j] == null || closes[j] < 3 || closes[j] > 15) continue;
            series.push({ date: ts[j] ? new Date(ts[j] * 1000).toISOString().slice(0, 10) : null, v: +closes[j].toFixed(2) });
          }
          if (series.length >= 2) {
            return {
              symbol,
              yield_pct: series[series.length - 1].v,
              date:      series[series.length - 1].date,
              series,
            };
          }
          return {
            symbol,
            yield_pct: +closes[i].toFixed(2),
            date:      ts[i] ? new Date(ts[i] * 1000).toISOString().slice(0,10) : null,
            series:    [],
          };
        }
      }
    } catch (_) { /* try next ticker */ }
  }
  return null;
}

// When the live Yahoo fetch fails we return the value but mark the date as
// null so callers can distinguish "live + timestamped" from "fallback + unknown".
// (Don't pin a stale-looking fallback date — the dashboard should not surface it.)

// ─── Live repo-rate verification against RBI's press releases ──────
// The listing page names every MPC resolution ("Monetary Policy Statement,
// YYYY-YY Resolution of the Monetary Policy Committee <range>") with a stable
// prid link; the release page states the decision in plain prose ("to increase
// the policy repo rate ... by 25 bps to 5.50 per cent" / "to keep ... unchanged
// at 5.25 per cent"). The decision date is the meeting range's last day — the
// same convention MPC_SCHEDULE documents. Anything unparseable resolves to
// null and the curated table stands; the payload shape never changes.
const RBI_PR_LISTING = "https://m.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx";
const RBI_PR_RELEASE = "https://m.rbi.org.in/Scripts/BS_PressReleaseDisplay.aspx?prid=";
const MONTHS = { january:1, february:2, march:3, april:4, may:5, june:6,
  july:7, august:8, september:9, october:10, november:11, december:12 };

function mpcRangeEndIso(title){
  const t = String(title || "");
  let month = null, day = null, year = null;
  let m = t.match(/([A-Za-z]+)\s+(\d{1,2})\s*(?:to|[–—-])\s*(\d{1,2}),?\s*(\d{4})/);
  if(m){ month = MONTHS[m[1].toLowerCase()]; day = +m[3]; year = +m[4]; }
  else {
    m = t.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
    if(!m) return null;
    month = MONTHS[m[1].toLowerCase()]; day = +m[2]; year = +m[3];
  }
  if(!month || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(iso + "T00:00:00Z");
  return (isNaN(d) || d.toISOString().slice(0, 10) !== iso) ? null : iso;
}

function parseRepoDecision(html){
  const text = String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
  const rate = text.match(/repo rate[\s\S]{0,300}?\b(?:to|at)\s+(\d{1,2}\.\d{1,2})\s*per cent/i);
  if(!rate) return null;
  const pct = parseFloat(rate[1]);
  if(!(pct > 3 && pct < 15)) return null;
  const verb = (text.match(/voted[^.]{0,150}?\b(increase|raise|hike|reduce|cut|lower|keep|unchanged|maintain|hold|status quo|leave)\w*/i) || [])[1] || "";
  const v = verb.toLowerCase();
  const decision = /increase|raise|hike/.test(v) ? "hike" : /reduce|cut|lower/.test(v) ? "cut" : "hold";
  return { pct: +pct.toFixed(2), decision };
}

async function fetchLiveRepoDecision(){
  try {
    const listRes = await get(RBI_PR_LISTING, { timeoutMs: 6000 });
    const list = await listRes.text();
    const re = /<a[^>]*href\s*=\s*["']?BS_PressReleaseDisplay\.aspx\?prid=(\d+)["']?[^>]*>([^<]*Monetary Policy Statement[^<]*Resolution[^<]*)<\/a>/gi;
    let m, latest = null;
    while((m = re.exec(list)) !== null){ latest = { prid: m[1], title: m[2].trim() }; break; }
    if(!latest) return null;
    const date = mpcRangeEndIso(latest.title);
    if(!date) return null;
    const relRes = await get(RBI_PR_RELEASE + latest.prid, { timeoutMs: 6000 });
    const parsed = parseRepoDecision(await relRes.text());
    if(!parsed) return null;
    return { date, pct: parsed.pct, decision: parsed.decision, prid: latest.prid };
  } catch(_) { return null; }
}

// The RBI check must never delay the payload: resolve to null (curated table
// stands) when it is slow — same pattern as the peer-rate withTimeout below.
const withTimeoutNull = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

// ─── Peer policy rates for the repo chart's comparison lines ─────────
// US Fed funds upper target (FRED csv mirror of DFEDTARU) and the ECB main
// refinancing rate (ECB's own SDMX API — FRED's ECB mirror sits behind a bot
// challenge). Both are policy rates: parsed to {date, pct} CHANGE points and
// drawn stepped. Failures return [] so the chart falls back to repo alone.
async function fetchFredSteps(id) {
  try {
    const res  = await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2023-06-01`, { timeoutMs: 8000 });
    const text = await res.text();
    const rows = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      const i = line.indexOf(",");
      if (i < 1) continue;
      const date = line.slice(0, i), v = parseFloat(line.slice(i + 1));
      if (/^\d{4}-\d{2}-\d{2}$/.test(date) && isFinite(v) && v > 0 && v < 15) rows.push({ date, pct: v });
    }
    // DFEDTARU is a DAILY series — collapse to change points (a step chart
    // only needs the values where the rate moved; ~1200 rows → ~10).
    return rows.filter((r, i) => i === 0 || r.pct !== rows[i - 1].pct);
  } catch (_) { return []; }
}

async function fetchEcbSteps() {
  try {
    // FM change-dates series (B = business frequency, LEV = level). CSV columns:
    // TIME_PERIOD = 8, OBS_VALUE = 9 (before the comma-containing TITLE column).
    const url  = "https://data-api.ecb.europa.eu/service/data/FM/B.U2.EUR.4F.KR.MRR_FR.LEV?format=csvdata&startPeriod=2024-01-01";
    const res  = await get(url, { timeoutMs: 10000 });
    const text = await res.text();
    const rows = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
      const c = line.split(",");
      const date = c[8], v = parseFloat(c[9]);
      if (/^\d{4}-\d{2}-\d{2}$/.test(date || "") && isFinite(v) && v > 0 && v < 15) rows.push({ date, pct: v });
    }
    return rows;
  } catch (_) { return []; }
}

// A slow peer source must never delay the payload — race each fetch against
// a timeout that resolves to [] (the chart then just draws fewer lines).
const withTimeout = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r([]), ms))]);

// Exported for tests/gsec-repo.test.js (same pattern as fetch-data.js sharing
// helpers with data-latest.js) — Netlify ignores module.exports on deploy.
exports.handler = async () => {
  const [yahoo, live, [fedSteps, ecbSteps]] = await Promise.all([
    fetchYahooYield(),
    withTimeoutNull(fetchLiveRepoDecision(), 9000),
    Promise.all([
      withTimeout(fetchFredSteps("DFEDTARU"), 9000),
      withTimeout(fetchEcbSteps(), 12000),
    ]),
  ]);
  // The curated table is history + fallback; a live decision newer than its
  // head wins, so the page updates on refresh with no redeploy.
  let history = REPO_HISTORY.slice();
  let repoSource = "curated REPO_HISTORY (RBI MPC decisions)";
  if(live && live.date && (!history[0] || live.date > history[0].date)){
    history = [{ date: live.date, pct: live.pct, decision: live.decision }, ...history];
    repoSource = `RBI press release prid=${live.prid} (live-checked ${new Date().toISOString().slice(0, 10)})`;
  }
  const last = history[0];

  const yield_pct = yahoo?.yield_pct ?? FALLBACK_YIELD.yield_pct;
  const yield_date = yahoo?.date ?? FALLBACK_YIELD.date;
  const source_yield = yahoo ? `Yahoo Finance ${yahoo.symbol}` : `${FALLBACK_YIELD.symbol} (live Yahoo tickers unavailable)`;
  const status = yahoo ? "ok" : "static fallback";

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at:          new Date().toISOString(),
      source_yield,
      gsec_10y_yield_pct:  yield_pct,
      gsec_10y_date:       yield_date,
      yield_series:        yahoo?.series ?? [],
      repo_rate_pct:       last?.pct  ?? null,
      repo_rate_date:      last?.date ?? null,
      repo_history:        history,
      repo_source:         repoSource,
      mpc_schedule:         MPC_SCHEDULE,
      policy_peers: {
        fed: { name: "Fed funds (US, upper target)", steps: fedSteps },
        ecb: { name: "ECB main refinancing rate",    steps: ecbSteps },
      },
      status,
    }),
  };
};

// Exported for tests/gsec-repo.test.js (same pattern as fetch-data.js sharing
// helpers with data-latest.js): attach to the existing exports object —
// reassigning module.exports here would orphan exports.handler above.
exports.mpcRangeEndIso = mpcRangeEndIso;
exports.parseRepoDecision = parseRepoDecision;
exports.REPO_HISTORY = REPO_HISTORY;
exports.MPC_SCHEDULE = MPC_SCHEDULE;
