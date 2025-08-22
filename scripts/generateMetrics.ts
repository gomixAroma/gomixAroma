/**
 * generateMetrics.ts
 * - GitHub GraphQL から直近7日分の commit タイムスタンプを取り、
 * - WakaTime API から last_7_days の言語/エディタ時間を取得し、
 * - README の <!--START_SECTION:waka--> セクションを指定のテキスト形式で更新します。
 *
 * 必要な環境変数:
 *  - GH_TOKEN (repo 権限付き PAT)
 *  - WAKATIME_API_KEY
 *  - GH_USERNAME (オプション: github.repository_owner と同じなら不要)
 *
 * Node 18+ かつ yarn 環境を想定。ローカルで動かすなら `yarn` 後に:
 *   GH_TOKEN=ghp_xxx WAKATIME_API_KEY=waka_xxx GH_USERNAME=yourname yarn run generate
 */

import { exec as _exec } from 'child_process';
import fs from 'fs/promises';
import fetch from 'node-fetch';
import path from 'path';
import { promisify } from 'util';
const exec = promisify(_exec);

const GH_TOKEN = process.env.GH_TOKEN;
const WAKATIME_API_KEY = process.env.WAKATIME_API_KEY;
const GH_USERNAME = process.env.GH_USERNAME || process.env.GITHUB_ACTOR || process.env.USER || '';

if (!GH_TOKEN) {
  console.error('Missing GH_TOKEN env');
  process.exit(1);
}
if (!WAKATIME_API_KEY) {
  console.error('Missing WAKATIME_API_KEY env');
  process.exit(1);
}
if (!GH_USERNAME) {
  console.error('Missing GH_USERNAME env (or GITHUB_ACTOR). Set GH_USERNAME or GH_TOKEN must belong to the user.');
  process.exit(1);
}

/** Helpers */
const padRight = (s: string, n: number) => (s + ' '.repeat(Math.max(0, n - s.length))).slice(0, n);
const makeBar = (value: number, maxValue: number, width = 24) => {
  if (maxValue === 0) return '░'.repeat(width);
  const filled = Math.round((value / maxValue) * width);
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
};
const formatTimeMinutes = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h > 0) return `${h} hrs ${m} mins`;
  return `${m} mins`;
};
const weekdayName = (i: number) => ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][i];

// convert Date(UTC) -> JST by adding 9 hours, then use getUTCHours/getUTCDay to avoid timezone differences
const toJST = (d: Date) => new Date(d.getTime() + 9 * 60 * 60 * 1000);

type RepoContribution = {
  repository: { name: string; url: string };
  contributions: { nodes: { occurredAt: string; commitCount?: number }[] };
};

async function queryCommits(fromISO: string, toISO: string) {
  const query = `
query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from, to:$to){
      commitContributionsByRepository(maxRepositories: 100) {
        repository { name url }
        contributions(first: 100) {
          nodes { occurredAt commitCount }
        }
      }
    }
  }
}
`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${GH_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { login: GH_USERNAME, from: fromISO, to: toISO } }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('GitHub GraphQL error: ' + t);
  }
  const j = await res.json();
  return (j.data?.user?.contributionsCollection?.commitContributionsByRepository || []) as RepoContribution[];
}

async function fetchWaka() {
  // WakaTime last_7_days
  const url = `https://wakatime.com/api/v1/users/current/stats/last_7_days?api_key=${WAKATIME_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) {
    const t = await r.text();
    throw new Error('WakaTime API error: ' + t);
  }
  return (await r.json()) as any;
}

// そして元の ensureReadmeExists をこれに置き換える
async function ensureReadmeExists(readmePath: string) {
  // 1) 作業ツリーに README があるかチェック
  try {
    await fs.access(readmePath);
    console.log('DEBUG: README.md exists:', readmePath);
    return;
  } catch {
    console.log('DEBUG: README.md not found in working directory:', readmePath);
  }

  // 2) git の HEAD から復元を試みる（checkout されていない場合に有効）
  const tryGitRestore = async (ref: string) => {
    try {
      // git show <ref>:README.md
      const cmd = `git show ${ref}:README.md`;
      const { stdout } = await exec(cmd, { cwd: process.cwd(), maxBuffer: 10 * 1024 * 1024 });
      if (stdout && stdout.length > 0) {
        await fs.writeFile(readmePath, stdout, 'utf-8');
        console.log(`DEBUG: README.md restored from git ${ref}`);
        return true;
      }
    } catch (e: any) {
      // 無視。ログだけ残す。
      console.log(`DEBUG: git show ${ref}:README.md failed: ${e?.message?.slice?.(0, 200) ?? e}`);
    }
    return false;
  };

  // 試す順番：HEAD -> origin/<default-branch> -> origin/main
  if (await tryGitRestore('HEAD')) return;
  // try origin branch detection from environment (GitHub Actions sets GITHUB_REF or GITHUB_HEAD_REF)
  const branchFromEnv = (() => {
    const ref = process.env.GITHUB_REF || process.env.GITHUB_BASE_REF || process.env.GITHUB_HEAD_REF;
    if (!ref) return null;
    // ref may be like refs/heads/main
    const parts = String(ref).split('/');
    return parts.length ? parts[parts.length - 1] : null;
  })();
  if (branchFromEnv) {
    if (await tryGitRestore(`origin/${branchFromEnv}`)) return;
  }
  if (await tryGitRestore('origin/main')) return;
  if (await tryGitRestore('origin/master')) return;

  // 3) それでも無ければプレースホルダを作る（ただし警告ログを出す）
  console.warn('WARN: README.md could not be found in working dir nor in git history. Creating placeholder README.md');
  const placeholder = `# Hello\n\n<!-- METRICS:START -->\n<p><em>Loading metrics…</em></p>\n<!-- METRICS:END -->\n\n<!--START_SECTION:waka-->\n<p><em>Loading WakaTime…</em></p>\n<!--END_SECTION:waka-->\n`;
  await fs.writeFile(readmePath, placeholder, 'utf-8');
  console.log('DEBUG: placeholder README.md created at', readmePath);
}
async function main() {
  console.log('DEBUG: cwd=', process.cwd());
  const now = new Date();
  const toISO = now.toISOString();
  const fromISO = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const readmePath = path.join(process.cwd(), 'README.md');
  await ensureReadmeExists(readmePath);

  // 1) GitHub commits
  console.log('INFO: querying commits from', fromISO, 'to', toISO);
  const repos = await queryCommits(fromISO, toISO);

  const hourBuckets: Record<string, number> = { Morning: 0, Daytime: 0, Evening: 0, Night: 0 };
  const weekdayCounts: Record<string, number> = { Monday: 0, Tuesday: 0, Wednesday: 0, Thursday: 0, Friday: 0, Saturday: 0, Sunday: 0 };
  let totalCommits = 0;

  for (const r of repos) {
    for (const node of r.contributions.nodes) {
      const occurredAt = node.occurredAt;
      const cnt = node.commitCount || 1;
      const utcDate = new Date(occurredAt);
      const jst = toJST(utcDate);
      const hour = jst.getUTCHours(); // JST hour via UTC getter
      const dayIndex = jst.getUTCDay(); // 0=Sun

      // bucket
      let bucket = 'Night';
      if (hour >= 6 && hour < 12) bucket = 'Morning';
      else if (hour >= 12 && hour < 18) bucket = 'Daytime';
      else if (hour >= 18 && hour < 24) bucket = 'Evening';

      hourBuckets[bucket] = (hourBuckets[bucket] || 0) + cnt;
      const name = weekdayName(dayIndex);
      weekdayCounts[name] = (weekdayCounts[name] || 0) + cnt;
      totalCommits += cnt;
    }
  }

  // build hour block
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

  // weekday
  const wkOrder = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
  const wkMax = Math.max(...wkOrder.map((k) => weekdayCounts[k] || 0), 1);
  const wkLines = wkOrder.map((k) => {
    const cnt = weekdayCounts[k] || 0;
    const pct = totalCommits ? (cnt / totalCommits) * 100 : 0;
    const bar = makeBar(cnt, wkMax, 24);
    return `${padRight(k, 24)} ${padRight(String(cnt) + ' commits', 8)} ${bar}   ${pct.toFixed(2)} % `;
  });

  // most productive day
  let mostDay = 'N/A';
  let best = -1;
  for (const k of wkOrder) {
    if ((weekdayCounts[k] || 0) > best) {
      best = weekdayCounts[k] || 0;
      mostDay = k;
    }
  }

  // 2) WakaTime
  console.log('INFO: fetching WakaTime stats');
  const waka = await fetchWaka();
  const languages = (waka.data?.languages || []).slice(0, 5).map((l: any) => ({ name: l.name, seconds: l.total_seconds }));
  const editors = (waka.data?.editors || []).slice(0, 5).map((e: any) => ({ name: e.name, seconds: e.total_seconds }));
  const totalSeconds = languages.reduce((s: number, l: any) => s + l.seconds, 0) || 0;

  const langMax = Math.max(...languages.map((l: any) => l.seconds), 1);
  const langLines = languages.map((l: any) => {
    const mins = Math.round(l.seconds / 60);
    const pct = totalSeconds ? (l.seconds / totalSeconds) * 100 : 0;
    const bar = makeBar(l.seconds, langMax, 24);
    return `${padRight(l.name, 24)} ${padRight(formatTimeMinutes(mins), 18)} ${bar}   ${pct.toFixed(2)} % `;
  });

  const edTotal = editors.reduce((s: number, e: any) => s + e.seconds, 0);
  const edMax = Math.max(...editors.map((e: any) => e.seconds), 1);
  const editorLines = editors.map((e: any) => {
    const mins = Math.round(e.seconds / 60);
    const pct = edTotal ? (e.seconds / edTotal) * 100 : 0;
    const bar = makeBar(e.seconds, edMax, 24);
    return `${padRight(e.name, 24)} ${padRight(formatTimeMinutes(mins), 18)} ${bar}   ${pct.toFixed(2)} % `;
  });

  // build final text block
  const morningPct = totalCommits ? (hourBuckets['Morning'] / totalCommits) * 100 : 0;
  const daytimePct = totalCommits ? (hourBuckets['Daytime'] / totalCommits) * 100 : 0;
  const earlyOrNot = morningPct > daytimePct ? "I'm an Early 🐤" : "I'm Productive";

  const out: string[] = [];
  out.push(`**${earlyOrNot}**`);
  out.push('');
  out.push('```text');
  out.push(...hourLines);
  out.push('```');
  out.push(`📅 **I'm Most Productive on ${mostDay}**`);
  out.push('');
  out.push('```text');
  out.push(...wkLines);
  out.push('```');
  out.push('');
  out.push('📊 **This Week I Spent My Time On**');
  out.push('');
  out.push('```text');
  out.push('💬 Programming Languages: ');
  out.push(...langLines);
  out.push('');
  out.push('🔥 Editors: ');
  out.push(...editorLines);
  out.push('```');
  out.push('');
  out.push(` Last Updated on ${now.toUTCString()}`);

  const finalBlock = out.join('\n');

  // Replace in README
  const md = await fs.readFile(readmePath, 'utf-8');
  const replaced = md.replace(/<!--START_SECTION:waka-->[\s\S]*?<!--END_SECTION:waka-->/, `<!--START_SECTION:waka-->\n${finalBlock}\n<!--END_SECTION:waka-->`);
  if (replaced !== md) {
    await fs.writeFile(readmePath, replaced, 'utf-8');
    console.log('README updated');
  } else {
    console.log('No changes');
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
