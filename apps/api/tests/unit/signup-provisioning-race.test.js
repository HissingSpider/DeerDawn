'use strict';

/**
 * A NEW SIGNUP MUST NOT LOSE ITS FIRST REQUEST TO ITS OWN WEBHOOK.
 *
 * The Clerk `user.created` webhook and the dashboard's first request both
 * provision the same identity at nearly the same moment. Each sees no row and
 * INSERTs; auth_subject and email are unique, so the loser gets a 23505. When
 * the loser was syncUser it returned null, the request 401'd, and somebody who
 * had just signed up was told their dashboard session had expired.
 *
 * Drives the real syncUser against a fake pool: the users INSERT fails the way
 * Postgres fails it after the other transaction commits, and the read-back then
 * sees the winner's row.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../../src/config/db');
const { _authAdapter: adapter } = require('../../src/middleware/auth');

const WINNER = {
    user_id: 'user-winner',
    email: 'new@example.test',
    role: 'owner',
    org_id: 'org-winner',
    org_name: 'new workspace',
    auth_provider: 'clerk',
    auth_subject: 'user_clerk_new',
};

// insertError: what the users INSERT throws. winnerExists: whether a row for
// this identity is visible once that INSERT has failed.
function fakePool({ insertError, winnerExists }) {
    const log = { orgsInserted: [], orgsDeleted: [] };
    let insertFailed = false;
    db.pool.connect = async () => ({
        release() {},
        async query(text, params = []) {
            if (text.includes('set_config')) return { rows: [] };
            if (text.startsWith('SELECT u.*') && text.includes('auth_subject = $2')) {
                return { rows: insertFailed && winnerExists ? [WINNER] : [] };
            }
            if (text.startsWith('SELECT u.*') && text.includes('u.email = $1')) return { rows: [] };
            if (text.startsWith('INSERT INTO organizations')) {
                log.orgsInserted.push(params[0]);
                return { rows: [] };
            }
            if (text.startsWith('INSERT INTO users')) {
                insertFailed = true;
                throw insertError;
            }
            if (text.startsWith('DELETE FROM organizations')) {
                log.orgsDeleted.push(params[0]);
                return { rows: [] };
            }
            throw new Error(`unexpected query: ${text}`);
        },
    });
    return log;
}

const uniqueViolation = () => Object.assign(new Error('duplicate key value violates unique constraint "idx_users_auth_subject"'), { code: '23505' });

test('losing the first-touch INSERT returns the account the webhook created', async () => {
    fakePool({ insertError: uniqueViolation(), winnerExists: true });
    const user = await adapter.syncUser('user_clerk_new', 'new@example.test', 'clerk');
    assert.ok(user, 'syncUser returned null, so the first request 401s as "session expired"');
    assert.strictEqual(user.user_id, 'user-winner');
    assert.strictEqual(user.org_id, 'org-winner');
});

test('the org minted by the losing call is removed, not left orphaned', async () => {
    const log = fakePool({ insertError: uniqueViolation(), winnerExists: true });
    await adapter.syncUser('user_clerk_new', 'new@example.test', 'clerk');
    assert.strictEqual(log.orgsInserted.length, 1);
    assert.deepStrictEqual(log.orgsDeleted, log.orgsInserted);
});

test('a 23505 with no row for this identity is not a race and still fails', async () => {
    // e.g. the email is held by a different identity: adopting anything here
    // would hand this signup somebody else's account.
    const log = fakePool({ insertError: uniqueViolation(), winnerExists: false });
    const user = await adapter.syncUser('user_clerk_new', 'new@example.test', 'clerk');
    assert.strictEqual(user, null);
    assert.deepStrictEqual(log.orgsDeleted, []);
});

test('any other INSERT failure still fails as before', async () => {
    const log = fakePool({ insertError: new Error('connection terminated'), winnerExists: true });
    const user = await adapter.syncUser('user_clerk_new', 'new@example.test', 'clerk');
    assert.strictEqual(user, null);
    assert.deepStrictEqual(log.orgsDeleted, []);
});
