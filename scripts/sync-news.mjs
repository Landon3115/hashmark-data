#!/usr/bin/env node
/**
 * Collects college football headlines from public RSS feeds into news.json.
 *
 *   OUT_DIR=site/v1 node scripts/sync-news.mjs     (reads OUT_DIR/teams.json for team tagging)
 *   node scripts/sync-news.mjs                      (writes src/data/generated/news.json)
 *
 * Each story keeps only what a feed reader shows: headline, a short summary, source, time, the publisher's
 * own preview image and the link. The full article always opens on the publisher's site.
 * Stories are tagged with teams by matching team names in the headline and summary.
 * No dependencies: feeds are parsed with a few regular expressions.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(ROOT, 'src/data/generated');
const MAX_AGE_DAYS = 10;
const MAX_ITEMS = 400;
const UA = 'Mozilla/5.0 (compatible; HashmarkNewsBot/1.0; +https://github.com/Landon3115/hashmark-data)';

/** College football feeds. A feed that fails is skipped; the rest still publish. */
const FEEDS = [
  { source: 'CBS Sports', url: 'https://www.cbssports.com/rss/headlines/college-football/' },
  { source: 'Yahoo Sports', url: 'https://sports.yahoo.com/college-football/rss.xml' },
  { source: 'NCAA.com', url: 'https://www.ncaa.com/news/football/fbs/rss.xml' },
  { source: 'SB Nation', url: 'https://www.sbnation.com/rss/college-football/index.xml' },
  { source: 'New York Post', url: 'https://nypost.com/college-football/feed/' },
  { source: 'Saturday Down South', url: 'https://www.saturdaydownsouth.com/feed/' },
  { source: 'Saturday Tradition', url: 'https://www.saturdaytradition.com/feed/' },
  { source: 'Saturday Blitz', url: 'https://www.saturdayblitz.com/feed/' },
  { source: 'College Football News', url: 'https://collegefootballnews.com/feed' },
  { source: 'On3', url: 'https://www.on3.com/feed/' },
];

// ---------- fetching ----------

async function get(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- parsing ----------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–', hellip: '…' };
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
const stripTags = (s) => decode(decode(s)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? m[1].trim() : '';
};
const attr = (block, tagName, attrName) => {
  const re = new RegExp(`<${tagName}\\b[^>]*\\b${attrName}=["']([^"']+)["'][^>]*>`, 'gi');
  return [...block.matchAll(re)].map((m) => decode(m[1]));
};

function firstImage(block) {
  const candidates = [
    ...attr(block, 'media:content', 'url'),
    ...attr(block, 'media:thumbnail', 'url'),
    ...[...block.matchAll(/<enclosure\b[^>]*>/gi)].filter((m) => /image/i.test(m[0])).flatMap((m) => attr(m[0], 'enclosure', 'url')),
    ...attr(decode(tag(block, 'description') + tag(block, 'content:encoded')), 'img', 'src'),
  ];
  return candidates.find((u) => /^https:\/\//.test(u) && !/\.(gif|svg)(\?|$)/i.test(u) && !/(pixel|tracking|1x1|feedburner)/i.test(u));
}

function parseFeed(xml, source) {
  const blocks = [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map((m) => m[0]);
  const atom = blocks.length === 0 ? [...xml.matchAll(/<entry\b[\s\S]*?<\/entry>/gi)].map((m) => m[0]) : [];
  return [...blocks, ...atom].map((b) => {
    const title = stripTags(tag(b, 'title'));
    const link = decode(tag(b, 'link') || attr(b, 'link', 'href')[0] || tag(b, 'guid')).trim();
    const when = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date');
    const summary = stripTags(tag(b, 'description') || tag(b, 'summary') || tag(b, 'content:encoded'));
    return { title, link, date: when ? new Date(decode(when)) : undefined, summary, image: firstImage(b), source };
  });
}

/** Preview image the publisher declares for link previews (og:image), for stories whose feed has none. */
async function ogImage(url) {
  try {
    const html = (await get(url, 8000)).slice(0, 200000);
    const m =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ??
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
    const img = m ? decode(m[1]) : undefined;
    return img && /^https:\/\//.test(img) ? img : undefined;
  } catch {
    return undefined;
  }
}

// ---------- team tagging ----------

const teamsFile = [path.join(OUT, 'teams.json'), path.join(ROOT, 'src/data/generated/teams.json')].find(existsSync);
const teams = JSON.parse(readFileSync(teamsFile, 'utf8')).filter((t) => t.fbs);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Names a headline might use. Longer names are matched first, so "Texas A&M" never also counts as "Texas".
const EXTRA = {
  'Miami': ['Miami Hurricanes'],
  'Miami (OH)': ['Miami (Ohio)', 'Miami of Ohio', 'Miami RedHawks'],
  'Ole Miss': ['Mississippi Rebels'],
  'UConn': ['Connecticut'],
  'UMass': ['Massachusetts'],
  'Southern Miss': ['Southern Mississippi'],
  'Hawai\'i': ['Hawaii'],
  'San José State': ['San Jose State'],
  'App State': ['Appalachian State'],
  'Appalachian State': ['App State'],
  'Louisiana': ['Ragin\' Cajuns', 'Louisiana-Lafayette'],
  'UL Monroe': ['Louisiana-Monroe'],
  'Pittsburgh': ['Pitt'],
  'Mississippi State': ['Miss State'],
};
const mascotCount = {};
for (const t of teams) if (t.nickname) mascotCount[t.nickname] = (mascotCount[t.nickname] ?? 0) + 1;
const patterns = [];
for (const t of teams) {
  const names = new Set([t.name, ...(EXTRA[t.name] ?? [])]);
  if (t.nickname) {
    names.add(`${t.name} ${t.nickname}`);
    if (mascotCount[t.nickname] === 1 && t.nickname.length > 4) names.add(t.nickname); // "Longhorns", not "Tigers"
  }
  for (const n of names) patterns.push({ id: t.id, name: n });
}
patterns.sort((a, b) => b.name.length - a.name.length);
const compiled = patterns.map((p) => ({ id: p.id, re: new RegExp(`(?<![\\w&])${esc(p.name)}(?![\\w&])`, 'g') }));

function teamsIn(text) {
  let s = text;
  const found = new Set();
  for (const { id, re } of compiled) {
    re.lastIndex = 0;
    if (re.test(s)) {
      found.add(id);
      re.lastIndex = 0;
      s = s.replace(re, (m) => ' '.repeat(m.length)); // mask so shorter names can't match inside it
    }
  }
  return [...found];
}

// ---------- run ----------

const cutoff = Date.now() - MAX_AGE_DAYS * 86400000;
/** Sportsbook promotions and other sports that football feeds sometimes carry. */
const NOISE = /promo code|bonus bets|sportsbook|betting promo|kalshi|polymarket|fanduel|draftkings|bet365|caesars|\bbasketball\b|\bhoops\b|\bNBA\b|\bWNBA\b|\bMLB\b|\bNHL\b|volleyball|\bsoccer\b|\bbaseball\b/i;
const all = [];
for (const feed of FEEDS) {
  try {
    const items = parseFeed(await get(feed.url), feed.source).filter((i) => i.title && /^https?:\/\//.test(i.link));
    const withImg = items.filter((i) => i.image).length;
    console.log(`  ${feed.source.padEnd(22)} ${String(items.length).padStart(3)} stories, ${withImg} with images`);
    all.push(...items);
  } catch (e) {
    console.log(`  ${feed.source.padEnd(22)} skipped (${e.message})`);
  }
}

const seen = new Set();
let items = all
  .filter((i) => !NOISE.test(i.title))
  .filter((i) => i.date && !Number.isNaN(i.date.getTime()) && i.date.getTime() >= cutoff && i.date.getTime() <= Date.now() + 3600000)
  .sort((a, b) => b.date - a.date)
  .filter((i) => {
    const key = i.link.split('?')[0].toLowerCase();
    const titleKey = i.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (seen.has(key) || seen.has(titleKey)) return false;
    seen.add(key);
    seen.add(titleKey);
    return true;
  })
  .slice(0, MAX_ITEMS);

// Fill in missing images from the article's own preview image, a few at a time.
const missing = items.filter((i) => !i.image).slice(0, 120);
for (let k = 0; k < missing.length; k += 6) {
  await Promise.all(missing.slice(k, k + 6).map(async (i) => (i.image = await ogImage(i.link))));
}

let n = 0;
const out = items.map((i) => {
  const summary = i.summary.length > 220 ? `${i.summary.slice(0, 217).replace(/\s+\S*$/, '')}…` : i.summary;
  return {
    id: `n${(n++).toString(36)}`,
    title: i.title,
    url: i.link,
    source: i.source,
    date: i.date.toISOString(),
    image: i.image ?? null,
    summary,
    teams: teamsIn(`${i.title} ${i.summary}`),
  };
});

await mkdir(OUT, { recursive: true });
await writeFile(path.join(OUT, 'news.json'), JSON.stringify({ generatedAt: new Date().toISOString(), items: out }));
const tagged = out.filter((i) => i.teams.length).length;
const imaged = out.filter((i) => i.image).length;
console.log(`News: ${out.length} stories from the last ${MAX_AGE_DAYS} days, ${imaged} with images, ${tagged} tagged with at least one team.`);
for (const i of out.slice(0, 25)) console.log(`    [${i.teams.join(',') || '-'}] ${i.image ? 'img' : '---'} ${i.source}: ${i.title}`);
if (process.env.NEWS_DUMP) {
  const { gzipSync } = await import('node:zlib');
  console.log(`NEWS_DUMP ${gzipSync(JSON.stringify({ generatedAt: new Date().toISOString(), items: out })).toString('base64')}`);
}
