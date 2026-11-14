const test = require('node:test');
const assert = require('node:assert');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
const request = require('supertest');
const app = require('../../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

async function cleanupByEmail(email) {
    const userRes = await db.query('SELECT org_id FROM users WHERE email = $1', [email], 'org-system').catch(() => ({ rows: [] }));
    const orgId = userRes.rows[0]?.org_id;

    if (orgId) {
        for (const table of ['escalation_resolutions', 'decisions', 'audit_logs', 'api_keys', 'policies', 'integrations', 'users']) {
            await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
        }
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
    }
}

test('Signup Pricing', async (t) => {
    const email = `signup-pricing-${Date.now()}@test.com`;

    t.after(async () => {
        await cleanupByEmail(email);
        await closeRedisConnections();
        await db.pool.end();
    });

    await t.test('POST /auth/signup defaults new workspaces to free organization trial', async () => {
        const res = await request(httpServer)
            .post('/api/v1/auth/signup')
            .send({
                email,
                password: 'Password123!',
                org_name: 'Signup Pricing Test Org',
            });

        assert.strictEqual(res.status, 201);
        assert.ok(res.body.user?.org_id, 'signup should return org_id');

        const orgRes = await db.query(
            'SELECT account_type, plan, plan_tier, subscription_status FROM organizations WHERE org_id = $1',
            [res.body.user.org_id],
            res.body.user.org_id
        );

        assert.strictEqual(orgRes.rows[0]?.account_type, 'organization');
        assert.strictEqual(orgRes.rows[0]?.plan, 'free');
        assert.strictEqual(orgRes.rows[0]?.plan_tier, 'free');
        assert.strictEqual(orgRes.rows[0]?.subscription_status, 'trial_active');
    });
});
