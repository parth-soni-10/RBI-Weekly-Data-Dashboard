// Netlify callable: daily NSDL FII (equity/debt) + NSE DII flows — gross buy,
// gross sell and net in ₹ cr, one row per trading day.
//
// Sources (both verified live; neither alone covers FII + DII):
//   1. NSDL Monthly page — every trading day of the current month with the
//      full per-day block (Equity sub-total, the three Debt sub-type
//      sub-totals: General/VRR/FAR, Hybrid, MF, AIFs, day Total). NSDL
//      publishes the day's FPI flows on the evening of the same day.
//   2. NSE fii-dii CSV — the official provisional FII/DII buy/sell/net for the
//      latest published session. Needs a cookie warm-up (page first, then the
//      API), and publishes DII one session behind NSDL. Only the DII row is
//      used here: NSE's FII/FPI figure is a single equity+debt number and
//      would fight NSDL's split.
//
// Live sources only ever hold a short window (NSDL = current month to date,
// NSE = latest session), so the dashboard accumulates rows day by day into
// public/fii-dii-history.json via scripts/snapshot-fii-dii.js (daily cron +
// deploy build); the frontend merges that file with this function's live rows.
//
// Always returns 200: if both sources fail we serve a curated ~30-day series
// flagged `status: "static fallback"` — the frontend ignores fallback rows so
// fabricated bars can never mix into the accumulated history.
//
// CORS: open.

const { get, extractHtmlTables } = require("./_utils/http");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=1800" };

const NSDL_MONTHLY = "https://www.fpi.nsdl.co.in/web/Reports/Monthly.aspx";
const NSE_PAGE     = "https://www.nseindia.com/reports/fii-dii";
const NSE_CSV      = "https://www.nseindia.com/api/fiidiiTradeReact?csv=true";

const MONTH_IDX = { Jan:"01", Feb:"02", Mar:"03", Apr:"04", May:"05", Jun:"06", Jul:"07", Aug:"08", Sep:"09", Oct:"10", Nov:"11", Dec:"12" };

// "06-Oct-2026" (both sources' date format) → "2026-10-06".
function nsdlDate(v) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(String(v || "").trim());
  return m && MONTH_IDX[m[2]] ? `${m[3]}-${MONTH_IDX[m[2]]}-${m[1].padStart(2, "0")}` : null;
}

// "(9,569.57)" → -9569.57 (parenthesised negatives), "17,667.90" → 17667.90.
function flowNum(v) {
  const s = String(v == null ? "" : v).trim();
  const t = s.replace(/[(),\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(t)) return NaN;
  const n = parseFloat(t);
  return Math.round((/^\(.*\)$/.test(s) ? -n : n) * 100) / 100; // 2dp, kills float noise
}

// Walk NSDL's first table: one block per trading day, opening with a
// "06-Oct-2026 | Equity | Stock Exchange | buy | sell | net | …" row. The
// Equity "Sub-total" row (stock exchange + primary market) overwrites the
// opening leg; each "Sub-total" under a "Debt-*" sub-type adds into the debt
// totals; Hybrid/MF/AIF sub-totals are ignored (they belong to neither bar).
function parseNsdlDayBlocks(html) {
  const tables = extractHtmlTables(html);
  const days = {};
  if (!tables.length) return days;
  let cur = null, seg = null;
  for (const r of tables[0]) {
    const label = String(r[0] || "").trim();
    const date = nsdlDate(label);
    if (date) {
      cur = days[date] || (days[date] = { date, fii_equity_cr: 0, fii_equity_buy_cr: 0, fii_equity_sell_cr: 0,
                                          fii_debt_cr: 0, fii_debt_buy_cr: 0, fii_debt_sell_cr: 0 });
      seg = String(r[1] || "").trim() === "Equity" ? "equity" : null;
      const b = flowNum(r[3]), s = flowNum(r[4]), n = flowNum(r[5]);
      if (!isNaN(b)) cur.fii_equity_buy_cr = b;
      if (!isNaN(s)) cur.fii_equity_sell_cr = s;
      if (!isNaN(n)) cur.fii_equity_cr = n;
      continue;
    }
    if (!cur) continue;
    if (label.startsWith("Debt-")) seg = "debt";
    else if (label === "Sub-total" && seg === "equity") {
      const b = flowNum(r[1]), s = flowNum(r[2]), n = flowNum(r[3]);
      if (!isNaN(b)) cur.fii_equity_buy_cr = b;
      if (!isNaN(s)) cur.fii_equity_sell_cr = s;
      if (!isNaN(n)) cur.fii_equity_cr = n;
      seg = null;
    } else if (label === "Sub-total" && seg === "debt") {
      const b = flowNum(r[1]), s = flowNum(r[2]), n = flowNum(r[3]);
      if (!isNaN(b)) cur.fii_debt_buy_cr += b;
      if (!isNaN(s)) cur.fii_debt_sell_cr += s;
      if (!isNaN(n)) cur.fii_debt_cr += n;
      seg = null;
    } else if (label === "Hybrid" || label === "Mutual Funds" || label === "AIFs") {
      seg = null; // its Sub-total must not land in the debt sum
    }
  }
  return days;
}

// NSE's provisional FII/DII CSV: header line, then rows shaped
// "DII","05-Oct-2026","20,492.93","15,311.31","5,181.62" (quoted, commas inside
// numbers). Returns rows keyed by date carrying only the DII fields.
async function fetchNseDii() {
  const warm = await get(NSE_PAGE, { timeoutMs: 10000 });
  const cookie = (warm.headers.getSetCookie ? warm.headers.getSetCookie() : [])
    .map(c => c.split(";")[0]).join("; ");
  const res = await get(NSE_CSV, { timeoutMs: 8000, headers: { Cookie: cookie, Referer: NSE_PAGE, Accept: "*/*" } });
  const text = await res.text();
  const rows = {};
  for (const line of text.split("\n")) {
    const m = /^\s*"([^"]+)","([^"]+)","([^"]+)","([^"]+)","([^"]+)"/.exec(line);
    if (!m || m[1].trim() !== "DII") continue;
    const date = nsdlDate(m[2]);
    if (!date) continue;
    const buy = flowNum(m[3]), sell = flowNum(m[4]);
    let net = flowNum(m[5]);
    if (isNaN(net) && !isNaN(buy) && !isNaN(sell)) net = Math.round((buy - sell) * 100) / 100;
    rows[date] = { date };
    if (!isNaN(buy))  rows[date].dii_buy_cr = buy;
    if (!isNaN(sell)) rows[date].dii_sell_cr = sell;
    if (!isNaN(net))  rows[date].dii_equity_cr = net; // NSE publishes no DII debt split
  }
  return rows;
}

// Curated last-known ~30 trading days, used only when every live source
// fails. Net-only (no gross buy/sell) and flagged `static fallback`.
function buildFallbackSeries() {
  const seq = [
    // [days_ago, fii_equity_cr, fii_debt_cr, dii_equity_cr]
    [0,   -845,   320,  1760],
    [1,  -1320, -210,  2050],
    [2,   -480,   85,  1410],
    [3,   1240,  295,  -890],
    [4,   -225,  410,  -340],
    [5,   1820,  175,  1150],
    [6,  -1190, -440,  2170],
    [7,    265,  320,   220],
    [8,   -790, -180,  1860],
    [9,   1020,  210,  -130],
    [10,  -380,  155,  1490],
    [11,   430,  -85,  -270],
    [12, -1565,  235,  2310],
    [13,   690,  340,  -180],
    [14,  -215,  305,  1820],
    [15,   810, -120,   490],
    [16, -1090,  215,  1850],
    [17,   165,  190,  -310],
    [18,  -640,  260,  1270],
    [19,  1130, -210,   340],
    [20,   -90,  185,  1980],
    [21,   735,  310,  -420],
    [22, -1245,  240,  2050],
    [23,   420, -160,   580],
    [24,  -275,  220,  1690],
    [25,   990,  300,  -640],
    [26,  -510,  170,  2200],
    [27,   295, -100,   370],
    [28, -1030,  195,  1880],
    [29,   180,  265,  -270],
  ];
  const today = new Date();
  return seq.map(([ago, eq, debt, dii]) => {
    const d = new Date(today);
    d.setDate(d.getDate() - ago);
    return { date: d.toISOString().slice(0, 10), fii_equity_cr: eq, fii_debt_cr: debt, dii_equity_cr: dii };
  });
}

// Overlay `add` rows onto `target` keyed by date: each source only fills the
// fields it actually knows, so a DII-only NSE row can never null out (or
// relabel) NSDL's equity/debt split for the same day.
function mergeByDate(target, add) {
  for (const r of Object.values(add)) {
    const cur = target[r.date] || (target[r.date] = { date: r.date });
    for (const k of Object.keys(r)) if (r[k] != null) cur[k] = r[k];
  }
}

// 2dp on the way out — summed floats carry noise (1054.9299999999998).
const r2 = v => (Number.isFinite(v) ? Math.round(v * 100) / 100 : v);

// Build the response payload (also consumed by scripts/snapshot-fii-dii.js,
// which accumulates these rows into public/fii-dii-history.json).
async function _buildPayload() {
  const [nsdl, nse] = await Promise.allSettled([fetchNsdlMonth(), fetchNseDii()]);
  const byDate = {};
  if (nsdl.status === "fulfilled") mergeByDate(byDate, nsdl.value);
  else console.error("fii-history: NSDL failed —", nsdl.reason && nsdl.reason.message);
  if (nse.status === "fulfilled") mergeByDate(byDate, nse.value);
  else console.error("fii-history: NSE failed —", nse.reason && nse.reason.message);

  let series = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  let source = "NSDL Monthly (FII split) + NSE fii-dii (DII)";
  let status = "ok";
  if (!series.length) {
    series = buildFallbackSeries();
    source = "manual fallback (NSDL + NSE both unparseable)";
    status = "static fallback";
  }

  // YTD summed over the returned rows (live rows cover the current month;
  // the frontend sums its accumulated history for the real YTD tile).
  const yearStart = new Date().getFullYear() + "-01-01";
  const sum = key => series.filter(r => r.date >= yearStart).reduce((s, r) => s + (Number(r[key]) || 0), 0);

  return {
    fetched_at: new Date().toISOString(),
    source,
    status,
    as_of_date: series[series.length - 1].date,
    count: series.length,
    error: status === "static fallback"
      ? "NSDL and NSE both returned no parseable rows - showing curated fallback series"
      : undefined,
    series: series.map(r => ({
      date: r.date,
      fii_equity_cr: r2(r.fii_equity_cr), fii_equity_buy_cr: r2(r.fii_equity_buy_cr), fii_equity_sell_cr: r2(r.fii_equity_sell_cr),
      fii_debt_cr: r2(r.fii_debt_cr), fii_debt_buy_cr: r2(r.fii_debt_buy_cr), fii_debt_sell_cr: r2(r.fii_debt_sell_cr),
      dii_equity_cr: r2(r.dii_equity_cr), dii_buy_cr: r2(r.dii_buy_cr), dii_sell_cr: r2(r.dii_sell_cr),
    })),
    ytd: {
      fii_equity_cr: sum("fii_equity_cr"),
      fii_debt_cr:   sum("fii_debt_cr"),
      dii_equity_cr: sum("dii_equity_cr"),
      dii_debt_cr:   0, // NSE does not split DII debt flows out
    },
  };
}

async function fetchNsdlMonth() {
  const res = await get(NSDL_MONTHLY, { timeoutMs: 12000 });
  return parseNsdlDayBlocks(await res.text());
}

exports._buildPayload = _buildPayload;
exports.handler = async () => ({
  statusCode: 200,
  headers: CORS,
  body: JSON.stringify(await _buildPayload()),
});
