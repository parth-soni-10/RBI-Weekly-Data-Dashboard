/**
 * HTTP verification of the agent-facing surface.
 *
 *   npx wrangler pages dev public --port 8790
 *   node tests/verify-agent-surface.mjs http://127.0.0.1:8790
 *
 * Every check is a real request, so it exercises Pages Functions, the assets
 * layer and `_headers` together. Point it at the deployed origin to repeat the
 * same checks against production. Exits non-zero on any failure.
 */
const BASE = (process.argv[2] || "http://127.0.0.1:8790").replace(/\/$/, "");
const PROBE = "/__ora-404-probe-0z74bcih";

let failures = 0;
const results = [];

function check(name, condition, detail = "") {
  if (condition) results.push(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  else {
    failures += 1;
    results.push(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function fetchPath(path, accept, method = "GET") {
  const headers = {};
  if (accept !== undefined) headers.Accept = accept;
  const response = await fetch(BASE + path, { method, headers, redirect: "manual" });
  const body = method === "HEAD" ? "" : await response.text();
  return { response, body, type: response.headers.get("content-type") || "" };
}

// 1. Homepage negotiation ------------------------------------------------
{
  const md = await fetchPath("/", "text/markdown");
  check("GET / Accept: text/markdown → 200", md.response.status === 200, String(md.response.status));
  check("homepage markdown type", /^text\/markdown; charset=utf-8$/.test(md.type), md.type);
  check("homepage markdown Vary", md.response.headers.get("vary") === "Accept", String(md.response.headers.get("vary")));
  check("homepage markdown body", md.body.startsWith("# RBI Weekly Dashboard"), `${md.body.length} bytes`);
  check("homepage markdown has when-to-use", md.body.includes("## When to use this"));

  const html = await fetchPath("/", "text/html,application/xhtml+xml,*/*;q=0.8");
  check("GET / Accept: text/html → 200", html.response.status === 200, String(html.response.status));
  check("homepage html type", /^text\/html/.test(html.type), html.type);
  check("homepage html Vary includes Accept", /accept/i.test(String(html.response.headers.get("vary"))), String(html.response.headers.get("vary")));
  check("homepage html Link alternate", /<\/index\.md>; rel="alternate"/.test(String(html.response.headers.get("link"))), String(html.response.headers.get("link")));
  check("homepage canonical", html.body.includes('<link rel="canonical" href="https://rbiweeklydashboard.pages.dev/">'));
  check("homepage og:type + og:image", html.body.includes('property="og:type" content="website"') && html.body.includes('content="https://rbiweeklydashboard.pages.dev/og-image.png"'));
  check("homepage JSON-LD organization", html.body.includes('"contactPoint"') && html.body.includes('"PostalAddress"'));
  check("homepage footer links", ["/about", "/contact", "/privacy", "/llms.txt", "/sitemap.xml"].every((p) => html.body.includes(`href="${p}"`)));
  check("homepage CSP applied", /script-src 'self'/.test(String(html.response.headers.get("content-security-policy"))));

  const dflt = await fetchPath("/", undefined);
  check("default Accept stays HTML", /^text\/html/.test(dflt.type), dflt.type);
}

// 2. Trust pages ---------------------------------------------------------
for (const page of ["about", "contact", "privacy"]) {
  const md = await fetchPath(`/${page}`, "text/markdown");
  check(`/${page} markdown → 200`, md.response.status === 200 && /^text\/markdown/.test(md.type), `${md.response.status} ${md.type}`);
  check(`/${page} markdown length`, md.body.length > 500, `${md.body.length} bytes`);

  const html = await fetchPath(`/${page}`, "text/html");
  check(`/${page} html → 200`, html.response.status === 200 && /^text\/html/.test(html.type), `${html.response.status} ${html.type}`);
  check(`/${page} canonical`, html.body.includes(`href="https://rbiweeklydashboard.pages.dev/${page}"`));
  check(`/${page} CSP applied`, /script-src 'self'/.test(String(html.response.headers.get("content-security-policy"))));
}

// 3. Markdown aliases ----------------------------------------------------
for (const [alias, heading] of [
  ["/index.md", "# RBI Weekly Dashboard"],
  ["/about.md", "# About RBI Weekly Dashboard"],
  ["/contact.md", "# Contact RBI Weekly Dashboard"],
  ["/privacy.md", "# Privacy"],
]) {
  const md = await fetchPath(alias, "text/html");
  check(`GET ${alias} → Markdown`, md.response.status === 200 && /^text\/markdown/.test(md.type) && md.body.startsWith(heading), `${md.response.status} ${md.type}`);
}

// 4. Clean URLs ----------------------------------------------------------
for (const [alias, target] of [
  ["/index.html", "/"],
  ["/about.html", "/about"],
  ["/contact.html", "/contact"],
  ["/privacy.html", "/privacy"],
]) {
  const redirect = await fetchPath(alias, "text/html");
  const location = redirect.response.headers.get("location") || "";
  check(`${alias} → 308 ${target}`, redirect.response.status === 308 && new URL(location).pathname === target, `${redirect.response.status} ${location}`);
}

// 5. 404 -----------------------------------------------------------------
{
  const md = await fetchPath(PROBE, "text/markdown");
  check("missing path markdown → 404", md.response.status === 404, String(md.response.status));
  check("missing path markdown type", /^text\/markdown; charset=utf-8$/.test(md.type), md.type);
  check("missing path markdown Vary", md.response.headers.get("vary") === "Accept", String(md.response.headers.get("vary")));
  check("missing path markdown explains", md.body.includes("Nothing is published at") && md.body.includes(PROBE), `${md.body.length} bytes`);
  check("missing path markdown links", md.body.includes("sitemap.xml") && md.body.includes("llms.txt"));

  const html = await fetchPath(PROBE, "text/html");
  check("missing path html → 404", html.response.status === 404, String(html.response.status));
  check("missing path html body", /^text\/html/.test(html.type) && /Nothing at this address/.test(html.body), `${html.type} ${html.body.length} bytes`);
  check("missing path html links", html.body.includes('href="/sitemap.xml"') && html.body.includes('href="/llms.txt"'));
}

// 6. 406 and HEAD --------------------------------------------------------
{
  const refused = await fetchPath("/", "application/pdf");
  check("unacceptable Accept → 406", refused.response.status === 406 && /^text\/markdown/.test(refused.type), `${refused.response.status} ${refused.type}`);

  const head = await fetchPath("/", "text/markdown", "HEAD");
  check("HEAD / markdown", head.response.status === 200 && /^text\/markdown/.test(head.type), `${head.response.status} ${head.type}`);
}

// 7. Machine-readable files ---------------------------------------------
for (const [path, type, minBytes] of [
  ["/llms.txt", /^text\/plain/, 2000],
  ["/robots.txt", /^text\/plain/, 100],
  ["/sitemap.xml", /^(application|text)\/xml/, 300],
  ["/og-image.png", /^image\/png/, 10000],
  ["/pages.css", /^text\/css/, 1000],
  ["/about", /^text\/html/, 2000],
]) {
  const file = await fetchPath(path, undefined);
  check(`GET ${path}`, file.response.status === 200 && type.test(file.type) && file.body.length >= minBytes, `${file.response.status} ${file.type} ${file.body.length} bytes`);
}

// 8. The data API is untouched by the document layer ---------------------
{
  const latest = await fetchPath("/data/latest.json", "text/markdown");
  let payload = null;
  try {
    payload = JSON.parse(latest.body);
  } catch {}
  check("/data/latest.json still JSON", latest.response.status === 200 && /^application\/json/.test(latest.type), `${latest.response.status} ${latest.type}`);
  check("/data/latest.json payload", !!payload && payload.status === "ok" && /^\d{4}-\d{2}-\d{2}$/.test(String(payload.iso || "")), payload ? `${payload.iso} ${payload.record && payload.record.date}` : "unparsable");

  const weekly = await fetchPath("/data/forex-weekly.json?weeks=2", "text/markdown");
  let rows = null;
  try {
    rows = JSON.parse(weekly.body);
  } catch {}
  check("/data/forex-weekly.json still JSON", weekly.response.status === 200 && /^application\/json/.test(weekly.type), `${weekly.response.status} ${weekly.type}`);
  check("/data/forex-weekly.json records", !!rows && Array.isArray(rows.records) && rows.records.length === 2, rows ? `${rows.records.length} rows` : "unparsable");
}

console.log(results.join("\n"));
console.log(`\n${results.length - failures}/${results.length} checks passed`);
process.exit(failures === 0 ? 0 : 1);
