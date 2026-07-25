// RBI FX Forward Book / Intervention.
// RBI publishes a monthly Bulletin with a "Forward Position" table that
// essentially shows net USD forwards sold/bought by RBI \u2014 the closest public
// proxy for FX intervention. Also publishable in the DBIE Handbook.
//
// URLs to try:
//   https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx  (current month bulletin)
//   https://dbie.rbi.org.in/DBIE/dbie.rbi?site=statistics
//
// Best-effort text scrape; downside: HTML layout changes often. We extract any
// numeric pairs that look like forward positions and return the most recent.

const { get, extractHtmlTables, parseNum } = require("./_utils/http");

const RBI_BULLETIN_URL = "https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx";

exports.handler = async () => {
  try {
    const res  = await get(RBI_BULLETIN_URL, { timeoutMs: 15000 });
    const html = await res.text();
    const tables = extractHtmlTables(html);

    let spot_fwd = null, forward_fwd = null, net_fwd = null;

    for (const rows of tables) {
      for (const row of rows) {
        const joined = row.join(" ").toLowerCase();
        if (joined.includes("forward") && (joined.includes("usd") || joined.includes("dollar") || joined.includes("$"))) {
          // Take first numeric >=1 in the row as forward USD bn (typical order of magnitude)
          for (const cell of row) {
            const n = parseNum(cell);
            if (!isNaN(n) && Math.abs(n) > 0 && Math.abs(n) < 200) {
              if (net_fwd == null) net_fwd = n;
              else if (forward_fwd == null) forward_fwd = n;
              else if (spot_fwd == null) spot_fwd = n;
              break;
            }
          }
        }
      }
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        fetched_at:   new Date().toISOString(),
        source:       "RBI Monthly Bulletin: Forward Position of the Rupee",
        spot_fwd, forward_fwd, net_fwd,
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "RBI Forward Position",
        status:     "unavailable",
        error:      e.message,
        spot_fwd: null, forward_fwd: null, net_fwd: null,
      }),
    };
  }
};
