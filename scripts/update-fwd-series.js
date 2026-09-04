#!/usr/bin/env node
/**
 * update-fwd-series.js — keep the RBI forward-book series current automatically.
 *
 * The RBI discloses its net forward position twice a year in the "Half-Yearly
 * Report on Management of Foreign Exchange Reserves" (I.3 Forward Outstanding:
 * "The net forward asset (receivable|payable) of the Reserve Bank stood at
 * USD x.xx billion as at the end of <Month> <Year>."). Those report pages are
 * server-rendered HTML on rbi.org.in (unlike the Bulletin), so a script can
 * read them. Monthly Bulletin disclosures (2025+) are still added by hand to
 * FWD_SERIES; this updater is the safety net that keeps the series anchored to
 * the official half-yearly reports without any manual step:
 *
 *   - finds the newest report via RBI's Half-Yearly publications index
 *   - if its period-end (Mar/Sep) is NEWER than the series' last point → appends
 *   - if a series point already exists for that period → upgrades its value +
 *     source to the official figure (drops any `approx` flag)
 *   - otherwise → "up to date", no change
 *
 * Idempotent, fails open (network/parse errors never break deploys), and never
 * removes data.
 *
 * Usage:
 *   node scripts/update-fwd-series.js
 *   npm run update:fwd
 */
const fs = require("fs");
const path = require("path");

const FN = process.env.FWD_FN || path.join(__dirname, "..", "netlify", "functions", "fetch-fx-intervention.js");
const INDEX_URL = "https://www.rbi.org.in/scripts/HalfYearlyPublications.aspx?head=Report%20on%20Foreign%20Exchange%20Reserves";
const REPORT_URL = id => `https://www.rbi.org.in/Scripts/PublicationsView.aspx?id=${id}`;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];

function monthNum(name){
  const n = MONTHS.findIndex(m => m.toLowerCase().startsWith(String(name).slice(0, 3).toLowerCase()));
  return n + 1; // 0 → 0 means "not found"
}
function fmtMonth(mo){ return String(mo).padStart(2, "0"); }
function pad(v){ return v.toFixed(2); }

async function getText(url){
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept": "text/html" } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.text();
}
function strip(html){
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&minus;/gi, "-")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Discovery ───────────────────────────────────────────────────────────
// The Half-Yearly publications index renders the latest report(s) with the
// title "Half Yearly Report on Management of Foreign Exchange Reserves:
// October 2025 - March 2026" linked to its PublicationsView id.
async function newestReport(){
  const html = await getText(INDEX_URL);
  const entries = [...html.matchAll(/PublicationsView\.aspx\?[Ii]d=(\d+)[^>]*>([\s\S]*?)<\/a>/g)]
    .map(m => {
      const title = strip(m[2]).replace(/\s+/g, " ").trim();
      const end = title.match(/[-–—]\s*([A-Za-z]+)\s+(\d{4})\s*$/);
      if (!end) return null;
      const mo = monthNum(end[1]);
      return mo ? { id: +m[1], title, date: `${end[2]}-${fmtMonth(mo)}` } : null;
    })
    .filter(Boolean)
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return entries[0] || null;
}

// ── Figure extraction (I.3 Forward Outstanding) ─────────────────────────
async function reportFigure(id){
  const t = strip(await getText(REPORT_URL(id)));
  const m = t.match(/net forward asset \((receivable|payable)\)[\s\S]{0,160}?USD\s*([\d.]+)\s*billion[\s\S]{0,80}?as at the end of ([A-Za-z]+) (\d{4})/i);
  if (!m) return null;
  const mo = monthNum(m[3]);
  if (!mo) return null;
  const payable = m[1].toLowerCase() === "payable";
  const value = Math.abs(parseFloat(m[2]));
  return {
    date: `${m[4]}-${fmtMonth(mo)}`,
    period: `${MONTHS[mo - 1]} ${m[4]}`,
    net_fwd: payable ? -value : value,
    raw: m[0].replace(/\s+/g, " ").slice(0, 200),
  };
}

// ── FWD_SERIES surgery (line-based, preserves everything else in the file) ──
function loadSeries(src){
  const entries = [];
  const re = /\{\s*date:\s*"(\d{4}-\d{2})"\s*,\s*net_fwd:\s*(-?[\d.]+)\s*((?:,\s*approx:\s*true)?)\s*,\s*source:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(src))) {
    entries.push({ date: m[1], net_fwd: parseFloat(m[2]), approx: /approx:\s*true/.test(m[3]), source: m[4], line: m[0] });
  }
  return entries;
}

function entryLine(date, netFwd, source, approx){
  const num = pad(netFwd);
  return `  { date: "${date}", net_fwd: ${approx ? num + ", approx: true" : num}, source: "${source}" }`;
}

function applyEdit(src, action){
  if (action.type === "none") return src;
  const marker = "const FWD_SERIES = [";
  const start = src.indexOf(marker);
  const arrEnd = src.indexOf("];", start + marker.length);
  if (start < 0 || arrEnd < 0) throw new Error("FWD_SERIES block not found in " + FN);
  let block = src.slice(start + marker.length, arrEnd);

  if (action.type === "append") {
    // insert after the last entry line (which ends with a comma)
    const lines = block.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].trim().startsWith("{") && lines[i].trim().endsWith(",")) {
        lines.splice(i + 1, 0, entryLine(action.date, action.netFwd, action.source, false));
        break;
      }
    }
    block = lines.join("\n");
  } else if (action.type === "upgrade") {
    // rewrite the exact line for that period, keeping the trailing comma if the
    // entry is not the last one in the array
    const lines = block.split("\n");
    const idx = lines.findIndex(l => l.includes('date: "' + action.date + '"'));
    if (idx < 0) throw new Error("no entry for " + action.date + " to upgrade");
    const hadComma = lines[idx].trimEnd().endsWith(",");
    lines[idx] = entryLine(action.date, action.netFwd, action.source, false) + (hadComma ? "," : "");
    block = lines.join("\n");
  }
  return src.slice(0, start + marker.length) + block + src.slice(arrEnd);
}

async function main(){
  const src = fs.readFileSync(FN, "utf8");
  const series = loadSeries(src);
  if (!series.length) throw new Error("could not parse FWD_SERIES from " + FN);
  series.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const byDate = new Map(series.map(e => [e.date, e]));

  const report = await newestReport();
  if (!report) { console.log("⚠ No half-yearly FX report found on the index — leaving FWD_SERIES unchanged."); return; }
  console.log(`Report index: newest = ${report.title.replace(/\s+/g, " ").slice(0, 90)} (id ${report.id}, period ${report.date})`);

  const fig = await reportFigure(report.id);
  if (!fig) { console.log(`⚠ Could not extract the I.3 figure from report ${report.id} — leaving FWD_SERIES unchanged.`); return; }
  console.log(`I.3 figure: ${fig.raw}`);

  const existing = byDate.get(fig.date);
  let action;
  if (!existing) {
    const last = series[series.length - 1];
    if (fig.date > last.date) {
      action = { type: "append", date: fig.date, netFwd: fig.net_fwd, source: `RBI Half-Yearly FX Reserves Report, half-year ending ${fig.period} (auto-appended)` };
    } else {
      action = { type: "none", reason: `series already has newer data (last ${last.date}) than the report's ${fig.date}` };
    }
  } else {
    const official = fig.net_fwd;
    const sameValue = Math.abs(existing.net_fwd - official) < 0.011 && !existing.approx;
    if (!sameValue) {
      action = { type: "upgrade", date: fig.date, netFwd: official, source: `RBI Half-Yearly FX Reserves Report, half-year ending ${fig.period} (official)` };
    } else {
      action = { type: "none", reason: `period ${fig.date} already matches the official figure` };
    }
  }

  if (action.type === "none") {
    console.log(`✓ Up to date — ${action.reason}.`);
    return;
  }
  const out = applyEdit(src, action);
  fs.writeFileSync(FN, out, "utf8");
  console.log(`✎ ${action.type === "append" ? "Appended" : "Upgraded"} ${fig.date} → ${fig.net_fwd >= 0 ? "+$" : "−$"}${Math.abs(fig.net_fwd).toFixed(2)}B (${action.source})`);
}

main().catch(e => {
  // fail open: never break a deploy because RBI was slow/blocked/unparseable
  console.warn(`⚠ update-fwd-series skipped (${e.message}) — FWD_SERIES unchanged.`);
});
