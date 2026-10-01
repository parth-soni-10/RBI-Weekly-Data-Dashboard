// scripts/make-rss.js — generate public/feed.xml (RSS 2.0) from rbi-data.json.
// Lets people subscribe to "new RBI week published" in any reader without
// visiting the dashboard. Runs in the deploy build after fetch:data, so every
// deploy ships a feed whose newest item matches the newest week.
const fs = require('fs');
const path = require('path');

const SITE = process.env.RSS_SITE_URL || 'https://rbiweeklydashboard.netlify.app/';
const SRC = path.join(__dirname, '..', 'public', 'rbi-data.json');
const OUT = path.join(__dirname, '..', 'public', 'feed.xml');

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

function item(rec, prev) {
  const dRes = prev && rec.total_usd != null && prev.total_usd != null ? rec.total_usd - prev.total_usd : null;
  const change = dRes == null ? '' :
    ` Reserves ${dRes >= 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(dRes)).toLocaleString('en-IN')} USD mn week-on-week.`;
  const title = `RBI week as on ${rec.date}: reserves $${(rec.total_usd / 1000).toFixed(1)}B` +
    (rec.usd_inr != null ? ` · USD/INR ${rec.usd_inr.toFixed(2)}` : '');
  const desc = `Forex reserves ${rec.total_usd != null ? rec.total_usd.toLocaleString('en-IN') : '—'} USD mn` +
    (rec.gold_usd != null ? `, gold ${rec.gold_usd.toLocaleString('en-IN')} USD mn` : '') +
    (rec.usd_inr != null ? `, USD/INR ${rec.usd_inr.toFixed(2)}` : '') + '.' + change;
  // RBI publishes the WSS the Friday AFTER the as-on date; anchor the pubDate there.
  const [y, m, d] = rec.date.split('-').map(Number);
  const pub = new Date(Date.UTC(y, m - 1, d + 7, 6, 0, 0));
  return `    <item>
      <title>${esc(title)}</title>
      <link>${SITE}#tab=dashboard</link>
      <guid isPermaLink="false">rbi-week-${rec.date}</guid>
      <pubDate>${pub.toUTCString()}</pubDate>
      <description>${esc(desc)}</description>
    </item>`;
}

try {
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const recs = (data.records || []).filter(r => r && r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!recs.length) throw new Error('no records');
  const items = recs.slice(-26).reverse().map((r, i) => item(r, recs[recs.length - 1 - i - 1])).join('\n');
  const lastBuild = new Date().toUTCString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RBI Weekly Dashboard — new weeks</title>
    <link>${SITE}</link>
    <description>One item per RBI Weekly Statistical Supplement week: forex reserves, gold, and the rupee, from the dashboard's weekly data.</description>
    <language>en-in</language>
    <lastBuildDate>${lastBuild}</lastBuildDate>
    <ttl>1440</ttl>
${items}
  </channel>
</rss>
`;
  fs.writeFileSync(OUT, xml);
  console.log(`✓ wrote public/feed.xml (${Math.min(26, recs.length)} items, newest ${recs[recs.length - 1].date})`);
} catch (e) {
  // Fail open: a missing feed must never break a deploy.
  console.warn(`⚠ feed.xml skipped: ${e.message}`);
}
