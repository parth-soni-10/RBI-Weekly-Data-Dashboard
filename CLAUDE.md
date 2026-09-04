# RBI Weekly Dashboard - Project Instructions

## Overview
Static dashboard of India's RBI Weekly Statistical Supplement (forex reserves, gold, rupee spot, equity markets), live crude-oil import estimates, macro context tiles (FII flows, G-Sec yield, REER, FX intervention, tax), and a curated PM CARES Fund section. Served from Netlify: a single-file frontend in `public/` plus serverless scrapers.

## Tech Stack
- Language: JavaScript (Node >= 18), zero build step, vanilla HTML/CSS/JS frontend
- Frontend: `public/index.html` - all markup, CSS, and JS inline in one file
- Charts: Chart.js 4.4.1 (CDN, loaded with `defer`); fonts Inter + DM Mono (Google Fonts)
- Hosting: Netlify (static publish + Functions, esbuild bundler)
- Deps: `node-fetch` (^2.7), `node-xlsx` (^0.23) - both used by the scrapers
- Scheduling: GitHub Actions cron (`refresh-data.yml`, daily 00:30 UTC)

## Code Style
- File naming: kebab-case. `fetch-*.js` = scrapers used by the dashboard; `data-*.js` = public JSON APIs behind `public/_redirects`
- Scrapers never throw to the client: always return 200, degrade to curated fallbacks, and flag them with `status: static fallback` / `source` / `as_of_date` fields so the UI can say "fallback" honestly
- Scrapers try multiple upstream sources in order (e.g. several Yahoo tickers for G-Sec) and never fail hard
- Heavy scrapers memoize via `_utils/cache.js` `withCache(key, ttlMs, fn)` (in-memory, fail-open) and set `Cache-Control`; light ones set plain headers in a `CORS` object
- Shared HTTP helpers live in `_utils/http.js` (`get`, `extractHtmlTables`, `parseNum`, `UA`)
- Frontend: semantic class names over inline styles; `.section` blocks are the tab panes, `showSection()`/`sw()` drive tabs and permalink hash (`#tab=...&modes=...`); empty metric values render as `—` (deliberate convention)
- Data file uses ISO dates (`YYYY-MM-DD`); display uses `en-IN` formatting via `fmt()`

## Testing
- No test framework exists. Run `npm run check` (node --check on every server file) after touching any `.js`
- Frontend changes: verify by serving `public/` and loading the page - tables/charts render from `rbi-data.json`; macro + crude tiles need the Netlify functions (use `netlify dev` or accept graceful fallbacks locally)

## Build & Run
- Regenerate static data: `npm run fetch:data` (incremental - only fetches weeks newer than the newest record in `public/rbi-data.json`)
- Syntax check: `npm run check`
- Local dev: serve `public/` with any static server; live functions require `netlify dev`
- Deploy: Netlify (build command `npm run fetch:data` regenerates data on every deploy); the GitHub Action keeps `rbi-data.json` fresh between deploys

## Project Structure
```
public/                 → Static site (publish dir)
  index.html              → The entire frontend (markup + CSS + JS inline)
  rbi-data.json           → Committed RBI weekly records (regenerated + auto-committed)
  _redirects              → Clean /data/*.json URLs → Netlify functions
  embed/                  → Standalone chart embeds
netlify/functions/      → Serverless scrapers + APIs
  fetch-data.js           → RBI WSS scraper core (_getFridays, _processOne) - reused by others
  fetch-crude.js          → Heavy pipeline: PPAC + TankerMap AIS + Yahoo prices
  fetch-fii*.js, fetch-gsec.js, fetch-tax.js, fetch-reer.js, fetch-fx-intervention.js,
  fetch-em-peers.js → server-side Yahoo FX proxy for the EM-peers overlay (browsers
  can't hit Yahoo directly on arbitrary origins — CORS)
  data-latest.js, data-forex-weekly.js, data-crude-bpd.js → public JSON APIs
  _utils/                 → http.js (shared fetch/parse), cache.js (TTL memo)
scripts/fetch-all.js    → CLI that regenerates public/rbi-data.json
scripts/update-fwd-series.js → auto-appends/upgrades FWD_SERIES with the newest
  official figure from RBI's half-yearly FX reserves report (Mar/Sep; runs in
  the daily cron + deploy build)
scripts/update-fwd-monthly.js → auto-appends the newest MONTHLY Bulletin Table 4A
  forward figure (each issue states its "As on" date); --backfill walks every
  Bulletin issue 2021→now to fill/verify all month-ends (one-off)
.github/workflows/      → refresh-data.yml (daily cron commit)
netlify.toml            → Publish/functions config + per-function timeouts
```

## Conventions
- Git: work on `main`; commit messages are imperative one-liners (e.g. "Speed up load, add collapsible header + animated mobile nav"). No PR workflow - commits go straight to main
- Do not commit `public/rbi-data.json` manually unless it's the intentional baseline; the Action owns refreshes
- PM CARES data is curated (audited PDFs are scanned images, not scrapable) - it lives in the `PMCARES` array in `index.html`, not in the pipeline
- RBI's net forward position (`fetch-fx-intervention.js`) is AUTO-UPDATED, not hand-curated: month-end figures (Mar-21 → today, all 65 months) come from the RBI Bulletin's Current Statistics table 4A "Maturity Breakdown (by Residual Maturity) of Outstanding Forwards of RBI", a server-rendered BS_ViewBulletin page — `scripts/update-fwd-monthly.js` reads the newest issue on every deploy/daily cron and appends/upgrades `FWD_SERIES` (its `--backfill` flag walks every issue back to May-2021 to fill or verify gaps). `scripts/update-fwd-series.js` does the same for the Mar/Sep half-yearly FX reserves report anchors, which WIN over the Bulletin table at the same date (RBI revised some early figures — Sep-2021 is +49.61bn in the Nov-21 Bulletin but +49.11bn in the report and later Bulletins). Both fail open (slow/blocked RBI never breaks a deploy) and never delete entries. The macro tile, the reserve KPIs, and the `cFwd` chart read the series automatically — chart tabs: stepped weekly on the dashboard's own WSS Fridays, stepped weekly every Friday since 2021 (long-to-short flip + Oct-23 short dip), and every published figure as points
- Keep inline `style=""` out of new markup; add classes to the stylesheet instead

## Icons (Lucide)
- Icons come from a vendored copy of Lucide (`public/lucide.min.js`, pinned 0.462.0). Add `<i data-lucide="name"></i>` to markup; `lucide.createIcons()` runs at end of `<body>`.
- Icon lookup keys are PascalCase at runtime (`data-lucide="ship"` → `Ship`). Not every Lucide name exists in this pinned build — verify an icon name against `lucide.icons` before using it (e.g. `barrel` and `droplets` do NOT exist here; `ship`, `fuel`, `factory`, `hand-heart`, `table-2` do).
- The Reload button re-injects its icon after load: `btn.innerHTML = '<i data-lucide="rotate-cw"></i> Reload data'` then re-runs `lucide.createIcons()`.
- Size icons via the `.lucide` rules at the bottom of the inline `<style>` (in nav/status/btn/dl/tab). SVGs inherit `currentColor`.
