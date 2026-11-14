const test = require('node:test');
const assert = require('node:assert');
const Module = require('node:module');

/**
 * Replay linkage on server-relayed product events.
 *
 * The whole activation funnel — onboarding_page_viewed, mcp_setup_viewed,
 * mcp_config_copied, oauth_consent_viewed/approved, connection_established,
 * first_sync_completed — is mirrored into PostHog through recordProductEvent
 * with posthog-node. Session replay is ON in the dashboard, so the recordings
 * exist, but the mirrored events carried no `$session_id` and so no activation
 * drop-off could be opened as a replay.
 *
 * Measured 2026-08-25 over 21 days, real users only (person.is_test = false):
 * 13 people copied a connector config and 3 reached the OAuth consent screen.
 * The ten who stalled are the largest activation leak on the board and none of
 * them had a replay reachable from the funnel.
 *
 * `$session_id` is the ONLY property PostHog joins an event to its recording
 * on; a plain `posthog_session_id` property links nothing. These tests pin that
 * mapping, and pin that an absent id stays absent rather than becoming null.
 */

// Stub posthog + db before requiring the service, and capture what it relays.
const relayed = [];
const originalLoad = Module._load;
Module._load = function (request, _parent, _isMain) {
  if (request === './posthog') {
    return {
      captureProductEvent: (payload) => relayed.push(payload),
      captureException: () => {},
      aliasUser: () => {},
    };
  }
  return originalLoad.apply(this, arguments);
};

const db = require('../../src/config/db');
const { recordProductEvent } = require('../../src/services/productEventsService');
Module._load = originalLoad;

async function record(metadata) {
  relayed.length = 0;
  const originalQuery = db.query;
  db.query = async () => ({ rows: [] });
  try {
    await recordProductEvent(
      { type: 'user', id: 'user-1', org_id: 'org-1' },
      {
        event_name: 'mcp_config_copied',
        source: 'dashboard',
        surface: 'onboarding_mobile_first',
        path: '/onboarding',
        session_id: 'dd-session-1',
        metadata,
      }
    );
  } finally {
    db.query = originalQuery;
  }
  assert.equal(relayed.length, 1, 'expected exactly one PostHog relay');
  return relayed[0];
}

test('a forwarded posthog_session_id is relayed as $session_id', async () => {
  const call = await record({ device_type: 'mobile', posthog_session_id: 'ph-sess-abc' });
  assert.equal(
    call.properties.$session_id,
    'ph-sess-abc',
    '$session_id is the only property PostHog joins a replay on'
  );
});

test('the raw posthog_session_id is not also stored under its own name', async () => {
  const call = await record({ device_type: 'mobile', posthog_session_id: 'ph-sess-abc' });
  assert.equal(
    call.properties.posthog_session_id,
    undefined,
    'the same value must not be stored twice under two names'
  );
});

test('unrelated metadata still reaches PostHog untouched', async () => {
  const call = await record({
    device_type: 'mobile',
    tool: 'claude',
    posthog_session_id: 'ph-sess-abc',
  });
  assert.equal(call.properties.device_type, 'mobile');
  assert.equal(call.properties.tool, 'claude');
  assert.equal(call.properties.surface, 'onboarding_mobile_first');
  assert.equal(call.properties.source, 'dashboard');
  assert.equal(call.properties.path, '/onboarding');
});

test('no session id means the property is ABSENT, not null', async () => {
  // posthog-node would send an explicit null otherwise, and PostHog reads a
  // null $session_id as a real (broken) session rather than an absent one.
  const call = await record({ device_type: 'desktop' });
  assert.ok(
    !('$session_id' in call.properties),
    '$session_id must not be present at all when the browser sent none'
  );
});

test('an empty-string session id is treated as absent', async () => {
  const call = await record({ device_type: 'desktop', posthog_session_id: '' });
  assert.ok(!('$session_id' in call.properties), 'an empty string is not a session');
});

test('a non-string session id is rejected rather than forwarded', async () => {
  const call = await record({ device_type: 'desktop', posthog_session_id: 12345 });
  assert.ok(!('$session_id' in call.properties), 'only a non-empty string is a session id');
});

test('server-only events (MCP, no browser) relay unchanged', async () => {
  // The MCP server posts through the same path and has no browser, so it never
  // supplies a session id. It must keep working exactly as before.
  const call = await record({});
  assert.ok(!('$session_id' in call.properties));
  assert.equal(call.event, 'mcp_config_copied');
  assert.equal(call.distinctId, 'user-1');
  assert.equal(call.orgId, 'org-1');
});
