// POST /api/v1/product-events is optionalAuth: anybody may call it, and
// everything that identifies the event is a string the caller typed.
//
// Two of those strings were dangerous together. `metadata` was relayed to PostHog
// verbatim, `$set` included, and the distinct id was the caller's own session_id.
// So ONE unauthenticated request — session_id set to a real person's user id,
// metadata { $set: { is_test: true } } — marked that person a test account, and
// every funnel in the company filters test accounts out. The third string,
// session_id again, let a signed-in caller adopt somebody else's pre-auth rows.

const test = require('node:test');
const assert = require('node:assert');

const posthog = require('../../src/services/posthog');
const captures = [];
posthog.captureProductEvent = (payload) => { captures.push(payload); };

const db = require('../../src/config/db');
const { recordProductEvent } = require('../../src/services/productEventsService');

async function record(actor, event, context) {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [] });
  try {
    return await recordProductEvent(actor, event, context);
  } finally {
    db.query = originalQuery;
  }
}

test('an anonymous caller cannot set person properties', async () => {
  captures.length = 0;
  await record(null, {
    event_name: 'signup_modal_opened',
    source: 'marketing',
    session_id: 'sess-ordinary-visitor',
    metadata: {
      anonymous_id: 'b1946ac9-2f1b-4a8e-9c55-0d6a7c1e2f30',
      cta_location: 'nav',
      $set: { is_test: true },
      $set_once: { plan: 'enterprise' },
      $unset: ['email'],
    },
  });
  const props = captures[0].properties;
  assert.ok(!('$set' in props), 'THE BUG: a caller-supplied $set reached PostHog and rewrites person properties');
  assert.ok(!('$set_once' in props));
  assert.ok(!('$unset' in props));
  assert.equal(props.cta_location, 'nav', 'ordinary metadata must still be relayed');
});

test('an anonymous caller naming a real user id is not filed under that user', async () => {
  for (const victim of ['user-3f6c2f0e-1111-4222-8333-444455556666', 'user_2abCDefGhIjKlMnOpQrStUvWx', 'org-3f6c2f0e-1111-4222-8333-444455556666']) {
    captures.length = 0;
    await record(null, { event_name: 'oauth_consent_viewed', source: 'dashboard', session_id: victim });
    assert.notEqual(captures[0].distinctId, victim, `THE BUG: an unauthenticated request was attributed to ${victim}`);
    assert.match(captures[0].distinctId, /^anon_[0-9a-f]{32}$/);
    assert.equal(captures[0].properties.$process_person_profile, false);
  }
});

test('an ordinary anonymous visitor keeps the identity the funnel stitches on', async () => {
  captures.length = 0;
  await record(null, {
    event_name: 'signup_modal_opened',
    source: 'marketing',
    metadata: { anonymous_id: 'b1946ac9-2f1b-4a8e-9c55-0d6a7c1e2f30' },
  });
  assert.equal(captures[0].distinctId, 'b1946ac9-2f1b-4a8e-9c55-0d6a7c1e2f30');
  assert.notEqual(captures[0].properties.$process_person_profile, false);
});

test('a signed-in actor is identified by the actor, whatever session id they send', async () => {
  captures.length = 0;
  await record(
    { type: 'user', id: 'user-real', org_id: 'org-real' },
    { event_name: 'mcp_config_copied', source: 'dashboard', session_id: 'user-somebody-else' },
  );
  assert.equal(captures[0].distinctId, 'user-real');
});

// Session adoption is proven against a real table in
// tests/integration/product-events-session-adoption.test.js.
