/**
 * A user row must be deletable. That sounds too obvious to test, and it is
 * exactly why nobody did.
 *
 * Two foreign keys referenced users(user_id) with no ON DELETE clause:
 * api_keys.owner_id and enterprise_inquiries.user_id. So `DELETE FROM users`
 * raised a violation for any user who had ever held an API key — which is the
 * FIRST WRITE the Clerk `user.deleted` webhook performs.
 *
 * The consequences were not local to the webhook:
 *   - the handler 500'd and Clerk retried the same event forever (measured
 *     2026-08-30: every failed delivery on the endpoint was a user.deleted,
 *     27% error rate, the same message ids repeated eight times)
 *   - the users row survived pointing at an auth_subject Clerk no longer had
 *   - the next sign-in with that email hit the account-takeover guard, fell
 *     through to an INSERT that violated users_email_key, and 401'd on every
 *     request — surfacing as an endless "your session expired" loop
 *   - right-to-erasure silently failed for anyone with an API key
 *
 * The paying customer was locked out for roughly nineteen days by this.
 *
 * Run via scripts/run-db-test.sh node tests/integration/user-delete-fk.test.js
 */
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

test('deleting a user cascades its API keys instead of being blocked by them', async (t) => {
    const orgId = `org-${uuidv4()}`;
    const userId = `user-${uuidv4()}`;
    const authSubject = `user_fk_${uuidv4()}`;
    const keyId = `key-${uuidv4()}`;

    t.after(async () => {
        await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
        await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
    });

    await db.query(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, 'FK guard', 'free', 'free', 'trial_active', 'organization')`,
        [orgId], orgId
    );
    await db.query(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'owner', $3, 'clerk', $4)`,
        [userId, `${userId}@fk-guard.test`, orgId, authSubject], orgId
    );
    await db.query(
        `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at)
         VALUES ($1, 'dd_test', $2, 'fk guard', $3, $4, 'production', now() + interval '1 year')`,
        [keyId, `hash-${keyId}`, userId, orgId], orgId
    );

    // Exactly the statement the user.deleted webhook runs first.
    await db.query(
        'DELETE FROM users WHERE auth_subject = $1 AND auth_provider = $2',
        [authSubject, 'clerk'], orgId
    );

    const userRows = await db.query('SELECT 1 FROM users WHERE user_id = $1', [userId], orgId);
    assert.strictEqual(userRows.rows.length, 0, 'the user row must be gone');

    // CASCADE, not SET NULL: a key whose owner no longer exists authenticates
    // nobody and should not linger as a credential with a dangling owner.
    const keyRows = await db.query('SELECT owner_id FROM api_keys WHERE key_id = $1', [keyId], orgId);
    assert.strictEqual(keyRows.rows.length, 0, 'the API key must be removed with its owner');
});

test('every foreign key into users declares an ON DELETE action', async () => {
    // The general form of the bug. A new table referencing users(user_id) with
    // the default NO ACTION re-breaks account deletion the moment one row
    // exists, and the symptom appears somewhere else entirely — a sign-in loop,
    // a webhook retrying forever — so it is worth catching at the schema.
    const res = await db.query(
        `SELECT c.conname,
                c.conrelid::regclass::text AS referencing_table,
                c.confdeltype
           FROM pg_constraint c
          WHERE c.confrelid = 'users'::regclass
            AND c.contype = 'f'`,
        [], 'org-system'
    );

    assert.ok(res.rows.length > 0, 'expected at least one FK into users');

    // confdeltype: a = NO ACTION, r = RESTRICT, c = CASCADE, n = SET NULL, d = SET DEFAULT
    const blocking = res.rows
        .filter((r) => r.confdeltype === 'a' || r.confdeltype === 'r')
        .map((r) => `${r.referencing_table}.${r.conname}`);

    assert.deepStrictEqual(
        blocking,
        [],
        'these foreign keys block DELETE FROM users; give each an ON DELETE action ' +
        '(CASCADE when the row is meaningless without its owner, SET NULL when it is ' +
        'a business record that outlives the account)'
    );
});

// The pool and the Redis client are process-wide, so they close once for the
// file. Closing them inside the first test's t.after left the second test
// querying a pool that had already ended.
after(async () => {
    await closeRedisConnections();
    await db.pool.end();
});
