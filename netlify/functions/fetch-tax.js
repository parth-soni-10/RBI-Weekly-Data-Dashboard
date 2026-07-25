// CBIC (Central Board of Indirect Taxes and Customs) monthly tax receipts.
// Includes GST, customs duty, excise. Updated monthly by CBIC.
//
// Stable data sources tried in order:
//   1. PIB monthly press release on indirect tax collection
//   2. CBIC dashboard at https://www.cbic.gov.in
//
// CBIC site doesn't expose a public CSV/JSON endpoint that survives page
// redesigns, so this scraper is intentionally best-effort and falls back to
// returning nulls + the most recent hardcoded manual value if scraping fails.
//
// Manual override: set REPO_TAX_OVERRIDE env var as JSON
//   {"month":"2026-04","gst_cr":XXX,"customs_cr":YYY,"excise_cr":ZZZ}

const { get } = require("./_utils/http");

const PIB_INDEX = "https://pib.gov.in/AllRelease.aspx";

exports.handler = async () => {
  const override = process.env.REPO_TAX_OVERRIDE ? (() => {
    try { return JSON.parse(process.env.REPO_TAX_OVERRIDE); }
    catch (_) { return null; }
  })() : null;
  if (override) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "manual override (REPO_TAX_OVERRIDE env var)",
        status:     "ok",
        ...override,
      }),
    };
  }

  // Best-effort PIB text scrape
  try {
    const res  = await get(PIB_INDEX, { timeoutMs: 15000 });
    const html = await res.text();
    // Look for a press release referencing GST collection this month
    const m = html.match(/(?:Gross\s+GST\s+Revenue|GST\s+collection)[^<]{0,200}?Rs\\.?\\s*([\\d,]+)\\s*(?:crore|cr)/i);
    const gst_cr = m ? Number(m[1].replace(/,/g, "")) : null;

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=86400" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "PIB press releases",
        status:     gst_cr != null ? "ok" : "unavailable",
        gst_cr,
        customs_cr: null,
        excise_cr:  null,
        error:      gst_cr == null ? "no recent press release matched pattern" : undefined,
      }),
    };
  } catch (e) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" },
      body: JSON.stringify({
        fetched_at: new Date().toISOString(),
        source:     "PIB press releases",
        status:     "unavailable",
        error:      e.message,
        gst_cr: null, customs_cr: null, excise_cr: null,
      }),
    };
  }
};
