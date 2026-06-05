const fetch = require("node-fetch");
const XLSX  = require("node-xlsx");

// ─── DATE HELPERS ────────────────────────────────────────────
function getAllFridaysUntilToday() {
  const start = new Date("2026-01-01");
  const end   = new Date();
  const fridays = [];
  // advance start to first Friday on or after Jan 1
  const dow = start.getDay(); // 0=Sun, 5=Fri
  const skip = dow <= 5 ? 5 - dow : 12 - dow;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + (skip === 0 ? 7 : skip));
  while (cur <= end) {
    fridays.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return fridays;
}

function fmtRbi(d) {
  return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
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
function parseReservesExcel(buf) {
  const result = { total_usd: null, total_inr: null, gold_usd: null, gold_inr: null, gold_tons: null };
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

    // ── Gold tonnes ─────────────────────────────────────────
    let tonnes_row_idx = null;
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      const text = row.map(c => String(c ?? "")).join(" ").toLowerCase();
      if (text.includes("gold") &&
          (text.includes("tonnes") || text.includes("metric") || text.includes("tons"))) {
        tonnes_row_idx = i;
        break;
      }
    }
    if (tonnes_row_idx !== null) {
      const row = rows[tonnes_row_idx];
      for (let col = 0; col < row.length; col++) {
        const val = toNum(row[col]);
        if (!isNaN(val) && isFinite(val)) {
          result.gold_tons = val;
          break;
        }
      }
    }

    if (result.gold_tons === null && gold_row_idx !== null) {
      const row = rows[gold_row_idx];
      const numbers = [];
      for (let col = 0; col < row.length; col++) {
        const val = toNum(row[col]);
        if (!isNaN(val) && isFinite(val)) {
          numbers.push(val);
        }
      }
      if (numbers.length >= 3) {
        result.gold_tons = numbers[2];
      }
    }

    if (result.total_usd !== null && result.gold_usd !== null) break;
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
  const from = new Date(targetDate); from.setDate(from.getDate() - 4);
  const to   = new Date(targetDate); to.setDate(to.getDate() + 1);
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
  asOn.setDate(asOn.getDate() - 7);
  const iso = isoDate(asOn);

  // 1. Fetch RBI page (using publication date)
  let html;
  try {
    const res = await get(`https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtRbi(pubFriday)}`, 10000);
    html = await res.text();
  } catch(e) {
    return { iso, error: `RBI page: ${e.message}` };
  }

  // 2. Find Excel links (now matches Python "Foreign Exchange Reserves" row logic primarily)
  const urls = findExcelUrls(html);
  if (!urls.reserves) return { iso, error: "no reserves Excel link on page" };

  // 3. Determine Yahoo targets
  // Historical: exact as-on Friday close
  // For current/recent publication week: use the last updated (most recent) data available
  let niftyTarget = asOn;
  let sensexTarget = asOn;
  let usdTarget = asOn;
  let eurTarget = asOn;

  const now = new Date();
  const daysSincePub = (now.getTime() - pubFriday.getTime()) / (1000 * 60 * 60 * 24);
  if (daysSincePub < 14) {
    // recent publication — fetch latest available equity/forex data for "current week"
    niftyTarget = now;
    sensexTarget = now;
    usdTarget = now;
    eurTarget = now;
  }

  // Download both Excels + Yahoo in parallel
  const [resBuf, spotBuf, nifty, sensex, usdInr, eurInr] = await Promise.all([
    get(urls.reserves, 8000).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null),
    urls.spot ? get(urls.spot, 8000).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null) : null,
    getYahooClose("^NSEI",  niftyTarget),
    getYahooClose("^BSESN", sensexTarget),
    getYahooClose("USDINR=X", usdTarget),
    getYahooClose("EURINR=X", eurTarget),
  ]);

  if (!resBuf) return { iso, error: "reserves Excel download failed" };

  // 4. Parse
  const reserves = parseReservesExcel(resBuf);
  if (reserves.total_usd == null) return { iso, error: "could not parse total_usd from Excel" };

  const spot = spotBuf ? parseSpotRateExcel(spotBuf) : { usd_inr: null, eur_inr: null };

  return {
    iso,
    record: {
      date:      iso,  // as-on date (previous Friday)
      total_usd: reserves.total_usd,
      total_inr: reserves.total_inr,
      gold_usd:  reserves.gold_usd,
      gold_inr:  reserves.gold_inr,
      gold_tons: reserves.gold_tons,
      usd_inr:   usdInr || spot.usd_inr,
      eur_inr:   eurInr || spot.eur_inr,
      nifty,
      sensex,
    }
  };
}

// ─── HANDLER ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const qs = event.queryStringParameters || {};
  const allFridays = getAllFridaysUntilToday();
  const total = allFridays.length;

  // ?weekOffset=N  →  process allFridays[N] (0 = oldest, total-1 = newest)
  const offset = parseInt(qs.weekOffset ?? "0");

  if (isNaN(offset) || offset >= total) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "No more weeks", done: true }),
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
