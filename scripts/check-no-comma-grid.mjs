#!/usr/bin/env node
/**
 * CI guard: fail if any Tailwind arbitrary grid value uses a top-level comma.
 *
 * `grid-cols-[1.05fr,0.95fr]` compiles to the INVALID CSS
 * `grid-template-columns: 1.05fr,0.95fr` (tracks are space-separated, not
 * comma-separated), so the browser drops it and the layout silently collapses
 * to a single column. Tailwind wants underscores for the gap between tracks:
 * `grid-cols-[1.05fr_0.95fr]`. Commas INSIDE functions like `minmax(0,1fr)` are
 * valid and intentionally ignored here (we only flag paren-depth-0 commas).
 *
 * Caught a 17-file regression once; this keeps it from coming back.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const SCAN_DIRS = ['apps', 'packages'];
const SKIP = new Set(['node_modules', '.next', 'dist', 'build', '.git', 'coverage']);
const ARBITRARY = /grid-(?:cols|rows)-\[([^\]]*)\]/g;

function hasTopLevelComma(inner) {
  let depth = 0;
  for (const ch of inner) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) return true;
  }
  return false;
}

const offenders = [];
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry)) {
      const src = readFileSync(full, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        for (const m of line.matchAll(ARBITRARY)) {
          if (hasTopLevelComma(m[1])) {
            offenders.push(`${relative(ROOT, full)}:${i + 1}  ${m[0]}`);
          }
        }
      });
    }
  }
}

for (const d of SCAN_DIRS) {
  try { walk(join(ROOT, d)); } catch { /* dir may not exist */ }
}

if (offenders.length) {
  console.error(`\n✗ Found ${offenders.length} comma-separated Tailwind grid value(s) — these collapse to one column.`);
  console.error('  Replace the track-separator comma with an underscore, e.g. grid-cols-[1fr_1fr]:\n');
  for (const o of offenders) console.error('   ' + o);
  console.error('');
  process.exit(1);
}
console.log('✓ No comma-separated Tailwind grid values found.');
