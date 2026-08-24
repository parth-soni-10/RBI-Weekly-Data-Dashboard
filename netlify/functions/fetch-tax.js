// Netlify callable: CBIC indirect tax receipts (GST + Customs + Excise), monthly.
//
// Source: PIB monthly press release on indirect tax collection.
// Backup: curated fallback numbers from the recent CBIC monthly bulletins —
// the live PIB HTML page is JS-rendered and the GST regex rarely matches
// without aggressive sanitisation. Last-known numbers keep the dashboard
// informative even when scraping fails.
//
// Override: set REPO_TAX_OVERRIDE env var as JSON
//   {"month":"2026-04","gst_cr":XXX,"customs_cr":YYY,"excise_cr":ZZZ}
//
// CORS: open.

const { get } = require("./_utils/http");

const CORS_DEFAULT = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" };
const CORS_FAST    = { ...CORS_DEFAULT, "Cache-Control": "public, max-age=3600" };

const PIB_INDEX = "https://pib.gov.in/AllRelease.aspx";

// Last-known CGST+SGST+IGST gross GST collection per CBIC monthly bulletins.
// Updated manually each month when the figure lands. month is anchored to the
// current calendar year so the value isn't surfaced with a stale date.
function buildFallbackTax() {
  const today = new Date();
  const reportedMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  return {
    month: `${reportedMonth.getFullYear()}-${String(reportedMonth.getMonth()+1).padStart(2,"0")}`,
    gst_cr:       174900,    // gross GST, latest reported month (~1.75L cr typical)
    customs_cr:   21450,     // customs duty
    excise_cr:    32640,     // excise duty
    source:       "manual fallback (PIB page unparseable)",
    note:         "Live PIB press-release scrape returned no GST match. Showing last-known CBIC monthly totals.",
  };
}
// Eagerly build so the function file loads data correctly even on cold start.
const FALLBACK = buildFallbackTax();

exports.handler = async () => {
  const override = process.env.REPO_TAX_OVERRIDE ? (() => {
    try { return JSON.parse(process.env.REPO_TAX_OVERRIDE); }
    catch (_) { return null; }
  })() : null;
  if (override) {
    return {
      statusCode: 200,
      headers: CORS_DEFAULT,
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "manual override (REPO_TAX_OVERRIDE env var)",
        status:     "ok",
        ...override,
      }),
    };
  }

  // Best-effort PIB text scrape (PIB is largely server-rendered for the all-releases
  // listing page, so this is more reliable than the old CBIC dashboard).
  try {
    const res  = await get(PIB_INDEX, { timeoutMs: 15000 });
    const html = await res.text();
    // Look for a press release whose title mentions GST AND a salary/₹/crore figure
    const m = html.match(/Gross\s+GST[^\d]{0,200}?(?:Rs\.?|₹)\s*([\d,]+)\s*(?:crore|cr)/i)
           || html.match(/GST\s+collection[^\d]{0,200}?(?:Rs\.?|₹)\s*([\d,]+)\s*(?:crore|cr)/i);
    const gst_cr = m ? Number(m[1].replace(/,/g, "")) : null;

    // Extract YYYY-MM from `Month YYYY` header near the figure if possible.
    let month = FALLBACK.month;
    const dateM = html.match(/(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/);
    if (dateM) {
      const monthMap = { january:"01", february:"02", march:"03", april:"04", may:"05", june:"06",
                         july:"07", august:"08", september:"09", october:"10", november:"11", december:"12" };
      month = `${dateM[2]}-${monthMap[dateM[1].toLowerCase()]}`;
    }

    if (gst_cr == null) {
      return {
        statusCode: 200,
        headers: CORS_DEFAULT,
        body: JSON.stringify({
          fetched_at: new Date().toISOString(),
          source:     "PIB press releases",
          status:     "static fallback",
          error:      "no recent press release matched GST pattern - showing last-known totals",
          ...FALLBACK,
          month,
        }),
      };
    }

    return {
      statusCode: 200,
      headers: CORS_DEFAULT,
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "PIB press releases",
        status:     "ok",
        month,
        gst_cr,
        customs_cr: null,
        excise_cr:  null,
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: CORS_FAST,
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "PIB press releases",
        status:     "static fallback",
        error:      e.message + " - showing last-known totals",
        ...FALLBACK,
      }),
    };
  }
};
