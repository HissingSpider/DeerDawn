/**
 * Meta-test: every test file in this app is actually executed by `npm test`.
 *
 * WHY THIS EXISTS: the test script named `src/lib/redirects.test.ts` by hand.
 * When #307 added `src/lib/lifecycleEmail.test.ts` on 2026-08-16, that file ran
 * nowhere — CI stayed green while three assertions about the lifecycle-email
 * click marker sat unexecuted. Same class of defect as apps/marketing, whose
 * `.test.ts` suite was skipped by a `tests/*.test.js` glob, and apps/api, whose
 * `npm test` was a hand-maintained list of 75 filenames.
 *
 * A test file that never runs is worse than no test file, because it reads as
 * coverage. This asserts the script's globs cover every test file on disk, so
 * the next one added in an unmatched location fails loudly instead of quietly
 * counting as green.
 *
 * Run: `node --test tests/test-runner-coverage.test.js`
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const script = pkg.scripts.test;

/** Directories the runner is expected to cover, relative to the app root. */
const SEARCH_ROOTS = ['src', 'tests'];
const TEST_FILE = /\.(test|contract)\.[cm]?[jt]sx?$/;

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (TEST_FILE.test(entry.name)) acc.push(path.relative(root, full).split(path.sep).join('/'));
  }
  return acc;
}

// `src/lib/*.test.ts` -> matcher. Only `*` is used, and it never crosses `/`.
const toRegExp = (glob) =>
  new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');

test('the test script names at least one glob per search root', () => {
  assert.ok(script, 'apps/dashboard must define a test script');
  for (const dir of SEARCH_ROOTS) {
    assert.ok(
      new RegExp(`(^|\\s)${dir}/`).test(script),
      `the test script covers nothing under ${dir}/ — got: ${script}`,
    );
  }
});

test('every test file on disk is matched by the test script', () => {
  const globs = script.match(/(?:src|tests)\/\S+/g) || [];
  const matchers = globs.map(toRegExp);
  const files = SEARCH_ROOTS.flatMap((dir) => walk(path.join(root, dir))).sort();

  assert.ok(files.length > 0, 'no test files found — the naming convention moved');

  const unmatched = files.filter((f) => !matchers.some((re) => re.test(f)));
  assert.deepEqual(
    unmatched,
    [],
    `these test files exist but are NOT run by \`npm test\` (${script}): ${unmatched.join(', ')}`,
  );
});

test('TypeScript suites go through a loader', () => {
  // .nvmrc pins Node 20, which cannot execute TypeScript, so matching the glob
  // is necessary but not sufficient — dropping tsx would crash rather than skip.
  const hasTs = SEARCH_ROOTS.flatMap((dir) => walk(path.join(root, dir))).some((f) =>
    /\.tsx?$/.test(f),
  );
  if (!hasTs) return;
  assert.match(
    script,
    /\btsx\b|--experimental-strip-types/,
    'TypeScript suites are present, so the test script needs a TS loader',
  );
});
