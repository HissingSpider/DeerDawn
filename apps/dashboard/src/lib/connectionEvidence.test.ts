import test from 'node:test';
import assert from 'node:assert/strict';

import {
  connectionEvidence,
  connectionStatus,
  nextPollDelay,
  type ConnectionSignals,
} from './connectionEvidence';

/** A brand-new account that has done nothing at all. */
const nothing: ConnectionSignals = {
  mcpRegistered: false,
  hasFirstSync: false,
  runtimeVerified: false,
  hasProjects: false,
  recentlyActive: false,
};

test('a project is not a connection', () => {
  // The defect, in one case. A phone user lands on the capture-first step, types
  // two lines, and presses "Save my first brief". That POST creates a
  // context_projects row and touches its updated_at, so has_projects and
  // recently_active both go true — while no AI tool has been opened, let alone
  // connected. The connect step then read 'synced', fired
  // onboarding_connection_detected, auto-advanced, and reported
  // verified_connection: true on onboarding_completed.
  const savedABriefOnly: ConnectionSignals = {
    ...nothing,
    hasProjects: true,
    recentlyActive: true,
  };

  assert.equal(connectionEvidence(savedABriefOnly), 'none');
  assert.equal(connectionStatus(savedABriefOnly), 'waiting');
});

test('a dashboard write is not a connection even when the API calls it registered', () => {
  // Defence in depth: the API used to fold has_projects into mcp_registered, so
  // the flag itself lied. If that ever regresses, the two non-signals below must
  // still not be able to manufacture a connection on their own.
  assert.equal(
    connectionEvidence({ ...nothing, hasProjects: true, recentlyActive: true, mcpRegistered: false }),
    'none',
  );
});

test('an authenticated handshake or tool call is a connection', () => {
  // sync_health.mcp_registered is now exactly one thing: product_events rows with
  // source='mcp'. The hosted dispatcher writes mcp_runtime_started on initialize
  // and mcp_tool_call_succeeded / mcp_start_session_succeeded per call; the local
  // stdio server writes them only after auth resolves. Either way a real client
  // reached the server holding a real credential.
  assert.equal(connectionEvidence({ ...nothing, mcpRegistered: true }), 'handshake');
  assert.equal(connectionStatus({ ...nothing, mcpRegistered: true }), 'detected');
});

test('a locally verified runtime is a connection', () => {
  // `npx @deerdawn/mcp-server setup` verifies the runtime server-side before it
  // reports a count, so this is evidence of the same kind.
  assert.equal(connectionEvidence({ ...nothing, runtimeVerified: true }), 'handshake');
  assert.equal(connectionStatus({ ...nothing, runtimeVerified: true }), 'detected');
});

test('a delivered brief outranks a bare handshake', () => {
  // first_sync_completed is durable and once-per-user: a brief actually reached a
  // tool. It implies the connection and is the stronger claim, so it wins.
  assert.equal(connectionEvidence({ ...nothing, hasFirstSync: true }), 'first_sync');
  assert.equal(connectionStatus({ ...nothing, hasFirstSync: true }), 'synced');
  assert.equal(
    connectionEvidence({ ...nothing, hasFirstSync: true, mcpRegistered: true }),
    'first_sync',
  );
});

test('missing signals are absent, never assumed', () => {
  // The hook reads these off an API response that can 404, 401 or time out. An
  // undefined field must read as "no evidence", not as a truthy object.
  assert.equal(connectionEvidence({}), 'none');
  assert.equal(connectionStatus({}), 'waiting');
});

test('every status above waiting is backed by evidence', () => {
  // The invariant the emitter depends on: onboarding_connection_detected fires
  // the first time status leaves 'waiting', so there must be no way to leave
  // 'waiting' without a named piece of evidence to put in the payload.
  const fields: (keyof ConnectionSignals)[] = [
    'mcpRegistered',
    'hasFirstSync',
    'runtimeVerified',
    'hasProjects',
    'recentlyActive',
  ];
  for (let mask = 0; mask < 1 << fields.length; mask += 1) {
    const signals: ConnectionSignals = {};
    fields.forEach((field, i) => {
      signals[field] = Boolean(mask & (1 << i));
    });
    const status = connectionStatus(signals);
    const evidence = connectionEvidence(signals);
    assert.equal(
      status === 'waiting',
      evidence === 'none',
      `status/evidence disagree for ${JSON.stringify(signals)}`,
    );
  }
});

test('the connect step stops polling every four seconds once nobody is mid-setup', () => {
  assert.equal(nextPollDelay(0), 4_000);
  assert.equal(nextPollDelay(119_000), 4_000);
  assert.equal(nextPollDelay(3 * 60_000), 15_000);
  assert.equal(nextPollDelay(30 * 60_000), 60_000);
  // An hour on the step is at most a few dozen bootstraps, not nine hundred.
  let asks = 0;
  for (let t = 0; t < 60 * 60_000; t += nextPollDelay(t)) asks += 1;
  assert.ok(asks < 120, `still ${asks} bootstrap requests in an hour`);
});
