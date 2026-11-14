'use strict';

/**
 * A SECOND BOOT MUST CHANGE NOTHING AND LOCK NOTHING.
 *
 * runAutoMigration() is executed by every machine on every start. It was
 * "idempotent" in the sense that the schema came out the same, but it got there
 * by dropping and re-adding constraints (ACCESS EXCLUSIVE plus a validating scan
 * of `users` and `api_keys`, the two tables every authenticated request reads)
 * and by rewriting rows that were already correct.
 *
 * None of that is visible in the resulting schema, which is why nothing caught
 * it. So these tests look at what a boot DOES rather than at what it leaves:
 *   - a constraint that was dropped and re-added has a new pg_constraint oid
 *   - a row that was rewritten has a new xmin
 *   - a statement that needs ACCESS EXCLUSIVE cannot proceed while another
 *     transaction is merely reading the table
 *
 * Run via scripts/run-db-test.sh node --test tests/integration/auto-migrate-second-boot.test.js
 */

const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert');
const { v4: uuidv4 } = require('uuid');

const STAFF_EMAIL = `staff-${uuidv4()}@automigrate.test`;
const LATER_STAFF_EMAIL = `later-${uuidv4()}@automigrate.test`;
process.env.PLATFORM_ADMIN_EMAILS = STAFF_EMAIL;

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { runAutoMigration } = require('../../src/config/autoMigrate');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');

const SWAPPED_CONSTRAINTS = [
    ['users', 'users_role_check'],
    ['api_keys', 'api_keys_owner_id_fkey'],
    ['enterprise_inquiries', 'enterprise_inquiries_user_id_fkey'],
];

async function constraintOids() {
    const out = {};
    for (const [table, name] of SWAPPED_CONSTRAINTS) {
        const res = await db.query(
            'SELECT oid::text AS oid FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)',
            [name, table], 'org-system'
        );
        out[name] = res.rows[0]?.oid || null;
    }
    return out;
}

const orgId = `org-${uuidv4()}`;
const staffId = `user-${uuidv4()}`;
const laterId = `user-${uuidv4()}`;

async function seed() {
    await db.query(
        `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, account_type)
         VALUES ($1, 'automigrate', 'free', 'free', 'trial_active', 'organization')`,
        [orgId], 'org-system'
    );
    for (const [id, email] of [[staffId, STAFF_EMAIL], [laterId, LATER_STAFF_EMAIL]]) {
        await db.query(
            `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
             VALUES ($1, $2, 'owner', $3, 'clerk', $4)`,
            [id, email, orgId, `sub_${id}`], 'org-system'
        );
    }
}

async function rowVersion(table, keyColumn, id) {
    const res = await db.query(`SELECT xmin::text AS xmin FROM ${table} WHERE ${keyColumn} = $1`, [id], 'org-system');
    return res.rows[0]?.xmin || null;
}

after(async () => {
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], 'org-system').catch(() => {});
    await closeRedisConnections?.().catch(() => {});
    await db.pool.end().catch(() => {});
});

test('a second boot re-creates no constraint and rewrites no row', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'auto-migrate second boot'))) return;
    await seed();

    await runAutoMigration(); // brings the database current, whatever state it was in
    const staff = await db.query('SELECT is_platform_staff FROM users WHERE user_id = $1', [staffId], 'org-system');
    assert.strictEqual(staff.rows[0].is_platform_staff, true, 'the allowlist still has to be applied');

    const oidsBefore = await constraintOids();
    const staffBefore = await rowVersion('users', 'user_id', staffId);
    const orgBefore = await rowVersion('organizations', 'org_id', orgId);
    for (const [, name] of SWAPPED_CONSTRAINTS) assert.ok(oidsBefore[name], `${name} should exist after a boot`);

    await runAutoMigration();

    assert.deepStrictEqual(
        await constraintOids(), oidsBefore,
        'a constraint with a new oid was dropped and re-added: ACCESS EXCLUSIVE and a full validating scan, on every boot'
    );
    assert.strictEqual(await rowVersion('users', 'user_id', staffId), staffBefore, 'an already-correct staff row was rewritten');
    assert.strictEqual(await rowVersion('organizations', 'org_id', orgId), orgBefore, 'an already-correct organization row was rewritten');
});

test('a second boot does not need ACCESS EXCLUSIVE on the tables the auth path reads', { timeout: 60000 }, async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'auto-migrate second boot'))) return;
    await runAutoMigration();

    // An ordinary reader: a transaction that has SELECTed from these tables and
    // not finished yet. It holds ACCESS SHARE, which conflicts with exactly one
    // lock mode: ACCESS EXCLUSIVE. A slow report at deploy time looks like this.
    const reader = await db.pool.connect();
    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        await reader.query('ROLLBACK').catch(() => {});
        reader.release();
    };
    t.after(release);
    await reader.query('BEGIN');
    for (const table of ['users', 'api_keys', 'organizations', 'enterprise_inquiries']) {
        await reader.query(`SELECT 1 FROM ${table} LIMIT 1`);
    }

    const boot = runAutoMigration().then(() => 'completed', (err) => `failed: ${err.message}`);
    const outcome = await Promise.race([
        boot,
        new Promise((resolve) => setTimeout(() => resolve('blocked'), 8000).unref?.()),
    ]);

    // Let a blocked boot finish before asserting, so a failure here does not
    // leave a migration transaction queued behind a lock for the next test.
    await release();
    await boot;

    assert.strictEqual(outcome, 'completed', 'the boot waited on a lock held by a plain reader');
});

test('two machines booting at once both come up', { timeout: 60000 }, async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'auto-migrate second boot'))) return;
    // Make there be real work to race over, so this is not just two no-ops.
    await db.query('ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_owner_id_fkey', [], 'org-system');
    await db.query('DELETE FROM context_migrations WHERE name = $1', ['users_admin_role_to_owner_v1'], 'org-system');

    const results = await Promise.allSettled([runAutoMigration(), runAutoMigration()]);

    assert.deepStrictEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled']);
    const fk = await db.query(
        'SELECT confdeltype FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)',
        ['api_keys_owner_id_fkey', 'api_keys'], 'org-system'
    );
    assert.strictEqual(fk.rows.length, 1, 'exactly one FK, not zero and not a duplicate');
    assert.strictEqual(fk.rows[0].confdeltype, 'c');
});

test('a database that really is behind is still corrected', { timeout: 60000 }, async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'auto-migrate second boot'))) return;
    // The shapes production actually had: the FK with no ON DELETE action (the
    // Clerk user.deleted incident), and the narrower role CHECK under the SAME
    // NAME. A check that only asked "does a constraint with this name exist"
    // would skip both.
    await db.query('ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_owner_id_fkey', [], 'org-system');
    await db.query(
        'ALTER TABLE api_keys ADD CONSTRAINT api_keys_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(user_id)',
        [], 'org-system'
    );
    await db.query('ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check', [], 'org-system');
    await db.query(
        'ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN (\'admin\', \'operator\', \'approver\')) NOT VALID',
        [], 'org-system'
    );

    await runAutoMigration();

    const fk = await db.query(
        'SELECT confdeltype FROM pg_constraint WHERE conname = $1 AND conrelid = to_regclass($2)',
        ['api_keys_owner_id_fkey', 'api_keys'], 'org-system'
    );
    assert.strictEqual(fk.rows[0].confdeltype, 'c', 'ON DELETE CASCADE must be restored');

    // Behavioural: the role the narrow CHECK refused is accepted again.
    const probe = `user-${uuidv4()}`;
    await db.query(
        `INSERT INTO users (user_id, email, role, org_id, auth_provider, auth_subject)
         VALUES ($1, $2, 'member', $3, 'clerk', $4)`,
        [probe, `${probe}@automigrate.test`, orgId, `sub_${probe}`], 'org-system'
    );
});

test('the platform-staff allowlist is still re-read on every boot', async (t) => {
    if (!(await ensureDatabaseAvailable(t, db, 'auto-migrate second boot'))) return;
    // It is an env var, so it can change between deploys. Making the UPDATE a
    // no-op for correct rows must not turn it into a run-once.
    process.env.PLATFORM_ADMIN_EMAILS = `${STAFF_EMAIL}, ${LATER_STAFF_EMAIL.toUpperCase()}`;
    await runAutoMigration();

    const res = await db.query('SELECT is_platform_staff FROM users WHERE user_id = $1', [laterId], 'org-system');
    assert.strictEqual(res.rows[0].is_platform_staff, true);
});
