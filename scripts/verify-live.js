// scripts/verify-live.js - the two guards that make a broken data path loud.
//
// Run by the weekly workflow AFTER it commits, so a partial run still ships
// whatever did change while the job reports red. Both questions a silent
// breakage leaves open are asked here:
//
//   1. Freshness. The committed public/rbi-data.json is what the site serves.
//      A healthy Friday run leaves its newest week about seven days old (the
//      WSS published that evening is "as on" the Friday before); nine days
//      means a scrape has been failing for at least a cycle. Nobody would
//      otherwise see it - the dashboard keeps rendering, just with the week
//      it already had.
//
//   2. The live check. The dashboard's Reload asks the DEPLOYED function for
//      weeks newer than the committed snapshot, and that function runs on
//      Cloudflare's edge where RBI's file CDN is unreachable - the HTML-view
//      fallback is what has to answer. This calls it exactly as the dashboard
//      does and accepts only the healthy answers: a record, "nothing newer
//      published yet", or "not published yet". An errorCode that means a
//      broken path (source_unreachable / page_unreachable / parse_failed /
//      download_blocked) fails the run, because that is the "live week check
//      unavailable" line users would see on Reload.
//
// Both checks run and the exit status is non-zero if either fails, so one red
// run tells the whole story. No dependencies - global fetch (Node 18+).

const fs = require("fs");
const path = require("path");

const MAX_AGE_DAYS = 9;
const SITE = process.env.LIVE_SITE_URL || "https://rbiweeklydashboard.pages.dev";
const DATA_FILE = path.join(__dirname, "..", "public", "rbi-data.json");
// A fresh push is deployed a minute or two after it lands, so a first answer
// that looks broken is retried once before it fails the run - otherwise the
// guard would report the previous deployment's code whenever it ships a fix.
const RETRY_DELAY_MS = 60 * 1000;

const isoDay = d => d.toISOString().slice(0, 10);
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The newest dated record in the committed file. */
function newestWeek(doc) {
  const records = (doc && Array.isArray(doc.records) ? doc.records : [])
    .filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")))
    .sort((a, b) => a.date.localeCompare(b.date));
  return records.length ? records[records.length - 1].date : null;
}

/** Whole days between an ISO day and now (UTC-anchored, DST-free). */
function ageDays(isoDate, now = new Date()) {
  const then = new Date(`${isoDate}T00:00:00Z`).getTime();
  if (!Number.isFinite(then)) return NaN;
  return Math.floor((now.getTime() - then) / 86400000);
}

/** The Friday RBI publishes a week's supplement: seven days after the as-on date. */
function publicationOf(isoDate) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 7);
  return isoDay(d);
}

/** What the live check is allowed to answer. */
function judgeLive(status, body) {
  if (body && body.record) {
    return {
      ok: true,
      message: `edge returned the week as on ${body.record.date}` + (body.via ? ` (via ${body.via})` : ""),
    };
  }
  if (body && body.done === true) return { ok: true, message: "nothing newer published yet" };
  // RBI simply being late with this week's supplement is a quiet Friday, not a
  // broken path - the committed snapshot is still the current data.
  if (body && body.errorCode === "not_published") return { ok: true, message: "RBI has not published this week yet" };
  const code = body && body.errorCode;
  if (code) {
    const detail = [body.error, body.hint].filter(Boolean).join(" - ");
    return { ok: false, message: `live check answered ${code}${detail ? `: ${detail}` : ""}` };
  }
  return { ok: false, message: `live check answered HTTP ${status} with no usable body` };
}

function checkFreshness() {
  const doc = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  const newest = newestWeek(doc);
  if (!newest) return { ok: false, newest: null, message: "rbi-data.json has no dated records at all" };
  const age = ageDays(newest);
  return {
    ok: age <= MAX_AGE_DAYS,
    newest,
    message: `newest committed week ${newest} is ${age} days old (healthy ~7, limit ${MAX_AGE_DAYS})`,
  };
}

async function checkLiveCheck(newest) {
  const after = publicationOf(newest);
  const url = `${SITE}/.netlify/functions/fetch-data?after=${after}&weekOffset=0`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    let body = null;
    try { body = await res.json(); } catch (_) { /* a non-JSON answer is judged below */ }
    const verdict = judgeLive(res.status, body);
    return { ...verdict, url };
  } catch (e) {
    return { ok: false, url, message: `could not reach ${url} (${e.message})` };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const fresh = checkFreshness();
  console.log(`${fresh.ok ? "✓" : "✗"} freshness: ${fresh.message}`);

  let live = { ok: false, url: "-", message: "skipped - no committed week to anchor on" };
  if (fresh.newest) {
    live = await checkLiveCheck(fresh.newest);
    if (!live.ok) {
      console.log(`… live check failed once (${live.message}); retrying after ${RETRY_DELAY_MS / 1000}s in case this run's deploy is still landing`);
      await sleep(RETRY_DELAY_MS);
      live = await checkLiveCheck(fresh.newest);
    }
  }
  console.log(`${live.ok ? "✓" : "✗"} live check (${live.url}): ${live.message}`);

  if (!fresh.ok || !live.ok) {
    console.error("::error::the data path is broken - see the two checks above");
    // exitCode, not process.exit(): tearing the process down with fetch's
    // sockets still open aborts libuv on Windows (exit 127, no clean step
    // annotation), and this has to be a legible red run on any runner.
    process.exitCode = 1;
    return;
  }
  console.log("✓ data path healthy");
}

module.exports = { MAX_AGE_DAYS, newestWeek, ageDays, publicationOf, judgeLive };

if (require.main === module) {
  main().catch(e => {
    console.error(`::error::${e.message}`);
    process.exitCode = 1;
  });
}
