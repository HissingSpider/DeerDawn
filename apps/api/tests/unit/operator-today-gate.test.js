/**
 * THE GATE on /api/v1/metrics/today, proven end to end against the live app.
 *
 * This route is the first cross-account READ of customer identity in the
 * product: it returns other people's email addresses, project names and
 * activity. Every other context route is scoped to `req.actor` and therefore
 * cannot leak across tenants even if its gate were wrong. This one can, so the
 * gate is not a detail of the route — it is the route's main safety property,
 * and it gets a behavioural test rather than a source-text assertion.
 *
 * The distinction that matters: `role = 'admin'` or `'owner'` is a TENANT role.
 * It is grantable by anyone who runs an org, and the schema comment says in so
 * many words that 'admin' is NOT a platform superuser. `is_platform_staff` is
 * the separate, non-grantable flag, seeded only from the PLATFORM_ADMIN_EMAILS
 * allowlist in autoMigrate. An org owner reaching this data would be a
 * cross-tenant disclosure, so that case is tested explicitly.
 *
 * Run: node --test tests/unit/operator-today-gate.test.js
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../../src/app');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { generateToken } = require('../../src/utils/security');

// One server for the file — see auth.middleware.test.js for why per-request
// listen()/close() churn produces spurious ETIMEDOUTs.
const httpServer = app.listen(0);

test('GET /api/v1/metrics/today is platform-staff only', async (t) => {
  const orgId = `org-${uuidv4()}`;
  const tenantOwnerId = `user-${uuidv4()}`;
  const tenantAdminId = `user-${uuidv4()}`;
  const staffId = `user-${uuidv4()}`;

  t.after(async () => {
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await closeRedisConnections();
    await db.pool.end();
    await new Promise((resolve) => httpServer.close(resolve));
  });

  await db.query(
    'INSERT INTO organizations (org_id, name, plan_tier, subscription_status) VALUES ($1, $2, $3, $4)',
    [orgId, 'Operator Today Gate Org', 'starter', 'active'],
    orgId
  );

  // Three users in ONE org, differing only in tenant role and the staff flag.
  const users = [
    [tenantOwnerId, `gate-owner-${Date.now()}@example.com`, 'owner', false],
    [tenantAdminId, `gate-admin-${Date.now()}@example.com`, 'admin', false],
    [staffId, `gate-staff-${Date.now()}@example.com`, 'owner', true],
  ];
  for (const [id, email, role, isStaff] of users) {
    await db.query(
      'INSERT INTO users (user_id, email, role, is_platform_staff, org_id) VALUES ($1, $2, $3, $4, $5)',
      [id, email, role, isStaff, orgId],
      orgId
    );
  }

  const tokenFor = (id, role) => generateToken({ user_id: id, role, org_id: orgId });

  await t.test('no credentials -> 401', async () => {
    const res = await request(httpServer).get('/api/v1/metrics/today');
    assert.equal(res.status, 401);
  });

  await t.test('a tenant OWNER -> 403, not customer data', async () => {
    const res = await request(httpServer)
      .get('/api/v1/metrics/today')
      .set('Authorization', `Bearer ${tokenFor(tenantOwnerId, 'owner')}`);
    assert.equal(res.status, 403, 'an org owner must not read across tenants');
    assert.equal(res.body.error, 'forbidden');
    assert.equal(res.body.people, undefined, 'no rows may leak on the refusal path');
  });

  await t.test('a tenant admin role -> 403 (admin is not a platform superuser)', async () => {
    const res = await request(httpServer)
      .get('/api/v1/metrics/today')
      .set('Authorization', `Bearer ${tokenFor(tenantAdminId, 'admin')}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.people, undefined);
  });

  await t.test('platform staff -> 200 with the operator shape', async () => {
    const res = await request(httpServer)
      .get('/api/v1/metrics/today')
      .set('Authorization', `Bearer ${tokenFor(staffId, 'owner')}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.people), 'returns the list');
    assert.equal(typeof res.body.people_count, 'number');
    assert.equal(typeof res.body.first_timers, 'number');
    assert.equal(res.body.window_days, 1, 'defaults to today');
  });

  await t.test('the days window is honoured and clamped for staff', async () => {
    const widened = await request(httpServer)
      .get('/api/v1/metrics/today?days=7')
      .set('Authorization', `Bearer ${tokenFor(staffId, 'owner')}`);
    assert.equal(widened.status, 200);
    assert.equal(widened.body.window_days, 7);

    // A hostile or fat-fingered window must not turn into an unbounded scan.
    const absurd = await request(httpServer)
      .get('/api/v1/metrics/today?days=100000')
      .set('Authorization', `Bearer ${tokenFor(staffId, 'owner')}`);
    assert.equal(absurd.status, 200);
    assert.equal(absurd.body.window_days, 31, 'clamped to MAX_WINDOW_DAYS');
  });

  await t.test('the gate is the same one /metrics/retention already uses', async () => {
    // Not a new gate: both routes sit on the router-level
    // requireAuth + requirePlatformStaff in routes/shared/metrics.js. If /today
    // ever drifted onto its own middleware, these two would stop agreeing.
    const token = `Bearer ${tokenFor(tenantOwnerId, 'owner')}`;
    const today = await request(httpServer).get('/api/v1/metrics/today').set('Authorization', token);
    const retention = await request(httpServer).get('/api/v1/metrics/retention').set('Authorization', token);
    assert.equal(today.status, retention.status);
    assert.equal(today.status, 403);
  });
});
