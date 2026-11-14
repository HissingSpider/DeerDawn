const { Client } = require('pg');

async function runMigration() {
  const client = new Client({ connectionString: process.env.DATABASE_URL || 'postgres://deerdawn:password@localhost:5432/deerdawn_dev' });
  try {
    await client.connect();

    await client.query(`
      CREATE TABLE IF NOT EXISTS context_integrations (
        integration_id  TEXT PRIMARY KEY,
        owner_key       TEXT NOT NULL,
        provider        TEXT NOT NULL,
        encrypted_key   TEXT,
        agent_id        TEXT,
        agent_url       TEXT,
        meta            JSONB NOT NULL DEFAULT '{}',
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query('CREATE INDEX IF NOT EXISTS idx_ctx_integrations_owner ON context_integrations(owner_key)');
    await client.query('CREATE UNIQUE INDEX IF NOT EXISTS idx_ctx_integrations_owner_provider ON context_integrations(owner_key, provider)');

    console.log('[migrate-integrations] PASS: context_integrations table ready');
    await client.end();
  } catch (err) {
    console.error('[migrate-integrations] ERROR:', err);
    try { await client.end(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
}

runMigration();
