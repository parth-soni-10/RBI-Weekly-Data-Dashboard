/* ---------------------------------------------------------------------------
 * RBI Weekly Dashboard — the agent-facing documents.
 *
 * `_router.js` serves these. Nothing here scrapes anything: the dashboard's own
 * `/data/*.json` endpoints stay the source of truth for numbers, and this module
 * is the stable description an agent can read before calling them. That matters
 * here more than on a marketing page, because the numbers change every Friday
 * and a description that repeats them would be wrong within a week.
 * ------------------------------------------------------------------------ */

export const SITE = "https://rbiweeklydashboard.pages.dev";
export const EMAIL = "soni.soni.parth@gmail.com";
export const REPO = "https://github.com/parth-soni-10/RBI-Weekly-Data-Dashboard";
export const PORTFOLIO = "https://parth-portfolio-wb.pages.dev/";

const lines = (...parts) => parts.join("\n").trim() + "\n";

export const HOME_MARKDOWN = lines(
  "# RBI Weekly Dashboard",
  "",
  "**RBI Weekly Dashboard** is a free, independent dashboard for India's weekly foreign-exchange",
  "reserves, gold, the rupee and the markets. It reads the Reserve Bank of India's Weekly",
  "Statistical Supplement (WSS), keeps each observation's reporting date separate from the time the",
  "file was generated, and puts the figure next to the market series and macro indicators that",
  "explain it.",
  "",
  `- **Live site:** ${SITE}/`,
  `- **Maintainer:** Parth Soni (${PORTFOLIO})`,
  `- **Contact:** ${EMAIL}`,
  `- **Source:** ${REPO}`,
  "- **Cost:** free, no account, no sign-up.",
  "- **Not an RBI publication.** No affiliation with or endorsement by the Reserve Bank of India.",
  "",
  "## When to use this",
  "",
  "Use this dashboard when the task is one of these:",
  "",
  "- **Look up India's latest weekly reserves.** Total reserves, foreign currency assets, gold,",
  "  SDRs and the IMF reserve position, as of the WSS Friday — with the USD figure and the rupee",
  "  equivalent shown side by side.",
  "- **Compare two reporting Fridays.** Pick two WSS dates and read every headline metric's",
  "  absolute and percentage move; the comparison is linkable.",
  "- **Read a history, not a single point.** Ten-week table, 26- and 52-week chart ranges, and a",
  "  CSV of the whole fetched history.",
  "- **Put the reserves next to markets.** USD/INR, EUR/INR, NIFTY 50 and BSE SENSEX for the same",
  "  week, each from its own dated source.",
  "- **Get the macro context.** FII/FPI flows (NSDL), the 10-year G-Sec yield, REER, RBI's net",
  "  forward book, monthly indirect-tax receipts, crude import values from PPAC, a World Bank",
  "  external-debt ranking and a market Fear & Greed composite.",
  "- **Machine reading.** Every series is exposed as JSON under `/data/*.json`, unauthenticated,",
  "  with CORS open — see \"How to call it\" below.",
  "",
  "Do **not** use it as an official RBI source, a live market feed, an investment recommendation or",
  "a redistribution channel. It is a personal, reference-use transcription of public data; no",
  "redistribution licence is asserted, and each provider's terms still apply.",
  "",
  "## How to call it",
  "",
  "The page is interactive, but the data is not behind it:",
  "",
  "- `GET /` with `Accept: text/markdown` returns this document. `Accept: text/html` returns the",
  "  dashboard, as does a browser's usual `text/html,application/xhtml+xml,*/*` header.",
  "- `/index.md`, `/about.md`, `/contact.md` and `/privacy.md` always return Markdown.",
  "- `/llms.txt` is the compact guide; `/sitemap.xml` lists the four published pages.",
  "- An unknown path requested as Markdown returns HTTP 404 with a Markdown body that links both.",
  "",
  "### The JSON endpoints",
  "",
  "All are `GET`, no key, `Access-Control-Allow-Origin: *`:",
  "",
  "- `GET /data/latest.json` — the newest weekly record only:",
  "  `{ fetched_at, snapshot_updated_at, source, status, record, iso }`.",
  "  `record.date` is the WSS Friday (ISO `YYYY-MM-DD`); `fetched_at` is when this response was",
  "  built, not when RBI published anything.",
  "- `GET /data/forex-weekly.json?weeks=8` — `{ fetched_at, snapshot_updated_at, source, weeks,",
  "  status, records[] }`, oldest first, capped at the deployment's `MAX_WEEKS` (8).",
  "- `GET /data/crude-bpd.json` — Brent, WTI and Urals spot prices in USD per barrel, each with its",
  "  own quote date; a failed price is `null` rather than an error.",
  "- `GET /data/fii.json`, `/data/fii-history.json` — NSDL FII/FPI flows (₹ crore).",
  "- `GET /data/fx-intervention.json` — RBI's net forward book, month-end series.",
  "- `GET /data/gsec.json` — the 10-year G-Sec yield and the repo path.",
  "- `GET /data/reer.json` — the 36-country REER, monthly, base FY2017 = 100.",
  "- `GET /data/tax.json` — monthly GST, customs and excise receipts (₹ crore).",
  "- `GET /data/sentiment.json` — a 0–100 market Fear & Greed composite with its components.",
  "- `GET /data/external-debt.json` — the World Bank quarterly external-debt ranking.",
  "",
  "The same handlers are reachable at `/.netlify/functions/<name>`; the `/data/*.json` paths are the",
  "public contract. `POST /.netlify/functions/data-sync` is the dashboard's own merge cache and is",
  "not a public API.",
  "",
  "### Units and field names",
  "",
  "- Reserve and component figures ending `_usd` are **USD million**; the same figure ending `_inr`",
  "  is **₹ crore**, converted at the week's reference rate.",
  "- `usd_inr` and `eur_inr` are rupees per unit; `nifty`, `sensex` are index points; `crude` is USD",
  "  per barrel; flows and receipts are ₹ crore; `gsec` yields are percent.",
  "- `date` / `iso` is always the **observation** date. `fetched_at`, `snapshot_updated_at` and",
  "  `data_modified` are **generation** timestamps (UTC). Never mix the two.",
  "- A `status` of `static fallback` (or `status: \"error\"` on a failed scrape) means the number is",
  "  curated or last-known, not fresh. Read the field, not just the value.",
  "",
  "### Share links",
  "",
  "A view is a fragment on the homepage: `#tab=<dashboard|table|compare|crude|pmcares>`,",
  "`modes=res:usd,gold:inr,...`, and `cmp=<from>><to>` for a two-week comparison. The app restores",
  "the tab, the unit toggles and the comparison from it.",
  "",
  "```bash",
  `curl -sS -H 'Accept: text/markdown' ${SITE}/`,
  `curl -sS ${SITE}/data/latest.json`,
  `curl -sS '${SITE}/data/forex-weekly.json?weeks=12'`,
  "```",
  "",
  "## What is on the page",
  "",
  "- **Dashboard** — the latest week's reserves, gold, rupee and index tiles, with each move against",
  "  the previous Friday, plus a decomposition of the reserve components.",
  "- **10-Week Table** — the recent weeks side by side, searchable, with a CSV download of the whole",
  "  history.",
  "- **Compare** — any two WSS Fridays, absolute and percent moves, linkable.",
  "- **Crude Oil Imports** — PPAC's import value and volume against the spot benchmarks.",
  "- **PM CARES Fund** — figures transcribed from the Fund's published audited Receipt and Payment",
  "  Accounts, clearly labelled as such.",
  "",
  "## How it stays current",
  "",
  "A GitHub Actions job runs on Friday at 22:00 UTC — after the week's WSS is published — and",
  "regenerates the committed `rbi-data.json`, the feed and the auxiliary series; the commit is what",
  "deploys. The dashboard's **Reload data** button additionally live-checks RBI for a week newer than",
  "the file and merges it in memory. A newer week therefore appears either when the schedule runs or",
  "when someone asks for it, and a failed scrape leaves the last good snapshot in place.",
  "",
  "## Limits to state when quoting it",
  "",
  "- Weekly, not intraday: reserves are one Friday's WSS, and market series are daily closes.",
  "- Some macro tiles fall back to curated values when an upstream page changes shape; the tile and",
  "  the JSON both say so.",
  "- External debt is quarterly and lags; the PM CARES section is a fixed historical account.",
  "- The rupee series is a reference/market series per date; RBI's own daily reference rate ended when",
  "  FBIL took over on 10 July 2018.",
  ""
);

export const ABOUT_MARKDOWN = lines(
  "# About RBI Weekly Dashboard",
  "",
  "RBI Weekly Dashboard puts the Reserve Bank of India's weekly numbers — foreign-exchange reserves,",
  "gold, the rupee, and the market indexes that move with them — onto one page, with the reporting",
  "date attached to every figure. RBI publishes the WSS as a page, an Excel file and a PDF; this",
  "site reads it into a table you can compare, chart and download.",
  "",
  "## Who runs it",
  "",
  "It is an independent personal project by **Parth Soni**. It is not published, endorsed or",
  "operated by the Reserve Bank of India, and nothing here should be read as an official figure.",
  `The source is public at ${REPO}.`,
  "",
  "## What the dashboard shows",
  "",
  "- **Weekly reserves** — total, foreign currency assets, gold, SDRs and the IMF reserve position,",
  "  in USD and in rupees, for each WSS Friday.",
  "- **Markets** — USD/INR, EUR/INR, NIFTY 50 and BSE SENSEX for the same week.",
  "- **History and comparison** — 10-, 26- and 52-week views, a searchable table, a two-date",
  "  comparison, and CSV downloads.",
  "- **Macro context** — FII/FPI flows, the 10-year G-Sec yield, REER, RBI's net forward book,",
  "  monthly indirect-tax receipts, crude import values, a World Bank external-debt ranking and a",
  "  market Fear & Greed composite.",
  "- **PM CARES** — the Fund's audited receipts and payments, transcribed with its own caveats.",
  "",
  "## Where the numbers come from",
  "",
  "- **Weekly reserves:** RBI Weekly Statistical Supplement, https://www.rbi.org.in/Scripts/BS_ViewWss.aspx",
  "- **Rupee and index closes:** FBIL reference rate, NSE and BSE historical index data.",
  "- **FII/FPI flows:** NSDL.",
  "- **Crude imports and prices:** PPAC import data, with spot benchmarks as market quotes.",
  "- **G-Sec, REER, forward book:** RBI (DBIE and the RBI Bulletin).",
  "- **Indirect taxes:** PIB/CBIC monthly releases.",
  "- **External debt:** World Bank quarterly data.",
  "- **PM CARES:** the Fund's published audited Receipt and Payment Accounts.",
  "",
  "Each source is linked from the section that uses it, and the JSON endpoints name their source in",
  "the payload.",
  "",
  "## What it is not",
  "",
  "It is not an official publication, a data vendor, an investment adviser or a real-time feed. It",
  "does not redistribute the underlying data under any licence it can grant; consult each provider's",
  "terms before reusing a figure. Where a source changes shape and a scrape fails, the dashboard",
  "keeps the last good value and labels it rather than presenting a guess as fresh data.",
  "",
  "## Corrections",
  "",
  `A figure that disagrees with the source, or a series that stopped updating, is worth reporting:`,
  `${EMAIL}. See [Contact](/contact) for the other routes.`,
  ""
);

export const CONTACT_MARKDOWN = lines(
  "# Contact RBI Weekly Dashboard",
  "",
  "This is a one-person project, and data corrections are the most useful thing you can send. The",
  "dashboard is only as good as its transcription of the sources it reads.",
  "",
  "## Email",
  "",
  `**${EMAIL}**`,
  "",
  "Use it for a wrong figure, a series that has stopped updating, a broken page, a privacy question,",
  "or a request to remove something. There is no support contract and no guaranteed response time;",
  "messages are read and acted on when they can be.",
  "",
  "## Source code and issue tracker",
  "",
  `The site is open source at ${REPO}. A scraper that broke, a mis-parsed table or a feature request`,
  "can be filed there as an issue, which keeps the discussion next to the code that would change.",
  "",
  "## What this site cannot do",
  "",
  "It cannot answer an RBI query, correct a figure at the source, or give investment, tax or legal",
  "advice. If a figure differs from RBI's own publication, RBI's publication is right — send the",
  "link and the row, and the transcription will be fixed.",
  "",
  "## Reporting a data problem well",
  "",
  "Include the metric, the WSS Friday (or the month/quarter for macro series), the value the",
  "dashboard shows and the value the source shows, plus the source link. That is enough to reproduce",
  "it without a round trip.",
  ""
);

export const PRIVACY_MARKDOWN = lines(
  "# Privacy",
  "",
  "Last updated: 21 October 2026.",
  "",
  "RBI Weekly Dashboard has no accounts, no advertising and no analytics or tracking scripts. This",
  "page lists the little data it does handle.",
  "",
  "## What stays in your browser",
  "",
  "Your theme choice, the active tab, the unit toggles, a comparison you picked, and the last data",
  "the site fetched are stored in your browser (`localStorage` and a service-worker cache) so the",
  "page opens where you left it and still renders the last week offline. None of it is sent to this",
  "site, and clearing site data removes it.",
  "",
  "## What the server keeps",
  "",
  "There is no account system and no form on this site that stores personal data. The only durable",
  "server-side state is a cache of the weekly data the dashboard itself fetched, held in a Cloudflare",
  "KV namespace so reloads do not re-scrape each week. It holds figures and timestamps, not visitors.",
  "",
  "## Requests to third parties",
  "",
  "Reserves and macro series are fetched by this site's own server-side functions, so your browser",
  "does not contact RBI, NSDL, NSE, BSE, PPAC, the World Bank or Yahoo Finance for them, and those",
  "providers do not receive your IP address from those requests. Following a link to a source takes",
  "you to that provider under its own policy. Fonts, scripts and styles load only from this domain.",
  "",
  "## Hosting and logs",
  "",
  "The site is hosted on Cloudflare Pages, which processes requests and keeps standard operational",
  "logs (IP address, user agent, requested URL, timestamp) as any web host does, for security and",
  "reliability. This project does not build profiles from them, combine them with anything else, or",
  "sell or share data.",
  "",
  "## Cookies",
  "",
  "This site sets no cookies. There is no consent banner because there is nothing to consent to.",
  "",
  "## Your rights",
  "",
  `Questions about this page can go to **${EMAIL}**. Under the GDPR you may ask for access,`,
  "correction or erasure of personal data, and you have the right to complain to the Irish Data",
  "Protection Commission (https://www.dataprotection.ie/). If this notice changes, the date at the",
  "top changes with it.",
  ""
);

export function notFoundMarkdown(pathname) {
  const path = pathname && pathname !== "/" ? String(pathname).replace(/`/g, "'") : "this address";
  return lines(
    "# Page not found",
    "",
    `Nothing is published at \`${path}\` on rbiweeklydashboard.pages.dev. The page may have moved,`,
    "or the link may be mistyped.",
    "",
    `Start from the [dashboard](${SITE}/). Every published page is listed in the`,
    `[sitemap](${SITE}/sitemap.xml), and [llms.txt](${SITE}/llms.txt) explains what the dashboard`,
    "shows, when to use it and which JSON endpoints answer for each series.",
    ""
  );
}

export const NOT_ACCEPTABLE_MARKDOWN = lines(
  "# Not acceptable",
  "",
  "This site publishes HTML and Markdown. The request's `Accept` header excludes both, so no",
  "representation can be returned.",
  "",
  `Ask for \`text/html\` or \`text/markdown\`. The Markdown home page is at ${SITE}/index.md, and`,
  `${SITE}/llms.txt describes the dashboard and its data endpoints.`,
  ""
);

/* ---------------------------------------------------------------------------
 * Content negotiation (RFC 9110 §12.5.1).
 *
 * Markdown is selected only when `text/markdown` is named explicitly and weighs
 * at least as much as `text/html`. Browsers send HTML plus a wildcard and keep
 * getting HTML; curl's default wildcard does too.
 * ------------------------------------------------------------------------ */

function parseAccept(header) {
  return header
    .split(",")
    .map((part) => {
      const [rawType, ...params] = part.trim().split(";");
      const [type, subtype] = rawType.trim().toLowerCase().split("/");
      if (!type || !subtype) return null;
      let q = 1;
      for (const param of params) {
        const [key, value] = param.trim().split("=");
        if (key && key.trim().toLowerCase() === "q") {
          const parsed = Number.parseFloat(value);
          q = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
        }
      }
      return { type, subtype, q };
    })
    .filter(Boolean);
}

function qualityFor(type, subtype, ranges) {
  let best = null;
  for (const range of ranges) {
    if (range.type !== "*" && range.type !== type) continue;
    if (range.subtype !== "*" && range.subtype !== subtype) continue;
    const specificity = range.type === "*" ? 0 : range.subtype === "*" ? 1 : 2;
    if (!best || specificity > best.specificity) best = { specificity, q: range.q };
  }
  return best ? best.q : 0;
}

/**
 * @param {string | null} header the request's Accept header
 * @returns {"markdown" | "html" | "not-acceptable"}
 */
export function negotiate(header) {
  if (!header || !header.trim()) return "html";
  const ranges = parseAccept(header);
  if (ranges.length === 0) return "html";

  const namedMarkdown = ranges.some(
    (range) => range.type === "text" && range.subtype === "markdown"
  );
  const markdown = qualityFor("text", "markdown", ranges);
  const html = qualityFor("text", "html", ranges);

  if (namedMarkdown && markdown > 0 && markdown >= html) return "markdown";
  if (html > 0) return "html";
  if (!namedMarkdown && markdown > 0) return "markdown";
  return "not-acceptable";
}

export const DOCUMENTS = new Map([
  ["/", { markdown: HOME_MARKDOWN, alternate: "/index.md", file: "/index.html" }],
  ["/about", { markdown: ABOUT_MARKDOWN, alternate: "/about.md", file: "/about.html" }],
  ["/contact", { markdown: CONTACT_MARKDOWN, alternate: "/contact.md", file: "/contact.html" }],
  ["/privacy", { markdown: PRIVACY_MARKDOWN, alternate: "/privacy.md", file: "/privacy.html" }],
]);

export const MARKDOWN_ALIASES = new Map([
  ["/index.md", HOME_MARKDOWN],
  ["/about.md", ABOUT_MARKDOWN],
  ["/contact.md", CONTACT_MARKDOWN],
  ["/privacy.md", PRIVACY_MARKDOWN],
]);

/** Clean URLs are canonical; the `.html` files stay as aliases that redirect. */
export const HTML_ALIASES = new Map([
  ["/index.html", "/"],
  ["/about.html", "/about"],
  ["/contact.html", "/contact"],
  ["/privacy.html", "/privacy"],
]);

/** Add Accept to a Vary header without dropping what is already there. */
export function mergeVary(headers) {
  const current = headers.get("Vary");
  if (!current) {
    headers.set("Vary", "Accept");
    return headers;
  }
  if (current.trim() === "*") return headers;
  const values = current.split(",").map((value) => value.trim().toLowerCase());
  if (!values.includes("accept")) headers.set("Vary", `${current}, Accept`);
  return headers;
}

export function markdownResponse(body, status = 200, method = "GET") {
  const headers = new Headers({
    "Content-Type": "text/markdown; charset=utf-8",
    Vary: "Accept",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
  return new Response(method === "HEAD" ? null : body, { status, headers });
}
