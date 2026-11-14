const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';

const client = new Client({
    connectionString: DATABASE_URL,
    ssl: getDbSslConfig()
});

async function migrate() {
    try {
        console.log('Connecting to DB...');
        await client.connect();
        console.log('Running cleanup migration...');
        await client.query('BEGIN');

        // Drop redundant last_used column (superseded by last_used_at)
        await client.query(`
            ALTER TABLE api_keys
            DROP COLUMN IF EXISTS last_used
        `);

        // Add missing index on users.org_id FK
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_users_org_id ON users (org_id)
        `);

        // Add composite index for escalation list queries
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_org_status
            ON escalation_resolutions (org_id, status)
        `);

        await client.query('COMMIT');
        console.log('PASS Cleanup migration successful!');
        process.exit(0);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('FAIL Cleanup migration failed:', err);
        process.exit(1);
    }
}

migrate();
