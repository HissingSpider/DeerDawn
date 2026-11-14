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
        console.log('Adding invite_code column to organizations...');
        await client.query(`
            ALTER TABLE organizations
            ADD COLUMN IF NOT EXISTS invite_code TEXT UNIQUE;
        `);
        console.log('PASS Migration successful!');
        process.exit(0);
    } catch (err) {
        console.error('FAIL Migration failed:', err);
        process.exit(1);
    }
}

migrate();
