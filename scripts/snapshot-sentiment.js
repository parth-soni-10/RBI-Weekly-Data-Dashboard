// snapshot-sentiment.js — append today's composite Fear & Greed reading to
// public/sentiment-history.json, building a committed daily history for the
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
//   - Keeps the most recent 400 points (≈ 16 months of trading days).
//
// Fail-open: any error exits 0 with a note on stderr and leaves the existing
// file untouched, so a blocked Yahoo never breaks the deploy or the cron.
//
// Run: node scripts/snapshot-sentiment.js

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "sentiment-history.json");
const MAX_POINTS = 400;

async function main() {
  const { _buildPayload } = require("../netlify/functions/fetch-sentiment");
  let payload;
  try {
    payload = await _buildPayload();
  } catch (e) {
    console.error("ℹ Sentiment snapshot skipped — live quotes unreachable: " + String(e.message || e));
    return; // exit 0, keep existing history
  }
  if (!payload || typeof payload.score !== "number" || !isFinite(payload.score)) {
    console.error("ℹ Sentiment snapshot skipped — no usable composite (status: " + (payload && payload.status) + ")");
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  let history = { updated_at: null, source: payload.source, points: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (prev && Array.isArray(prev.points)) {
      history.points = prev.points.filter(p => p && /^\d{4}-\d{2}-\d{2}$/.test(p.date) && typeof p.score === "number");
      if (prev.source) history.source = prev.source;
    }
  } catch (_) { /* first run — start fresh */ }

  const row = { date: today, score: payload.score, label: payload.label || null };
  const idx = history.points.findIndex(p => p.date === today);
  if (idx >= 0) history.points[idx] = row;
  else history.points.push(row);
  history.points.sort((a, b) => a.date.localeCompare(b.date));
  if (history.points.length > MAX_POINTS) history.points = history.points.slice(-MAX_POINTS);
  history.updated_at = new Date().toISOString();

  fs.writeFileSync(OUT, JSON.stringify(history, null, 2) + "\n");
  console.log(`✓ sentiment-history.json: ${history.points.length} day${history.points.length > 1 ? "s" : ""} · today ${payload.score} (${payload.label})`);
}

main().catch(e => { console.error("ℹ Sentiment snapshot failed (kept existing file): " + String(e.message || e)); });
