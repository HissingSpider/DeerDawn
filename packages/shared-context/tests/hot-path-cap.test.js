const test = require('node:test');
const assert = require('node:assert/strict');

const { createContextObject, mergeContextObject } = require('../src');

// AT THE CAP, THE NEWEST PATH IS THE ONE THAT MUST SURVIVE.
//
// hot_paths is capped at 40. uniqueEntries ranks by priority and then recency,
// but normalizeHotPaths passed a priority function and NO recency — so with 40
// untagged entries every comparison tied, the sort was stable, and the OLDEST
// 40 won. Recording a path today returned "Recorded 1 hot path" and stored
// nothing; `recall paths` then could not find the file the agent had just
// written down. A path recorded today beats one recorded in July.
//
// These entries carry no timestamp, so their ORDER is their recency:
// mergeContextObject feeds [...current, ...delta], newest at the tail.

const pathEntry = (n) => ({ label: `mod ${n}`, path: `src/mod-${n}.js`, purpose: `module ${n}` });
const full = Array.from({ length: 40 }, (_, i) => pathEntry(i + 1));

test('a new hot path recorded at the cap replaces the oldest, not itself', () => {
  const current = createContextObject({ project_name: 'Atlas', hot_paths: full });
  const merged = mergeContextObject(current, { hot_paths: [pathEntry('NEW')] });

  assert.equal(merged.hot_paths.length, 40);
  assert.ok(
    merged.hot_paths.some((entry) => entry.path === 'src/mod-NEW.js'),
    'the path recorded last must be stored; dropping it while replying "Recorded 1" is a silent loss',
  );
  assert.ok(
    !merged.hot_paths.some((entry) => entry.path === 'src/mod-1.js'),
    'the oldest entry is the one that makes room',
  );
});

test('a pinned or important hot path still outranks a newer trivial one at the cap', () => {
  const stored = [{ ...pathEntry('pinned'), pinned: true }, ...full.slice(0, 39)];
  const current = createContextObject({ project_name: 'Atlas', hot_paths: stored });
  const merged = mergeContextObject(current, { hot_paths: [pathEntry('NEW')] });

  assert.equal(merged.hot_paths.length, 40);
  assert.ok(merged.hot_paths.some((entry) => entry.path === 'src/mod-pinned.js'), 'pinned survives eviction');
  assert.ok(merged.hot_paths.some((entry) => entry.path === 'src/mod-NEW.js'), 'the newest still lands');
});

test('re-recording an existing hot path refreshes its recency', () => {
  const current = createContextObject({ project_name: 'Atlas', hot_paths: full });
  // Record the oldest entry again, then push one more past the cap. The
  // refreshed entry is no longer the oldest, so it must not be the one evicted.
  const refreshed = mergeContextObject(current, { hot_paths: [pathEntry(1)] });
  const merged = mergeContextObject(refreshed, { hot_paths: [pathEntry('NEW')] });

  assert.equal(merged.hot_paths.length, 40);
  assert.ok(merged.hot_paths.some((entry) => entry.path === 'src/mod-1.js'), 're-recorded today, so not the oldest');
  assert.ok(!merged.hot_paths.some((entry) => entry.path === 'src/mod-2.js'), 'mod 2 is now the oldest');
});

test('under the cap nothing is reordered', () => {
  const stored = full.slice(0, 5);
  const current = createContextObject({ project_name: 'Atlas', hot_paths: stored });
  const merged = mergeContextObject(current, { hot_paths: [pathEntry('NEW')] });
  assert.deepStrictEqual(
    merged.hot_paths.map((entry) => entry.path),
    [...stored.map((entry) => entry.path), 'src/mod-NEW.js'],
  );
});
