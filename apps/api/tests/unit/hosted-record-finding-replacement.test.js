'use strict';

// The hosted half of tests/unit/record-finding-replacement.test.js.
//
// record_finding answered "Recorded debugging finding" whether it appended a
// note or deleted one. Notes that differ only by a date or a counter are ONE
// note by design (that is what stops an hourly run-log evicting every real
// finding), so a caller could file a finding, be told it was recorded, and lose
// a note it never asked about.
//
// The replacement is said in the TEXT only: structuredContent is held to the
// advertised output schema, which is frozen while a review is in flight.
//
// Drives the real dispatcher with the service layer stubbed.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');

let replaced = null;
let evicted = [];
service.resolveActiveProject = async () => ({ project_id: 'proj-1', project_name: 'Aurora' });
service.recordDebugFinding = async () => ({
  project_id: 'proj-1',
  project_name: 'Aurora',
  debugging_notes: [],
  replaced,
  evicted,
});

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');
const file = () => dispatchTool(
  'record_debug_finding',
  { project_id: 'proj-1', summary: 'Growth run 2026-09-20 08:00 finished: 5 signups' },
  ACTOR,
  'claude_web',
);

beforeEach(() => {
  replaced = null;
  evicted = [];
});

test('an append still reads as a plain append', async () => {
  const result = await file();
  assert.strictEqual(textOf(result), 'Recorded debugging finding for Aurora.');
  assert.strictEqual(result.structuredContent.recorded, true);
});

test('a replacement is named, with the note that went', async () => {
  replaced = 'Growth run 2026-09-19 08:00 finished: 3 signups';
  const text = textOf(await file());
  assert.match(text, /Replaced an earlier note/, 'THE BUG: a write that deleted a note reported a plain success');
  assert.match(text, /Growth run 2026-09-19/);
});

test('a very long replaced note is clipped rather than reprinted whole', async () => {
  replaced = `The consent redirect drops the code query parameter ${'and '.repeat(200)}TAIL-MARKER`;
  const text = textOf(await file());
  assert.doesNotMatch(text, /TAIL-MARKER/);
  assert.match(text, /consent redirect/);
});

// An eviction is the OTHER way a note can disappear behind "Recorded": the log
// is capped, and the note that leaves has nothing to do with the one filed.
test('an eviction at the cap is named, with the note that went', async () => {
  evicted = ['The Stripe webhook retry is not idempotent'];
  const text = textOf(await file());
  assert.match(text, /The log is full/, 'THE BUG: a write that evicted a note reported a plain success');
  assert.match(text, /the oldest note was dropped to make room/);
  assert.match(text, /Stripe webhook retry/);
});

test('several evictions are counted, and only the first few are quoted', async () => {
  evicted = ['note one about auth', 'note two about billing', 'note three about queues', 'note four about search'];
  const text = textOf(await file());
  assert.match(text, /4 older notes were dropped/);
  assert.match(text, /note one about auth/);
  assert.doesNotMatch(text, /note four about search/, 'a full log must not answer with the whole log');
});

test('a replacement and an eviction in one write are both reported', async () => {
  replaced = 'Growth run 2026-09-19 08:00 finished: 3 signups';
  evicted = ['The consent redirect drops the code query parameter'];
  const text = textOf(await file());
  assert.match(text, /Replaced an earlier note/);
  assert.match(text, /The log is full/);
});
