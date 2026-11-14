/**
 * DS-01: GDPR erasure — purgeOwnerData removes ALL owner-scoped data, including the encrypted
 * integration credentials and globals that the old delete path missed.
 *
 * Run via scripts/run-db-test.sh node tests/integration/data-erasure.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { purgeOwnerData } = require('../../src/services/dataErasureService');

test('purgeOwnerData erases context, credentials, and api keys for an org', async (t) => {
    const orgId = `org-${uuidv4()}`;
    t.after(async () => {
        await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM context_integrations WHERE owner_key = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await closeRedisConnections();
        await db.pool.end();
    });

    const userId = `user-${uuidv4()}`;
    await db.query(
        'INSERT INTO organizations (org_id, name, plan_tier, subscription_status) VALUES ($1, $2, $3, $4)',
        [orgId, 'Erasure Test Org', 'starter', 'active'], orgId
    );
    await db.query(
        'INSERT INTO users (user_id, email, role, org_id) VALUES ($1, $2, $3, $4)',
        [userId, `erasure-${uuidv4()}@test.com`, 'owner', orgId], orgId
    );
    await db.query(
        // No org_id: context_projects is keyed by owner_key, and only autoMigrate
        // (never the migration scripts) bolts an org_id onto it.
        'INSERT INTO context_projects (project_id, owner_key, project_name, context) VALUES ($1, $2, $3, $4)',
        [`proj-${uuidv4()}`, orgId, 'P', JSON.stringify({ current_task: 'x' })], 'org-system'
    );
    await db.query(
        'INSERT INTO context_integrations (integration_id, owner_key, provider, encrypted_key) VALUES ($1, $2, $3, $4)',
        [`int-${uuidv4()}`, orgId, 'obsidian', 'v1:deadbeef'], 'org-system'
    );
    await db.query(
        'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [`key-${uuidv4()}`, 'dd_x', 'hash-' + uuidv4(), 'k', userId, orgId, 'production', new Date(Date.now() + 8.64e7).toISOString(), ['context:read']], orgId
    );

    const deleted = await purgeOwnerData(orgId);

    // every owner-scoped table reports a clean delete (number, not an error string)
    for (const [table, result] of Object.entries(deleted)) {
        assert.ok(typeof result === 'number', `${table} should delete cleanly, got: ${result}`);
    }

    const proj = await db.query('SELECT 1 FROM context_projects WHERE owner_key = $1', [orgId], 'org-system');
    const intg = await db.query('SELECT 1 FROM context_integrations WHERE owner_key = $1', [orgId], 'org-system');
    const keys = await db.query('SELECT 1 FROM api_keys WHERE org_id = $1', [orgId], orgId);
    assert.strictEqual(proj.rows.length, 0, 'context_projects must be erased');
    assert.strictEqual(intg.rows.length, 0, 'context_integrations (credentials) must be erased');
    assert.strictEqual(keys.rows.length, 0, 'api_keys must be erased');
});
