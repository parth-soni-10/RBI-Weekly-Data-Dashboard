// tests/deploy-staging.test.js — the staging step the deploy depends on.
//
// The Cloudflare Pages project builds this site with
//
//   node tools/deploy-pages.mjs --assets public --out .pages-dist
//
// and uploads whatever lands in `.pages-dist` (wrangler.toml's
// `pages_build_output_dir`). When tools/ was removed from the repository the
// build command had nothing left to run: the build failed on every push, the
// site silently kept serving an older commit, and nothing in the repo said so
// — the data pipeline looked broken (stale weeks, "reserves Excel download
// failed") when the real fault was one missing file.
//
// This test runs the script the way the build does and asserts the upload it
// produces: index.html present, the platform's directive files kept, a 404
// generated, and the ignore rules honoured.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const SCRIPT = path.join(ROOT, "tools", "deploy-pages.mjs");
const OUT = path.join(ROOT, ".deploy-staging-test");

test("the deploy staging script the build command runs is in the repository", () => {
  assert.ok(fs.existsSync(SCRIPT), "tools/deploy-pages.mjs exists (the Pages build command runs it)");
});

test("staging public/ produces the upload the Pages project expects", () => {
  fs.rmSync(OUT, { recursive: true, force: true });
  try {
    execFileSync(process.execPath, [SCRIPT, "--assets", "public", "--out", OUT], {
      cwd: ROOT,
      stdio: "pipe",
      encoding: "utf8",
    });

    // The page itself — an upload without it serves nothing.
    assert.ok(fs.existsSync(path.join(OUT, "index.html")), "index.html is staged");
    // Directives the platform consumes rather than serves: dropping them
    // silently loses CSP, the /data/*.json routes and the SPA fallback.
    for (const directive of ["_headers", "_redirects"]) {
      assert.ok(fs.existsSync(path.join(OUT, directive)), `${directive} is staged`);
    }
    // Without a 404.html, Pages answers 200 with index.html for every unknown
    // path — which makes a typo look like a real page.
    assert.ok(fs.existsSync(path.join(OUT, "404.html")), "a 404.html is generated");
    // The committed data is the upload — the build regenerates nothing.
    assert.ok(fs.existsSync(path.join(OUT, "rbi-data.json")), "rbi-data.json is staged");
    // Never published, whatever the repository says.
    for (const secret of [".env", ".dev.vars", ".assetsignore", "node_modules"]) {
      assert.ok(!fs.existsSync(path.join(OUT, secret)), `${secret} is not uploaded`);
    }
  } finally {
    fs.rmSync(OUT, { recursive: true, force: true });
  }
});
