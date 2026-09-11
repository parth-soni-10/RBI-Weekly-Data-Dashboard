#!/usr/bin/env node
/**
 * fetch-debt-rankings.js — regenerate public/external-debt.json.
 *
 * Pulls the world's biggest-borrower ranking (gross external-debt stock,
 * World Bank Quarterly External Debt Statistics, SDDS+GDDS) from the live
 * World Bank API and writes it as a static file the dashboard ships with.
 * Runs on every deploy (netlify.toml build command) and in the daily GitHub
 * cron (refresh-data.yml), so every run re-pulls the authenticated source.
 *
 * Fails open: on network/parse errors the committed file is refreshed from
 * the function's curated fallback (clearly flagged), never left stale and
 * never deleted — a slow/blocked api.worldbank.org can't break a deploy.
 *
 * Usage:
 *   node scripts/fetch-debt-rankings.js
 *   npm run fetch:debt
 */
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "public", "external-debt.json");
const { _buildPayload, _fallbackPayload } = require("../netlify/functions/fetch-external-debt");

async function main() {
  let payload;
  let note = "live World Bank API";
  try {
    payload = await _buildPayload();
  } catch (e) {
    payload = _fallbackPayload(e.message || "World Bank API unreachable");
    note = "curated fallback (API unreachable)";
  }

  payload.generated_by = "scripts/fetch-debt-rankings.js";
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  console.log(
    `✅ Wrote external-debt.json (${note}) · #1 ${payload.top_borrowers[0].name} ` +
    `$${payload.top_borrowers[0].value_bn}bn (${payload.top_borrowers[0].period}) · ` +
    `India #${payload.india.rank} $${payload.india.value_bn}bn (${payload.india.period}) · ` +
    `${payload.top_borrowers.length} of ${payload.ranked_count} ranked economies`
  );
}

main().catch(e => {
  console.error("❌ fetch-debt-rankings failed:", e.message);
  process.exit(1);
});
