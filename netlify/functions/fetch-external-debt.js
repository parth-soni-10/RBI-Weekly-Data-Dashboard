// Netlify callable: The world's biggest borrower countries — cross-country
// ranking of total EXTERNAL DEBT STOCKS, with India highlighted, plus each
// economy's official FX reserves so the dashboard can show debt cover.
//
// ── SOURCE (authenticated/official) ──────────────────────────────────────
// World Bank API v2, Quarterly External Debt Statistics (QEDS) — the
// quarterly, mutually-agreed structured data submissions countries make to
// the World Bank under the IMF's Special Data Dissemination Standard (SDDS,
// source 22) and General Data Dissemination System (GDDS, source 23).
// Indicator: gross external debt position, all sectors, all maturities,
// all instruments, USD. The API is served from api.worldbank.org over HTTPS
// with no key; the numbers ARE the World Bank's published QEDS figures (same
// as databank.worldbank.org), not a third-party estimate.
//
// ── WHY QUARTERLY QEDS, NOT ANNUAL IDS ───────────────────────────────────
// The annual IDS series (DT.DOD.DECT.CD) excludes high-income countries and
// lags a year+. QEDS includes the SDDS subscribers — USA, UK, Japan, the
// euro-area economies, Singapore, HK… — and runs ~5 quarters fresher
// (latest: 2026Q1). The honest headline changes: the USA is the world's
// biggest external borrower (~$30T), the UK second (~$11T); CHINA (~$2.3T)
// leads only among the non-SDDS (annual-IDS) reporters, and INDIA ranks
// ~#23 (~$0.76T). Each row carries its own reference quarter because
// countries publish with different lags. `scope_note` says this verbatim.
//
// ── CADENCE / REFRESH ────────────────────────────────────────────────────
// QEDS vintages land monthly-ish per country (source lastupdated: 2026-08-07).
// The payload is memoized in-process for 6h; `?refresh=1` bypasses AND
// overwrites the memo, and the frontend uses it on every explicit Reload —
// plus scripts/fetch-debt-rankings.js regenerates public/external-debt.json
// on every deploy and daily cron run. So every run re-pulls the live API.
//
// CORS: open.
//
// ── RESERVES (for the debt-cover comparison) ───────────────────────────
// WDI total reserves incl. gold, current US$ (FI.RES.TOTL.CD) — annual, each
// economy's latest non-empty year (2025 as of this writing). Served per row
// as `reserves_bn`/`reserves_year` so the UI can compute debt ÷ reserves
// cover. Cross-country cover ratios compare debt quarter vs reserves year;
// for INDIA the dashboard overrides with its own fresher RBI weekly figure.
//
// ── INDIA MATURITY SPLIT (short vs long term) ───────────────────────────
// QEDS SDDS carries the all-sectors SHORT-TERM external-debt stock directly
// (DT.DOD.DSTC.CD.US); long-term = the total (DT.DOD.DECT.CD.AR.US) minus
// short-term — the same-source identity QEDS itself publishes. india.history
// therefore also carries total_bn / st_bn / lt_bn / st_share_pct (st_share
// omitted where a quarter lacks the short-term figure), which the UI renders
// as a stacked maturity-split chart.
//
// ── INDIA RANK HISTORY (past five years, quarter by quarter) ────────────
// The full QEDS panel (every reporter × quarter, date-range query) is pulled
// for both sources and merged per quarter (SDDS wins, GDDS fills). For each
// quarter with ≥30 reporters, india.rank_history records India's rank, the
// reporter count, India's stock, and the ±2 rank neighbours. NOTE: a rank
// counts economies REPORTING THAT QUARTER (~117-124 settled), while the
// current tile rank counts every reporter's latest vintage (135) — the
// newest quarter is always still filling in, so its rank runs slightly high.
//
// Output shape:
//   {
//     fetched_at, source, source_url, indicator, status, scope_note,
//     as_of_period, worldbank_lastupdated, ranked_count, sdds_count, gdds_count,
//     reserves_lastupdated, reserves_year, reserves_note,
//     top_borrowers: [ { rank, iso3, name, value_bn, period,
//                        reserves_bn, reserves_year } ],   // top 12
//     india: { rank, iso3, name, value_bn, period,
//              reserves_bn, reserves_year,
//              neighbours: [ {rank, iso3, name, value_bn, period} ],  // ±2 ranks
//              history: [ { date, value_bn, total_bn,
//                           st_bn?, lt_bn?, st_share_pct? } ] },   // quarterly
//              rank_history: [ { period, rank, reporters, value_bn,
//                                neighbours: [ {rank, iso3, value_bn} ] } ] },
//   }
// status "static fallback" → the API was unreachable and FALLBACK_* (curated,
// verified against the API) is served instead; never a hard failure.

const { get } = require("./_utils/http");

const CORS = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Cache-Control": "public, max-age=21600" };

const API_BASE = "https://api.worldbank.org/v2";
// Gross external debt position, all sectors/maturities/instruments, USD:
//   SDDS (source 22): DT.DOD.DECT.CD.AR.US — includes USA/UK/JPN/CHN/HKG/SGP…
//   GDDS (source 23): DT.DOD.DECT.CD.TL.US — smaller reporters, same concept
const IND_SDDS = "DT.DOD.DECT.CD.AR.US";
const IND_GDDS = "DT.DOD.DECT.CD.TL.US";
const URL_SDDS      = `${API_BASE}/country/all/indicator/${IND_SDDS}?format=json&source=22&per_page=400&mrnev=1`;
const URL_GDDS      = `${API_BASE}/country/all/indicator/${IND_GDDS}?format=json&source=23&per_page=400&mrnev=1`;
const URL_RESERVES  = `${API_BASE}/country/all/indicator/FI.RES.TOTL.CD?format=json&per_page=400&mrnev=1`;
const URL_COUNTRY   = `${API_BASE}/country?format=json&per_page=400`;
const URL_INDIA_HIST = `${API_BASE}/country/IND/indicator/${IND_SDDS}?format=json&source=22&per_page=30`;
const IND_ST   = "DT.DOD.DSTC.CD.US"; // all sectors, SHORT-TERM stock, USD (SDDS)
const URL_INDIA_ST = `${API_BASE}/country/IND/indicator/${IND_ST}?format=json&source=22&per_page=30`;

// Rank-history panel: five rolling years of every reporter × quarter.
const PANEL_MIN_REPORTERS = 30;
const PANEL_RANGE = `${new Date().getFullYear() - 5}Q1:${new Date().getFullYear()}Q4`;
const URL_SDDS_PANEL = `${API_BASE}/country/all/indicator/${IND_SDDS}?format=json&source=22&per_page=30000&date=${PANEL_RANGE}`;
const URL_GDDS_PANEL = `${API_BASE}/country/all/indicator/${IND_GDDS}?format=json&source=23&per_page=30000&date=${PANEL_RANGE}`;

const SCOPE_NOTE =
  "Gross external-debt stock ranking among economies reporting to the World Bank's " +
  "Quarterly External Debt Statistics (IMF SDDS/GDDS subscribers, incl. high-income " +
  "economies). Each economy's latest published quarter is used, so vintages differ " +
  "by up to a few quarters. The annual IDS series — which excludes high-income " +
  "reporters — tops out at China instead; QEDS shows the USA and UK far ahead.";

// Curated fallback, verified against api.worldbank.org on 2026-09-11
// (SDDS meta.lastupdated 2026-08-07). Served (clearly flagged) only when the
// live API call fails, so the tile never goes blank.
const FALLBACK_TOP12 = [
  { iso3: 'USA', name: 'United States',  value_bn: 30197.0, period: '2026Q1' }, // #1
  { iso3: 'GBR', name: 'United Kingdom', value_bn: 11182.9, period: '2026Q1' }, // #2
  { iso3: 'FRA', name: 'France',         value_bn: 9233.4,  period: '2026Q1' }, // #3
  { iso3: 'DEU', name: 'Germany',        value_bn: 8125.5,  period: '2026Q1' }, // #4
  { iso3: 'NLD', name: 'Netherlands',    value_bn: 4868.8,  period: '2026Q1' }, // #5
  { iso3: 'JPN', name: 'Japan',          value_bn: 4765.1,  period: '2026Q1' }, // #6
  { iso3: 'LUX', name: 'Luxembourg',     value_bn: 4048.4,  period: '2026Q1' }, // #7
  { iso3: 'IRL', name: 'Ireland',        value_bn: 3888.6,  period: '2026Q1' }, // #8
  { iso3: 'CAN', name: 'Canada',         value_bn: 3471.7,  period: '2026Q1' }, // #9
  { iso3: 'ESP', name: 'Spain',          value_bn: 3284.8,  period: '2026Q1' }, // #10
  { iso3: 'ITA', name: 'Italy',          value_bn: 3263.3,  period: '2026Q1' }, // #11
  { iso3: 'SGP', name: 'Singapore',      value_bn: 2580.7,  period: '2026Q1' }, // #12
];
// WDI reserves (FI.RES.TOTL.CD), latest year per economy — verified 2026-09-11.
const FALLBACK_RESERVES = {
  USA: { value_bn: 1385.4, year: '2025' }, GBR: { value_bn: 214.4,  year: '2025' },
  FRA: { value_bn: 428.2,  year: '2025' }, DEU: { value_bn: 572.2,  year: '2025' },
  NLD: { value_bn: 118.1,  year: '2025' }, JPN: { value_bn: 1371.4, year: '2025' },
  LUX: { value_bn: 3.1,    year: '2025' }, IRL: { value_bn: 13.7,   year: '2025' },
  CAN: { value_bn: 125.6,  year: '2025' }, ESP: { value_bn: 128.6,  year: '2025' },
  ITA: { value_bn: 434.0,  year: '2025' }, SGP: { value_bn: 432.1,  year: '2025' },
  CHE: { value_bn: 925.7,  year: '2025' }, CHN: { value_bn: 3748.7, year: '2025' },
  HKG: { value_bn: 426.4,  year: '2025' }, AUS: { value_bn: 78.4,   year: '2025' },
  BEL: { value_bn: 37.2,   year: '2025' }, SWE: { value_bn: 84.7,   year: '2025' },
  AUT: { value_bn: 33.5,   year: '2025' }, NOR: { value_bn: 85.9,   year: '2025' },
  BRA: { value_bn: 358.5,  year: '2025' }, KOR: { value_bn: 436.6,  year: '2025' },
  IND: { value_bn: 700.1,  year: '2025' }, GRC: { value_bn: 24.0,   year: '2025' },
  DNK: { value_bn: 127.8,  year: '2025' }, FIN: { value_bn: 21.8,   year: '2025' },
  MEX: { value_bn: 236.7,  year: '2025' }, POL: { value_bn: 208.6,  year: '2025' },
  PRT: { value_bn: 29.3,   year: '2025' }, TUR: { value_bn: 165.0,  year: '2025' },
};

// India's reconstructed rank per quarter, 2021Q1→2026Q1 (verified against the
// live panel 2026-09-11; reporters-per-quarter shrink in the newest quarter
// because late filers haven't reported yet). SDDS+GDDS merged, ≥30 reporters.
const FALLBACK_RANK_HISTORY = [
  { period: '2021Q1', rank: 26, reporters: 124, value_bn: 573.7 },
  { period: '2021Q2', rank: 27, reporters: 122, value_bn: 575.3 },
  { period: '2021Q3', rank: 27, reporters: 121, value_bn: 603.0 },
  { period: '2021Q4', rank: 24, reporters: 122, value_bn: 613.0 },
  { period: '2022Q1', rank: 25, reporters: 120, value_bn: 619.1 },
  { period: '2022Q2', rank: 24, reporters: 120, value_bn: 613.0 },
  { period: '2022Q3', rank: 24, reporters: 121, value_bn: 605.8 },
  { period: '2022Q4', rank: 24, reporters: 122, value_bn: 611.7 },
  { period: '2023Q1', rank: 24, reporters: 120, value_bn: 624.3 },
  { period: '2023Q2', rank: 24, reporters: 121, value_bn: 629.0 },
  { period: '2023Q3', rank: 24, reporters: 123, value_bn: 637.1 },
  { period: '2023Q4', rank: 24, reporters: 123, value_bn: 648.7 },
  { period: '2024Q1', rank: 24, reporters: 123, value_bn: 668.8 },
  { period: '2024Q2', rank: 22, reporters: 123, value_bn: 681.5 },
  { period: '2024Q3', rank: 22, reporters: 120, value_bn: 713.0 },
  { period: '2024Q4', rank: 21, reporters: 118, value_bn: 718.6 },
  { period: '2025Q1', rank: 22, reporters: 117, value_bn: 736.4 },
  { period: '2025Q2', rank: 22, reporters: 117, value_bn: 746.8 },
  { period: '2025Q3', rank: 22, reporters: 117, value_bn: 747.2 },
  { period: '2025Q4', rank: 23, reporters: 113, value_bn: 767.4 },
  { period: '2026Q1', rank: 22, reporters: 104, value_bn: 762.8 },
];

const FALLBACK_INDIA = { rank: 23, iso3: 'IND', name: 'India', value_bn: 762.8, period: '2026Q1' };
const FALLBACK_NEIGHBOURS = [
  { rank: 21, iso3: 'BRA', name: 'Brazil',      value_bn: 855.6, period: '2026Q1' },
  { rank: 22, iso3: 'KOR', name: 'Korea, Rep.', value_bn: 774.4, period: '2026Q1' },
  { rank: 23, iso3: 'IND', name: 'India',       value_bn: 762.8, period: '2026Q1' },
  { rank: 24, iso3: 'GRC', name: 'Greece',      value_bn: 687.2, period: '2026Q1' },
  { rank: 25, iso3: 'DNK', name: 'Denmark',     value_bn: 686.9, period: '2026Q1' },
];
const FALLBACK_INDIA_HISTORY = [
  { date: '2020Q4', value_bn: 563.8 }, { date: '2021Q1', value_bn: 573.7 },
  { date: '2021Q2', value_bn: 575.3 }, { date: '2021Q3', value_bn: 603.0 },
  { date: '2021Q4', value_bn: 613.0 }, { date: '2022Q1', value_bn: 619.1 },
  { date: '2022Q2', value_bn: 613.0 }, { date: '2022Q3', value_bn: 605.8 },
  { date: '2022Q4', value_bn: 611.7 }, { date: '2023Q1', value_bn: 624.3 },
  { date: '2023Q2', value_bn: 629.0 }, { date: '2023Q3', value_bn: 637.1 },
  { date: '2023Q4', value_bn: 648.7 }, { date: '2024Q1', value_bn: 668.8 },
  { date: '2024Q2', value_bn: 681.5 }, { date: '2024Q3', value_bn: 713.0 },
  { date: '2024Q4', value_bn: 718.6 }, { date: '2025Q1', value_bn: 736.4 },
  { date: '2025Q2', value_bn: 746.8 }, { date: '2025Q3', value_bn: 747.2 },
  { date: '2025Q4', value_bn: 767.4 }, { date: '2026Q1', value_bn: 762.8 },
];

// India's SHORT-TERM external-debt stock (QEDS SDDS DT.DOD.DSTC.CD.US),
// verified 2026-09-11. Long-term = total − short-term in the builder below.
const FALLBACK_INDIA_ST = [
  { date: '2020Q4', st_bn: 103.5 }, { date: '2021Q1', st_bn: 101.1 },
  { date: '2021Q2', st_bn: 102.5 }, { date: '2021Q3', st_bn: 104.8 },
  { date: '2021Q4', st_bn: 114.6 }, { date: '2022Q1', st_bn: 121.7 },
  { date: '2022Q2', st_bn: 125.9 }, { date: '2022Q3', st_bn: 126.9 },
  { date: '2022Q4', st_bn: 127.9 }, { date: '2023Q1', st_bn: 128.4 },
  { date: '2023Q2', st_bn: 123.6 }, { date: '2023Q3', st_bn: 129.3 },
  { date: '2023Q4', st_bn: 127.1 }, { date: '2024Q1', st_bn: 127.6 },
  { date: '2024Q2', st_bn: 132.0 }, { date: '2024Q3', st_bn: 134.9 },
  { date: '2024Q4', st_bn: 140.0 }, { date: '2025Q1', st_bn: 134.5 },
  { date: '2025Q2', st_bn: 134.6 }, { date: '2025Q3', st_bn: 138.0 },
  { date: '2025Q4', st_bn: 152.6 }, { date: '2026Q1', st_bn: 149.2 },
];

// Join a total history with the short-term series → maturity fields.
function withMaturity(history, stList) {
  const st = {};
  (stList || []).forEach(p => { st[p.date] = p.st_bn; });
  return (history || []).map(h => {
    const stBn = st[h.date];
    if (stBn == null) return { ...h, total_bn: h.value_bn };
    return {
      ...h,
      total_bn: h.value_bn,
      st_bn: stBn,
      lt_bn: +(h.value_bn - stBn).toFixed(1),
      st_share_pct: h.value_bn > 0 ? +((stBn / h.value_bn) * 100).toFixed(1) : null,
    };
  });
}

// Rebuild India's rank for every quarter of the merged SDDS+GDDS panel.
// Panel rows leave countryiso3code blank; the ISO3 sits in country.id.
function rankHistory(sddsPanel, gddsPanel, iso3s) {
  const perQuarter = {}; // quarter → { iso3 → value }
  const ingest = (rows, override) => {
    for (const r of rows) {
      const iso = r.countryiso3code || (r.country && r.country.id);
      if (!iso || r.value == null || !iso3s.has(iso)) continue;
      const m = (perQuarter[r.date] = perQuarter[r.date] || {});
      if (override || m[iso] == null) m[iso] = r.value;
    }
  };
  ingest(rowsOf(gddsPanel), false); // GDDS fills…
  ingest(rowsOf(sddsPanel), true);  // …SDDS wins
  return Object.keys(perQuarter)
    .filter(q => Object.keys(perQuarter[q]).length >= PANEL_MIN_REPORTERS)
    .sort()
    .map(q => {
      const m = perQuarter[q];
      const order = Object.keys(m).sort((a, b) => m[b] - m[a]);
      const indRank = order.indexOf("IND");
      if (indRank < 0) return null;
      const lo = Math.max(0, indRank - 2);
      return {
        period: q,
        rank: indRank + 1,
        reporters: order.length,
        value_bn: +(m.IND / 1e9).toFixed(1),
        neighbours: order.slice(lo, indRank + 3).map((iso, j) => ({
          rank: lo + j + 1,
          iso3: iso,
          value_bn: +(m[iso] / 1e9).toFixed(1),
        })),
      };
    })
    .filter(Boolean);
}

const TOP_N = 12;
const MEMO_TTL_MS = 6 * 60 * 60 * 1000; // QEDS refreshes monthly-ish; 6h is generous

// Small in-process memo (same idea as _utils/cache.js) — hand-rolled so that
// `?refresh=1` can OVERWRITE the cached entry, which withCache can't do.
let memo = { t: 0, value: null };

async function getJson(url) {
  const res = await get(url, { timeoutMs: 15000 });
  return res.json();
}

// World Bank responses are [meta, rows]; tolerate objects, nulls, missing fields.
function rowsOf(j) {
  const arr = Array.isArray(j) ? j[1] : j;
  return Array.isArray(arr) ? arr.filter(Boolean) : [];
}

// The /country list marks aggregates (LMY, EAP, EMU…) with region.id "NA".
// Using the live list keeps the filter future-proof instead of a hardcoded
// aggregate blacklist.
function realCountryIso3s(countryList) {
  return new Set(
    rowsOf(countryList)
      .filter(c => c && c.id && c.region && c.region.id !== "NA")
      .map(c => c.id)
  );
}

// Merge SDDS + GDDS most-recent-non-empty rows into one ranked list.
// SDDS wins when an economy reports in both (fresher quarterly coverage).
function rankAll(sdds, gdds, iso3s) {
  const best = new Map(); // iso3 → { value, date, name }
  const put = (rows, src) => {
    for (const r of rows) {
      const iso = r.countryiso3code;
      if (!iso || r.value == null || !iso3s.has(iso)) continue;
      const prev = best.get(iso);
      // mrnev already yields the latest non-empty per economy; keep whichever is newer.
      if (!prev || String(r.date).localeCompare(String(prev.date)) > 0) {
        best.set(iso, {
          value: r.value,
          date: String(r.date),
          name: (r.country && r.country.value) || iso,
          src,
        });
      }
    }
  };
  put(rowsOf(sdds), "SDDS");
  put(rowsOf(gdds), "GDDS");
  return [...best.entries()]
    .map(([iso3, v]) => ({ iso3, ...v }))
    .sort((a, b) => b.value - a.value);
}

async function buildPayload() {
  const [sdds, gdds, reserves, countries, indiaHist, indiaSt, sddsPanel, gddsPanel] = await Promise.all([
    getJson(URL_SDDS), getJson(URL_GDDS), getJson(URL_RESERVES), getJson(URL_COUNTRY),
    getJson(URL_INDIA_HIST), getJson(URL_INDIA_ST),
    getJson(URL_SDDS_PANEL), getJson(URL_GDDS_PANEL),
  ]);

  const iso3s = realCountryIso3s(countries);
  const ranked = rankAll(sdds, gdds, iso3s);
  if (!ranked.length) throw new Error("World Bank QEDS API returned no ranked rows");

  // Latest published reserves per economy (WDI FI.RES.TOTL.CD): iso3 → { bn, year }.
  const resByIso = {};
  let resYear = null;
  for (const r of rowsOf(reserves)) {
    if (r.value == null || !r.countryiso3code || !iso3s.has(r.countryiso3code)) continue;
    resByIso[r.countryiso3code] = { bn: +(r.value / 1e9).toFixed(1), year: String(r.date) };
    if (resYear == null || String(r.date) > resYear) resYear = String(r.date);
  }

  const decorate = (r, i) => {
    const res = resByIso[r.iso3] || null;
    return {
      rank: i + 1,
      iso3: r.iso3,
      name: r.name,
      value_bn: +(r.value / 1e9).toFixed(1),
      period: r.date,
      reserves_bn: res ? res.bn : null,
      reserves_year: res ? res.year : null,
    };
  };
  const withRank = ranked.map(decorate);

  // India: rank, the ±2 rank neighbours for context, and quarterly history.
  const indIdx = ranked.findIndex(r => r.iso3 === "IND");
  const neighbours = withRank.slice(Math.max(0, indIdx - 2), indIdx + 3);
  const india = indIdx >= 0 ? {
    ...withRank[indIdx],
    neighbours,
    history: withMaturity(
      rowsOf(indiaHist)
        .filter(r => r.value != null)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map(r => ({ date: String(r.date), value_bn: +(r.value / 1e9).toFixed(1) })),
      rowsOf(indiaSt)
        .filter(r => r.value != null)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)))
        .map(r => ({ date: String(r.date), st_bn: +(r.value / 1e9).toFixed(1) })),
    ),
    rank_history: rankHistory(sddsPanel, gddsPanel, iso3s),
  } : null;

  const meta = Array.isArray(sdds) ? sdds[0] : null;
  const resMeta = Array.isArray(reserves) ? reserves[0] : null;
  const sddsCount = new Set(rowsOf(sdds).filter(r => r.value != null).map(r => r.countryiso3code)).size;
  const gddsCount = new Set(rowsOf(gdds).filter(r => r.value != null).map(r => r.countryiso3code)).size;

  return {
    fetched_at: new Date().toISOString(),
    source: "World Bank Quarterly External Debt Statistics, SDDS+GDDS (gross external debt position, all sectors, USD) + WDI reserves (FI.RES.TOTL.CD)",
    source_url: `https://api.worldbank.org/v2/country/all/indicator/${IND_SDDS}?format=json&source=22&mrnev=1`,
    indicator: `${IND_SDDS} / ${IND_GDDS} + FI.RES.TOTL.CD`,
    status: "ok",
    scope_note: SCOPE_NOTE,
    as_of_period: withRank[0].period, // reference quarter of the #1 borrower
    worldbank_lastupdated: meta && meta.lastupdated ? meta.lastupdated : null,
    ranked_count: withRank.length,
    sdds_count: sddsCount,
    gdds_count: gddsCount,
    reserves_lastupdated: resMeta && resMeta.lastupdated ? resMeta.lastupdated : null,
    reserves_year: resYear,
    reserves_note: "Total reserves incl. gold (WDI, annual); India's tile uses the fresher RBI weekly figure when loaded.",
    top_borrowers: withRank.slice(0, TOP_N),
    india,
  };
}

function fallbackPayload(reason) {
  return {
    fetched_at: new Date().toISOString(),
    source: "World Bank Quarterly External Debt Statistics, SDDS+GDDS — curated fallback",
    source_url: `https://api.worldbank.org/v2/country/all/indicator/${IND_SDDS}?format=json&source=22&mrnev=1`,
    indicator: `${IND_SDDS} / ${IND_GDDS}`,
    status: "static fallback",
    error: reason + " — showing last-known curated figures",
    scope_note: SCOPE_NOTE,
    as_of_period: FALLBACK_TOP12[0].period,
    worldbank_lastupdated: "2026-08-07",
    ranked_count: 135,
    sdds_count: 129,
    gdds_count: 60,
    reserves_lastupdated: "2026-07-13",
    reserves_year: "2025",
    reserves_note: "Total reserves incl. gold (WDI, annual); India's tile uses the fresher RBI weekly figure when loaded.",
    top_borrowers: FALLBACK_TOP12.map((r, i) => {
      const res = FALLBACK_RESERVES[r.iso3] || {};
      return { rank: i + 1, ...r, reserves_bn: res.value_bn ?? null, reserves_year: res.year ?? null };
    }),
    india: {
      ...FALLBACK_INDIA,
      reserves_bn: FALLBACK_RESERVES.IND.value_bn,
      reserves_year: FALLBACK_RESERVES.IND.year,
      neighbours: FALLBACK_NEIGHBOURS.map(t => {
        const res = FALLBACK_RESERVES[t.iso3] || {};
        return { ...t, reserves_bn: res.value_bn ?? null, reserves_year: res.year ?? null };
      }),
      history: withMaturity(FALLBACK_INDIA_HISTORY, FALLBACK_INDIA_ST),
      rank_history: FALLBACK_RANK_HISTORY,
    },
  };
}

exports.handler = async (event) => {
  const force = /(^|&|\?)refresh=1/.test(event.rawQuery || "");
  let payload;
  try {
    if (force || !memo.value || Date.now() - memo.t >= MEMO_TTL_MS) {
      payload = await buildPayload();
      memo = { t: Date.now(), value: payload };
    } else {
      payload = memo.value;
    }
  } catch (e) {
    payload = fallbackPayload(e.message || "World Bank API unreachable");
  }

  return {
    statusCode: 200,
    headers: CORS,
    body: JSON.stringify(payload),
  };
};

// Internals shared with scripts/fetch-debt-rankings.js (single parsing truth),
// following the _getFridays/_processOne export precedent from fetch-data.js.
exports._buildPayload = buildPayload;
exports._fallbackPayload = fallbackPayload;
exports._withMaturity = withMaturity;
exports._SCOPE_NOTE = SCOPE_NOTE;
