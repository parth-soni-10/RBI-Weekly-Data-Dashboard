# RBI Weekly Dashboard

A simple dashboard that gathers the Reserve Bank of India's weekly updates — foreign exchange reserves, gold holdings, the value of the rupee, and how the stock market is doing — and puts them all in one easy-to-read place.

## Watch it

A 30-second trailer — click the poster to play:

[![Play the RBI trailer](brag-output/brag.jpg)](brag-output/brag.mp4)

## Why it exists

Every week the RBI publishes a new report as a raw spreadsheet. This project keeps a **history** of those numbers, so instead of digging through old files you can see the story at a glance:

- Is gold going up or down?
- Is the rupee getting stronger or weaker?
- What did the stock market do last Friday?
- How do the latest figures compare with the week before?

## What you can see

- **Key numbers at a glance** — reserves, gold, rupee vs the dollar and euro, and the main market indexes
- **Weekly change** — whether each number moved up or down versus the previous week
- **Charts and tables** — trend lines for the last 10 weeks, plus a searchable history
- **Extra context** — crude-oil import estimates, investor (FII) flow, interest rates, and more
- **World's biggest borrowers** — a quarterly cross-country ranking of external-debt stocks from the World Bank's Quarterly External Debt Statistics (countries' official IMF SDDS/GDDS submissions), with India's rank highlighted — the USA borrows the most, India sits in the low-#20s — plus a debt-to-reserves cover comparison (India's tile uses the dashboard's own weekly RBI reserves), India's short- vs long-term maturity split, and India's borrower rank reconstructed quarter by quarter since 2021
- **A PM CARES section** — a snapshot of the COVID-era relief fund from its audited accounts
- **Installable & offline-friendly** — add it to your phone/home screen as an app; when the network is down, the last week it fetched still renders (charts, tiles and tables) from the on-device cache
- **Zoomable charts** — Ctrl + scroll to zoom, drag to pan, double-click to reset on every time-series chart; pinch on touch
- **Longer tables & full history** — switch the weekly tables between 10 / 26 / 52 weeks and download the whole fetched history as CSV
- **Compare any two weeks** — a dedicated tab where you pick two Fridays and every headline metric shows its absolute and percent move between them, with a shareable link and CSV download
- **New-week alerts** — when a live check finds a freshly published RBI week, a toast slides in and a small header badge appears; click either to jump straight to the updated numbers
- **Macro event annotations** — the ⚑ Events tab marks every RBI MPC and Fed decision as a labeled vertical rule on the rupee chart
- **Macro trends** — the RBI repo-rate path with the live 10Y yield, and the REER(36) real-exchange-rate series, as charts beside the tiles
- **Reserves composition over time** — a stacked view of FCA + gold + SDR + IMF (and the gold/SDR/IMF share of total) once WSS decomposition rows arrive in the data
- **Charts as images** — one click downloads any main chart as a PNG beside the existing Copy CSV buttons
- **Practical table tools** — sticky column headers on long tables and a from/to date filter over the 10/26/52-week views
- **Keyboard + language** — keys 1–5 switch tabs, and a हि/EN toggle swaps the navigation into Hindi (persisted)
- **Subscribe + safe** — an RSS feed of new weeks (`/feed.xml`, generated at build), vendored JavaScript with no CDN dependency, and CSP/security headers on every page
- **Little conveniences** — a share button (copies a one-line snapshot with the link where native sharing isn't available), a print/PDF view of the active tab, the latest reserves and USD/INR shown right in the browser-tab title, a 1-year level view for reserves, and a quiet auto-refresh every 30 minutes while the tab is open

## How it stays up to date

The data refreshes automatically. A small automated job checks for the latest RBI report each day — and re-pulls the World Bank borrower ranking — updating the dashboard on its own. The ranking is also refreshed from the live World Bank API on every deploy, and the in-page Reload button always bypasses caches.

## Run it locally

You'll need **Node.js** (version 18 or newer).

```
npm install
npm run fetch:data
```

Then open the `public` folder in any browser (or serve it with a local server). The dashboard reads the freshly generated data file.

Quick checks: `npm run check` verifies the syntax of every script in the repo.

## Built with

A hand-written **HTML / CSS / JavaScript** site hosted on **Netlify**, with a bit of **Node** automation behind the scenes that fetches the reports and tidies the numbers. No database, no accounts, no sign-up.

---

*Data for reference and personal use. Figures correspond to weekly RBI reporting dates.*