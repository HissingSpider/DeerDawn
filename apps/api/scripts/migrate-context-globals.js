const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig()
});

async function runMigration() {
    try {
        console.log('[migrate-context-globals] Connecting to DB...');
        await client.connect();

        console.log('[migrate-context-globals] Creating context_globals table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS context_globals (
                owner_key   TEXT PRIMARY KEY,
                global      JSONB NOT NULL DEFAULT '{}',
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            );
        `);
        console.log('[migrate-context-globals] PASS: context_globals table ready');

        await client.end();
        console.log('[migrate-context-globals] Migration complete.');
    } catch (err) {
        console.error('[migrate-context-globals] ERROR:', err);
        try { await client.end(); } catch (_) { /* ignore */ }
        process.exit(1);
    }
}

runMigration();
