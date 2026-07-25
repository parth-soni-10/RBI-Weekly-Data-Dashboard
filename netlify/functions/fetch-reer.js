// INR Real Effective Exchange Rate (36-country basket, RBI).
// REER captures whether a currency is genuinely over/under-valued vs spot USD.
// RBI publishes monthly in the DBIE Handbook and a Reserve Bank Quarterly
// publication.
//
// Endpoints to try:
//   https://dbie.rbi.org.in/DBIE/dbie.rbi?site=statistics
//   https://rbi.org.in/Scripts/PublicationsView.aspx?id=...
//
// Returns the last 12 months where parsing succeeds, otherwise nulls.
//
// Output shape:
//   { fetched_at, source, reer_36: [{ date, value }], latest, latest_date }

const { get, extractHtmlTables, parseNum } = require("./_utils/http");

const DBIE_URL = "https://dbie.rbi.org.in/DBIE/dbie.rbi?site=statistics";

exports.handler = async () => {
  try {
    const res  = await get(DBIE_URL, { timeoutMs: 15000 });
    const html = await res.text();
    const tables = extractHtmlTables(html);

    const series = [];
    for (const rows of tables) {
      for (const row of rows) {
        const joined = row.join(" ").toLowerCase();
        if ((joined.includes("reer") || joined.includes("real effective exchange")) &&
            row.some(cell => /\\b\\d{2,4}\\.\\d+\\b/.test(String(cell)))) {
          series.push(row);
        }
      }
    }

    const points = series.slice(-12).map(row => {
      const date = row.find(c => /\\b20\\d{2}\\b/.test(c)) || null;
      const val  = row.map(parseNum).find(n => !isNaN(n) && n > 50 && n < 200) || null;
      return date && val != null ? { date, value: +val.toFixed(2) } : null;
    }).filter(Boolean);

    const latest = points[points.length - 1] || null;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "RBI DBIE: REER (36-country)",
        reer_36:    points,
        latest:     latest?.value  ?? null,
        latest_date:latest?.date   ?? null,
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "RBI DBIE: REER (36-country)",
        status:     "unavailable",
        error:      e.message,
        reer_36:   [],
        latest:    null,
        latest_date:null,
      }),
    };
  }
};
