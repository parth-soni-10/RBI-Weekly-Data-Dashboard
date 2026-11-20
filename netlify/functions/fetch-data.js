const XLSX  = require("node-xlsx");
// Shared HTTP client (UA + timeout) and numeric parser from _utils/http - one
// place for every scraper instead of a private copy here.
const { get: httpGet, extractHtmlTables, parseNum: toNum, UA } = require("./_utils/http");

// NOTE: Crude-oil import data is fetched LIVE by the dashboard from
// /.netlify/functions/fetch-crude (PPAC + TankerMap AIS + Yahoo). No static
// crude JSON dumps are needed at runtime. The india_crude_import_data/ folder
// under public/ is reserved for any optional Python-pipeline output that may
// be regenerated locally; that folder is gitignored. This function remains
// focused on the 10-week as-on-Friday RBI + yfinance records.

// ─── DATE HELPERS ────────────────────────────────────────────
// Returns every Friday on or after `startISO` up to today.
//
// Default start: Jan 1 of the PREVIOUS calendar year, so the public
// data-latest / data-forex-weekly endpoints keep December's tail weeks
// available immediately after a new year starts (e.g. on Jan 2, 2027 the
// list still contains late-Dec 2026 Fridays).
//
// All arithmetic uses UTC (getUTCDay/setUTCDate) so the result is stable
// regardless of the runtime's timezone or DST transitions - otherwise a
// server in BST/PST/etc. can shift "Friday" labels onto adjacent days.
function getAllFridaysUntilToday(startISO) {
  const thisYear = new Date().getFullYear();
  const start = startISO ? new Date(startISO) : new Date(`${thisYear - 1}-01-01`);
  const end   = new Date();
  const fridays = [];
  // advance start to first Friday on or after Jan 1
  const dow = start.getUTCDay(); // 0=Sun, 5=Fri
  const skip = dow <= 5 ? 5 - dow : 12 - dow;
  const cur = new Date(start);
  cur.setUTCDate(cur.getUTCDate() + skip); // include the start date itself if it is already a Friday
  while (cur <= end) {
    fridays.push(new Date(cur));
    cur.setUTCDate(cur.getUTCDate() + 7);
  }
  return fridays;
}

function fmtRbi(d) {
  // UTC to match the UTC-anchored Friday list (timezone/DST independent)
  return `${d.getUTCMonth()+1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// Real spreadsheets start with PK\x03\x04 (xlsx) or D0 CF 11 E0 (legacy xls).
// Anything else (notably "<!DOCTYPE html>") is F5's challenge interstitial
// from RBI's rbidocs doc CDN. See scripts/backfill-decomp.js for the same check.
function isSpreadsheet(buf) {
  if (!buf || buf.length < 8) return false;
  const pk = buf[0] === 0x50 && buf[1] === 0x4b;
  const xls = buf[0] === 0xd0 && buf[1] === 0xcf;
  return pk || xls;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── HTTP ────────────────────────────────────────────────────
// Same shared client every other scraper uses, pinned to the RBI referer the
// upstream expects - with accept:false: RBI's doc CDN (rbidocs, behind an F5
// bot check) serves an .xlsx challenge page whenever Accept names text/html.
const get = (url, timeoutMs) => httpGet(url, { timeoutMs, referer: "https://www.rbi.org.in/", accept: false });

// ─── FIND EXCEL LINKS ON RBI PAGE ────────────────────────────
// Matches the Python logic: look for tr containing "Foreign Exchange Reserves", take its .XLSX link
function findExcelUrls(html) {
  const urls = {};
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cell = m[1];
    const text = cell.replace(/<[^>]+>/g, " ").toLowerCase();
    if (text.includes("foreign exchange reserves")) {
      const href = cell.match(/href="([^"]+\.xlsx)"/i);
      if (href) {
        let link = href[1];
        if (!link.startsWith("http")) link = "https://www.rbi.org.in" + link;
        urls.reserves = link;
        // break to match python: only the first matching row for reserves
        break;
      }
    }
  }
  // keep spot logic for compatibility (may find "Ratios and Rates" etc if text matches)
  trRe.lastIndex = 0;
  while ((m = trRe.exec(html)) !== null) {
    const cell = m[1];
    const text = cell.replace(/<[^>]+>/g, " ").toLowerCase();
    if (text.includes("foreign exchange market") ||
        text.includes("exchange rate") ||
        text.includes("spot rate")) {
      const href = cell.match(/href="([^"]+\.xlsx)"/i);
      if (href && !urls.spot) {
        let link = href[1];
        if (!link.startsWith("http")) link = "https://www.rbi.org.in" + link;
        urls.spot = link;
      }
    }
  }
  return urls;
}

// helper to parse number, strip commas etc.
// Only accept strings that are purely numeric (after removing commas) to avoid
// picking numbers out of labels like "1 Total Reserves" or "1.2 Gold" -
// parseNum from _utils/http implements exactly that.

// ─── PARSE RESERVES EXCEL ────────────────────────────────────
// Strategy: same logic as the Python scraper (row keyword search, then first two
// numerics in row order, but adjusted for actual table layout where INR Cr appears
// before US$ Mn in the "As on" columns)
//
// Extended (decomposition): also extracts Foreign Currency Assets (FCA), Special
// Drawing Rights (SDR), IMF Reserve Position, and Gold tonnes when those rows exist
// in the Excel. Falls back gracefully - these fields stay null on older sheets.
function parseReservesExcel(buf) {
  const result = {
    total_usd: null, total_inr: null,
    gold_usd: null, gold_inr: null, gold_tonnes: null,
    fca_usd: null, fca_inr: null,
    sdr_usd: null, sdr_inr: null,
    imf_reserve_usd: null, imf_reserve_inr: null,
  };
  let sheets;
  try { sheets = XLSX.parse(buf); } catch(e) { return result; }

  let reservesSheetIdx = null;
  for (let si0 = 0; si0 < sheets.length; si0++) {
    const sheet = sheets[si0];
    const rows = sheet.data || [];
    // ── Total reserves ──────────────────────────────────────
    let total_row_idx = null;
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const text = row.map(c => String(c ?? "")).join(" ").toLowerCase();
      if (text.includes("total reserves") || text.includes("total foreign exchange reserves")) {
        total_row_idx = i;
        break;
      }
    }
    if (total_row_idx !== null) {
      let inr_val = null;
      let usd_val = null;
      const row = rows[total_row_idx];
      for (let col = 0; col < row.length; col++) {
        const cell_val = toNum(row[col]);
        if (!isNaN(cell_val) && isFinite(cell_val)) {
          if (inr_val === null) {
            inr_val = cell_val;
          } else {
            usd_val = cell_val;
            break;
          }
        }
      }
      result.total_inr = inr_val;
      result.total_usd = usd_val;
      reservesSheetIdx = si0;
    }

    // ── Gold ────────────────────────────────────────────────
    let gold_row_idx = null;
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const text = row.map(c => String(c ?? "")).join(" ").toLowerCase();
      if (text.includes("gold") && !text.includes("total")) {
        gold_row_idx = i;
        break;
      }
    }
    if (gold_row_idx !== null) {
      let inr_val = null;
      let usd_val = null;
      const row = rows[gold_row_idx];
      for (let col = 0; col < row.length; col++) {
        const cell_val = toNum(row[col]);
        if (!isNaN(cell_val) && isFinite(cell_val)) {
          if (inr_val === null) {
            inr_val = cell_val;
          } else {
            usd_val = cell_val;
            break;
          }
        }
      }
      result.gold_inr = inr_val;
      result.gold_usd = usd_val;
    }

    if (result.total_usd !== null && result.gold_usd !== null) break;
  }

  // ── Decomposition: FCA / SDR / IMF Reserve / Gold tonnes ───────────
  // Adds fields without disturbing existing total + gold logic above.
  // Each entry is null if the row / numerics aren't found in the sheet.
  //
  // RBI row layout: [Label ... | INR cr | USD mn] - INR crore comes FIRST,
  // same column order as the Total and Gold rows read above (first numeric →
  // INR, second → USD). Verified against archived + live sheets: FCA(₹60.5L cr)
  // + Gold + SDR + IMF in USD mn sum exactly to total_usd.
  const decompFinders = [
    { keys: ["fca_usd", "fca_inr"],                match: ["foreign currency assets", "currency assets"],           exclude: [] },
    { keys: ["sdr_usd", "sdr_inr"],                match: ["special drawing rights", "special drawing right", "sdr"], exclude: [] },
    { keys: ["imf_reserve_usd", "imf_reserve_inr"], match: ["reserve position", "reserve tranche", "imf"],          exclude: [] },
  ];

  for (const f of decompFinders) {
    const candidates = []; // { rowIdx, sheetIdx, usd, inr }
    for (let si = 0; si < sheets.length; si++) {
      const rows = sheets[si].data || [];
      for (let j = 0; j < rows.length; j++) {
        const text = rows[j].map(c => String(c || "")).join(" ").toLowerCase();
        if (f.match.some(k => text.includes(k)) && f.exclude.every(k => !text.includes(k))) {
          // Read left-to-right; collect every numeric in the row.
          const nums = [];
          for (let c = 0; c < rows[j].length; c++) {
            const v = toNum(rows[j][c]);
            if (!isNaN(v) && isFinite(v)) nums.push(v);
          }
          // Column order, not magnitude, decides: [INR cr | USD mn].
          if (nums.length >= 2) {
            candidates.push({
              sheetIdx: si, rowIdx: j,
              inr: nums[0],
              usd: nums[1]
            });
          } else if (nums.length === 1) {
            // Single-column report - assume USD mn.
            candidates.push({ sheetIdx: si, rowIdx: j, usd: nums[0], inr: null });
          }
          // NOTE: deliberately no `break` - scan every sheet. RBI's WSS can
          // carry a decoy row of the same label in another table (e.g. the
          // balance-sheet "Foreign Currency Assets" in T_1, in a different
          // unit); collecting all candidates lets the sanity filter below
          // discard it instead of latching onto the first hit.
        }
      }
    }
    // Pick the row that actually belongs to the reserves table. Preference:
    //   1. a candidate in the same sheet as the total-reserves row, with a
    //      plausible ₹cr/$mn ratio (₹cr = $mn × rate ÷ 10 ≈ 9–11 recently);
    //   2. any candidate with a plausible ratio (handles single-sheet files);
    //   3. the first candidate as a last resort.
    if (candidates.length) {
      const sane = c => c.inr && c.usd && (c.inr / c.usd > 4 && c.inr / c.usd < 25);
      const best = (reservesSheetIdx != null && candidates.find(c => c.sheetIdx === reservesSheetIdx && sane(c)))
                || candidates.find(sane)
                || candidates[0];
      result[f.keys[0]] = best.usd;
      result[f.keys[1]] = best.inr;
    }
  }

  // ── Gold tonnes (best-effort) ──────────────────────────────────────
  for (let si = 0; si < sheets.length; si++) {
    const rows = sheets[si].data || [];
    for (let j = 0; j < rows.length; j++) {
      const text = rows[j].map(c => String(c || "")).join(" ").toLowerCase();
      if ((text.includes("gold") && text.includes("tonne")) || text.includes("tonnes of gold") || text.includes("gold (mt)")) {
        for (let c = rows[j].length - 1; c >= 0; c--) {
          const v = toNum(rows[j][c]);
          if (!isNaN(v) && isFinite(v) && v > 0 && v < 1000) {
            result.gold_tonnes = v;
            break;
          }
        }
        if (result.gold_tonnes != null) break;
      }
    }
    if (result.gold_tonnes != null) break;
  }

  return result;
}

// ─── PARSE SPOT RATE EXCEL ────────────────────────────────────
function parseSpotRateExcel(buf) {
  const result = { usd_inr: null, eur_inr: null };
  let sheets;
  try { sheets = XLSX.parse(buf); } catch(e) { return result; }

  for (const sheet of sheets) {
    const rows = sheet.data || [];
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const text = row.map(c => String(c ?? "")).join(" ").toLowerCase();
      // INR/USD spot: expect ~83–90
      if (result.usd_inr === null &&
          (text.includes("usd") || text.includes("us dollar") || text.includes("dollar")) &&
          !text.includes("euro") && !text.includes("eur")) {
        // scan right-to-left to get the most recent value
        for (let j = row.length - 1; j >= 0; j--) {
          const v = toNum(row[j]);
          if (!isNaN(v) && v > 50 && v < 200) { result.usd_inr = v; break; }
        }
      }
      // INR/EUR spot: expect ~88–100
      if (result.eur_inr === null &&
          (text.includes("euro") || text.includes("eur"))) {
        for (let j = row.length - 1; j >= 0; j--) {
          const v = toNum(row[j]);
          if (!isNaN(v) && v > 50 && v < 200) { result.eur_inr = v; break; }
        }
      }
      if (result.usd_inr && result.eur_inr) break;
    }
    if (result.usd_inr && result.eur_inr) break;
  }

  return result;
}

// ─── YAHOO FINANCE ───────────────────────────────────────────
// Fetch daily data ±3 days around the target date, find closest close.
async function getYahooClose(symbol, targetDate) {
  // UTC arithmetic keeps the ±window aligned with isoDate() labels regardless
  // of the runtime timezone / DST.
  const from = new Date(targetDate); from.setUTCDate(from.getUTCDate() - 4);
  const to   = new Date(targetDate); to.setUTCDate(to.getUTCDate() + 1);
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`
             + `?period1=${Math.floor(from/1000)}&period2=${Math.floor(to/1000)}&interval=1d`;
  try {
    const res = await get(url, 6000);
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const ts     = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const target = targetDate.getTime();
    let best = null, bestDiff = Infinity;
    ts.forEach((t, i) => {
      const diff = Math.abs(t * 1000 - target);
      if (diff < bestDiff && closes[i] != null) { bestDiff = diff; best = closes[i]; }
    });
    return best;
  } catch { return null; }
}

// Download a single URL as a Buffer, validating it's a real spreadsheet.
// Sends NO Accept header: RBI's rbidocs CDN (behind an F5 bot check) serves a
// challenge page whenever Accept names text/html, and a spreadsheet Accept
// trips a transport-level failure - but a request with no Accept at all gets
// the real .xlsx (verified against the live CDN). Uses fetch() with a
// per-attempt AbortController so the timeout is honoured on every runtime:
// node:https is a shim under Cloudflare's nodejs_compat and can ignore the
// socket timeout, which made the deployed function hang instead of failing.
//
// Returns { buf, reason }. `reason` says WHY the file did not arrive, because
// the two failures need opposite reactions:
//
//   "challenge"  the CDN answered fast with F5's bot page - transient, so it
//                is worth several tries with backing off. F5 can challenge
//                more than once in a row, so one retry is not enough.
//   "timeout" /  the request never came back: this runtime's network cannot
//   "network"    reach the doc CDN at all (Cloudflare's egress is refused by
//                RBI's CDN). Retrying the same URL cannot change that, so the
//                wait is not doubled for nothing and the caller reports it as
//                "this edge cannot reach the source" rather than "try again".
async function downloadSpreadsheet(url, timeoutMs = 12000) {
  const MAX_ATTEMPTS = 5;
  const backoffMs = [2000, 4000, 8000, 12000];
  let reason = "unavailable";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let buf = null;
    let why = "unavailable";
    const ctrl = new AbortController();
    // Race the whole request (connect + body) against a hard timer: a runtime
    // can leave a fetch to a black-holed host pending well past the
    // AbortController, so the race - not the signal - is what guarantees we
    // stop waiting and either retry or give up.
    let timer;
    try {
      buf = await Promise.race([
        (async () => {
          const res = await fetch(url, {
            signal: ctrl.signal,
            headers: { "User-Agent": UA, "Referer": "https://www.rbi.org.in/" },
          });
          if (!res.ok) { why = "http"; return null; }
          return Buffer.from(await res.arrayBuffer());
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { ctrl.abort(); reject(new Error("timeout")); }, timeoutMs);
        }),
      ]);
    } catch (e) {
      buf = null;
      why = (e && e.message === "timeout") ? "timeout" : "network";
    } finally {
      clearTimeout(timer);
    }
    if (isSpreadsheet(buf)) return { buf, reason: null };
    if (why === "unavailable") why = "challenge"; // a body that is not a spreadsheet
    reason = why;
    // Only a challenge page is worth retrying: it came back quickly, which
    // means the network is fine. F5 can challenge more than once in a row, so
    // we retry with backing off instead of giving up after one attempt. A
    // timeout or a refused connection is the network itself, and no retry can
    // fix it.
    if (reason !== "challenge") break;
    if (attempt < MAX_ATTEMPTS) await sleep(backoffMs[attempt - 1]);
  }
  return { buf: null, reason };
}

// ─── THE HTML VIEW (same issue, host the edge can reach) ──────
// RBI publishes every WSS issue twice: the .XLSX on rbidocs - behind an F5 bot
// check, and refused outright to Cloudflare's egress - and the same table as
// HTML at /Scripts/WSSView.aspx?Id=N on www.rbi.org.in, which the edge CAN
// read. That is the live check's way in when the download is refused: same
// figures, same [₹ crore | US$ mn] column order the Excel parser reads.
//
// The id is not guessable, so it comes from a page that lists the issue: the
// detail page the caller already fetched links it in the row beside the
// spreadsheet; when it doesn't, the monthly archive on BS_ViewWss.aspx does
// (an ASP.NET postback - the form's hidden fields are replayed here).

const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
const two = n => String(n).padStart(2, "0");

// Parse one issue's HTML view into the field names the Excel parser produces.
// `as_on` is the page's own "As on <date>" line, so the caller can prove the
// page is the week it asked for before a single figure is used.
function parseWssHtml(html) {
  const out = {
    as_on: null,
    total_usd: null, total_inr: null,
    gold_usd: null, gold_inr: null,
    fca_usd: null, fca_inr: null,
    sdr_usd: null, sdr_inr: null,
    imf_reserve_usd: null, imf_reserve_inr: null,
  };
  const text = String(html || "");
  const asOn = text.match(/As on\s+([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})/i);
  if (asOn) {
    const mi = MONTHS.indexOf(asOn[1].toLowerCase());
    if (mi >= 0) out.as_on = `${asOn[3]}-${two(mi + 1)}-${two(Number(asOn[2]))}`;
  }
  const rows = [];
  for (const table of extractHtmlTables(text)) for (const row of table) rows.push(row);
  // [label | ₹ cr | US$ mn | ...variations] - read only the first two numerics,
  // and only from a row whose ₹cr-per-$mn ratio passes the same 4-25 gate the
  // Excel decomposition uses, so a variations-first layout or a decoy row can
  // never be mistaken for a level.
  const read = (labelRe) => {
    for (const row of rows) {
      const label = String(row[0] || "");
      if (!labelRe.test(label)) continue;
      const inr = toNum(row[1]);
      const usd = toNum(row[2]);
      if (!isFinite(inr) || !isFinite(usd) || inr <= 0 || usd <= 0) continue;
      if (inr / usd < 4 || inr / usd > 25) continue;
      return { inr, usd };
    }
    return null;
  };
  const total = read(/total reserves/i);
  if (total) { out.total_inr = total.inr; out.total_usd = total.usd; }
  const fca = read(/foreign currency assets/i);
  if (fca) { out.fca_inr = fca.inr; out.fca_usd = fca.usd; }
  const gold = read(/^\s*\d+(?:\.\d+)?\s*gold\b/i);
  if (gold) { out.gold_inr = gold.inr; out.gold_usd = gold.usd; }
  const sdr = read(/^\s*\d+(?:\.\d+)?\s*sdrs?\b/i);
  if (sdr) { out.sdr_inr = sdr.inr; out.sdr_usd = sdr.usd; }
  const imf = read(/reserve position in the imf/i);
  if (imf) { out.imf_reserve_inr = imf.inr; out.imf_reserve_usd = imf.usd; }
  return out;
}

// The WSSView.aspx?Id= of an issue, taken from any page that links it.
function findHtmlViewId(html) {
  const rows = String(html || "").match(/<tr[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    if (!/foreign exchange reserves/i.test(row.replace(/<[^>]+>/g, " "))) continue;
    const id = row.match(/WSSView\.aspx\?Id=(\d+)/i);
    if (id) return id[1];
  }
  const any = String(html || "").match(/WSSView\.aspx\?Id=(\d+)/i);
  return any ? any[1] : null;
}

// The monthly archive, mapping publication Friday → HTML-view id. Megabytes of
// markup, so it is fetched at most once per month per isolate, and only when
// the cheap lookup above came up empty.
let archiveCache = null;
async function archiveViewIds(pubFriday) {
  const key = `${pubFriday.getUTCFullYear()}-${two(pubFriday.getUTCMonth() + 1)}`;
  if (archiveCache && archiveCache.key === key && Date.now() - archiveCache.at < 30 * 60 * 1000) return archiveCache.map;
  const form = await (await get("https://www.rbi.org.in/Scripts/BS_ViewWss.aspx", 12000)).text();
  const body = new URLSearchParams();
  for (const m of form.matchAll(/<input[^>]*type="hidden"[^>]*name="([^"]+)"[^>]*value="([^"]*)"/gi)) {
    body.set(m[1], m[2].replace(/&amp;/gi, "&"));
  }
  if (!body.get("__VIEWSTATE")) return {}; // a bot-challenge page, not the form
  body.set("ddlYear", String(pubFriday.getUTCFullYear()));
  body.set("ddlMonth", String(pubFriday.getUTCMonth() + 1));
  body.set("ddlSection", "2"); // Foreign Exchange Reserves
  body.set("btnGo", "Go");
  const res = await fetch("https://www.rbi.org.in/Scripts/BS_ViewWss.aspx", {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Referer": "https://www.rbi.org.in/",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  const listing = await res.text();
  // Each issue is a date heading followed by one row per section; the row whose
  // link text is "Foreign Exchange Reserves" carries the HTML view's id.
  const map = {};
  const heads = [...listing.matchAll(/<th[^>]*>\s*(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})\s*<\/th>/gi)];
  for (let i = 0; i < heads.length; i++) {
    const start = heads[i].index + heads[i][0].length;
    const end = i + 1 < heads.length ? heads[i + 1].index : listing.length;
    const id = listing.slice(start, end).match(/WSSView\.aspx\?Id=(\d+)[^>]*>\s*Foreign Exchange Reserves/i);
    const token = heads[i][2].toLowerCase();
    const mi = MONTHS.findIndex(m => m.slice(0, 3) === token.slice(0, 3));
    if (!id || mi < 0) continue;
    map[`${heads[i][3]}-${two(mi + 1)}-${two(Number(heads[i][1]))}`] = id[1];
  }
  archiveCache = { key, at: Date.now(), map };
  return map;
}

// One issue's fields, read from its HTML view. Null when the page is
// unreachable, or when it turns out to be a different week than the one asked
// for - the guard that keeps a stale or adjacent issue out of the series.
async function reservesFromHtmlView(detailHtml, pubFriday, asOnIso) {
  try {
    let id = findHtmlViewId(detailHtml);
    if (!id) {
      const map = await archiveViewIds(pubFriday);
      id = map[isoDate(pubFriday)] || null;
    }
    if (!id) return null;
    const page = await get(`https://www.rbi.org.in/Scripts/WSSView.aspx?Id=${id}`, 12000);
    const parsed = parseWssHtml(await page.text());
    if (parsed.as_on !== asOnIso || parsed.total_usd == null) return null;
    return parsed;
  } catch (_) {
    return null; // a bonus path: any failure leaves the committed snapshot in charge
  }
}

// The market quotes every record carries (the WSS table has none of them).
function marketQuotes(asOn) {
  return Promise.all([
    getYahooClose("^NSEI",  asOn),
    getYahooClose("^BSESN", asOn),
    getYahooClose("USDINR=X", asOn),
    getYahooClose("EURINR=X", asOn),
  ]);
}

// An HTML-view issue as a dashboard record - the same shape as the Excel path,
// with gold_tonnes left null (that row exists only in the spreadsheet).
async function recordFromHtmlView(view, iso, asOn) {
  const [nifty, sensex, usdInr, eurInr] = await marketQuotes(asOn);
  return {
    date: iso,
    total_usd: view.total_usd, total_inr: view.total_inr,
    gold_usd: view.gold_usd, gold_inr: view.gold_inr, gold_tonnes: null,
    fca_usd: view.fca_usd, fca_inr: view.fca_inr,
    sdr_usd: view.sdr_usd, sdr_inr: view.sdr_inr,
    imf_reserve_usd: view.imf_reserve_usd, imf_reserve_inr: view.imf_reserve_inr,
    usd_inr: usdInr, eur_inr: eurInr, nifty, sensex,
  };
}

// ─── PROCESS ONE FRIDAY ───────────────────────────────────────
async function processOneFriday(pubFriday) {
  // The publication Friday's WSS shows reserves/gold data "as on" the *previous* Friday
  const asOn = new Date(pubFriday);
  asOn.setUTCDate(asOn.getUTCDate() - 7);
  const iso = isoDate(asOn);

  // 1. Fetch RBI page (using publication date)
  let html;
  try {
    const res = await get(`https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtRbi(pubFriday)}`, 10000);
    html = await res.text();
  } catch(e) {
    return {
      iso,
      code: "page_unreachable",
      error: `RBI's WSS page could not be reached from this runtime (${e.message})`,
      hint: "This network cannot reach RBI - the committed Friday snapshot is the current data",
    };
  }

  // 2. Find Excel links (now matches Python "Foreign Exchange Reserves" row logic primarily)
  const urls = findExcelUrls(html);
  if (!urls.reserves) {
    // Not an error: the publication Friday in question simply has no
    // supplement yet (RBI publishes later in the day), so the dashboard's
    // newest committed week is still the current one.
    return {
      iso,
      code: "not_published",
      error: "RBI has not published this week's supplement yet",
      hint: "Nothing to merge - the committed Friday snapshot is current",
    };
  }

  // 3. Download the reserves Excel with F5-limiter validation + retries.
  //    Yahoo targets use the as-on Friday (previous week) for all.
  //    Nifty and Sensex (and rupee) for the latest record will be the values
  //    at scrape time (up to latest available).
  const dl = await downloadSpreadsheet(urls.reserves, 8000);
  if (!dl.buf) {
    // The file host refused this network (Cloudflare's egress, always) - read
    // the same issue from its HTML view rather than giving up on the week.
    const view = await reservesFromHtmlView(html, pubFriday, iso);
    if (view) return { iso, via: "html", record: await recordFromHtmlView(view, iso, asOn) };
    const blocked = dl.reason === "timeout" || dl.reason === "network";
    return {
      iso,
      code: blocked ? "source_unreachable" : "download_blocked",
      error: blocked
        ? "RBI's document CDN is unreachable from this runtime (the request timed out)"
        : "RBI's document CDN served a bot-challenge page instead of the file",
      hint: blocked
        ? "This network cannot reach RBI's file host - the committed Friday snapshot is the current data"
        : "RBI's limiter is serving a challenge page - the next attempt usually gets the file",
    };
  }
  const resBuf = dl.buf;

  // 4. Spot Excel + Yahoo quotes in parallel now that reserves is in hand.
  const [spotDl, quotes] = await Promise.all([
    urls.spot ? downloadSpreadsheet(urls.spot, 8000) : Promise.resolve(null),
    marketQuotes(asOn),
  ]);
  const [nifty, sensex, usdInr, eurInr] = quotes;

  // 5. Parse
  const reserves = parseReservesExcel(resBuf);
  if (reserves.total_usd == null) {
    const view = await reservesFromHtmlView(html, pubFriday, iso);
    if (view) return { iso, via: "html", record: await recordFromHtmlView(view, iso, asOn) };
    return {
      iso,
      code: "parse_failed",
      error: "could not parse total_usd from Excel - retry on next request",
      hint: "The file arrived but did not carry the expected reserves row",
    };
  }

  const spot = spotDl && spotDl.buf ? parseSpotRateExcel(spotDl.buf) : { usd_inr: null, eur_inr: null };

  return {
    iso,
    record: {
      date:      iso,
      total_usd: reserves.total_usd,
      total_inr: reserves.total_inr,
      gold_usd:  reserves.gold_usd,
      gold_inr:  reserves.gold_inr,
      gold_tonnes: reserves.gold_tonnes,
      fca_usd:   reserves.fca_usd,
      fca_inr:   reserves.fca_inr,
      sdr_usd:   reserves.sdr_usd,
      sdr_inr:   reserves.sdr_inr,
      imf_reserve_usd: reserves.imf_reserve_usd,
      imf_reserve_inr: reserves.imf_reserve_inr,
      usd_inr:   usdInr || spot.usd_inr,
      eur_inr:   eurInr || spot.eur_inr,
      nifty,
      sensex,
    }
  };
}

// ─── HANDLER ─────────────────────────────────────────────────
// Accepts:
//   ?weekOffset=N      default 0; sequential week-by-week fetch (legacy)
//   ?startYear=YYYY    start year for the friday list (default = current year)
// Public exports below so data-latest.js / data-forex-weekly.js can reuse the
// underlying scrape without duplicating the parser.
exports._getFridays    = getAllFridaysUntilToday;
exports._processOne    = processOneFriday;
// Parser internals, reused by scripts/backfill-decomp.js so the WSS
// decomposition fields can be filled into the historical record set without
// duplicating parsing logic (same pattern as fetch-all.js).
exports._findExcelUrls = findExcelUrls;
exports._parseReservesExcel = parseReservesExcel;
exports._parseWssHtml = parseWssHtml;
exports._findHtmlViewId = findHtmlViewId;

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const startYear = parseInt(qs.startYear ?? "") || new Date().getFullYear();
  let allFridays = getAllFridaysUntilToday(`${startYear}-01-01`);

  // ?after=YYYY-MM-DD - incremental mode: only process Fridays strictly AFTER
  // this date. weekOffset is then relative to the remaining list, so a client
  // can re-fetch just the weeks published since its last successful fetch
  // instead of re-scraping the entire year on every request.
  const after = qs.after;
  if (after && /^\d{4}-\d{2}-\d{2}$/.test(after)) {
    allFridays = allFridays.filter(f => isoDate(f) > after);
  }

  const total = allFridays.length;

  // ?weekOffset=N  →  process allFridays[N] (0 = oldest remaining, total-1 = newest)
  const offset = parseInt(qs.weekOffset ?? "0");

  if (isNaN(offset) || offset >= total) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "No more weeks", done: true, totalWeeks: total }),
    };
  }

  const friday = allFridays[offset];
  const result = await processOneFriday(friday);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      done:      false,
      record:    result.record || null,
      error:     result.error  || null,
      // Why the week failed, as a stable code - the client uses it to say the
      // honest thing: "not published yet" and "this edge cannot reach RBI" are
      // not the user's problem to retry, a challenge page or a parse failure is.
      errorCode: result.code  || null,
      hint:      result.hint  || null,
      iso:       result.iso,
      // Which transport produced the record: "html" is the fallback used when
      // RBI's file CDN refuses this network (see reservesFromHtmlView).
      via:       result.via || null,
      weekIndex: offset,
      totalWeeks: total,
    }),
  };
};
