const fetch = require("node-fetch");
const XLSX  = require("node-xlsx");

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
// regardless of the runtime's timezone or DST transitions — otherwise a
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

// ─── HTTP ────────────────────────────────────────────────────
async function get(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", "Referer": "https://www.rbi.org.in/" }
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

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
// picking numbers out of labels like "1 Total Reserves" or "1.2 Gold"
function toNum(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  // after removing commas, must match pure number pattern
  const cleaned = s.replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return NaN;
  }
  const n = parseFloat(cleaned);
  return isNaN(n) ? NaN : n;
}

// ─── PARSE RESERVES EXCEL ────────────────────────────────────
// Strategy: same logic as the Python scraper (row keyword search, then first two
// numerics in row order, but adjusted for actual table layout where INR Cr appears
// before US$ Mn in the "As on" columns)
//
// Extended (decomposition): also extracts Foreign Currency Assets (FCA), Special
// Drawing Rights (SDR), IMF Reserve Position, and Gold tonnes when those rows exist
// in the Excel. Falls back gracefully — these fields stay null on older sheets.
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

  for (const sheet of sheets) {
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
  // RBI row layout: [Label ... | INR cr | USD mn] (INR cr is left of USD mn).
  // When we read the right-to-left pair, the larger magnitude is USD mn
  // (USD mn is ~50-100× INR cr for reserves) so we discriminate by size.
  const decompFinders = [
    { keys: ["fca_usd", "fca_inr"],                match: ["foreign currency assets", "currency assets"],           exclude: [] },
    { keys: ["sdr_usd", "sdr_inr"],                match: ["special drawing rights", "special drawing right", "sdr"], exclude: [] },
    { keys: ["imf_reserve_usd", "imf_reserve_inr"], match: ["reserve position", "reserve tranche", "imf"],          exclude: [] },
  ];

  for (const f of decompFinders) {
    const candidates = []; // { rowIdx, sheetIdx, usd, inr }
    outer: for (let si = 0; si < sheets.length; si++) {
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
          // Pick the LARGER one as USD mn, the smaller as INR cr.
          // (Reserves: USD mn is ~50-100× larger than INR cr.)
          if (nums.length >= 2) {
            candidates.push({
              sheetIdx: si, rowIdx: j,
              usd: Math.max(nums[0], nums[1]),
              inr: Math.min(nums[0], nums[1])
            });
          } else if (nums.length === 1) {
            // Single-column report — assume USD mn.
            candidates.push({ sheetIdx: si, rowIdx: j, usd: nums[0], inr: null });
          }
          break outer;
        }
      }
    }
    // Prefer the FIRST match in physical order. If multiple, prefer one whose
    // usd/inr ratio looks like a real reserves split (~30-90 range).
    if (candidates.length) {
      const best = candidates.find(c => c.inr && (c.usd / c.inr > 20 && c.usd / c.inr < 200))
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
    return { iso, error: `RBI page: ${e.message} - retry on next request` };
  }

  // 2. Find Excel links (now matches Python "Foreign Exchange Reserves" row logic primarily)
  const urls = findExcelUrls(html);
  if (!urls.reserves) return { iso, error: "no reserves Excel link on page - RBI may not have published this week; retry later" };

  // 3. Yahoo targets use the as-on Friday (previous week) for all.
  // Nifty and Sensex (and rupee) for the latest record will be the values at scrape time (up to latest available).
  // Download both Excels + Yahoo in parallel
  const [resBuf, spotBuf, nifty, sensex, usdInr, eurInr] = await Promise.all([
    get(urls.reserves, 8000).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null),
    urls.spot ? get(urls.spot, 8000).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null) : null,
    getYahooClose("^NSEI",  asOn),
    getYahooClose("^BSESN", asOn),
    getYahooClose("USDINR=X", asOn),
    getYahooClose("EURINR=X", asOn),
  ]);

  if (!resBuf) return { iso, error: "reserves Excel download failed - will retry on next request" };

  // 4. Parse
  const reserves = parseReservesExcel(resBuf);
  if (reserves.total_usd == null) return { iso, error: "could not parse total_usd from Excel - retry on next request" };

  const spot = spotBuf ? parseSpotRateExcel(spotBuf) : { usd_inr: null, eur_inr: null };

  return {
    iso,
    record: {
      date:      iso,  // as-on date (previous Friday)
      total_usd: reserves.total_usd,
      total_inr: reserves.total_inr,
      gold_usd:  reserves.gold_usd,
      gold_inr:  reserves.gold_inr,
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

exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const startYear = parseInt(qs.startYear ?? "") || new Date().getFullYear();
  let allFridays = getAllFridaysUntilToday(`${startYear}-01-01`);

  // ?after=YYYY-MM-DD — incremental mode: only process Fridays strictly AFTER
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
      iso:       result.iso,
      weekIndex: offset,
      totalWeeks: total,
    }),
  };
};
