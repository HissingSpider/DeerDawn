/**
 * Auth Middleware Tests
 *
 * Tests requireAuth, requireScope, and requireRole against the live Express app.
 * Uses real DB records for API keys and JWT sessions.
 */

const test = require('node:test');
const assert = require('node:assert');
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
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const { v4: uuidv4 } = require('uuid');

test('Auth Middleware', async (t) => {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const { key: validApiKey, prefix, hash: keyHash } = generateApiKey();
    const { key: expiredKey, prefix: expPrefix, hash: expHash } = generateApiKey();
    const { key: scopedOnlyKey, prefix: scopedPrefix, hash: scopedHash } = generateApiKey();
    let adminToken;

    t.after(async () => {
        await db.query('DELETE FROM audit_logs WHERE org_id = $1', [orgId], orgId);
        await db.query('DELETE FROM escalation_resolutions WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM decisions WHERE org_id = $1', [orgId], orgId);
        await db.query('DELETE FROM policies WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM integrations WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId);
        await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId);
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId);
        await closeRedisConnections();
        await db.pool.end();
    });

    await db.query(
        'INSERT INTO organizations (org_id, name, plan_tier, subscription_status) VALUES ($1, $2, $3, $4)',
        [orgId, 'Auth Test Org', 'starter', 'active'],
        orgId
    );

    const passHash = await hashPassword('test-password');
    await db.query(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [userId, `auth-admin-${Date.now()}@test.com`, passHash, 'admin', orgId],
        orgId
    );

    const readOnlyUserId = `user-${uuidv4()}`;
    await db.query(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [readOnlyUserId, `auth-readonly-${Date.now()}@test.com`, passHash, 'read-only', orgId],
        orgId
    );

    adminToken = generateToken({ user_id: userId, role: 'admin', org_id: orgId });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);

    await db.query(
        'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [`key-${uuidv4()}`, prefix, keyHash, 'Valid Key', userId, orgId, 'production', expiresAt.toISOString(), ['*']],
        orgId
    );

    const expiredAt = new Date();
    expiredAt.setDate(expiredAt.getDate() - 1);
    await db.query(
        'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [`key-${uuidv4()}`, expPrefix, expHash, 'Expired Key', userId, orgId, 'production', expiredAt.toISOString(), ['*']],
        orgId
    );

    await db.query(
        'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [`key-${uuidv4()}`, scopedPrefix, scopedHash, 'Scoped Key', userId, orgId, 'production', expiresAt.toISOString(), ['decisions:evaluate']],
        orgId
    );

    await t.test('rejects missing credentials with 401', async () => {
        const res = await request(httpServer).get('/api/v1/context/projects');
        assert.strictEqual(res.status, 401);
    });

    await t.test('rejects invalid API key with 401', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', 'dd_badkey_notindb000000000000000000000000000000000000000000000000000000000');
        assert.strictEqual(res.status, 401);
    });

    await t.test('accepts valid API key via X-Api-Key header', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', validApiKey);
        assert.notStrictEqual(res.status, 401);
        assert.notStrictEqual(res.status, 403);
    });

    await t.test('accepts valid API key via Authorization Bearer with dd_ prefix', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('Authorization', `Bearer ${validApiKey}`);
        assert.notStrictEqual(res.status, 401);
    });

    await t.test('rejects expired API key with 401', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', expiredKey);
        assert.strictEqual(res.status, 401);
    });

    await t.test('accepts valid Bearer JWT token', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
    });

    await t.test('rejects tampered JWT token with 401', async () => {
        const tampered = adminToken.slice(0, -5) + 'XXXXX';
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('Authorization', `Bearer ${tampered}`);
        assert.strictEqual(res.status, 401);
    });

    await t.test('system key (DEERDAWN_API_KEY) bypasses DB lookup', async () => {
        const systemKey = process.env.DEERDAWN_API_KEY || 'dev-key';
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', systemKey);
        assert.notStrictEqual(res.status, 401);
    });

    await t.test('scope enforcement: restricted-scope key cannot access context routes', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', scopedOnlyKey);
        assert.strictEqual(res.status, 403);
    });

    await t.test('admin JWT can GET context projects', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('Authorization', `Bearer ${adminToken}`);
        assert.strictEqual(res.status, 200);
        assert.ok(Array.isArray(res.body.projects));
    });

    await t.test('CSRF protection: cookie auth POST without X-Csrf-Token returns 403', async () => {
        const csrfToken = 'csrf-token-abc123';
        const res = await request(httpServer)
            .post('/api/v1/context/projects')
            .set('Cookie', `dd_session=${adminToken}; dd_csrf=${csrfToken}`)
            .send({ project_name: 'csrf-test' });
        assert.strictEqual(res.status, 403);
    });

    await t.test('CSRF protection: cookie auth GET without X-Csrf-Token is allowed', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('Cookie', `dd_session=${adminToken}`);
        assert.notStrictEqual(res.status, 403);
    });

    await t.test('scope: * key accepted on context routes', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', validApiKey);
        assert.notStrictEqual(res.status, 401);
        assert.notStrictEqual(res.status, 403);
    });
});
