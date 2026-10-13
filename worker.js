/**
 * RBI weekly dashboard — Cloudflare Worker.
 *
 * This file only adapts how the sixteen functions under netlify/functions/ are
 * hosted. Wrangler bundles those files into this Worker, so the scrapers, the
 * parsers, the validation in data-sync and the response caching keep exactly one
 * implementation — the one the site ran on.
 *
 * What the Netlify runtime used to provide, and what replaces it here:
 *
 *   routing     `public/_redirects` mapped the dashboard's public API — the
 *               /data/*.json paths — onto functions. Those rewrites are handled
 *               here instead (PUBLIC_API below), because on Cloudflare a
 *               rewrite in `_redirects` only reaches this Worker if the
 *               post-rewrite path is also in `run_worker_first`, which makes the
 *               same rule depend on two files agreeing. The /data/* paths are
 *               still the public API and still answer exactly as they did; the
 *               `_redirects` file stays as the record of that contract.
 *
 *   storage     data-sync.js kept its durable merge cache in a Netlify Blob. It
 *               now receives a KV-backed store through setStore() with the same
 *               two calls it made before — get(key, { type: 'json' }) and
 *               setJSON(key, value) — so its validation, its write guards and
 *               its read-side cleaning are untouched.
 *
 *   config      Netlify put environment variables in process.env; Workers hand
 *               them over as bindings, so they are copied onto process.env
 *               before any handler runs (nodejs_compat supplies the object).
 *
 *   build       Netlify ran scripts/fetch-all.js and the forward-book updaters
 *               on every deploy to regenerate the committed public/*.json. There
 *               is no build step here: a deploy ships what the repository holds.
 *               Refreshing that data is a local step now (see wrangler.toml).
 *               The live figures are unaffected — the fetch-* endpoints scrape
 *               on request.
 *
 * Handlers are called with the same event shape they declare ({ httpMethod,
 * headers, queryStringParameters, body, ... }), and their { statusCode, headers,
 * body } result is turned straight back into a Response.
 */

import dataLatest from "./netlify/functions/data-latest.js";
import dataForexWeekly from "./netlify/functions/data-forex-weekly.js";
import dataCrudeBpd from "./netlify/functions/data-crude-bpd.js";
import dataSync from "./netlify/functions/data-sync.js";
import fetchData from "./netlify/functions/fetch-data.js";
import fetchCrude from "./netlify/functions/fetch-crude.js";
import fetchEmPeers from "./netlify/functions/fetch-em-peers.js";
import fetchExternalDebt from "./netlify/functions/fetch-external-debt.js";
import fetchFii from "./netlify/functions/fetch-fii.js";
import fetchFiiHistory from "./netlify/functions/fetch-fii-history.js";
import fetchFwdLatest from "./netlify/functions/fetch-fwd-latest.js";
import fetchFxIntervention from "./netlify/functions/fetch-fx-intervention.js";
import fetchGsec from "./netlify/functions/fetch-gsec.js";
import fetchReer from "./netlify/functions/fetch-reer.js";
import fetchSentiment from "./netlify/functions/fetch-sentiment.js";
import fetchTax from "./netlify/functions/fetch-tax.js";

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
    the rewritten path is also listed in `run_worker_first` — one mechanism
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
  async fetch(request, env) {
    const url = new URL(request.url);
    const mod = ROUTES[url.pathname] || PUBLIC_API[url.pathname];
    if (!mod) return env.ASSETS.fetch(request);

    wireBindings(env);

    try {
      const result = await mod.handler(await toEvent(request, url));
      return new Response(result.body, {
        status: result.statusCode || 200,
        headers: result.headers || {},
      });
    } catch (error) {
      console.error(`${url.pathname} failed:`, (error && error.stack) || error);
      return new Response(JSON.stringify({ error: String((error && error.message) || error) }), {
        status: 500,
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
  },
};
