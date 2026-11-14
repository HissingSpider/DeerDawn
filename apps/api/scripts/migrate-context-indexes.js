const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig(),
});

async function run() {
    try {
        await client.connect();
        console.log('[MIGRATE] Adding context sync indexes...');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_projects_owner_key
                ON context_projects(owner_key);
        `);
        console.log('[MIGRATE] idx_context_projects_owner_key OK');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_projects_owner_updated
                ON context_projects(owner_key, updated_at DESC);
        `);
        console.log('[MIGRATE] idx_context_projects_owner_updated OK');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_events_project_created
                ON context_events(project_id, created_at DESC);
        `);
        console.log('[MIGRATE] idx_context_events_project_created OK');

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_context_sessions_owner_session
                ON context_sessions(owner_key, session_id);
        `);
        console.log('[MIGRATE] idx_context_sessions_owner_session OK');

        console.log('[MIGRATE] All context indexes applied.');
        await client.end();
        process.exit(0);
    } catch (err) {
        console.error('[MIGRATE] Failed:', err.message);
        await client.end().catch(() => {});
        process.exit(1);
    }
}

run();
