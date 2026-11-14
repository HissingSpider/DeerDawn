const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const DB_URL = process.env.DATABASE_URL || 'postgres://deerdawn:password@localhost:5432/deerdawn_dev';

const client = new Client({
    connectionString: DB_URL,
    ssl: getDbSslConfig()
});

async function runPatch() {
    try {
        console.log('FIX Adding Policy Versioning...');
        await client.connect();

        // 1. Add version column to policies
        await client.query(`
      ALTER TABLE policies 
      ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
    `);

        // 2. Create Policy Versions History Table
        await client.query(`
      CREATE TABLE IF NOT EXISTS policy_versions (
        version_id TEXT PRIMARY KEY,
        policy_id TEXT REFERENCES policies(policy_id) ON DELETE CASCADE,
        org_id TEXT,
        version INTEGER NOT NULL,
        name TEXT,
        action_types JSONB,
        effect TEXT,
        conditions JSONB,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);

        // 3. Create Access Logs Table
        await client.query(`
      CREATE TABLE IF NOT EXISTS access_logs (
        access_id TEXT PRIMARY KEY,
        org_id TEXT,
        actor_id TEXT,
        method TEXT,
        path TEXT,
        status INTEGER,
        ip TEXT,
        user_agent TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    
        console.log('PASS Patch Complete!');
        process.exit(0);
    } catch (err) {
        console.error('FAIL Patch Failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runPatch();
