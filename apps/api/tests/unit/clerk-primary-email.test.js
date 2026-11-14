'use strict';

/**
 * SIGN-IN MUST IDENTIFY A PERSON BY THEIR PRIMARY CLERK ADDRESS.
 *
 * `_verifyClerk` read `clerkUser.emailAddresses[0]`. Clerk orders that list by
 * when each address was added, so [0] is the OLDEST — for anybody who changed
 * their email, the one they left. JIT provisioning then created (or adopted by
 * email match) an account under the wrong address.
 *
 * Drives the real adapter: a token goes in, and the assertion is on the address
 * that reaches syncUser. @clerk/backend is replaced in the require cache before
 * auth.js destructures it, so nothing here talks to Clerk.
 */

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';
process.env.DISABLE_REDIS = 'true';
process.env.CLERK_SECRET_KEY = 'sk_test_primary_email';

const test = require('node:test');
const assert = require('node:assert');

let clerkUser = null;
const clerkPath = require.resolve('@clerk/backend');
require.cache[clerkPath] = {
    id: clerkPath,
    filename: clerkPath,
    loaded: true,
    exports: {
        verifyToken: async () => ({ sub: 'user_clerk_subject' }),
        createClerkClient: () => ({ users: { getUser: async () => clerkUser } }),
    },
};

const reports = [];
const reportSwallowedModule = require('../../src/utils/reportSwallowed');
reportSwallowedModule.reportSwallowed = (error, meta = {}) => {
    reports.push({ message: error?.message, ...meta });
};

const { _authAdapter: adapter } = require('../../src/middleware/auth');
const { primaryClerkEmail } = require('../../src/utils/clerkEmail');

function captureSync() {
    const calls = [];
    adapter.syncUser = async (externalId, email, provider) => {
        calls.push({ externalId, email, provider });
        return { user_id: 'user-1', email, org_id: 'org-1', role: 'owner' };
    };
    return calls;
}

test('_verifyClerk provisions against the primary address, not the first one', async () => {
    const calls = captureSync();
    clerkUser = {
        primaryEmailAddressId: 'idn_new',
        emailAddresses: [
            { id: 'idn_old', emailAddress: 'old@example.test' },
            { id: 'idn_new', emailAddress: 'new@example.test' },
        ],
    };

    const user = await adapter._verifyClerk('any.token.here');

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].email, 'new@example.test');
    assert.strictEqual(user.email, 'new@example.test');
});

test('_verifyClerk still signs in a user whose primary pointer is missing', async () => {
    // Older Clerk users and some SDK shapes carry no pointer. They signed in
    // before this change and must keep doing so.
    const calls = captureSync();
    clerkUser = { emailAddresses: [{ id: 'idn_only', emailAddress: 'only@example.test' }] };

    await adapter._verifyClerk('any.token.here');

    assert.strictEqual(calls[0].email, 'only@example.test');
});

test('_verifyClerk refuses, and reports, a Clerk user with no address at all', async () => {
    const calls = captureSync();
    reports.length = 0;
    clerkUser = { primaryEmailAddressId: null, emailAddresses: [] };

    const user = await adapter._verifyClerk('any.token.here');

    assert.strictEqual(user, null);
    assert.strictEqual(calls.length, 0, 'never provision an account with no email');
    assert.strictEqual(reports.length, 1);
    assert.match(reports[0].message, /no email address/);
});

test('primaryClerkEmail reads the webhook (snake_case) shape the same way', () => {
    const payload = {
        primary_email_address_id: 'idn_2',
        email_addresses: [
            { id: 'idn_1', email_address: 'first@example.test' },
            { id: 'idn_2', email_address: 'second@example.test' },
        ],
    };
    assert.strictEqual(primaryClerkEmail(payload), 'second@example.test');
    // Dangling pointer: sign-in falls back, an overwrite does not.
    const dangling = { ...payload, primary_email_address_id: 'idn_gone' };
    assert.strictEqual(primaryClerkEmail(dangling), 'first@example.test');
    assert.strictEqual(primaryClerkEmail(dangling, { strict: true }), null);
    assert.strictEqual(primaryClerkEmail(null), null);
});
