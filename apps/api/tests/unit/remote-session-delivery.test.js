const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const productEvents = require('../../src/services/productEventsService');
const svc = require('../../src/services/sessionCatchupService');

// The hosted transport (Claude.ai / ChatGPT / any remote connector) answers
// start_session from getWorkspaceOverview and never touches renderInjection —
// the only place context_delivered and first_sync_completed are emitted. That
// made activation structurally unreachable from every no-install surface: a
// user could authorize, call start_session, receive their whole workspace, and
// never appear as activated. The three users in the 2026-08 warm list who hit
// mcp_runtime_started with no first sync were all hosted; one had TWO
// successful start_session calls.
//
// These pin the emit SET, which is the part that was wrong — not the wording of
// any call site.

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-1' };

// Both milestone emitters gate on an EXISTS check against product_events, so
// `already: false` means "first time" and drives the full emit set.
function withStubs({ already = false } = {}, run) {
  const originalQuery = db.queryBestEffort;
  const originalRecord = productEvents.recordProductEvent;
  const events = [];
  db.queryBestEffort = async () => ({ rows: [{ already, email: null, click_id: null }] });
  productEvents.recordProductEvent = async (actor, input) => {
    events.push(input);
    return input;
  };
  return (async () => {
    try {
      return await run(events);
    } finally {
      db.queryBestEffort = originalQuery;
      productEvents.recordProductEvent = originalRecord;
    }
  })();
}

// recordRemoteSessionDelivery is fire-and-forget by design (telemetry must never
// add latency to a tool call), so let the emitters' promises settle before
// asserting on what landed.
const settle = () => new Promise((resolve) => setImmediate(resolve));

test('a hosted start_session that returns real context emits the full activation set', async () => {
  await withStubs({ already: false }, async (events) => {
    svc.recordRemoteSessionDelivery(ACTOR, {
      surface: 'claude_web',
      projectId: 'project_1',
      delivered: true,
    });
    await settle();
    const names = events.map((e) => e.event_name).sort();
    assert.deepEqual(
      names,
      ['connection_established', 'context_delivered', 'first_sync_completed'],
      'context reaching a hosted tool is a real sync — this is the whole defect',
    );

    const delivered = events.find((e) => e.event_name === 'context_delivered');
    assert.equal(delivered.surface, 'claude_web', 'surface separates hosted from local');
    assert.equal(
      delivered.source,
      'context_sync',
      'NOT source=mcp: a query filtering context_delivered by source must see hosted deliveries too',
    );
    assert.equal(delivered.metadata.project_id, 'project_1');
    assert.equal(delivered.metadata.scope, 'workspace_overview');

    const firstSync = events.find((e) => e.event_name === 'first_sync_completed');
    assert.equal(firstSync.surface, 'claude_web');
  });
});

test('an empty hosted workspace records the connection but never claims a sync', async () => {
  await withStubs({ already: false }, async (events) => {
    svc.recordRemoteSessionDelivery(ACTOR, {
      surface: 'chatgpt_web',
      projectId: null,
      delivered: false,
    });
    await settle();
    const names = events.map((e) => e.event_name);
    assert.deepEqual(names, ['connection_established'], 'nothing was delivered, so nothing was synced');
    assert.ok(
      !names.includes('first_sync_completed'),
      'a false activation is worse than a missing one — it would hide the real funnel',
    );
    assert.ok(!names.includes('context_delivered'));
  });
});

test('the milestones stay once-per-user on a repeat hosted session', async () => {
  // already:true is what the EXISTS check returns once the markers are in the
  // event store. context_delivered is per-session and must still fire; the two
  // milestones must not.
  await withStubs({ already: true }, async (events) => {
    svc.recordRemoteSessionDelivery(ACTOR, {
      surface: 'claude_web',
      projectId: 'project_1',
      delivered: true,
    });
    await settle();
    const names = events.map((e) => e.event_name);
    assert.deepEqual(names, ['context_delivered'], 'only the per-session event repeats');
  });
});

test('telemetry failure can never break a tool call', async () => {
  const originalQuery = db.queryBestEffort;
  const originalRecord = productEvents.recordProductEvent;
  db.queryBestEffort = async () => { throw new Error('db down'); };
  productEvents.recordProductEvent = async () => { throw new Error('sink down'); };
  try {
    assert.doesNotThrow(() => {
      svc.recordRemoteSessionDelivery(ACTOR, { surface: 'claude_web', projectId: null, delivered: true });
    });
    await settle();
    await settle();
  } finally {
    db.queryBestEffort = originalQuery;
    productEvents.recordProductEvent = originalRecord;
  }
});
