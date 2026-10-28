// tests/agent-surface.test.mjs - the agent-facing layer of the dashboard.
//
//   npm test          (node --test, no dependencies)
//
// functions/_router.js serves Markdown for `/`, `/about`, `/contact` and
// `/privacy`, always answers the `.md` aliases, redirects the `.html` aliases,
// and turns an unmatched path into a Markdown 404 when one is asked for - all
// without disturbing the `/data/*.json` API that sits in front of it. The
// router takes `env` as an argument, so an ASSETS stub exercises the real
// routing without Wrangler, without a scrape and without the network.
//
// Everything else here reads the files that get uploaded: the homepage head,
// the JSON-LD an agent parses, the three trust pages, the sitemap, robots.txt,
// llms.txt and the social card.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import {
  ABOUT_MARKDOWN,
  CONTACT_MARKDOWN,
  DOCUMENTS,
  HOME_MARKDOWN,
  HTML_ALIASES,
  MARKDOWN_ALIASES,
  PRIVACY_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from "../functions/_agent-docs.js";
import router from "../functions/_router.js";

const ROOT = new URL("../", import.meta.url);
const PUBLIC = new URL("../public/", import.meta.url);
const SITE = "https://rbiweeklydashboard.pages.dev";
const read = (name) => readFile(new URL(name, ROOT), "utf8");

// The router only reaches the Cache API for a GET that matched a route. The
// document paths return before that, and the one API assertion below supplies
// the same Map-shaped stand-in the edge-cache test uses.
function runtime() {
  globalThis.caches = {
    default: {
      async match() {
        return undefined;
      },
      async put() {},
    },
  };
  const pending = [];
  return {
    env: {
      ASSETS: assetsStub(),
      SYNC_KV: { async get() { return null; }, async put() {} },
    },
    ctx: { waitUntil: (promise) => pending.push(Promise.resolve(promise).catch(() => {})) },
    pending,
  };
}

const HTML_PAGE = (title) =>
  new Response(`<!doctype html><html lang="en"><body><h1>${title}</h1></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });

const SNAPSHOT = JSON.stringify({
  fetched_at: "2026-10-17T11:10:17.406Z",
  data_updated_at: "2026-10-17T11:10:17.406Z",
  records: [
    { date: "2026-10-02", total_usd: 720000, gold_usd: 104000, usd_inr: 96.1 },
    { date: "2026-10-09", total_usd: 726027, gold_usd: 105094, usd_inr: 96.82 },
  ],
});

/** The assets layer, resolving `/contact` itself but not `/about`, so both the
 *  direct hit and the `.html` fallback get exercised. */
function assetsStub() {
  return {
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/" || path === "/index.html") return HTML_PAGE("RBI Weekly Dashboard");
      if (path === "/about.html") return HTML_PAGE("About");
      if (path === "/contact") return HTML_PAGE("Contact");
      if (path === "/privacy.html") return HTML_PAGE("Privacy");
      if (path === "/rbi-data.json") {
        return new Response(SNAPSHOT, { headers: { "Content-Type": "application/json" } });
      }
      if (path === "/llms.txt") {
        return new Response("# RBI Weekly Dashboard\n", {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response('<!doctype html><html lang="en"><body><h1>Nothing here</h1></body></html>', {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  };
}

async function get(path, accept, method = "GET") {
  const headers = {};
  if (accept !== undefined) headers.Accept = accept;
  const rt = runtime();
  const response = await router.fetch(
    new Request(`${SITE}${path}`, { method, headers }),
    rt.env,
    rt.ctx
  );
  await Promise.all(rt.pending);
  return response;
}

/** Text a crawler sees, with scripts, styles and tags removed. */
function visibleText(html) {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/* ----------------------------------------------------------- negotiation */

test("negotiation keeps browsers and wildcards on HTML", () => {
  assert.equal(negotiate(null), "html");
  assert.equal(negotiate("*/*"), "html");
  assert.equal(negotiate("text/html,*/*;q=0.8"), "html");
  assert.equal(negotiate("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"), "html");
  assert.equal(negotiate("text/markdown"), "markdown");
  assert.equal(negotiate("text/markdown, text/html;q=0.5"), "markdown");
  assert.equal(negotiate("text/html;q=1, text/markdown;q=0.8"), "html");
  assert.equal(negotiate("text/markdown;q=0.9, text/html;q=0.9"), "markdown");
  assert.equal(negotiate("application/pdf"), "not-acceptable");
  assert.equal(negotiate("text/markdown;q=0"), "not-acceptable");
});

test("the homepage negotiates Markdown with Vary", async () => {
  const response = await get("/", "text/markdown");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown; charset=utf-8$/);
  assert.equal(response.headers.get("Vary"), "Accept");
  const body = await response.text();
  assert.ok(body.startsWith("# RBI Weekly Dashboard"), body.slice(0, 40));
  assert.ok(body.includes("## When to use this"));
  assert.ok(body.length > 1500, `body too short: ${body.length}`);
});

test("the homepage keeps HTML for browsers and advertises the alternate", async () => {
  const response = await get("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(response.headers.get("Vary") || "", /\bAccept\b/);
  assert.match(response.headers.get("Link") || "", /<\/index\.md>; rel="alternate"/);
  assert.match(response.headers.get("Link") || "", /llms\.txt/);
});

test("HEAD carries the Markdown type and no body", async () => {
  const response = await get("/", "text/markdown", "HEAD");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown/);
  assert.equal(await response.text(), "");
});

test("an Accept that excludes both representations gets 406", async () => {
  const response = await get("/", "application/pdf");
  assert.equal(response.status, 406);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown/);
  assert.match(await response.text(), /Not acceptable/);
});

/* --------------------------------------------------------------- aliases */

test("every .md alias always answers Markdown", async () => {
  for (const [path, document] of MARKDOWN_ALIASES) {
    const response = await get(path, "text/html");
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("Content-Type"), /^text\/markdown/, path);
    assert.equal(await response.text(), document, path);
  }
});

test("the trust pages negotiate Markdown and serve HTML", async () => {
  for (const path of ["/about", "/contact", "/privacy"]) {
    const markdown = await get(path, "text/markdown");
    assert.equal(markdown.status, 200, path);
    assert.match(markdown.headers.get("Content-Type"), /^text\/markdown/, path);
    assert.ok((await markdown.text()).length > 500, path);

    const html = await get(path, "text/html");
    assert.equal(html.status, 200, path);
    assert.match(html.headers.get("Content-Type"), /^text\/html/, path);
    assert.equal(html.headers.get("Vary"), "Accept", path);
  }
});

test("the .html files redirect to their clean URL", async () => {
  for (const [alias, canonical] of HTML_ALIASES) {
    const response = await get(alias, "text/html");
    assert.equal(response.status, 308, alias);
    assert.equal(new URL(response.headers.get("Location")).pathname, canonical, alias);
  }
});

/* ------------------------------------------------------------------- 404 */

test("a missing path asked for Markdown returns 404 with a Markdown body", async () => {
  const response = await get("/__ora-404-probe-0z74bcih", "text/markdown");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("Content-Type"), /^text\/markdown; charset=utf-8$/);
  assert.equal(response.headers.get("Vary"), "Accept");
  const body = await response.text();
  assert.ok(body.length > 60, `too short: ${body.length}`);
  assert.match(body, /Page not found/);
  assert.match(body, /__ora-404-probe-0z74bcih/);
  assert.match(body, /sitemap\.xml/);
  assert.match(body, /llms\.txt/);
  assert.doesNotMatch(body, /<html/i);
});

test("a missing path for a browser keeps the HTML 404", async () => {
  const response = await get("/__ora-404-probe-0z74bcih", "text/html");
  assert.equal(response.status, 404);
  assert.match(response.headers.get("Content-Type"), /^text\/html/);
  assert.match(await response.text(), /Nothing here/);
  assert.match(response.headers.get("Vary") || "", /\bAccept\b/);
});

test("the 404 body is safe when the path contains backticks", () => {
  assert.match(notFoundMarkdown("/a`b"), /a'b/);
});

/* --------------------------------------------------------------- routing */

test("the public JSON API wins over the document layer", async () => {
  const response = await get("/data/latest.json", "text/markdown");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Content-Type"), /^application\/json/);
  const payload = JSON.parse(await response.text());
  assert.equal(payload.status, "ok");
  assert.equal(payload.iso, "2026-10-09");
  assert.equal(payload.record.total_usd, 726027);
});

test("merging Vary keeps what a handler already sent", () => {
  const headers = new Headers({ Vary: "Accept-Encoding" });
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
  mergeVary(headers);
  assert.equal(headers.get("Vary"), "Accept-Encoding, Accept");
  const wildcard = new Headers({ Vary: "*" });
  mergeVary(wildcard);
  assert.equal(wildcard.get("Vary"), "*");
});

test("markdownResponse drops the body on HEAD", async () => {
  assert.equal(await markdownResponse("# hi\n", 200, "HEAD").text(), "");
});

/* ------------------------------------------------------------------ docs */

test("the documents name endpoints the router actually serves", async () => {
  const routerSource = await read("functions/_router.js");
  for (const endpoint of [
    "/data/latest.json",
    "/data/forex-weekly.json",
    "/data/crude-bpd.json",
    "/data/fii.json",
    "/data/gsec.json",
    "/data/reer.json",
    "/data/tax.json",
    "/data/sentiment.json",
    "/data/external-debt.json",
  ]) {
    assert.ok(routerSource.includes(`"${endpoint}"`), `router is missing ${endpoint}`);
    assert.ok(HOME_MARKDOWN.includes(endpoint), `home Markdown is missing ${endpoint}`);
  }
  assert.ok(HOME_MARKDOWN.includes("## When to use this"));
  assert.ok((await read("public/llms.txt")).includes("## When to use this"));
});

test("every document is substantial and consistent with its alias", () => {
  for (const [path, doc] of DOCUMENTS) {
    assert.ok(doc.markdown.length > 500, path);
    assert.ok(doc.markdown.startsWith("# "), path);
    assert.equal(MARKDOWN_ALIASES.get(doc.alternate), doc.markdown, path);
  }
  for (const doc of [ABOUT_MARKDOWN, CONTACT_MARKDOWN, PRIVACY_MARKDOWN]) {
    assert.match(doc, /soni\.soni\.parth@gmail\.com/);
  }
});

/* -------------------------------------------------------------- metadata */

test("the homepage carries the metadata an agent resolves the entity from", async () => {
  const html = await read("public/index.html");
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/rbiweeklydashboard\.pages\.dev\/">/);
  assert.match(html, /<link rel="alternate" type="text\/markdown" href="\/index\.md">/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta property="og:site_name" content="RBI Weekly Dashboard">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/rbiweeklydashboard\.pages\.dev\/">/);
  assert.match(html, /<meta property="og:image" content="https:\/\/rbiweeklydashboard\.pages\.dev\/og-image\.png">/);
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  assert.match(html, /RBI Weekly Dashboard - India Forex Reserves/);
});

test("the JSON-LD is valid, complete and internally linked", async () => {
  const html = await read("public/index.html");
  const match = html.match(/<script type="application\/ld\+json" id="seo-dataset-schema">([\s\S]*?)<\/script>/);
  assert.ok(match, "no JSON-LD block");
  const schema = JSON.parse(match[1]);
  const nodes = schema["@graph"];
  assert.ok(Array.isArray(nodes));

  const org = nodes.find((node) => node["@type"] === "Organization");
  const site = nodes.find((node) => node["@type"] === "WebSite");
  const app = nodes.find((node) => node["@type"] === "WebApplication");
  const dataset = nodes.find((node) => node["@type"] === "Dataset");
  assert.ok(org && site && app && dataset, "missing a node");

  assert.equal(org["@id"], `${SITE}/#organization`);
  assert.equal(org.contactPoint["@type"], "ContactPoint");
  assert.match(org.contactPoint.email, /@/);
  assert.ok(org.contactPoint.contactType);
  assert.equal(org.address["@type"], "PostalAddress");
  assert.ok(org.address.addressCountry);
  assert.ok(org.address.addressLocality);
  assert.ok(Array.isArray(org.sameAs) && org.sameAs.length >= 1);
  assert.equal(org.name, "RBI Weekly Dashboard");

  assert.equal(site.publisher["@id"], org["@id"]);
  assert.equal(app.publisher["@id"], org["@id"]);
  assert.equal(dataset.creator["@id"], org["@id"]);
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(dataset.dateModified));
  assert.match(dataset.temporalCoverage, /^\d{4}-\d{2}-\d{2}\/\d{4}-\d{2}-\d{2}$/);
});

test("the social card is a 1200x630 PNG", async () => {
  const png = await readFile(new URL("og-image.png", PUBLIC));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.ok(png.length > 10000, `card looks empty: ${png.length} bytes`);
});

/* ------------------------------------------------------- trust and files */

test("the trust pages carry real content and navigation", async () => {
  for (const [file, canonical, markdownAlias] of [
    ["about.html", `${SITE}/about`, "/about.md"],
    ["contact.html", `${SITE}/contact`, "/contact.md"],
    ["privacy.html", `${SITE}/privacy`, "/privacy.md"],
  ]) {
    const html = await readFile(new URL(file, PUBLIC), "utf8");
    assert.match(html, /<html lang="en">/, file);
    assert.ok(html.includes(`<link rel="canonical" href="${canonical}">`), file);
    assert.ok(html.includes(`<link rel="alternate" type="text/markdown" href="${markdownAlias}">`), file);
    assert.ok(html.includes('name="description"'), file);
    assert.ok(html.includes('property="og:image"'), file);
    assert.ok(visibleText(html).length >= 500, `${file} has too little text`);

    for (const other of ["/about", "/contact", "/privacy"]) {
      assert.ok(html.includes(`href="${other}"`), `${file} does not link ${other}`);
    }
    assert.doesNotMatch(html, /\sstyle="/, `${file} carries an inline style the CSP would drop`);
  }
});

test("the 404 page points at the machine-readable files", async () => {
  const html = await readFile(new URL("404.html", PUBLIC), "utf8");
  assert.ok(visibleText(html).length > 200);
  assert.ok(html.includes('href="/sitemap.xml"'));
  assert.ok(html.includes('href="/llms.txt"'));
  assert.match(html, /noindex/);
});

test("the sitemap lists every published page", async () => {
  const sitemap = await readFile(new URL("sitemap.xml", PUBLIC), "utf8");
  const locations = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]);
  assert.deepEqual(
    locations.sort(),
    [`${SITE}/`, `${SITE}/about`, `${SITE}/contact`, `${SITE}/privacy`].sort()
  );
  for (const page of ["about.html", "contact.html", "privacy.html"]) {
    const html = await readFile(new URL(page, PUBLIC), "utf8");
    const canonical = html.match(/rel="canonical" href="([^"]+)"/)[1];
    assert.ok(locations.includes(canonical), `${page} canonical is not in the sitemap`);
  }
});

test("robots.txt and llms.txt agree on the sitemap", async () => {
  const robots = await readFile(new URL("robots.txt", PUBLIC), "utf8");
  assert.match(robots, /Sitemap: https:\/\/rbiweeklydashboard\.pages\.dev\/sitemap\.xml/);
  assert.match(robots, /User-agent: \*/);
  const llms = await readFile(new URL("llms.txt", PUBLIC), "utf8");
  assert.ok(llms.startsWith("# RBI Weekly Dashboard"));
  assert.ok(llms.includes("> "), "llms.txt needs the summary blockquote");
  assert.ok(llms.includes(`${SITE}/sitemap.xml`));
});

test("the deploy stages public/ and the new pages are in it", async () => {
  // `public/` is the whole upload (tools/deploy-pages.mjs --assets public), so a
  // file that exists there is published unless .assetsignore excludes it - and
  // this repo's .assetsignore is empty.
  const ignore = await read(".assetsignore");
  assert.equal(ignore.trim(), "");
  for (const file of ["about.html", "contact.html", "privacy.html", "llms.txt", "pages.css"]) {
    await assert.doesNotReject(readFile(new URL(file, PUBLIC)), `${file} is missing from public/`);
  }
});
