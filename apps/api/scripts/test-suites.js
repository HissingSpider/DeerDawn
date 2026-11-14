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

/**
 * CI shards: one slice of a suite, for running it across parallel jobs that
 * each have their own database. The default suite took 20-25 minutes as one
 * serial run; the files cannot share a database side by side (see
 * run-db-test.sh), but separate jobs do not share one.
 *
 * Balanced by FILE SIZE, longest-processing-time first: biggest file to the
 * lightest shard. Measured against per-file CI timings (2026-11-13, 415 files)
 * size lands within ~10% of a timing-balanced split, and unlike a committed
 * timings file it cannot go stale or need regenerating when tests are added.
 * Ties break on path, so every job computes the same partition.
 *
 * A shard can never be empty (that would hand `node --test` no files, and with
 * no files it discovers and runs everything): asking for more shards than files
 * throws.
 */
function parseShard(spec) {
  const m = /^(\d+)\/(\d+)$/.exec(String(spec).trim());
  if (!m) throw new Error(`bad shard "${spec}" — expected INDEX/TOTAL, e.g. 2/4`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) {
    throw new Error(`bad shard "${spec}" — INDEX must be 1..TOTAL`);
  }
  return { index, total };
}

function shardFiles(files, spec, sizeOf = (f) => fs.statSync(path.resolve(__dirname, '..', f)).size) {
  const { index, total } = parseShard(spec);
  if (files.length < total) {
    throw new Error(`cannot split ${files.length} files into ${total} non-empty shards`);
  }
  const weighted = files
    .map((f) => ({ f, w: sizeOf(f) }))
    .sort((a, b) => b.w - a.w || (a.f < b.f ? -1 : 1));
  const load = new Array(total).fill(0);
  const owner = new Map();
  for (const { f, w } of weighted) {
    let k = 0;
    for (let i = 1; i < total; i += 1) if (load[i] < load[k]) k = i;
    load[k] += w;
    owner.set(f, k);
  }
  // Keep the suite's own (sorted) order inside a shard.
  return files.filter((f) => owner.get(f) === index - 1);
}

module.exports = { allTestFiles, suiteFor, filesFor, shardFiles, parseShard, SUITES, TESTS_DIR };

// Invoked directly by the npm scripts: print the suite's files, space separated.
// TEST_SHARD=INDEX/TOTAL (set by CI's matrix) prints just that shard's slice.
if (require.main === module) {
  const suite = process.argv[2] || 'default';
  const all = filesFor(suite);
  const shard = process.env.TEST_SHARD;
  const files = shard ? shardFiles(all, shard) : all;
  if (shard) process.stderr.write(`[test-suites] ${suite} shard ${shard}: ${files.length} of ${all.length} files\n`);
  process.stdout.write(files.join(' '));
}
