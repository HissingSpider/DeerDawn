/**
 * Which test files belong to which npm script — the single source of truth.
 *
 * WHY THIS EXISTS: `npm test` used to be a hand-maintained `&&` chain naming 75
 * files one by one. Adding a test file meant remembering to append it, and
 * forgetting was silent: the suite still passed, just without the new file.
 *
 * Six files had been forgotten that way and were running nowhere in CI:
 *   tests/google-ads-conversion.test.js          (6 assertions)
 *   tests/security-hardening-contracts.test.js   (1)
 *   tests/unit/mcp-safety.test.js                (1)
 *   tests/integration/context-sync-org-sharing.test.js (1)
 *   tests/integration/data-erasure.test.js       (1)
 *   tests/integration/context-sync-e2e.test.js   (41)
 * All six pass — they were forgotten, not excluded.
 *
 * The runner and the guard (tests/unit/test-suite-coverage.test.js) both read
 * this module, so the two cannot drift apart. Discovery is by directory scan,
 * so a new file is picked up with no edit here at all; the only thing spelled
 * out is which files belong to a suite OTHER than the default one.
 */
const fs = require('fs');
const path = require('path');

const TESTS_DIR = path.resolve(__dirname, '..', 'tests');

/**
 * Layer suites are slow, DB-heavy behavioural walks. CI runs them as their own
 * step (`test:behavioral`) so a failure there is distinguishable from a unit
 * regression, and so the default suite stays fast enough to run locally.
 */
const isLayerSuite = (rel) => /^tests\/layer\d+[-.]/.test(rel);

/** Its own CI step (`test:mcp-review`) — a corpus review, not a regression test. */
const isReviewCorpus = (rel) => rel === 'tests/mcp-launch-review-cases.test.js';

function walk(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (/\.test\.js$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

/** Every test file on disk, as repo-relative POSIX paths, sorted. */
function allTestFiles() {
  return walk(TESTS_DIR)
    .map((f) => path.relative(path.resolve(__dirname, '..'), f).split(path.sep).join('/'))
    .sort();
}

/** The suite a file belongs to. Every file belongs to exactly one. */
function suiteFor(rel) {
  if (isLayerSuite(rel)) return 'behavioral';
  if (isReviewCorpus(rel)) return 'review';
  return 'default';
}

const SUITES = ['default', 'behavioral', 'review'];

function filesFor(suite) {
  if (!SUITES.includes(suite)) {
    throw new Error(`unknown suite "${suite}" — expected one of ${SUITES.join(', ')}`);
  }
  return allTestFiles().filter((f) => suiteFor(f) === suite);
}

module.exports = { allTestFiles, suiteFor, filesFor, SUITES, TESTS_DIR };

// Invoked directly by the npm scripts: print the suite's files, space separated.
if (require.main === module) {
  const suite = process.argv[2] || 'default';
  process.stdout.write(filesFor(suite).join(' '));
}
