'use strict';

const db = require('../src/config/db');

const CREDENTIAL_PROVIDERS = ['notion', 'slack', 'claude_agent'];

async function verifyCredentialMigration(database = db) {
  const result = await database.query(
    `SELECT COUNT(*)::int AS remaining
       FROM context_integrations
      WHERE provider = ANY($1)
        AND encrypted_key IS NOT NULL
        AND encrypted_key NOT LIKE 'v1:%'`,
    [CREDENTIAL_PROVIDERS],
    'org-system'
  );
  return Number(result.rows?.[0]?.remaining || 0);
}

if (require.main === module) {
  verifyCredentialMigration()
    .then((remaining) => {
      if (remaining > 0) {
        console.error(`[verify-credential-migration] Found ${remaining} legacy credential record(s).`);
        process.exit(1);
      }
      console.log('[verify-credential-migration] All credential records use v1 encryption.');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[verify-credential-migration] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { verifyCredentialMigration };
