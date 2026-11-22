// tests/week-pages.test.js - the dated weekly pages and the sitemap.
//
// The dashboard's views are all #fragments of `/`, which a search engine treats
// as one URL, so these pages are the only thing that can rank for a specific
// week. These pins cover what the plan asked for and what a silent regression
// would cost: the exact title and summary wording, the week-on-week arithmetic,
// a canonical URL and JSON-LD an agent can parse, no inline style (the CSP
// drops it), and a sitemap whose home <lastmod> is the snapshot's real date.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildSitemap,
  buildWeekPage,
  buildWeekPages,
  publicationOf,
  weekPath,
} = require("../scripts/make-week-pages.js");

const ROOT = path.join(__dirname, "..");
const data = JSON.parse(fs.readFileSync(path.join(ROOT, "public", "rbi-data.json"), "utf8"));
const latest = data.records.at(-1);
const previous = data.records.at(-2);

test("the newest week's page leads with the words a weekly search asks for", () => {
  const html = buildWeekPage(latest, previous, { records: data.records });

  assert.equal(latest.date, "2026-11-13");
  assert.match(html, /<title>India forex reserves, week ended 13 Nov 2026: US\$705\.3 billion \| RBI Weekly Dashboard<\/title>/);
  assert.match(
    html,
    /India's foreign-exchange reserves fell by US\$14,205 million to US\$705,342 million in the week ended 13 November 2026, according to RBI's Weekly Statistical Supplement released on 20 November 2026\./
  );
  // Moves are differences of the two published levels, so they can be US$1mn off
  // RBI's own change column (computed on unrounded figures) - the gold move and
  // the total match it here.
  assert.match(html, /Foreign currency assets fell US\$7,898 million to US\$583,452 million\./);
  assert.match(html, /Gold fell US\$6,183 million \(5\.9%\) to US\$98,613 million\./);
  assert.match(
    html,
    /SDRs fell US\$93 million to US\$18,517 million, and the reserve position in the IMF fell US\$33 million to US\$4,758 million\./
  );
  assert.ok(html.includes("RBI computes its own change column on unrounded figures"), "the page says where the US$1 difference comes from");

  // Every figure is on the page as RBI publishes it, ₹ crore beside US$ million.
  for (const usd of ["705,342", "583,452", "98,613", "18,517", "4,758"]) {
    assert.ok(html.includes(usd), `missing US$ ${usd} million`);
  }
  for (const rupees of ["6,647,812", "5,499,031", "929,430", "174,527", "44,824"]) {
    assert.ok(html.includes(rupees), `missing ₹ ${rupees} crore`);
  }

  assert.ok(html.includes('<link rel="canonical" href="https://rbiweeklydashboard.pages.dev/forex-reserves/2026-11-13">'));
  assert.ok(html.includes('name="description"'));
  assert.ok(html.includes('property="og:image"'));
  assert.ok(html.includes('name="robots" content="index,follow'));

  const schema = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(schema["@type"], "Article");
  assert.equal(schema.datePublished, "2026-11-20", "RBI's release date, not the as-on date");
  assert.equal(schema.mainEntityOfPage["@id"], "https://rbiweeklydashboard.pages.dev/forex-reserves/2026-11-13");

  // `_headers` sends style-src 'self': an inline style attribute would be dropped.
  assert.doesNotMatch(html, /\sstyle="/);
});

test("the week page is dated by the WSS release, and the oldest week invents no move", () => {
  assert.equal(publicationOf("2026-11-13"), "2026-11-20");
  const oldest = buildWeekPage(data.records[0], null, { records: data.records });
  assert.match(oldest, /stood at US\$/);
  assert.doesNotMatch(oldest, /fell by US\$|rose by US\$/);
  assert.doesNotMatch(oldest, /fell US\$|rose US\$/, "no component is compared against a week that is not there");
  assert.doesNotMatch(oldest, /start of this series/, "the first week is not compared with itself");
});

test("the long-horizon sentence is a year-on-year figure only when the history has a year", () => {
  const newest = buildWeekPage(latest, previous, { records: data.records });
  assert.doesNotMatch(newest, /Compared with a year earlier/, "the committed history starts 2025-12-26");
  assert.match(
    newest,
    /Since 26 December 2025, the start of this series, total reserves are up US\$8,732 million\./,
    "with under a year of history the comparison says so instead of pretending"
  );

  const synthetic = [
    { date: "2025-11-14", total_usd: 692577 },
    { date: "2026-11-13", total_usd: 705342 },
  ];
  const html = buildWeekPage(synthetic[1], null, { records: synthetic });
  assert.match(html, /Compared with a year earlier, total reserves are up US\$12,765 million\./);
});

test("every record gets a page, and the pages link to their neighbours", () => {
  const pages = buildWeekPages(data.records);
  assert.equal(pages.size, data.records.length);
  assert.ok(pages.has(weekPath("2026-11-13")));
  assert.equal(weekPath("2026-11-13"), "public/forex-reserves/2026-11-13.html");

  const html = pages.get(weekPath("2026-11-13"));
  assert.ok(html.includes('href="/forex-reserves/2026-11-06"'), "previous week is linked");
  assert.ok(html.includes('href="/forex-reserves/2026-11-20"') === false, "not a future week");
});

test("the sitemap dates the home page from the snapshot and lists every week", () => {
  const sitemap = buildSitemap({ records: data.records, dataUpdatedAt: data.data_updated_at });
  assert.match(
    sitemap,
    new RegExp(`<loc>https://rbiweeklydashboard\\.pages\\.dev/</loc>\\s*<lastmod>${data.data_updated_at}</lastmod>`)
  );
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.equal(locations.length, 4 + data.records.length);
  assert.ok(locations.includes("https://rbiweeklydashboard.pages.dev/forex-reserves/2026-11-13"));
  assert.match(sitemap, /<lastmod>2026-11-20<\/lastmod>/, "the week page is dated when RBI published it");
});

test("the generated files on disk match what the builder produces", () => {
  const pages = buildWeekPages(data.records);
  for (const [relative, html] of pages) {
    assert.equal(fs.readFileSync(path.join(ROOT, relative), "utf8"), html, `${relative} is stale`);
  }
  const sitemap = buildSitemap({ records: data.records, dataUpdatedAt: data.data_updated_at });
  assert.equal(fs.readFileSync(path.join(ROOT, "public", "sitemap.xml"), "utf8"), sitemap, "sitemap.xml is stale");
});
