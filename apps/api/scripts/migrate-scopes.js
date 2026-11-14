const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig()
});

async function migrate() {
    try {
        await client.connect();
        console.log('[MIGRATE] Adding scopes column to api_keys table...');

        // Add scopes column if it doesn't exist
        await client.query(`
            ALTER TABLE api_keys
            ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT '{decisions:evaluate}'
        `);

        console.log('[MIGRATE] Scopes column added successfully');
        await client.end();
        process.exit(0);
    } catch (err) {
        console.error('[MIGRATE] Migration failed:', err.message);
        await client.end();
        process.exit(1);
    }
}

migrate();
