// Netlify callable: RBI FX Forward Position (USD bn) — the Reserve Bank's
// outstanding NET position in its forward dollar book. This is the closest
// public proxy for FX intervention and is the data behind the "RBI Fwd
// Position" macro tile plus the "RBI forward book" history chart.
//
// ── WHY THIS IS AUTO-UPDATED (not scraped live) ──────────────────────────
// RBI discloses its net forward position monthly in the RBI Bulletin's
// "Current Statistics" — table "4A. Maturity Breakdown (by Residual Maturity)
// of Outstanding Forwards of RBI (US$ Million)", a server-rendered
// BS_ViewBulletin page — and at HALF-YEARLY frequency in the "Half-Yearly
// Report on Management of Foreign Exchange Reserves" (the two match: e.g.
// end-Sep 2025 reads $59.40bn in both). Both are added to FWD_SERIES
// AUTOMATICALLY — this array is the machine-updated source of truth the
// function serves:
//
//   scripts/update-fwd-monthly.js  → reads the newest Bulletin issue's Table 4A
//     (runs in the daily cron + every deploy); --backfill walks every issue
//     from May 2021 (all 65 month-ends are now official Bulletin figures).
//   scripts/update-fwd-series.js   → appends/upgrades the Mar/Sep half-yearly
//     report anchors; where the two disagree at the same date the half-yearly
//     report wins (RBI revised some early Bulletin figures, e.g. Sep-2021
//     reads +49.61bn in the Nov-2021 Bulletin but the report — and later
//     Bulletins — use +49.11bn).
//
// (Pre-2021 press-carried figures like the Mar-21 anchor remain curated; the
// updaters never delete entries, and a slow/blocked RBI site fails open.)
//
// ── CADENCE ──────────────────────────────────────────────────────────────
// 2021-03 → today : MONTHLY month-end figures from the RBI Bulletin Table 4A
//                   (each issue states "As on <Month> <Year>" on the page,
//                   so periods are never assumed), with the Mar/Sep points
//                   cross-checked against the half-yearly FX reserves reports.
// 2026-07          : latest published (record −$136.77bn, Bulletin Jul-26).
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
  { date: "2021-04", net_fwd: 64.94, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on April 30, 2021 (official)" },
  { date: "2021-05", net_fwd: 59.85, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on May 31, 2021 (official)" },
  { date: "2021-06", net_fwd: 49.57, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on June 30, 2021 (official)" },
  { date: "2021-07", net_fwd: 49.01, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on July 31, 2021 (official)" },
  { date: "2021-08", net_fwd: 49.61, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on August 31, 2021 (official)" },
  { date: "2021-09", net_fwd:   49.11, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2021" },
  { date: "2021-10", net_fwd: 49.11, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on October 31, 2021 (official)" },
  { date: "2021-11", net_fwd: 49.11, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on November 30, 2021 (official)" },
  { date: "2021-12", net_fwd: 49.11, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on December 31, 2021 (official)" },
  { date: "2022-01", net_fwd: 49.88, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on January 31, 2022 (official)" },
  { date: "2022-02", net_fwd: 49.11, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on February 28, 2022 (official)" },
  { date: "2022-03", net_fwd:   65.79, source: "RBI Half-Yearly FX Reserves Report, Oct 2021–Mar 2022" },
  { date: "2022-04", net_fwd: 63.83, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on April 30, 2022 (official)" },
  { date: "2022-05", net_fwd: 49.19, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on May 31, 2022 (official)" },
  { date: "2022-06", net_fwd: 30.86, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on June 30, 2022 (official)" },
  { date: "2022-07", net_fwd: 22.02, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on July 31, 2022 (official)" },
  { date: "2022-08", net_fwd: 20.16, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on August 31, 2022 (official)" },
  { date: "2022-09", net_fwd:   28.40, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2022" },
  { date: "2022-10", net_fwd: 0.24, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on October 31, 2022 (official)" },
  { date: "2022-11", net_fwd: 8.49, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on November 30, 2022 (official)" },
  { date: "2022-12", net_fwd: 10.97, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on December 31, 2022 (official)" },
  { date: "2023-01", net_fwd: 21.73, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on January 31, 2023 (official)" },
  { date: "2023-02", net_fwd: 20.47, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on February 28, 2023 (official)" },
  { date: "2023-03", net_fwd:   23.60, source: "RBI Half-Yearly FX Reserves Report, Oct 2022–Mar 2023" },
  { date: "2023-04", net_fwd: 19.93, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on April 30, 2023 (official)" },
  { date: "2023-05", net_fwd: 19.27, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on May 31, 2023 (official)" },
  { date: "2023-06", net_fwd: 19.47, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on June 30, 2023 (official)" },
  { date: "2023-07", net_fwd: 19.47, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on July 31, 2023 (official)" },
  { date: "2023-08", net_fwd: 10.07, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on August 31, 2023 (official)" },
  { date: "2023-09", net_fwd:    4.64, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2023" },
  { date: "2023-10", net_fwd: -14.61, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on October 31, 2023 (official)" },
  { date: "2023-11", net_fwd: -11.90, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on November 30, 2023 (official)" },
  { date: "2023-12", net_fwd: 2.18, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on December 31, 2023 (official)" },
  { date: "2024-01", net_fwd: 9.97, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on January 31, 2024 (official)" },
  { date: "2024-02", net_fwd: 9.69, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on February 29, 2024 (official)" },
  { date: "2024-03", net_fwd:   -0.54, source: "RBI Half-Yearly FX Reserves Report, Oct 2023–Mar 2024 (net payable ≈ nil — book at the flip)" },
  { date: "2024-04", net_fwd: -16.26, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on April 30, 2024 (official)" },
  { date: "2024-05", net_fwd: -10.36, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on May 31, 2024 (official)" },
  { date: "2024-06", net_fwd: -15.84, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on June 30, 2024 (official)" },
  { date: "2024-07", net_fwd: -9.10, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on July 31, 2024 (official)" },
  { date: "2024-08", net_fwd: -18.98, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on August 31, 2024 (official)" },
  { date: "2024-09", net_fwd:  -14.58, source: "RBI Half-Yearly FX Reserves Report, Apr–Sep 2024 (net payable — short era begins)" },
  { date: "2024-10", net_fwd: -49.18, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on October 31, 2024 (official)" },
  { date: "2024-11", net_fwd: -58.85, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on November 30, 2024 (official)" },
  { date: "2024-12", net_fwd: -67.94, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on December 31, 2024 (official)" },
  { date: "2025-01", net_fwd: -77.53, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on January 31, 2025 (official)" },
  { date: "2025-02", net_fwd:  -88.75, source: "RBI Bulletin via Fortune India, Jun 2025 (peak since 2007)" },
  { date: "2025-03", net_fwd:  -84.345, source: "RBI Half-Yearly FX Reserves Report, Oct 2024–Mar 2025 (exact)" },
  { date: "2025-04", net_fwd:  -72.58, source: "RBI Bulletin (Jun 2025) via Fortune India" },
  { date: "2025-05", net_fwd: -65.22, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on May 31, 2025 (official)" },
  { date: "2025-06", net_fwd: -60.39, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on June 30, 2025 (official)" },
  { date: "2025-07", net_fwd: -57.85, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on July 31, 2025 (official)" },
  { date: "2025-08", net_fwd:  -53.36, source: "RBI Bulletin via Informist/Reuters, Nov 2025" },
  { date: "2025-09", net_fwd:  -59.41, source: "RBI Bulletin via Reuters, Oct 2025 (first rise after six months of declines)" },
  { date: "2025-10", net_fwd:  -63.60, source: "RBI Bulletin via Business Standard, 23 Dec 2025" },
  { date: "2025-11", net_fwd:  -66.04, source: "RBI Bulletin via Business Standard, 31 Dec 2025 (7-month high)" },
  { date: "2025-12", net_fwd:  -62.35, source: "RBI Bulletin via Informist, 31 Jan 2026 ($3.69bn lower than Nov)" },
  { date: "2026-01", net_fwd: -67.77, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on January 31, 2026 (official)" },
  { date: "2026-02", net_fwd:  -77.67, source: "RBI Bulletin via Business Standard, May 2026" },
  { date: "2026-03", net_fwd: -103.06, source: "RBI Bulletin via Business Standard, May 2026" },
  { date: "2026-04", net_fwd: -95.30, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on April 30, 2026 (official)" },
  { date: "2026-05", net_fwd: -106.66, source: "RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on May 31, 2026 (official)" },
  { date: "2026-06", net_fwd: -103.33, source: "RBI Bulletin via Business Standard, Aug 2026" },
  { date: "2026-07", net_fwd: -136.77, source: "RBI Bulletin via Business Standard, 31 Aug 2026 (record)" }
];

exports.handler = async () => {
  const latest = FWD_SERIES[FWD_SERIES.length - 1];

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify({
      fetched_at: new Date().toISOString(),
      source: "RBI Bulletin Table 4A (monthly, auto-updated) — cross-checked to Half-Yearly FX Reserves Reports",
      status: "static fallback", // honest: curated figures, not a live scrape
      month: latest.date,
      net_fwd: latest.net_fwd,
      history: FWD_SERIES.map(p => ({
        date: p.date,
        net_fwd: p.net_fwd,
        ...(p.approx ? { approx: true } : {}),
        source: p.source,
      })),
      note: "RBI's net forward position, month-end, USD bn (signed): net assets while long, net liabilities while short. Month-end figures are added AUTOMATICALLY from the RBI Bulletin's Current Statistics table 4A (Maturity Breakdown of Outstanding Forwards) by scripts/update-fwd-monthly.js, which runs in the daily cron and on every deploy; Mar/Sep points are cross-checked to RBI's Half-Yearly FX Reserves Reports (scripts/update-fwd-series.js). RBI publishes no currency split, so there is no separate euro forward figure.",
    }),
  };
};
