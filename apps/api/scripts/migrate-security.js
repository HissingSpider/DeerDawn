const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: getDbSslConfig()
});

async function migrate() {
    try {
        await client.connect();
        console.log('SEC  Enabling Database Security Controls...');

        // 1. Ensure Columns Exist for core security features
        console.log('STEP 1: Patching schema...');
    
        // Audit Logs
        await client.query('ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES organizations(org_id);');
    
        // Organizations
        await client.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS redaction_mode TEXT DEFAULT \'strict\';');
        await client.query('ALTER TABLE organizations ADD COLUMN IF NOT EXISTS redaction_keys TEXT[] DEFAULT \'{}\';');
    
        // Decisions
        await client.query(`
        ALTER TABLE decisions ADD COLUMN IF NOT EXISTS is_fail_safe BOOLEAN DEFAULT FALSE;
    `);

        // 2. Add last_used_at and expires_at to API Keys
        console.log('STEP 2: Patching API Keys...');
        await client.query(`
        ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at TIMESTAMP WITH TIME ZONE;
        ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT '{decisions:evaluate}';
        ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS oauth_resource TEXT;
    `);
    
        // Backfill expiration if missing
        await client.query('UPDATE api_keys SET expires_at = created_at + INTERVAL \'90 days\' WHERE expires_at IS NULL;');
        await client.query('ALTER TABLE api_keys ALTER COLUMN expires_at SET NOT NULL;');

        // 3. Ensure System context exists
        console.log('STEP 3: Ensuring System Context and Role Constraints...');
    
        // Fix role constraint if it's outdated (org-scoped roles: read-only < member < owner)
        await client.query(`
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('owner', 'member', 'read-only', 'admin', 'operator', 'approver'));
        ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_staff BOOLEAN NOT NULL DEFAULT FALSE;
    `);

        await client.query('INSERT INTO organizations (org_id, name) VALUES (\'org-system\', \'System Context\') ON CONFLICT DO NOTHING;');

        // 4. Enable RLS (Note: Policies must be created for each table)
        console.log('STEP 4: Activating Row Level Security...');
        const tables = ['decisions', 'policies', 'api_keys', 'audit_logs', 'integrations'];
        for (const table of tables) {
            await client.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;`);
        
            // This policy ensures that the 'org_id' in the row matches the 'org_id' in the app-set config
            // Special case: 'org-system' bypasses isolation for lookups (like finding an API key's owner)
            await client.query(`
            DROP POLICY IF EXISTS ${table}_isolation_policy ON ${table};
            CREATE POLICY ${table}_isolation_policy ON ${table}
            USING (
                org_id = current_setting('app.current_org_id', true) 
                OR 
                current_setting('app.current_org_id', true) = 'org-system'
            );
        `);
        }

        console.log('PASS Security Migration Complete');
        process.exit(0);
    } catch (err) {
        console.error('FAIL Migration failed:', err);
        process.exit(1);
    }
}

migrate();
