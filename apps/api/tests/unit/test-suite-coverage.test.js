/**
 * Meta-test: every test file on disk is actually run by some CI step.
 *
 * WHY THIS EXISTS: `npm test` was a hand-maintained `&&` chain naming 75 files
 * individually. Adding a test meant remembering to append it there, and
 * forgetting was silent — the suite went green without it. Six files had been
 * forgotten and were running nowhere in CI, together 51 assertions, including
 * tests/google-ads-conversion.test.js and tests/security-hardening-contracts.test.js.
 * All six passed once run, so they had been forgotten rather than excluded.
 *
 * A test file that never runs is worse than no test file, because it reads as
 * coverage. Suite membership now comes from scripts/test-suites.js, which
 * discovers files by scanning the directory; this asserts the partition is
 * total and that the npm scripts actually consult it, so nobody can quietly
 * reintroduce a hardcoded list.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const suites = require('../../scripts/test-suites.js');
const pkg = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../package.json'), 'utf8'));

test('every test file on disk belongs to exactly one suite', () => {
  const all = suites.allTestFiles();
  assert.ok(all.length > 0, 'no test files found — the directory or naming convention moved');

  const counts = new Map(all.map((f) => [f, 0]));
  for (const suite of suites.SUITES) {
    for (const file of suites.filesFor(suite)) counts.set(file, counts.get(file) + 1);
  }

  const orphans = [...counts].filter(([, n]) => n === 0).map(([f]) => f);
  const duplicates = [...counts].filter(([, n]) => n > 1).map(([f]) => f);

  assert.deepEqual(orphans, [], `these test files are run by NO suite: ${orphans.join(', ')}`);
  assert.deepEqual(duplicates, [], `these test files run twice: ${duplicates.join(', ')}`);
});

test('every file a suite claims actually exists', () => {
  for (const suite of suites.SUITES) {
    for (const file of suites.filesFor(suite)) {
      assert.ok(
        fs.existsSync(path.resolve(__dirname, '../..', file)),
        `suite "${suite}" names ${file}, which is not on disk`,
      );
    }
  }
});

test('the npm scripts read suite membership from test-suites.js, not a hardcoded list', () => {
  // This is the assertion that actually prevents recurrence: the previous bug
  // was a literal file list in package.json drifting away from the directory.
  for (const [script, suite] of [
    ['test', 'default'],
    ['test:behavioral', 'behavioral'],
    ['test:mcp-review', 'review'],
  ]) {
    const command = pkg.scripts[script];
    assert.ok(command, `package.json must define a "${script}" script`);
    assert.match(
      command,
      new RegExp(`test-suites\\.js\\s+${suite}\\b`),
      `"${script}" must resolve its files via \`node scripts/test-suites.js ${suite}\``,
    );
  }
});

test('no suite is empty — a typo in the classifier would silently run nothing', () => {
  for (const suite of suites.SUITES) {
    assert.ok(
      suites.filesFor(suite).length > 0,
      `suite "${suite}" resolved to zero files, so its CI step would pass vacuously`,
    );
  }
});

test('this guard is itself in the default suite', () => {
  // Self-coverage: if the guard stopped being run, nothing would report it.
  const self = 'tests/unit/test-suite-coverage.test.js';
  assert.equal(suites.suiteFor(self), 'default');
  assert.ok(suites.allTestFiles().includes(self), 'the guard must be discoverable on disk');
});

// ── CI shards ────────────────────────────────────────────────────────────────
// CI splits the default and behavioral suites across parallel jobs. A file that
// lands in no shard runs nowhere, which is the same silent loss this guard was
// written for, so the partition is held to the same standard as the suites.

test('every shard split is a partition: each file in exactly one shard, none empty', () => {
  for (const suite of ['default', 'behavioral']) {
    const all = suites.filesFor(suite);
    for (let total = 1; total <= Math.min(8, all.length); total += 1) {
      const seen = new Map(all.map((f) => [f, 0]));
      for (let index = 1; index <= total; index += 1) {
        const slice = suites.shardFiles(all, `${index}/${total}`);
        assert.ok(slice.length > 0, `${suite} shard ${index}/${total} is empty`);
        for (const f of slice) {
          assert.ok(seen.has(f), `${suite} shard ${index}/${total} names ${f}, which is not in the suite`);
          seen.set(f, seen.get(f) + 1);
        }
      }
      const wrong = [...seen].filter(([, n]) => n !== 1);
      assert.deepEqual(wrong, [], `${suite} split ${total} ways runs these files 0 or 2+ times`);
    }
  }
});

test('the shard split is deterministic and keeps suite order inside a shard', () => {
  const all = suites.filesFor('default');
  const a = suites.shardFiles(all, '2/4');
  const b = suites.shardFiles([...all].reverse(), '2/4');
  assert.deepEqual([...b].reverse(), a, 'input order must not change which files a shard gets');
  assert.deepEqual(a, [...a].sort(), 'files inside a shard keep the suite order');
});

test('a malformed or impossible shard throws instead of selecting nothing', () => {
  // `node --test` handed zero files discovers and runs everything, so an empty
  // shard must be an error, never an empty list.
  const all = suites.filesFor('behavioral');
  for (const bad of ['0/4', '5/4', '1/0', '2', 'a/b', '']) {
    assert.throws(() => suites.shardFiles(all, bad), /bad shard/, `"${bad}" must be refused`);
  }
  assert.throws(() => suites.shardFiles(all.slice(0, 2), '1/3'), /non-empty shards/);
});

test('CI runs every shard it declares: the matrix lists 1/N..N/N exactly', () => {
  // Each matrix entry names its own INDEX/TOTAL, so dropping an entry without
  // changing TOTAL would leave a slice of the suite running nowhere.
  const workflow = path.resolve(__dirname, '../../../../.github/workflows/ci.yml');
  const source = fs.readFileSync(workflow, 'utf8');
  const m = source.match(/^\s*shard:\s*\[([^\]]*)\]/m);
  assert.ok(m, `${workflow} has no \`shard: [...]\` matrix — the API job is no longer sharded?`);
  const shards = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  const total = shards.length;
  assert.deepEqual(shards, Array.from({ length: total }, (_, i) => `${i + 1}/${total}`));
  assert.match(source, /TEST_SHARD:\s*\$\{\{\s*matrix\.shard\s*\}\}/, 'the matrix value must reach TEST_SHARD');
});
