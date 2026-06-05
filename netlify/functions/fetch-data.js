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
      headers: { "User-Agent": "Mozilla/5.0" }
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
function findExcelUrls(html) {
  const urls = {};
  // iterate all <tr> blocks
  const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRe.exec(html)) !== null) {
    const cell = m[1];
    const href = cell.match(/href="([^"]+\.xlsx)"/i);
    if (!href) continue;
    let link = href[1];
    if (!link.startsWith("http")) link = "https://www.rbi.org.in" + link;
    const text = cell.replace(/<[^>]+>/g, " ").toLowerCase();
    if (text.includes("foreign exchange reserves"))
      urls.reserves = urls.reserves || link;
    if (text.includes("foreign exchange market") ||
        text.includes("exchange rate") ||
        text.includes("spot rate"))
      urls.spot = urls.spot || link;
  }
  return urls;
}

// ─── PARSE RESERVES EXCEL ────────────────────────────────────
// Strategy: scan every sheet, every row. Use flexible keyword matching
// rather than assuming fixed column positions (RBI reformats occasionally).
function parseReservesExcel(buf) {
  const result = { total_usd: null, total_inr: null, gold_usd: null, gold_inr: null, gold_tons: null };
  let sheets;
  try { sheets = XLSX.parse(buf); } catch(e) { return result; }

  for (const sheet of sheets) {
    const rows = sheet.data || [];
    for (let i = 0; i < rows.length; i++) {
      const row  = rows[i];
      // build a flat lowercased string of the whole row for matching
      const text = row.map(c => String(c ?? "")).join(" ").toLowerCase();
      // pull every numeric value from this row
      const nums = row.map(c => parseFloat(c)).filter(n => !isNaN(n) && isFinite(n));

      // ── Total reserves ──────────────────────────────────────
      if (result.total_usd === null &&
          (text.includes("total reserves") || text.includes("total foreign exchange reserves"))) {
        // USD is usually the larger number (>100,000 mn), INR is huge (crore)
        // Typical range: USD ~500k-700k, INR ~4000k-6000k crore
        const usdCandidates = nums.filter(n => n > 50000 && n < 2000000);
        const inrCandidates = nums.filter(n => n > 2000000);
        if (usdCandidates.length) result.total_usd = usdCandidates[0];
        if (inrCandidates.length) result.total_inr = inrCandidates[0];
        // Fallback: if only two numbers and one is bigger, assign by size
        if (result.total_usd === null && nums.length >= 2) {
          result.total_usd = Math.min(...nums.slice(0, 3));
          result.total_inr = Math.max(...nums.slice(0, 3));
        }
      }

      // ── Gold ────────────────────────────────────────────────
      if (result.gold_usd === null &&
          text.includes("gold") && !text.includes("total") &&
          !text.includes("tonnes") && !text.includes("metric")) {
        const usdCandidates = nums.filter(n => n > 1000 && n < 500000);
        const inrCandidates = nums.filter(n => n > 500000);
        if (usdCandidates.length) result.gold_usd = usdCandidates[0];
        if (inrCandidates.length) result.gold_inr = inrCandidates[0];
        if (result.gold_usd === null && nums.length >= 2) {
          result.gold_usd = Math.min(...nums.slice(0, 3));
          result.gold_inr = Math.max(...nums.slice(0, 3));
        }
      }

      // ── Gold tonnes ─────────────────────────────────────────
      if (result.gold_tons === null &&
          text.includes("gold") &&
          (text.includes("tonnes") || text.includes("metric") || text.includes("tons"))) {
        // tonnes is typically 700–1100
        const tonCandidates = nums.filter(n => n > 200 && n < 5000);
        if (tonCandidates.length) result.gold_tons = tonCandidates[0];
      }

      if (result.total_usd && result.gold_usd) break;
    }
    if (result.total_usd && result.gold_usd) break;
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
          const v = parseFloat(row[j]);
          if (!isNaN(v) && v > 50 && v < 200) { result.usd_inr = v; break; }
        }
      }
      // INR/EUR spot: expect ~88–100
      if (result.eur_inr === null &&
          (text.includes("euro") || text.includes("eur"))) {
        for (let j = row.length - 1; j >= 0; j--) {
          const v = parseFloat(row[j]);
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
async function processOneFriday(friday) {
  const iso = isoDate(friday);

  // 1. Fetch RBI page
  let html;
  try {
    const res = await get(`https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtRbi(friday)}`, 10000);
    html = await res.text();
  } catch(e) {
    return { iso, error: `RBI page: ${e.message}` };
  }

  // 2. Find Excel links
  const urls = findExcelUrls(html);
  if (!urls.reserves) return { iso, error: "no reserves Excel link on page" };

  // 3. Download both Excels + Yahoo in parallel
  const [resBuf, spotBuf, nifty, sensex] = await Promise.all([
    get(urls.reserves, 8000).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null),
    urls.spot ? get(urls.spot, 8000).then(r => r.arrayBuffer()).then(b => Buffer.from(b)).catch(() => null) : null,
    getYahooClose("^NSEI",  friday),
    getYahooClose("^BSESN", friday),
  ]);

  if (!resBuf) return { iso, error: "reserves Excel download failed" };

  // 4. Parse
  const reserves = parseReservesExcel(resBuf);
  if (reserves.total_usd == null) return { iso, error: "could not parse total_usd from Excel" };

  const spot = spotBuf ? parseSpotRateExcel(spotBuf) : { usd_inr: null, eur_inr: null };

  return {
    iso,
    record: {
      date:      iso,
      total_usd: reserves.total_usd,
      total_inr: reserves.total_inr,
      gold_usd:  reserves.gold_usd,
      gold_inr:  reserves.gold_inr,
      gold_tons: reserves.gold_tons,
      usd_inr:   spot.usd_inr,
      eur_inr:   spot.eur_inr,
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