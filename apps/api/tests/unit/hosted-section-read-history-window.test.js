'use strict';

// TWO READS OF ONE PROJECT DISAGREED ABOUT WHAT THE PLAN REMEMBERS.
//
// renderInjection applies the plan's memory window (Free: 90 days) and says what
// it left out. The SECTION read — recall({action:"context", sections:[…]}) —
// rendered straight off the stored context, so it served a Free account the
// decisions its own brief had just aged out. Whichever read you trust, the other
// one is lying, and the aged-out line is the upgrade surface the window exists
// for.
//
// Same helper, same rule, same fail-open: no entitlements means no window.
//
// Drives the real dispatcher with the service layer stubbed.

process.env.NODE_ENV = 'test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');

const OLD = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

let context = {};
const windowCalls = [];
let windowResult = null;

service.resolveActiveProject = async () => ({ project_id: 'proj-1', project_name: 'Aurora' });
service.getProject = async (actor, projectId) => ({ project_id: projectId, project_name: 'Aurora', context });
service.getGlobalContext = async () => null;

const realWindow = service.applyPlanHistoryWindow;
service.applyPlanHistoryWindow = async (actor, ctx) => {
  windowCalls.push(ctx);
  return windowResult || { context: ctx, agedOut: 0, days: null };
};

const { dispatchTool } = require('../../src/routes/mcp');

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1', scopes: ['context:read', 'context:write'] };
const textOf = (result) => result.content.map((c) => c.text).join('\n');
const read = () => dispatchTool('get_context', { project_id: 'proj-1', sections: ['decisions'] }, ACTOR, 'claude_web');

beforeEach(() => {
  context = {
    project_name: 'Aurora',
    recent_decisions: [
      { summary: 'Chose Postgres advisory locks for the scheduler', decided_at: OLD },
      { summary: 'Invite acceptance binds the workspace, not the personal org', decided_at: RECENT },
    ],
  };
  windowCalls.length = 0;
  windowResult = null;
});

test('the section read goes through the plan window, not around it', async () => {
  const text = textOf(await read());
  assert.equal(windowCalls.length, 1, 'THE BUG: this read never consulted the plan at all');
  assert.deepEqual(windowCalls[0], context, 'the stored context is what gets windowed');
  // Nothing aged out here, so the reply reads exactly as it did.
  assert.match(text, /advisory locks/);
  assert.match(text, /Invite acceptance/);
  assert.doesNotMatch(text, /history window/);
});

test('what the window removed is gone from the reply, and said', async () => {
  windowResult = {
    context: { ...context, recent_decisions: [context.recent_decisions[1]] },
    agedOut: 1,
    days: 90,
  };
  const text = textOf(await read());
  assert.doesNotMatch(text, /advisory locks/, 'the section read served what the brief had aged out');
  assert.match(text, /1 older entry is outside this plan's 90-day history window/);
  assert.match(text, /Nothing has been deleted/, 'the window hides, it never deletes');
});

// THE SENTENCE BELONGS TO THE SECTIONS THAT CAN AGE OUT.
//
// The window only ever trims recent_decisions, debugging_notes and shipped, and
// the sentence says entries "are not included above". On a read of the task and
// the stack it points at nothing: the caller goes looking for a loss that did
// not happen on this read, and an upgrade surface that appears on every read
// stops meaning anything.
test('a read of sections the window cannot trim does not mention the window', async () => {
  windowResult = {
    context: { ...context, recent_decisions: [context.recent_decisions[1]] },
    agedOut: 1,
    days: 90,
  };
  const text = textOf(await dispatchTool(
    'get_context',
    { project_id: 'proj-1', sections: ['task', 'stack'] },
    ACTOR,
    'claude_web',
  ));
  assert.doesNotMatch(text, /history window/, 'THE BUG: nothing above could have been windowed');
});

test('"all" still gets the sentence, because it asks for the windowed sections too', async () => {
  windowResult = {
    context: { ...context, recent_decisions: [context.recent_decisions[1]] },
    agedOut: 1,
    days: 90,
  };
  const text = textOf(await dispatchTool('get_context', { project_id: 'proj-1', sections: ['all'] }, ACTOR, 'claude_web'));
  assert.match(text, /history window/);
});

test('the window helper fails open for an actor with no billable workspace', async () => {
  // Same rule renderInjection follows: an unbilled or internal actor, or a
  // lookup that errors, means no window at all. A billing hiccup must never
  // degrade a paying customer's brief into Free's.
  const result = await realWindow({ type: 'system', scopes: ['*'] }, context);
  assert.equal(result.agedOut, 0);
  assert.equal(result.days, null);
  assert.deepEqual(result.context, context);
});
