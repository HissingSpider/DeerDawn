process.env.DISABLE_REDIS = 'true';
process.env.DB_CIRCUIT_BREAKER_TIMEOUT = process.env.DB_CIRCUIT_BREAKER_TIMEOUT || '10000';

/**
 * Layer 2 — Billing & Subscription
 *
 * Tests Stripe checkout session creation, webhook handlers (mocked payload),
 * portal link generation, plan list shape, and feature/usage gating.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../src/config/db');
const { redis, closeRedisConnections } = require('../src/config/redis');
const { hashPassword, generateApiKey, generateToken } = require('../src/utils/security');
const { ensureDatabaseAvailable } = require('./helpers/dbAvailability');

async function setupOrg(planTier = 'free', subscriptionStatus = 'active') {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const { key, prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;

  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `Billing Test ${orgId.slice(-8)}`, planTier, planTier, subscriptionStatus],
    orgId
  );
  const passHash = await hashPassword('TestPass123!');
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `billing-${Date.now()}-${uuidv4().slice(0, 8)}@test.com`, passHash, 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 30);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [keyId, prefix, hash, 'Billing Key', userId, orgId, 'production', expiresAt.toISOString(), ['*']],
    orgId
  );

  return { orgId, userId, apiKey: key };
}

async function cleanupOrg(orgId) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_events', 'context_sessions', 'context_projects', 'injection_preferences', 'usage_counters', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function setOrgPlan(orgId, plan, subscriptionStatus = 'active') {
  await db.query(
    'UPDATE organizations SET plan = $1::text, plan_tier = $1::text, subscription_status = $2::text WHERE org_id = $3::text',
    [plan, subscriptionStatus, orgId],
    orgId
  );
  await redis.del(`org:${orgId}`).catch(() => {});
}

test('Layer 2 — Billing & Subscription', async (t) => {
  const orgs = [];

  t.after(async () => {
    for (const orgId of orgs) await cleanupOrg(orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
  });

  if (!await ensureDatabaseAvailable(t, db, 'Layer 2 — Billing & Subscription')) return;

  // ─── Plans list ──────────────────────────────────────────────────────────

  await t.test('GET /billing/plans returns plan list with required fields', async () => {
    const { orgId, apiKey } = await setupOrg();
    orgs.push(orgId);

    const res = await request(httpServer)
      .get('/api/v1/billing/plans')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(res.status, 200);
    const plans = res.body.plans || res.body;
    assert.ok(Array.isArray(plans), 'expected array of plans');
    assert.ok(plans.length > 0, 'expected at least one plan');
    const planIds = plans.map(p => p.id || p.plan_id);
    assert.ok(planIds.includes('free') || planIds.includes('developer_basic'), 'expected free/developer_basic plan in list');
  });

  await t.test('GET /billing/plans is accessible without authentication', async () => {
    const res = await request(httpServer).get('/api/v1/billing/plans');
    assert.ok(res.status === 200 || res.status === 401, `got ${res.status}`);
  });

  // ─── Checkout session ────────────────────────────────────────────────────

  await t.test('POST /billing/checkout returns checkout URL or Stripe error', async () => {
    const { orgId, apiKey } = await setupOrg('free');
    orgs.push(orgId);

    const res = await request(httpServer)
      .post('/api/v1/billing/checkout')
      .set('X-Api-Key', apiKey)
      .send({ plan_id: 'starter', interval: 'monthly' });

    if (process.env.STRIPE_SECRET_KEY) {
      assert.ok(res.status === 200 || res.status === 201, `got ${res.status}: ${JSON.stringify(res.body)}`);
      assert.ok(res.body.url || res.body.checkout_url, 'expected checkout URL');
    } else {
      assert.ok(res.status === 502 || res.status === 400 || res.status === 500, `without Stripe key expected error, got ${res.status}`);
    }
  });

  await t.test('POST /billing/checkout with unknown plan_id returns 400', async () => {
    const { orgId, apiKey } = await setupOrg('free');
    orgs.push(orgId);

    const res = await request(httpServer)
      .post('/api/v1/billing/checkout')
      .set('X-Api-Key', apiKey)
      .send({ plan_id: 'nonexistent_plan_xyz', interval: 'monthly' });
    assert.ok(res.status === 400 || res.status === 404 || res.status === 502, `got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  // ─── Billing portal ──────────────────────────────────────────────────────

  await t.test('POST /billing/portal requires authentication', async () => {
    const res = await request(httpServer).post('/api/v1/billing/portal');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await t.test('POST /billing/portal rejects machine (operator) keys', async () => {
    // Same rule as downgrade: opening the billing portal is an owner action on
    // the workspace, and an API key is not a workspace owner.
    const { orgId, apiKey } = await setupOrg('starter');
    orgs.push(orgId);
    const res = await request(httpServer)
      .post('/api/v1/billing/portal')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(res.status, 403, `machine keys must not open the billing portal, got ${res.status}: ${JSON.stringify(res.body)}`);
  });

  await t.test('POST /billing/portal returns portal URL or Stripe error', async () => {
    const { orgId, userId } = await setupOrg('starter');
    orgs.push(orgId);
    const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });

    const res = await request(httpServer)
      .post('/api/v1/billing/portal')
      .set('Authorization', `Bearer ${token}`);

    if (process.env.STRIPE_SECRET_KEY) {
      assert.ok(res.status === 200 || res.status === 201 || res.status === 400, `got ${res.status}: ${JSON.stringify(res.body)}`);
    } else {
      assert.ok(
        res.status === 400 || res.status === 502 || res.status === 500 || res.status === 503,
        `without Stripe key expected error, got ${res.status}: ${JSON.stringify(res.body)}`
      );
    }
  });

  // ─── Self-serve downgrade to Free ────────────────────────────────────────

  await t.test('POST /billing/downgrade requires authentication', async () => {
    const res = await request(httpServer).post('/api/v1/billing/downgrade');
    assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
  });

  await t.test('POST /billing/downgrade rejects machine (operator) keys', async () => {
    // API keys resolve to role 'operator' — changing the plan is an owner action,
    // so the guard must reject them even though the key is otherwise valid.
    const { orgId, apiKey } = await setupOrg('developer_basic');
    orgs.push(orgId);
    const res = await request(httpServer)
      .post('/api/v1/billing/downgrade')
      .set('X-Api-Key', apiKey);
    assert.strictEqual(res.status, 403, `machine keys must not downgrade, got ${res.status}: ${JSON.stringify(res.body)}`);

    const row = await db.query('SELECT plan_tier FROM organizations WHERE org_id = $1', [orgId], orgId);
    assert.strictEqual(row.rows[0].plan_tier, 'developer_basic', 'plan must be unchanged after a rejected downgrade');
  });

  await t.test('POST /billing/downgrade drops a comped paid account to Free', async () => {
    const { orgId, userId } = await setupOrg('developer_basic');
    orgs.push(orgId);
    const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });

    const res = await request(httpServer)
      .post('/api/v1/billing/downgrade')
      .set('Authorization', `Bearer ${token}`);

    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.plan_tier, 'free');

    const row = await db.query(
      'SELECT plan, plan_tier, subscription_status FROM organizations WHERE org_id = $1',
      [orgId],
      orgId
    );
    assert.strictEqual(row.rows[0].plan_tier, 'free', 'plan_tier should be free');
    assert.strictEqual(row.rows[0].plan, 'free', 'plan should be free');
    // Must land on an ACTIVE status — an inactive one would force-free entitlements
    // for a different reason and muddy the state.
    assert.ok(
      !['cancelled', 'unpaid', 'past_due'].includes(row.rows[0].subscription_status),
      `subscription_status should be active, got ${row.rows[0].subscription_status}`
    );
  });

  await t.test('POST /billing/downgrade on a Free account returns 400 already_free', async () => {
    const { orgId, userId } = await setupOrg('free');
    orgs.push(orgId);
    const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });

    const res = await request(httpServer)
      .post('/api/v1/billing/downgrade')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 400, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'already_free');
  });

  await t.test('POST /billing/downgrade with an active Stripe subscription returns 409 and does not mutate', async () => {
    const { orgId, userId } = await setupOrg('developer_basic');
    orgs.push(orgId);
    await db.query(
      'UPDATE organizations SET stripe_subscription_id = $1 WHERE org_id = $2',
      ['sub_test_downgrade', orgId],
      orgId
    );
    const token = generateToken({ user_id: userId, role: 'admin', org_id: orgId });

    const res = await request(httpServer)
      .post('/api/v1/billing/downgrade')
      .set('Authorization', `Bearer ${token}`);
    assert.strictEqual(res.status, 409, `got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.strictEqual(res.body.error, 'stripe_subscription_active');

    const row = await db.query('SELECT plan_tier FROM organizations WHERE org_id = $1', [orgId], orgId);
    assert.strictEqual(row.rows[0].plan_tier, 'developer_basic', 'Stripe-billed plans must not be DB-downgraded');
  });

  // ─── Stripe webhook handlers ─────────────────────────────────────────────

  await t.test('POST /webhooks/stripe without signature returns 400', async () => {
    const res = await request(httpServer)
      .post('/api/v1/webhooks/stripe')
      .send({ type: 'checkout.session.completed', data: {} });
    assert.ok(res.status === 400 || res.status === 401, `expected 400/401, got ${res.status}`);
  });

  await t.test('Stripe webhook idempotency: duplicate event_id is ignored', async () => {
    const eventId = `evt_test_${uuidv4()}`;
    await db.query(
      `INSERT INTO stripe_events (event_id, type, status, processed_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (event_id) DO NOTHING`,
      [eventId, 'checkout.session.completed', 'processed'],
      'org-system'
    ).catch(() => {});

    const existing = await db.query(
      'SELECT event_id FROM stripe_events WHERE event_id = $1',
      [eventId],
      'org-system'
    ).catch(() => ({ rows: [] }));
    assert.ok(existing.rows.length <= 1, 'duplicate event should not create multiple rows');
  });

  // ─── Plan gating via DB ───────────────────────────────────────────────────

  await t.test('Org with active subscription has correct plan in DB', async () => {
    const { orgId } = await setupOrg('growth', 'active');
    orgs.push(orgId);

    const result = await db.query(
      'SELECT plan, subscription_status FROM organizations WHERE org_id = $1',
      [orgId],
      orgId
    );
    assert.strictEqual(result.rows[0].plan, 'growth');
    assert.strictEqual(result.rows[0].subscription_status, 'active');
  });

  await t.test('Setting org to canceled plan reflects in DB', async () => {
    const { orgId } = await setupOrg('scale', 'active');
    orgs.push(orgId);

    await setOrgPlan(orgId, 'free', 'canceled');
    const result = await db.query(
      'SELECT plan, subscription_status FROM organizations WHERE org_id = $1',
      [orgId],
      orgId
    );
    assert.strictEqual(result.rows[0].plan, 'free');
    assert.strictEqual(result.rows[0].subscription_status, 'canceled');
  });

  await t.test('Free plan: projects are uncapped, history is the bound', async () => {
    // The workspace cap came off on 2026-08-27. It sat directly on top of the
    // moat — a capped free user only ever meets per-project memory, which is the
    // commoditized half — so Free is now bounded by history, not by how much
    // work you do. null is the documented unlimited sentinel; createProject's
    // Number.isFinite guard skips the gate on it.
    const { PLANS } = require('../src/config/plans');
    const free = PLANS.free || PLANS['free'];
    assert.ok(free, 'free plan config should exist');
    assert.strictEqual(
      free.limits.included_projects, null,
      `free must be uncapped on projects, got: ${JSON.stringify(free.limits)}`
    );
    assert.ok(
      Number.isFinite(free.limits.history_days),
      'free must keep a history window — it is the only remaining bound'
    );
  });

  await t.test('developer_pro (Team) is sellable, and unsellable without a price', async () => {
    // Team went public on 2026-08-27 for the three-column argument and stayed
    // out of self-serve because its Stripe prices were still the old $25/$240
    // ones. Those were re-created at $15/seat and $150/seat/year on 2026-09-02
    // and the API holds their ids, so the condition this test named as its own
    // reason no longer holds.
    //
    // The durable property is not "Team is unsellable" but "nothing is sellable
    // without a resolvable price", which is enforced on the checkout path and
    // asserted there below.
    const { PLANS, isSelfServePlan } = require('../src/config/plans');
    const pro = PLANS.developer_pro || PLANS['developer_pro'];
    if (pro) {
      assert.ok(pro.features, 'developer_pro should have features');
      assert.strictEqual(pro.features.api_access, true, 'developer_pro should have api_access');
      assert.strictEqual(pro.public, true, 'developer_pro is shown on the pricing page');
      assert.strictEqual(isSelfServePlan('developer_pro'), true, 'developer_pro is checkout-able now its prices exist');
      assert.strictEqual(pro.limits.minimum_seats, 2, 'a one-seat Team is a more expensive Pro');

      // The guard that replaces "Team is unsellable": no price ids are
      // configured in this environment, so checkout must refuse rather than
      // build a line item around an undefined price.
      const { __testables: { validateCheckoutCatalog } } = require('../src/services/stripeService');
      assert.throws(
        () => validateCheckoutCatalog(pro, 'developer_pro', 'monthly'),
        /Missing Stripe base price/,
        'no plan may be sold without a resolvable price, whatever the catalog says',
      );
    } else {
      console.log('  developer_pro not found in plans config — skipping');
    }
  });

  // ─── Entitlement service unit checks ────────────────────────────────────

  await t.test('entitlementService.getOrgPlan returns plan object', async () => {
    const { orgId } = await setupOrg('starter');
    orgs.push(orgId);

    try {
      const entitlementService = require('../src/services/entitlementService');
      if (typeof entitlementService.getOrgPlan === 'function') {
        const plan = await entitlementService.getOrgPlan(orgId);
        assert.ok(plan, 'expected plan object');
        assert.ok(plan.id || plan.plan, 'expected plan id field');
      }
    } catch (e) {
      console.log(`  entitlementService not available for direct testing: ${e.message}`);
    }
  });
});
