const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig(),
  });

  try {
    await client.connect();
    console.log('[migrate-ltd] connected');
    await client.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS lifetime_activated_at TIMESTAMPTZ');
    console.log('[migrate-ltd] done');
  } catch (err) {
    console.error('[migrate-ltd] failed:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end().catch(() => {});
  }
}

run();
