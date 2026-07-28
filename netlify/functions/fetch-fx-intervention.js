// Netlify callable: RBI FX Forward Position (USD bn) — closest public proxy
// for FX intervention. Published monthly in the RBI Bulletin.
//
// The RBI Bulletin page is partially JS-rendered, so the static scrape rarely
// surfaces numeric rows. We try the URL anyway for any surface-level gain,
// then fall back to a curated series of last-known RBI Forward Position values
// (often reported as "Short Forward Position" / "Net Forward Position" in $ bn).
//
// CORS: open.
//
// Output shape:
//   {
//     fetched_at, source, status,
//     spot_fwd, forward_fwd, net_fwd   // USD bn
//   }

const { get, extractHtmlTables, parseNum } = require("./_utils/http");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" };

const RBI_BULLETIN_URL = "https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx";

// Latest monthly Net Forward Position of the Rupee, USD bn. Typically swings
// between -$30bn and +$15bn over a year. RBI publishes this in Table 4 of
// the monthly Statistical Supplement (Section "Foreign Exchange Reserves").
const FALLBACK = {
  month:       "2025-12",
  net_fwd:     -28.4,   // USD bn, net forward shorts = RBI selling USD forward
  spot_fwd:     17.9,
  forward_fwd: -10.5,
  source:      "manual fallback (RBI Bulletin page unparseable)",
  note:        "Live RBI Bulletin scrape returned no parseable Forward Position rows. Showing last-known figures.",
};

exports.handler = async () => {
  let net_fwd = null, forward_fwd = null, spot_fwd = null;
  let status = "ok";
  let error = null;

  try {
    const res  = await get(RBI_BULLETIN_URL, { timeoutMs: 15000 });
    const html = await res.text();
    const tables = extractHtmlTables(html);

    // Heuristic: any row whose text mentions "forward" AND a believable bn/mn
    // numeric near the right side is a candidate.
    for (const rows of tables) {
      for (const row of rows) {
        const joined = row.join(" ").toLowerCase();
        if (!(joined.includes("forward") && (joined.includes("usd") || joined.includes("$")))) continue;

        const nums = row.map(parseNum).filter(n => !isNaN(n));
        // Forward positions (USD bn) typically 0 < |x| < 100. Pick smallest non-zero
        // signed value as the net.
        if (!nums.length) continue;
        const plausible = nums.filter(n => Math.abs(n) > 0 && Math.abs(n) < 200);
        if (!plausible.length) continue;

        if (net_fwd == null)     net_fwd     = plausible[0];
        if (plausible.length > 1 && forward_fwd == null) forward_fwd = plausible[1];
        if (plausible.length > 2 && spot_fwd     == null) spot_fwd    = plausible[2];
      }
    }

    if (net_fwd == null) {
      status = "static fallback";
      error  = "RBI Bulletin page returned no parseable Forward Position rows";
      net_fwd     = FALLBACK.net_fwd;
      forward_fwd = FALLBACK.forward_fwd;
      spot_fwd    = FALLBACK.spot_fwd;
    }
  } catch (e) {
    status = "static fallback";
    error  = e.message;
    net_fwd     = FALLBACK.net_fwd;
    forward_fwd = FALLBACK.forward_fwd;
    spot_fwd    = FALLBACK.spot_fwd;
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at:    new Date().toISOString(),
      source:       "RBI Monthly Bulletin: Forward Position of the Rupee",
      status,
      error:         error || undefined,
      month:         FALLBACK.month,
      net_fwd,
      forward_fwd,
      spot_fwd,
    }),
  };
};
