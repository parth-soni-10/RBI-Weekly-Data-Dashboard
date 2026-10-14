// scripts/make-rss.js — generate public/feed.xml (RSS 2.0) from rbi-data.json.
// Lets people subscribe to "new RBI week published" in any reader without
// visiting the dashboard. Runs in the weekly refresh (npm run fetch:data +
// the scheduled Worker), so every refresh ships a feed whose newest item
// matches the newest week.
//
// buildFeed() is pure: records in, feed out, and every date in the file derives
// from those records. lastBuildDate is the newest item's own pubDate rather than
// "now" for the same reason — a feed that changes only when its items change is
// what lets the scheduled refresh tell a real change from a rewrite and skip a
// commit that would ship nothing new.
const fs = require('fs');
const path = require('path');

const SITE = process.env.RSS_SITE_URL || 'https://rbiweeklydashboard.pages.dev/';
// CLI paths only: the scheduled Worker hands buildFeedFile() the rbi-data text it
// just built. `__dirname` does not exist in a Worker, so the guard keeps this
// module importable there (same trap as scripts/update-fwd-monthly.js).
const SRC = typeof __dirname === 'string' ? path.join(__dirname, '..', 'public', 'rbi-data.json') : '';
const OUT = typeof __dirname === 'string' ? path.join(__dirname, '..', 'public', 'feed.xml') : '';

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

// RBI publishes the WSS the Friday AFTER the as-on date; anchor the pubDate there.
function pubDateFor(date) {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 7, 6, 0, 0));
}

function item(rec, prev, site) {
  const dRes = prev && rec.total_usd != null && prev.total_usd != null ? rec.total_usd - prev.total_usd : null;
  const change = dRes == null ? '' :
    ` Reserves ${dRes >= 0 ? 'rose' : 'fell'} ${Math.abs(Math.round(dRes)).toLocaleString('en-IN')} USD mn week-on-week.`;
  const title = `RBI week as on ${rec.date}: reserves $${(rec.total_usd / 1000).toFixed(1)}B` +
    (rec.usd_inr != null ? ` · USD/INR ${rec.usd_inr.toFixed(2)}` : '');
  const desc = `Forex reserves ${rec.total_usd != null ? rec.total_usd.toLocaleString('en-IN') : '—'} USD mn` +
    (rec.gold_usd != null ? `, gold ${rec.gold_usd.toLocaleString('en-IN')} USD mn` : '') +
    (rec.usd_inr != null ? `, USD/INR ${rec.usd_inr.toFixed(2)}` : '') + '.' + change;
  return `    <item>
      <title>${esc(title)}</title>
      <link>${site}#tab=dashboard</link>
      <guid isPermaLink="false">rbi-week-${rec.date}</guid>
      <pubDate>${pubDateFor(rec.date).toUTCString()}</pubDate>
      <description>${esc(desc)}</description>
    </item>`;
}

/** records → { text, items, newest } (throws when there is nothing to publish). */
function buildFeed(records, { siteUrl = SITE } = {}) {
  const site = siteUrl || SITE;
  const recs = (records || []).filter(r => r && r.date).sort((a, b) => a.date.localeCompare(b.date));
  if (!recs.length) throw new Error('no records');
  const items = recs.slice(-26).reverse().map((r, i) => item(r, recs[recs.length - 1 - i - 1], site)).join('\n');
  const newest = recs[recs.length - 1];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>RBI Weekly Dashboard — new weeks</title>
    <link>${site}</link>
    <description>One item per RBI Weekly Statistical Supplement week: forex reserves, gold, and the rupee, from the dashboard's weekly data.</description>
    <language>en-in</language>
    <lastBuildDate>${pubDateFor(newest.date).toUTCString()}</lastBuildDate>
    <ttl>1440</ttl>
${items}
  </channel>
</rss>
`;
  return { text: xml, items: Math.min(26, recs.length), newest: newest.date };
}

/** rbi-data.json text → the feed, so the scheduled refresh feeds it the record
    set it just produced rather than re-reading a file it may not even have. */
function buildFeedFile({ priorText = null, siteUrl = null } = {}) {
  let data;
  try {
    data = JSON.parse(priorText);
  } catch (e) {
    return { text: null, detail: `skipped — rbi-data.json unreadable (${e.message})` };
  }
  if (!data || !Array.isArray(data.records) || !data.records.length) {
    return { text: null, detail: 'skipped — rbi-data.json has no records' };
  }
  const feed = buildFeed(data.records, { siteUrl });
  return { text: feed.text, detail: `${feed.items} items · newest ${feed.newest}` };
}

if (require.main === module) {
  try {
    const feed = buildFeedFile({ priorText: fs.readFileSync(SRC, 'utf8'), siteUrl: process.env.RSS_SITE_URL || null });
    if (!feed.text) throw new Error(feed.detail);
    fs.writeFileSync(OUT, feed.text);
    console.log(`✓ wrote public/feed.xml (${feed.detail})`);
  } catch (e) {
    // Fail open: a missing feed must never break a refresh.
    console.warn(`⚠ feed.xml skipped: ${e.message}`);
  }
}

module.exports = { buildFeed, buildFeedFile, pubDateFor };
