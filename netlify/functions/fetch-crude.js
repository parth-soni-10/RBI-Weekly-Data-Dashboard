const fetch = require("node-fetch");

// ─── CONFIG ───────────────────────────────────────────────────
const PPAC_BASE     = "https://ppac.gov.in";
const PPAC_PAGE     = PPAC_BASE + "/import-export";
const PPAC_AJAX     = PPAC_BASE + "/AjaxController/getImportExportsJson";
const TANKERMAP     = "https://tankermap.com";

const INDIA_PORTS = [
  { slug: "jamnagar-oil",      name: "Jamnagar / Sikka"    },
  { slug: "vadinar-oil",       name: "Vadinar"              },
  { slug: "mumbai-oil",        name: "Mumbai / JNPT"        },
  { slug: "paradip-oil",       name: "Paradip"              },
  { slug: "mangalore-oil",     name: "Mangalore / NMPT"     },
  { slug: "chennai-oil",       name: "Chennai / Ennore"     },
  { slug: "haldia-oil",        name: "Haldia / Kolkata"     },
  { slug: "kochi-oil",         name: "Kochi / Cochin"       },
  { slug: "visakhapatnam-oil", name: "Visakhapatnam"        },
  { slug: "kandla-oil",        name: "Kandla / Deendayal"   },
  { slug: "kakinada-oil",      name: "Kakinada"             },
  { slug: "tuticorin-oil",     name: "Tuticorin / VOC Port" },
];

const VESSEL_CLASSES = [
  ["VLCC",      200000, Infinity],
  ["Suezmax",   120000, 200000  ],
  ["Aframax",    80000, 120000  ],
  ["Panamax",    50000,  80000  ],
  ["Handymax",   35000,  50000  ],
  ["Handysize",  10000,  35000  ],
];

const INDIA_KEYWORDS = [
  "sikka","jamnagar","mumbai","bombay","paradip","vadinar",
  "mangalore","chennai","kandla","haldia","kochi","cochin",
  "visakhapatnam","vizag","tuticorin","india","jnip","kakinada",
  "mormugao","goa","ennore","kolkata","nhava sheva","deendayal",
  "nmpt","voc port","dahej","okha","hazira","mundra",
];

const MONTH_KEYS = [
  "april","may","june","july","august","september",
  "october","november","december","january","february","march",
];
const MONTH_DISPLAY = {
  april:"APRIL",may:"MAY",june:"JUNE",july:"JULY",
  august:"AUGUST",september:"SEPTEMBER",october:"OCTOBER",
  november:"NOVEMBER",december:"DECEMBER",january:"JANUARY",
  february:"FEBRUARY",march:"MARCH",
};
const FISCAL_YEARS = ["2025-2026","2024-2025","2023-2024"];

// ─── HTTP ─────────────────────────────────────────────────────
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

async function get(url, timeout = 10000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml,*/*" },
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

async function post(url, data, extraHeaders = {}, timeout = 12000) {
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), timeout);
  const body = new URLSearchParams(data).toString();
  try {
    const res = await fetch(url, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
        "Accept": "application/json, text/javascript, */*; q=0.01",
        "Referer": PPAC_PAGE,
        ...extraHeaders,
      },
      body,
    });
    clearTimeout(tid);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } catch (e) {
    clearTimeout(tid);
    throw e;
  }
}

// ─── PPAC PHP var_dump PARSER ────────────────────────────────
function parsePpacVarDump(text) {
  const result = {};
  const trRe   = /\["(\w+)"\]=>\s*array\(\d+\)\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = trRe.exec(text)) !== null) {
    const key   = m[1];
    const block = m[2];
    const rec   = {};
    const fpRe  = /\["(\w+)"\]=>\s*string\(\d+\)\s*"([^"]*)"/g;
    let fm;
    while ((fm = fpRe.exec(block)) !== null) {
      rec[fm.group ? fm.group(1) : fm[1]] = fm[2] !== undefined ? fm[2] : fm[2];
    }
    // re-run properly
    const fRe2 = /\["(\w+)"\]=>\s*string\(\d+\)\s*"([^"]*)"/g;
    let fm2;
    while ((fm2 = fRe2.exec(block)) !== null) {
      rec[fm2[1]] = fm2[2];
    }
    if (Object.keys(rec).length) result[key] = rec;
  }
  return Object.keys(result).length ? result : null;
}

// ─── PPAC FETCH ───────────────────────────────────────────────
async function fetchPpacFy(pageId, fy, rby) {
  try {
    const res  = await post(PPAC_AJAX, { financialYear: fy, reportBy: rby, pageId });
    const text = await res.text();
    const parsed = parsePpacVarDump(text);
    if (!parsed) return [];

    const unitMap = { "1":"Quantity (000 MT)", "2":"Value Rs Crore", "3":"Value USD Mn" };
    return Object.entries(parsed).map(([, rec]) => {
      const row = {
        source: "PPAC", fiscal_year: fy,
        category: rec.product_title || "Unknown",
        unit: unitMap[rby] || rby,
      };
      for (const mn of MONTH_KEYS) {
        const v = rec[mn];
        row[MONTH_DISPLAY[mn]] = v ? parseFloat(v) : null;
      }
      row.TOTAL = rec.total ? parseFloat(rec.total) : null;
      return row;
    });
  } catch (e) {
    return [];
  }
}

async function fetchAllPpac() {
  // get page_id first
  let pageId = "14";
  try {
    const res  = await get(PPAC_PAGE, 15000);
    const html = await res.text();
    const m    = html.match(/id="page_id"[^>]*value="(\d+)"/);
    if (m) pageId = m[1];
  } catch (_) {}

  const rows = [];
  // fetch all FY × report types in parallel batches
  // reportBy: 1=Quantity, 2=Value INR, 3=Value USD
  // Also try reportBy=4 or "country" for country-wise breakdown (PPAC sometimes has this)
  const tasks = [];
  for (const fy of FISCAL_YEARS) {
    for (const rby of ["1", "2", "3"]) {
      tasks.push(fetchPpacFy(pageId, fy, rby));
    }
  }
  const results = await Promise.all(tasks);
  for (const r of results) rows.push(...r);
  return rows;
}

// ─── PPAC → MONTHLY BARRELS ───────────────────────────────────
function ppacToMonthlyBarrels(ppacData) {
  const BARRELS_PER_TONNE = 7.33;
  const monthly = {};

  const crudeQty = ppacData.filter(r =>
    r.unit === "Quantity (000 MT)" &&
    (r.category || "").toUpperCase().includes("CRUDE")
  );

  for (const rec of crudeQty) {
    const fyStart = parseInt((rec.fiscal_year || "2025-2026").split("-")[0]);
    for (let mi = 0; mi < MONTH_KEYS.length; mi++) {
      const mn  = MONTH_KEYS[mi];
      const val = rec[MONTH_DISPLAY[mn]];
      if (!val || val <= 0) continue;

      let calMonth = mi + 4;  // April=4
      let calYear  = fyStart;
      if (calMonth > 12) { calMonth -= 12; calYear++; }

      const mk       = `${calYear}-${String(calMonth).padStart(2,"0")}`;
      const tonnes   = val * 1000;
      const barrels  = tonnes * BARRELS_PER_TONNE;
      const days     = daysInMonth(calYear, calMonth);
      monthly[mk] = {
        fiscal_year: rec.fiscal_year,
        month_name: MONTH_DISPLAY[mn],
        tonnes_k: val,
        barrels_total: Math.round(barrels),
        barrels_per_day: Math.round(barrels / days),
        days_in_month: days,
      };
    }
  }
  return monthly;
}

function daysInMonth(y, m) {
  return new Date(y, m, 0).getDate();
}

// ─── TANKERMAP ────────────────────────────────────────────────
// For each port, try multiple slug variants — TankerMap slug names are not
// always predictable (e.g. "kochi" not "kochi-oil", "ennore" not "chennai-oil")
const PORT_SLUG_VARIANTS = {
  "jamnagar-oil":      ["jamnagar-oil", "jamnagar", "sikka-oil", "sikka"],
  "vadinar-oil":       ["vadinar-oil", "vadinar"],
  "mumbai-oil":        ["mumbai-oil", "mumbai", "nhava-sheva", "jnpt"],
  "paradip-oil":       ["paradip-oil", "paradip", "paradeep-oil", "paradeep"],
  "mangalore-oil":     ["mangalore-oil", "mangalore", "nmpt", "new-mangalore"],
  "chennai-oil":       ["chennai-oil", "ennore", "ennore-port", "kamarajar", "chennai"],
  "haldia-oil":        ["haldia-oil", "haldia", "kolkata-oil", "kolkata"],
  "kochi-oil":         ["kochi-oil", "kochi", "cochin-oil", "cochin"],
  "visakhapatnam-oil": ["visakhapatnam-oil", "visakhapatnam", "vizag-oil", "vizag"],
  "kandla-oil":        ["kandla-oil", "kandla", "deendayal-oil", "deendayal"],
  "kakinada-oil":      ["kakinada-oil", "kakinada"],
  "tuticorin-oil":     ["tuticorin-oil", "tuticorin", "voc-port", "thoothukudi"],
};

async function tryPortSlug(slug) {
  const variants = PORT_SLUG_VARIANTS[slug] || [slug];
  for (const v of variants) {
    try {
      const res  = await get(`${TANKERMAP}/api/ports/${v}`, 8000);
      const data = await res.json();
      // Verify it returned something useful
      if (data && (data.arrivals || data.in_port || data.expected)) {
        return { data, resolvedSlug: v };
      }
    } catch (_) {}
  }
  return null;
}

async function fetchPortArrivals() {
  const results = await Promise.allSettled(
    INDIA_PORTS.map(async (port) => {
      const hit = await tryPortSlug(port.slug);
      if (!hit) return { port_info: port, arrivals: [], departures: [], in_port: [], expected: [] };
      return { ...hit.data, port_info: port, resolvedSlug: hit.resolvedSlug };
    })
  );

  const portSummaries = {};
  const arrivalsByDate = {};

  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    const pd    = r.value;
    const pinfo = pd.port_info || {};
    const slug  = pinfo.slug || "unknown";
    const name  = pinfo.name || "Unknown";

    const arrivals   = pd.arrivals   || [];
    const departures = pd.departures || [];
    const inPort     = pd.in_port    || [];
    const expected   = pd.expected   || [];

    const crudeArr   = arrivals.filter(a => a.vessel_type === "Crude Oil Tanker");
    const productArr = arrivals.filter(a => (a.vessel_type || "").includes("Product"));

    portSummaries[slug] = {
      name,
      total_arrivals:    arrivals.length,
      crude_arrivals:    crudeArr.length,
      product_arrivals:  productArr.length,
      departures:        departures.length,
      in_port:           inPort.length,
      expected:          expected.length,
      total_crude_dwt:   crudeArr.reduce((s, a) => s + (a.dwt || 0), 0),
      total_product_dwt: productArr.reduce((s, a) => s + (a.dwt || 0), 0),
    };

    for (const a of crudeArr) {
      const ot = a.observed_at || "";
      if (!ot) continue;
      const ds = ot.split("T")[0].split(" ")[0];
      if (!arrivalsByDate[ds]) arrivalsByDate[ds] = [];
      arrivalsByDate[ds].push({
        port:        name,
        vessel_name: a.vessel_name || "",
        imo:         a.vessel_imo  || "",
        dwt:         a.dwt || 0,
        vessel_class: classifyVessel(a.dwt || 0),
        barrels_est: Math.round((a.dwt || 0) * 0.9 * 7.33),
        observed_at: ot,
      });
    }
  }

  return { portSummaries, arrivalsByDate };
}

async function fetchLiveVessels() {
  try {
    const res  = await get(`${TANKERMAP}/api/vessels/live`, 15000);
    return await res.json();
  } catch (_) { return []; }
}

async function fetchMarketData() {
  const tickers  = ["brent", "wti", "urals"];
  const results  = await Promise.allSettled(
    tickers.map(async (t) => {
      const res  = await get(`${TANKERMAP}/api/market-data/${t}?period=3M`, 10000);
      const data = await res.json();
      return { ticker: t, bars: data.bars || [] };
    })
  );

  const out = {};
  for (const r of results) {
    if (r.status === "fulfilled") {
      out[r.value.ticker] = r.value.bars;
    }
  }
  return out;
}

// ─── ORIGIN FROM COORDINATES ─────────────────────────────────
// Infer vessel origin region from current lat/lon position.
// Crude export regions with bounding boxes [lat_min, lat_max, lon_min, lon_max]
const ORIGIN_REGIONS = [
  { name: "Persian Gulf",       box: [22,   30,  48,  60]  },
  { name: "Iraq / Basra",       box: [28,   31,  47,  49]  },
  { name: "Saudi Arabia",       box: [14,   32,  36,  56]  },
  { name: "UAE / Abu Dhabi",    box: [22,   27,  51,  56]  },
  { name: "Kuwait",             box: [28,   30,  47,  49]  },
  { name: "Iran",               box: [24,   38,  44,  64]  },
  { name: "Russia / Novorossiysk", box: [42, 48, 36,  40]  },
  { name: "Russia / Baltic",    box: [54,   60,  18,  30]  },
  { name: "West Africa",        box: [-10,  10,  -5,  15]  },
  { name: "Nigeria",            box: [3,     7,   3,   9]  },
  { name: "Angola",             box: [-18, -4,   8,  16]  },
  { name: "North Sea",          box: [51,   63,  -5,  10]  },
  { name: "US Gulf",            box: [24,   31, -98, -85]  },
  { name: "Venezuela",          box: [8,    13, -73, -60]  },
  { name: "East Africa",        box: [-15,  15,  40,  52]  },
  { name: "Red Sea",            box: [12,   30,  32,  45]  },
  { name: "Mediterranean",      box: [30,   46,  -6,  37]  },
];

function originFromLatLon(lat, lon) {
  if (lat == null || lon == null) return "";
  // Most specific regions first (smaller boxes)
  const ordered = [...ORIGIN_REGIONS].sort((a, b) => {
    const areaA = (a.box[1]-a.box[0]) * (a.box[3]-a.box[2]);
    const areaB = (b.box[1]-b.box[0]) * (b.box[3]-b.box[2]);
    return areaA - areaB;
  });
  for (const r of ordered) {
    const [latMin, latMax, lonMin, lonMax] = r.box;
    if (lat >= latMin && lat <= latMax && lon >= lonMin && lon <= lonMax) return r.name;
  }
  return "";
}

// ─── VESSEL HELPERS ───────────────────────────────────────────
function classifyVessel(dwt) {
  for (const [cls, lo, hi] of VESSEL_CLASSES) {
    if (dwt >= lo && dwt < hi) return cls;
  }
  return "Unknown";
}

function filterIndiaBound(vessels) {
  return vessels
    .filter(v => v.vessel_type === "Crude Oil Tanker")
    .filter(v => {
      const dest = String(v.destination || "").toLowerCase();
      return INDIA_KEYWORDS.some(kw => dest.includes(kw));
    })
    .map(v => {
      // Origin: try explicit fields first, then infer from coordinates
      const explicitOrigin = v.last_port || v.departure_port || v.origin
        || v.from_port || v.previous_port || v.port_from || "";
      const coordOrigin = explicitOrigin
        ? "" : originFromLatLon(v.lat || v.latitude, v.lon || v.longitude);
      return {
        name:         v.name         || "",
        imo:          v.imo          || "",
        mmsi:         v.mmsi         || "",
        dwt:          v.deadweight   || 0,
        vessel_class: classifyVessel(v.deadweight || 0),
        destination:  v.destination  || "",
        origin:       explicitOrigin || coordOrigin,
        speed_knots:  v.speed_knots  || 0,
        nav_status:   v.nav_status   || "",
        barrels_est:  Math.round((v.deadweight || 0) * 0.9 * 7.33),
      };
    });
}

// ─── DAILY ESTIMATES ─────────────────────────────────────────
function buildDailyEstimates(arrivalsByDate, marketData, monthlyBarrels) {
  const priceByDate = {};
  for (const [ticker, bars] of Object.entries(marketData)) {
    for (const bar of bars) {
      const ds = bar.time || "";
      if (ds) {
        if (!priceByDate[ds]) priceByDate[ds] = {};
        priceByDate[ds][ticker] = bar.close || 0;
      }
    }
  }

  const allDates = new Set([
    ...Object.keys(arrivalsByDate),
    ...Object.keys(priceByDate),
  ]);
  if (!allDates.size) return [];

  const sorted   = [...allDates].sort();
  const startD   = new Date(sorted[0]);
  // Always extend to today so the table includes the current date
  // even when tanker/price data hasn't caught up yet
  const today    = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const lastData = new Date(sorted[sorted.length - 1]);
  const endD     = lastData > today ? lastData : today;

  // monthly tanker DWT totals for reconciliation
  const monthDwt = {};
  for (const [ds, arrs] of Object.entries(arrivalsByDate)) {
    const mk = ds.slice(0, 7);
    monthDwt[mk] = (monthDwt[mk] || 0) + arrs.reduce((s, a) => s + a.dwt, 0);
  }

  const daily = [];
  const cur   = new Date(startD);
  while (cur <= endD) {
    const ds  = cur.toISOString().slice(0, 10);
    const mk  = ds.slice(0, 7);
    const arrs = arrivalsByDate[ds] || [];

    const tankerDwt     = arrs.reduce((s, a) => s + a.dwt, 0);
    const tankerBarrels = arrs.reduce((s, a) => s + a.barrels_est, 0);
    const ppac          = monthlyBarrels[mk] || {};
    const ppacBpd       = ppac.barrels_per_day || 0;

    const prices   = priceByDate[ds] || {};
    const brent    = prices.brent  || null;
    const wti      = prices.wti    || null;
    const urals    = prices.urals  || null;

    let reconciled, methodology, confidence;
    if (tankerDwt > 0 && ppacBpd > 0) {
      const mDwt  = monthDwt[mk] || 0;
      const share = mDwt > 0 ? tankerDwt / mDwt : 0;
      reconciled  = Math.round(
        (share * (ppac.barrels_total || 0) / (ppac.days_in_month || 30) + ppacBpd) / 2
      );
      methodology = "TANKER_RECONCILED";
      confidence  = "HIGH";
    } else if (ppacBpd > 0) {
      reconciled  = ppacBpd;
      methodology = "PPAC_AVERAGE";
      confidence  = "MEDIUM";
    } else if (tankerDwt > 0) {
      reconciled  = tankerBarrels;
      methodology = "TANKER_ONLY";
      confidence  = "LOW";
    } else {
      reconciled  = 0;
      methodology = "NO_DATA";
      confidence  = "NONE";
    }

    daily.push({
      date:                 ds,
      barrels_per_day:      reconciled,
      methodology,
      confidence,
      tanker_arrivals:      arrs.length,
      tanker_unique_vessels: new Set(arrs.map(a => a.imo).filter(Boolean)).size,
      tanker_total_dwt:     tankerDwt,
      tanker_barrels_est:   tankerBarrels,
      ppac_monthly_bpd:     ppacBpd || null,
      ppac_monthly_tonnes_k: ppac.tonnes_k || null,
      brent_price:          brent,
      wti_price:            wti,
      urals_price:          urals,
      urals_brent_spread:   (urals !== null && brent !== null)
                              ? Math.round((urals - brent) * 100) / 100 : null,
    });

    cur.setDate(cur.getDate() + 1);
  }

  return daily;
}

// ─── YAHOO FINANCE (Brent + WTI spot) ────────────────────────
async function fetchYahooPrice(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=15d`;
  try {
    const res    = await get(url, 8000);
    const json   = await res.json();
    const result = json?.chart?.result?.[0];
    const closes = result?.indicators?.quote?.[0]?.close || [];
    const timestamps = result?.timestamp || [];
    for (let i = closes.length - 1; i >= 0; i--) {
      if (closes[i] != null) {
        const price = +closes[i].toFixed(2);
        // Convert unix timestamp to YYYY-MM-DD
        const date = timestamps[i]
          ? new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
          : null;
        return { price, date };
      }
    }
    return { price: null, date: null };
  } catch (_) { return { price: null, date: null }; }
}

// ─── HANDLER ─────────────────────────────────────────────────
exports.handler = async (event) => {
  const CORS = {
    "Access-Control-Allow-Origin":  "*",
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const action = (event.queryStringParameters || {}).action || "all";

  try {
    if (action === "prices") {
      // Fast path: just live Brent + WTI from Yahoo
      const [brentRes, wtiRes] = await Promise.all([
        fetchYahooPrice("BZ=F"),
        fetchYahooPrice("CL=F"),
      ]);
      if (brentRes.price === null && wtiRes.price === null) {
        return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "Yahoo Finance unavailable" }) };
      }
      return {
        statusCode: 200, headers: CORS,
        body: JSON.stringify({
          brent: brentRes.price, brent_date: brentRes.date,
          wti:   wtiRes.price,   wti_date:   wtiRes.date,
          fetched_at: new Date().toISOString(),
        }),
      };
    }

    // action === "all"  → full crude data pipeline
    const [
      ppacData,
      { portSummaries, arrivalsByDate },
      liveVessels,
      marketData,
      brentRes,
      wtiRes,
    ] = await Promise.all([
      fetchAllPpac(),
      fetchPortArrivals(),
      fetchLiveVessels(),
      fetchMarketData(),
      fetchYahooPrice("BZ=F"),
      fetchYahooPrice("CL=F"),
    ]);

    const brentLive = brentRes.price;
    const brentDate = brentRes.date;
    const wtiLive   = wtiRes.price;
    const wtiDate   = wtiRes.date;

    const monthlyBarrels = ppacToMonthlyBarrels(ppacData);
    const indiaBound     = filterIndiaBound(liveVessels);
    const dailyEstimates = buildDailyEstimates(arrivalsByDate, marketData, monthlyBarrels);

    // quality metrics
    const total    = dailyEstimates.length;
    const tankerD  = dailyEstimates.filter(e => e.tanker_arrivals > 0).length;
    const ppacD    = dailyEstimates.filter(e => e.ppac_monthly_bpd).length;
    const reconD   = dailyEstimates.filter(e => e.methodology === "TANKER_RECONCILED").length;
    const complete = total ? (tankerD + ppacD) / (2 * total) : 0;
    const quality  = {
      total_days:        total,
      tanker_days:       tankerD,
      ppac_days:         ppacD,
      reconciled_days:   reconD,
      data_completeness: +complete.toFixed(2),
      confidence:        reconD > total * 0.5 ? "HIGH" : ppacD > total * 0.3 ? "MEDIUM" : "LOW",
      start_date:        dailyEstimates[0]?.date  || null,
      end_date:          dailyEstimates[total - 1]?.date || null,
    };

    const payload = {
      fetched_at:       new Date().toISOString(),
      live_prices:      { brent: brentLive, brent_date: brentDate, wti: wtiLive, wti_date: wtiDate },
      daily_estimates:  dailyEstimates,
      port_summaries:   portSummaries,
      india_bound_tankers: indiaBound,
      ppac_monthly_barrels: monthlyBarrels,
      ppac_raw:         ppacData,
      quality_metrics:  quality,
    };

    return {
      statusCode: 200, headers: CORS,
      body: JSON.stringify(payload),
    };

  } catch (err) {
    return {
      statusCode: 500, headers: CORS,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
