// Public JSON API — lightweight crude snapshot.
//
// For the FULL crude pipeline (PPAC + TankerMap + reconciled daily BPD),
// call GET /.netlify/functions/fetch-crude?action=all directly — that's the
// endpoint the dashboard already uses. This thin endpoint serves a
// cache-friendly subset so an embed widget or third-party site can pull
// just the price headline.
//
// GET /data/crude-bpd.json  →  { brent, wti, urals?, fetched_at }
//
// Yahoo Finance is hit directly (no net hop to fetch-crude) to keep
// the response fast and cacheable. urals is best-effort — Yahoo sometimes
// delists it. If everything fails we still return 200 with null prices
// so the embed can render a "no data" state without a thrown error.

const fetch = require("node-fetch");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Cache-Control":                 "public, max-age=300", // 5 min — prices move
  "Content-Type":                  "application/json",
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function yahooPrice(symbol) {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 6000);
    const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=15d`;
    const res  = await fetch(url, { signal: ctrl.signal, headers: { "User-Agent": UA } });
    clearTimeout(tid);
    if (!res.ok) return { price: null, date: null };
    const json   = await res.json();
    const result = json?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const ts     = result?.timestamp || [];
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        const date = ts[i] ? new Date(ts[i] * 1000).toISOString().slice(0, 10) : null;
        return { price: +closes[i].toFixed(2), date };
      }
    }
    return { price: null, date: null };
  } catch (_) {
    return { price: null, date: null };
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    // Fetch the three benchmarks in parallel — they're independent.
    // urals is included for completeness; many dashboards show Brent + WTI only.
    const [brent, wti, urals] = await Promise.all([
      yahooPrice("BZ=F"),
      yahooPrice("CL=F"),
      yahooPrice("URC=F").catch(() => ({ price: null, date: null })),
    ]);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "Yahoo Finance (spot, USD/bbl)",
        brent:      brent.price,  brent_date:  brent.date,
        wti:        wti.price,    wti_date:    wti.date,
        urals:      urals?.price ?? null, urals_date: urals?.date ?? null,
      }),
    };
  } catch (err) {
    return {
      statusCode: 200, headers: CORS, // intentionally 200 — embed handles missing prices
      body: JSON.stringify({ fetched_at: new Date().toISOString(), error: err.message }),
    };
  }
};
