// backfill-decomp.js — one-shot backfill of the WSS decomposition fields
// (fca_usd/inr, sdr_usd/inr, imf_reserve_usd/inr, gold_tonnes) into the
// existing public/rbi-data.json records by re-downloading each week's
// reserves Excel from RBI and re-parsing it with the production parser
// (parseReservesExcel from netlify/functions/fetch-data.js).
//
// Why: the WSS scraper always *parsed* FCA/SDR/IMF but dropped them when
// building records, so the composition chart had no data. New weeks carry
// the fields from now on; this script fills the historical weeks once.
//
// Notes:
//   - As-on dates are the record dates (the scraper's "as on" Friday). The
//     WSS page for publication Friday = as-on + 7 days is probed; if that
//     page has no reserves Excel (RBI reorganizes old pages), the adjacent
//     Fridays ±7d are tried before giving up on that week.
//   - Only missing/zero fields are filled — a value already present is never
//     overwritten (same never-destroy rule as the fwd-series updaters).
//   - A sanity check keeps the merge honest: FCA + gold + SDR + IMF must be
//     within 0.5% of the week's recorded total (USD mn), else the fields are
//     NOT written and the week is reported for manual inspection.
//   - --dry-run reports what would change without writing the file.
//
// Run: node scripts/backfill-decomp.js [--dry-run]

const fs = require("fs");
const path = require("path");
const { get } = require("../netlify/functions/_utils/http");
const { _findExcelUrls, _parseReservesExcel } = require("../netlify/functions/fetch-data");

const DATA = path.join(__dirname, "..", "public", "rbi-data.json");
const WSS = "https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=";

const dryRun = process.argv.includes("--dry-run");
const sleep = ms => new Promise(r => setTimeout(r, ms));

function fmtRbi(d) {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

// Fetch the WSS page for a publication Friday and parse its reserves Excel.
// Returns the parsed decomposition object or null.
async function parseWeek(pubFriday) {
  const url = WSS + fmtRbi(pubFriday);
  let html;
  try {
    const res = await get(url, 12000);
    html = await res.text();
  } catch (e) {
    throw new Error("page: " + e.message);
  }
  const urls = _findExcelUrls(html);
  if (!urls.reserves) return null; // page exists but no reserves file
  const res = await get(urls.reserves, 15000);
  const buf = Buffer.from(await res.arrayBuffer());
  return _parseReservesExcel(buf);
}

// Try the publication Friday, then ±7 days (some old pages move).
async function parseWeekWithFallback(asOnIso) {
  const base = new Date(asOnIso + "T00:00:00Z");
  const tries = [7, 14, 0].map(days => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  });
  for (const d of tries) {
    try {
      const parsed = await parseWeek(d);
      if (parsed && parsed.fca_usd != null) return parsed;
    } catch (e) {
      console.log(`    · ${fmtRbi(d)} → ${e.message}`);
    }
    await sleep(400);
  }
  return null;
}

function decompSum(r) {
  return (r.fca_usd || 0) + (r.gold_usd || 0) + (r.sdr_usd || 0) + (r.imf_reserve_usd || 0);
}

async function main() {
  const data = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const records = data.records || [];
  console.log(`Backfilling decomposition fields for ${records.length} weeks${dryRun ? " (dry run)" : ""}\n`);

  let filled = 0, skipped = 0, failed = 0;
  for (const r of records) {
    const needs = r.fca_usd == null || r.sdr_usd == null || r.imf_reserve_usd == null || r.gold_tonnes == null;
    if (!needs) { skipped++; continue; }
    process.stdout.write(`${r.date} … `);
    const parsed = await parseWeekWithFallback(r.date);
    if (!parsed) {
      console.log("✗ no parseable decomposition");
      failed++;
      continue;
    }
    // Sanity: components must sum to ~the recorded total (USD mn).
    if (r.total_usd && parsed.fca_usd != null) {
      const diff = Math.abs(decompSum(parsed) - r.total_usd) / r.total_usd;
      if (diff > 0.005) {
        console.log(`✗ sanity fail: components ${Math.round(decompSum(parsed))} vs total ${Math.round(r.total_usd)} (${(diff * 100).toFixed(2)}% off) — not written`);
        failed++;
        continue;
      }
    }
    const set = [];
    const put = (k, v) => { if (v != null && (r[k] == null || r[k] === 0)) { r[k] = v; set.push(k); } };
    put("fca_usd", parsed.fca_usd);           put("fca_inr", parsed.fca_inr);
    put("sdr_usd", parsed.sdr_usd);           put("sdr_inr", parsed.sdr_inr);
    put("imf_reserve_usd", parsed.imf_reserve_usd); put("imf_reserve_inr", parsed.imf_reserve_inr);
    put("gold_tonnes", parsed.gold_tonnes);
    if (set.length) {
      filled++;
      console.log(`✓ ${set.join(", ")}`);
    } else {
      skipped++;
      console.log("· nothing to add");
    }
  }

  console.log(`\nDone: ${filled} weeks filled, ${skipped} already complete, ${failed} failed.`);
  if (dryRun) {
    console.log("Dry run — file NOT written.");
    return;
  }
  if (filled) {
    fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");
    console.log("Wrote " + DATA);
  }
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
