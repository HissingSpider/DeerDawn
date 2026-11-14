const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');
const { hashPassword } = require('../src/utils/security');
const { v4: uuidv4 } = require('uuid');

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/deerdawn_dev';

const client = new Client({
    connectionString: DATABASE_URL,
    ssl: getDbSslConfig()
});

async function seed() {
    try {
        console.log('SEED Seeding DB...');
        await client.connect();

        // 1. Create Default Organization
        const orgId = 'org-admin-default';
        const systemOrgId = 'org-system';
    
        // Create System Org
        await client.query('INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [systemOrgId, 'System Org', 'active']);

        const orgCheck = await client.query('SELECT * FROM organizations WHERE org_id = $1', [orgId]);
    
        if (orgCheck.rows.length === 0) {
            const trialEndsAt = new Date();
            trialEndsAt.setFullYear(trialEndsAt.getFullYear() + 10); // 10 year license for admin
        
            await client.query(
                'INSERT INTO organizations (org_id, name, plan, trial_ends_at, subscription_status) VALUES ($1, $2, $3, $4, $5)', 
                [orgId, 'Deerdawn Admin Org', 'enterprise', trialEndsAt.toISOString(), 'active']
            );
            console.log('PASS Created Default Org');
        }

        // 2. Create Admin User
        const email = 'admin@deerdawn.com';
        const password = 'password123'; // In a real script, maybe prompt or use env
        const hash = await hashPassword(password);
        const userId = `user-${uuidv4()}`;

        // Check if exists
        const existing = await client.query('SELECT * FROM users WHERE email = $1', [email]);
        if (existing.rows.length === 0) {
            await client.query(
                'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
                [userId, email, hash, 'admin', orgId]
            );
            console.log(`PASS Created Admin: ${email} / ${password}`);
        } else {
            // Update org_id if missing (fix for existing broken seeds)
            if (!existing.rows[0].org_id) {
                await client.query('UPDATE users SET org_id = $1 WHERE email = $2', [orgId, email]);
                console.log('FIX Fixed Admin Org ID');
            }
            console.log(`ℹ️  Admin ${email} already exists`);
        }

        // 2. Create Sample Policy
        const policyId = 'pol-default-allow';
        const polCheck = await client.query('SELECT * FROM policies WHERE policy_id = $1', [policyId]);
        if (polCheck.rows.length === 0) {
            await client.query(
                `INSERT INTO policies (policy_id, name, enabled, priority, action_types, effect, conditions, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
                [
                    policyId, 'Default Allow', true, 0, JSON.stringify(['*']), 
                    'allow', JSON.stringify([]), 'Baseline allow policy'
                ]
            );
            console.log('PASS Created Default Policy');
        }

        process.exit(0);
    } catch (err) {
        console.error('FAIL Seed failed:', err);
        process.exit(1);
    }
}

seed();
