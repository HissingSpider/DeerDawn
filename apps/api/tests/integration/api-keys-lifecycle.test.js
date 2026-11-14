/**
 * API Keys Lifecycle Integration Tests
 *
 * Tests key creation, listing, authentication, deletion, expiration, and scope enforcement.
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

async function setupOrg() {
    const orgId = `org-${uuidv4()}`;
    const adminUserId = `user-${uuidv4()}`;
    const readOnlyUserId = `user-${uuidv4()}`;
    const { key: _bootstrapKey, prefix, hash: keyHash } = generateApiKey();

    await db.query(
        'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
        [orgId, `Keys Test Org ${orgId}`, 'starter', 'starter', 'active'],
        orgId
    );

    const passHash = await hashPassword('password123');

    // Admin user
    await db.query(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [adminUserId, `keys-admin-${Date.now()}-${uuidv4().slice(0, 8)}@test.com`, passHash, 'admin', orgId],
        orgId
    );

    // Real read-only DB user
    await db.query(
        'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
        [readOnlyUserId, `keys-readonly-${Date.now()}-${uuidv4().slice(0, 8)}@test.com`, passHash, 'read-only', orgId],
        orgId
    );

    const adminToken = generateToken({ user_id: adminUserId, role: 'admin', org_id: orgId });
    const readOnlyToken = generateToken({ user_id: readOnlyUserId, role: 'read-only', org_id: orgId });

    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + 30);
    await db.query(
        'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
        [`key-${uuidv4()}`, prefix, keyHash, 'Bootstrap Key', adminUserId, orgId, 'production', expiresAt.toISOString(), ['*']],
        orgId
    );

    return { orgId, adminUserId, readOnlyUserId, adminToken, readOnlyToken };
}

async function cleanupOrg(orgId) {
    for (const table of ['escalation_resolutions', 'decisions', 'audit_logs', 'api_keys', 'integrations', 'users']) {
        await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
    }
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
}

test('API Keys Lifecycle', async (t) => {
    let orgId;

    t.after(async () => {
        if (orgId) await cleanupOrg(orgId).catch(() => {});
        await closeRedisConnections();
        await db.pool.end();
    });

    const { orgId: oid, adminUserId, adminToken, readOnlyToken } = await setupOrg();
    orgId = oid;

    let createdKeyId;
    let createdRawKey;

    await t.test('POST /keys creates a new API key and returns raw key once', async () => {
        const res = await request(httpServer)
            .post('/api/v1/keys')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({
                name: 'Integration Test Key',
                environment: 'production',
                scopes: ['context:read'],
            });

        assert.strictEqual(res.status, 201, `Expected 201, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert.ok(res.body.key?.key, 'must return the raw key');
        assert.ok(res.body.key.key.startsWith('dd_'), 'key must start with dd_');
        assert.ok(res.body.key.id, 'must return key id');
        createdRawKey = res.body.key.key;
        createdKeyId = res.body.key.id;
    });

    await t.test('GET /keys lists keys without exposing raw key', async () => {
        const res = await request(httpServer)
            .get('/api/v1/keys')
            .set('Authorization', `Bearer ${adminToken}`);

        assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}`);
        assert.ok(Array.isArray(res.body.keys), 'must return keys array');

        for (const k of res.body.keys) {
            assert.ok(!k.key, 'raw key must not be in list response');
            assert.ok(!k.key_hash, 'key_hash must not be in list response');
            assert.ok(k.prefix || k.key_id, 'must include prefix or key_id');
        }
    });

    await t.test('created key authenticates successfully on context routes', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', createdRawKey);

        assert.ok([200, 201].includes(res.status), `Expected 200/201, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert.ok(Array.isArray(res.body.projects), 'must return projects array');
    });

    await t.test('DELETE /keys/:id revokes the key', async () => {
        assert.ok(createdKeyId, 'must have createdKeyId from previous test');

        const res = await request(httpServer)
            .delete(`/api/v1/keys/${createdKeyId}`)
            .set('Authorization', `Bearer ${adminToken}`);

        assert.ok([200, 204].includes(res.status), `Expected 200/204, got ${res.status}: ${JSON.stringify(res.body)}`);
    });

    await t.test('revoked key is rejected with 401', async () => {
        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', createdRawKey);

        assert.strictEqual(res.status, 401, `Expected 401 for revoked key, got ${res.status}`);
    });

    await t.test('expired key is rejected with 401', async () => {
        const { key: expKey, prefix: expPrefix, hash: expHash } = generateApiKey();
        const pastDate = new Date();
        pastDate.setDate(pastDate.getDate() - 1);

        await db.query(
            'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [`key-${uuidv4()}`, expPrefix, expHash, 'Expired Key', adminUserId, orgId, 'production', pastDate.toISOString(), ['*']],
            orgId
        );

        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', expKey);

        assert.strictEqual(res.status, 401, `Expected 401 for expired key, got ${res.status}`);
    });

    await t.test('key with context:read scope can access context routes', async () => {
        const { key: scopedKey, prefix: sp, hash: sh } = generateApiKey();
        const futureDate = new Date();
        futureDate.setDate(futureDate.getDate() + 90);

        await db.query(
            'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
            [`key-${uuidv4()}`, sp, sh, 'Scoped Context Key', adminUserId, orgId, 'production', futureDate.toISOString(), ['context:read']],
            orgId
        );

        const res = await request(httpServer)
            .get('/api/v1/context/projects')
            .set('X-Api-Key', scopedKey);

        assert.ok([200, 201].includes(res.status), `context:read scoped key should access context routes, got ${res.status}`);
    });

    await t.test('read-only bearer token cannot delete a key', async () => {
        // Create a key to try to delete
        const createRes = await request(httpServer)
            .post('/api/v1/keys')
            .set('Authorization', `Bearer ${adminToken}`)
            .send({ name: `Delete Target ${uuidv4()}`, environment: 'sandbox', scopes: ['context:read'] });

        assert.strictEqual(createRes.status, 201);
        const targetId = createRes.body.key?.id;

        const deleteRes = await request(httpServer)
            .delete(`/api/v1/keys/${targetId}`)
            .set('Authorization', `Bearer ${readOnlyToken}`);

        assert.ok([403, 401].includes(deleteRes.status), `Expected 403/401 for read-only delete, got ${deleteRes.status}`);
    });
});
