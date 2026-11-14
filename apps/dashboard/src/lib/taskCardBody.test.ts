/**
 * A task card's body — the rules, run against real inputs.
 *
 * These assert BEHAVIOUR. The structural half (which component may render a
 * body, and that the board does not) is next door in
 * `tests/task-card-body-contract.test.js`, because a suite that reads source
 * text can pin a class name but can never tell you what a save decided.
 *
 * The last section pins this module to packages/shared-context, which owns the
 * three server rules this UI makes promises about. Each one fails silently: a
 * clip that is not mentioned reads as a complete save, a title that matches two
 * cards writes to the wrong one, and an emptied body returns 200 and changes
 * nothing. If shared-context moves, these fail here rather than in production.
 *
 * Run: `npx tsx --test src/lib/taskCardBody.test.ts`
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  BODY_CLEAR_NOTE,
  BODY_DUPLICATE_NOTE,
  BODY_STEP_NOTE,
  BODY_UNMATCHED_NOTE,
  TASK_BODY_MARKER_LABEL,
  TASK_BODY_MAX_CHARS,
  TASK_BODY_MAX_LABEL,
  bodyLengthNote,
  bodySavedNotice,
  clipTaskBody,
  planBodySave,
  resolveBodyTarget,
  taskBodyIsAtLimit,
  taskBodyWouldClip,
  type StoredTaskCard,
} from './taskCardBody';

const stored = (id: string, title: string, body?: string): StoredTaskCard => ({ id, title, body });

// ── Clipping is never silent ─────────────────────────────────────────────────

test('a body over the cap is clipped, not rejected — and the clip is visible', () => {
  const long = 'x'.repeat(TASK_BODY_MAX_CHARS + 500);
  const clipped = clipTaskBody(long);
  assert.equal(clipped.length, TASK_BODY_MAX_CHARS, 'the stored body must land exactly on the cap');
  assert.ok(clipped.endsWith('…'), 'the clip marks itself');
  assert.equal(taskBodyWouldClip(long), true);
  assert.equal(taskBodyIsAtLimit(clipped), true, 'a stored clipped body is recognisable when read back');
});

test('a body at the cap exactly is left alone', () => {
  const exact = 'y'.repeat(TASK_BODY_MAX_CHARS);
  assert.equal(clipTaskBody(exact), exact);
  assert.equal(taskBodyWouldClip(exact), false);
  assert.equal(taskBodyIsAtLimit(exact), false, 'an intact body must not claim it was cut');
});

test('the plan hands back what will be STORED, and says it was clipped', () => {
  // The failure this prevents: showing the typed text back with "Saved". The
  // server took 2,000 characters; the board would have shown 2,500 until the
  // next refetch quietly replaced them.
  const long = 'z'.repeat(TASK_BODY_MAX_CHARS + 1);
  const plan = planBodySave(long, null);
  assert.equal(plan.action, 'save');
  if (plan.action !== 'save') return;
  assert.equal(plan.clipped, true);
  assert.equal(plan.body.length, TASK_BODY_MAX_CHARS);
  assert.notEqual(plan.body, long.trim());
  assert.match(bodySavedNotice(true), /clipped/i, 'a clipped save must not toast a bare "saved"');
  assert.doesNotMatch(bodySavedNotice(false), /clipped/i);
});

test('the counter says where the cut lands before the save, not after', () => {
  const under = bodyLengthNote('a'.repeat(120));
  assert.equal(under.over, false);
  assert.equal(under.text, `120 / ${TASK_BODY_MAX_LABEL}`);

  const over = bodyLengthNote('a'.repeat(TASK_BODY_MAX_CHARS + 340));
  assert.equal(over.over, true);
  assert.match(over.text, /340 over the limit/);
  assert.match(over.text, new RegExp(`clips this to ${TASK_BODY_MAX_LABEL}`));
});

test('the length note uses no locale formatter', () => {
  // Same reason Today's proof line does not: these render, and a locale-formatted
  // number disagrees between server and client.
  assert.equal(TASK_BODY_MAX_LABEL, '2,000');
  assert.match(bodyLengthNote('a'.repeat(1500)).text, /^1,500 \//);
});

// ── The three saves that would silently do nothing ───────────────────────────

test('emptying a body is refused with the reason, never sent', () => {
  // `if (entry.body && …)` in the merge: an empty body normalizes to undefined
  // and is skipped. The request returns 200 and the body is still there.
  const plan = planBodySave('   ', 'the spec that is already stored');
  assert.equal(plan.action, 'blocked');
  if (plan.action !== 'blocked') return;
  assert.equal(plan.reason, 'clear_unsupported');
  assert.equal(plan.note, BODY_CLEAR_NOTE);
  assert.match(BODY_CLEAR_NOTE, /report success and change nothing/);
});

test('an unchanged body is a skip, not a write', () => {
  assert.deepEqual(planBodySave('  same text  ', 'same text'), { action: 'skip', reason: 'unchanged' });
  assert.deepEqual(planBodySave('', null), { action: 'skip', reason: 'empty' });
});

test('a real edit saves', () => {
  const plan = planBodySave('  line one\nline two  ', 'line one');
  assert.deepEqual(plan, { action: 'save', body: 'line one\nline two', clipped: false });
});

// ── Which card the write would actually hit ──────────────────────────────────

test('a title matching exactly one stored card is writable', () => {
  const items = [stored('todo-1', 'Ship the board body'), stored('todo-2', 'Something else')];
  assert.deepEqual(resolveBodyTarget(items, { id: 'todo-1', title: 'Ship the board body' }), {
    writable: true,
    title: 'Ship the board body',
  });
});

test('two cards sharing a title are refused — the write would pick one', () => {
  // The merge keys by lowercased title, so the LAST card with that title wins
  // and the body lands on a card the user was not looking at.
  const items = [stored('todo-1', 'Fix auth'), stored('todo-2', 'fix auth')];
  const target = resolveBodyTarget(items, { id: 'todo-1', title: 'Fix auth' });
  assert.equal(target.writable, false);
  if (target.writable) return;
  assert.equal(target.reason, 'duplicate_title');
  assert.equal(target.note, BODY_DUPLICATE_NOTE);
});

test('a card that is not in todo_items is refused — a save would file a new one', () => {
  // Legacy `completed_todos` entries render in Done but live outside todo_items,
  // and add_todos only ever looks at todo_items. Writing here creates a second
  // card in Backlog and leaves this one untouched.
  const target = resolveBodyTarget([stored('todo-1', 'On the board')], {
    id: 'legacy-9',
    title: 'Finished long ago',
  });
  assert.equal(target.writable, false);
  if (target.writable) return;
  assert.equal(target.reason, 'unmatched_title');
  assert.equal(target.note, BODY_UNMATCHED_NOTE);
});

test('a derived step card is refused — it has no stored card at all', () => {
  const target = resolveBodyTarget([stored('todo-1', 'Real card')], {
    id: 'step-0-write-the-migration',
    title: 'Write the migration',
    kind: 'step',
  });
  assert.equal(target.writable, false);
  if (target.writable) return;
  assert.equal(target.reason, 'derived_step');
  assert.equal(target.note, BODY_STEP_NOTE);
});

test('matching mirrors the merge: query trimmed, stored titles are not', () => {
  // normalizeTaskCardInputs trims the title it sends; the merge's byTitle map
  // does not trim what it stored. A stored title with stray whitespace therefore
  // never matches, and the save would file a new card — so it is refused.
  assert.equal(resolveBodyTarget([stored('t1', 'Padded ')], { id: 't1', title: '  Padded ' }).writable, false);
  assert.equal(resolveBodyTarget([stored('t1', 'Padded')], { id: 't1', title: '  Padded  ' }).writable, true);
});

// ── Pinned to packages/shared-context ────────────────────────────────────────

const REPO_ROOT = path.join(import.meta.dirname, '../../../..');
const sharedSource = fs.readFileSync(
  path.join(REPO_ROOT, 'packages/shared-context/src/index.js'),
  'utf8',
);

test('the cap matches MAX_TODO_BODY_CHARS in shared-context', () => {
  const match = sharedSource.match(/const MAX_TODO_BODY_CHARS = (\d+);/);
  assert.ok(match, 'MAX_TODO_BODY_CHARS is gone from shared-context — the cap moved');
  assert.equal(
    Number(match![1]),
    TASK_BODY_MAX_CHARS,
    'the dashboard counter promises a different cap than the server enforces',
  );
});

test('the clip algorithm matches normalizeTodoBody', () => {
  assert.match(
    sharedSource,
    /text\.slice\(0, MAX_TODO_BODY_CHARS - 1\)\}…/,
    'shared-context clips differently now — clipTaskBody shows the user the wrong stored text',
  );
});

test('the marker word matches the one every text surface uses', () => {
  const match = sharedSource.match(/const TASK_BODY_MARKER = '([^']+)';/);
  assert.ok(match, 'TASK_BODY_MARKER is gone from shared-context');
  assert.ok(
    match![1].includes(TASK_BODY_MARKER_LABEL),
    `the brief and both MCP listings mark a body as "${match![1].trim()}" — this UI says "${TASK_BODY_MARKER_LABEL}"`,
  );
});

test('a body still cannot be cleared by an add, so refusing it is still right', () => {
  // The day this stops being true, BODY_CLEAR_NOTE becomes the lie instead.
  assert.match(
    sharedSource,
    /if \(entry\.body && entry\.body !== existing\.body\)/,
    'the merge changed how it applies a body to an existing card — recheck whether clearing works now',
  );
});

test('the merge still matches an add by untrimmed lowercased title', () => {
  assert.match(
    sharedSource,
    /new Map\(nextTodoItems\.map\(t => \[String\(t\.title \|\| ''\)\.toLowerCase\(\), t\]\)\)/,
    'resolveBodyTarget mirrors this predicate — if it changed, the UI is guarding the wrong thing',
  );
});
