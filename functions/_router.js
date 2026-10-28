/**
 * RBI weekly dashboard - the routing half of this site's Pages Function.
 *
 * This file only adapts how the sixteen functions under netlify/functions/ are
 * hosted. Pages compiles this directory (see `functions/[[path]].js`, the
 * catch-all route) and it imports those files, so the scrapers, the parsers, the
 * validation in data-sync and the response caching keep exactly one
 * implementation - the one the site ran on. The `_` prefix keeps this file out of
 * the routing table: the only route is the catch-all beside it.
 *
 * What the Netlify runtime used to provide, and what replaces it here:
 *
 *   routing     `public/_redirects` mapped the dashboard's public API - the
 *               /data/*.json paths - onto functions. Those rewrites are handled
 *               here instead (PUBLIC_API below), because on Cloudflare a
 *               rewrite in `_redirects` only reaches the function if the
 *               post-rewrite path is also routed to it, which makes the same rule
 *               depend on two files agreeing. The /data/* paths are
 *               still the public API and still answer exactly as they did; the
 *               `_redirects` file stays as the record of that contract.
 *
 *   storage     data-sync.js kept its durable merge cache in a Netlify Blob. It
 *               now receives a KV-backed store through setStore() with the same
 *               two calls it made before - get(key, { type: 'json' }) and
 *               setJSON(key, value) - so its validation, its write guards and
 *               its read-side cleaning are untouched.
 *
 *   config      Netlify put environment variables in process.env; Workers hand
 *               them over as bindings, so they are copied onto process.env
 *               before any handler runs (nodejs_compat supplies the object).
 *
 *   CDN cache   Netlify's CDN held each handler's response for the Cache-Control
 *               the handler already declares (`public, max-age=900` on the
 *               data-* endpoints), so repeat and embed traffic never re-scraped.
 *               A Worker's response is not edge-cached unless the Worker puts it
 *               there, and these handlers scrape live on request - data-latest
 *               walks back up to six Fridays - so the missing layer showed up as
 *               36–54 seconds per request instead of a cache hit. The two
 *               weekly endpoints no longer scrape on request: they read the
 *               committed snapshot (see _utils/committed.js), so only the live
 *               fetch-* endpoints still scrape. `fetch` now
 *               stores a response in the colo cache under exactly the policy the
 *               handler asked for; see EDGE CACHE below.
 *
 *   build       Netlify ran scripts/fetch-all.js and the forward-book updaters
 *               on every deploy to regenerate the committed public/*.json. There
 *               is no build step here - a deploy ships what the repository holds
 *               - so the same chain is run by .github/workflows/refresh-data.yml
 *               (Friday 22:00 UTC) over a checked-out tree, and its data commit
 *               is what the Pages build that follows deploys. It was this file's
 *               `scheduled` handler calling netlify/functions/refresh-data.js
 *               over the GitHub API while the site ran on a Worker; Pages has no
 *               cron triggers, and a runner has the filesystem the API call was
 *               standing in for. Nothing in this file regenerates data any more.
 *               The live figures never depended on any of it - the fetch-*
 *               endpoints scrape on request.
 *
 * Handlers are called with the same event shape they declare ({ httpMethod,
 * headers, queryStringParameters, body, ... }), and their { statusCode, headers,
 * body } result is turned straight back into a Response.
 *
 * The agent layer sits beside the API and touches none of it: `/`, `/about`,
 * `/contact` and `/privacy` negotiate `text/markdown`, their `.md` aliases always
 * answer Markdown, and an unmatched path gets a Markdown 404 when one is asked
 * for. `/data/*.json` and `/.netlify/functions/*` are matched first, so no
 * document rule can shadow a data endpoint. The bodies live in
 * `_agent-docs.js`; the dashboard's own delivery is unchanged.
 */

import dataLatest from "../netlify/functions/data-latest.js";
import dataForexWeekly from "../netlify/functions/data-forex-weekly.js";
import dataCrudeBpd from "../netlify/functions/data-crude-bpd.js";
import dataSync from "../netlify/functions/data-sync.js";
import fetchData from "../netlify/functions/fetch-data.js";
import fetchCrude from "../netlify/functions/fetch-crude.js";
import fetchEmPeers from "../netlify/functions/fetch-em-peers.js";
import fetchExternalDebt from "../netlify/functions/fetch-external-debt.js";
import fetchFii from "../netlify/functions/fetch-fii.js";
import fetchFiiHistory from "../netlify/functions/fetch-fii-history.js";
import fetchFwdLatest from "../netlify/functions/fetch-fwd-latest.js";
import fetchFxIntervention from "../netlify/functions/fetch-fx-intervention.js";
import fetchGsec from "../netlify/functions/fetch-gsec.js";
import fetchReer from "../netlify/functions/fetch-reer.js";
import fetchSentiment from "../netlify/functions/fetch-sentiment.js";
import fetchTax from "../netlify/functions/fetch-tax.js";
import {
  DOCUMENTS,
  HTML_ALIASES,
  MARKDOWN_ALIASES,
  NOT_ACCEPTABLE_MARKDOWN,
  markdownResponse,
  mergeVary,
  negotiate,
  notFoundMarkdown,
} from "./_agent-docs.js";

const ROUTES = {
  "/.netlify/functions/data-latest": dataLatest,
  "/.netlify/functions/data-forex-weekly": dataForexWeekly,
  "/.netlify/functions/data-crude-bpd": dataCrudeBpd,
  "/.netlify/functions/data-sync": dataSync,
  "/.netlify/functions/fetch-data": fetchData,
  "/.netlify/functions/fetch-crude": fetchCrude,
  "/.netlify/functions/fetch-em-peers": fetchEmPeers,
  "/.netlify/functions/fetch-external-debt": fetchExternalDebt,
  "/.netlify/functions/fetch-fii": fetchFii,
  "/.netlify/functions/fetch-fii-history": fetchFiiHistory,
  "/.netlify/functions/fetch-fwd-latest": fetchFwdLatest,
  "/.netlify/functions/fetch-fx-intervention": fetchFxIntervention,
  "/.netlify/functions/fetch-gsec": fetchGsec,
  "/.netlify/functions/fetch-reer": fetchReer,
  "/.netlify/functions/fetch-sentiment": fetchSentiment,
  "/.netlify/functions/fetch-tax": fetchTax,
};

/** The clean public API `public/_redirects` described, pointing at the same
    handlers. Kept here because a Worker rewrite only reaches this Worker when
    the rewritten path is also listed in `run_worker_first` - one mechanism
    instead of two that have to agree. */
const PUBLIC_API = {
  "/data/latest.json": dataLatest,
  "/data/forex-weekly.json": dataForexWeekly,
  "/data/crude-bpd.json": dataCrudeBpd,
  "/data/fii.json": fetchFii,
  "/data/fii-history.json": fetchFiiHistory,
  "/data/fx-intervention.json": fetchFxIntervention,
  "/data/gsec.json": fetchGsec,
  "/data/tax.json": fetchTax,
  "/data/reer.json": fetchReer,
  "/data/sentiment.json": fetchSentiment,
  "/data/external-debt.json": fetchExternalDebt,
};

/**
 * EDGE CACHE - the layer Netlify's CDN used to be.
 *
 * A response is stored only when the handler itself asked for it: `public` with
 * a positive `max-age`, and no `Set-Cookie`. That is deliberately narrower than
 * "anything with a Cache-Control header". Every error path in these handlers
 * sends `no-store`, and data-sync sends `no-store` on its reads as well as its
 * writes, so nothing that should stay fresh is held - the same policy the site
 * had in front of it before. A response we decline to store is simply returned,
 * which is the behaviour without this block.
 *
 * The Cache API takes the entry's lifetime from the response's own Cache-Control,
 * so the handler's `max-age=900` is the TTL again, and no second copy of that
 * number lives here to drift away from it.
 *
 * This layer was load-bearing rather than a nicety: the netlify.toml this file
 * replaced gave data-latest and data-forex-weekly a 26-second budget, so a live
 * scrape that overran it was only ever survivable because the answer was then
 * served from cache until the 900s expired. The same two endpoints measured 36s
 * and 54s without it.
 */
const NO_STORE = /(?:^|,|\s)(?:no-store|private)\b/i;
const PUBLIC_SHARED = /(?:^|,|\s)public\b/i;
const MAX_AGE = /max-age\s*=\s*(\d+)/i;

export function storeable(response) {
  const cc = response.headers.get("Cache-Control") || "";
  if (!cc || NO_STORE.test(cc) || !PUBLIC_SHARED.test(cc)) return false;
  const ttl = cc.match(MAX_AGE);
  if (!ttl || Number(ttl[1]) <= 0) return false;
  return !response.headers.has("Set-Cookie");
}

/** The two calls data-sync made to a Netlify Blob, served from KV. */
function storeFromKv(kv) {
  const STORE_NAME = "rbi-data-sync";
  return {
    async get(key, options) {
      const value = options && options.type === "json" ? await kv.get(`${STORE_NAME}/${key}`, "json") : await kv.get(`${STORE_NAME}/${key}`);
      return value === null ? null : value;
    },
    async setJSON(key, value) {
      await kv.put(`${STORE_NAME}/${key}`, JSON.stringify(value));
    },
  };
}

/** Hand this request's bindings to the code that expects Netlify's shape. */
function wireBindings(env) {
  if (typeof process !== "undefined" && process.env) {
    for (const [key, value] of Object.entries(env)) {
      if (typeof value === "string") process.env[key] = value;
    }
  }
  if (env.SYNC_KV) dataSync.setStore(storeFromKv(env.SYNC_KV));
  // The public /data/*.json endpoints read the committed snapshot through the
  // asset store instead of scraping RBI on request (see netlify/functions/_
  // utils/committed.js).
  if (env.ASSETS) {
    dataLatest.setAssets(env.ASSETS);
    dataForexWeekly.setAssets(env.ASSETS);
  }
}

/** Fetch a negotiated HTML document, falling back to its `.html` file: Pages
    resolves clean URLs itself, but the assets layer is the only place that
    knows how, and this keeps the behaviour identical under a test stub. */
async function fetchDocument(env, request, document) {
  let response = await env.ASSETS.fetch(request);
  if (response.status === 404 && document.file) {
    const url = new URL(request.url);
    url.pathname = document.file;
    response = await env.ASSETS.fetch(new Request(url, request));
  }
  return response;
}

/** Advertise the Markdown alternative on the HTML response, and make a shared
    cache key on Accept - without Vary it would hand one visitor's
    representation to the next. */
function withDocHeaders(response, document) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  if (response.status >= 200 && response.status < 300) {
    headers.set(
      "Link",
      `<${document.alternate}>; rel="alternate"; type="text/markdown", ` +
        `</llms.txt>; rel="describedby"; type="text/plain"`
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function withVary(response) {
  const headers = new Headers(response.headers);
  mergeVary(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** One of the agent documents: alias, negotiated Markdown, or the real page.
    Returns null when the pathname is not a document. */
async function serveDocument(request, env, pathname) {
  const alias = MARKDOWN_ALIASES.get(pathname);
  if (alias) return markdownResponse(alias, 200, request.method);

  const document = DOCUMENTS.get(pathname);
  if (!document) return null;

  const choice = negotiate(request.headers.get("Accept"));
  if (choice === "markdown") return markdownResponse(document.markdown, 200, request.method);
  if (choice === "not-acceptable") {
    return markdownResponse(NOT_ACCEPTABLE_MARKDOWN, 406, request.method);
  }
  return withDocHeaders(await fetchDocument(env, request, document), document);
}

/** Build the event the functions are written against out of this request. */
async function toEvent(request, url) {
  const headers = {};
  for (const [name, value] of request.headers) headers[name.toLowerCase()] = value;
  if (!headers["x-forwarded-for"] && headers["cf-connecting-ip"]) {
    headers["x-forwarded-for"] = headers["cf-connecting-ip"];
  }
  const method = request.method;
  const event = {
    httpMethod: method,
    headers,
    path: url.pathname,
    rawUrl: url.toString(),
    queryStringParameters: Object.fromEntries(url.searchParams),
  };
  if (method !== "GET" && method !== "HEAD") event.body = await request.text();
  return event;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname] || PUBLIC_API[url.pathname];
    if (!mod) {
      if (request.method === "GET" || request.method === "HEAD") {
        // One canonical address per page: `/about.html` redirects to `/about`,
        // so a search result or a pasted link never splits into two documents.
        const canonical = HTML_ALIASES.get(url.pathname);
        if (canonical) {
          const target = new URL(url);
          target.pathname = canonical;
          return new Response(null, {
            status: 308,
            headers: { Location: target.toString(), "Cache-Control": "public, max-age=3600" },
          });
        }

        const document = await serveDocument(request, env, url.pathname);
        if (document) return document;

        const response = await env.ASSETS.fetch(request);
        if (response.status === 404) {
          if (negotiate(request.headers.get("Accept")) === "markdown") {
            return markdownResponse(notFoundMarkdown(url.pathname), 404, request.method);
          }
          return withVary(response);
        }
        return response;
      }
      return env.ASSETS.fetch(request);
    }

    wireBindings(env);

    // Only a GET is looked up or stored. A HEAD shares a GET's cache entry but
    // is not how this API is called, and every other method is a write.
    const edge = request.method === "GET";
    if (edge) {
      const hit = await caches.default.match(request);
      if (hit) return hit;
    }

    try {
      const result = await mod.handler(await toEvent(request, url));
      const response = new Response(result.body, {
        status: result.statusCode || 200,
        headers: result.headers || {},
      });
      // Stored after the reply is on its way, so a slow scrape is never the
      // reason a first visitor waits even longer.
      if (edge && ctx) {
        const copy = response.clone();
        if (storeable(copy)) ctx.waitUntil(caches.default.put(request, copy).catch(() => {}));
      }
      return response;
    } catch (error) {
      console.error(`${url.pathname} failed:`, (error && error.stack) || error);
      return new Response(JSON.stringify({ error: String((error && error.message) || error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  },
};
