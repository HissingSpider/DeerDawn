const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig()
});

async function runPatch() {
    try {
        console.log('FIX Connecting to DB for Full Patch/Init...');
        await client.connect();

        console.log('Ensuring Base Tables Exist...');

        // 1. Organizations
        await client.query(`
      CREATE TABLE IF NOT EXISTS organizations (
        org_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        // Patch columns
        await client.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT \'growth\';');
        await client.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMP WITH TIME ZONE;');
        await client.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS subscription_status TEXT DEFAULT \'trial_active\';');
        console.log('PASS Checked/Patched: organizations');

        // 2. Users
        await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
    // Patch columns
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS org_id TEXT;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_token_hash TEXT;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS invite_expires_at TIMESTAMP WITH TIME ZONE;');
    await client.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS password_reset_required BOOLEAN DEFAULT FALSE;');
    console.log('PASS Checked/Patched: users');

        // 3. API Keys
        await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        key_id TEXT PRIMARY KEY,
        prefix TEXT NOT NULL,
        key_hash TEXT NOT NULL,
        name TEXT,
        owner_id TEXT,
        status TEXT DEFAULT 'active',
        last_used TIMESTAMP WITH TIME ZONE,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        // Patch columns
        await client.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS org_id TEXT;');
        await client.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS environment TEXT DEFAULT \'production\';');
        await client.query('ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS oauth_resource TEXT;');
        console.log('PASS Checked/Patched: api_keys');

        // 4. Policies
        await client.query(`
      CREATE TABLE IF NOT EXISTS policies (
        policy_id TEXT PRIMARY KEY,
        name TEXT,
        enabled BOOLEAN DEFAULT TRUE,
        priority INTEGER DEFAULT 0,
        action_types JSONB NOT NULL,
        effect TEXT NOT NULL,
        conditions JSONB DEFAULT '[]'::jsonb,
        reason TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        last_modified TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        // Patch columns
        await client.query('ALTER TABLE policies ADD COLUMN IF NOT EXISTS org_id TEXT;');
        await client.query('ALTER TABLE policies ADD COLUMN IF NOT EXISTS environment TEXT DEFAULT \'production\';');
        await client.query('ALTER TABLE policies ADD COLUMN IF NOT EXISTS hit_count INTEGER DEFAULT 0;');
        await client.query('ALTER TABLE policies ADD COLUMN IF NOT EXISTS last_hit_at TIMESTAMP WITH TIME ZONE;');
        console.log('PASS Checked/Patched: policies');

        // 5. Decisions
        await client.query(`
      CREATE TABLE IF NOT EXISTS decisions (
        decision_id TEXT PRIMARY KEY,
        trace_id TEXT UNIQUE NOT NULL,
        action_type TEXT NOT NULL,
        decision TEXT NOT NULL,
        reason TEXT,
        policy_ids JSONB DEFAULT '[]'::jsonb,
        findings JSONB DEFAULT '[]'::jsonb,
        summary JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
        latency TEXT,
        latency_ms INTEGER
      );
    `);
        // Patch columns
        await client.query('ALTER TABLE decisions ADD COLUMN IF NOT EXISTS org_id TEXT;');
        await client.query('ALTER TABLE decisions ADD COLUMN IF NOT EXISTS environment TEXT DEFAULT \'production\';');
        await client.query('ALTER TABLE decisions ADD COLUMN IF NOT EXISTS latency_ms INTEGER;');
        console.log('PASS Checked/Patched: decisions');

        // 6. Integrations
        await client.query(`
      CREATE TABLE IF NOT EXISTS integrations (
        integration_id TEXT PRIMARY KEY,
        org_id TEXT,
        type TEXT NOT NULL,
        config JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        await client.query('ALTER TABLE integrations ADD COLUMN IF NOT EXISTS webhook_secret TEXT;');
        console.log('PASS Checked/Patched: integrations');
    
        // 7. Enterprise Inquiries
        await client.query(`
      CREATE TABLE IF NOT EXISTS enterprise_inquiries (
        inquiry_id TEXT PRIMARY KEY,
        org_id TEXT,
        user_id TEXT,
        company_size TEXT,
        estimated_decisions TEXT,
        use_case TEXT,
        timeline TEXT,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        console.log('PASS Checked/Patched: enterprise_inquiries');

        // 8. Audit Logs
        await client.query(`
      CREATE TABLE IF NOT EXISTS audit_logs (
        log_id TEXT PRIMARY KEY,
        org_id TEXT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target TEXT,
        details JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        console.log('PASS Checked/Patched: audit_logs');

        // 9. Escalation Resolutions
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
        console.log('PASS Checked/Patched: escalation_resolutions');

        // 10. Leads
        await client.query(`
      CREATE TABLE IF NOT EXISTS leads (
        lead_id UUID PRIMARY KEY,
        email VARCHAR(255) NOT NULL,
        company_name VARCHAR(255),
        use_case VARCHAR(255),
        created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );
    `);
        console.log('PASS Checked/Patched: leads');

        console.log('SUCCESS Full Init/Patch Complete!');
        process.exit(0);
    } catch (err) {
        console.error('FAIL Patch Failed:', err);
        process.exit(1);
    } finally {
        await client.end();
    }
}

runPatch();
