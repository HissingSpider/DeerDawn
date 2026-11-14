const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const DB_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';


const client = new Client({
    connectionString: DB_URL,
    ssl: getDbSslConfig()
});

async function runMigration() {
    try {
        console.log('Connecting to DB for PRD Gap Analysis migrations...');
        await client.connect();

        console.log('Creating escalation_resolutions table...');

        // 1. Escalation Resolutions Table (Critical Gap #1)
        await client.query(`
            CREATE TABLE IF NOT EXISTS escalation_resolutions (
                resolution_id TEXT PRIMARY KEY,
                decision_id TEXT NOT NULL,
                status TEXT CHECK (status IN ('pending', 'approved', 'denied')) NOT NULL DEFAULT 'pending',
                approver_id TEXT,
                approver_email TEXT,
                justification TEXT,
                sla_minutes INTEGER DEFAULT 240,
                sla_deadline TIMESTAMP WITH TIME ZONE,
                resolved_at TIMESTAMP WITH TIME ZONE,
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                org_id TEXT NOT NULL
            );
        `);

        await client.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS idx_escalation_resolutions_decision_unique
            ON escalation_resolutions(decision_id);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_status
            ON escalation_resolutions(status);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_escalation_resolutions_org
            ON escalation_resolutions(org_id);
        `);

        console.log('Escalation resolutions table created');

        // 2. Policy Hit Count Tracking (Critical Gap #3)
        console.log('Adding policy hit count tracking...');

        await client.query(`
            ALTER TABLE policies
            ADD COLUMN IF NOT EXISTS hit_count INTEGER DEFAULT 0;
        `);

        await client.query(`
            ALTER TABLE policies
            ADD COLUMN IF NOT EXISTS last_hit_at TIMESTAMP WITH TIME ZONE;
        `);

        console.log('Policy hit count tracking added');

        // 3. System Health Metrics (Critical Gap #4)
        console.log('Creating system_health_log table...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS system_health_log (
                log_id TEXT PRIMARY KEY,
                timestamp TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
                metric_name TEXT NOT NULL,
                metric_value NUMERIC,
                metadata JSONB DEFAULT '{}'::jsonb,
                org_id TEXT
            );
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_system_health_timestamp
            ON system_health_log(timestamp DESC);
        `);

        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_system_health_metric
            ON system_health_log(metric_name, timestamp DESC);
        `);

        console.log('System health log table created');

        // 4. Decision Detail Enhancements (Critical Gap #2)
        console.log('Adding decision detail fields...');

        await client.query(`
            ALTER TABLE decisions
            ADD COLUMN IF NOT EXISTS request_metadata JSONB DEFAULT '{}'::jsonb;
        `);

        await client.query(`
            ALTER TABLE decisions
            ADD COLUMN IF NOT EXISTS evaluated_policies JSONB DEFAULT '[]'::jsonb;
        `);

        await client.query(`
            ALTER TABLE decisions
            ADD COLUMN IF NOT EXISTS explanation TEXT;
        `);

        await client.query(`
            ALTER TABLE decisions
            ADD COLUMN IF NOT EXISTS integration_id TEXT;
        `);

        await client.query(`
            ALTER TABLE decisions
            ADD COLUMN IF NOT EXISTS latency_ms INTEGER;
        `);

        console.log('Decision detail fields added');

        // 5. Integration Enhancements
        console.log('Adding integration tracking fields...');

        await client.query(`
            ALTER TABLE integrations
            ADD COLUMN IF NOT EXISTS enabled BOOLEAN DEFAULT true;
        `);

        await client.query(`
            ALTER TABLE integrations
            ADD COLUMN IF NOT EXISTS last_decision_at TIMESTAMP WITH TIME ZONE;
        `);

        await client.query(`
            ALTER TABLE integrations
            ADD COLUMN IF NOT EXISTS total_decisions INTEGER DEFAULT 0;
        `);

        console.log('Integration tracking fields added');

        // 6. User Activity Tracking
        console.log('Adding user activity tracking...');

        await client.query(`
            ALTER TABLE users
            ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMP WITH TIME ZONE;
        `);

        console.log('User activity tracking added');

        // 7. API Key Last Used Tracking
        console.log('Ensuring API key last_used field exists...');

        await client.query(`
            ALTER TABLE api_keys
            ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
        `);

        console.log('API key tracking verified');

        // 8. Leads table
        console.log('Creating leads table...');

        await client.query(`
            CREATE TABLE IF NOT EXISTS leads (
                lead_id UUID PRIMARY KEY,
                email VARCHAR(255) NOT NULL,
                company_name VARCHAR(255),
                use_case VARCHAR(255),
                created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
            );
        `);

        console.log('Leads table created');

        console.log('SUCCESS! All PRD gap migrations complete!');
        console.log('');
        console.log('Summary of changes:');
        console.log('  escalation_resolutions table (with SLA tracking)');
        console.log('  policies.hit_count and policies.last_hit_at');
        console.log('  system_health_log table');
        console.log('  decisions detail fields (metadata, evaluated_policies, explanation)');
        console.log('  integrations tracking (enabled, last_decision_at, total_decisions)');
        console.log('  users.last_active_at');
        console.log('  api_keys.expires_at');
        console.log('  decisions.latency_ms');
        console.log('  leads table');

        process.exit(0);
    } catch (err) {
        console.error('FAIL Migration failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runMigration();
