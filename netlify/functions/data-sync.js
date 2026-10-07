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
//
// ---------------------------------------------------------------------------
// Write path: this is a shared, public cache, so what it stores is what every
// visitor's browser renders. Three things keep that safe:
//
//   1. Same-origin writes. A browser sends Origin on a cross-site POST, so a
//      page on another site is refused (403). Requests with no Origin at all
//      (curl, a script, CI) pass through to the checks below — an operator may
//      legitimately seed the cache that way. Note what this does and does not
//      buy: shape validation (3) is what stops a write from becoming markup, but
//      it cannot tell a *true* record from a well-formed false one. An
//      unauthenticated writer can therefore put believable wrong numbers in
//      front of every visitor. Set SYNC_WRITE_TOKEN to close that, which is the
//      only defence against integrity rather than injection.
//   2. An optional shared secret. Set SYNC_WRITE_TOKEN in the Netlify env and
//      every write must present it as the x-sync-token header (401 otherwise);
//      the dashboard sends it from localStorage("rbi-sync-token") when present.
//      Left unset the write path stays open, because the dashboard is a static
//      page with no server to hold a secret — which is exactly why nothing here
//      is trusted on shape: see 3.
//   3. Validation and sanitisation on the way in *and* on the way out. Any
//      string that could become markup is stripped of < and >, dates must look
//      like dates, numbers must be finite, and every collection has a cap — so
//      neither a fresh write nor a payload stored before this check existed can
//      reach the page as HTML. public/index.html escapes on render as well.
// ---------------------------------------------------------------------------
const { getStore } = require("@netlify/blobs");
const { timingSafeEqual } = require("node:crypto");

const STORE_NAME = "rbi-data-sync";
const KEY = "records";

// Netlify accepts ~6 MB request bodies for a synchronous function; the merge
// payload never needs anywhere near that, so fail fast well below it.
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RECORDS = 500;
const MAX_PMCARES_ROWS = 100;
const MAX_EM_RANGES = 12;
const MAX_PEERS = 200;
const MAX_POINTS = 4000;
const MAX_FIELDS = 30;
const MAX_TEXT = 400;
const MAX_NOTE = 800;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const SAFE_KEY = /^[A-Za-z0-9_]{1,40}$/;
const SAFE_RANGE = /^[A-Za-z0-9_-]{1,24}$/;

const isIsoDay = (v) => typeof v === "string" && ISO_DAY.test(v) && !Number.isNaN(Date.parse(v));

// Strip the two characters that turn a value into executable markup and cap the
// length. Applied to every string this function stores or returns.
const cleanText = (v, max = MAX_TEXT) => String(v).replace(/[<>]/g, "").slice(0, max);

const json = (statusCode, obj) => ({
  statusCode,
  headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  body: JSON.stringify(obj),
});

/* ── validation ──────────────────────────────────────────────────────────── */

// A weekly record is a date plus numeric columns. The date must be a real ISO
// day: the dashboard sorts and prints it, and a "date" that is not a date is
// the exact shape a DOM-XSS payload arrives in.
function cleanRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return null;
  if (!isIsoDay(rec.date)) return null;
  const keys = Object.keys(rec);
  if (keys.length > MAX_FIELDS) return null;
  const out = { date: rec.date };
  for (const k of keys) {
    if (k === "date" || !SAFE_KEY.test(k)) continue;
    const v = rec[k];
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "string") {
      out[k] = cleanText(v);
    } else if (v === null || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

function cleanRecords(list) {
  if (!Array.isArray(list)) return null;
  if (list.length > MAX_RECORDS) return null;
  return list.map(cleanRecord).filter(Boolean);
}

function cleanTextFields(obj, max) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const keys = Object.keys(obj);
  if (keys.length > MAX_FIELDS) return null;
  const out = {};
  for (const k of keys) {
    if (!SAFE_KEY.test(k)) continue;
    const v = obj[k];
    if (typeof v === "number") {
      if (Number.isFinite(v)) out[k] = v;
    } else if (typeof v === "string") {
      out[k] = cleanText(v, max);
    } else if (v === null || typeof v === "boolean") {
      out[k] = v;
    }
  }
  return out;
}

// forward: { date: ISO day, net_fwd: number }
function cleanForward(fwd) {
  if (fwd === undefined || fwd === null) return null;
  if (typeof fwd !== "object" || Array.isArray(fwd)) return null;
  if (!isIsoDay(fwd.date) || !Number.isFinite(fwd.net_fwd)) return null;
  return { date: fwd.date, net_fwd: fwd.net_fwd };
}

// em: { [range]: { peers: [ { code, points: [n], dates: [ISO] } ], fetchedAt } }
function cleanPeer(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  const points = Array.isArray(p.points) ? p.points.filter((n) => Number.isFinite(n)) : [];
  const dates = Array.isArray(p.dates) ? p.dates.filter(isIsoDay) : [];
  if (!points.length && !dates.length) return null;
  if (points.length > MAX_POINTS || dates.length > MAX_POINTS) return null;
  const out = { points, dates };
  if (typeof p.code === "string") out.code = cleanText(p.code, 16);
  if (typeof p.error === "string") out.error = cleanText(p.error, 200);
  return out;
}

function cleanEm(em) {
  if (em === undefined || em === null) return null;
  if (typeof em !== "object" || Array.isArray(em)) return null;
  const ranges = Object.keys(em);
  if (ranges.length > MAX_EM_RANGES) return null;
  const out = {};
  for (const range of ranges) {
    if (!SAFE_RANGE.test(range)) continue;
    const v = em[range];
    if (!v || typeof v !== "object" || Array.isArray(v)) return null;
    if (!Array.isArray(v.peers) || v.peers.length > MAX_PEERS) return null;
    const peers = v.peers.map(cleanPeer).filter(Boolean);
    if (!peers.length) return null;
    const fetchedAt = typeof v.fetchedAt === "string" && !Number.isNaN(Date.parse(v.fetchedAt))
      ? v.fetchedAt
      : new Date().toISOString();
    out[range] = { peers, fetchedAt };
  }
  return Object.keys(out).length ? out : null;
}

// pmcares: { rows: [ { fy, open, recap, int, disp, close, cal, calnote, relief, relnote, note } ], checkedAt }
function cleanPmcares(pm) {
  if (pm === undefined || pm === null) return null;
  if (typeof pm !== "object" || Array.isArray(pm)) return null;
  if (!Array.isArray(pm.rows) || pm.rows.length > MAX_PMCARES_ROWS) return null;
  const rows = pm.rows.map((r) => cleanTextFields(r, MAX_NOTE)).filter(Boolean);
  if (!rows.length) return null;
  const checkedAt = typeof pm.checkedAt === "string" && !Number.isNaN(Date.parse(pm.checkedAt))
    ? pm.checkedAt
    : new Date().toISOString();
  return { rows, checkedAt };
}

/* ── write guards ────────────────────────────────────────────────────────── */

// Requests carrying an Origin must come from this site. A same-origin POST is
// the only kind the dashboard makes, and an attacker's page cannot forge the
// Origin of another origin — so this closes the drive-by write path entirely.
function sameOrigin(event) {
  const headers = event.headers || {};
  const origin = headers.origin || headers.Origin;
  if (!origin) return true; // curl / script / CI — validated below regardless
  const host = headers.host || headers.Host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Optional shared secret: enforced only when the operator sets it, so a plain
// deploy keeps working while a locked-down one refuses everyone else. See note 2
// in the header for why the default is open, and SYNC_WRITE_TOKEN in
// .env.example for how to close it.
function tokenOk(event) {
  const expected = process.env.SYNC_WRITE_TOKEN || "";
  if (!expected) return true;
  const headers = event.headers || {};
  const presented = String(headers["x-sync-token"] || headers["X-Sync-Token"] || "");
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

exports.handler = async (event) => {
  const method = event.httpMethod || "GET";

  if (method === "POST") {
    const raw = event.body || "";
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
      return json(413, { error: `body larger than ${MAX_BODY_BYTES} bytes` });
    }
    if (!sameOrigin(event)) {
      return json(403, { error: "cross-origin writes are not accepted" });
    }
    if (!tokenOk(event)) {
      return json(401, { error: "write token required", code: "SYNC_TOKEN_REQUIRED" });
    }
  } else if (method !== "GET") {
    return json(405, { error: "method not allowed" });
  }

  let store;
  try {
    // In the Netlify function runtime getStore() auto-configures from the
    // environment; a named store is durable across deploys.
    store = getStore({ name: STORE_NAME });
  } catch (err) {
    // Blobs auto-configures only inside the Netlify runtime (deployed site, or
    // `netlify dev` logged into the linked site). Anywhere else getStore()
    // throws MissingBlobsEnvironmentError — report it as 503 with a code the
    // dashboard can turn into one honest log line instead of mystery noise.
    return json(503, {
      error: `blob store unavailable: ${err.message}`,
      code: "BLOB_UNAVAILABLE",
      hint: "Deploy via Netlify, or run netlify dev logged into the linked site.",
    });
  }

  if (method === "POST") {
    let body;
    try {
      body = JSON.parse(event.body || "{}");
    } catch {
      return json(400, { error: "invalid JSON body" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json(400, { error: "body must be an object" });
    }

    // ── validate before anything is stored ────────────────────────────────
    if (!Array.isArray(body.records)) {
      return json(400, { error: "body.records must be an array" });
    }
    if (body.records.length > MAX_RECORDS) {
      return json(400, { error: `body.records must hold at most ${MAX_RECORDS} entries` });
    }
    const records = cleanRecords(body.records);
    if (records === null || records.length !== body.records.length) {
      return json(400, {
        error: "every record needs a real date (YYYY-MM-DD) and at most " + MAX_FIELDS + " plain fields",
      });
    }

    const fwd = body.forward;
    if (fwd !== undefined && fwd !== null && !cleanForward(fwd)) {
      return json(400, { error: "body.forward must be an object with date (YYYY-MM-DD) and net_fwd (number)" });
    }
    const em = body.em;
    if (em !== undefined && em !== null && !cleanEm(em)) {
      return json(400, { error: "body.em must map a range to { peers: [{ code, points, dates }], fetchedAt }" });
    }
    const pm = body.pmcares;
    if (pm !== undefined && pm !== null && !cleanPmcares(pm)) {
      return json(400, { error: "body.pmcares must be { rows: [...], checkedAt }" });
    }

    // Writes that omit a key must not wipe a previously saved value — keep the
    // existing forward, em, and/or pmcares payloads. Values read back from the
    // store are re-cleaned, so anything saved before this check existed is
    // defused rather than carried forward.
    let forward = fwd === undefined ? null : cleanForward(fwd);
    let emSaved = em === undefined ? null : cleanEm(em);
    let pmSaved = pm === undefined ? null : cleanPmcares(pm);
    if (fwd === undefined || em === undefined || pm === undefined) {
      try {
        const prev = await store.get(KEY, { type: "json" });
        if (prev) {
          if (fwd === undefined && prev.forward) forward = cleanForward(prev.forward);
          if (em === undefined && prev.em) emSaved = cleanEm(prev.em);
          if (pm === undefined && prev.pmcares) pmSaved = cleanPmcares(prev.pmcares);
        }
      } catch (_) { /* no previous value */ }
    }
    const savedAt = new Date().toISOString();
    try {
      await store.setJSON(KEY, { savedAt, records, forward, em: emSaved, pmcares: pmSaved });
    } catch (err) {
      return json(502, { error: `write failed: ${err.message}` });
    }
    return json(200, { ok: true, savedAt });
  }

  // GET — same cleaning on the way out: a blob written before the write path
  // was validated must not reach the page as markup either.
  try {
    const saved = await store.get(KEY, { type: "json" });
    if (!saved || !Array.isArray(saved.records)) {
      return json(200, { records: null, savedAt: null, forward: null, em: null, pmcares: null });
    }
    const records = cleanRecords(saved.records);
    if (!records || !records.length) {
      return json(200, { records: null, savedAt: null, forward: null, em: null, pmcares: null });
    }
    return json(200, {
      records,
      savedAt: typeof saved.savedAt === "string" ? saved.savedAt : null,
      forward: cleanForward(saved.forward),
      em: cleanEm(saved.em),
      pmcares: cleanPmcares(saved.pmcares),
    });
  } catch (err) {
    // Blob missing/unavailable is not fatal — the dashboard falls back to the file.
    return json(200, { records: null, savedAt: null, forward: null, em: null, pmcares: null });
  }
};
