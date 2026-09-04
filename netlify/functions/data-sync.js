// data-sync.js — durable merge cache for the dashboard's Reload button.
//
// The dashboard loads the committed static file public/rbi-data.json, live-checks
// the fetch-data function for weeks newer than the file, and merges them in the
// browser. That merged set is ephemeral unless persisted — and Netlify Functions
// cannot write to the publish directory in production. So this function stores
// the merged records in a Netlify Blob (durable, shared across visitors, survives
// deploys). On the next page load the dashboard reads the blob first, anchors the
// live check on its newest record, and only re-scrapes RBI when something newer
// actually exists — repeat reloads never re-fetch the same weeks.
//
// The blob also carries a `forward` entry (the newest official RBI forward
// figure found by a live check, so repeat reloads skip the fetch-fwd-latest
// rbi.org.in scrape), an `em` entry (per-range EM-peers payloads, so repeat
// reloads skip the Yahoo fetches too), and a `pmcares` entry (a durable mirror
// of the curated PM CARES fund rows, so the section never depends on fetching
// anything). Writes that omit a key preserve the existing saved value, so the
// weekly/forward/em/pmcares persists never clobber each other.
//
//   GET  /.netlify/functions/data-sync            → { savedAt, records, forward, em, pmcares } | { records: null, ... }
//   POST /.netlify/functions/data-sync            body: { records: [...], forward?: {...}, em?: {...}, pmcares?: { rows, checkedAt } } → { ok, savedAt }
//
// Failures degrade gracefully: GET returns records:null and POST returns an error
// status; the dashboard falls back to file + live-check in both cases.
const { getStore } = require("@netlify/blobs");

const STORE_NAME = "rbi-data-sync";
const KEY = "records";

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  body: JSON.stringify(obj),
});

exports.handler = async (event) => {
  let store;
  try {
    // In the Netlify function runtime getStore() auto-configures from the
    // environment; a named store is durable across deploys.
    store = getStore({ name: STORE_NAME });
  } catch (err) {
    return json(503, { error: `blob store unavailable: ${err.message}` });
  }

  if (event.httpMethod === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    if (!Array.isArray(body.records)) {
      return json(400, { error: "body.records must be an array" });
    }
    const fwd = body.forward;
    if (fwd !== undefined && fwd !== null && !(typeof fwd === "object" && typeof fwd.date === "string" && typeof fwd.net_fwd === "number")) {
      return json(400, { error: "body.forward must be an object with date (string) and net_fwd (number)" });
    }
    const em = body.em;
    if (em !== undefined && em !== null) {
      if (typeof em !== "object" || Array.isArray(em)) {
        return json(400, { error: "body.em must be an object of { range: { peers, fetchedAt } }" });
      }
      for (const k of Object.keys(em)) {
        const v = em[k];
        if (!v || typeof v !== "object" || !Array.isArray(v.peers)) {
          return json(400, { error: `body.em.${k} must be { peers: [...], fetchedAt }` });
        }
      }
    }
    const pm = body.pmcares;
    if (pm !== undefined && pm !== null && (!pm || typeof pm !== "object" || Array.isArray(pm) || !Array.isArray(pm.rows))) {
      return json(400, { error: "body.pmcares must be { rows: [...], checkedAt }" });
    }
    // Writes that omit a key must not wipe a previously saved value — keep the
    // existing forward, em, and/or pmcares payloads.
    let forward = fwd === undefined ? null : fwd;
    let emSaved = em === undefined ? null : em;
    let pmSaved = pm === undefined ? null : pm;
    if (fwd === undefined || em === undefined || pm === undefined) {
      try {
        const prev = await store.get(KEY, { type: "json" });
        if (prev) {
          if (fwd === undefined && prev.forward) forward = prev.forward;
          if (em === undefined && prev.em) emSaved = prev.em;
          if (pm === undefined && prev.pmcares) pmSaved = prev.pmcares;
        }
      } catch (_) { /* no previous value */ }
    }
    const savedAt = new Date().toISOString();
    try {
      await store.setJSON(KEY, { savedAt, records: body.records, forward, em: emSaved, pmcares: pmSaved });
    } catch (err) {
      return json(502, { error: `write failed: ${err.message}` });
    }
    return json(200, { ok: true, savedAt });
  }

  // GET
  try {
    const saved = await store.get(KEY, { type: "json" });
    if (!saved || !Array.isArray(saved.records)) {
      return json(200, { records: null, savedAt: null, forward: null, em: null, pmcares: null });
    }
    return json(200, {
      records: saved.records,
      savedAt: saved.savedAt || null,
      forward: saved.forward || null,
      em: saved.em || null,
      pmcares: saved.pmcares || null,
    });
  } catch (err) {
    // Blob missing/unavailable is not fatal — the dashboard falls back to the file.
    return json(200, { records: null, savedAt: null, forward: null, em: null, pmcares: null });
  }
};