const fs = require('fs');
const { getDbSslConfig } = require('../src/config/dbSsl');
const path = require('path');
const { Client } = require('pg');

const schemaPath = path.join(__dirname, '../sql/schema.sql');
const schema = fs.readFileSync(schemaPath, 'utf8');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';

const client = new Client({
    connectionString: DATABASE_URL,
    ssl: getDbSslConfig()
});

async function migrate() {
    try {
        console.log('Connecting to DB...');
        await client.connect();
        console.log('Running migration...');
        await client.query('BEGIN');
        await client.query(schema);
        await client.query('COMMIT');
        console.log('PASS Migration successful!');
        process.exit(0);
    } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        console.error('FAIL Migration failed:', err);
        process.exit(1);
    }
}

migrate();
