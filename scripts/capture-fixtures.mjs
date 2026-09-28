#!/usr/bin/env node
/**
 * Golden-fixture capture: snapshot REAL Google Custom Search JSON API
 * responses while the API still exists (it shuts down 2027-01-01 and is
 * already closed to new customers — if you have a working key, these
 * snapshots become irreplaceable after the shutdown).
 *
 * Usage:
 *   GOOGLE_API_KEY=... GOOGLE_CX=... node scripts/capture-fixtures.mjs [outDir]
 *
 * Captures a matrix of parameter combinations that exercise the parts of
 * the contract clients actually depend on (pagination, zero results,
 * operators, errors), sanitizes your key out of every payload, and writes
 * one JSON file per case to test/golden/ (or outDir).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const KEY = process.env.GOOGLE_API_KEY;
const CX = process.env.GOOGLE_CX;
const OUT = process.argv[2] ?? 'test/golden';

if (!KEY || !CX) {
  console.error('Set GOOGLE_API_KEY and GOOGLE_CX (your real, still-working CSE credentials).');
  process.exit(1);
}

/** Cases chosen to pin down envelope behaviour, not content. */
const CASES = [
  { name: 'basic', params: { q: 'cloudflare workers tutorial' } },
  { name: 'num-5', params: { q: 'typescript generics', num: '5' } },
  { name: 'page-2', params: { q: 'typescript generics', num: '10', start: '11' } },
  { name: 'last-window', params: { q: 'javascript', num: '10', start: '91' } },
  { name: 'zero-results', params: { q: 'sdkfjhsdkfjhsdfkjhsdfkjhx zzqqxxyy' } },
  { name: 'exact-terms', params: { q: 'search api', exactTerms: 'pagination' } },
  { name: 'exclude-terms', params: { q: 'jaguar', excludeTerms: 'car' } },
  { name: 'filetype', params: { q: 'annual report', fileType: 'pdf' } },
  { name: 'site-search', params: { q: 'workers', siteSearch: 'developers.cloudflare.com', siteSearchFilter: 'i' } },
  { name: 'safe-active', params: { q: 'medical anatomy', safe: 'active' } },
  { name: 'date-restrict', params: { q: 'ai news', dateRestrict: 'w1' } },
  { name: 'gl-hl', params: { q: 'boulangerie', gl: 'fr', hl: 'fr' } },
  { name: 'sort-date', params: { q: 'press release', sort: 'date' } },
  // Error-shape cases (deliberately invalid; captures Google's error envelope):
  { name: 'err-num-11', params: { q: 'x', num: '11' }, expectError: true },
  { name: 'err-start-overflow', params: { q: 'x', start: '95', num: '10' }, expectError: true },
  { name: 'err-missing-q', params: {}, expectError: true },
  { name: 'err-bad-key', params: { q: 'x' }, overrideKey: 'invalid-key-on-purpose', expectError: true },
];

await mkdir(OUT, { recursive: true });
let ok = 0;
let failed = 0;

for (const c of CASES) {
  const url = new URL('https://www.googleapis.com/customsearch/v1');
  url.searchParams.set('key', c.overrideKey ?? KEY);
  url.searchParams.set('cx', CX);
  for (const [k, v] of Object.entries(c.params)) url.searchParams.set(k, v);

  try {
    const resp = await fetch(url);
    const text = await resp.text();
    // Sanitize: never write your real key into a fixture.
    const sanitized = text.replaceAll(KEY, 'REDACTED_KEY').replaceAll(CX, 'REDACTED_CX');
    let body;
    try {
      body = JSON.parse(sanitized);
    } catch {
      body = { _nonJson: sanitized };
    }
    const record = {
      _meta: {
        capturedAt: new Date().toISOString(),
        httpStatus: resp.status,
        case: c.name,
        params: c.params,
        note: 'Golden fixture from the real Google Custom Search JSON API, pre-shutdown.',
      },
      response: body,
    };
    await writeFile(join(OUT, `${c.name}.json`), JSON.stringify(record, null, 2));
    const tag = c.expectError ? (resp.status >= 400 ? 'error-as-expected' : 'UNEXPECTED 2xx') : `status ${resp.status}`;
    console.log(`✓ ${c.name} (${tag})`);
    ok++;
  } catch (e) {
    console.error(`✗ ${c.name}: ${e.message}`);
    failed++;
  }
  // Be polite to your remaining daily quota (100 free/day).
  await new Promise((r) => setTimeout(r, 400));
}

console.log(`\n${ok} captured, ${failed} failed → ${OUT}/`);
console.log('Commit these. After 2027-01-01 they cannot be regenerated.');
