// Public JSON API — returns an array of the last N RBI weekly records,
// just enough to chart forex reserves / gold / rupee trendlines.
// Defaults to 12 weeks (~one quarter), overridable via ?weeks=N (max 52).
// Each call scrapes N weekly Excels in series; budget ~3-4s per week.
//
// GET /data/forex-weekly.json[?weeks=12]  →  { records: [...], weeks: 12, fetched_at }

const { _getFridays, _processOne } = require("./fetch-data");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Cache-Control":                 "public, max-age=1800", // 30 min
  "Content-Type":                  "application/json",
};

// Conservative cap to fit Netlify's 26s free-tier function timeout (~3-4s per
// week × sequential scraping). Override with MAX_WEEKS env var if you move to a
// paid tier with longer timeouts. The 30-min Cache-Control softens the impact.
const MAX_WEEKS = parseInt(process.env.MAX_WEEKS || "8");

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const qs  = event.queryStringParameters || {};
  const n   = Math.min(MAX_WEEKS, Math.max(1, parseInt(qs.weeks ?? "12")));
  const fridays = _getFridays();
  const slice   = fridays.slice(-n);

  const out = [];
  for (const f of slice) {
    try {
      const r = await _processOne(f);
      if (r && r.record) {
        out.push({ iso: r.iso, ...r.record });
      }
    } catch (_) { /* skip */ }
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source:     "RBI Weekly Statistical Supplement",
      weeks:      n,
      records:    out,
    }),
  };
};
