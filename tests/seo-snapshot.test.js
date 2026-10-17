const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { injectSnapshot, formatDate } = require("../scripts/inject-snapshot.js");

const root = path.join(__dirname, "..");
const template = fs.readFileSync(path.join(root, "public/index.html"), "utf8");
const data = JSON.parse(fs.readFileSync(path.join(root, "public/rbi-data.json"), "utf8"));

test("formatDate labels an ISO WSS observation date without local-time drift", () => {
  assert.equal(formatDate("2026-09-25"), "25 September 2026");
  assert.throws(() => formatDate("September 25, 2026"), /invalid snapshot date/);
});

test("static snapshot injection synchronizes latest RBI figures, temporal coverage and JSON-LD", () => {
  const html = injectSnapshot(template, JSON.stringify(data));
  const latest = data.records.at(-1);
  assert.match(html, new RegExp(`<time id="snapshot-observation">${formatDate(latest.date)}</time>`));
  assert.match(html, new RegExp(`<time id="snapshot-generated">.*? UTC</time>`));
  assert.match(html, new RegExp(`<div class="mc-val" id="m-res-usd">${latest.total_usd.toLocaleString("en-IN")}</div>`));
  assert.match(html, new RegExp(`<div class="mc-val" id="m-gold-usd">${latest.gold_usd.toLocaleString("en-IN")}</div>`));
  assert.match(html, new RegExp(`<div class="mc-val" id="m-usd-inr">${latest.usd_inr.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>`));
  assert.match(html, new RegExp(`<span id="snapshot-reserves">${latest.total_usd.toLocaleString("en-IN")}</span>`));
  assert.match(html, new RegExp(`<span id="snapshot-gold">${latest.gold_usd.toLocaleString("en-IN")}</span>`));
  assert.match(html, new RegExp(`<span id="snapshot-usdinr">${latest.usd_inr.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`));
  const match = html.match(/<script type="application\/ld\+json" id="seo-dataset-schema">([\s\S]*?)<\/script>/);
  assert.ok(match, "JSON-LD script remains parseable in the head");
  const schema = JSON.parse(match[1]);
  const dataset = schema["@graph"].find(node => node["@type"] === "Dataset");
  assert.equal(dataset.dateModified, data.date_modified || data.fetched_at.slice(0, 10));
  assert.equal(dataset.temporalCoverage, data.temporal_coverage || `${data.records[0].date}/${latest.date}`);
});

test("no-data or malformed data cannot silently clear the crawlable snapshot", () => {
  assert.throws(() => injectSnapshot(template, JSON.stringify({ records: [] })), /no records/);
  assert.throws(() => injectSnapshot(template, "not json"), /JSON/);
});

test("the page publishes crawlable canonical, social, dataset and source context", () => {
  assert.match(template, /<link rel="canonical" href="https:\/\/rbiweeklydashboard\.pages\.dev\/">/);
  assert.match(template, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(template, /<meta property="og:image" content="https:\/\/rbiweeklydashboard\.pages\.dev\/og-image\.png">/);
  assert.match(template, /<meta property="og:image:alt" content="[^"]+">/);
  assert.match(template, /<meta name="twitter:image" content="https:\/\/rbiweeklydashboard\.pages\.dev\/og-image\.png">/);
  assert.match(template, /Weekly Statistical Supplement \(WSS\)/);
  assert.match(template, /<script type="application\/json" id="seo-data-snapshot">/);
  assert.match(template, /<div class="mc-val" id="m-res-usd">\d/);
  assert.match(template, /<time id="snapshot-observation">\d/);
  assert.match(template, /not an RBI publication or endorsement/);
  assert.match(template, /https:\/\/ppac\.gov\.in\/import-export/);
  assert.match(template, /not presented as Union Budget expenditure or as accounts audited by the CAG/);
  assert.match(template, /no redistribution licence is asserted/i);
});
