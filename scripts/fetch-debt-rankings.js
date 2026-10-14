#!/usr/bin/env node
/**
 * fetch-debt-rankings.js — regenerate public/external-debt.json.
 *
 * Pulls the world's biggest-borrower ranking (gross external-debt stock,
 * World Bank Quarterly External Debt Statistics, SDDS+GDDS) plus each
 * economy's official FX reserves (WDI FI.RES.TOTL.CD, for debt-cover
 * ratios) from the live World Bank API and writes it as a static file the
 * dashboard ships with.
 *
 * Runs in the weekly refresh (npm run refresh, and the Friday workflow — this
 * was the Netlify build command before that), so every run re-pulls the
 * authenticated source.
 *
 * Fails open: on network/parse errors the committed file is refreshed from
 * the function's curated fallback (clearly flagged), never left stale and
 * never deleted — a slow/blocked api.worldbank.org can't break a refresh.
 *
 * buildExternalDebtFile() is the whole job as a pure function, so the CLI and
 * the weekly refresh produce the same bytes.
 *
 * Usage:
 *   node scripts/fetch-debt-rankings.js
 *   npm run fetch:debt
 */
const fs = require("fs");
const path = require("path");

// CLI path only — the weekly refresh commits the text the builder returns.
// `__dirname` does not exist in a Worker, hence the guard (see
// scripts/update-fwd-monthly.js for the same trap).
const OUT = typeof __dirname === "string" ? path.join(__dirname, "..", "public", "external-debt.json") : "";
const { _buildPayload, _fallbackPayload } = require("../netlify/functions/fetch-external-debt");

/** → { text, payload, note, detail }. Throws only on a bug — both failures below are data. */
async function buildExternalDebtFile() {
  let payload;
  let note = "live World Bank API";
  try {
    payload = await _buildPayload();
  } catch (e) {
    payload = _fallbackPayload(e.message || "World Bank API unreachable");
    note = "curated fallback (API unreachable)";
  }

  // The file this builder lives in. The weekly refresh drives it too, but no
  // per-run stamp goes in here: a value that names the caller would make the
  // file differ every week and commit on every run.
  payload.generated_by = "scripts/fetch-debt-rankings.js";

  const top = payload.top_borrowers[0];
  return {
    text: JSON.stringify(payload, null, 2),
    payload,
    note,
    detail:
      `${note} · #1 ${top.name} $${top.value_bn}bn (${top.period}) · ` +
      `India #${payload.india.rank} $${payload.india.value_bn}bn (${payload.india.period}) · ` +
      `${payload.top_borrowers.length} of ${payload.ranked_count} ranked economies`,
  };
}

async function main() {
  const { text, detail } = await buildExternalDebtFile();
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`✅ Wrote external-debt.json (${detail})`);
}

if (require.main === module) {
  main().catch(e => {
    console.error("❌ fetch-debt-rankings failed:", e.message);
    process.exit(1);
  });
}

module.exports = { buildExternalDebtFile };
