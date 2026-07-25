// Public JSON API — returns ONLY the most recent RBI weekly record.
// Single scrape (not the full historical loop), so this is cheap enough
// to serve as an embeddable data source.
//
// GET /data/latest.json  →  { record, fetched_at, source }
//
// Cache-Control is conservative so a popular embed doesn't burn Netlify
// invocations; if you want fresher data, force-refresh via a cache-buster
// or set Cache-Control shorter in your _headers file.

const { _getFridays, _processOne } = require("./fetch-data");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Cache-Control":                 "public, max-age=900", // 15 min
  "Content-Type":                  "application/json",
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    const fridays = _getFridays();
    if (!fridays.length) {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "no fridays in range" }) };
    }
    // Walk backward through the most recent fridays until we get a successful
    // record. The most recent one may have an error (RBI not yet published,
    // or temporary outage), so we tolerate a few empty/skipped weeks.
    let result = null;
    for (let i = fridays.length - 1; i >= Math.max(0, fridays.length - 6); i--) {
      result = await _processOne(fridays[i]);
      if (result && result.record) break;
    }

    if (!result || !result.record) {
      // No record found in the 6 most recent fridays — distinct signal a
      // embed can branch on, separate from "RBI is offline entirely".
      return {
        statusCode: 503,
        headers: CORS,
        body: JSON.stringify({
          fetched_at: new Date().toISOString(),
          source:     "RBI Weekly Statistical Supplement",
          status:     "no_recent_data",
          record:     null,
          iso:        null,
          error:      "no record found in the most recent 6 fridays",
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "RBI Weekly Statistical Supplement",
        status:     "ok",
        record:     result.record,
        iso:        result.iso,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
