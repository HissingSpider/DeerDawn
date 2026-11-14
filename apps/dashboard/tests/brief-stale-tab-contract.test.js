/**
 * JOURNEY R3 / S3-1 — the wiring half.
 *
 * An open /projects tab held the brief it loaded and never read it again, and
 * every per-line action (Pin, Edit, "This is wrong", Dismiss) PATCHed the whole
 * list rebuilt from that copy — so a click erased whatever the person's own AI
 * tool had saved since the tab loaded, and the toast said "Brief updated.".
 *
 * The rules themselves (fresh read, identity not index, version, at most two
 * retries, write nothing when the line is gone) run against real inputs in
 * src/lib/briefEdits.test.ts. This pins that the components actually use them:
 * a source-level suite can say WHICH path a click takes, and that the old path
 * is not still there beside the new one.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const readCode = (...parts) => read(...parts)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*(\/\/|\*|\{\/\*)/.test(line))
  .join('\n');

const workspace = () => readCode('src', 'components', 'dashboard', 'brief', 'BriefWorkspace.tsx');

test('THE BUG: a line action no longer rebuilds the list from the context the tab loaded', () => {
  const src = workspace();
  // The old mutateArray: `const currentArray = ... context[field] ...; transform([...currentArray])`.
  assert.doesNotMatch(src, /context\[field\]/, 'no list is rebuilt from the loaded context');
  assert.doesNotMatch(src, /mutateArray/, 'the whole-array-from-page-load path is gone, not kept beside the new one');
  assert.doesNotMatch(src, /targetIndex|item\.index \?\? -1/, 'a line is never found by its index in the old list');
});

test('every per-line action goes through the fresh-read, versioned write', () => {
  const src = workspace();
  assert.match(src, /saveLineChange\(/);
  for (const action of ['onEdit', 'onCorrect', 'onDismiss', 'onPin']) {
    assert.match(src, new RegExp(`${action}: \\([^)]*\\) => mutateLine\\(`), `${action} must go through mutateLine`);
  }
  assert.match(src, /api\.getProjectContextJson\(projectId\)/, 'the read is a fresh read');
  assert.match(src, /expectedContextVersion: expectedVersion/, 'the write carries the version of that read');
});

test('a click on a line that is gone writes nothing and never says "Brief updated."', () => {
  const src = workspace();
  const gone = src.slice(src.indexOf("result.outcome === 'gone'"));
  assert.ok(gone.length > 0, 'the outcome where nothing was written is handled');
  const branch = gone.slice(0, gone.indexOf('return;'));
  assert.match(branch, /LINE_CHANGED_MESSAGE/);
  assert.doesNotMatch(branch, /BRIEF_SAVED_MESSAGE|Brief updated/);
  assert.match(branch, /showFresh\(projectId, result\.context\)/, 'and the brief shown is the one just read');
});

test('clearing the blocker clears the one the person saw, from a fresh read', () => {
  const src = workspace();
  const fn = src.slice(src.indexOf('const completeBlocking'), src.indexOf('const answerQuestion'));
  assert.match(fn, /writeFromFreshRead\(/);
  assert.match(fn, /BLOCKER_CHANGED_MESSAGE/);
  assert.doesNotMatch(fn, /api\.updateProjectContext\(selectedId, patch/, 'not the unguarded write from the loaded copy');
});

test('the open tab re-reads the brief when it is looked at again, throttled, without polling', () => {
  const src = workspace();
  assert.match(src, /window\.addEventListener\('focus', refetch\)/);
  assert.match(src, /document\.addEventListener\('visibilitychange', refetch\)/);
  assert.match(src, /window\.removeEventListener\('focus', refetch\)/, 'and cleans up');
  assert.match(src, /REFETCH_MIN_INTERVAL_MS/);
  const interval = Number((src.match(/REFETCH_MIN_INTERVAL_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, ''));
  assert.ok(interval >= 2000 && interval <= 15000, `no more than once every few seconds (got ${interval}ms)`);
  assert.doesNotMatch(src, /setInterval\(/, 'no polling');
  assert.match(src, /if \(writingRef\.current\) return;/, 'a refetch never lands on top of a write in flight');
});

test('an open editor stays on its own line across a refresh, and saves against the words it opened on', () => {
  const slot = readCode('src', 'components', 'dashboard', 'brief', 'BriefSlot.tsx');
  assert.doesNotMatch(slot, /key=\{`\$\{slot\}-\$\{item\.index/, 'a line is not keyed by its position');
  assert.match(slot, /briefLineKeys\(slot, items\)/);
  const line = readCode('src', 'components', 'dashboard', 'brief', 'BriefLine.tsx');
  assert.match(line, /const target = opened \?\? item;/);
  assert.match(line, /onEdit\?\.\(target, next, slot\)/);
  assert.match(line, /onCorrect\?\.\(target, next, slot\)/);
});

test('the API client sends the version only when it has one', () => {
  const api = readCode('src', 'lib', 'api.ts');
  const method = api.slice(api.indexOf('updateProjectContext: ('), api.indexOf('resolveQuestion:'));
  assert.match(method, /expected_context_version: version/);
  assert.match(method, /Number\.isInteger\(version\)/);
});

test('the /memory project editor sends only what the person changed', () => {
  const net = readCode('src', 'components', 'dashboard', 'ContextNetwork.tsx');
  const save = net.slice(net.indexOf('async function saveEdit'), net.indexOf('const connectedProjectIds'));
  assert.ok(save.length > 0);
  assert.match(save, /projectEditorPatch\(editStart, editFields\)/);
  assert.doesNotMatch(save, /current_task: editFields\.current_task/, 'an unchanged task is not written back from the copy /memory loaded');
  assert.match(save, /mergeLineEdits\(/, 'goals are merged as line edits onto a fresh read');
});
