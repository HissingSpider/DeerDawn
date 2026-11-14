const { Client } = require('pg');
const { getPlan, normalizePlanId } = require('../src/config/plans');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: true }
});

async function cleanup() {
    try {
        console.log('CLEAN Starting Audit Log Cleanup...');
        await client.connect();

        // 1. Get all orgs and their plans
        const { rows: orgs } = await client.query('SELECT org_id, plan FROM organizations');

        let totalDeleted = 0;

        for (const org of orgs) {
        // 2. Fetch plan limits for retention days
            const plan = getPlan(normalizePlanId(org.plan) || 'starter');
            const retentionDays = plan.limits?.audit_retention_days ?? 0;
      
            const cutoffDate = new Date();
            cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

            console.log(`Checking Org ${org.org_id} (${org.plan}): Retention ${retentionDays} days, Cutoff ${cutoffDate.toISOString()}`);

            // Delete old decisions
            const res = await client.query(
                'DELETE FROM decisions WHERE org_id = $1 AND created_at < $2',
                [org.org_id, cutoffDate]
            );
      
            // Delete old audit logs
            const auditRes = await client.query(
                'DELETE FROM audit_logs WHERE org_id = $1 AND created_at < $2',
                [org.org_id, cutoffDate]
            );

            const deleted = (res.rowCount || 0) + (auditRes.rowCount || 0);
            if (deleted > 0) {
                console.log(`   - Deleted ${deleted} records`);
                totalDeleted += deleted;
            }
        }

        console.log(`PASS Cleanup Complete. Total deleted: ${totalDeleted}`);
        process.exit(0);
    } catch (err) {
        console.error('FAIL Cleanup failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

if (require.main === module) {
    cleanup();
}

module.exports = cleanup;
