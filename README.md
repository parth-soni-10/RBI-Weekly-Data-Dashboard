# RBI Weekly Dashboard

A live dashboard that scrapes the Reserve Bank of India's **Weekly Statistical Supplement (WSS)** and displays foreign exchange reserves, gold holdings, rupee spot rates, and equity market data — all in one place.

Built as a static site deployable on **Netlify**, with a serverless function handling all the data fetching.

---

## What it shows

| Data | Source | Unit |
|------|--------|------|
| Total forex reserves | RBI WSS Excel | USD million & ₹ crore |
| Gold holdings | RBI WSS Excel | USD million, ₹ crore, metric tonnes |
| Rupee spot rate | RBI WSS Excel | INR per USD & INR per EUR |
| Nifty 50 close | Yahoo Finance | Index points (Friday) |
| Sensex close | Yahoo Finance | Index points (Friday) |

All data points correspond to **Friday closing / reporting dates**, starting from **January 1, 2026**.

---

## Project structure

```
rbi-dashboard/
├── netlify.toml                  # Build config — publish dir + function dir
├── package.json                  # Node dependencies for the serverless function
├── README.md
├── netlify/
│   └── functions/
│       └── fetch-data.js         # Serverless scraper (runs on Netlify)
└── public/
    └── index.html                # Full dashboard — charts, metrics, 5-week table
```

---

## How it works

### Data pipeline

```
Browser clicks "Fetch data"
        │
        ▼
POST /.netlify/functions/fetch-data
        │
        ├─→ Yahoo Finance API (Nifty + Sensex, both in parallel)
        │
        └─→ For each Friday since Jan 1 2026 (batches of 4, concurrent):
                │
                ├─→ RBI WSS page (HTML) — find Excel links
                │
                └─→ Download both Excel files in parallel:
                        ├─ Foreign Exchange Reserves.xlsx → reserves + gold
                        └─ Foreign Exchange Market.xlsx   → USD/INR, EUR/INR spot rates
        │
        ▼
Returns JSON { records, logs, lastFridayUrl }
        │
        ▼
Frontend renders charts + metric cards + 5-week table
```

### Frontend

- Single `index.html` — no build step, no framework
- Two tabs: **Dashboard** (charts + metric cards) and **5-Week Table**
- All charts built with [Chart.js 4](https://www.chartjs.org/)
- Charts are tabbed: switch between USD/INR, gold series, both indices, etc.
- 5-week table shows every column with week-on-week Δ and direct links to each Friday's RBI report page
- Footer link to the latest fetched Friday auto-updates after each fetch

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

Netlify free tier has a **10-second default** function timeout. The scraper needs up to ~40 seconds for a full year of Fridays.

**Fix:** Netlify dashboard → Site settings → Functions → set timeout to **26 seconds** (max on free tier).

If 26s is still tight: the parallel batch size is set to 4 in `fetch-data.js` — you can increase it to 6–8, but be mindful of rate-limiting from RBI's server.

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
| DM Sans / DM Mono | Google Fonts | Typography |

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
- **Data is fetched fresh on every button click** — there is no caching between sessions. Results are held in browser memory only.
