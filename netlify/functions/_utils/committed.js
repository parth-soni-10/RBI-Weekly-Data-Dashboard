// Shared reader for the committed weekly data file (public/rbi-data.json).
//
// The public /data/*.json endpoints used to scrape RBI on every request. On
// Cloudflare that is the wrong shape: a Worker's response is only cached when
// the handler itself stores it, so a cold request ran the whole scrape —
// data-latest walks back up to six Fridays, each a WSS page fetch plus Excel
// retries — and took minutes instead of answering. The committed snapshot IS
// the site's source of truth (the Friday refresh keeps it current and the deploy
// ships it), so these endpoints serve it through the Pages ASSETS binding
// rather than touching RBI at all.
//
// The binding is injected from functions/_router.js with setAssets(), the same
// way data-sync takes its KV store through setStore() — no handler reaches for a
// global, and a test can hand it a fake.

let assets = null;

/** The Pages ASSETS binding. Called once per request by the router. */
function setAssets(fetcher) {
  assets = fetcher || null;
}

/**
 * Parse and return the committed public/rbi-data.json.
 * `origin` is the request URL the router saw; ASSETS resolves by path, so any
 * absolute base works, but using the real origin keeps it honest.
 */
async function readRbiData(origin) {
  if (!assets) throw new Error("no asset store wired");
  const base = origin || "https://rbiweeklydashboard.pages.dev/";
  const url = new URL("/rbi-data.json", base).toString();
  const res = await assets.fetch(new Request(url, { method: "GET" }));
  if (!res.ok) throw new Error(`rbi-data.json: HTTP ${res.status}`);
  return res.json();
}

/** The snapshot's dated records, oldest first. */
function datedRecords(data) {
  return (data && Array.isArray(data.records) ? data.records : [])
    .filter(r => r && /^\d{4}-\d{2}-\d{2}$/.test(String(r.date || "")))
    .sort((a, b) => a.date.localeCompare(b.date));
}

module.exports = { setAssets, readRbiData, datedRecords };
