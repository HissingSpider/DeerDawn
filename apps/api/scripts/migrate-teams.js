const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig(),
  });

  try {
    await client.connect();
    console.log('[migrate-teams] connected');
    await client.query(`
      CREATE TABLE IF NOT EXISTS team_members (
        team_member_id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
        user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
        invited_email TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'read-only',
        invited_by_user_id TEXT REFERENCES users(user_id) ON DELETE SET NULL,
        invite_sent_at TIMESTAMPTZ,
        accepted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (org_id, invited_email)
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_team_members_org_id ON team_members(org_id, created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_team_members_user_id ON team_members(user_id)');
    console.log('[migrate-teams] done');
  } catch (err) {
    console.error('[migrate-teams] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

run();
