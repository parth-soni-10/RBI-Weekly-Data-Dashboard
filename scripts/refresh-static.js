#!/usr/bin/env node
/**
 * refresh-static.js — the weekly refresh, run locally, over the filesystem.
 *
 * The same plan the scheduled Worker runs (netlify/functions/refresh-data.js):
 * rbi-data.json + feed.xml, the forward-book series, external-debt.json, and the
 * sentiment + FII/DII histories. This is the replacement for the chain Netlify
 * used to run as its build command — one command, one implementation, so a local
 * run and a cron run cannot produce different data.
 *
 * Usage:
 *   node scripts/refresh-static.js              # regenerate, write what changed
 *   node scripts/refresh-static.js --check      # regenerate, write NOTHING, report
 *   node scripts/refresh-static.js --only=debt,sentiment
 *   node scripts/refresh-static.js --limit=2    # cap weeks fetched this run
 *   npm run refresh
 *
 * --check is the one to use before a manual deploy or a commit: it hits the live
 * sources exactly as a real run does, then prints what a run would have written
 * and the commit message it would have used, leaving the working tree untouched.
 *
 * Exit status: 0 when every step did something or had nothing to do (skips are
 * normal — a blocked source, an already-current series), 1 when a step failed
 * outright, 2 for a bad --only. The scheduled Worker ignores exit status; there
 * it is the log that reports.
 */
const fs = require("fs");
const path = require("path");
const { runRefresh, summarise, STEPS, DEFAULT_WEEK_LIMIT } = require("../netlify/functions/refresh-data.js");

const ROOT = path.join(__dirname, "..");

function arg(name) {
  const hit = process.argv.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return null;
  return hit.includes("=") ? hit.split("=").slice(1).join("=") : true;
}

async function main() {
  const check = !!arg("check");
  const limit = parseInt(arg("limit"), 10);
  const only = String(arg("only") || "").split(",").map(s => s.trim()).filter(Boolean);

  let steps = STEPS;
  if (only.length) {
    steps = STEPS.filter(s => only.includes(s.id));
    const unknown = only.filter(id => !STEPS.some(s => s.id === id));
    if (unknown.length) {
      console.error(`✗ unknown step(s): ${unknown.join(", ")}`);
      console.error(`  valid steps: ${STEPS.map(s => s.id).join(", ")}`);
      process.exit(2);
    }
  }

  const written = [];
  const io = {
    // A missing file is a successful read with no text (the repository has no
    // such file), never an error: the incremental steps distinguish the two.
    async read(p) {
      try {
        return { ok: true, text: fs.readFileSync(path.join(ROOT, p), "utf8") };
      } catch (e) {
        if (e.code === "ENOENT") return { ok: true, text: null };
        return { ok: false, error: e.message };
      }
    },
    async commit({ files }) {
      if (!check) {
        for (const f of files) {
          fs.writeFileSync(path.join(ROOT, f.path), f.content);
          written.push(f.path);
        }
      }
      return { ok: true, files: files.length, commit: null, check };
    },
  };

  const summary = await runRefresh({
    io,
    steps,
    options: {
      weekLimit: Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_WEEK_LIMIT,
      siteUrl: process.env.RSS_SITE_URL || null,
    },
    log: console.log,
  });

  console.log(summarise(summary));
  if (check) {
    console.log(`\n--check: nothing was written. ${summary.files.length ? "Would have written:" : "No file would change."}`);
    summary.files.forEach(p => console.log(`  ${p}`));
  } else if (written.length) {
    console.log(`\nWrote: ${written.join(", ")}`);
  }
  if (summary.message) {
    console.log(`\nCommit message a run would have used:\n${summary.message}`);
  }

  process.exitCode = summary.ok ? 0 : 1;
}

main().catch(e => {
  console.error("✗ refresh failed:", (e && e.message) || e);
  process.exit(1);
});
