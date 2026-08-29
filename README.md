# RBI Weekly Dashboard

A simple dashboard that gathers the Reserve Bank of India's weekly updates — foreign exchange reserves, gold holdings, the value of the rupee, and how the stock market is doing — and puts them all in one easy-to-read place.

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
- **A PM CARES section** — a snapshot of the COVID-era relief fund from its audited accounts

## How it stays up to date

The data refreshes automatically. A small automated job checks for the latest RBI report each day and updates the dashboard on its own — no manual work needed.

## Run it locally

You'll need **Node.js** (version 18 or newer).

```
npm install
npm run fetch:data
```

Then open the `public` folder in any browser (or serve it with a local server). The dashboard reads the freshly generated data file.

## Built with

A hand-written **HTML / CSS / JavaScript** site hosted on **Netlify**, with a bit of **Node** automation behind the scenes that fetches the reports and tidies the numbers. No database, no accounts, no sign-up.

---

*Data for reference and personal use. Figures correspond to weekly RBI reporting dates.*