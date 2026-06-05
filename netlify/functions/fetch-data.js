const fetch = require("node-fetch");
const XLSX = require("node-xlsx");

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

// Short timeouts to stay under 10s total
const FETCH_TIMEOUT = 6000;      // 6 seconds per fetch
const EXCEL_TIMEOUT = 5000;      // 5 seconds per Excel download

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

async function getRbiPageHtml(d) {
  const url = `https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtDate(d)}`;
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  }, FETCH_TIMEOUT);
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
  const res = await fetchWithTimeout(url, {
    headers: { "User-Agent": "Mozilla/5.0" }
  }, EXCEL_TIMEOUT);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function parseReservesExcel(buf) {
  const sheets = XLSX.parse(buf);
  const r = { total_usd: null, total_inr: null, gold_usd: null, gold_inr: null, gold_tons: null };
  if (!sheets.length) return r;
  for (const row of sheets[0].data) {
    const t = row.map(c => String(c ?? '')).join(' ').toLowerCase();
    const nums = () => row.map(c => parseFloat(c)).filter(n => !isNaN(n));
    if ((t.includes('total reserves') || t.includes('total foreign exchange reserves')) && r.total_usd === null) {
      const n = nums(); if (n[0]) r.total_usd = n[0]; if (n[1]) r.total_inr = n[1];
    }
    if (t.includes('gold') && !t.includes('total') && r.gold_usd === null) {
      const n = nums(); if (n[0]) r.gold_usd = n[0]; if (n[1]) r.gold_inr = n[1]; if (n[2]) r.gold_tons = n[2];
    }
    if (t.includes('gold') && (t.includes('tonnes') || t.includes('metric') || t.includes('tons')) && r.gold_tons === null) {
      const n = nums(); if (n[0]) r.gold_tons = n[0];
    }
  }
  return r;
}

function parseSpotRateExcel(buf) {
  const sheets = XLSX.parse(buf);
  const r = { usd_inr: null, eur_inr: null };
  if (!sheets.length) return r;
  for (const row of sheets[0].data) {
    const t = row.map(c => String(c ?? '')).join(' ').toLowerCase();
    const nums = () => row.map(c => parseFloat(c)).filter(n => !isNaN(n) && n > 10 && n < 300);
    if ((t.includes('us dollar') || t.includes('usd') || t.includes('dollar')) && !t.includes('euro') && r.usd_inr === null) {
      const n = nums(); if (n[0]) r.usd_inr = n[0];
    }
    if ((t.includes('euro') || t.includes('eur')) && r.eur_inr === null) {
      const n = nums(); if (n[0]) r.eur_inr = n[0];
    }
    if (r.usd_inr && r.eur_inr) break;
  }
  return r;
}

// Yahoo – with very short timeout and non‑critical
async function getYahooValue(symbol, targetDate) {
  const start = new Date(targetDate);
  start.setDate(start.getDate() - 3);
  const end = new Date(targetDate);
  end.setDate(end.getDate() + 3);
  const from = Math.floor(start.getTime() / 1000);
  const to = Math.floor(end.getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1d&events=history`;
  try {
    const res = await fetchWithTimeout(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    }, 4000); // 4 sec max
    if (!res.ok) return null;
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return null;
    const ts = result.timestamp || [], closes = result.indicators?.quote?.[0]?.close || [];
    const targetMs = targetDate.getTime();
    let bestIdx = -1, bestDiff = Infinity;
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

async function processOneFriday(friday) {
  const iso = isoDate(friday);
  let html;
  try {
    html = await getRbiPageHtml(friday);
  } catch (e) {
    return { iso, error: `page: ${e.message}` };
  }

  const urls = findExcelUrls(html);
  if (!urls.reserves) {
    return { iso, error: 'no reserves Excel link' };
  }

  // Download both Excels in parallel, but don't let one failure stop the other
  const [resBuf, spotBuf] = await Promise.all([
    downloadXlsx(urls.reserves).catch(e => null),
    urls.spot ? downloadXlsx(urls.spot).catch(() => null) : Promise.resolve(null),
  ]);

  if (!resBuf) {
    return { iso, error: 'reserves Excel download failed' };
  }

  const res = parseReservesExcel(resBuf);
  const spot = spotBuf ? parseSpotRateExcel(spotBuf) : { usd_inr: null, eur_inr: null };

  if (res.total_usd == null) {
    return { iso, error: 'parse failed' };
  }

  // Yahoo is optional – don't fail if it times out
  const nifty = await getYahooValue("^NSEI", friday).catch(() => null);
  const sensex = await getYahooValue("^BSESN", friday).catch(() => null);

  return {
    iso,
    record: {
      date: iso,
      total_usd: res.total_usd,
      total_inr: res.total_inr,
      gold_usd: res.gold_usd,
      gold_inr: res.gold_inr,
      gold_tons: res.gold_tons,
      usd_inr: spot.usd_inr,
      eur_inr: spot.eur_inr,
      nifty: nifty,
      sensex: sensex,
    }
  };
}

exports.handler = async (event) => {
  try {
    const query = event.queryStringParameters || {};
    let weekOffset = parseInt(query.weekOffset);
    if (isNaN(weekOffset)) weekOffset = 0;

    const allFridays = getAllFridaysUntilToday();
    if (weekOffset >= allFridays.length) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No more weeks", done: true })
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
        totalWeeks: allFridays.length
      })
    };
  } catch (err) {
    console.error("Fatal error in handler:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};