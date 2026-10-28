#!/usr/bin/env node
/**
 * fetch-all.js - regenerate public/rbi-data.json with ALL RBI weekly records.
 *
 * Reuses the scraper internals from netlify/functions/fetch-data.js
 * (_getFridays + _processOne) so parsing stays in one place.
 *
 * Behaviour:
 *   - Reads the existing public/rbi-data.json (if any) and only fetches weeks
 *     NEWER than the newest record already in the file - each run just adds
 *     what's new ("update it every run").
 *   - On a full first run (no file), fetches every Friday from the start year
 *     (default: the current year).
 *   - Auto-extends across calendar years: once data exists, the Friday list is
 *     anchored on the year of the OLDEST record, so a week published in late
 *     Dec of year N that is first fetched in Jan of year N+1 is still in range
 *     and gets picked up instead of being skipped forever.
 *   - Merges + dedupes by date, sorts ascending, writes the file back.
 *
 * buildRbiDataFile() is that whole job as a pure function of the text already on
 * disk, because the weekly refresh (netlify/functions/refresh-data.js) runs it
 * against the copy the repository holds - one implementation, so a refresh can
 * only ever write the JSON this CLI writes. main() is the file I/O around it.
 *
 * Usage:
 *   node scripts/fetch-all.js [startYear] [--limit=N]
 *   npm run fetch:data
 */
const fs = require("fs");
const path = require("path");
const { _getFridays, _processOne } = require("../netlify/functions/fetch-data");

// Where the CLI writes. The weekly refresh imports the builder below and reads
// its "prior" text from the repository instead, and in a Worker `__dirname` is not
// a binding at all - the `typeof` guard is what keeps this module importable there
// (scripts/update-fwd-monthly.js documents the same trap). Only main() reads OUT.
const OUT = typeof __dirname === "string" ? path.join(__dirname, "..", "public", "rbi-data.json") : "";

function iso(d) {
  return d.toISOString().slice(0, 10);
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Produce the rbi-data.json document from the file's current text.
 *
 * `priorText` is the committed file (null when there is none). `limit` caps how
 * many weeks one call fetches: the weekly refresh has a wall-clock budget, so
 * a long backlog drains over a few runs instead of being killed mid-scrape with
 * nothing to show. Returns the exact text to write, plus the numbers to log.
 */
async function buildRbiDataFile({ priorText = null, startYear = null, limit = null, log = () => {} } = {}) {
  // 1. Prior records (kept on transient failures so the file never goes empty).
  let prior = [];
  let priorDoc = null;
  try {
    const parsed = JSON.parse(priorText);
    if (parsed && Array.isArray(parsed.records)) { prior = parsed.records; priorDoc = parsed; }
  } catch (_) { /* no prior file - first run */ }

  const curYear = new Date().getFullYear();
  const wanted = Number.isFinite(startYear) ? startYear : null;

  // Anchor the Friday list on the oldest record's year when data already
  // exists (covers year-boundary weeks), else use the requested/current year.
  let anchor;
  if (prior.length) {
    const oldestYear = prior.reduce((acc, r) => Math.min(acc, parseInt(String(r.date).slice(0, 4), 10) || curYear), curYear);
    anchor = Math.min(wanted || curYear, oldestYear);
  } else {
    anchor = wanted || curYear;
  }

  const fridays = _getFridays(`${anchor}-01-01`);
  const newestDate = prior.length ? prior.map(r => r.date).sort().pop() : null;

  // 2. Only fetch weeks newer than what we already have.
  //    Records are labelled with their "as on" Friday (publication - 7 days),
  //    so the next week to fetch is the one whose as-on date is > newestDate + 7
  //    (i.e. publication Friday strictly after the newest publication we have).
  let todo = fridays;
  if (newestDate) {
    const nextPub = new Date(newestDate + "T00:00:00Z");
    nextPub.setUTCDate(nextPub.getUTCDate() + 7); // = newest publication Friday
    const nextIso = iso(nextPub);
    todo = fridays.filter(f => iso(f) > nextIso);
  }
  const pending = todo.length;
  if (limit && limit > 0) todo = todo.slice(0, limit);

  log(`Start year: ${anchor} · ${fridays.length} Fridays in range · ${prior.length} already on file · ${todo.length} to fetch`);

  const fresh = [];
  for (const f of todo) {
    const res = await _processOne(f);
    if (res.record) {
      fresh.push(res.record);
      log(`✓ ${res.record.date} | Reserves $${res.record.total_usd?.toLocaleString()}M | USD/INR ${res.record.usd_inr ?? "N/A"}`);
    } else {
      log(`⚠ ${res.iso} - ${res.error}`);
    }
    await sleep(300); // be polite to RBI + Yahoo
  }

  // 3. Merge prior + fresh, dedupe by date, sort ascending.
  const seen = new Set();
  const merged = [...prior, ...fresh]
    .filter(r => { if (seen.has(r.date)) return false; seen.add(r.date); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));

  // 4. Build the file. The SEO metadata is carried across an unchanged run: only
  //    a run that actually added a record re-stamps data_updated_at /
  //    date_modified. Otherwise a quiet Friday would rewrite the file (and every
  //    crawlable snapshot built from it) for no reason - the same rule the
  //    refresh driver applies to fetched_at.
  const changed = fresh.length > 0 || merged.length !== prior.length;
  const nowIso = new Date().toISOString();
  const doc = {
    fetched_at: nowIso,
    data_updated_at: changed ? nowIso : ((priorDoc && (priorDoc.data_updated_at || priorDoc.fetched_at)) || nowIso),
    date_modified: changed ? nowIso.slice(0, 10) : ((priorDoc && priorDoc.date_modified) || nowIso.slice(0, 10)),
    temporal_coverage: merged.length
      ? `${merged[0].date}/${merged[merged.length - 1].date}`
      : ((priorDoc && priorDoc.temporal_coverage) || null),
    source: "RBI Weekly Statistical Supplement (Excel) + Yahoo Finance",
    generated_by: "scripts/fetch-all.js",
    count: merged.length,
    records: merged,
  };

  return {
    text: JSON.stringify(doc, null, 2),
    count: merged.length,
    fresh: fresh.length,
    pending,
  };
}

async function main() {
  const argYear = parseInt(process.argv[2], 10);
  const limitArg = process.argv.find(a => a.startsWith("--limit="));
  const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

  let priorText = null;
  try { priorText = fs.readFileSync(OUT, "utf8"); } catch (_) { /* no prior file - first run */ }

  const { text, count, fresh } = await buildRbiDataFile({ priorText, startYear: argYear, limit, log: console.log });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`✅ Wrote ${count} weeks → public/rbi-data.json${fresh ? ` (${fresh} new this run)` : ""}`);
}

// Only when run as a CLI. The weekly refresh imports buildRbiDataFile() from
// this file, and a module-scope main() would make it stop at startup: there is
// no filesystem there, and no stdout either.
if (require.main === module) {
  main().catch(e => {
    console.error("❌ fetch-all failed:", e.message);
    process.exit(1);
  });
}

module.exports = { buildRbiDataFile };
