const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig()
});

async function runMigration() {
    try {
        console.log('[migrate-personal] Connecting to DB...');
        await client.connect();

        console.log('[migrate-personal] Adding account_type column to organizations...');
        await client.query(`
            ALTER TABLE organizations
            ADD COLUMN IF NOT EXISTS account_type TEXT DEFAULT 'organization'
            CHECK (account_type IN ('organization', 'personal'));
        `);
        console.log('[migrate-personal] PASS: account_type column added');

        await client.end();
        console.log('[migrate-personal] Migration complete.');
    } catch (err) {
        console.error('[migrate-personal] ERROR:', err);
        try { await client.end(); } catch (_) { /* ignore disconnect errors */ }
        process.exit(1);
    }
}

runMigration();
