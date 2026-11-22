// scripts/make-week-pages.js - one dated page per published RBI week, plus the
// sitemap that lists them.
//
// WHY
//
// Every view on the dashboard is a fragment of `/` (`#tab=dashboard`,
// `#tab=compare`, ...), and a search engine treats everything after `#` as the
// same URL - so no single week can ever rank on its own, however good the data
// is. This writes `/forex-reserves/YYYY-MM-DD` for every record in
// `public/rbi-data.json`: a server-rendered page with that week's five figures,
// the week-on-week move and the release date, which is what a "India forex
// reserves this week" query asks for.
//
// The same script rebuilds `public/sitemap.xml`, so the home page's `<lastmod>`
// is the snapshot's own `data_updated_at` rather than a hand-typed date, and every
// week page is listed. The weekly refresh runs it right after
// `scripts/refresh-static.js`, so a new week adds one page and one sitemap entry
// with no manual edit.
//
// Pages are plain HTML with no inline style or script: `public/_headers` sends
// `style-src 'self'`, so the table and the layout are classes in `pages.css`.
const fs = require("fs");
const path = require("path");

const DEFAULT_SITE = "https://rbiweeklydashboard.pages.dev";
const WEEK_DIR = "public/forex-reserves";
const SITEMAP = "public/sitemap.xml";
const DATA = "public/rbi-data.json";
const WSS = "https://www.rbi.org.in/Scripts/BS_ViewWss.aspx";

// The five lines RBI's WSS publishes, in the order it publishes them.
const COMPONENTS = [
  { label: "Total reserves", usd: "total_usd", inr: "total_inr" },
  { label: "Foreign currency assets", usd: "fca_usd", inr: "fca_inr" },
  { label: "Gold", usd: "gold_usd", inr: "gold_inr", percent: true },
  { label: "SDRs", usd: "sdr_usd", inr: "sdr_inr" },
  { label: "Reserve position in the IMF", usd: "imf_reserve_usd", inr: "imf_reserve_inr" },
];

const site = (value) => String(value || DEFAULT_SITE).replace(/\/+$/, "");

const esc = (value) =>
  String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** 705342 → "705,342". US grouping: these pages quote US$ million, as RBI does. */
function num(value, decimals = 0) {
  if (value == null || !Number.isFinite(Number(value))) return "—";
  return Number(value).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function utc(iso) {
  const [year, month, day] = String(iso).split("-").map(Number);
  if (!year || !month || !day) throw new Error(`invalid week date: ${iso}`);
  return new Date(Date.UTC(year, month - 1, day));
}

/** "2026-11-13" → "13 November 2026" (UTC, so no local-time drift). */
const longDate = (iso) =>
  utc(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

/** "2026-11-13" → "13 Nov 2026", for the <title> a search result shows. */
const shortDate = (iso) =>
  utc(iso).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });

/** RBI publishes the WSS the Friday AFTER the week it describes. */
function publicationOf(iso) {
  const date = utc(iso);
  date.setUTCDate(date.getUTCDate() + 7);
  return date.toISOString().slice(0, 10);
}

const weekPath = (iso) => `${WEEK_DIR}/${iso}.html`;

/** The record closest to a year before `iso`, if the history reaches back that far. */
function yearAgo(records, iso) {
  const target = utc(iso).getTime() - 365 * 86400000;
  let best = null;
  for (const record of records) {
    const diff = Math.abs(utc(record.date).getTime() - target);
    if (diff <= 10 * 86400000 && (!best || diff < best.diff)) best = { record, diff };
  }
  return best ? best.record : null;
}

/** One component's sentence, with the move against the week before when known. */
function componentSentence(label, value, before, { percent = false } = {}) {
  if (value == null) return null;
  const delta = before == null ? null : Number(value) - Number(before);
  if (delta == null) return `${label} stood at US$${num(value)} million.`;
  if (delta === 0) return `${label} were unchanged at US$${num(value)} million.`;
  const pct = percent && before > 0 ? ` (${Math.abs((delta / before) * 100).toFixed(1)}%)` : "";
  return `${label} ${delta < 0 ? "fell" : "rose"} US$${num(Math.abs(delta))} million${pct} to US$${num(value)} million.`;
}

/**
 * The paragraph a dated page leads with - the same shape the plan asked for:
 * the total's move first, then each component, then the year-earlier comparison
 * when the committed history reaches back that far.
 */
function summaryFor(record, previous = null, yearEarlier = null) {
  const published = longDate(publicationOf(record.date));
  const asOn = longDate(record.date);
  const total = record.total_usd;
  const delta = total != null && previous && previous.total_usd != null ? Number(total) - Number(previous.total_usd) : null;
  const head =
    total == null
      ? `India's foreign-exchange reserves for the week ended ${asOn}, per RBI's Weekly Statistical Supplement released on ${published}.`
      : delta == null
        ? `India's foreign-exchange reserves stood at US$${num(total)} million in the week ended ${asOn}, according to RBI's Weekly Statistical Supplement released on ${published}.`
        : delta === 0
          ? `India's foreign-exchange reserves were unchanged at US$${num(total)} million in the week ended ${asOn}, according to RBI's Weekly Statistical Supplement released on ${published}.`
          : `India's foreign-exchange reserves ${delta < 0 ? "fell" : "rose"} by US$${num(Math.abs(delta))} million to US$${num(total)} million in the week ended ${asOn}, according to RBI's Weekly Statistical Supplement released on ${published}.`;

  const fca = componentSentence("Foreign currency assets", record.fca_usd, previous && previous.fca_usd);
  const gold = componentSentence("Gold", record.gold_usd, previous && previous.gold_usd, { percent: true });
  const sdr = componentSentence("SDRs", record.sdr_usd, previous && previous.sdr_usd);
  const imf = componentSentence("the reserve position in the IMF", record.imf_reserve_usd, previous && previous.imf_reserve_usd);
  // "SDRs fell ... , and the reserve position in the IMF fell ... ."
  const tail = sdr && imf ? `${sdr.replace(/\.$/, "")}, and ${imf}` : sdr || imf;

  let yoy = null;
  if (total != null && yearEarlier && yearEarlier.total_usd != null) {
    const change = Number(total) - Number(yearEarlier.total_usd);
    yoy =
      change === 0
        ? "Total reserves are unchanged from a year earlier."
        : `Compared with a year earlier, total reserves are ${change > 0 ? "up" : "down"} US$${num(Math.abs(change))} million.`;
  }

  return [head, fca, gold, tail, yoy].filter(Boolean).join(" ").trim();
}

/** The body of /forex-reserves/<date>: figures first, sources after. */
function buildWeekPage(record, previous = null, { siteUrl = DEFAULT_SITE, records = [] } = {}) {
  const base = site(siteUrl);
  const url = `${base}/forex-reserves/${record.date}`;
  const title = `India forex reserves, week ended ${shortDate(record.date)}: US$${num(
    record.total_usd == null ? null : record.total_usd / 1000,
    1
  )} billion | RBI Weekly Dashboard`;
  const summary = summaryFor(record, previous, yearAgo(records.length ? records : [record], record.date));
  const description = summary.split(/(?<=\.)\s/)[0] || summary;
  const published = publicationOf(record.date);

  const rows = COMPONENTS.map((component) => {
    const value = record[component.usd];
    const before = previous ? previous[component.usd] : null;
    const delta = value == null || before == null ? null : Number(value) - Number(before);
    const pct = delta == null || !before ? "—" : `${delta === 0 ? "" : delta < 0 ? "−" : "+"}${Math.abs((delta / before) * 100).toFixed(1)}%`;
    const change = delta == null ? "—" : `${delta === 0 ? "" : delta < 0 ? "−" : "+"}${num(Math.abs(delta))}`;
    return `          <tr>
            <th scope="row">${esc(component.label)}</th>
            <td>${num(record[component.inr])}</td>
            <td>${num(value)}</td>
            <td>${change}</td>
            <td>${pct}</td>
          </tr>`;
  }).join("\n");

  const facts = COMPONENTS.slice(0, 5)
    .map(
      (component) =>
        `        <li><span class="fact-label">${esc(component.label)}</span><span class="fact-value">US$ ${num(
          record[component.usd]
        )} mn</span></li>`
    )
    .join("\n");

  const sorted = (records.length ? records : [record]).filter((row) => row && row.date).sort((a, b) => a.date.localeCompare(b.date));
  const at = sorted.findIndex((row) => row.date === record.date);
  const before = at > 0 ? sorted[at - 1] : null;
  const after = at >= 0 && at < sorted.length - 1 ? sorted[at + 1] : null;
  const pager = [
    before ? `Previous week: <a href="/forex-reserves/${before.date}">week ended ${longDate(before.date)}</a>` : null,
    after ? `Next week: <a href="/forex-reserves/${after.date}">week ended ${longDate(after.date)}</a>` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  const schema = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: summary,
    datePublished: published,
    dateModified: published,
    inLanguage: "en-IN",
    author: { "@type": "Organization", name: "RBI Weekly Dashboard", url: `${base}/` },
    publisher: { "@type": "Organization", name: "RBI Weekly Dashboard", url: `${base}/` },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    about: { "@type": "Thing", name: "India's foreign-exchange reserves" },
    isBasedOn: WSS,
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
<meta property="og:type" content="article">
<meta property="og:site_name" content="RBI Weekly Dashboard">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${base}/og-image.png">
<meta property="og:image:alt" content="RBI Weekly Dashboard - India's forex reserves, gold and markets">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${base}/og-image.png">
<meta name="color-scheme" content="dark light">
<script type="application/ld+json">
${JSON.stringify(schema, null, 2)}
</script>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/png" sizes="192x192" href="/icons/icon-192.png">
<link rel="apple-touch-icon" href="/icons/icon-192.png">
<link rel="stylesheet" href="/styles.css">
<link rel="stylesheet" href="/pages.css">
<script src="/theme-init.js"></script>
</head>
<body>
<a class="skip-link" href="#main-content">Skip to content</a>

<header class="doc-header">
  <div class="doc-header-inner">
    <a class="doc-brand" href="/">
      <span class="logo-badge" aria-hidden="true">₹</span>
      <span class="doc-brand-text">
        <span class="doc-brand-name">RBI Weekly Dashboard</span>
        <span class="doc-brand-sub">Forex, Rupee, Gold, Markets</span>
      </span>
    </a>
    <nav class="doc-nav" aria-label="Site">
      <a href="/">Dashboard</a>
      <a href="/about">About</a>
      <a href="/contact">Contact</a>
      <a href="/privacy">Privacy</a>
    </nav>
  </div>
</header>

<main class="doc-wrap" id="main-content">
  <article class="doc-card">
    <p class="doc-eyebrow">Weekly · RBI WSS</p>
    <h1>India's foreign-exchange reserves, week ended ${longDate(record.date)}</h1>
    <p class="doc-lede">${esc(summary)}</p>

    <ul class="doc-facts">
${facts}
    </ul>

    <h2>The five reserve components</h2>
    <div class="doc-table-wrap">
      <table class="doc-table">
        <caption>Week ended ${longDate(record.date)}; ₹ crore at that week's reference rate. Changes are the difference between the two weeks' published levels; RBI computes its own change column on unrounded figures, so a component can differ by US$1 million.</caption>
        <thead>
          <tr>
            <th scope="col">Component</th>
            <th scope="col">₹ crore</th>
            <th scope="col">US$ million</th>
            <th scope="col">Week change (US$ mn)</th>
            <th scope="col">Week change (%)</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
      </table>
    </div>

    <h2>Where these figures come from</h2>
    <p>
      RBI's <a href="${WSS}" target="_blank" rel="noopener noreferrer">Weekly Statistical Supplement</a>
      for the week ended ${longDate(record.date)}, released on ${longDate(published)}. The WSS is dated a
      week after the week it describes: "as on ${longDate(record.date)}" is the observation date used here,
      and the release date is when RBI published it. Figures are transcribed, not revised - where RBI
      later revises a number, RBI's own publication is right.
    </p>
    <p>
      The same records are available as JSON at
      <a href="/data/forex-weekly.json">/data/forex-weekly.json</a>, and
      <a href="/">the dashboard</a> puts this week next to the rupee, the indexes and the macro series.
    </p>

    <p class="doc-note">
      <strong>Independent project.</strong> This page is a transcription of public RBI data, not an RBI
      publication or an endorsement by it. No redistribution licence is asserted.
    </p>

    ${pager ? `<p class="doc-pager">${pager}</p>` : ""}
    <a class="doc-back" href="/">Open the dashboard</a>
  </article>
</main>

<footer class="doc-footer">
  <div class="doc-footer-inner">
    <span>Independent project. Not an RBI publication.</span>
    <a href="/about">About</a>
    <a href="/contact">Contact</a>
    <a href="/privacy">Privacy</a>
    <a href="/llms.txt">Agent guide</a>
    <a href="/sitemap.xml">Sitemap</a>
  </div>
</footer>
</body>
</html>
`;
}

/** Every record → { "public/forex-reserves/<date>.html": html }. */
function buildWeekPages(records, { siteUrl = DEFAULT_SITE } = {}) {
  const sorted = (records || []).filter((record) => record && /^\d{4}-\d{2}-\d{2}$/.test(String(record.date))).sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) throw new Error("rbi-data.json has no dated records");
  const pages = new Map();
  sorted.forEach((record, index) => {
    pages.set(weekPath(record.date), buildWeekPage(record, index > 0 ? sorted[index - 1] : null, { siteUrl, records: sorted }));
  });
  return pages;
}

/**
 * public/sitemap.xml from the same records: the home page's <lastmod> is the
 * snapshot's own data update (never a guessed build date), and the document
 * pages carry none rather than one nobody can verify. Every dated week page is
 * listed, newest first.
 */
function buildSitemap({ records = [], dataUpdatedAt = null, siteUrl = DEFAULT_SITE } = {}) {
  const base = site(siteUrl);
  const weeks = (records || [])
    .filter((record) => record && /^\d{4}-\d{2}-\d{2}$/.test(String(record.date)))
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!weeks.length) throw new Error("rbi-data.json has no dated records");
  const updatedAt = dataUpdatedAt || null;

  const entries = [
    `  <url>\n    <loc>${base}/</loc>\n${updatedAt ? `    <lastmod>${esc(updatedAt)}</lastmod>\n` : ""}    <priority>1.0</priority>\n  </url>`,
    ...["/about", "/contact", "/privacy"].map(
      (page, index) =>
        `  <url>\n    <loc>${base}${page}</loc>\n    <priority>${["0.6", "0.6", "0.5"][index]}</priority>\n  </url>`
    ),
    ...weeks.map(
      (record) =>
        `  <url>\n    <loc>${base}/forex-reserves/${record.date}</loc>\n    <lastmod>${publicationOf(record.date)}</lastmod>\n    <priority>0.8</priority>\n  </url>`
    ),
  ];

  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- Generated by scripts/make-week-pages.js - do not hand-edit.
     The home page's lastmod is rbi-data.json's data_updated_at, so it moves
     with the data rather than with a typed date; each /forex-reserves/ date is
     one published RBI week, dated when RBI published it. The .md aliases are
     alternates of these URLs (Link headers and <link rel="alternate">), not
     separate destinations. -->
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries.join("\n")}
</urlset>
`;
}

if (require.main === module) {
  const root = path.join(__dirname, "..");
  const data = JSON.parse(fs.readFileSync(path.join(root, DATA), "utf8"));
  const siteUrl = process.env.RSS_SITE_URL || DEFAULT_SITE;
  const pages = buildWeekPages(data.records, { siteUrl });

  const dir = path.join(root, WEEK_DIR);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of fs.readdirSync(dir)) {
    // A record that disappeared must not leave an orphan page behind.
    if (name.endsWith(".html") && !pages.has(`${WEEK_DIR}/${name}`)) fs.unlinkSync(path.join(dir, name));
  }
  for (const [relative, html] of pages) fs.writeFileSync(path.join(root, relative), html);

  const sitemap = buildSitemap({ records: data.records, dataUpdatedAt: data.data_updated_at || data.fetched_at, siteUrl });
  fs.writeFileSync(path.join(root, SITEMAP), sitemap);

  const newest = data.records.filter((record) => record && record.date).sort((a, b) => a.date.localeCompare(b.date)).pop();
  console.log(`✓ wrote ${pages.size} week page(s) to ${WEEK_DIR} · sitemap (home lastmod ${data.data_updated_at || data.fetched_at}, newest ${newest.date})`);
}

module.exports = {
  buildWeekPage,
  buildWeekPages,
  buildSitemap,
  summaryFor,
  publicationOf,
  weekPath,
  WEEK_DIR,
  SITEMAP,
};
