// fetch-fwd-latest.js — on-demand live check of the newest official RBI forward
// figure, for the dashboard's Reload button.
//
// The committed forward series (FWD_SERIES in fetch-fx-intervention.js) is
// refreshed by the daily cron and every deploy (scripts/update-fwd-monthly.js
// + update-fwd-series.js). Between those runs, Reload calls this function,
// which re-runs the exact same discovery + parsing against the RBI Bulletin's
// newest Table 4A and returns the figure — the frontend appends it in-memory
// when it's newer than the series tail. Never writes to the series file; the
// real append/upgrade stays with the scripts.
//
//   GET /.netlify/functions/fetch-fwd-latest
//     → { date: "2026-07", net_fwd: -136.77, source: "...", asOn: "July 31, 2026" }
//     → { error: "no-table" | "unparseable" | <message> }
const { fetchLatestOfficial } = require("../../scripts/update-fwd-monthly.js");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };

exports.handler = async () => {
  try {
    const latest = await fetchLatestOfficial();
    if (latest.error) {
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ error: latest.error }) };
    }
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        date: latest.date,
        net_fwd: latest.netFwd,
        source: latest.source,
        asOn: latest.asOn,
      }),
    };
  } catch (err) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: err.message }) };
  }
};