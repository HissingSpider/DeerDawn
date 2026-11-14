const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

// Adds the unsubscribe flag for the weekly activity-digest email. Idempotent.
const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig(),
});

async function runMigration() {
    try {
        console.log('[migrate-email-prefs] Connecting to DB...');
        await client.connect();
        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS weekly_digest_unsubscribed BOOLEAN NOT NULL DEFAULT FALSE
        `);
        console.log('[migrate-email-prefs] PASS: users.weekly_digest_unsubscribed ready');
    } catch (err) {
        console.error('[migrate-email-prefs] FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        await client.end();
    }
}

runMigration();
