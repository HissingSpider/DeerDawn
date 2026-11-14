const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';


const client = new Client({
    connectionString: DB_URL,
    ssl: getDbSslConfig()
});

async function runMigration() {
    try {
        console.log('Connecting to DB for onboarding survey migration...');
        await client.connect();

        console.log('Creating onboarding_responses table...');
        await client.query(`
            CREATE TABLE IF NOT EXISTS onboarding_responses (
                user_id     TEXT PRIMARY KEY,
                org_id      TEXT REFERENCES organizations(org_id) ON DELETE CASCADE,
                role        TEXT,
                primary_use TEXT,
                tools       TEXT[] DEFAULT '{}',
                team_size   TEXT,
                motivation  TEXT,
                created_at  TIMESTAMPTZ DEFAULT NOW(),
                updated_at  TIMESTAMPTZ DEFAULT NOW()
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_onboarding_responses_org
            ON onboarding_responses (org_id, created_at DESC);
        `);

        console.log('onboarding_responses created successfully!');
        process.exit(0);
    } catch (err) {
        console.error('FAIL Migration failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runMigration();
