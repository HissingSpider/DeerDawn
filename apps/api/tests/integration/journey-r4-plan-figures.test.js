/**
 * JOURNEY R4 — THE PLAN PAGES CAN SHOW WHAT THE PERSON PAYS.
 *
 * /settings/plan showed only the plan's name and status, and /settings/upgrade's
 * "Current plan" card told a monthly subscriber "$12/mo or $96/yr": the cycle
 * is read off the billing period (dashboard planCopy.billingCycleOnRecord), and
 * neither read carried the period's START, so a period ending within the month
 * could not be told from the last month of a year. The seats bought were not
 * sent either.
 *
 * The owner's decision: the pages show price, cycle, seats, renewal and trial
 * end from the subscription's current state, as the webhook stores it on the
 * workspace row; nothing new is fetched from Stripe on a page load. So both
 * reads now carry what the row already holds: the period's start and end, and
 * on GET /orgs/usage the purchased seat count. Additive; nothing else changes.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r4-plan-figures.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');

const START = '2026-09-19T10:00:00.000Z';
const END = '2026-10-19T10:00:00.000Z';

async function subscriber({ plan, seats }) {
  const orgId = `org-${uuidv4()}`;
  await q(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats,
       billing_period_start, billing_period_end, stripe_customer_id, stripe_subscription_id)
     VALUES ($1, $2, $3, $3, 'active', $4, $5, $6, $7, $8)`,
    [orgId, 'Figures workspace', plan, seats, START, END, `cus_${uuidv4().slice(0, 8)}`, `sub_${uuidv4().slice(0, 8)}`],
  );
  const userId = `user-${uuidv4()}`;
  const email = `figures-${uuidv4().slice(0, 8)}@e2e.test`;
  await q('INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId]);
  await workspace.ensureOwnerMembership(orgId, userId);
  return { orgId, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin', email }) };
}

const iso = (value) => (value ? new Date(value).toISOString() : value);

test('THE BUG: the bootstrap carries the start of the billing period, so the cycle can be read off it', async () => {
  const who = await subscriber({ plan: 'developer_basic', seats: null });
  const res = await request(httpServer).get('/api/v1/dashboard/bootstrap').set('Authorization', `Bearer ${who.jwt}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(iso(res.body.org.billing_period_start), START, 'THE BUG: a monthly subscriber\'s card said "$12/mo or $96/yr"');
  assert.equal(iso(res.body.org.billing_period_end), END, 'and the end, as before');
});

test('the plan page\'s read carries the period and the seats bought, from the workspace row', async () => {
  const who = await subscriber({ plan: 'developer_pro', seats: 3 });
  const res = await request(httpServer).get('/api/v1/orgs/usage').set('Authorization', `Bearer ${who.jwt}`);
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  const { plan } = res.body;
  assert.equal(iso(plan.billing_period_start), START);
  assert.equal(iso(plan.billing_period_end), END);
  assert.equal(plan.purchased_seats, 3);
  // Unchanged: the fields the page already read.
  assert.equal(plan.tier, 'developer_pro');
  assert.equal(plan.status, 'active');
  assert.equal(iso(plan.period_end), END);
});

test('a workspace with no seat count on record says so with null, not a guess', async () => {
  const who = await subscriber({ plan: 'developer_basic', seats: null });
  const res = await request(httpServer).get('/api/v1/orgs/usage').set('Authorization', `Bearer ${who.jwt}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.plan.purchased_seats, null);
});
