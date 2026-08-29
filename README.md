# RBI Weekly Dashboard

A live dashboard that scrapes the Reserve Bank of India's **Weekly Statistical Supplement (WSS)** and displays foreign exchange reserves, gold holdings, rupee spot rates, and equity market data — all in one place.

Built as a static site deployable on **Netlify**, with serverless functions handling all the data fetching.

---

## What it shows

| Data | Source | Unit |
|------|--------|------|
| Total forex reserves | RBI WSS Excel | USD million & ₹ crore |
| Gold holdings | RBI WSS Excel | USD million, ₹ crore, metric tonnes |
| Rupee spot rate | Yahoo Finance + RBI WSS Excel | INR per USD & INR per EUR |
| Nifty 50 close | Yahoo Finance | Index points (Friday) |
| Sensex close | Yahoo Finance | Index points (Friday) |

All data points correspond to **Friday closing / reporting dates**, starting from **January 1, 2026**.

---

## Project structure

```
rbi-dashboard/
├── netlify.toml                  # Build config — build command + publish dir + functions + timeouts
├── package.json                  # Node deps + npm scripts (fetch:data regenerates the data file)
├── README.md
├── scripts/
│   └── fetch-all.js              # Regenerates public/rbi-data.json from RBI + Yahoo
├── netlify/
│   └── functions/
│       ├── fetch-data.js         # RBI WSS scraper internals (shared with scripts/fetch-all.js)
│       ├── fetch-crude.js        # Crude imports (PPAC + TankerMap AIS + Yahoo)
│       ├── fetch-fii.js          # NSDL FPI daily flows
│       ├── fetch-fii-history.js  # 6-month FII + DII series (NSDL + CDSL)
│       ├── fetch-gsec.js         # 10Y G-Sec yield + repo rate history
│       ├── fetch-tax.js          # CBIC indirect tax receipts
│       ├── fetch-reer.js         # INR REER (36-country)
│       ├── fetch-fx-intervention.js  # RBI Forward Position of the Rupee
│       ├── data-latest.js        # Public JSON: latest week (/data/latest.json)
│       ├── data-forex-weekly.js  # Public JSON: last N weeks
│       ├── data-crude-bpd.js     # Public JSON: Brent/WTI/Urals snapshot
│       └── _utils/http.js        # Shared fetch + HTML-table helpers
└── public/
    ├── index.html                # Full dashboard — charts, metrics, tables, crude
    ├── rbi-data.json             # STATIC DATA FILE — all fetched RBI weekly records
    ├── _redirects                # /data/*.json → serverless functions
    └── embed/
        └── forex-reserves.html   # Embeddable forex-reserves widget
```

---

## How it works

### Data pipeline

All RBI weekly records live in **`public/rbi-data.json`** — a static, committed
data file regenerated on every deploy. The frontend just loads that file; there
is no per-week scraping in the browser and no client-side cache.

```
`npm run fetch:data`  (also run automatically by the Netlify build command)
        │
        ▼
scripts/fetch-all.js  — reuses the scraper internals from fetch-data.js
        │
        ├─→ RBI WSS page (HTML) — find Excel links
        │
        └─→ For each Friday (only NEWER weeks than the newest record already
            in the file), download in parallel:
                ├─ Foreign Exchange Reserves.xlsx → reserves + gold
                └─ Foreign Exchange Market.xlsx   → USD/INR, EUR/INR spot rates
            + Yahoo Finance (Nifty, Sensex, USD/INR, EUR/INR) in parallel
        │
        ▼
Merges + dedupes by date and writes public/rbi-data.json
        │
        ▼
Frontend GET /rbi-data.json → renders charts + metrics + tables + summary
```

### Updating the data

- **Automatically (GitHub Actions):** `.github/workflows/refresh-data.yml` runs
  `npm run fetch:data` on a **daily schedule** (00:30 UTC) and commits the
  refreshed `public/rbi-data.json` back to `main` if it changed. So the data
  updates itself every week — the latest Friday's RBI report is published Friday
  evening IST and is committed by Saturday morning. It can also be triggered
  manually via the "Run workflow" button in the Actions tab. (The action only
  commits when there is actual new data, so it won't churn empty commits.)
- **On Netlify:** the build command (`npm run fetch:data`) regenerates
  `rbi-data.json` on every deploy, so the deployed site also always ships with
  the latest reports — even ahead of a scheduled commit.
- **Locally:** run `npm run fetch:data` to refresh the file, then commit it
  (or serve `public/` directly).
- The script is incremental — each run only fetches weeks newer than the
  newest record already in the file, so repeat runs are fast and polite to RBI.
- It also **auto-extends across calendar years**: the Friday list is anchored
  on the oldest record's year, so when the year rolls over the script keeps
  fetching the new year's weeks without edits — and any week published in late
  December that wasn't fetched until January is still picked up (no gap at the
  year boundary). The header tagline's year updates automatically too.

### Frontend

- Single `index.html` — no build step, no framework
- Three tabs: **Dashboard** (charts + metric cards + macro context), **10-Week Table**, and **Crude Oil Imports**
- All charts built with [Chart.js 4](https://www.chartjs.org/)
- Charts are tabbed: switch between USD/INR, gold series, both indices, EM peers, events, etc.
- Macro context row: FPI equity/debt, YTD FII/DII, 10Y G-Sec yield, CBIC tax, REER, RBI Forward Position (loaded async from the macro functions)
- 10-week table shows every column with week-on-week Δ and direct links to each Friday's RBI report page
- Crude Oil Imports tab: live BPD estimates, prices, port arrivals, tankers (fetch-crude)
- Footer link to the latest fetched Friday auto-updates after each fetch
- Embeddable forex-reserves widget at `public/embed/forex-reserves.html`

---

## Deploy to Netlify

### Option A — drag & drop (easiest)

1. Zip the entire `rbi-dashboard/` folder
2. Go to [netlify.com](https://netlify.com) → **Add new site → Deploy manually**
3. Drag the zip onto the upload area
4. Done — Netlify detects `netlify.toml` automatically

### Option B — Netlify CLI

```bash
npm install -g netlify-cli
cd rbi-dashboard
netlify login
netlify deploy --prod
```

### Option C — GitHub

1. Push `rbi-dashboard/` to a GitHub repo
2. In Netlify: **Add new site → Import from Git**
3. Set **Publish directory** to `public`, **Functions directory** to `netlify/functions`
4. Deploy

### ⚠️ Function timeout

The scraper can need ~30+ seconds for a full year of Fridays. Timeouts are pre-configured in `netlify.toml` (26s for `fetch-data` / `fetch-crude` / `fetch-fii-history`, 20s for the other macro scrapers). If you remove that config, Netlify's default 10s limit will time the long runs out.

---

## Run locally

The function can be tested locally with the Netlify CLI dev server, which emulates the serverless environment:

```bash
# Install deps
cd rbi-dashboard
npm install

# Start local dev server
npx netlify dev
```

Then open `http://localhost:8888` — the function runs at `/.netlify/functions/fetch-data`.

**Requirements:** Node.js 18+

---

## Dependencies

### Serverless function (`package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `node-fetch` | ^2.7.0 | HTTP requests (CommonJS compatible) |
| `node-xlsx` | ^0.23.0 | Parse `.xlsx` Excel files without writing to disk |

### Frontend (`index.html`)

| Library | How loaded | Purpose |
|---------|-----------|---------|
| Chart.js 4.4.1 | CDN (cdnjs) | Bar + line charts |
| Inter / DM Mono | Google Fonts | Typography |

No build tooling, no bundler, no npm for the frontend.

---

## Data sources

| Source | URL |
|--------|-----|
| RBI WSS — latest Friday | `https://www.rbi.org.in/Scripts/WSSViewDetail.aspx?TYPE=Basic&PARAM1=M/D/YYYY` |
| RBI WSS — full index | `https://www.rbi.org.in/Scripts/BS_ViewWss.aspx` |
| RBI WSS — Basic series | `https://www.rbi.org.in/Scripts/WSSView.aspx?TYPE=Basic` |
| Yahoo Finance — Nifty 50 | `https://finance.yahoo.com/quote/%5ENSEI/` |
| Yahoo Finance — Sensex | `https://finance.yahoo.com/quote/%5EBSESN/` |

No API keys are required. The Yahoo Finance chart API endpoint used (`/v8/finance/chart/`) is publicly accessible.

---

## Notes & caveats

- **RBI page availability** — not every Friday has a published WSS report. Missing weeks are skipped with a log entry.
- **Spot rate table** — RBI labels this table differently across years ("Foreign Exchange Market", "Exchange Rate", "Spot Rate"). The scraper tries all three keywords.
- **Gold tonnes** — parsed from either a dedicated "metric tonnes" row or as the third numeric value in the gold row, whichever is found first.
- **Nifty/Sensex date alignment** — Yahoo returns weekly bars whose timestamps don't always land exactly on Friday. The scraper snaps each timestamp to the nearest Friday before building the date→value map.
- **Data lives in `public/rbi-data.json`** — regenerated on every deploy (Netlify build command) or via `npm run fetch:data` locally. The dashboard reads this static file on load; the "↺ Reload data" button re-reads it. The public JSON endpoints (`/data/*.json`) are cache-enabled server-side (`Cache-Control` headers) so embeds don't burn a function invocation on every load.
