#!/usr/bin/env node
/**
 * fetch-all.js — regenerate public/rbi-data.json with ALL RBI weekly records.
 *
 * Reuses the scraper internals from netlify/functions/fetch-data.js
 * (_getFridays + _processOne) so parsing stays in one place.
 *
 * Behaviour:
 *   - Reads the existing public/rbi-data.json (if any) and only fetches weeks
 *     NEWER than the newest record already in the file — each run just adds
 *     what's new ("update it every run").
 *   - On a full first run (no file), fetches every Friday from the start year
 *     (default: the current year).
 *   - Auto-extends across calendar years: once data exists, the Friday list is
 *     anchored on the year of the OLDEST record, so a week published in late
 *     Dec of year N that is first fetched in Jan of year N+1 is still in range
 *     and gets picked up instead of being skipped forever.
 *   - Merges + dedupes by date, sorts ascending, writes the file back.
 *
 * Usage:
 *   node scripts/fetch-all.js [startYear] [--limit=N]
 *   npm run fetch:data
 */
const fs = require("fs");
const path = require("path");
const { _getFridays, _processOne } = require("../netlify/functions/fetch-data");

const OUT = path.join(__dirname, "..", "public", "rbi-data.json");

function iso(d) {
  return d.toISOString().slice(0, 10);
}
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const argYear   = parseInt(process.argv[2], 10);
  const curYear   = new Date().getFullYear();
  const limitArg  = process.argv.find(a => a.startsWith("--limit="));
  const limit     = limitArg ? parseInt(limitArg.split("=")[1], 10) : null;

  // 1. Prior records (kept on transient failures so the file never goes empty).
  let prior = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(OUT, "utf8"));
    if (Array.isArray(parsed.records)) prior = parsed.records;
  } catch (_) { /* no prior file — first run */ }

  // Anchor the Friday list on the oldest record's year when data already
  // exists (covers year-boundary weeks), else use the requested/current year.
  let startYear;
  if (prior.length) {
    const oldestYear = prior.reduce((acc, r) => Math.min(acc, parseInt(String(r.date).slice(0, 4), 10) || curYear), curYear);
    startYear = Math.min(argYear || curYear, oldestYear);
  } else {
    startYear = argYear || curYear;
  }

  const fridays = _getFridays(`${startYear}-01-01`);
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
  if (limit && limit > 0) todo = todo.slice(0, limit);

  console.log(`Start year: ${startYear} · ${fridays.length} Fridays in range · ${prior.length} already on file · ${todo.length} to fetch`);

  const fresh = [];
  for (const f of todo) {
    const res = await _processOne(f);
    if (res.record) {
      fresh.push(res.record);
      console.log(`✓ ${res.record.date} | Reserves $${res.record.total_usd?.toLocaleString()}M | USD/INR ${res.record.usd_inr ?? "N/A"}`);
    } else {
      console.log(`⚠ ${res.iso} — ${res.error}`);
    }
    await sleep(300); // be polite to RBI + Yahoo
  }

  // 3. Merge prior + fresh, dedupe by date, sort ascending.
  const seen = new Set();
  const merged = [...prior, ...fresh]
    .filter(r => { if (seen.has(r.date)) return false; seen.add(r.date); return true; })
    .sort((a, b) => a.date.localeCompare(b.date));

  // 4. Write the file.
  const out = {
    fetched_at: new Date().toISOString(),
    source: "RBI Weekly Statistical Supplement (Excel) + Yahoo Finance",
    generated_by: "scripts/fetch-all.js",
    count: merged.length,
    records: merged,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`✅ Wrote ${merged.length} weeks → public/rbi-data.json${fresh.length ? ` (${fresh.length} new this run)` : ""}`);
}

main().catch(e => {
  console.error("❌ fetch-all failed:", e.message);
  process.exit(1);
});
