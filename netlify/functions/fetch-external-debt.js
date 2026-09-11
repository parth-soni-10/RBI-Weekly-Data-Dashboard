// Netlify callable: The world's biggest borrower countries — cross-country
// ranking of total EXTERNAL DEBT STOCKS, with India highlighted.
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
// Output shape:
//   {
//     fetched_at, source, source_url, indicator, status, scope_note,
//     as_of_period, worldbank_lastupdated, ranked_count, sdds_count, gdds_count,
//     top_borrowers: [ { rank, iso3, name, value_bn, period } ],   // top 12
//     india: { rank, iso3, name, value_bn, period,
//              neighbours: [ {rank, iso3, name, value_bn, period} ],  // ±2 ranks
//              history: [ { date: "2020Q4", value_bn } ] },           // quarterly
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
const URL_COUNTRY   = `${API_BASE}/country?format=json&per_page=400`;
const URL_INDIA_HIST = `${API_BASE}/country/IND/indicator/${IND_SDDS}?format=json&source=22&per_page=30`;

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
  const [sdds, gdds, countries, indiaHist] = await Promise.all([
    getJson(URL_SDDS), getJson(URL_GDDS), getJson(URL_COUNTRY), getJson(URL_INDIA_HIST),
  ]);

  const iso3s = realCountryIso3s(countries);
  const ranked = rankAll(sdds, gdds, iso3s);
  if (!ranked.length) throw new Error("World Bank QEDS API returned no ranked rows");

  const decorate = (r, i) => ({
    rank: i + 1,
    iso3: r.iso3,
    name: r.name,
    value_bn: +(r.value / 1e9).toFixed(1),
    period: r.date,
  });
  const withRank = ranked.map(decorate);

  // India: rank, the ±2 rank neighbours for context, and quarterly history.
  const indIdx = ranked.findIndex(r => r.iso3 === "IND");
  const neighbours = withRank.slice(Math.max(0, indIdx - 2), indIdx + 3);
  const india = indIdx >= 0 ? {
    ...withRank[indIdx],
    neighbours,
    history: rowsOf(indiaHist)
      .filter(r => r.value != null)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map(r => ({ date: String(r.date), value_bn: +(r.value / 1e9).toFixed(1) })),
  } : null;

  const meta = Array.isArray(sdds) ? sdds[0] : null;
  const sddsCount = new Set(rowsOf(sdds).filter(r => r.value != null).map(r => r.countryiso3code)).size;
  const gddsCount = new Set(rowsOf(gdds).filter(r => r.value != null).map(r => r.countryiso3code)).size;

  return {
    fetched_at: new Date().toISOString(),
    source: "World Bank Quarterly External Debt Statistics, SDDS+GDDS (gross external debt position, all sectors, USD)",
    source_url: `https://api.worldbank.org/v2/country/all/indicator/${IND_SDDS}?format=json&source=22&mrnev=1`,
    indicator: `${IND_SDDS} / ${IND_GDDS}`,
    status: "ok",
    scope_note: SCOPE_NOTE,
    as_of_period: withRank[0].period, // reference quarter of the #1 borrower
    worldbank_lastupdated: meta && meta.lastupdated ? meta.lastupdated : null,
    ranked_count: withRank.length,
    sdds_count: sddsCount,
    gdds_count: gddsCount,
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
    top_borrowers: FALLBACK_TOP12.map((r, i) => ({ rank: i + 1, ...r })),
    india: {
      ...FALLBACK_INDIA,
      neighbours: FALLBACK_NEIGHBOURS,
      history: FALLBACK_INDIA_HISTORY,
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
exports._SCOPE_NOTE = SCOPE_NOTE;
