const db = require('../src/config/db');

async function migrate() {
    const client = await db.pool.connect();
    try {
        await client.query('BEGIN');

        console.log('--- Migrating Organizations Table ---');
        // Add billing fields to organizations if they don't exist
        await client.query(`
      ALTER TABLE organizations 
      ADD COLUMN IF NOT EXISTS plan_tier VARCHAR(50) DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS billing_period_start TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS billing_period_end TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS subscription_status VARCHAR(50) DEFAULT 'active';
    `);

        console.log('--- Creating Usage Counters Table ---');
        // Create usage_counters table
        await client.query(`
      CREATE TABLE IF NOT EXISTS usage_counters (
        org_id TEXT NOT NULL REFERENCES organizations(org_id) ON DELETE CASCADE,
        period_start TIMESTAMPTZ NOT NULL,
        period_end TIMESTAMPTZ NOT NULL,
        decisions_count BIGINT DEFAULT 0,
        reported_overage_count BIGINT DEFAULT 0,
        last_updated_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (org_id, period_start)
      );
    `);

        await client.query('COMMIT');
        console.log('Migration completed successfully.');
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Migration failed:', err);
        process.exit(1);
    } finally {
        client.release();
        process.exit(0);
    }
}

migrate();