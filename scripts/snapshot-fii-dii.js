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
//   - When the merge changes nothing, the file is returned verbatim, so a quiet
//     run produces no commit churn (and no timestamp-only diff).
//
// buildFiiHistoryFile() is the whole job as a pure function of the file's
// current text, so the CLI and the scheduled Worker produce the same bytes.
//
// Fail-open: any error exits 0 with a note on stderr and leaves the existing
// file untouched, so a blocked NSDL/NSE never breaks a refresh.
//
// Run: node scripts/snapshot-fii-dii.js
const fs = require("fs");
const path = require("path");
const { _buildPayload } = require("../netlify/functions/fetch-fii-history");

// CLI path only — the scheduled Worker commits the text the builder returns.
// `__dirname` does not exist in a Worker, hence the guard (see
// scripts/update-fwd-monthly.js for the same trap).
const OUT = typeof __dirname === "string" ? path.join(__dirname, "..", "public", "fii-dii-history.json") : "";
const MAX_ROWS = 400;

/** prevText + a live payload → { text, changed, rows }. */
function mergeFiiHistory(prevText, payload) {
  let prev = null;
  try { prev = JSON.parse(prevText); } catch (_) { /* first run */ }

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

  const changed = !(prev && JSON.stringify(prev.series) === JSON.stringify(series));
  if (!changed) return { text: prevText, changed: false, rows: series.length };

  const next = { updated_at: new Date().toISOString(), source: payload.source, series };
  return { text: JSON.stringify(next, null, 2) + "\n", changed: true, rows: series.length, newest: series[series.length - 1].date };
}

/** → { text|null, detail }. text is null when there is nothing usable to write. */
async function buildFiiHistoryFile({ priorText = null } = {}) {
  let payload;
  try {
    payload = await _buildPayload();
  } catch (e) {
    return { text: null, detail: `skipped — sources unreachable (${String((e && e.message) || e)})` };
  }
  if (!payload || payload.status !== "ok" || !Array.isArray(payload.series) || !payload.series.length) {
    return { text: null, detail: `skipped — no live rows (status: ${payload && payload.status})` };
  }

  const merged = mergeFiiHistory(priorText, payload);
  return {
    text: merged.text,
    detail: `${merged.rows} rows${merged.newest ? ` · newest ${merged.newest}` : ""}`,
    changed: merged.changed,
  };
}

async function main() {
  let priorText = null;
  try { priorText = fs.readFileSync(OUT, "utf8"); } catch (_) { /* first run */ }
  const res = await buildFiiHistoryFile({ priorText });
  if (!res.text) { console.error(`ℹ FII/DII snapshot skipped — ${res.detail}`); return; }
  fs.writeFileSync(OUT, res.text);
  console.log(`✓ fii-dii-history.json: ${res.detail}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error("ℹ FII/DII snapshot failed (kept existing file): " + String((e && e.message) || e));
  });
}

module.exports = { buildFiiHistoryFile, mergeFiiHistory };
