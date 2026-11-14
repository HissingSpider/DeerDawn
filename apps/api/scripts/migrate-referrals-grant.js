const { Client } = require('pg');
const { getDbSslConfig } = require('../src/config/dbSsl');

const connectionString = process.env.DATABASE_URL;
const client = new Client({
  connectionString,
  ssl: getDbSslConfig()
});

// Extract the DB role from DATABASE_URL so the GRANT targets the application user.
// Format: postgres://user:pass@host:port/db
function extractDbUser(url) {
  try {
    const parsed = new URL(url);
    return parsed.username;
  } catch {
    return null;
  }
}

async function run() {
  try {
    console.log('[migrate-referrals-grant] Connecting...');
    await client.connect();

    const dbUser = extractDbUser(connectionString);
    if (!dbUser) {
      throw new Error('Could not parse DB user from DATABASE_URL');
    }
    console.log(`[migrate-referrals-grant] Granting referrals access to role: ${dbUser}`);

    // Check current owner — if we're not the owner, attempt to take ownership (requires superuser).
    const ownerRes = await client.query(
      'SELECT tableowner FROM pg_tables WHERE schemaname = \'public\' AND tablename = \'referrals\''
    );
    const owner = ownerRes.rows[0]?.tableowner;

    if (!owner) {
      // Table doesn't exist yet — autoMigrate will create it and grant inline.
      console.log('[migrate-referrals-grant] SKIP Table does not exist yet; autoMigrate will handle grant at startup.');
      process.exit(0);
    }

    if (owner !== dbUser) {
      console.log(`[migrate-referrals-grant] Table owned by '${owner}', attempting ownership transfer to '${dbUser}'...`);
      await client.query(`ALTER TABLE referrals OWNER TO "${dbUser}";`);
    }

    await client.query(`GRANT SELECT, INSERT, UPDATE ON TABLE referrals TO "${dbUser}";`);
    console.log('[migrate-referrals-grant] PASS Grant applied');

    process.exit(0);
  } catch (err) {
    console.error('[migrate-referrals-grant] FAIL:', err.message);
    console.error('[migrate-referrals-grant] If this is a local dev DB, run: psql -c "GRANT SELECT,INSERT,UPDATE ON referrals TO deerdawn;"');
    process.exit(1);
  } finally {
    await client.end();
  }
}

run();
