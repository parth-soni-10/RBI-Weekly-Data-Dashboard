// 6-month history of NSDL FII + DII capital flows (daily resolution).
// NSDL publishes FII daily at https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx
// and DII daily at https://www.fpi.nsdl.co.in/web/Reports/DII.aspx.
//
// Public endpoints tried in order (each degrades gracefully — keeps any rows
// it can parse even if others fail). 6-month window is computed from `series`,
// so the actual archive depth is whatever the upstream exposed.
//
// Output shape (200 OK even on partial failure):
//   {
//     fetched_at, source, status,
//     series: [{ date, fii_equity_cr, fii_debt_cr, dii_equity_cr, dii_debt_cr }, ...],
//     ytd:    { fii_equity_cr, fii_debt_cr, dii_equity_cr, dii_debt_cr }
//   }

const { get, extractHtmlTables, parseNum } = require("./_utils/http");

const URLS = [
  { url: "https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx", kind: "fii"  },
  { url: "https://www.fpi.nsdl.co.in/web/Reports/DII.aspx",   kind: "dii"  },
  { url: "https://www.fpi.nsdl.co.in/web/Reports/Archive.aspx", kind: "archive" },
  { url: "https://www.cdslindia.com/InvestorServices/FPI.aspx",  kind: "fii-fallback"  },
];

// Pull a row of the form [Date, ..., numeric, numeric, ...] from any of the
// NSDL-formatted tables.  Different pages place columns differently, so we
// sniff for the marker words then take the rightmost 1–4 numerics of the row.
function extractFlowRow(row) {
  const joined = row.join(" ").toLowerCase();
  const dateStr = row.find(c => /\d{4}-\d{2}-\d{2}/.test(String(c))) ||
                  row.find(c => /\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/.test(String(c)));
  if (!dateStr) return null;
  // Convert slashes to ISO if needed
  let date = dateStr;
  const m = String(dateStr).match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (m) {
    const [, d, mo, y] = m;
    const yr = y.length === 2 ? `20${y}` : y;
    date = `${yr}-${mo.padStart(2,"0")}-${d.padStart(2,"0")}`;
  } else if (!/^\d{4}/.test(String(dateStr))) {
    date = String(dateStr);
  }
  const nums = row
    .map(c => String(c).replace(/[()]/g, "").trim())
    .filter(c => /^-?[\d,\.]+$/.test(c))
    .map(parseNum)
    .filter(n => !isNaN(n) && n > -1e6 && n < 1e6);
  if (!nums.length) return null;
  // Heuristic: most-recent NSDL tables put (Equity Buy, Equity Sell, Net,
  // Debt Buy, Debt Sell, Debt Net). We collapse Buy+Sell to Net sign internally:
  // For "Net" series we take the third numeric (net). For Buy/Sell pairs we
  // subtract.  Different pages expose only some columns — best-effort only.
  return { date, raw: nums, joined };
}

function combineToFlow(row, kind) {
  if (!row) return null;
  const nums = row.raw;
  let equityNet = null, debtNet = null;
  if (kind === "fii" || kind === "fii-fallback") {
    // Try common NSDL shapes:
    if (nums.length >= 6) { equityNet = nums[2]; debtNet = nums[5]; }
    else if (nums.length >= 4) { equityNet = nums[1]; debtNet = nums[3]; }
    else if (nums.length >= 2) { equityNet = nums[0]; }
  } else if (kind === "dii") {
    // DII table typically has only equity buy/sell/net
    if (nums.length >= 3) equityNet = nums[2];
    else if (nums.length >= 2) equityNet = nums[1] - nums[0];
    else if (nums.length >= 1) equityNet = nums[0];
  } else if (kind === "archive") {
    // Archive page may have date + multiple categories. Take rathe first numeric.
    if (nums.length >= 2) { equityNet = nums[0]; debtNet = nums[1]; }
    else if (nums.length >= 1) { equityNet = nums[0]; }
  }
  return { date: row.date, equityNet, debtNet };
}

async function fetchOne(url, kind) {
  try {
    const res  = await get(url, { timeoutMs: 15000 });
    const html = await res.text();
    const tables = extractHtmlTables(html);
    const rows = [];
    for (const t of tables) {
      for (const r of t) {
        const flow = combineToFlow(extractFlowRow(r), kind);
        if (flow && flow.date) rows.push(flow);
      }
    }
    return rows;
  } catch (_) { return []; }
}

exports.handler = async () => {
  // Run URLs serially to keep the request cheap; we'll pull whatever rows we
  // can from each. Most live days only set the "Latest" page so that's first.
  const allRows = [];
  for (const u of URLS) {
    const rows = await fetchOne(u.url, u.kind);
    if (rows.length) {
      allRows.push(...rows.map(r => ({
        date: r.date,
        fii_equity_cr: r.equityNet,
        fii_debt_cr:   r.debtNet,
        dii_equity_cr: u.kind === "dii" ? r.equityNet : null,
        dii_debt_cr:   u.kind === "dii" ? r.debtNet   : null,
      })));
    }
  }

  // De-dupe by date (latest source wins on conflict).
  const byDate = {};
  for (const r of allRows) {
    if (!r.date) continue;
    byDate[r.date] = r;
  }
  const series = Object.values(byDate).sort((a,b) => a.date.localeCompare(b.date));

  // Filter to last 6 months and compute YTD from the same series.
  const today = new Date();
  const sixMonthsAgo = new Date(today); sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const yearStart    = new Date(today.getFullYear(), 0, 1);

  const fmtDate = d => d.toISOString().slice(0,10);
  const recent = series.filter(r => {
    const dt = new Date(r.date);
    return !isNaN(dt.getTime()) && dt >= sixMonthsAgo;
  });
  const ytdRows = series.filter(r => {
    const dt = new Date(r.date);
    return !isNaN(dt.getTime()) && dt >= yearStart;
  });

  const sumKey = (rows, key) => rows.reduce((s, r) => s + (Number(r[key]) || 0), 0);
  const ytd = {
    fii_equity_cr: sumKey(ytdRows, "fii_equity_cr"),
    fii_debt_cr:   sumKey(ytdRows, "fii_debt_cr"),
    dii_equity_cr: sumKey(ytdRows, "dii_equity_cr"),
    dii_debt_cr:   sumKey(ytdRows, "dii_debt_cr"),
  };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=1800" },
    body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source:     "NSDL FII + DII; CDSL fallback",
      status:     series.length ? "ok" : "unavailable",
      count:      series.length,
      series:     recent.map(r => ({
        date: r.date,
        fii_equity_cr: r.fii_equity_cr,
        fii_debt_cr:   r.fii_debt_cr,
        dii_equity_cr: r.dii_equity_cr,
        dii_debt_cr:   r.dii_debt_cr,
      })),
      ytd,
    }),
  };
};
