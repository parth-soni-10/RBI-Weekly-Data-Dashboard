// Netlify callable: RBI FX Forward Position (USD bn) — the Reserve Bank's
// outstanding NET position in its forward dollar book. This is the closest
// public proxy for FX intervention and is the data behind the "RBI Fwd
// Position" macro tile plus the "RBI forward book" history chart.
//
// ── WHY THIS IS CURATED (not scraped) ─────────────────────────────────────
// RBI discloses its net forward position MONTHLY in the RBI Bulletin's
// statistical appendix ("Foreign Exchange Reserves") and at HALF-YEARLY
// frequency in the "Half-Yearly Report on Management of Foreign Exchange
// Reserves" (the figures match across the two publications — e.g. end-Sep
// 2025 reads $59.40bn in both). But the figure is not exposed through any
// stable, parseable HTML table or API (the Bulletin pages are JS-rendered
// and the reports are PDFs), so — like the PM CARES data in index.html —
// the series below is curated from official RBI reports and figures carried
// by Business Standard / Reuters / Times of India / Fortune India / Informist.
//
// To update:
//  - half-yearly report figures (Mar/Sep): handled automatically —
//    scripts/update-fwd-series.js appends/upgrades this array whenever RBI
//    publishes a newer half-yearly FX reserves report (runs in the daily cron
//    and on every deploy).
//  - monthly Bulletin figures (2025+): still added by hand — ADD one entry and
//    bump nothing else; `latest` is derived from the last row.
//
// ── CADENCE ──────────────────────────────────────────────────────────────
// 2021-03 → 2024-09 : half-yearly disclosures (each Half-Yearly FX Reserves
//                     Report states the figure "as at the end of March /
//                     September"). The weekly chart carries each value
//                     across weeks until the next release steps it.
// 2025-02 → today   : monthly RBI Bulletin disclosures (month-end values).
//
// ── SIGN CONVENTION ───────────────────────────────────────────────────────
//   net_fwd > 0  = net forward ASSETS    (RBI long dollars, buying USD forward)
//   net_fwd < 0  = net forward LIABILITIES (RBI short dollars / selling USD
//                  forward). RBI's reports phrase this "net forward asset
//                  (receivable)" for the long era and "net forward asset
//                  (payable)" once payables dominate; the press reports the
//                  recent era as "net short dollar position in the forward
//                  market". Numbers below are signed accordingly.
//
// CORS: open.
//
// Output shape:
//   {
//     fetched_at, source, status, month, net_fwd,
//     history: [ { date: "YYYY-MM", net_fwd, approx?, source } ]
//   }

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=86400" };

// Values as-of period end, USD bn (signed per convention above).
// approx=true marks values implied from published deltas rather than quoted directly.
const FWD_SERIES = [
  { date: "2021-03", net_fwd:   72.80, source: "RBI Bulletin article, Apr 2022 (long-era anchor)" },
  { date: "2021-09", net_fwd:   49.11, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2021" },
  { date: "2022-03", net_fwd:   65.79, source: "RBI Half-Yearly FX Reserves Report, Oct 2021–Mar 2022" },
  { date: "2022-09", net_fwd:   28.40, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2022" },
  { date: "2023-03", net_fwd:   23.60, source: "RBI Half-Yearly FX Reserves Report, Oct 2022–Mar 2023" },
  { date: "2023-09", net_fwd:    4.64, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2023" },
  { date: "2024-03", net_fwd:   -0.54, source: "RBI Half-Yearly FX Reserves Report, Oct 2023–Mar 2024 (net payable ≈ nil — book at the flip)" },
  { date: "2024-09", net_fwd:  -14.58, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2024 (net payable — short era begins)" },
  { date: "2025-02", net_fwd:  -88.75, source: "RBI Bulletin via Fortune India, Jun 2025 (peak since 2007)" },
  { date: "2025-03", net_fwd:  -84.345, source: "RBI Half-Yearly FX Reserves Report, Oct 2024–Mar 2025 (exact)" },
  { date: "2025-04", net_fwd:  -72.58, source: "RBI Bulletin (Jun 2025) via Fortune India" },
  { date: "2025-08", net_fwd:  -53.36, source: "RBI Bulletin via Informist/Reuters, Nov 2025" },
  { date: "2025-09", net_fwd:  -59.41, source: "RBI Bulletin via Reuters, Oct 2025 (first rise after six months of declines)" },
  { date: "2025-10", net_fwd:  -63.60, source: "RBI Bulletin via Business Standard, 23 Dec 2025" },
  { date: "2025-11", net_fwd:  -66.04, source: "RBI Bulletin via Business Standard, 31 Dec 2025 (7-month high)" },
  { date: "2025-12", net_fwd:  -62.35, source: "RBI Bulletin via Informist, 31 Jan 2026 ($3.69bn lower than Nov)" },
  { date: "2026-01", net_fwd:  -67.80, source: "RBI Bulletin via Reuters/Bit.Fan, Jul 2026" },
  { date: "2026-02", net_fwd:  -77.67, source: "RBI Bulletin via Business Standard, May 2026" },
  { date: "2026-03", net_fwd: -103.06, source: "RBI Bulletin via Business Standard, May 2026" },
  { date: "2026-04", net_fwd:  -95.00, approx: true, source: "RBI Bulletin via Business Standard/TOI, May-Jul 2026 ($95bn, published rounded)" },
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
      source: "RBI Bulletin (monthly, 2025+) & Half-Yearly FX Reserves Reports (2021-2024) — curated",
      status: "static fallback", // honest: curated figures, not a live scrape
      month: latest.date,
      net_fwd: latest.net_fwd,
      history: FWD_SERIES.map(p => ({
        date: p.date,
        net_fwd: p.net_fwd,
        ...(p.approx ? { approx: true } : {}),
        source: p.source,
      })),
      note: "RBI discloses its net forward position monthly in the RBI Bulletin and half-yearly in the Report on Management of Foreign Exchange Reserves, but through no parseable table/API, so the series is curated (official reports + BS/Reuters/ToI/Fortune/Informist). Add each new period to FWD_SERIES when reported. RBI publishes no currency split, so there is no separate euro forward figure.",
    }),
  };
};
