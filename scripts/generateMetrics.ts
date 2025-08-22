// scripts/generateMetrics.ts
import fs from 'fs/promises';
import fetch from 'node-fetch';
import path from 'path';

type ContributionsNode = { occurredAt: string; commitCount: number };

const GH_TOKEN = process.env.GH_TOKEN!;
const WAKATIME_API_KEY = process.env.WAKATIME_API_KEY!;
const USER = process.env.GH_USERNAME || process.env.GITHUB_ACTOR || process.env.USER;

if (!GH_TOKEN) {
  console.error('Missing GH_TOKEN env');
  process.exit(1);
}
if (!WAKATIME_API_KEY) {
  console.error('Missing WAKATIME_API_KEY env');
  process.exit(1);
}
if (!USER) {
  console.error('Missing GH_USERNAME or GITHUB_ACTOR env');
  process.exit(1);
}

/** helpers */
const padRight = (s: string, n: number) => (s + ' '.repeat(Math.max(0, n - s.length))).slice(0, n);
const hoursToBucket = (hour: number) => {
  // Morning 06-11, Daytime 12-17, Evening 18-23, Night 0-5
  if (hour >= 6 && hour < 12) return 'Morning';
  if (hour >= 12 && hour < 18) return 'Daytime';
  if (hour >= 18 && hour < 24) return 'Evening';
  return 'Night';
};
const weekdayName = (i: number) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i];

function makeBar(value: number, maxValue: number, width = 24) {
  if (maxValue === 0) return '░'.repeat(width);
  const filled = Math.round((value / maxValue) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function formatTimeMinutes(mins: number) {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h > 0) return `${h} hrs ${m} mins`;
  return `${m} mins`;
}

async function queryCommits(fromISO: string, toISO: string) {
  const q = `
query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from, to:$to){
      commitContributionsByRepository(maxRepositories: 100) {
        repository { name url }
        contributions(first: 100) {
          nodes {
            occurredAt
            commitCount
          }
        }
      }
    }
  }
}
`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: q, variables: { login: USER, from: fromISO, to: toISO } }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('GitHub GraphQL error: ' + t);
  }
  const j = await res.json();
  return j.data.user.contributionsCollection.commitContributionsByRepository as any[];
}

async function fetchWaka() {
  // WakaTime stats for last_7_days
  const url = `https://wakatime.com/api/v1/users/current/stats/last_7_days?api_key=${WAKATIME_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error('WakaTime API error: ' + t);
  }
  return (await r.json()) as any;
}

async function main() {
  const now = new Date();
  const to = now.toISOString();
  const from = new Date(now.getTime() - 7 * 24 * 3600 * 1000).toISOString();

  // 1) GitHub commits
  const repos = await queryCommits(from, to);

  const hourBuckets: Record<string, number> = { Morning: 0, Daytime: 0, Evening: 0, Night: 0 };
  const weekdayCounts: Record<string, number> = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0, Sunday: 0 };
  let totalCommits = 0;

  for (const r of repos) {
    for (const node of r.contributions.nodes as ContributionsNode[]) {
      const dt = new Date(node.occurredAt);
      const cnt = node.commitCount || 1;
      const hBucket = hoursToBucket(dt.getUTCHours()); // GitHub times are UTC; we'll convert to local timezone offset
      // Convert occurredAt UTC -> local hour
      // safer: use local time string
      const local = new Date(node.occurredAt);
      const hourLocal = local.getHours();
      const bucketLocal = hoursToBucket(hourLocal);
      hourBuckets[bucketLocal] = (hourBuckets[bucketLocal] || 0) + cnt;

      const w = local.getDay(); // 0=Sun
      const name = weekdayName(w);
      weekdayCounts[name] = (weekdayCounts[name] || 0) + cnt;
      totalCommits += cnt;
    }
  }

  // If totalCommits == 0, the user may have no commits in the range.
  // Build time-of-day block
  const hourEntries = [
    { label: '🌞 Morning', key: 'Morning' },
    { label: '🌆 Daytime', key: 'Daytime' },
    { label: '🌃 Evening', key: 'Evening' },
    { label: '🌙 Night', key: 'Night' },
  ];
  const maxHour = Math.max(...Object.values(hourBuckets), 1);
  const hourLines = hourEntries.map((e) => {
    const cnt = hourBuckets[e.key] || 0;
    const pct = totalCommits ? (cnt / totalCommits) * 100 : 0;
    const bar = makeBar(cnt, maxHour, 24);
    return `${e.label} ${padRight(String(cnt) + ' commits', 18)} ${bar}   ${pct.toFixed(2)} % `;
  });

  // Weekday lines (Monday .. Sunday)
  const wkOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const wkMax = Math.max(...wkOrder.map((k) => weekdayCounts[k] || 0), 1);
  const wkLines = wkOrder.map((k) => {
    const cnt = weekdayCounts[k] || 0;
    const pct = totalCommits ? (cnt / totalCommits) * 100 : 0;
    const bar = makeBar(cnt, wkMax, 24);
    return `${padRight(k, 24)} ${padRight(String(cnt) + ' commits', 8)} ${bar}   ${pct.toFixed(2)} % `;
  });

  // find most productive day
  let mostDay = 'N/A';
  let best = -1;
  for (const k of wkOrder) {
    if ((weekdayCounts[k] || 0) > best) {
      best = weekdayCounts[k] || 0;
      mostDay = k;
    }
  }

  // 2) WakaTime
  const waka = await fetchWaka();
  // waka.languages, waka.editors entries include name, total_seconds
  const languages = (waka.data.languages || []).slice(0, 5).map((l: any) => ({
    name: l.name,
    seconds: l.total_seconds,
  }));
  const editors = (waka.data.editors || []).slice(0, 5).map((e: any) => ({
    name: e.name,
    seconds: e.total_seconds,
  }));
  const totalSeconds = languages.reduce((s: number, l: any) => s + l.seconds, 0) || 0;
  // Build languages block lines
  const langMax = Math.max(...languages.map((l: any) => l.seconds), 1);
  const langLines = languages.map((l: any) => {
    const mins = Math.round(l.seconds / 60);
    const pct = totalSeconds ? (l.seconds / totalSeconds) * 100 : 0;
    const bar = makeBar(l.seconds, langMax, 24);
    return `${padRight(l.name, 24)} ${padRight(formatTimeMinutes(mins), 18)} ${bar}   ${pct.toFixed(2)} % `;
  });

  // editors: show top editor time
  const edTotal = editors.reduce((s: number, e: any) => s + e.seconds, 0);
  const edMax = Math.max(...editors.map((e: any) => e.seconds), 1);
  const editorLines = editors.map((e: any) => {
    const mins = Math.round(e.seconds / 60);
    const pct = edTotal ? (e.seconds / edTotal) * 100 : 0;
    const bar = makeBar(e.seconds, edMax, 24);
    return `${padRight(e.name, 24)} ${padRight(formatTimeMinutes(mins), 18)} ${bar}   ${pct.toFixed(2)} % `;
  });

  // Build final text block matching your format
  const outLines: string[] = [];
  // determine "I'm an Early" by comparing Morning vs Night etc (simple heuristic)
  const morningPct = totalCommits ? (hourBuckets['Morning'] / totalCommits) * 100 : 0;
  const daytimePct = totalCommits ? (hourBuckets['Daytime'] / totalCommits) * 100 : 0;
  const earlyOrNot = morningPct > daytimePct ? "I'm an Early 🐤" : "I'm Productive";
  outLines.push(`**${earlyOrNot}**`);
  outLines.push('');
  outLines.push('```text');
  outLines.push(...hourLines);
  outLines.push('```');
  outLines.push(`📅 **I'm Most Productive on ${mostDay}**`);
  outLines.push('');
  outLines.push('```text');
  outLines.push(...wkLines);
  outLines.push('```');
  outLines.push('');
  outLines.push('📊 **This Week I Spent My Time On**');
  outLines.push('');
  outLines.push('```text');
  outLines.push('💬 Programming Languages: ');
  outLines.push(...langLines);
  outLines.push('');
  outLines.push('🔥 Editors: ');
  outLines.push(...editorLines);
  outLines.push('```');
  outLines.push('');
  outLines.push(` Last Updated on ${now.toUTCString()}`);
  // Wrap in HTML-safe block if needed (we'll just replace the section)
  const finalBlock = outLines.join('\n');

  // Replace in README
  const readmePath = path.join(process.cwd(), 'README.md');
  let md = await fs.readFile(readmePath, 'utf-8');
  const replaced = md.replace(/<!--START_SECTION:waka-->[\s\S]*?<!--END_SECTION:waka-->/, `<!--START_SECTION:waka-->\n${finalBlock}\n<!--END_SECTION:waka-->`);
  if (replaced !== md) {
    await fs.writeFile(readmePath, replaced, 'utf-8');
    console.log('README updated');
  } else {
    console.log('No changes');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
