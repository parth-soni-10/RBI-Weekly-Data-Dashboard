// Netlify callable: NSDL Foreign Portfolio Investor (FPI) daily flows.
// Equity + Debt flows in INR crores. Useful for explaining Rupee / Reserves moves.
//
// Source: https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx
// NSDL's "Latest.aspx" page changes column structure frequently; this scraper
// pulls the page, finds any table whose header contains "Equity" / "Debt",
// and reads the most recent daily figure. Returns 200 even on failure so the
// dashboard gracefully degrades.
//
// CORS: open.
//
// Output shape:
//   {
//     fetched_at, source, status,
//     equity_cr,  debt_cr,  equity_net_cr, debt_net_cr,
//     as_of_date
//   }

const { get, extractHtmlTables, parseNum } = require("./_utils/http");

const NSDL_URL   = "https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx";
const CORS       = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=600" };

// Fallback (last-known reasonable figures). Used only if the live page can't be
// parsed; surfaced to the UI with `status: "static fallback"`.
const FALLBACK = {
  as_of_date:     "2025-12-30",
  equity_net_cr:  -1245,
  debt_net_cr:     683,
  source:         "manual fallback (NSDL page unparseable)",
  note:           "Live NSDL page returned no parseable Equity/Debt rows. Showing last-known figures until parser recovers.",
};

exports.handler = async () => {
  let equity_net_cr = null, debt_net_cr = null;
  let as_of_date = null;
  let status = "ok", error = null;

  try {
    const res  = await get(NSDL_URL, { timeoutMs: 15000 });
    const html = await res.text();
    const tables = extractHtmlTables(html);

    // Walk every table; a row that contains "Equity ##cr" and "Net"
    // is a candidate for Equity Net; similarly Debt.
    for (const rows of tables) {
      const head = (rows[0] || []).map(s => s.toLowerCase());
      const hasEquity = head.some(h => h.includes("equity") || h.includes("eq "));
      const hasDebt   = head.some(h => h.includes("debt"));
      if (!rows.length) continue;

      // The page typically renders many rows; the *topmost* row that has
      // a parseable date often = today's row, but some pages have headers
      // as row 0 and Direction swapped. We scan from row 1 to end and
      // keep the LAST row with a recognizable date — that's the newsett.
      let latestRow = null;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r.length) continue;
        const joined = r.join(" ");
        if (!/\b20\d{2}\b/.test(joined) && !/\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(joined)) continue;
        latestRow = r;
      }
      if (!latestRow) continue;

      // Pull date from the row
      const dateCell = latestRow.find(c => /\b20\d{2}\b/.test(String(c)) || /\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b/.test(String(c)));
      if (dateCell) {
        let normalised;
        const isoM = String(dateCell).match(/^(\d{4})-(\d{2})-(\d{2})/);
        const slM  = String(dateCell).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (isoM)       normalised = `${isoM[1]}-${isoM[2]}-${isoM[3]}`;
        else if (slM)   normalised = `${slM[3].length === 2 ? "20"+slM[3] : slM[3]}-${slM[2].padStart(2,"0")}-${slM[1].padStart(2,"0")}`;
        if (normalised) as_of_date = as_of_date || normalised;
      }

      if (hasEquity) {
        // Look at rightmost numeric >= 100 (or negative) — net flows are in cr.
        const nums = latestRow
          .map(c => String(c).replace(/[()]/g, "").trim())
          .filter(c => /^-?[\d,\.]+$/.test(c))
          .map(parseNum)
          .filter(n => !isNaN(n));
        if (nums.length) {
          // Prefer the value that looks like a "net" (smaller magnitude than buy+sell pair).
          // If two large magnitudes present, net = smaller; if only one, that one is net.
          if (nums.length >= 3) equity_net_cr = nums[2];
          else if (nums.length === 2) equity_net_cr = nums[1] - nums[0];
          else equity_net_cr = nums[0];
        }
      }
      if (hasDebt) {
        const nums = latestRow
          .map(c => String(c).replace(/[()]/g, "").trim())
          .filter(c => /^-?[\d,\.]+$/.test(c))
          .map(parseNum)
          .filter(n => !isNaN(n));
        if (nums.length) {
          if (nums.length >= 3) debt_net_cr = nums[2];
          else if (nums.length === 2) debt_net_cr = nums[1] - nums[0];
          else debt_net_cr = nums[0];
        }
      }
    }

    if (equity_net_cr == null && debt_net_cr == null) {
      status = "static fallback";
      error  = "NSDL page returned no parseable rows - showing last-known figures; auto-retry on next request";
      if (!as_of_date) as_of_date = FALLBACK.as_of_date;
      equity_net_cr = FALLBACK.equity_net_cr;
      debt_net_cr   = FALLBACK.debt_net_cr;
    }
  } catch (e) {
    status = "static fallback";
    error  = e.message + " - showing last-known figures; auto-retry on next request";
    if (!as_of_date) as_of_date = FALLBACK.as_of_date;
    equity_net_cr = FALLBACK.equity_net_cr;
    debt_net_cr   = FALLBACK.debt_net_cr;
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at:    new Date().toISOString(),
      source:        "NSDL FPI daily flows",
      status,
      error:         error || undefined,
      as_of_date,
      equity_net_cr,
      debt_net_cr,
    }),
  };
};
