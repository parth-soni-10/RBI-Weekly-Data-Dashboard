const fetch = require("node-fetch");
const XLSX  = require("node-xlsx");

// ─── date helpers ─────────────────────────────────────────────
function getAllFridaysUntilToday() {
  const start = new Date("2026-01-01");
  const end   = new Date();
  const fridays = [];
  const day = start.getDay();
  const daysAhead = day <= 5 ? 5 - day : 12 - day;
  const cur = new Date(start);
  cur.setDate(cur.getDate() + (daysAhead === 0 ? 7 : daysAhead));
  while (cur <= end) { fridays.push(new Date(cur)); cur.setDate(cur.getDate() + 7); }
  return fridays;
}
function fmtDate(d) { return `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`; }
function isoDate(d) { return d.toISOString().slice(0,10); }

// ─── RBI helpers ──────────────────────────────────────────────
async function getRbiPageHtml(d) {
  const url = `https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtDate(d)}`;
  const res = await fetch(url, { timeout: 20000, headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function findExcelUrls(html) {
  // Return map of keyword→url for all xlsx links on the page
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
  const res = await fetch(url, { timeout: 20000, headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── Excel parsers ────────────────────────────────────────────
function parseReservesExcel(buf) {
  const sheets = XLSX.parse(buf);
  const r = { total_usd:null, total_inr:null, gold_usd:null, gold_inr:null, gold_tons:null };
  if (!sheets.length) return r;
  for (const row of sheets[0].data) {
    const t = row.map(c => String(c??'').toLowerCase()).join(' ');
    const nums = () => row.map(c=>parseFloat(c)).filter(n=>!isNaN(n));
    if ((t.includes('total reserves')||t.includes('total foreign exchange reserves')) && r.total_usd===null) {
      const n = nums(); if (n[0]) r.total_usd=n[0]; if (n[1]) r.total_inr=n[1];
    }
    if (t.includes('gold') && !t.includes('total') && r.gold_usd===null) {
      const n = nums(); if (n[0]) r.gold_usd=n[0]; if (n[1]) r.gold_inr=n[1]; if (n[2]) r.gold_tons=n[2];
    }
    if (t.includes('gold') && (t.includes('tonnes')||t.includes('metric')||t.includes('tons')) && r.gold_tons===null) {
      const n = nums(); if (n[0]) r.gold_tons=n[0];
    }
  }
  return r;
}

function parseSpotRateExcel(buf) {
  const sheets = XLSX.parse(buf);
  const r = { usd_inr:null, eur_inr:null };
  if (!sheets.length) return r;
  for (const row of sheets[0].data) {
    const t = row.map(c=>String(c??'').toLowerCase()).join(' ');
    const nums = () => row.map(c=>parseFloat(c)).filter(n=>!isNaN(n)&&n>10&&n<300);
    if ((t.includes('us dollar')||t.includes('usd')||t.includes('dollar')) && !t.includes('euro') && r.usd_inr===null) {
      const n=nums(); if (n[0]) r.usd_inr=n[0];
    }
    if ((t.includes('euro')||t.includes('eur')) && r.eur_inr===null) {
      const n=nums(); if (n[0]) r.eur_inr=n[0];
    }
    if (r.usd_inr && r.eur_inr) break;
  }
  return r;
}

// ─── Yahoo Finance ────────────────────────────────────────────
async function getYahooMap(symbol, fromDate, toDate) {
  const from = Math.floor(fromDate.getTime()/1000);
  const to   = Math.floor(toDate.getTime()/1000);
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?period1=${from}&period2=${to}&interval=1wk&events=history`;
  try {
    const res = await fetch(url, { timeout:15000, headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"} });
    if (!res.ok) return {};
    const json = await res.json();
    const result = json?.chart?.result?.[0];
    if (!result) return {};
    const ts = result.timestamp||[], closes = result.indicators?.quote?.[0]?.close||[];
    const map = {};
    ts.forEach((t,i) => {
      const d = new Date(t*1000);
      const daysToFri = (5-d.getDay()+7)%7;
      const fri = new Date(d); fri.setDate(fri.getDate()+daysToFri);
      if (closes[i]!=null) map[fri.toISOString().slice(0,10)] = closes[i];
    });
    return map;
  } catch { return {}; }
}

// ─── process one Friday (page fetch + both excels in parallel) ─
async function processFriday(friday, niftyMap, sensexMap) {
  const iso = isoDate(friday);
  let html;
  try { html = await getRbiPageHtml(friday); }
  catch(e) { return { iso, error: `page: ${e.message}` }; }

  const urls = findExcelUrls(html);
  if (!urls.reserves) return { iso, error: 'no reserves Excel link' };

  // download both excels in parallel
  const [resBuf, spotBuf] = await Promise.all([
    downloadXlsx(urls.reserves).catch(e=>null),
    urls.spot ? downloadXlsx(urls.spot).catch(()=>null) : Promise.resolve(null),
  ]);

  if (!resBuf) return { iso, error: 'reserves Excel download failed' };

  const res  = parseReservesExcel(resBuf);
  const spot = spotBuf ? parseSpotRateExcel(spotBuf) : { usd_inr:null, eur_inr:null };

  if (res.total_usd == null) return { iso, error: 'parse failed' };

  return {
    iso,
    record: {
      date:      iso,
      total_usd: res.total_usd,
      total_inr: res.total_inr,
      gold_usd:  res.gold_usd,
      gold_inr:  res.gold_inr,
      gold_tons: res.gold_tons,
      usd_inr:   spot.usd_inr,
      eur_inr:   spot.eur_inr,
      nifty:     niftyMap[iso]  ?? null,
      sensex:    sensexMap[iso] ?? null,
    }
  };
}

// ─── main ─────────────────────────────────────────────────────
exports.handler = async () => {
  const fridays = getAllFridaysUntilToday();
  const logs    = [];
  const records = [];

  logs.push(`Processing ${fridays.length} Fridays in parallel batches…`);

  // Yahoo: both in parallel, upfront
  const rangeStart = fridays[0], rangeEnd = new Date();
  logs.push('Fetching Nifty 50 + Sensex from Yahoo Finance…');
  const [niftyMap, sensexMap] = await Promise.all([
    getYahooMap("^NSEI",  rangeStart, rangeEnd),
    getYahooMap("^BSESN", rangeStart, rangeEnd),
  ]);
  logs.push(`  Nifty: ${Object.keys(niftyMap).length} pts  |  Sensex: ${Object.keys(sensexMap).length} pts`);

  // RBI: batches of 4 concurrent (polite to RBI server)
  const BATCH = 4;
  for (let i = 0; i < fridays.length; i += BATCH) {
    const batch = fridays.slice(i, i+BATCH);
    const results = await Promise.all(batch.map(f => processFriday(f, niftyMap, sensexMap)));
    for (const r of results) {
      if (r.record) {
        records.push(r.record);
        logs.push(`  ✓ ${r.iso} | Reserves $${r.record.total_usd?.toLocaleString()}M | USD/INR ${r.record.usd_inr??'N/A'} | Nifty ${r.record.nifty?.toFixed(0)??'N/A'}`);
      } else {
        logs.push(`  ✗ ${r.iso} — ${r.error}`);
      }
    }
    // small courtesy delay between batches
    if (i + BATCH < fridays.length) await new Promise(r=>setTimeout(r,300));
  }

  logs.push(`✓ Complete — ${records.length}/${fridays.length} records.`);
  records.sort((a,b)=>a.date.localeCompare(b.date));

  // compute last-Friday link for footer
  const lastFriday = fridays[fridays.length-1];
  const lastFridayUrl = lastFriday
    ? `https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=${fmtDate(lastFriday)}`
    : null;
  const lastFridayIso = lastFriday ? isoDate(lastFriday) : null;

  return {
    statusCode: 200,
    headers: { "Content-Type":"application/json", "Access-Control-Allow-Origin":"*" },
    body: JSON.stringify({ records, logs, lastFridayUrl, lastFridayIso }),
  };
};
