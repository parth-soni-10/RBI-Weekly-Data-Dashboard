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
//   - RATE LIMITING: RBI's doc CDN (rbidocs) sits behind an F5 rate limiter.
//     Bursty scraping (the first version ran at ~2 req/s) trips it and every
//     later request returns a challenge HTML page instead of the file. This
//     version paces itself (2.5s between weeks), validates the XLSX/XLS
//     magic bytes, retries once after a cool-down, and reports weeks blocked
//     by the challenge distinctly from unparseable ones.
//
// Run: node scripts/backfill-decomp.js [--dry-run] [--limit N]
//   --limit N   process at most N weeks this invocation (the script persists
//               after every filled week, so repeated invocations resume where
//               the last left off — useful under tight timeouts).

const fs = require("fs");
const path = require("path");
const { get } = require("../netlify/functions/_utils/http");
const { _findExcelUrls, _parseReservesExcel } = require("../netlify/functions/fetch-data");

const DATA = path.join(__dirname, "..", "public", "rbi-data.json");
const WSS = "https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=";

const dryRun = process.argv.includes("--dry-run");
const limitIdx = process.argv.indexOf("--limit");
const limit = limitIdx > -1 ? parseInt(process.argv[limitIdx + 1], 10) || 0 : 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Real spreadsheets start with PK\x03\x04 (xlsx) or D0 CF 11 E0 (legacy xls).
// Anything else (notably "<!DOCTYPE html>") is F5's challenge interstitial.
function isSpreadsheet(buf) {
  if (buf.length < 8) return false;
  const pk = buf[0] === 0x50 && buf[1] === 0x4b;
  const xls = buf[0] === 0xd0 && buf[1] === 0xcf;
  return pk || xls;
}

function fmtRbi(d) {
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

// Fetch the WSS page for a publication Friday and parse its reserves Excel.
// Returns { parsed } or { challenge: true } when the doc CDN rate-limits us.
async function parseWeek(pubFriday) {
  const url = WSS + fmtRbi(pubFriday);
  let html;
  try {
    const res = await get(url, { timeoutMs: 12000 });
    html = await res.text();
  } catch (e) {
    throw new Error("page: " + e.message);
  }
  const urls = _findExcelUrls(html);
  if (!urls.reserves) return null; // page exists but no reserves file
  // accept:false — rbidocs (F5 bot check) serves a challenge HTML page for
  // any .xlsx request whose Accept header names text/html.
  const res = await get(urls.reserves, { timeoutMs: 20000, accept: false });
  let buf = Buffer.from(await res.arrayBuffer());
  if (!isSpreadsheet(buf)) {
    // Challenged — cool down and retry once.
    await sleep(8000);
    const res2 = await get(urls.reserves, { timeoutMs: 20000, accept: false });
    buf = Buffer.from(await res2.arrayBuffer());
    if (!isSpreadsheet(buf)) return { challenge: true };
  }
  return { parsed: _parseReservesExcel(buf) };
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
      const out = await parseWeek(d);
      if (out && out.challenge) return { challenge: true };
      if (out && out.parsed && out.parsed.fca_usd != null) return out;
    } catch (e) {
      console.log(`    · ${fmtRbi(d)} → ${e.message}`);
    }
    await sleep(1500);
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

  let filled = 0, skipped = 0, failed = 0, challenged = 0, attempted = 0;
  let consecutiveChallenges = 0;
  for (const r of records) {
    if (limit && attempted >= limit) { console.log(`\n--limit ${limit} reached — rerun to continue.`); break; }
    // The F5 limiter flags per-IP for a while once tripped; hammering through
    // it only extends the penalty. Three consecutive challenges = back off
    // and let the next invocation (or the daily cron from a different IP)
    // resume.
    if (consecutiveChallenges >= 3) {
      console.log("\nLimiter active — stopping this run. Resume later or let the cron retry.");
      break;
    }
    // gold_tonnes is best-effort (many sheets don't carry the row) — never
    // let its absence keep a week "needing" forever.
    const needs = r.fca_usd == null || r.sdr_usd == null || r.imf_reserve_usd == null;
    if (!needs) { skipped++; continue; }
    attempted++;
    process.stdout.write(`${r.date} … `);
    const out = await parseWeekWithFallback(r.date);
    if (out && out.challenge) {
      console.log("⏳ rate-limited by RBI CDN — will resume next run");
      challenged++;
      consecutiveChallenges++;
      await sleep(20000); // let the limiter cool before the next week
      continue;
    }
    consecutiveChallenges = 0;
    const parsed = out && out.parsed;
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
      // Persist immediately so a killed/interrupted run keeps its progress
      // (the file is small; the script is resumable by design).
      if (!dryRun) fs.writeFileSync(DATA, JSON.stringify(data, null, 2) + "\n");
    } else {
      skipped++;
      console.log("· nothing to add");
    }
    await sleep(5000); // pace: ~5s between weeks keeps the F5 limiter dormant
  }

  console.log(`\nDone: ${filled} weeks filled, ${skipped} already complete, ${failed} failed, ${challenged} rate-limited (retry next run).`);
  if (dryRun) console.log("Dry run — file NOT written.");
  else if (filled) console.log("Wrote " + DATA);
}

main().catch(e => { console.error("FATAL", e); process.exit(1); });
