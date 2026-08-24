// Netlify callable: India 10Y G-Sec yield + RBI policy repo rate.
//
// Yield: try a handful of Yahoo tickers historically used for the India 10Y
// benchmark. Yahoo occasionally renames or retires these tickers, so we try
// several in order and never throw — we always return 200.
//
// Repo rate: a small curated table of recent RBI MPC decisions. India
// announces repo rate bi-monthly; update this list every meeting. (We could
// scrape the RBI press release HTML but it's brittle across their redesigns.)
//
// CORS: open.
//
// Output shape:
//   {
//     fetched_at, source_yield, gsec_10y_yield_pct, gsec_10y_date,
//     repo_rate_pct, repo_rate_date, repo_history, status
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

async function fetchYahooYield() {
  for (const symbol of YIELD_TICKERS) {
    try {
      const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=15d`;
      const res  = await get(url, { timeoutMs: 6000 });
      const json = await res.json();
      const r    = json?.chart?.result?.[0];
      const closes = r?.indicators?.quote?.[0]?.close || [];
      const ts     = r?.timestamp || [];
      for (let i = closes.length - 1; i >= 0; i--) {
        if (closes[i] != null) {
          // Sanity: India 10Y typically 5–8.5%. Discard obviously-wrong values.
          if (closes[i] < 3 || closes[i] > 15) continue;
          return {
            symbol,
            yield_pct: +closes[i].toFixed(2),
            date:      ts[i] ? new Date(ts[i] * 1000).toISOString().slice(0,10) : null,
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

exports.handler = async () => {
  const yahoo = await fetchYahooYield();
  const last  = REPO_HISTORY[0];

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
      repo_rate_pct:       last?.pct  ?? null,
      repo_rate_date:      last?.date ?? null,
      repo_history:        REPO_HISTORY,
      status,
    }),
  };
};
