#!/usr/bin/env node
/**
 * GitHub census: find public repositories that still call the Google Custom
 * Search JSON API (shutting down 2027-01-01), enrich them with activity data,
 * and write an outreach shortlist.
 *
 * Requires the GitHub CLI, signed in (`gh auth status`). Code search is
 * rate-limited (~10 requests/min), so the script paces itself.
 *
 * Usage:  node scripts/census.mjs
 * Output: census/results.csv, census/results.json, census/raw/*.json
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

const QUERIES = [
  { tag: 'rest-url', q: '"googleapis.com/customsearch/v1"' },
  { tag: 'rest-url-new-host', q: '"customsearch.googleapis.com"' },
  { tag: 'python-client', q: 'build("customsearch"' },
  { tag: 'python-client', q: "build('customsearch'" },
  { tag: 'node-googleapis', q: 'google.customsearch(' },
  { tag: 'env-var', q: 'GOOGLE_CSE_ID' },
  { tag: 'langchain-wrapper', q: 'GoogleSearchAPIWrapper' },
];
const PER_QUERY = 100; // gh search code max per call
const SLEEP_MS = 7000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

try {
  gh(['auth', 'status']);
} catch {
  console.error('GitHub CLI is not signed in. Run `gh auth login` first.');
  process.exit(1);
}

mkdirSync('census/raw', { recursive: true });
const repos = new Map(); // nameWithOwner -> { tags:Set, paths:Set }

for (const [i, { tag, q }] of QUERIES.entries()) {
  process.stdout.write(`[${i + 1}/${QUERIES.length}] searching ${q} … `);
  try {
    const out = gh(['search', 'code', q, '--limit', String(PER_QUERY), '--json', 'path,repository']);
    const hits = JSON.parse(out);
    writeFileSync(`census/raw/${i}-${tag}.json`, JSON.stringify(hits, null, 2));
    for (const h of hits) {
      const name = h.repository?.nameWithOwner;
      if (!name) continue;
      if (!repos.has(name)) repos.set(name, { tags: new Set(), paths: new Set() });
      repos.get(name).tags.add(tag);
      repos.get(name).paths.add(h.path);
    }
    console.log(`${hits.length} hits`);
  } catch (e) {
    console.log(`failed (${String(e.message).split('\n')[0]})`);
  }
  if (i < QUERIES.length - 1) await sleep(SLEEP_MS);
}

console.log(`\n${repos.size} unique repositories. Fetching activity data …`);
const rows = [];
let n = 0;
for (const [name, info] of repos) {
  n++;
  try {
    const r = JSON.parse(gh(['api', `repos/${name}`]));
    rows.push({
      repo: name,
      url: r.html_url,
      stars: r.stargazers_count,
      forks: r.forks_count,
      pushed_at: r.pushed_at,
      archived: r.archived,
      is_fork: r.fork,
      has_issues: r.has_issues,
      language: r.language ?? '',
      description: (r.description ?? '').replace(/\s+/g, ' ').slice(0, 160),
      match_types: [...info.tags].join('|'),
      files: [...info.paths].slice(0, 5).join('|'),
    });
  } catch {
    // repo deleted/private since indexing: skip
  }
  if (n % 25 === 0) console.log(`  ${n}/${repos.size}`);
}

writeFileSync('census/results.json', JSON.stringify(rows, null, 2));
const cols = Object.keys(rows[0] ?? { repo: '' });
const esc = (v) => `"${String(v).replace(/"/g, '""')}"`;
writeFileSync(
  'census/results.csv',
  [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'),
);
console.log(`\nDone. ${rows.length} repositories written to census/results.csv`);
