'use strict';

// THE SAME WINDOW, ON THE OTHER TWO SECTION READS.
//
// #509 put the plan's memory window on the hosted section read and left the two
// REST ones (GET /projects/:id/inject?sections=… and GET /active?sections=…,
// which the dashboard and the local MCP server call) rendering straight off the
// stored context. So a Free account got its aged-out decisions back by asking a
// different surface for the same project — three reads, two answers, and the
// aged-out line is the whole point of the window.
//
// Route-level, with the service stubbed: this is about which reads consult the
// window, not about what the window computes.

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/contextSyncService');

const OLD = new Date(Date.now() - 200 * 24 * 60 * 60 * 1000).toISOString();
const RECENT = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();

let context = {};
const windowCalls = [];
let windowResult = null;

service.getProject = async (actor, projectId) => ({ project_id: projectId, project_name: 'Aurora', context });
service.getGlobalContext = async () => null;
service.resolveActiveProject = async () => ({
  project_id: 'proj-1', project_name: 'Aurora', context, updated_at: RECENT,
});
service.applyPlanHistoryWindow = async (actor, ctx) => {
  windowCalls.push(ctx);
  return windowResult || { context: ctx, agedOut: 0, days: null };
};

const request = require('supertest');
const app = require('../../src/app');
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', API_KEY);

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

const READS = [
  ['a named project', () => auth(request(httpServer).get('/api/v1/context/projects/proj-1/inject')).query({ sections: 'decisions' })],
  ['the active project', () => auth(request(httpServer).get('/api/v1/context/active')).query({ sections: 'decisions' })],
];

for (const [label, send] of READS) {
  test(`the section read of ${label} goes through the plan window`, async () => {
    const res = await send();
    assert.equal(res.status, 200);
    assert.equal(windowCalls.length, 1, 'THE BUG: this read never consulted the plan at all');
  });

  test(`what the window removed is gone from the ${label} reply, and said`, async () => {
    windowResult = {
      context: { ...context, recent_decisions: [context.recent_decisions[1]] },
      agedOut: 1,
      days: 90,
    };
    const res = await send();
    const body = res.body?.payload?.body || res.body?.brief || '';
    assert.doesNotMatch(body, /advisory locks/, 'the section read served what the brief had aged out');
    assert.match(body, /1 older entry is outside this plan's 90-day history window/);
    assert.match(body, /Nothing has been deleted/, 'the window hides, it never deletes');
  });
}

test('a read of sections the window cannot trim does not mention the window', async () => {
  windowResult = {
    context: { ...context, recent_decisions: [context.recent_decisions[1]] },
    agedOut: 1,
    days: 90,
  };
  const res = await auth(request(httpServer).get('/api/v1/context/projects/proj-1/inject')).query({ sections: 'task,stack' });
  assert.doesNotMatch(res.body?.payload?.body || '', /history window/);
});
