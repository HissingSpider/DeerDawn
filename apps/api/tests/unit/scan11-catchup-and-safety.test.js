'use strict';

// Round-11 scan, the pure halves: the catch-up after a confirmed finish_task, and
// the structuredContent key filter that stripped `tech_stack` from every hosted
// reply. No DB.

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResumeHint, renderCatchupText } = require('../../src/services/sessionCatchupService');
const { sanitizeToolResult, OPAQUE_STRUCTURED_FIELDS } = require('../../src/services/mcpSafety');

const HOUR = 3600000;
const DAY = 24 * HOUR;

// ─── 5. A finished task is not an open thread ───────────────────────────────

const FINISHED = {
  current_task: 'Ship the importer',
  current_status: 'Completed: Ship the importer',
  task_progress: 'completed',
  next_action: 'Run the importer against staging',
};

test('the catch-up does not tell you to resume a task you confirmed finished', () => {
  const text = renderCatchupText({
    projectName: 'deerdawn-web',
    load: { session_number: 7, first_session_at: new Date(Date.now() - 10 * DAY).toISOString() },
    gapMs: DAY,
    gapHuman: 'yesterday',
    since: { shipped: ['Ship the importer'], decided: [], landmines: [] },
    resumeHint: buildResumeHint(FINISHED),
    context: FINISHED,
  });
  assert.doesNotMatch(text, /Still open: Ship the importer/, `THE BUG: a finished task read as still open:\n${text}`);
  assert.doesNotMatch(text, /Resume: (Pick up|Continue with)/, `THE BUG: resume pointed back into finished work:\n${text}`);
});

test('the quiet catch-up says a finished task was finished, not "where you left it"', () => {
  const text = renderCatchupText({
    projectName: 'deerdawn-web',
    load: { session_number: 7, first_session_at: new Date(Date.now() - 10 * DAY).toISOString() },
    gapMs: DAY,
    gapHuman: 'yesterday',
    since: { shipped: [], decided: [], landmines: [] },
    resumeHint: null,
    context: FINISHED,
  });
  assert.doesNotMatch(text, /is where you left it/);
  assert.match(text, /was finished/);
});

test('an open task still resumes exactly as before', () => {
  const open = { ...FINISHED, task_progress: 'in_progress' };
  assert.strictEqual(buildResumeHint(open), 'Continue with: Run the importer against staging');
  assert.strictEqual(buildResumeHint({ current_task: 'Ship it' }), 'Pick up Ship it');
  // A finished task falls through to the open question, which is still open.
  assert.strictEqual(buildResumeHint({ ...FINISHED, open_questions: ['cron or queue?'] }), 'Open question: cron or queue?');
});

// ─── 2. The key filter: data keys survive, secrets still go ─────────────────

test('tech_stack, catalog, blog and changelog survive the sensitive-key filter', () => {
  const safe = sanitizeToolResult({
    content: [],
    structuredContent: { tech_stack: ['Node.js'], global_stack: ['Go'], catalog: 1, blog: 2, changelog: 3, backlog: 4 },
  });
  assert.deepStrictEqual(safe.structuredContent, { tech_stack: ['Node.js'], global_stack: ['Go'], catalog: 1, blog: 2, changelog: 3, backlog: 4 });
});

test('the filter still strips secrets, stacks, traces and logs by name', () => {
  const keys = ['access_token', 'apiSecret', 'user_password', 'cookie', 'authorization', 'raw_request', 'debug_object',
    'stackTrace', 'errorStack', 'stack_trace', 'callstack', 'trace', 'traceback', 'logs', 'log', 'auditLogs', 'request_log', 'debugLog'];
  const safe = sanitizeToolResult({ content: [], structuredContent: Object.fromEntries(keys.map((k) => [k, 'x'])) });
  for (const key of keys) assert.ok(!(key in safe.structuredContent), `${key} must still be stripped`);
  // Scan 13: a bare `stack` goes by what it HOLDS. A trace is stripped; a
  // technology ("Fastify", a graph edge's metadata.stack) is data. It used to be
  // stripped by name, which is what made export_trail redact ordinary stacks.
  const trace = sanitizeToolResult({ content: [], structuredContent: { stack: 'Error: x\n    at run (/srv/app.js:3:9)' } });
  assert.ok(!('stack' in trace.structuredContent), 'a bare stack holding a trace must still be stripped');
  const data = sanitizeToolResult({ content: [], structuredContent: { stack: 'Fastify' } });
  assert.strictEqual(data.structuredContent.stack, 'Fastify');
});

test('an opaque field passes through byte-for-byte; its siblings are still clamped', () => {
  const archive = { content: { brief: { tech_stack: ['a'] }, board: { cards: Array.from({ length: 150 }, (_, i) => ({ i })) } }, stack: 'kept inside the archive' };
  // The sibling was `stack: 'leak'`; since scan 13 a bare `stack` is judged by
  // its value, so the sibling is a key that is sensitive by name alone.
  const result = { content: [{ type: 'text', text: 'ok' }], structuredContent: { trail: archive, filename: 'x.dawn', errorStack: 'leak' } };
  result[OPAQUE_STRUCTURED_FIELDS] = ['trail'];
  const safe = sanitizeToolResult(result);
  assert.deepStrictEqual(safe.structuredContent.trail, archive);
  assert.strictEqual(safe.structuredContent.filename, 'x.dawn');
  assert.ok(!('errorStack' in safe.structuredContent), 'a sibling of the opaque field is still filtered');
  assert.deepStrictEqual(Object.keys(safe.structuredContent), ['trail', 'filename']);
  assert.ok(!Object.getOwnPropertySymbols(safe).includes(OPAQUE_STRUCTURED_FIELDS));
});

test('an opaque field over the size bound is dropped, not shipped unbounded', () => {
  const result = { content: [], structuredContent: { trail: { blob: 'x'.repeat(250_000) }, filename: 'x.dawn' } };
  result[OPAQUE_STRUCTURED_FIELDS] = ['trail'];
  const safe = sanitizeToolResult(result);
  assert.ok(!('trail' in safe.structuredContent));
  assert.strictEqual(safe.structuredContent.filename, 'x.dawn');
});
