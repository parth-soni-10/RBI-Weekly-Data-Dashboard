// snapshot-fii-dii.js — merge the latest NSDL FII + NSE DII daily flow rows
// into public/fii-dii-history.json, building the committed daily history the
// dashboard's FII/DII chart renders (same pattern as snapshot-sentiment.js →
// sentiment-history.json).
//
// How it works:
//   - Reuses fetch-fii-history's _buildPayload (the exact rows the live
//     endpoint serves) so the chart, the tiles and the history file can never
//     diverge.
//   - One row per trading date; each run overlays its rows field-by-field, so
//     a DII-only row (NSE publishes one session behind NSDL) never erases the
//     equity/debt split already stored for that date, and later runs correct
//     the same day's provisional figures in place.
//   - Degraded payloads (static fallback / zero rows — curated or empty) are
//     skipped: fabricated bars must never enter the accumulated history.
//   - Keeps the most recent 400 rows (≈ 19 months of trading days, enough for
//     a rolling 6-month chart window plus a full-year YTD sum).
//   - Writes only when the series actually changed, so a quiet weekend run
//     produces no commit churn.
//
// Fail-open: any error exits 0 with a note on stderr and leaves the existing
// file untouched, so a blocked NSDL/NSE never breaks the deploy or the cron.
//
// Run: node scripts/snapshot-fii-dii.js

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "fii-dii-history.json");
const MAX_ROWS = 400;

async function main() {
  const { _buildPayload } = require("../netlify/functions/fetch-fii-history");
  let payload;
  try {
    payload = await _buildPayload();
  } catch (e) {
    console.error("ℹ FII/DII snapshot skipped — sources unreachable: " + String(e.message || e));
    return; // exit 0, keep existing history
  }
  if (!payload || payload.status !== "ok" || !Array.isArray(payload.series) || !payload.series.length) {
    console.error("ℹ FII/DII snapshot skipped — no live rows (status: " + (payload && payload.status) + ")");
    return;
  }

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch (_) { /* first run */ }
  const byDate = {};
  if (prev && Array.isArray(prev.series)) {
    for (const r of prev.series) {
      if (r && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) byDate[r.date] = r;
    }
  }

  for (const r of payload.series) {
    const cur = byDate[r.date] || (byDate[r.date] = { date: r.date });
    for (const k of Object.keys(r)) if (r[k] != null) cur[k] = r[k];
  }

  let series = Object.values(byDate).sort((a, b) => a.date.localeCompare(b.date));
  if (series.length > MAX_ROWS) series = series.slice(-MAX_ROWS);

  const next = { updated_at: new Date().toISOString(), source: payload.source, series };
  if (prev && JSON.stringify(prev.series) === JSON.stringify(series)) {
    console.log(`✓ fii-dii-history.json unchanged: ${series.length} rows (newest ${series[series.length - 1].date})`);
    return;
  }

  fs.writeFileSync(OUT, JSON.stringify(next, null, 2) + "\n");
  console.log(`✓ fii-dii-history.json: ${series.length} row${series.length > 1 ? "s" : ""} · newest ${series[series.length - 1].date} · ${payload.source}`);
}

main().catch(e => { console.error("ℹ FII/DII snapshot failed (kept existing file): " + String(e.message || e)); });
