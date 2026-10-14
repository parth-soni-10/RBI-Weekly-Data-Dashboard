// snapshot-sentiment.js — append today's composite Fear & Greed reading to
// public/sentiment-history.json, building a committed history for the
// dashboard's sentiment chart (same pattern as fetch-debt-rankings.js
// committing external-debt.json from the live World Bank API).
//
// How it works:
//   - Reuses fetch-sentiment's _buildPayload (the exact six-signal composite
//     the live gauge serves) so the history and the meter can never diverge.
//   - One row per calendar date; today's row is UPDATED in place on every
//     run, so the last run of a day wins (intraday readings move with the
//     market; after close they settle).
//   - Only rows with a numeric score are stored; degraded payloads
//     (static fallback / unavailable) are skipped — a rate-limited run must
//     not write a stale score under today's date.
//   - Keeps the most recent 400 points (one point per weekly refresh, so
//     ≈ 7.7 years).
//   - When the new reading leaves the points unchanged, the file is returned
//     verbatim: a refresh that learned nothing new must not commit a
//     timestamp-only diff.
//
// buildSentimentFile() is the whole job as a pure function of the file's
// current text, so the CLI and the weekly refresh produce the same bytes.
//
// Fail-open: any error exits 0 with a note on stderr and leaves the existing
// file untouched, so a blocked Yahoo never breaks a refresh.
//
// Run: node scripts/snapshot-sentiment.js
const fs = require("fs");
const path = require("path");
const { _buildPayload } = require("../netlify/functions/fetch-sentiment");

// CLI path only — the weekly refresh commits the text the builder returns.
// `__dirname` does not exist in a Worker, hence the guard (see
// scripts/update-fwd-monthly.js for the same trap).
const OUT = typeof __dirname === "string" ? path.join(__dirname, "..", "public", "sentiment-history.json") : "";
const MAX_POINTS = 400;

/** prevText + a live payload → { text, changed, points, row }. */
function mergeSentimentHistory(prevText, payload) {
  let history = { updated_at: null, source: payload.source, points: [] };
  let hadPrior = false;
  try {
    const prev = JSON.parse(prevText);
    if (prev && Array.isArray(prev.points)) {
      hadPrior = true;
      history.points = prev.points.filter(p => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.score === "number");
      if (prev.source) history.source = prev.source;
    }
  } catch (_) { /* first run — start fresh */ }

  const today = new Date().toISOString().slice(0, 10);
  const row = { date: today, score: payload.score, label: payload.label || null };
  const idx = history.points.findIndex(p => p.date === today);
  if (idx >= 0) history.points[idx] = row;
  else history.points.push(row);
  history.points.sort((a, b) => a.date.localeCompare(b.date));
  if (history.points.length > MAX_POINTS) history.points = history.points.slice(-MAX_POINTS);

  // Nothing new (a second run the same day) → hand back the file as it stands.
  let prevPoints = null;
  try { prevPoints = JSON.parse(prevText).points; } catch (_) { /* no prior file */ }
  const changed = !hadPrior || JSON.stringify(prevPoints) !== JSON.stringify(history.points);
  if (!changed) return { text: prevText, changed: false, points: history.points.length, row };

  history.updated_at = new Date().toISOString();
  return { text: JSON.stringify(history, null, 2) + "\n", changed: true, points: history.points.length, row };
}

/** → { text|null, detail }. text is null when there is nothing usable to write. */
async function buildSentimentFile({ priorText = null } = {}) {
  let payload;
  try {
    payload = await _buildPayload();
  } catch (e) {
    return { text: null, detail: `skipped — live quotes unreachable (${String((e && e.message) || e)})` };
  }
  if (!payload || typeof payload.score !== "number" || !isFinite(payload.score)) {
    return { text: null, detail: `skipped — no usable composite (status: ${payload && payload.status})` };
  }

  const merged = mergeSentimentHistory(priorText, payload);
  return {
    text: merged.text,
    detail: `${merged.points} day${merged.points === 1 ? "" : "s"} · today ${merged.row.score} (${merged.row.label})`,
    changed: merged.changed,
  };
}

async function main() {
  let priorText = null;
  try { priorText = fs.readFileSync(OUT, "utf8"); } catch (_) { /* first run */ }
  const res = await buildSentimentFile({ priorText });
  if (!res.text) { console.error(`ℹ Sentiment snapshot skipped — ${res.detail}`); return; }
  fs.writeFileSync(OUT, res.text);
  console.log(`✓ sentiment-history.json: ${res.detail}`);
}

if (require.main === module) {
  main().catch(e => {
    console.error("ℹ Sentiment snapshot failed (kept existing file): " + String((e && e.message) || e));
  });
}

module.exports = { buildSentimentFile, mergeSentimentHistory };
