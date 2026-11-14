/**
 * The one place a PostHog person ever gets an identity.
 *
 * `account_created` (Clerk `user.created` webhook) is the only emitter in this
 * repo that writes PERSON properties: `email`, `name`, `signup_method`,
 * `is_test`, and the `initial_*` first-touch attribution. It wrote them as
 * `metadata.$set` / `metadata.$set_once`.
 *
 * On 2026-09-19 the optionalAuth ingest route was hardened to drop every
 * `$`-prefixed key out of caller metadata — correct, and necessary: one
 * unauthenticated request could otherwise mark any real person `is_test` and
 * delete them from every funnel in the company. But `recordProductEvent` is
 * shared by the untrusted route and by trusted server-side emitters, so the
 * filter took the webhook's writes with it, silently.
 *
 * Measured: the 2026-09-21 journey E2E signed up, carried `is_test: true` on the
 * EVENT, and produced a PostHog person with no properties at all — no email, no
 * signup_method, no `is_test`. `coalesce(person.properties.is_test, false) =
 * false` is the predicate every growth query in this repo trusts (protocol
 * §6.2.1), so an automated run had become indistinguishable from a new customer.
 * No real signup landed inside the window, which is luck, not design.
 *
 * What is pinned here:
 *   1. A caller's `metadata.$set` is STILL dropped. The hardening is not undone.
 *   2. A server-built `context.personProperties` DOES reach PostHog. This is the
 *      assertion whose absence let the regression ship: nothing anywhere
 *      asserted that account_created identifies its person.
 *   3. The channel is the context, and the HTTP route never builds the context
 *      from the request body — so it is unreachable from outside.
 *   4. A suppressed person gets no `$set`: there is no profile to write to.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// Patch the mirror before productEventsService destructures it at require time.
const posthog = require('../../src/services/posthog');
const captures = [];
posthog.captureProductEvent = (payload) => { captures.push(payload); };

const db = require('../../src/config/db');
const { recordProductEvent } = require('../../src/services/productEventsService');

// These files explain the defects they fix in prose, so a source assertion could
// match its own documentation. Assert against code only.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

const readSrc = (...parts) =>
  stripComments(fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8'));

async function record(actor, event, context) {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [] });
  try {
    return await recordProductEvent(actor, event, context);
  } finally {
    db.query = originalQuery;
  }
}

test('a trusted caller can identify the person it just created', async () => {
  captures.length = 0;
  await record(
    { type: 'user', id: 'user-new', org_id: 'org-new' },
    { event_name: 'account_created', source: 'api', surface: 'clerk_webhook', metadata: { plan: 'free' } },
    {
      personProperties: {
        set: { email: 'someone@example.com', is_test: false, signup_method: 'password' },
        setOnce: { initial_plan: 'free', initial_utm_source: 'google', initial_device_type: 'mobile' },
      },
    },
  );
  const props = captures[0].properties;
  assert.deepEqual(
    props.$set,
    { email: 'someone@example.com', is_test: false, signup_method: 'password' },
    'THE REGRESSION: account_created reached PostHog without identifying its person, so every new account is property-less and unfilterable',
  );
  assert.equal(props.$set_once.initial_utm_source, 'google', 'first-touch attribution must survive the relay');
  assert.equal(props.$set_once.initial_device_type, 'mobile');
  assert.equal(props.plan, 'free', 'ordinary metadata is unaffected');
});

test('a test account is still flagged on the PERSON, not only on the event', async () => {
  captures.length = 0;
  await record(
    { type: 'user', id: 'user-journey', org_id: 'org-journey' },
    { event_name: 'account_created', source: 'api', surface: 'clerk_webhook', metadata: { is_test: true } },
    { personProperties: { set: { email: 'journey+clerk_test_x@deerdawn.com', is_test: true }, setOnce: { initial_plan: 'free' } } },
  );
  assert.equal(captures[0].properties.is_test, true, 'the event flag');
  assert.equal(
    captures[0].properties.$set.is_test,
    true,
    'the person flag — the event flag alone does not filter a journey run out of a person-level funnel query',
  );
});

test('the hardening is not undone: a caller-supplied $set is still dropped', async () => {
  captures.length = 0;
  await record(null, {
    event_name: 'signup_modal_opened',
    source: 'marketing',
    metadata: {
      anonymous_id: 'b1946ac9-2f1b-4a8e-9c55-0d6a7c1e2f30',
      cta_location: 'nav',
      $set: { is_test: true },
      $set_once: { plan: 'enterprise' },
    },
  });
  const props = captures[0].properties;
  assert.ok(!('$set' in props), 'a caller-supplied $set must never reach PostHog');
  assert.ok(!('$set_once' in props));
  assert.equal(props.cta_location, 'nav');
});

test('caller metadata cannot reach the person channel by naming it', async () => {
  captures.length = 0;
  await record(null, {
    event_name: 'signup_modal_opened',
    source: 'marketing',
    metadata: { anonymous_id: 'b1946ac9-2f1b-4a8e-9c55-0d6a7c1e2f30', personProperties: { set: { is_test: true } } },
    // deliberately NOT passed as context
  });
  assert.ok(!('$set' in captures[0].properties), 'personProperties is a context field; a metadata key of the same name must do nothing');
});

test('a person the service is suppressing is not also given properties', async () => {
  captures.length = 0;
  // Attempt-scoped identity: no user, no org, no anonymous_id — E-007's case.
  await record(null, { event_name: 'mcp_device_flow_started', source: 'api', session_id: 'devicecode-abc' }, {
    personProperties: { set: { is_test: true } },
  });
  const props = captures[0].properties;
  assert.equal(props.$process_person_profile, false);
  assert.ok(!('$set' in props), 'setting properties on a person the same event refuses to create asks PostHog for two contradictory things');
});

test('an empty or malformed bag writes nothing rather than an empty $set', async () => {
  for (const bag of [{}, [], 'email', null]) {
    captures.length = 0;
    await record(
      { type: 'user', id: 'user-x', org_id: 'org-x' },
      { event_name: 'account_created', source: 'api' },
      { personProperties: { set: bag } },
    );
    assert.ok(!('$set' in captures[0].properties), `a ${JSON.stringify(bag)} person bag must not be relayed`);
  }
});

test('the Clerk webhook passes person properties as context, not as metadata', () => {
  const src = readSrc('src', 'routes', 'auth-webhooks.js');
  assert.ok(
    /personProperties:\s*\{/.test(src),
    'account_created must identify its person through the context channel',
  );
  assert.ok(
    /set:\s*\{[^}]*is_test:\s*isTestAccount/.test(src),
    'is_test must be written to the PERSON, or a journey run reads as a real signup',
  );
  assert.ok(
    /setOnce:\s*\{\s*initial_plan/.test(src),
    'first-touch attribution must be $set_once, so a later visit cannot overwrite it',
  );
  assert.ok(
    !/metadata:\s*\{[^}]*\$set/.test(src),
    'person properties must not travel in metadata — that is the filtered channel',
  );
});
