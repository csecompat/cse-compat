#!/usr/bin/env node
/**
 * Structural diff: compare golden Google fixtures (from capture-fixtures.mjs)
 * against a running cse-compat deployment, field by field.
 *
 * We diff SHAPE, not content — results legitimately differ across search
 * indexes; what must match is the contract: which fields exist, their JSON
 * types, pagination structure, and error envelopes.
 *
 * Usage:
 *   node scripts/diff-golden.mjs <baseUrl> <proxyKey> [goldenDir]
 *   e.g. node scripts/diff-golden.mjs https://cse-compat.you.workers.dev mykey test/golden
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [baseUrl, proxyKey, goldenDir = 'test/golden'] = process.argv.slice(2);
if (!baseUrl || !proxyKey) {
  console.error('Usage: node scripts/diff-golden.mjs <baseUrl> <proxyKey> [goldenDir]');
  process.exit(1);
}

/** Collect "path: jsontype" signatures. Arrays are sampled at [0]. */
function shape(value, prefix = '', out = new Map()) {
  if (Array.isArray(value)) {
    out.set(prefix || '$', 'array');
    if (value.length > 0) shape(value[0], `${prefix}[]`, out);
  } else if (value !== null && typeof value === 'object') {
    out.set(prefix || '$', 'object');
    for (const [k, v] of Object.entries(value)) shape(v, prefix ? `${prefix}.${k}` : k, out);
  } else {
    out.set(prefix || '$', value === null ? 'null' : typeof value);
  }
  return out;
}

// Fields that are known-absent by design (documented in README) — reported
// separately so real regressions stand out.
const KNOWN_GAPS = new Set([
  'items[].pagemap',
  'items[].cacheId',
  'spelling',
  'spelling.correctedQuery',
  'spelling.htmlCorrectedQuery',
  'promotions',
  'context.facets',
]);

const files = (await readdir(goldenDir)).filter((f) => f.endsWith('.json'));
let hardMisses = 0;

for (const f of files) {
  const golden = JSON.parse(await readFile(join(goldenDir, f), 'utf8'));
  const params = new URLSearchParams({ key: proxyKey, cx: 'golden-cx', ...golden._meta.params });
  const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/customsearch/v1?${params}`);
  const ours = await resp.json();

  const gShape = shape(golden.response);
  const oShape = shape(ours);

  const missing = [];
  const typeMismatch = [];
  const knownGaps = [];
  for (const [path, type] of gShape) {
    if (!oShape.has(path)) {
      const root = path.replace(/^(items\[\]\.[a-zA-Z]+).*/, '$1');
      (KNOWN_GAPS.has(path) || KNOWN_GAPS.has(root) ? knownGaps : missing).push(path);
    } else if (oShape.get(path) !== type) {
      typeMismatch.push(`${path}: golden=${type} ours=${oShape.get(path)}`);
    }
  }
  const statusMatch = golden._meta.httpStatus === resp.status;

  const bad = missing.length > 0 || typeMismatch.length > 0 || !statusMatch;
  if (bad) hardMisses++;
  console.log(`${bad ? '✗' : '✓'} ${golden._meta.case}  [golden ${golden._meta.httpStatus} vs ours ${resp.status}]`);
  for (const m of missing) console.log(`    missing: ${m}`);
  for (const m of typeMismatch) console.log(`    type:    ${m}`);
  if (knownGaps.length) console.log(`    known gaps (documented): ${knownGaps.join(', ')}`);
}

console.log(`\n${files.length - hardMisses}/${files.length} cases structurally conformant.`);
process.exit(hardMisses > 0 ? 1 : 0);
