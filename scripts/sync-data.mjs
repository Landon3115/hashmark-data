#!/usr/bin/env node
/**
 * Pulls a snapshot of real FBS data into src/data/generated/*.json.
 *
 *   CFBD_API_KEY=your-key node scripts/sync-data.mjs            (uses the cache in scripts/.cache)
 *   CFBD_API_KEY=your-key node scripts/sync-data.mjs --refresh  (fetches everything again)
 *   CFBD_API_KEY=your-key node scripts/sync-data.mjs --weekly   (fresh scores, polls and records; rosters and
 *                                                                coaches are re-fetched only when the cache is 4+ weeks old)
 *   SEASON=2026 sets the season (default 2026). OUT_DIR=some/folder writes the JSON there instead of the app.
 *
 * Sources
 *   CollegeFootballData.com (needs a free key; about 150 calls per full refresh, the free tier has 1,000 a month)
 *     teams, games and scores, polls, records, FPI ratings, head coaches, rosters, season player and team stats
 *   ESPN's unofficial public API (no key): class year for each player, which CFBD's roster lacks
 *
 * The key stays in this script's environment. It is never written to the app or to the output files.
 * CFBD's terms: do not present the data as official, and do not call their API from the app itself.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.env.OUT_DIR ? path.resolve(process.env.OUT_DIR) : path.join(ROOT, 'src/data/generated');
const CACHE = path.join(ROOT, 'scripts/.cache');
const SEASON = Number(process.env.SEASON ?? 2026);
const KEY = process.env.CFBD_API_KEY;
const WEEKLY = process.argv.includes('--weekly');
const REFRESH = process.argv.includes('--refresh') || WEEKLY;
/** In --weekly runs, these slow-changing caches are kept until they are this old. Saves ~140 CFBD calls a week. */
const SLOW = /^(roster-|espn-roster-|coaches-)/;
const SLOW_MAX_AGE_MS = 27 * 24 * 3600 * 1000;

if (!KEY) {
  console.error('Set CFBD_API_KEY first. A free key comes from https://collegefootballdata.com/key');
  process.exit(1);
}

const CFBD = 'https://api.collegefootballdata.com';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/college-football';

await mkdir(OUT, { recursive: true });
await mkdir(CACHE, { recursive: true });

// ---------- helpers ----------

let callsLeft = '?';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Returns the cached result when there is one. Otherwise runs `fetcher` and caches what it returns. */
async function cached(name, fetcher) {
  const file = path.join(CACHE, `${name.replace(/[^a-z0-9._-]+/gi, '_')}.json`);
  const keepSlow = WEEKLY && SLOW.test(name) && existsSync(file) && Date.now() - statSync(file).mtimeMs < SLOW_MAX_AGE_MS;
  if ((!REFRESH || keepSlow) && existsSync(file)) return JSON.parse(await readFile(file, 'utf8'));
  const value = await fetcher();
  await writeFile(file, JSON.stringify(value));
  return value;
}

async function cfbd(pathAndQuery, attempt = 1) {
  const res = await fetch(CFBD + pathAndQuery, { headers: { Authorization: `Bearer ${KEY}` } });
  callsLeft = res.headers.get('x-calllimit-remaining') ?? callsLeft;
  if (res.status === 401) throw new Error('CFBD rejected the key (401). Check CFBD_API_KEY.');
  if (res.status === 429) {
    // A 429 with calls remaining is a short burst limit: wait and try again. At zero it is the monthly cap.
    if (String(callsLeft) === '0') throw new Error('CFBD monthly call limit reached. It resets on the 1st.');
    if (attempt > 6) throw new Error(`CFBD kept rate limiting ${pathAndQuery}. Run the script again in a minute; finished calls are cached.`);
    const wait = Number(res.headers.get('retry-after')) || 4 * attempt;
    await sleep(wait * 1000);
    return cfbd(pathAndQuery, attempt + 1);
  }
  if (!res.ok) throw new Error(`CFBD ${res.status} for ${pathAndQuery}`);
  return res.json();
}

/** Run `fn` over `items` with a few requests in flight at a time. */
async function pool(items, size, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
        await sleep(60);
      }
    }),
  );
  return results;
}

const slugify = (s) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

const CURATED = JSON.parse(readFileSync(path.join(ROOT, 'scripts/team-slugs.json'), 'utf8'));
const NAME_OVERRIDES = { 'App State': 'Appalachian State' };
const CONFERENCES = {
  SEC: 'sec',
  'Big Ten': 'bigten',
  'Big 12': 'big12',
  ACC: 'acc',
  'Pac-12': 'pac12',
  'Sun Belt': 'sunbelt',
  'FBS Independents': 'ind',
  'American Athletic': 'american',
  'Conference USA': 'cusa',
  'Mid-American': 'mac',
  'Mountain West': 'mwc',
};

const ET = 'America/New_York';
const fmt = (opts) => new Intl.DateTimeFormat('en-US', { timeZone: ET, ...opts });
const dayFmt = fmt({ weekday: 'short', month: 'short', day: 'numeric' });
const timeFmt = fmt({ hour: 'numeric', minute: '2-digit' });
const shortDayFmt = fmt({ month: 'short', day: 'numeric' });

// ---------- pull ----------

console.log(`Season ${SEASON}. Pulling from CFBD (cached results are reused; pass --refresh to refetch).`);

const fbsTeams = await cached(`teams-${SEASON}`, () => cfbd(`/teams/fbs?year=${SEASON}`));
const regular = await cached(`games-${SEASON}`, () => cfbd(`/games?year=${SEASON}&classification=fbs`));
const post = await cached(`games-post-${SEASON}`, () =>
  cfbd(`/games?year=${SEASON}&classification=fbs&seasonType=postseason`),
);
const records = await cached(`records-${SEASON}`, () => cfbd(`/records?year=${SEASON}`));
const fpi = await cached(`fpi-${SEASON}`, () => cfbd(`/ratings/fpi?year=${SEASON}`));
const polls = await cached(`rankings-${SEASON}`, () => cfbd(`/rankings?year=${SEASON}`));
const coaches = await cached(`coaches-${SEASON}`, () => cfbd(`/coaches?minYear=2001&maxYear=${SEASON}`));
const playerStats = await cached(`player-stats-${SEASON}`, () => cfbd(`/stats/player/season?year=${SEASON}`));
const teamStats = await cached(`team-stats-${SEASON}`, () => cfbd(`/stats/season?year=${SEASON}`));
console.log(`Core data loaded. CFBD calls left this month: ${callsLeft}`);

// ---------- teams ----------

const teams = []; // { id, cfbd, name, nickname, abbr, conf, color, fbs }
const slugByCfbdId = new Map();
const slugBySchool = new Map();
const used = new Set();

function addTeam(cfbdId, school, extra) {
  if (slugByCfbdId.has(cfbdId)) return slugByCfbdId.get(cfbdId);
  let slug = CURATED[school] ?? slugify(school);
  while (used.has(slug)) slug += '-2';
  used.add(slug);
  slugByCfbdId.set(cfbdId, slug);
  slugBySchool.set(school, slug);
  teams.push({ id: slug, cfbd: cfbdId, name: NAME_OVERRIDES[school] ?? school, ...extra });
  return slug;
}

for (const t of fbsTeams) {
  addTeam(t.id, t.school, {
    nickname: t.mascot ?? '',
    abbr: (t.abbreviation ?? t.school.slice(0, 4)).toUpperCase(),
    conf: CONFERENCES[t.conference] ?? 'ind',
    color: t.color ?? '#444444',
    fbs: true,
  });
}

const allGames = [...regular, ...post.map((g) => ({ ...g, week: 100 + g.week }))];
const abbrOf = (name) => {
  const words = name.replace(/[()]/g, '').split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words.map((w) => w[0]).join('') : name.slice(0, 4)).toUpperCase().slice(0, 4);
};
for (const g of allGames) {
  for (const side of ['home', 'away']) {
    if (!slugByCfbdId.has(g[`${side}Id`])) {
      addTeam(g[`${side}Id`], g[`${side}Team`], {
        nickname: '',
        abbr: abbrOf(g[`${side}Team`]),
        conf: 'fcs',
        color: '#6B6B6B',
        fbs: false,
      });
    }
  }
}

// ---------- games ----------

const games = allGames
  .map((g) => {
    const when = new Date(g.startDate);
    const tbd = g.startTimeTBD;
    return {
      id: String(g.id),
      w: g.week,
      d: g.startDate,
      dl: dayFmt.format(when),
      ds: shortDayFmt.format(when),
      tl: tbd ? 'TBD' : `${timeFmt.format(when)} ET`,
      n: g.neutralSite ? 1 : 0,
      v: g.venue ?? '',
      c: g.conferenceGame ? 1 : 0,
      h: slugByCfbdId.get(g.homeId),
      a: slugByCfbdId.get(g.awayId),
      hp: g.homePoints ?? null,
      ap: g.awayPoints ?? null,
      done: g.completed ? 1 : 0,
      hl: g.homeLineScores ?? [],
      al: g.awayLineScores ?? [],
      note: g.notes ?? '',
    };
  })
  .sort((a, b) => a.d.localeCompare(b.d));

const completedWeeks = games.filter((g) => g.done && g.w < 100).map((g) => g.w);
const currentWeek = completedWeeks.length ? Math.max(...completedWeeks) : 1;

// ---------- records and ratings ----------

const recordsOut = {};
for (const r of records) {
  const slug = slugByCfbdId.get(r.teamId);
  if (!slug) continue;
  recordsOut[slug] = [r.total.wins, r.total.losses, r.conferenceGames.wins, r.conferenceGames.losses];
}

const ratingsOut = [];
for (const r of fpi) {
  const slug = slugBySchool.get(r.team);
  if (!slug) continue;
  ratingsOut.push({
    id: slug,
    fpi: r.fpi,
    fpiRank: r.resumeRanks?.fpi ?? null,
    sor: r.resumeRanks?.strengthOfRecord ?? null,
    sos: r.resumeRanks?.strengthOfSchedule ?? null,
  });
}

// ---------- polls (latest two weeks of each) ----------

const firstGame = new Date(Math.min(...games.map((g) => new Date(g.d).getTime())));
const firstSunday = new Date(firstGame);
firstSunday.setUTCHours(12, 0, 0, 0);
while (firstSunday.getUTCDay() !== 0) firstSunday.setUTCDate(firstSunday.getUTCDate() + 1);

/** A poll for CFBD week W comes out the Sunday after the games of week W-1. The CFP committee follows on Tuesday. */
function pollDate(week, poll) {
  const d = new Date(firstSunday);
  d.setUTCDate(d.getUTCDate() + 7 * (week - 1) + (poll === 'Playoff Committee Rankings' ? 2 : 0));
  return shortDayFmt.format(d);
}

const pollsOut = {};
for (const poll of ['Playoff Committee Rankings', 'AP Top 25', 'Coaches Poll']) {
  const weeks = polls
    .filter((w) => w.seasonType === 'regular' && w.polls.some((p) => p.poll === poll))
    .sort((a, b) => b.week - a.week)
    .slice(0, 2);
  pollsOut[poll] = weeks.map((w) => ({
    week: w.week,
    date: pollDate(w.week, poll),
    ranks: w.polls
      .find((p) => p.poll === poll)
      .ranks.map((r) => [slugByCfbdId.get(r.teamId) ?? slugBySchool.get(r.school) ?? slugify(r.school), r.points ?? null]),
  }));
}

// ---------- head coaches ----------

const coachesOut = {};
for (const c of coaches) {
  const now = c.seasons.find((s) => s.year === SEASON);
  if (!now) continue;
  const slug = slugByCfbdId.get(now.teamId);
  if (!slug) continue;
  coachesOut[slug] = {
    id: `${slugify(`${c.firstName} ${c.lastName}`)}-${c.id}`,
    name: `${c.firstName} ${c.lastName}`.trim(),
    hired: c.hireDate ? c.hireDate.slice(0, 4) : null,
    // [school slug or name, year, wins, losses, school name] for finished seasons. The current season comes from records.
    seasons: c.seasons
      .filter((s) => s.year < SEASON && s.games > 0)
      .map((s) => [slugByCfbdId.get(s.teamId) ?? s.school, s.year, s.wins, s.losses, s.school]),
  };
}

// ---------- rosters ----------

const GROUPS = {
  QB: 'Quarterbacks',
  RB: 'Running backs',
  FB: 'Running backs',
  HB: 'Running backs',
  WR: 'Wide receivers',
  TE: 'Tight ends',
  OL: 'Offensive line',
  OT: 'Offensive line',
  OG: 'Offensive line',
  C: 'Offensive line',
  DL: 'Defensive line',
  DT: 'Defensive line',
  DE: 'Defensive line',
  NT: 'Defensive line',
  EDGE: 'Edge',
  LB: 'Linebackers',
  ILB: 'Linebackers',
  OLB: 'Linebackers',
  DB: 'Defensive backs',
  CB: 'Defensive backs',
  S: 'Defensive backs',
  FS: 'Defensive backs',
  SS: 'Defensive backs',
  NB: 'Defensive backs',
  PK: 'Specialists',
  K: 'Specialists',
  P: 'Specialists',
  LS: 'Specialists',
  KR: 'Specialists',
  PR: 'Specialists',
};
const GROUP_ORDER = [
  'Quarterbacks',
  'Running backs',
  'Wide receivers',
  'Tight ends',
  'Offensive line',
  'Defensive line',
  'Edge',
  'Linebackers',
  'Defensive backs',
  'Specialists',
  'Other',
];
const normName = (s) =>
  s
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '')
    .replace(/[^a-z]/g, '');
const CLASS_ABBR = { Freshman: 'Fr', Sophomore: 'So', Junior: 'Jr', Senior: 'Sr' };

async function espnClasses(cfbdId) {
  return cached(`espn-roster-${cfbdId}`, async () => {
    const res = await fetch(`${ESPN}/teams/${cfbdId}/roster`);
    if (!res.ok) return {};
    const body = await res.json();
    const out = {};
    for (const group of body.athletes ?? []) {
      for (const a of group.items ?? []) {
        const label = a.experience?.displayValue;
        if (label && a.fullName) out[normName(a.fullName)] = CLASS_ABBR[label] ?? null;
      }
    }
    return out;
  });
}

const fbsOnly = teams.filter((t) => t.fbs);
let classHits = 0;
let playerCount = 0;
const rostersOut = {};
await pool(fbsOnly, 2, async (team, i) => {
  const school = fbsTeams.find((t) => t.id === team.cfbd).school;
  const roster = await cached(`roster-${SEASON}-${team.cfbd}`, () =>
    cfbd(`/roster?team=${encodeURIComponent(school)}&year=${SEASON}`),
  );
  const classes = await espnClasses(team.cfbd).catch(() => ({}));
  const rows = roster
    .map((p) => {
      const name = `${p.firstName} ${p.lastName}`.trim();
      const cls = classes[normName(name)] ?? null;
      if (cls) classHits++;
      const home = [p.homeCity, p.homeState].filter(Boolean).join(', ');
      const group = GROUPS[(p.position ?? '').toUpperCase()] ?? 'Other';
      return { group, row: [String(p.id), p.jersey ?? null, name, p.position ?? '', p.height ?? null, p.weight ?? null, home, cls, group] };
    })
    .sort(
      (a, b) =>
        GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || (a.row[1] ?? 999) - (b.row[1] ?? 999),
    );
  rostersOut[team.id] = rows.map((r) => r.row);
  playerCount += rows.length;
  if ((i + 1) % 20 === 0) console.log(`  rosters ${i + 1}/${fbsOnly.length} (CFBD calls left: ${callsLeft})`);
});

// ---------- season stats ----------
// Players: { [cfbd athlete id]: [teamSlug, name, position, { "passing.YDS": 3012, ... }] }, FBS players only.
// Teams:   { [teamSlug]: { games, firstDowns, netPassingYards, ..., <name>Opponent } }, FBS teams only.
const fbsSlugs = new Set(fbsOnly.map((t) => t.id));
// Raw counts only; rates (completion %, yards per carry, averages) are worked out in the app.
const KEEP_STATS = new Set([
  'passing.COMPLETIONS', 'passing.ATT', 'passing.YDS', 'passing.TD', 'passing.INT',
  'rushing.CAR', 'rushing.YDS', 'rushing.TD', 'rushing.LONG',
  'receiving.REC', 'receiving.YDS', 'receiving.TD', 'receiving.LONG',
  'defensive.TOT', 'defensive.SOLO', 'defensive.SACKS', 'defensive.TFL', 'defensive.PD', 'defensive.QB HUR', 'defensive.TD',
  'interceptions.INT', 'interceptions.YDS', 'interceptions.TD',
  'fumbles.FUM', 'fumbles.LOST', 'fumbles.REC',
  'kicking.FGM', 'kicking.FGA', 'kicking.XPM', 'kicking.XPA', 'kicking.PTS', 'kicking.LONG',
  'punting.NO', 'punting.YDS', 'punting.In 20', 'punting.TB', 'punting.LONG',
  'kickReturns.NO', 'kickReturns.YDS', 'kickReturns.TD',
  'puntReturns.NO', 'puntReturns.YDS', 'puntReturns.TD',
]);
const statsPlayers = {};
for (const s of playerStats) {
  const slug = slugBySchool.get(s.team);
  if (!slug || !fbsSlugs.has(slug)) continue;
  const key = `${s.category}.${s.statType}`;
  const value = Number(s.stat);
  if (!KEEP_STATS.has(key) || !Number.isFinite(value) || value === 0) continue;
  const row = (statsPlayers[s.playerId] ??= [slug, s.player, s.position ?? '', {}]);
  row[3][key] = value;
}
const statsTeams = {};
for (const s of teamStats) {
  const slug = slugBySchool.get(s.team);
  if (!slug || !fbsSlugs.has(slug)) continue;
  (statsTeams[slug] ??= {})[s.statName] = Number(s.statValue);
}

// ---------- write ----------

const write = (name, value) => writeFile(path.join(OUT, name), JSON.stringify(value));
await write('teams.json', teams);
await write('games.json', games);
await write('records.json', recordsOut);
await write('ratings.json', ratingsOut);
await write('polls.json', pollsOut);
await write('coaches.json', coachesOut);
await write('rosters.json', rostersOut);
await write('stats.json', { players: statsPlayers, teams: statsTeams });
await write('meta.json', {
  season: SEASON,
  currentWeek,
  generatedAt: new Date().toISOString(),
  sources: ['collegefootballdata.com', 'site.api.espn.com (class year only)'],
});

console.log(
  `Done. ${teams.length} teams (${fbsOnly.length} FBS), ${games.length} games, ${playerCount} players ` +
    `(${classHits} with a class year), ${Object.keys(coachesOut).length} head coaches, season stats for ` +
    `${Object.keys(statsPlayers).length} players and ${Object.keys(statsTeams).length} teams. Current week: ${currentWeek}. ` +
    `CFBD calls left this month: ${callsLeft}`,
);
