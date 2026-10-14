// Syntax-check every JS file in the repo (functions, utils, scripts).
// Cross-platform: works on Windows cmd, PowerShell, bash, and CI.
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

// `functions/` is the Pages Function Pages compiles at deploy time: a syntax
// error in it is a failed deploy rather than a failing test, so it is checked
// here with everything else.
const dirs = ['functions', 'netlify/functions', 'netlify/functions/_utils', 'scripts'];
const files = [];
for (const dir of dirs) {
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.js')) files.push(path.join(dir, name));
  }
}
for (const file of files) {
  cp.execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`\u2713 ${files.length} files OK`);
