// Netlify scheduled/cron-callable: NSDL Foreign Portfolio Investor (FPI) daily flows.
// Equity + Debt flows in INR crores. Useful for explaining Rupee / Reserves moves.
//
// NSDL publishes these on https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx
// Layout fluctuates; contract here is monotonic best-effort: pull the page, look
// for tables containing "Equity" and "Debt", pick the latest daily row.
//
// CORS: open. Returns shape:
//   { fetched_at, source, equity_cr, debt_cr, equity_net_cr, debt_net_cr }

const { get, extractHtmlTables, parseNum } = require("./_utils/http");

const NSDL_URL = "https://www.fpi.nsdl.co.in/web/Reports/Latest.aspx";

exports.handler = async () => {
  try {
    const res  = await get(NSDL_URL, { timeoutMs: 15000 });
    const html = await res.text();
    const tables = extractHtmlTables(html);

    let equity_cr = null, debt_cr = null;
    let equity_net_cr = null, debt_net_cr = null;

    for (const rows of tables) {
      const head = rows[0]?.map(s => s.toLowerCase()) || [];
      if (head.includes("equity") || head.some(h => h.includes("equity"))) {
        // Find column indices once
        const eqIdx = head.findIndex(h => h.includes("equity"));
        const netIdx = head.findIndex(h => h.startsWith("net"));
        const lastRow = rows[rows.length - 1];
        if (eqIdx >= 0) equity_cr     = parseNum(lastRow[eqIdx]);
        if (netIdx >= 0) equity_net_cr = parseNum(lastRow[netIdx]);
      }
      if (head.includes("debt") || head.some(h => h.includes("debt"))) {
        const dIdx = head.findIndex(h => h.includes("debt"));
        const netIdx = head.findIndex(h => h.startsWith("net"));
        const lastRow = rows[rows.length - 1];
        if (dIdx >= 0) debt_cr     = parseNum(lastRow[dIdx]);
        if (netIdx >= 0) debt_net_cr = parseNum(lastRow[netIdx]);
      }
    }

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=1800",
      },
      body: JSON.stringify({
        fetched_at:   new Date().toISOString(),
        source:       "NSDL FPI daily flows",
        equity_cr,    debt_cr,
        equity_net_cr, debt_net_cr,
      }),
    };
  } catch (e) {
    // Graceful degradation: return nulls + error string so UI can show "unavailable".
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=300",
      },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "NSDL FPI daily flows",
        status:     "unavailable",
        error:      e.message,
        equity_cr:    null, debt_cr:    null,
        equity_net_cr: null, debt_net_cr: null,
      }),
    };
  }
};
