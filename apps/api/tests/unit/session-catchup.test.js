const test = require('node:test');
const assert = require('node:assert');
const {
  buildSinceLastSession,
  buildResumeHint,
  humanizeGap,
  renderCatchupText,
  buildPreviousLoad,
} = require('../../src/services/sessionCatchupService');

const HOUR = 3600000;
const DAY = 24 * HOUR;

test('humanizeGap phrases time coarsely and consistently', () => {
  assert.strictEqual(humanizeGap(2 * HOUR), 'earlier today');
  assert.strictEqual(humanizeGap(1 * DAY + HOUR), 'yesterday');
  assert.strictEqual(humanizeGap(3 * DAY), '3 days ago');
  assert.strictEqual(humanizeGap(21 * DAY), '3 weeks ago');
  assert.strictEqual(humanizeGap(90 * DAY), '3 months ago');
  assert.strictEqual(humanizeGap(-5), null);
  assert.strictEqual(humanizeGap(NaN), null);
});

test('buildSinceLastSession includes only items written after the previous session', () => {
  const last = new Date(Date.now() - 1 * DAY).toISOString();
  const before = new Date(Date.now() - 2 * DAY).toISOString();
  const after = new Date(Date.now() - 2 * HOUR).toISOString();
  const context = {
    shipped: [
      { summary: 'old thing', shipped_at: before },
      { summary: 'Stripe webhook handler — success + redirect done', shipped_at: after },
    ],
    recent_decisions: [
      { summary: 'jose over jsonwebtoken', decided_at: after },
      { summary: 'stale decision', decided_at: before },
    ],
    landmines: [{ summary: 'old landmine', added_at: before }],
  };
  const since = buildSinceLastSession(context, last);
  assert.deepStrictEqual(since.shipped, ['Stripe webhook handler — success + redirect done']);
  assert.deepStrictEqual(since.decided, ['jose over jsonwebtoken']);
  assert.deepStrictEqual(since.landmines, []);
});

test('buildSinceLastSession never pads: empty stays empty, stale write-backs excluded', () => {
  const last = new Date(Date.now() - 1 * DAY).toISOString();
  const stale = new Date(Date.now() - 5 * DAY).toISOString();
  // Everything was written BEFORE the previous session — the timestamp filter
  // is the stale-write-back guard: the delta must be empty, not misleading.
  const context = {
    shipped: [{ summary: 'shipped long ago', shipped_at: stale }],
    recent_decisions: [{ summary: 'decided long ago', decided_at: stale }],
    landmines: [],
  };
  const since = buildSinceLastSession(context, last);
  assert.deepStrictEqual(since, { shipped: [], decided: [], landmines: [] });
  // No previous session at all → no delta is even computable.
  assert.deepStrictEqual(
    buildSinceLastSession(context, null),
    { shipped: [], decided: [], landmines: [] }
  );
});

test('buildResumeHint prefers next_action, then task, then open question', () => {
  assert.strictEqual(
    buildResumeHint({ next_action: 'wire the redirect logic', current_task: 'webhooks' }),
    'Continue with: wire the redirect logic'
  );
  assert.strictEqual(
    buildResumeHint({ current_task: 'webhook handler', current_status: '70% done' }),
    'Pick up webhook handler (70% done)'
  );
  assert.strictEqual(
    buildResumeHint({ open_questions: ['retry strategy for failed webhooks'] }),
    'Open question: retry strategy for failed webhooks'
  );
  assert.strictEqual(buildResumeHint({}), null);
});

test('renderCatchupText: first session and <2h empty returns say nothing', () => {
  const base = {
    projectName: 'deerdawn-web',
    gapHuman: 'earlier today',
    since: { shipped: [], decided: [], landmines: [] },
    resumeHint: null,
    context: {},
  };
  // Session 1 — the brief itself is the payload; no catch-up header.
  assert.strictEqual(
    renderCatchupText({ ...base, load: { session_number: 1, first_session_at: null }, gapMs: HOUR }),
    null
  );
  // A 90-minute return with nothing new — goldfish suppression.
  assert.strictEqual(
    renderCatchupText({ ...base, load: { session_number: 5, first_session_at: null }, gapMs: 1.5 * HOUR }),
    null
  );
});

test('renderCatchupText: empty delta past 2h states nothing changed, honestly', () => {
  const text = renderCatchupText({
    projectName: 'deerdawn-web',
    load: { session_number: 5, first_session_at: new Date(Date.now() - 10 * DAY).toISOString() },
    gapMs: 1 * DAY,
    gapHuman: 'yesterday',
    since: { shipped: [], decided: [], landmines: [] },
    resumeHint: null,
    context: { current_task: 'webhook handler', current_status: 'redirect pending' },
  });
  assert.ok(text.includes('Session 5 on deerdawn-web'));
  assert.ok(text.includes('last session yesterday'));
  assert.ok(text.includes('Nothing new recorded'));
  assert.ok(text.includes('webhook handler'));
  // History is only 10 days old — the "context since <month>" fact stays quiet.
  assert.ok(!text.includes('context since'));
});

test('renderCatchupText: delta renders slots, open thread, and resume hint', () => {
  const text = renderCatchupText({
    projectName: 'deerdawn-web',
    load: { session_number: 48, first_session_at: new Date(Date.now() - 120 * DAY).toISOString() },
    gapMs: 1 * DAY,
    gapHuman: 'yesterday',
    since: {
      shipped: ['Stripe webhook handler — success + redirect done'],
      decided: ['jose over jsonwebtoken for JWT verify'],
      landmines: [],
    },
    resumeHint: 'Continue with: the redirect logic in the webhook handler',
    context: { current_task: 'Stripe webhook handler', current_status: 'redirect logic still pending' },
  });
  assert.ok(text.startsWith('Session 48 on deerdawn-web'));
  assert.ok(text.includes('context since'));
  assert.ok(text.includes('Since last session:'));
  assert.ok(text.includes('shipped: Stripe webhook handler — success + redirect done'));
  assert.ok(text.includes('decided: jose over jsonwebtoken for JWT verify'));
  assert.ok(!text.includes('landmine:'), 'empty slots must not render');
  assert.ok(text.includes('Still open: Stripe webhook handler — redirect logic still pending'));
  assert.ok(text.includes('Resume: Continue with: the redirect logic in the webhook handler'));
});

// ─── Thing 3a: where the last session was, and a task set since it ───────────
// A NEW field (previous_session), beside the pinned since_last_session.

test('buildPreviousLoad names the previous tool and a task set after it', () => {
  const last = new Date(Date.now() - 1 * DAY).toISOString();
  const load = { session_number: 2, last_session_at: last, last_tool: 'chatgpt_web' };
  const context = { current_task: 'get three quotes', current_task_set_at: new Date(Date.now() - HOUR).toISOString() };
  assert.deepStrictEqual(buildPreviousLoad(load, context), {
    at: last, tool: 'chatgpt_web', tool_label: 'ChatGPT', task_set_since: 'get three quotes',
  });
  // Set BEFORE the last session: not news. Finished: history. Unknown tool: unnamed.
  assert.strictEqual(buildPreviousLoad(load, { ...context, current_task_set_at: new Date(Date.now() - 2 * DAY).toISOString() }).task_set_since, null);
  assert.strictEqual(buildPreviousLoad(load, { ...context, task_progress: 'completed' }).task_set_since, null);
  assert.strictEqual(buildPreviousLoad({ ...load, last_tool: 'unknown_web' }, context).tool_label, null);
  // No previous session at all.
  assert.strictEqual(buildPreviousLoad({ session_number: 1, last_session_at: null }, context), null);
});

test('renderCatchupText: the header says where the last session was', () => {
  const text = renderCatchupText({
    projectName: 'Garden',
    load: { session_number: 2, first_session_at: null },
    gapMs: 3 * 60000,
    gapHuman: 'earlier today',
    since: { shipped: [], decided: ['tomatoes along the south fence'], landmines: [] },
    resumeHint: null,
    context: {},
    previousLoad: { tool: 'chatgpt_web', tool_label: 'ChatGPT', task_set_since: null },
  });
  assert.ok(text.startsWith('Session 2 on Garden — last session earlier today in ChatGPT.'), text);
  assert.ok(text.includes('decided: tomatoes along the south fence'));
});

test('renderCatchupText: a task set since the last session is news, said once', () => {
  const text = renderCatchupText({
    projectName: 'Kitchen',
    load: { session_number: 3, first_session_at: null },
    gapMs: 30 * 60000,
    gapHuman: 'earlier today',
    since: { shipped: [], decided: [], landmines: [] },
    resumeHint: null,
    context: { current_task: 'get three quotes' },
    previousLoad: { tool: null, tool_label: null, task_set_since: 'get three quotes' },
  });
  assert.ok(text, 'not suppressed as a quiet <2h return: something changed');
  assert.ok(text.startsWith('Session 3 on Kitchen — last session earlier today.'), text);
  assert.ok(text.includes('new task: get three quotes'));
  assert.ok(!text.includes('Still open:'), 'the task is not repeated as "still open"');
  assert.ok(!text.includes('Nothing new recorded'));
});
