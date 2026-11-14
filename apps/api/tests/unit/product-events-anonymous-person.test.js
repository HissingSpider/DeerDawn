// An anonymous, attempt-scoped server event must not mint a PostHog person.
//
// Regression guard for the 2026-08-26 finding: `POST /auth/mcp/start` is
// anonymous by design and keys on a per-device-code session id, so every
// unauthorized attempt created a brand-new PostHog person carrying exactly one
// event and no properties — including no `is_test`. Over 30 days that put 11
// fictional "real users" onto the activation funnel (all of them the nightly
// production journey E2E), which read as "11 people started a device flow and
// none authorized" on the exact step the activation work targets.
//
// The event itself is real and stays. Only the person profile is suppressed.

const test = require('node:test');
const assert = require('node:assert');

// Patch the PostHog mirror BEFORE productEventsService destructures it at require
// time. Order matters: requiring the service first would bind the real function.
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

test('an anonymous per-attempt session id does not create a person', async () => {
  captures.length = 0;

  await record(null, {
    event_name: 'mcp_device_flow_started',
    source: 'mcp_auth',
    surface: 'device_flow',
    session_id: 'mcpdf-abc123',
  });

  assert.equal(captures.length, 1);
  assert.equal(captures[0].distinctId, 'mcpdf-abc123');
  assert.equal(
    captures[0].properties.$process_person_profile,
    false,
    'an attempt-scoped identity must not be promoted to a PostHog person'
  );
});

test('an identified actor still gets a full person profile', async () => {
  captures.length = 0;

  await record(
    { type: 'user', id: 'user-123', org_id: 'org-123' },
    {
      event_name: 'mcp_runtime_started',
      source: 'mcp',
      surface: 'claude_web',
      session_id: 'sess-123',
    }
  );

  assert.equal(captures.length, 1);
  assert.equal(captures[0].distinctId, 'user-123');
  assert.ok(
    !('$process_person_profile' in captures[0].properties),
    'identified events must keep person processing on'
  );
});

test('a pre-auth browser anonymous_id still gets a person profile', async () => {
  // The marketing funnel deliberately carries an anonymous_id so a visitor's
  // pre-signup journey and their account are one person. That is a real identity
  // being stitched, not a throwaway attempt, and must not be caught by the guard.
  captures.length = 0;

  await record(null, {
    event_name: 'signup_started',
    source: 'marketing',
    session_id: 'sess-xyz',
    metadata: { anonymous_id: 'anon-42' },
  });

  assert.equal(captures.length, 1);
  // distinctId precedence is user > session > anonymous_id, so the session id
  // wins here. What matters for this guard is the person profile, not the key.
  assert.equal(captures[0].distinctId, 'sess-xyz');
  assert.ok(
    !('$process_person_profile' in captures[0].properties),
    'a deliberately carried anonymous_id is an identity, not an attempt'
  );
});

// ── 2026-08-29: the other half of the same defect (E-013) ───────────────────
//
// The exemption directly above is correct and stays — but the dashboard's relay
// stamps `anonymous_id` on EVERY event from a localStorage uuid, so a driven
// browser was exempted along with the humans. Each automation run gets a fresh
// profile directory, so a fresh uuid, so a brand-new person; and because the
// surface it dies on is the SIGNED-OUT authorize screen, that person never
// identifies and never receives `is_test`. Six of the eleven "people" who
// reached `oauth_consent_viewed` in the 30 days to 2026-08-29 were exactly this.

test('anonymous automation does not create a person, even with an anonymous_id', async () => {
  captures.length = 0;

  await record(null, {
    event_name: 'oauth_consent_viewed',
    source: 'dashboard',
    surface: 'oauth_consent',
    session_id: 'sess-bot',
    metadata: { anonymous_id: 'anon-bot', is_automation: true, signed_in: 0 },
  });

  assert.equal(captures.length, 1);
  assert.equal(
    captures[0].properties.$process_person_profile,
    false,
    'a driven browser must not mint an unfilterable person'
  );
  assert.equal(
    captures[0].properties.is_automation,
    true,
    'the event itself is kept and stays flagged — only the person is suppressed'
  );
});

test('signed-in automation keeps its person, because is_test can filter it', async () => {
  // An automated run that actually signs in carries a real actor and is already
  // flagged `is_test` at the person level. Suppressing that person would break
  // the journey assertions that read it back, and buys nothing.
  captures.length = 0;

  await record(
    { type: 'user', id: 'user-bot', org_id: 'org-bot' },
    {
      event_name: 'oauth_consent_approved',
      source: 'dashboard',
      session_id: 'sess-bot',
      metadata: { anonymous_id: 'anon-bot', is_automation: true },
    }
  );

  assert.equal(captures.length, 1);
  assert.ok(
    !('$process_person_profile' in captures[0].properties),
    'an identified automated actor is filterable by is_test and keeps its person'
  );
});

test('a real signed-out human is untouched by the automation guard', async () => {
  // The exact case the guard must not catch: no user, no org, a browser
  // anonymous_id, and no automation flag. This is a person arriving at the
  // authorize screen signed out — the population E-011 exists to measure.
  captures.length = 0;

  await record(null, {
    event_name: 'oauth_consent_viewed',
    source: 'dashboard',
    session_id: 'sess-human',
    metadata: { anonymous_id: 'anon-human', signed_in: 0 },
  });

  assert.equal(captures.length, 1);
  assert.ok(
    !('$process_person_profile' in captures[0].properties),
    'a signed-out human still stitches to their browser person'
  );
});

test('the request user agent reaches the PostHog mirror', async () => {
  // Until now every relayed event arrived with no user agent at all, so the
  // whole activation funnel was undiagnosable by device and invisible to
  // E-010's crawler exclusion, which matches on UA.
  captures.length = 0;

  await record(
    null,
    {
      event_name: 'mcp_config_copied',
      source: 'dashboard',
      session_id: 'sess-ua',
      metadata: { anonymous_id: 'anon-ua' },
    },
    { userAgent: 'Mozilla/5.0 (Macintosh) Chrome/148.0.0.0 Safari/537.36' }
  );

  assert.equal(captures.length, 1);
  assert.equal(
    captures[0].properties.$raw_user_agent,
    'Mozilla/5.0 (Macintosh) Chrome/148.0.0.0 Safari/537.36'
  );
});

test('an absent user agent is omitted rather than sent as null', async () => {
  // posthog-node sends an explicit null for a null property, and a null
  // `$raw_user_agent` reads as a broken value rather than an absent one — the
  // same trap `$session_id` hit.
  captures.length = 0;

  await record(null, {
    event_name: 'mcp_config_copied',
    source: 'mcp',
    session_id: 'sess-noua',
  });

  assert.equal(captures.length, 1);
  assert.ok(
    !('$raw_user_agent' in captures[0].properties),
    'no user agent means no property, not a null one'
  );
});
