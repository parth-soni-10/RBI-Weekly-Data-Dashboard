// Public JSON API - returns an array of the last N RBI weekly records,
// just enough to chart forex reserves / gold / rupee trendlines.
// Defaults to 8 weeks, overridable via ?weeks=N (capped at MAX_WEEKS).
//
// GET /data/forex-weekly.json[?weeks=8]  →  { records: [...], weeks: 8, fetched_at }
//
// Served from the committed weekly snapshot (public/rbi-data.json) rather than
// scraped on request: the old version ran N sequential RBI scrapes here, which
// on Cloudflare (no implicit CDN cache in front of a Worker) meant a cold
// request spent a minute or more fetching weeks it could read from the file.
// The snapshot is refreshed every Friday by the pipeline and shipped by the
// deploy, so this is both faster and no staler.

const { setAssets, readRbiData, datedRecords } = require("./_utils/committed");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Cache-Control":                 "public, max-age=1800", // 30 min
  "Content-Type":                  "application/json",
};

// Page size for a single call. Override with MAX_WEEKS to serve a longer
// trendline; the snapshot already holds the full history.
const MAX_WEEKS = parseInt(process.env.MAX_WEEKS || "8");

exports.setAssets = setAssets;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const qs = event.queryStringParameters || {};
  const n  = Math.min(MAX_WEEKS, Math.max(1, parseInt(qs.weeks ?? "8") || 8));

  try {
    const data = await readRbiData(event.rawUrl);
    const records = datedRecords(data).slice(-n).map(r => ({ iso: r.date, ...r }));
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        fetched_at:          new Date().toISOString(),
        snapshot_updated_at: data.data_updated_at || data.fetched_at || null,
        source:              "RBI Weekly Statistical Supplement",
        weeks:               n,
        status:              records.length ? "ok" : "error",
        records,
      }),
    };
  } catch (err) {
    return {
      statusCode: 503,
      headers: { ...CORS, "Cache-Control": "no-store" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "RBI Weekly Statistical Supplement",
        weeks:      n,
        status:     "unavailable",
        records:    [],
        error:      `the committed RBI snapshot is unavailable - ${(err && err.message) || err}`,
      }),
    };
  }
};
