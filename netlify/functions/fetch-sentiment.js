// Netlify callable: India market sentiment — a composite Fear & Greed meter
// built from free Yahoo Finance quotes, in the spirit of CNN's Fear & Greed
// Index but tuned for Indian markets (no key, no paid API).
//
// Signals (all server-side from Yahoo):
//   1. Nifty 50 momentum     — % distance from its 125-day moving average
//                              (≈ 6 trading months). Deep below the MA = fear.
//   2. Nifty 50 strength     — share of the last 52 weeks' range where the
//                              index currently sits. Near the low = fear.
//   3. India VIX             — level relative to its own trailing 1-year
//                              percentiles (P25/P75 computed from the series).
//                              High volatility = fear.
//   4. Breadth proxy         — Nifty's 21-day return vs the Nifty Smallcap
//                              index's 21-day return. When smallcaps lag large
//                              caps sharply, speculative appetite is fading.
//   5. Safe-haven demand     — 21-day % change in USD/INR. A surging dollar
//                              against the rupee = capital leaving = fear.
//
// Each signal maps to 0 (extreme fear) … 100 (extreme greed); the meter is the
// simple average. Every component is reported so the UI can show the
// breakdown, not just a bare number.
//
// Output shape (always 200; fails open to the last successful composite):
//   {
//     fetched_at, source,
//     score:           0–100,          // composite
//     label:           "Extreme fear" … "Extreme greed",
//     change:          vs-previous-close-points | null,
//     as_of:           "YYYY-MM-DD",   // market date of the quotes
//     components: [ { key, label, value, score } ],   // value = raw signal
//     status: "ok" | "partial" | "static fallback",
//     note:   set when degraded
//   }
//
// Response is cached in-process (30 min) + Cache-Control (15 min). The last
// good payload is remembered module-side too, so a temporarily blocked Yahoo
// serves the last-known meter flagged "static fallback" — the same honest
// degradation the other dashboard scrapers use.

const { get } = require("./_utils/http");
const { withCache } = require("./_utils/cache");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=900" };

const TTL_MS = 30 * 60 * 1000;

// Yahoo chart API: daily closes, 1 year (enough for the 52-week range + VIX
// percentiles + 125d MA). Tickers verified live: ^NSEI = Nifty 50,
// ^INDIAVIX = India VIX, NIFTYSMLCAP250.NS = Nifty Smallcap 250, USDINR=X = spot.
// (^CNXSC, the old Smallcap-100 code, still resolves but serves a dead series.)
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart/";
const Q = "?interval=1d&range=1y";

function clamp01(x){ return Math.min(100, Math.max(0, x)); }

// Map a value onto 0–100 between worst (→0) and best (→100) anchors.
function scale(val, worst, best){
  if(!isFinite(val)) return null;
  if(worst === best) return null;
  const t = (val - worst) / (best - worst);
  return clamp01(t * 100);
}

// Percentile of `x` within `arr` (linear interpolation), arr unsorted ok.
function pctRank(arr, x){
  const s = arr.filter(v => isFinite(v)).sort((a, b) => a - b);
  if(!s.length) return null;
  let lo = 0, hi = s.length;
  while(lo < hi){ const mid = (lo + hi) >> 1; if(s[mid] < x) lo = mid + 1; else hi = mid; }
  if(lo === 0) return 0;
  if(lo === s.length) return 100;
  return (lo / s.length) * 100; // rank fraction; good enough for zone mapping
}

function sma(closes, n){
  if(closes.length < n) return null;
  const slice = closes.slice(-n);
  return slice.reduce((a, b) => a + b, 0) / n;
}

async function chart(ticker){
  const url = CHART + encodeURIComponent(ticker) + Q;
  const res = await get(url, { timeoutMs: 9000 });
  if(!res.ok) throw new Error("Yahoo HTTP " + res.status + " for " + ticker);
  const json = await res.json();
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  const closes = r && r.indicators && r.indicators.quote && r.indicators.quote[0] && r.indicators.quote[0].close || [];
  const clean = closes.filter(v => v != null && isFinite(v));
  if(clean.length < 130) throw new Error("not enough history for " + ticker + " (" + clean.length + " closes)");
  const stamps = (r.meta && r.meta.regularMarketTime) || (r.timestamp || []).slice(-1)[0];
  const asOf = new Date(stamps * 1000).toISOString().slice(0, 10);
  return { closes: clean, asOf };
}

// ── Signal scorers ──────────────────────────────────────────────────────────
// Each returns { value, score } or throws if the underlying series is broken.

// 1. Momentum: distance from the 125-day MA (≈ 6 months), % + vs −.
function momentumSig(nifty){
  const ma = sma(nifty.closes, 125);
  const last = nifty.closes.slice(-1)[0];
  const dist = (last / ma - 1) * 100;
  return {
    value: +dist.toFixed(2),
    unit: "%",
    label: "Nifty vs 6-month average",
    // +6% above MA = full greed, −6% below = full fear (momentum extremes are
    // deliberately asymmetric-tolerant: trending bull markets stay greedy).
    score: scale(dist, -6, 6),
  };
}

// 2. Strength: position within the 52-week range (0 = at the low, 100 = high).
function strengthSig(nifty){
  const c = nifty.closes;
  const last = c.slice(-1)[0];
  const win = c.slice(-252);
  const hi = Math.max(...win), lo = Math.min(...win);
  const pos = hi === lo ? 50 : (last - lo) / (hi - lo) * 100;
  return {
    value: +pos.toFixed(1),
    unit: "% of 52w range",
    label: "Nifty position in 52-week range",
    score: clamp01(pos),
  };
}

// 3. Volatility: India VIX vs its own 1-year P25/P75.
function vixSig(vix){
  const c = vix.closes;
  const last = c.slice(-1)[0];
  const s = c.slice().sort((a, b) => a - b);
  const p25 = s[Math.floor(s.length * 0.25)], p75 = s[Math.floor(s.length * 0.75)];
  // Below P25 = full greed, above P75 = full fear; linear in between.
  return {
    value: +last.toFixed(2),
    unit: "VIX",
    label: "India VIX vs its 1-year norm",
    score: scale(last, p75, p25),
  };
}

// 4. Breadth proxy — 21-day return spread, smallcaps − largecaps. When the
//    series is missing, falls back to a direct 21-day Nifty return (a falling
//    market reads as fear regardless of smallcap behaviour).
function breadthSig(nifty, small){
  const ret = (c, k) => (c.slice(-1)[0] / c.slice(-(k + 1))[0] - 1) * 100;
  const nret = ret(nifty.closes, 21);
  if(small){
    const spread = ret(small.closes, 21) - nret;
    return {
      value: +spread.toFixed(2),
      unit: "pp / 21d",
      label: "Smallcap minus largecap 21-day return",
      // Spread above +3pp = speculative appetite alive (greed); below −3pp = fear.
      score: scale(spread, -3, 3),
    };
  }
  return {
    value: +nret.toFixed(2),
    unit: "% / 21d",
    label: "Nifty 21-day return (breadth series unavailable)",
    // −5% in 21 days = full fear; +5% = full greed.
    score: scale(nret, -5, 5),
  };
}

// 5. Safe-haven: 21-day % move in USD/INR (rising USD/INR = fear).
function fxSig(usdinr){
  const c = usdinr.closes;
  const chg = (c.slice(-1)[0] / c.slice(-22)[0] - 1) * 100;
  return {
    value: +chg.toFixed(2),
    unit: "% / 21d",
    label: "USD/INR 21-day move",
    // +2% dollar surge in 21 days = full fear; −2% = rupee rallying = greed.
    score: scale(chg, 2, -2),
  };
}

function labelFor(score){
  if(score < 25)  return "Extreme fear";
  if(score < 45)  return "Fear";
  if(score <= 55) return "Neutral";
  if(score <= 75) return "Greed";
  return "Extreme greed";
}

async function buildPayload(){
  // Breadth series: Nifty Smallcap 250 on Yahoo (NSE suffix). Optional.
  let small = null;
  try { small = await chart("NIFTYSMLCAP250.NS"); } catch (e) { /* breadth optional */ }

  const [nifty, vix, usdinr] = await Promise.all([
    chart("^NSEI"),
    chart("^INDIAVIX"),
    chart("USDINR=X").catch(() => null),
  ]);

  // Score all signals for a given set of series; returns { comps, score } or
  // null when fewer than 3 signals are usable. `shift` truncates every series
  // by one close so the same code computes the previous day's composite.
  function composite(shift){
    const cut = s => s ? { ...s, closes: s.closes.slice(0, s.closes.length - shift) } : null;
    const N = cut(nifty), V = cut(vix), U = cut(usdinr), S = cut(small);
    const comps = [];
    const push = (key, sig) => { if(sig && sig.score != null) comps.push({ key, ...sig }); };
    push("momentum", momentumSig(N));
    push("strength", strengthSig(N));
    push("vix",      vixSig(V));
    // Breadth always contributes: with the smallcap series it's the
    // small-vs-large spread; without it, a direct Nifty 21-day return.
    push("breadth", breadthSig(N, S));
    if(U) push("haven", fxSig(U));
    if(comps.length < 3) return null;
    return { comps, score: comps.reduce((a, c) => a + c.score, 0) / comps.length };
  }

  const cur = composite(0);
  if(!cur) throw new Error("too few usable signals");
  const prev = composite(1);
  const score = Math.round(cur.score);
  const change = prev ? +(score - Math.round(prev.score)).toFixed(0) : null;

  return {
    fetched_at: new Date().toISOString(),
    source: "Yahoo Finance — Nifty 50, India VIX, Nifty Smallcap, USD/INR (server-side)",
    score,
    label: labelFor(score),
    change,
    as_of: nifty.asOf,
    components: cur.comps.map(c => ({ key: c.key, label: c.label, value: c.value, unit: c.unit, score: Math.round(c.score) })),
    status: usdinr ? "ok" : "partial",
    note: usdinr ? null : "USD/INR signal unavailable — meter averages the remaining signals.",
  };
}

exports.handler = async () => {
  try {
    const payload = await withCache("fg:" + new Date().toISOString().slice(0, 13), TTL_MS, buildPayload);
    lastGood = payload;
    return { statusCode: 200, headers: CORS, body: JSON.stringify(payload) };
  } catch (e) {
    if(lastGood){
      const p = { ...lastGood, status: "static fallback",
        note: "Live quotes unreachable (" + String(e.message || e) + ") — showing the last successful meter (" + lastGood.fetched_at + ")." };
      return { statusCode: 200, headers: CORS, body: JSON.stringify(p) };
    }
    return { statusCode: 200, headers: CORS, body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source: "Yahoo Finance (server-side)",
      score: null, label: null, change: null, as_of: null,
      components: [],
      status: "unavailable",
      note: "Live quotes unreachable — no last-known meter available yet: " + String(e.message || e),
    }) };
  }
};

// test hook
exports._buildPayload = buildPayload;
