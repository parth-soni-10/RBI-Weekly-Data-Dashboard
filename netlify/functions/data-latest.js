// Public JSON API — returns ONLY the most recent RBI weekly record.
//
// GET /data/latest.json  →  { record, fetched_at, source }
//
// The record comes from the committed weekly snapshot (public/rbi-data.json),
// not from a scrape on request. This endpoint used to walk back up to six
// Fridays, hitting RBI's WSS page and Excel for each one; on Cloudflare a cold
// request ran that whole path and timed out long before it could answer, since
// a Worker response is only edge-cached when the handler stores it. The
// snapshot is already refreshed every Friday by the weekly pipeline and shipped
// by the deploy, so serving it is both fresher than a lucky scrape and instant.
//
// Cache-Control stays conservative; the edge layer in functions/_router.js
// holds the answer for max-age.

const { setAssets, readRbiData, datedRecords } = require("./_utils/committed");

const CORS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Cache-Control":                 "public, max-age=900", // 15 min
  "Content-Type":                  "application/json",
};

// Never cache failure responses — an unavailable snapshot shouldn't keep
// serving an error for 15 minutes once it is back.
const ERR_HEADERS = { ...CORS, "Cache-Control": "no-store" };

exports.setAssets = setAssets;

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  try {
    const data = await readRbiData(event.rawUrl);
    const records = datedRecords(data);
    if (!records.length) {
      return {
        statusCode: 503,
        headers: ERR_HEADERS,
        body: JSON.stringify({
          fetched_at: new Date().toISOString(),
          source:     "RBI Weekly Statistical Supplement",
          status:     "no_recent_data",
          record:     null,
          iso:        null,
          error:      "the committed RBI snapshot has no dated records - the weekly refresh has not produced one yet",
        }),
      };
    }

    const record = records[records.length - 1];
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        fetched_at:          new Date().toISOString(),
        snapshot_updated_at: data.data_updated_at || data.fetched_at || null,
        source:              "RBI Weekly Statistical Supplement",
        status:              "ok",
        record,
        iso:                 record.date,
      }),
    };
  } catch (err) {
    return {
      statusCode: 503,
      headers: ERR_HEADERS,
      body: JSON.stringify({
        status: "unavailable",
        record: null,
        iso:    null,
        error:  `the committed RBI snapshot is unavailable - ${(err && err.message) || err}`,
      }),
    };
  }
};
