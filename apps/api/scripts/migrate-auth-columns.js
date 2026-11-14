const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';


const client = new Client({
    connectionString: DB_URL,
    ssl: getDbSslConfig()
});

async function runMigration() {
    try {
        console.log('Connecting to DB for auth columns migration...');
        await client.connect();

        console.log('Adding auth_provider and auth_subject columns to users table...');

        // Add auth_provider column
        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS auth_provider TEXT DEFAULT 'local';
        `);

        // Add auth_subject column
        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS auth_subject TEXT;
        `);

        // Add unique index on auth_subject (for faster lookups and uniqueness)
        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_users_auth_subject
            ON users(auth_subject)
            WHERE auth_subject IS NOT NULL;
        `);

        console.log('Auth columns added successfully!');
        console.log('');
        console.log('Summary of changes:');
        console.log('  users.auth_provider (default: "local")');
        console.log('  users.auth_subject (unique)');
        console.log('  Unique index on auth_subject');

        process.exit(0);
    } catch (err) {
        console.error('FAIL Migration failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runMigration();
