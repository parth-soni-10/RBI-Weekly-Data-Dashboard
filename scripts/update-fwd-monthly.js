#!/usr/bin/env node
/**
 * update-fwd-monthly.js — auto-append the MONTHLY RBI Bulletin forward figures.
 *
 * The half-yearly updater (update-fwd-series.js) keeps the Mar/Sep anchors
 * current; the months between them were hand-added from press coverage of the
 * RBI Bulletin. This script closes that gap: the Bulletin's Current Statistics
 * section has a dedicated, SERVER-RENDERED table —
 *
 *   "4A. Maturity Breakdown (by Residual Maturity) of Outstanding Forwards of
 *    RBI (US $ Million)"   (BS_ViewBulletin.aspx?Id=<issue-specific>)
 *
 * — whose rows give long/short positions by maturity and a Total row with
 *   Long (+) / Short (-) / Net (1-2). Net (1-2) = long − short in US$ million
 * and equals the series the press quotes (and the half-yearly reports): e.g.
 * the May-2025 issue's table reads "As on March 31, 2025" with net −84,345mn,
 * matching the official half-yearly −84.345bn exactly.
 *
 * Each Bulletin issue (month M, released ~M+1 month) carries data "As on" the
 * second previous month-end, stated on the page — so the DATA month is read
 * from the page, never assumed.
 *
 * Usage:
 *   node scripts/update-fwd-monthly.js              # newest-issue sync (every deploy)
 *   node scripts/update-fwd-monthly.js --backfill   # walk ALL issues (one-off)
 *
 * Newest-issue sync:
 *   1. discovers the current Bulletin issue's 4A table on the Bulletin front page
 *   2. parses its as-on date + net total
 *   3. appends FWD_SERIES when the as-on month is newer than the series tail,
 *      upgrades the matching month to the official figure otherwise
 *
 * --backfill additionally walks every Bulletin issue from 2021-05 (first issue
 * carrying the Mar-2021 data the series starts at) through the newest one using
 * the site's own month selector, then inserts any months missing from the
 * series and upgrades approx/half-yearly-anchor months to the exact Bulletin
 * values. Idempotent; never removes data.
 *
 * Fails open: a slow/blocked/unparseable RBI site logs a warning and exits 0,
 * so a deploy is never broken by this step.
 */
const fs = require("fs");
const path = require("path");

const FN = process.env.FWD_FN || path.join(__dirname, "..", "netlify", "functions", "fetch-fx-intervention.js");
const FRONT_URL = "https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx";
const TABLE_URL = id => `https://www.rbi.org.in/Scripts/BS_ViewBulletin.aspx?Id=${id}`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const BACKFILL_FROM = { y: 2021, m: 5 }; // issue 2021-05 carries the Mar-2021 data
const THROTTLE_MS = 350; // be polite to rbi.org.in during the backfill walk

function monthNum(name) {
  const n = MONTHS.findIndex(m => m.toLowerCase().startsWith(String(name).slice(0, 3).toLowerCase()));
  return n + 1; // 0 = not found
}
function pad(v) { return v.toFixed(2); }
function fmt(mo) { return String(mo).padStart(2, "0"); }

async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}
// Tag-strip to a cell stream: HTML cells → text separated by " | " so tables
// survive as ordered lists of cell values.
function cells(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, "|")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&minus;/gi, "-")
    .split(/\|+/)
    .map(s => s.trim())
    .filter(Boolean);
}
const num = s => {
  const m = String(s).replace(/,/g, "").match(/^-?\d+(\.\d+)?$/);
  return m ? parseFloat(m[0]) : NaN;
};

// ── Table 4A parsing ────────────────────────────────────────────────────
// Returns { period:"2026-06", asOn:"June 30, 2026", netMn, longMn, shortMn }
// or null when the page is not the expected table.
function parseFwdTable(html) {
  // Row-based so stray page content can never leak into the numbers: find the
  // <tr> whose cells start with the "Total (1+2+3+4)" label and read only that
  // row's long / short / net cells. A nil cell renders as ".." (e.g. the
  // May-2026 issue has all-long zero) — treat a nil LONG as zero only when
  // short + net then balance. Net (1-2) = long − short is enforced, so a
  // mis-parse can never silently ship a wrong figure.
  const asOnM = html.match(/As on\s+([A-Za-z]+)\s+(\d{1,2})\s*,\s*(\d{4})/i);
  if (!asOnM) return null;
  const mo = monthNum(asOnM[1]);
  if (!mo) return null;
  const rows = html.split(/<tr[\s>]/i).map(part => {
    const tds = [...part.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(mm => cells(mm[1]).join(" "));
    return tds.filter(Boolean);
  });
  const total = rows.find(t => t.length >= 2 && /^Total/i.test(t[0]));
  if (!total) return null;
  const col = total.slice(1);
  const nums = [];
  const nilAt = [];
  col.forEach((c2, i) => {
    if (/^\.{1,3}$/.test(c2)) { nilAt.push(i); return; }
    const n = num(c2);
    if (!Number.isNaN(n)) nums.push(n);
  });
  let longMn = 0, shortMn = 0, netMn = 0;
  if (nums.length === 3) {
    [longMn, shortMn, netMn] = nums;
  } else if (nums.length === 2 && nilAt.length === 1 && nilAt[0] === 0 && nums[1] === -nums[0]) {
    [shortMn, netMn] = nums; // nil long ".." → zero
  } else {
    return null;
  }
  if (Math.abs(longMn - shortMn - netMn) > 1) return null;
  return { period: `${asOnM[3]}-${fmt(mo)}`, asOn: `${asOnM[1]} ${asOnM[2]}, ${asOnM[3]}`, netMn, longMn, shortMn };
}

// ── Discovery (newest issue) ────────────────────────────────────────────
// The Bulletin front page renders the current issue's table list server-side;
// the 4A table link is the anchor just before its title.
async function newestTableId() {
  const html = await getText(FRONT_URL);
  const i = html.indexOf("4A. Maturity Breakdown");
  if (i < 0) return null;
  const back = html.slice(0, i);
  const m = [...back.matchAll(/BS_ViewBulletin\.aspx\?Id=(\d+)/g)].pop();
  return m ? m[1] : null;
}

// ── Issue-month navigation (backfill) ───────────────────────────────────
// The month selector is an ASP.NET postback (GetYearMonth sets hdnYear /
// hdnMonth and clicks UsrFontCntr$btn). Replaying it returns the selected
// issue's table list; each issue has its own 4A page id.
async function issueTableId(year, month, formId) {
  const base = await getText(TABLE_URL(formId));
  const grab = name => {
    const m = base.match(new RegExp('name="' + name + '"[^>]*value="([^"]*)"')) || base.match(new RegExp('id="' + name + '"[^>]*value="([^"]*)"'));
    return m ? m[1] : null;
  };
  const body = new URLSearchParams();
  body.set("__EVENTTARGET", "");
  body.set("__EVENTARGUMENT", "");
  body.set("__VIEWSTATE", grab("__VIEWSTATE") || "");
  body.set("__EVENTVALIDATION", grab("__EVENTVALIDATION") || "");
  body.set("hdnYear", String(year));
  body.set("hdnMonth", String(month));
  body.set("ddlSubSection", "0");
  body.set("UsrFontCntr$btn", "");
  const res = await fetch(TABLE_URL(formId), {
    method: "POST",
    headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body.toString()) },
    body: body.toString(),
  });
  const html = await res.text();
  const i = html.indexOf("4A. Maturity");
  if (i < 0) return null;
  const pre = html.slice(Math.max(0, i - 900), i);
  const m = [...pre.matchAll(/BS_ViewBulletin\.aspx\?Id=(\d+)/g)].pop();
  return m ? m[1] : null;
}

// ── FWD_SERIES surgery (same conventions as update-fwd-series.js) ───────
function loadSeries(src) {
  const entries = [];
  const re = /\{\s*date:\s*"(\d{4}-\d{2})"\s*,\s*net_fwd:\s*(-?[\d.]+)\s*((?:,\s*approx:\s*true)?)\s*,\s*source:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    // capture the entry's full source line (indent, closing brace, trailing comma)
    const ls = src.lastIndexOf("\n", m.index) + 1;
    const le = src.indexOf("\n", m.index);
    const line = src.slice(ls, le < 0 ? src.length : le).trimEnd();
    entries.push({ date: m[1], net_fwd: parseFloat(m[2]), approx: /approx:\s*true/.test(m[3]), source: m[4], line });
  }
  return entries;
}
function entryLine(date, netFwd, source) {
  return `  { date: "${date}", net_fwd: ${pad(netFwd)}, source: "${source}" }`;
}
const SRC_PREFIX = (date, asOn) => `RBI Bulletin Table 4A (Maturity Breakdown of Outstanding Forwards), as on ${asOn}`;

// Replace the FWD_SERIES array with the given ordered rows. Rows that keep an
// untouched original entry reuse its exact text (minimal diffs); changed rows
// are regenerated.
function rewriteSeries(src, rows, changed) {
  const marker = "const FWD_SERIES = [";
  const start = src.indexOf(marker);
  const arrEnd = src.indexOf("];", start + marker.length);
  if (start < 0 || arrEnd < 0) throw new Error("FWD_SERIES block not found in " + FN);
  const changedMap = new Map(changed.map(c => [c.date, c]));
  const lines = rows.map((r, i) => {
    const last = i === rows.length - 1;
    let base;
    if (changedMap.has(r.date)) {
      const c = changedMap.get(r.date);
      base = entryLine(r.date, c.netFwd, c.source);
    } else {
      // untouched entry: keep its original line text exactly
      base = r.line.endsWith(",") ? r.line.slice(0, -1) : r.line;
    }
    return base + (last ? "" : ",");
  });
  const block = "\n" + lines.join("\n") + (lines.length ? "\n" : "");
  return src.slice(0, start + marker.length) + block + src.slice(arrEnd);
}

// ── Sync one official row into the series ───────────────────────────────
// Returns { action, rows, changed } where `rows` is the (new) ordered series
// with the row applied and `changed` lists modified/inserted entries.
function applyOfficial(entries, official) {
  const rows = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const idx = rows.findIndex(e => e.date === official.date);
  const changed = [];
  if (idx < 0) {
    const insertAt = rows.findIndex(e => e.date > official.date);
    const entry = { date: official.date, net_fwd: official.netFwd, source: official.source, approx: false };
    if (insertAt < 0) rows.push(entry);
    else rows.splice(insertAt, 0, entry);
    changed.push({ date: official.date, netFwd: official.netFwd, source: official.source });
    return { rows, changed, summary: `inserted ${official.date}` };
  }
  const e = rows[idx];
  const sameValue = !e.approx && Math.abs(e.net_fwd - official.netFwd) < 0.011;
  if (sameValue) return { rows, changed: [], summary: `period ${official.date} already matches the official figure` };
  // The half-yearly report figures at Mar/Sep are authoritative at those dates:
  // RBI later revises the Bulletin table (e.g. Sep-2021 reads +49.61bn in the
  // Nov-2021 Bulletin but the report — and Dec-2021's table — use the revised
  // +49.11bn), so a verified report anchor must never be overwritten by the
  // Bulletin table when the two disagree.
  if (!e.approx && /Half-Yearly FX Reserves Report|long-era anchor/.test(e.source)) {
    return { rows, changed: [], summary: `period ${official.date} kept (half-yearly report anchor ${e.net_fwd} vs table ${official.netFwd})` };
  }
  changed.push({ date: official.date, netFwd: official.netFwd, source: official.source });
  return { rows, changed, summary: `upgraded ${official.date} ${e.net_fwd} → ${official.netFwd}` };
}

// ── Newest-issue discovery + parse (no file writes) ─────────────────────
// Shared with netlify/functions/fetch-fwd-latest.js so the Reload button can
// live-check the newest official figure without running the CLI. Returns
//   { id, date, asOn, netMn, longMn, shortMn, netFwd, source }  — newest figure
//   { error: "no-table" | "unparseable", id? }                  — nothing usable
async function fetchLatestOfficial() {
  const id = await newestTableId();
  if (!id) return { error: "no-table" };
  const fig = parseFwdTable(await getText(TABLE_URL(id)));
  if (!fig) return { error: "unparseable", id };
  return {
    id,
    date: fig.period,
    asOn: fig.asOn,
    netMn: fig.netMn,
    longMn: fig.longMn,
    shortMn: fig.shortMn,
    netFwd: +(fig.netMn / 1000).toFixed(3),
    source: SRC_PREFIX(fig.period, fig.asOn),
  };
}

async function main() {
  const backfill = process.argv.includes("--backfill");
  const src = fs.readFileSync(FN, "utf8");
  const entries = loadSeries(src);
  if (!entries.length) throw new Error("could not parse FWD_SERIES from " + FN);

  if (!backfill) {
    const latest = await fetchLatestOfficial();
    if (latest.error === "no-table") { console.log("⚠ No 4A (Outstanding Forwards of RBI) table found on the Bulletin front page — leaving FWD_SERIES unchanged."); return; }
    if (latest.error === "unparseable") { console.log(`⚠ Could not parse Table 4A from page ${latest.id} — leaving FWD_SERIES unchanged.`); return; }
    console.log(`Bulletin front page: newest 4A forward table id ${latest.id}`);
    console.log(`Table 4A: ${latest.asOn} — net ${latest.netMn >= 0 ? "+" : "−"}$${Math.abs(latest.netMn).toLocaleString("en-US")}mn (long ${latest.longMn.toLocaleString("en-US")}, short ${latest.shortMn.toLocaleString("en-US")}) → period ${latest.date}`);
    const official = { date: latest.date, netFwd: latest.netFwd, source: latest.source };
    const res = applyOfficial(entries, official);
    if (!res.changed.length) { console.log(`✓ Up to date — ${res.summary}.`); return; }
    const marker = res.summary.startsWith("inserted") ? " (auto-appended)" : " (official)";
    res.changed[0].source += marker;
    const out = rewriteSeries(src, res.rows, res.changed);
    fs.writeFileSync(FN, out, "utf8");
    console.log(`✎ ${res.summary} → ${official.netFwd >= 0 ? "+$" : "−$"}${Math.abs(official.netFwd).toFixed(2)}B`);
    return;
  }

  // ── Backfill: walk every issue 2021-05 → newest ──
  const formId = (await newestTableId()) || "24382";
  const now = new Date();
  const rows = new Map(); // data-period → official row (from the newest available issue for that period)
  let checked = 0, got = 0, skipped = [];
  for (let y = BACKFILL_FROM.y, m = BACKFILL_FROM.m; y < now.getUTCFullYear() || (y === now.getUTCFullYear() && m <= now.getUTCMonth()); ) {
    const issueId = await issueTableId(y, m, formId);
    if (issueId) {
      const fig = parseFwdTable(await getText(TABLE_URL(issueId)));
      if (fig) {
        rows.set(fig.period, { date: fig.period, netFwd: +(fig.netMn / 1000).toFixed(3), source: `${SRC_PREFIX(fig.period, fig.asOn)} (official)` });
        got++;
      } else skipped.push(`${y}-${fmt(m)} (table unparseable)`);
    } else {
      skipped.push(`${y}-${fmt(m)} (no 4A table)`);
    }
    checked++;
    m++;
    if (m > 12) { m = 1; y++; }
    await new Promise(r => setTimeout(r, THROTTLE_MS));
  }
  console.log(`Backfill walk: ${checked} issues checked, ${got} official monthly figures collected${skipped.length ? ", skipped: " + skipped.slice(0, 6).join("; ") + (skipped.length > 6 ? "…" : "") : ""}`);

  // Apply in ascending data-period order: insert missing months, upgrade others.
  let rowsArr = entries.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const changed = [];
  let inserted = 0, upgraded = 0;
  for (const period of [...rows.keys()].sort()) {
    const official = rows.get(period);
    const res = applyOfficial(rowsArr, official);
    rowsArr = res.rows;
    if (res.changed.length) {
      changed.push(...res.changed);
      if (res.summary.startsWith("inserted")) inserted++;
      else upgraded++;
    }
  }
  if (!changed.length) { console.log("✓ Backfill complete — every official monthly figure already matches the series."); return; }
  const out = rewriteSeries(src, rowsArr, changed);
  fs.writeFileSync(FN, out, "utf8");
  console.log(`✎ Backfill wrote ${inserted} inserted + ${upgraded} upgraded monthly points (series now ${rowsArr.length} entries).`);
}

if (require.main === module) {
  main().catch(e => {
    console.warn(`⚠ update-fwd-monthly skipped (${e.message}) — FWD_SERIES unchanged.`);
  });
}

module.exports = { fetchLatestOfficial };
