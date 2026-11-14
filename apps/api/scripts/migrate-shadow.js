const { Client } = require('pg');

const client = new Client({ connectionString: process.env.DATABASE_URL });

async function migrate() {
    await client.connect();
    try {
        await client.query(`
            ALTER TABLE organizations
            ADD COLUMN IF NOT EXISTS shadow_mode BOOLEAN DEFAULT false
        `);
        console.log('[MIGRATE] shadow_mode column added to organizations');
    } finally {
        await client.end();
    }
}

migrate().catch(err => {
    console.error('[MIGRATE] Failed:', err);
    process.exit(1);
});
