'use strict';

const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: getDbSslConfig(),
});

async function runMigration() {
  try {
    console.log('[migrate-encryption] Connecting to DB...');
    await client.connect();

    console.log('[migrate-encryption] Creating user_encryption_keys table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_encryption_keys (
        owner_key     TEXT PRIMARY KEY,
        encrypted_dek TEXT NOT NULL,
        dek_version   INT NOT NULL DEFAULT 1,
        encrypted_at  TIMESTAMPTZ DEFAULT NOW(),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    console.log('[migrate-encryption] PASS: user_encryption_keys ready');

    console.log('[migrate-encryption] Creating context_audit_logs table...');
    await client.query(`
      CREATE TABLE IF NOT EXISTS context_audit_logs (
        id          BIGSERIAL PRIMARY KEY,
        owner_key   TEXT NOT NULL,
        project_id  TEXT,
        action      TEXT NOT NULL,
        actor_type  TEXT,
        tool        TEXT,
        metadata    JSONB,
        created_at  TIMESTAMPTZ DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_context_audit_owner
        ON context_audit_logs(owner_key, created_at DESC);
    `);
    console.log('[migrate-encryption] PASS: context_audit_logs ready');

    console.log('[migrate-encryption] Migration complete.');
    await client.end();
  } catch (err) {
    console.error('[migrate-encryption] FAIL:', err.message);
    await client.end().catch(() => {});
    process.exit(1);
  }
}

runMigration();
