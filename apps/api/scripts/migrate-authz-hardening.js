// AUTHZ hardening migration (AUTHZ-001/002/003).
// Idempotent. Can be run standalone (node scripts/migrate-authz-hardening.js); the same steps
// also run automatically at boot via src/config/autoMigrate.js.
//
//   1. Add the non-grantable users.is_platform_staff capability column.
//   2. Widen the role CHECK to the org-scoped taxonomy (owner/member/read-only + legacy roles).
//   3. Downgrade every legacy role='admin' tenant to org 'owner' (no platform power).
//   4. Seed platform staff strictly from PLATFORM_ADMIN_EMAILS (the only signup-adjacent path).
//   5. Normalize any tenant api_keys carrying a wildcard scope to the explicit context:* set.

const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig(),
});

async function migrate() {
    await client.connect();
    console.log('[AUTHZ] Hardening role model...');
    try {
        await client.query('BEGIN');

        await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_staff BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
      ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'member', 'read-only', 'admin', 'operator', 'approver'));
    `);

        const downgraded = await client.query(`
      UPDATE users SET role = 'owner' WHERE role = 'admin';
    `);
        console.log(`[AUTHZ] Downgraded ${downgraded.rowCount} legacy admin users to org owner.`);

        const platformAdminEmails = (process.env.PLATFORM_ADMIN_EMAILS || '')
            .split(',')
            .map((e) => e.trim().toLowerCase())
            .filter(Boolean);
        if (platformAdminEmails.length > 0) {
            const seeded = await client.query(
                'UPDATE users SET is_platform_staff = TRUE WHERE lower(email) = ANY($1::text[]);',
                [platformAdminEmails]
            );
            console.log(`[AUTHZ] Seeded ${seeded.rowCount} platform-staff accounts from PLATFORM_ADMIN_EMAILS.`);
        } else {
            console.log('[AUTHZ] PLATFORM_ADMIN_EMAILS not set — no platform staff seeded.');
        }

        const keys = await client.query(`
      UPDATE api_keys
         SET scopes = ARRAY['context:read','context:write','context:admin']
       WHERE scopes @> ARRAY['*'];
    `);
        console.log(`[AUTHZ] Normalized ${keys.rowCount} wildcard api_key scopes.`);

        await client.query('COMMIT');
        console.log('[AUTHZ] Done.');
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('[AUTHZ] Migration failed:', err.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

migrate();
