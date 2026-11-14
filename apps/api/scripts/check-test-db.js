const { Client } = require('pg');

const quiet = process.argv.includes('--quiet');
const connectionString = process.env.DATABASE_URL || 'postgres://deerdawn:password@localhost:5432/deerdawn_dev';
const isLocal =
  connectionString.includes('localhost') ||
  connectionString.includes('127.0.0.1') ||
  connectionString.includes('@postgres:');

async function main() {
  const client = new Client({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 5000,
  });

  try {
    await client.connect();
    await client.query('SELECT 1');
    if (!quiet) {
      console.log(`[TEST-DB] Ready: ${connectionString.replace(/:[^:@]+@/, ':***@')}`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

main().catch((error) => {
  if (!quiet) {
    console.error(`[TEST-DB] Unavailable: ${error.message || error}`);
  }
  process.exit(1);
});
