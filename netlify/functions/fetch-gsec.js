// India 10Y G-Sec yield + RBI policy repo rate.
// Yield: Yahoo Finance via ^IR10 or IN10Y=X (whichever is currently available).
// Repo rate: we keep a hardcoded historical snapshot of recent RBI MPC decisions
// because RBI's press releases HTML is fragile to scrape; manual updates only.

const { get, parseNum } = require("./_utils/http");

const YIELD_TICKERS = ["^IR10", "IN10Y=X", "IN10.B=X"]; // try in order

const REPO_HISTORY = [
  // Updated as RBI MPC decisions land. Each entry: { date, pct, decision }.
  { date: "2025-12-05", pct: 5.50, decision: "cut"  },
  { date: "2025-10-01", pct: 5.75, decision: "cut"  },
  { date: "2025-08-06", pct: 6.00, decision: "cut"  },
  { date: "2025-06-06", pct: 6.25, decision: "cut"  },
  { date: "2025-04-09", pct: 6.50, decision: "hold" },
  { date: "2025-02-07", pct: 6.50, decision: "hold" },
  { date: "2024-12-06", pct: 6.50, decision: "hold" },
  { date: "2024-10-09", pct: 6.50, decision: "hold" },
  { date: "2024-08-08", pct: 6.50, decision: "hold" },
  { date: "2024-06-07", pct: 6.50, decision: "hold" },
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

exports.handler = async () => {
  const yahoo = await fetchYahooYield();
  const last  = REPO_HISTORY[0];

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=900" },
    body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source_yield: yahoo ? `Yahoo Finance ${yahoo.symbol}` : "unavailable",
      gsec_10y_yield_pct: yahoo?.yield_pct ?? null,
      gsec_10y_date:     yahoo?.date       ?? null,
      repo_rate_pct:     last?.pct         ?? null,
      repo_rate_date:    last?.date        ?? null,
      repo_history:      REPO_HISTORY,
    }),
  };
};
