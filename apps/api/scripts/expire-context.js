'use strict';

// Run daily to delete context_projects where the owner has set a ttl_days security preference
// and the project hasn't been updated within that window.
// Triggered via node-cron in app.js or run standalone: node scripts/expire-context.js

const { randomUUID } = require('crypto');
const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

async function expireContext() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig(),
  });

  try {
    await client.connect();
    console.log('[expire-context] Starting TTL expiry sweep...');

    // Find owner_keys with a ttl_days setting
    const prefsResult = await client.query(`
      SELECT owner_key, (preferences->'security'->>'ttl_days')::int AS ttl_days
      FROM injection_preferences
      WHERE preferences->'security'->>'ttl_days' IS NOT NULL
    `);

    let totalDeleted = 0;

    for (const { owner_key, ttl_days } of prefsResult.rows) {
      if (!ttl_days || ttl_days < 1) continue;

      const deleteResult = await client.query(`
        DELETE FROM context_projects
        WHERE owner_key = $1
          AND updated_at < NOW() - ($2 || ' days')::INTERVAL
        RETURNING project_id
      `, [owner_key, ttl_days]);

      const count = deleteResult.rowCount || 0;
      if (count > 0) {
        console.log(`[expire-context] Deleted ${count} project(s) for ${owner_key} (ttl=${ttl_days}d)`);
        totalDeleted += count;

        // Log to audit trail
        await client.query(`
          INSERT INTO context_audit_logs (audit_id, owner_key, action, actor_type, metadata, created_at)
          VALUES ($1, $2, 'context_ttl_expired', 'system', $3, NOW())
        `, [`audit_${randomUUID()}`, owner_key, JSON.stringify({ deleted_count: count, ttl_days })]);
      }
    }

    console.log(`[expire-context] Done. Total deleted: ${totalDeleted}`);
    await client.end();
    return totalDeleted;
  } catch (err) {
    console.error('[expire-context] Error:', err.message);
    await client.end().catch(() => {});
    throw err;
  }
}

// Run standalone
if (require.main === module) {
  expireContext()
    .then((n) => { console.log(`[expire-context] Expired ${n} project(s).`); process.exit(0); })
    .catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { expireContext };
