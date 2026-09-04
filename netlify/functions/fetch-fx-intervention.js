// Netlify callable: RBI FX Forward Position (USD bn) — the Reserve Bank's
// outstanding NET position in its forward dollar book. This is the closest
// public proxy for FX intervention and is the data behind the "RBI Fwd
// Position" macro tile plus the "RBI forward book" history chart.
//
// ── WHY THIS IS CURATED (not scraped) ─────────────────────────────────────
// RBI discloses its net forward position MONTHLY in the RBI Bulletin's
// statistical appendix ("Foreign Exchange Reserves"), and at half-yearly
// frequency in the Report on Management of Foreign Exchange Reserves. But the
// figure is not exposed through any stable, parseable HTML table or API (the
// Bulletin pages are JS-rendered and the reports are PDFs), so — like the PM
// CARES data in index.html — the series below is curated from published
// figures (RBI publications as carried by Business Standard / Reuters / Times
// of India / Fortune India / Informist).
//
// To update: when a new month's figure is reported, ADD one entry at the END
// of FWD_SERIES and bump nothing else — `latest` is derived from the last row.
//
// ── SIGN CONVENTION ───────────────────────────────────────────────────────
//   net_fwd > 0  = net forward ASSETS    (RBI long dollars, buying USD forward)
//   net_fwd < 0  = net forward LIABILITIES (RBI short dollars / selling USD
//                  forward). The press reports the recent era as "net short
//                  dollar position in the forward market".
//
// CORS: open.
//
// Output shape:
//   {
//     fetched_at, source, status, month, net_fwd,
//     history: [ { date: "YYYY-MM", net_fwd, approx?, source } ]
//   }

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" };

// Monthly values as-of month-end, USD bn (signed per convention above).
// approx=true marks values implied from published deltas rather than quoted directly.
const FWD_SERIES = [
  { date: "2021-03", net_fwd:   72.80, source: "RBI Bulletin article, Apr 2022" },
  { date: "2025-02", net_fwd:  -88.75, source: "RBI Bulletin via Fortune India, Jun 2025 (peak since 2007)" },
  { date: "2025-03", net_fwd:  -84.34, approx: true, source: "RBI Bulletin via Business Standard — implied by FY26 net change of +$18.72bn" },
  { date: "2025-04", net_fwd:  -72.58, source: "RBI Bulletin (Jun 2025) via Fortune India" },
  { date: "2025-08", net_fwd:  -53.36, source: "RBI Bulletin via Informist/Reuters, Nov 2025" },
  { date: "2025-09", net_fwd:  -59.41, source: "RBI Bulletin via Reuters, Oct 2025 (first rise after six months of declines)" },
  { date: "2026-01", net_fwd:  -67.80, source: "RBI Bulletin via Reuters/Bit.Fan, Jul 2026" },
  { date: "2026-02", net_fwd:  -77.67, source: "RBI Bulletin via Business Standard, May 2026" },
  { date: "2026-03", net_fwd: -103.06, source: "RBI Bulletin via Business Standard, May 2026" },
  { date: "2026-05", net_fwd: -106.60, source: "RBI Bulletin via Times of India, Jul 2026 (record at the time)" },
  { date: "2026-06", net_fwd: -103.33, source: "RBI Bulletin via Business Standard, Aug 2026" },
  { date: "2026-07", net_fwd: -136.77, source: "RBI Bulletin via Business Standard, 31 Aug 2026 (record)" },
];

exports.handler = async () => {
  const latest = FWD_SERIES[FWD_SERIES.length - 1];

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source: "RBI Bulletin — monthly disclosure of outstanding net forward position (curated)",
      status: "static fallback", // honest: curated figures, not a live scrape
      month: latest.date,
      net_fwd: latest.net_fwd,
      history: FWD_SERIES.map(p => ({
        date: p.date,
        net_fwd: p.net_fwd,
        ...(p.approx ? { approx: true } : {}),
        source: p.source,
      })),
      note: "RBI discloses its net forward position monthly in the RBI Bulletin but not through a parseable table/API. Series is curated from RBI publications as carried by BS/Reuters/ToI/Fortune/Informist; add the newest month to FWD_SERIES when reported. RBI publishes no currency split, so there is no separate euro forward figure.",
    }),
  };
};
