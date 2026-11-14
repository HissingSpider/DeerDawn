#!/usr/bin/env node
// First-load JS budget reporter for a Next.js Pages Router app.
//
// Measures the gzipped size of the JS a fresh visit to a route must download
// (the union of the route's chunks, the shared _app chunks, and the root/runtime
// chunks) straight from `.next/build-manifest.json`. Warn-only by default so it
// can land before thresholds are calibrated; pass --enforce to fail when over
// budget (Wave 4 turns this into a PR gate).
//
// Usage:
//   node scripts/bundle-budget.mjs --app apps/marketing --route / --budget 180
//   node scripts/bundle-budget.mjs --app apps/dashboard --route / [--enforce]
//
// --budget is in KB gzipped. Omit it to just print the measured number (so you
// can set the budget from a real build).

import { readFileSync, existsSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, resolve } from 'node:path';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  return process.argv.includes(`--${name}`) ? true : fallback;
}

// apps/marketing ships only in the private repo; a public checkout defaults to
// the dashboard instead.
const defaultApp = existsSync(resolve(process.cwd(), 'apps/marketing')) ? 'apps/marketing' : 'apps/dashboard';
const appDir = resolve(process.cwd(), arg('app', defaultApp));
if (!existsSync(appDir)) {
  console.error(`[bundle-budget] no app at ${appDir}. Pass --app <dir> (apps/marketing exists only in the private repo).`);
  process.exit(2);
}
const route = arg('route', '/');
const budgetKb = arg('budget', null);
const enforce = Boolean(arg('enforce', false));

const nextDir = join(appDir, '.next');
const manifestPath = join(nextDir, 'build-manifest.json');

if (!existsSync(manifestPath)) {
  console.log(`[bundle-budget] no build at ${manifestPath} — run \`next build\` first. Skipping (exit 0).`);
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const pages = manifest.pages || {};

// First-load set = this route's chunks ∪ _app chunks ∪ shared root/runtime files.
const files = new Set([
  ...(pages[route] || []),
  ...(pages['/_app'] || []),
  ...(manifest.rootMainFiles || []),
  ...(manifest.devFiles || []),
  ...(manifest.ampDevFiles || []),
]);

let rawBytes = 0;
let gzBytes = 0;
let missing = 0;
const perFile = [];
for (const rel of files) {
  if (!rel.endsWith('.js')) continue;
  const abs = join(nextDir, rel);
  if (!existsSync(abs)) {
    missing += 1;
    continue;
  }
  const buf = readFileSync(abs);
  const gz = gzipSync(buf).length;
  rawBytes += statSync(abs).size;
  gzBytes += gz;
  perFile.push({ rel, gz });
}

const gzKb = gzBytes / 1024;
const rawKb = rawBytes / 1024;
perFile.sort((a, b) => b.gz - a.gz);

console.log(`\n[bundle-budget] ${appDir.split('/').slice(-2).join('/')} route "${route}"`);
console.log(`  first-load JS: ${gzKb.toFixed(1)} KB gz  (${rawKb.toFixed(1)} KB raw, ${perFile.length} chunks${missing ? `, ${missing} missing` : ''})`);
for (const f of perFile.slice(0, 6)) {
  console.log(`    ${(f.gz / 1024).toFixed(1).padStart(6)} KB gz  ${f.rel}`);
}

if (budgetKb == null) {
  console.log(`  (no --budget set; reporting only)`);
  process.exit(0);
}

const budget = Number(budgetKb);
const over = gzKb > budget;
console.log(`  budget: ${budget} KB gz → ${over ? 'OVER' : 'OK'} (${(gzKb - budget).toFixed(1)} KB)`);

if (over && enforce) {
  console.error(`[bundle-budget] FAIL: route "${route}" first-load JS ${gzKb.toFixed(1)} KB gz exceeds ${budget} KB.`);
  process.exit(1);
}
process.exit(0);
