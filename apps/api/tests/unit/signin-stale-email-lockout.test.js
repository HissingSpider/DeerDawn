'use strict';

/**
 * A NEW CLERK IDENTITY MUST NOT BE LOCKED OUT BY A STALE ROW HOLDING ITS EMAIL.
 *
 * When somebody's earlier Clerk account was deleted but its users row was not
 * (the user.deleted webhook failed for months), signing up again with the same
 * address reached syncUser's resurrection guard, which correctly refused to
 * adopt the old row and "fell through to fresh-account creation". That INSERT
 * can never succeed: users.email is UNIQUE. syncUser returned null, every
 * request 401'd, and the dashboard looped on "your session expired".
 *
 * Drives the real syncUser against a fake pool and a fake Clerk client.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');
const db = require('../../src/config/db');
const { _authAdapter: adapter } = require('../../src/middleware/auth');

const EMAIL = 'back@example.test';
const STALE = {
    user_id: 'user-stale',
    email: EMAIL,
    role: 'owner',
    org_id: 'org-stale',
    org_name: 'old workspace',
    auth_provider: 'clerk',
    auth_subject: 'user_clerk_old',
};

// The users table as Postgres would enforce it: email is UNIQUE.
function fakePool() {
    const rows = [{ ...STALE }];
    const log = { emailUpdates: [], usersInserted: [] };
    db.pool.connect = async () => ({
        release() {},
        async query(text, params = []) {
            if (text.includes('set_config')) return { rows: [] };
            if (text.startsWith('SELECT u.*') && text.includes('auth_subject = $2')) {
                return { rows: rows.filter((r) => r.auth_provider === params[0] && r.auth_subject === params[1]) };
            }
            if (text.startsWith('SELECT u.*') && text.includes('u.email = $1')) {
                return { rows: rows.filter((r) => r.email === params[0]) };
            }
            if (text.startsWith('UPDATE users SET email')) {
                const row = rows.find((r) => r.user_id === params[1] && r.auth_subject === params[2] && r.email === params[3]);
                if (row) {
                    row.email = params[0];
                    log.emailUpdates.push({ user_id: row.user_id, email: params[0] });
                }
                return { rows: [], rowCount: row ? 1 : 0 };
            }
            if (text.startsWith('INSERT INTO organizations')) return { rows: [] };
            if (text.startsWith('INSERT INTO users')) {
                const [user_id, email, role, org_id, auth_provider, auth_subject] = params;
                if (rows.some((r) => r.email === email || r.auth_subject === auth_subject)) {
                    throw Object.assign(new Error('duplicate key value violates unique constraint "users_email_key"'), { code: '23505' });
                }
                rows.push({ user_id, email, role, org_id, auth_provider, auth_subject });
                log.usersInserted.push(user_id);
                return { rows: [] };
            }
            if (text.startsWith('DELETE FROM organizations')) return { rows: [] };
            // ensureFounderMembership and anything else best-effort.
            return { rows: [], rowCount: 0 };
        },
    });
    return { rows, log };
}

function fakeClerk(getUser) {
    adapter.clerk = { users: { getUser } };
}

const notFound = () => Object.assign(new Error('Not Found'), { status: 404 });
const clerkUserAt = (address) => ({
    primaryEmailAddressId: 'idn_1',
    emailAddresses: [{ id: 'idn_1', emailAddress: address }],
});

test('the old Clerk identity is gone: the new one gets a fresh account', async () => {
    const { rows, log } = fakePool();
    fakeClerk(async () => { throw notFound(); });
    const user = await adapter.syncUser('user_clerk_new', EMAIL, 'clerk');
    assert.ok(user, 'syncUser returned null, so every request 401s as "session expired"');
    assert.strictEqual(user.auth_subject, 'user_clerk_new');
    assert.strictEqual(user.email, EMAIL);
    assert.notStrictEqual(user.org_id, 'org-stale', 'the new identity must not inherit the old workspace');
    assert.strictEqual(log.usersInserted.length, 1);
    const stale = rows.find((r) => r.user_id === 'user-stale');
    assert.strictEqual(stale.email, 'released+user-stale@deerdawn.invalid');
    assert.strictEqual(stale.org_id, 'org-stale', 'the stale row keeps its own workspace');
});

test('the old identity moved to another address: the email is released too', async () => {
    const { log } = fakePool();
    fakeClerk(async () => clerkUserAt('elsewhere@example.test'));
    const user = await adapter.syncUser('user_clerk_new', EMAIL, 'clerk');
    assert.ok(user);
    assert.strictEqual(user.auth_subject, 'user_clerk_new');
    assert.strictEqual(log.emailUpdates.length, 1);
});

test('the old identity still holds the address: nothing is released', async () => {
    const { rows, log } = fakePool();
    fakeClerk(async () => clerkUserAt(EMAIL.toUpperCase()));
    const user = await adapter.syncUser('user_clerk_new', EMAIL, 'clerk');
    assert.strictEqual(user, null);
    assert.deepStrictEqual(log.emailUpdates, []);
    assert.strictEqual(rows.find((r) => r.user_id === 'user-stale').email, EMAIL);
});

test('Clerk cannot be asked: fail closed, nothing is released', async () => {
    const { log } = fakePool();
    fakeClerk(async () => { throw Object.assign(new Error('Bad Gateway'), { status: 502 }); });
    const user = await adapter.syncUser('user_clerk_new', EMAIL, 'clerk');
    assert.strictEqual(user, null);
    assert.deepStrictEqual(log.emailUpdates, []);
});

test('the old identity signing in is untouched by any of this', async () => {
    const { log } = fakePool();
    fakeClerk(async () => { throw new Error('getUser must not be called for the row\'s own identity'); });
    const user = await adapter.syncUser('user_clerk_old', EMAIL, 'clerk');
    assert.strictEqual(user.user_id, 'user-stale');
    assert.deepStrictEqual(log.emailUpdates, []);
});
