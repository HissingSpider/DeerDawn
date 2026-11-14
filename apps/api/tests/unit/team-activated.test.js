const test = require('node:test');
const assert = require('node:assert');

const db = require('../../src/config/db');
const productEvents = require('../../src/services/productEventsService');
const svc = require('../../src/services/sessionCatchupService');

// team_activated is the metric three gates in the profitability plan are written
// against — Oct 15 asks for three of them — and until this shipped nothing
// produced it, so there was no way to answer.
//
// It means one thing and must not be satisfiable by anything else: two DISTINCT
// people, each of whose agent reached this server, inside the same seven days,
// in the same workspace. Seats sold, invites sent and logins all do not count. A
// team that bought five seats and never connected has not activated, and these
// tests exist to keep that true when someone later wants the number to go up.

const ACTOR = { type: 'user', id: 'user-1', org_id: 'org-personal', workspace_key: 'org-acme' };

function withStubs({ already = false, members = 0 }, run) {
  const originalQuery = db.queryBestEffort;
  const originalRecord = productEvents.recordProductEvent;
  const captured = { queries: [], events: [] };
  db.queryBestEffort = async (text, params, orgId) => {
    captured.queries.push({ text, params, orgId });
    return { rows: [{ already, members }] };
  };
  productEvents.recordProductEvent = async (actor, input) => {
    captured.events.push(input);
    return input;
  };
  return (async () => {
    try {
      return await run(captured);
    } finally {
      db.queryBestEffort = originalQuery;
      productEvents.recordProductEvent = originalRecord;
    }
  })();
}

test('two people in the window activates the workspace', async () => {
  await withStubs({ already: false, members: 2 }, async (captured) => {
    const emitted = await svc.maybeEmitTeamActivated(ACTOR, { tool: 'claude_code' });
    assert.equal(emitted, true);
    assert.equal(captured.events.length, 1);
    const ev = captured.events[0];
    assert.equal(ev.event_name, 'team_activated');
    assert.equal(ev.surface, 'claude_code');
    assert.equal(ev.metadata.members, 2);
    assert.equal(ev.metadata.window_days, 7);
    // The workspace is on the event, so the number can be attributed to a team
    // rather than to whichever member happened to trigger the check.
    assert.equal(ev.metadata.workspace, 'org-acme');
  });
});

test('one person is not a team, however many sessions they run', async () => {
  // The whole point. A solo account dogfooding all day must never register.
  await withStubs({ already: false, members: 1 }, async (captured) => {
    assert.equal(await svc.maybeEmitTeamActivated(ACTOR, { tool: 'claude_code' }), false);
    assert.equal(captured.events.length, 0);
  });
});

test('a workspace nobody has used does not activate', async () => {
  await withStubs({ already: false, members: 0 }, async (captured) => {
    assert.equal(await svc.maybeEmitTeamActivated(ACTOR, {}), false);
    assert.equal(captured.events.length, 0);
  });
});

test('it fires once and then stays quiet', async () => {
  // The emitted event is its own idempotence marker, like every other milestone
  // here. Without this a busy team re-emits on every session and the gate counts
  // sessions rather than teams.
  await withStubs({ already: true, members: 5 }, async (captured) => {
    assert.equal(await svc.maybeEmitTeamActivated(ACTOR, {}), false);
    assert.equal(captured.events.length, 0);
  });
});

test('it counts the BOUND workspace, not the caller’s own org', async () => {
  await withStubs({ already: false, members: 2 }, async (captured) => {
    await svc.maybeEmitTeamActivated(ACTOR, {});
    const q = captured.queries[0];
    // An invited teammate's actor still carries their personal org; keying off
    // that would count them in the wrong workspace and the team would never
    // reach two.
    assert.equal(q.params[0], 'org-acme');
    assert.notEqual(q.params[0], 'org-personal');
    assert.equal(q.orgId, 'org-acme');
  });
});

test('the query asks the only question that means anything', async () => {
  await withStubs({ already: false, members: 2 }, async (captured) => {
    await svc.maybeEmitTeamActivated(ACTOR, {});
    const sql = captured.queries[0].text.replace(/\s+/g, ' ');

    assert.match(sql, /COUNT\(DISTINCT user_id\)/,
      'two sessions by one person are not two people');
    assert.match(sql, /FROM context_session_loads/,
      'counted from session loads: the activation events are once-per-user-ever '
      + 'and cannot express a rolling window');
    assert.match(sql, /user_id IS NOT NULL/,
      'legacy key-authed loads carry a null user_id, and COUNT(DISTINCT) folds '
      + 'every one of them into a single phantom member — a solo account with '
      + 'old rows would activate as a team of two');
    assert.match(sql, /make_interval\(days => \$2\)/,
      'the window is a bound parameter, not a literal pasted into SQL');
    assert.equal(captured.queries[0].params[1], 7);
  });
});

test('a credential without a workspace cannot activate anything', async () => {
  await withStubs({ already: false, members: 9 }, async (captured) => {
    assert.equal(await svc.maybeEmitTeamActivated(null, {}), false);
    assert.equal(await svc.maybeEmitTeamActivated({}, {}), false);
    assert.equal(captured.queries.length, 0, 'it must not even ask');
  });
});

test('a database wobble never blocks the brief', async () => {
  // queryBestEffort can return an empty result when the breaker is open. The
  // caller is a brief someone is waiting for, so the only acceptable behaviour
  // is to skip the metric.
  const originalQuery = db.queryBestEffort;
  const originalRecord = productEvents.recordProductEvent;
  let emittedAnything = false;
  db.queryBestEffort = async () => ({ rows: [] });
  productEvents.recordProductEvent = async () => { emittedAnything = true; };
  try {
    assert.equal(await svc.maybeEmitTeamActivated(ACTOR, {}), false);
    assert.equal(emittedAnything, false);
  } finally {
    db.queryBestEffort = originalQuery;
    productEvents.recordProductEvent = originalRecord;
  }
});

test('the owner+time index the hot path depends on exists', async () => {
  // This runs on every start_session. The two pre-existing indexes cannot serve
  // it — one has project_id between owner_key and created_at, the other has no
  // owner at all — so without a dedicated index it scans every row a workspace
  // has ever written. That is the shape that has tripped the DB circuit breaker
  // three times on context_graph_*.
  const fs = require('fs');
  const path = require('path');
  const store = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'src', 'store', 'contextSyncStore.js'),
    'utf8',
  );
  assert.match(
    store,
    /idx_context_session_loads_owner_time ON context_session_loads\(owner_key, created_at DESC\)/,
    'team_activated needs an owner-leading, time-second index',
  );
});
