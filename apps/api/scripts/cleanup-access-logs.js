// Manual / cron entry point for the access_logs retention prune. The scheduler
// runs the same function nightly (src/jobs/scheduler.js); this exists for the
// first drain of a backlog and for running it on demand, in the same shape as
// scripts/cleanup-audit-logs.js.
//
//   ACCESS_LOG_RETENTION_DAYS   default 90
//   ACCESS_LOG_PRUNE_BATCH      default 5000 rows per DELETE
//   ACCESS_LOG_PRUNE_MAX_BATCHES default 200 per run
const { Client } = require('pg');
const { pruneAccessLogs } = require('../src/jobs/accessLogRetentionJob');

async function cleanup() {
    const client = new Client({
        connectionString: process.env.DATABASE_URL,
        // Same posture as cleanup-audit-logs.js for a remote database; a local
        // one (docker compose, tests) has no TLS to verify.
        ssl: /localhost|127\.0\.0\.1|@postgres[:/]/.test(process.env.DATABASE_URL || '') ? false : { rejectUnauthorized: true },
    });
    try {
        console.log('CLEAN Starting Access Log Cleanup...');
        await client.connect();
        const result = await pruneAccessLogs({ query: (text, params) => client.query(text, params) });
        console.log(`PASS Cleanup Complete. Total deleted: ${result.deleted}${result.more ? ' (cap reached; run again)' : ''}`);
        return result;
    } finally {
        await client.end().catch(() => {});
    }
}

if (require.main === module) {
    cleanup().then(() => process.exit(0)).catch((err) => {
        console.error('FAIL Cleanup failed:', err);
        process.exit(1);
    });
}

module.exports = cleanup;
