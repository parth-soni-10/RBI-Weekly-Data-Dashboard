// Netlify callable: EM FX-peers overlay data (INR vs BRL/IDR/CNY/ZAR, indexed
// to 100) proxied from Yahoo Finance on the SERVER.
//
// The dashboard's "EM Peers" tab used to call Yahoo's chart API straight from
// the browser, which only works when the page origin is one Yahoo allows
// (CORS) — locally served copies and other origins got blocked and the tab
// silently degraded. Proxying through this function fixes that: browsers talk
// to /.netlify/functions/fetch-em-peers (same origin, no CORS) and the
// function talks to Yahoo server-side.
//
// The indexing math (closes / first close × 100) is done here so the
// frontend just plots what it receives. Always returns 200 with open CORS;
// peers that fail to load are omitted and a per-currency `errors` list is
// included so the UI can stay honest instead of guessing.
//
// Optional query params (whitelisted to prevent abuse):
//   ?range=6mo    default; also 1mo, 3mo, 1y
//   ?interval=1d  default; also 1wk
//
// Output shape:
//   {
//     fetched_at, source, range, interval,
//     peers: [ { code, points: [100, 99.6, ...], dates: ["YYYY-MM-DD", ...] } ],
//     errors: [ { code, error } ],
//     status
//   }

const { get } = require("./_utils/http");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" };

const SYMS = [
  { code: "INR", ticker: "INR=X" },
  { code: "BRL", ticker: "BRL=X" },
  { code: "IDR", ticker: "IDR=X" },
  { code: "CNY", ticker: "CNY=X" },
  { code: "ZAR", ticker: "ZAR=X" },
];
const RANGES = { "1mo": "1mo", "3mo": "3mo", "6mo": "6mo", "1y": "1y" };
const INTERVALS = { "1d": "1d", "1wk": "1wk" };

// One currency → { points (indexed to 100), dates } or null if unusable.
async function fetchPeer(sym, range, interval) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym.ticker)}?interval=${interval}&range=${range}`;
  const res = await get(url, { timeoutMs: 8000 });
  const json = await res.json();
  const r = json?.chart?.result?.[0];
  const closes = (r?.indicators?.quote?.[0]?.close || []).filter(v => v != null);
  const ts = r?.timestamp || [];
  if (closes.length < 5) throw new Error("not enough closes from Yahoo");
  const base = closes[0];
  return {
    code: sym.code,
    points: closes.map(v => +(v / base * 100).toFixed(2)),
    dates: ts.map(t => new Date(t * 1000).toISOString().slice(0, 10)),
  };
}

exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const range    = RANGES[q.range]    || "6mo";
  const interval = INTERVALS[q.interval] || "1d";

  const results = await Promise.allSettled(SYMS.map(s => fetchPeer(s, range, interval)));
  const peers  = [];
  const errors = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) peers.push(r.value);
    else errors.push({ code: SYMS[i].code, error: r.reason ? String(r.reason.message || r.reason) : "unknown" });
  });

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source: "Yahoo Finance (proxied server-side by fetch-em-peers)",
      range,
      interval,
      peers,
      errors,
      status: peers.length ? (errors.length ? "partial" : "ok") : "unavailable",
    }),
  };
};
