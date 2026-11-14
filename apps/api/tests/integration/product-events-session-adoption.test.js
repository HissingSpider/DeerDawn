/**
 * Pre-auth product events are adopted by the account that made them — not by
 * whoever names their session id.
 *
 * recordProductEvent back-fills org_id/user_id onto earlier anonymous rows that
 * share the event's session_id. session_id is caller-supplied on an optionalAuth
 * route, so that was a claim anybody signed in could make about anybody's
 * anonymous funnel. The browser's anonymous_id is the second factor.
 *
 * DB-backed: bash scripts/run-db-test.sh node --test tests/integration/product-events-session-adoption.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const posthog = require('../../src/services/posthog');
posthog.captureProductEvent = () => {};

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { recordProductEvent } = require('../../src/services/productEventsService');

const ORG = `org-${uuidv4()}`;
const USER = `user-${uuidv4()}`;

test.before(async () => {
  await db.query('INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)', [ORG, 'Adoption', 'active'], ORG);
  await db.query('INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)', [USER, `adopt-${uuidv4().slice(0, 8)}@test.com`, 'admin', ORG], ORG);
});

test.after(async () => {
  await db.query('DELETE FROM product_events WHERE org_id = $1 OR session_id LIKE $2', [ORG, 'sess-adopt-%'], 'org-system').catch(() => {});
  await db.query('DELETE FROM users WHERE org_id = $1', [ORG], ORG).catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [ORG], ORG).catch(() => {});
  await closeRedisConnections().catch(() => {});
});

async function ownerOf(sessionId, eventName) {
  const r = await db.query('SELECT org_id FROM product_events WHERE session_id = $1 AND event_name = $2', [sessionId, eventName], 'org-system');
  return r.rows[0]?.org_id ?? null;
}

const actor = () => ({ type: 'user', id: USER, org_id: ORG });

test('somebody else\'s anonymous rows are not adopted by naming their session id', async () => {
  const session = `sess-adopt-${uuidv4().slice(0, 8)}`;
  await recordProductEvent(null, { event_name: 'victim_pre_auth_step', source: 'marketing', session_id: session, metadata: { anonymous_id: 'anon-victim' } });

  await recordProductEvent(actor(), { event_name: 'attacker_signed_in_step', source: 'dashboard', session_id: session, metadata: { anonymous_id: 'anon-attacker' } });

  assert.equal(await ownerOf(session, 'victim_pre_auth_step'), null, 'THE BUG: a signed-in caller pulled another visitor\'s funnel into their own org');
});

test('your own pre-auth rows are still adopted when you sign in', async () => {
  const session = `sess-adopt-${uuidv4().slice(0, 8)}`;
  await recordProductEvent(null, { event_name: 'own_pre_auth_step', source: 'marketing', session_id: session, metadata: { anonymous_id: 'anon-me' } });
  await recordProductEvent(actor(), { event_name: 'own_signed_in_step', source: 'dashboard', session_id: session, metadata: { anonymous_id: 'anon-me' } });
  assert.equal(await ownerOf(session, 'own_pre_auth_step'), ORG);
});

test('the device flow, keyed by session id alone on both legs, is still stitched', async () => {
  const session = `sess-adopt-${uuidv4().slice(0, 8)}`;
  await recordProductEvent(null, { event_name: 'mcp_device_flow_started', source: 'mcp_auth', session_id: session });
  await recordProductEvent(actor(), { event_name: 'mcp_device_flow_authorized', source: 'mcp_auth', session_id: session });
  assert.equal(await ownerOf(session, 'mcp_device_flow_started'), ORG);
});
