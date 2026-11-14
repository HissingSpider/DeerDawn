/**
 * JOURNEY R4 — A REFUSED BRIEF EDIT KEEPS WHAT WAS TYPED (the wiring half).
 *
 * A save refused because the brief changed underneath it (409
 * stale_context_version, or the line no longer as the person saw it) closed
 * the editor, and what they had typed was gone. The owner's decision: the
 * editor stays open with their text, beside the line as it now is; they can
 * copy, adjust and save again. When the line no longer exists, the text is
 * still kept on screen and they are told the line is gone.
 *
 * The rules (which line, which sentence) run against real inputs in
 * src/lib/briefRefusedEdit.test.ts. This pins that the components use them.
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

const brief = (file) => readCode('src', 'components', 'dashboard', 'brief', file);

test('the editor stays open until the save is settled, instead of closing on the press', () => {
  const line = brief('BriefLine.tsx');
  const commit = line.slice(line.indexOf('const commit = async'), line.indexOf('const cancel'));
  assert.ok(commit.length > 0, 'commit waits for the save');
  const awaitAt = commit.search(/await onEdit\?\.\(target, next, slot\)/);
  assert.ok(awaitAt >= 0, 'the edit is awaited');
  assert.match(commit, /await onCorrect\?\.\(target, next, slot\)/, 'the correction too');
  assert.ok(commit.lastIndexOf('setEditing(null)') > awaitAt, 'and the editor closes only after the answer');
});

test('a save refused as "the line changed" or "the brief kept changing" keeps the typed text', () => {
  const ws = brief('BriefWorkspace.tsx');
  const fn = ws.slice(ws.indexOf('const mutateLine = useCallback'), ws.indexOf('const saveRefusedEdit'));
  assert.ok(fn.length > 0);
  const gone = fn.slice(fn.indexOf("result.outcome === 'gone'"));
  assert.match(gone.slice(0, gone.indexOf('return;')), /keep\('changed'\)/, 'line no longer as seen: kept');
  const stale = fn.slice(fn.indexOf('if (isStaleVersionError(err))'));
  assert.match(stale.slice(0, stale.indexOf('return;')), /keep\('busy'\)/, 'stale on every attempt: kept');
  assert.match(fn, /if \(change\.kind !== 'edit'\) return;/, 'only an edit has typed text to keep');
  assert.match(fn, /keepRefusedEdit\(projectId, slot, id, change\.text/, 'what is kept is what was typed');
  assert.match(fn, /if \(opts\.refusalId\) dropRefusedEdit\(opts\.refusalId\)/, 'a kept edit saved again is cleared');
});

test('the kept text is shown in place of its line as it now reads, or on its own when the line is gone', () => {
  const slot = brief('BriefSlot.tsx');
  assert.match(slot, /locateRefusedLine\(edit\.slot, items, edit\.seen\)/);
  assert.match(slot, /<RefusedLineEditor/);
  assert.match(slot, /now: at >= 0 \? items\[at\] : null/, 'a line that is gone is shown as gone, not as another line');
  assert.match(slot, /refused\.filter\(\(edit\) => edit\.slot === slot\)/, 'each slot holds its own lines\' kept text only');
  assert.match(slot, /if \(!items\.length && !refusedHere\.length\)/, 'a slot whose last line went keeps the kept text on screen');
  const view = brief('BriefView.tsx');
  assert.match(view, /refused\.some\(\(edit\) => edit\.slot === s\)/, 'and the grid is not replaced by an empty-brief panel');
});

test('the kept editor holds the typed text, the line as it now reads, and Copy, Save again, Discard', () => {
  const ed = brief('RefusedLineEditor.tsx');
  assert.match(ed, /useState\(edit\.draft\)/);
  assert.match(ed, /value=\{draft\}/);
  assert.match(ed, /\{now\.text\}/);
  assert.match(ed, /LINE_NOW_LABEL/);
  assert.match(ed, /refusedEditMessage\(edit, Boolean\(now\)\)/);
  assert.match(ed, /navigator\.clipboard\.writeText\(draft\)/);
  assert.match(ed, /await onSave\(next\)/);
  assert.match(ed, /\{now && \(\s*<button/, 'Save is offered only when there is a line to save onto');
});

test('a save again goes through the same versioned write, against the line as it now reads', () => {
  const ws = brief('BriefWorkspace.tsx');
  assert.match(ws, /mutateLine\(edit\.slot, now, \{ kind: 'edit', text \}, \{ mode: edit\.mode, refusalId: edit\.id \}\)/);
  assert.match(ws, /refusedEdits\.filter\(\(edit\) => edit\.projectId === selectedId\)/, 'kept text stays with its project');
});

test('a save refused because the project was archived since the tab loaded shows the current state', () => {
  const ws = brief('BriefWorkspace.tsx');
  const fn = ws.slice(ws.indexOf('const mutateLine = useCallback'), ws.indexOf('const saveRefusedEdit'));
  assert.match(fn, /if \(apiErrorReason\(err\) === 'project_archived'\) setLocalRefresh\(\(n\) => n \+ 1\);/);
});
