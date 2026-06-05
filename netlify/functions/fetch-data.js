const fetch = require("node-fetch");
const XLSX = require("node-xlsx");

// ========== DATE HELPERS ==========
function getAllFridaysUntilToday() {
  const start = new Date("2026-01-01");
  const end = new Date();
  const fridays = [];
  const day = start.getDay();
  const daysAhead = day <= 5 ? 5 - day : 12 - day;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + (daysAhead === 0 ? 7 : daysAhead));
  while (cur <= end) {
    fridays.push(new Date(cur));
    cur.setDate(cur.getDate() + 7);
  }
  return fridays;
}

function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
}
function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

// ========== FETCH WITH TIMEOUT ==========
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return res;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

// ========== RBI PAGE ==========
async function getRbiPageHtml(d) {
  const url = `https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtDate(d)}`;
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 8000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function findExcelUrls(html) {
  const urls = {};
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = trRegex.exec(html)) !== null) {
    const cell = m[1];
    const hrefM = cell.match(/href="([^"]+\.xlsx)"/i);
    if (!hrefM) continue;
    let href = hrefM[1];
    if (!href.startsWith("http")) href = "https://www.rbi.org.in" + href;
    const text = cell.replace(/<[^>]+>/g, " ").toLowerCase();
    if (text.includes("foreign exchange reserves")) urls.reserves = urls.reserves || href;
    if (text.includes("foreign exchange market") || text.includes("exchange rate") || text.includes("spot rate"))
      urls.spot = urls.spot || href;
  }
  return urls;
}

async function downloadXlsx(url) {
  const res = await fetchWithTimeout(url, { headers: { "User-Agent": "Mozilla/5.0" } }, 7000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ========== RESERVES PARSER (mimics Python pandas logic) ==========
function parseReservesExcel(buf) {
  try {
    const sheets = XLSX.parse(buf);
    let reservesSheet = null;

    // Find the correct sheet: either named "T_2" or contains "Foreign Exchange Reserves"
    for (const sheet of sheets) {
      if (sheet.name === "T_2") {
        reservesSheet = sheet;
        break;
      }
      // Check first few rows for the title
      const firstRows = sheet.data.slice(0, 5).map(r => r.join(" ")).join(" ");
      if (firstRows.includes("Foreign Exchange Reserves")) {
        reservesSheet = sheet;
        break;
      }
    }

    if (!reservesSheet) {
      console.error("No reserves sheet found");
      return { total_usd: null, total_inr: null, gold_usd: null, gold_inr: null, gold_tons: null };
    }

    const rows = reservesSheet.data;
    let total_usd = null, total_inr = null;
    let gold_usd = null, gold_inr = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.length) continue;
      const firstCell = String(row[0] || "").trim();

      // Match "1 Total Reserves" (exact start, case‑insensitive)
      if (firstCell.match(/^1\s+Total Reserves/i)) {
        // column index 2 (third column) = USD million, index 1 = INR crore
        if (row[2] !== undefined && !isNaN(parseFloat(row[2]))) total_usd = parseFloat(row[2]);
        if (row[1] !== undefined && !isNaN(parseFloat(row[1]))) total_inr = parseFloat(row[1]);
      }

      // Match "1.2 Gold"
      if (firstCell.match(/^1\.2\s+Gold/i)) {
        if (row[2] !== undefined && !isNaN(parseFloat(row[2]))) gold_usd = parseFloat(row[2]);
        if (row[1] !== undefined && !isNaN(parseFloat(row[1]))) gold_inr = parseFloat(row[1]);
      }
    }

    // Gold tonnes: not available in this sheet – leave null
    return { total_usd, total_inr, gold_usd, gold_inr, gold_tons: null };
  } catch (err) {
    console.error("parseReservesExcel error:", err);
    return { total_usd: null, total_inr: null, gold_usd: null, gold_inr: null, gold_tons: null };
  }
}

// ========== SPOT RATE PARSER (simplified – uses T_5 or "Ratios and Rates" sheet) ==========
function parseSpotRateExcel(buf) {
  try {
    const sheets = XLSX.parse(buf);
    let spotSheet = null;
    for (const sheet of sheets) {
      const firstRows = sheet.data.slice(0, 10).map(r => r.join(" ")).join(" ");
      if (firstRows.includes("Ratios and Rates") || sheet.name === "T_5") {
        spotSheet = sheet;
        break;
      }
    }
    if (!spotSheet) return { usd_inr: null, eur_inr: null };

    const rows = spotSheet.data;
    let usd_inr = null, eur_inr = null;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row.length) continue;
      const firstCell = String(row[0] || "").trim().toLowerCase();

      // USD row
      if (firstCell.includes("inr-us$ spot rate") || (firstCell.includes("usd") && firstCell.includes("spot"))) {
        // Scan from rightmost column to left for a number between 10 and 300
        for (let j = row.length - 1; j >= 0; j--) {
          const val = parseFloat(row[j]);
          if (!isNaN(val) && val > 10 && val < 300) {
            usd_inr = val;
            break;
          }
        }
      }
      // EUR row
      if (firstCell.includes("inr-euro spot rate") || (firstCell.includes("euro") && firstCell.includes("spot"))) {
        for (let j = row.length - 1; j >= 0; j--) {
          const val = parseFloat(row[j]);
          if (!isNaN(val) && val > 10 && val < 300) {
            eur_inr = val;
            break;
          }
        }
      }
    }
    return { usd_inr, eur_inr };
  } catch (err) {
    console.error("parseSpotRateExcel error:", err);
    return { usd_inr: null, eur_inr: null };
  }
}

// ========== YAHOO FINANCE (optional) ==========
async function getYahooValue(symbol, targetDate) {
  try {
    const start = new Date(targetDate);
    start.setDate(start.getDate() - 3);
    const end = new Date(targetDate);
    end.setDate(end.getDate() + 3);
    const from = Math.floor(start.getTime() / 1000);
    const to = Math.floor(end.getTime() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1d&events=history`;
    const res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" } },
      5000
    );
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];
    const targetMs = targetDate.getTime();
    let bestIdx = -1,
      bestDiff = Infinity;
    ts.forEach((t, i) => {
      const diff = Math.abs(t * 1000 - targetMs);
      if (diff < bestDiff && closes[i] != null) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    return bestIdx !== -1 ? closes[bestIdx] : null;
  } catch {
    return null;
  }
}

// ========== PROCESS ONE FRIDAY ==========
async function processOneFriday(friday) {
  const iso = isoDate(friday);
  try {
    const html = await getRbiPageHtml(friday);
    const urls = findExcelUrls(html);
    if (!urls.reserves) return { iso, error: "no reserves Excel link" };

    const [resBuf, spotBuf] = await Promise.all([
      downloadXlsx(urls.reserves).catch((e) => null),
      urls.spot ? downloadXlsx(urls.spot).catch(() => null) : Promise.resolve(null),
    ]);
    if (!resBuf) return { iso, error: "reserves Excel download failed" };

    const reserves = parseReservesExcel(resBuf);
    if (reserves.total_usd == null) {
      return { iso, error: "parse reserves failed (no total_usd found)" };
    }

    const spot = spotBuf ? parseSpotRateExcel(spotBuf) : { usd_inr: null, eur_inr: null };
    const nifty = await getYahooValue("^NSEI", friday);
    const sensex = await getYahooValue("^BSESN", friday);

    return {
      iso,
      record: {
        date: iso,
        total_usd: reserves.total_usd,
        total_inr: reserves.total_inr,
        gold_usd: reserves.gold_usd,
        gold_inr: reserves.gold_inr,
        gold_tons: reserves.gold_tons,
        usd_inr: spot.usd_inr,
        eur_inr: spot.eur_inr,
        nifty,
        sensex,
      },
    };
  } catch (err) {
    console.error(`processOneFriday error for ${iso}:`, err);
    return { iso, error: `unexpected: ${err.message}` };
  }
}

// ========== MAIN HANDLER ==========
exports.handler = async (event) => {
  const query = event.queryStringParameters || {};
  let weekOffset = parseInt(query.weekOffset);
  if (isNaN(weekOffset)) weekOffset = 0;

  const allFridays = getAllFridaysUntilToday();
  if (weekOffset >= allFridays.length) {
    return {
      statusCode: 404,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ error: "No more weeks", done: true }),
    };
  }

  const targetFriday = allFridays[allFridays.length - 1 - weekOffset];
  const result = await processOneFriday(targetFriday);

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      done: false,
      record: result.record || null,
      error: result.error || null,
      weekIndex: weekOffset,
      totalWeeks: allFridays.length,
    }),
  };
};