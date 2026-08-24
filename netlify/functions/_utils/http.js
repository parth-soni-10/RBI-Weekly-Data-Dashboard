// Shared HTTP helper. Centralizing UA + timeouts so all scrapers behave the same.
// Caches don't live here — Netlify Blobs are the recommended cache layer.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const DEFAULT_TIMEOUT_MS = 12000;

async function get(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, referer } = {}) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Accept":     "text/html,application/xhtml+xml,application/json,text/plain,*/*",
        ...(referer ? { "Referer": referer } : {}),
        ...headers,
      },
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${url}`);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// Decode the HTML entities real pages emit (nbsp is the critical one — a raw
// non-breaking space breaks numeric parsing if left untouched).
function decodeEntities(s) {
  const safe = cp => { try { return String.fromCodePoint(cp); } catch (_) { return ""; } };
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safe(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safe(parseInt(d, 10)));
}

// Disney-cheerio alternative: minimal HTML table extractor (no external dep).
// Walks all <table> nodes, returns rows as arrays of trimmed cell strings.
function extractHtmlTables(html) {
  const tables = [];
  const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = tableRe.exec(html)) !== null) {
    const rows = [];
    const trRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(m[1])) !== null) {
      const cells = [];
      const tdRe  = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
      let td;
      while ((td = tdRe.exec(tr[1])) !== null) {
        cells.push(decodeEntities(td[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim());
      }
      if (cells.length) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}

// Pure utility: keep only numeric cells above 0; parse comma-formatted Indian nums.
function parseNum(v) {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  const s = String(v).trim();
  const cleaned = s.replace(/[\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return NaN;
  const n = parseFloat(cleaned);
  return isNaN(n) ? NaN : n;
}

module.exports = { get, extractHtmlTables, parseNum, UA };
