'use strict';

const db = require('../src/config/db');
const { encryptCredential } = require('../src/services/contextCredentialService');

const CREDENTIAL_PROVIDERS = ['notion', 'slack', 'claude_agent'];

function decodeLegacyCredential(encodedValue) {
  const normalized = String(encodedValue || '').trim();
  if (!normalized || !/^[A-Za-z0-9+/=]+$/.test(normalized)) {
    throw new Error('legacy value is not valid base64');
  }
  const decodedBuffer = Buffer.from(normalized, 'base64');
  if (!decodedBuffer.length) {
    throw new Error('legacy value decoded to empty payload');
  }
  const roundTrip = decodedBuffer.toString('base64').replace(/=+$/g, '');
  if (roundTrip !== normalized.replace(/=+$/g, '')) {
    throw new Error('legacy value failed base64 round-trip validation');
  }
  const plaintext = decodedBuffer.toString('utf8').trim();
  if (!plaintext) {
    throw new Error('legacy value decoded to empty text');
  }
  return plaintext;
}

async function migrateContextSourceCredentials(database = db) {
  await database.query('BEGIN', [], 'org-system');
  try {
    const result = await database.query(
      `SELECT integration_id, encrypted_key
         FROM context_integrations
        WHERE provider = ANY($1)
          AND encrypted_key IS NOT NULL
        FOR UPDATE`,
      [CREDENTIAL_PROVIDERS],
      'org-system'
    );

    let migrated = 0;
    let skipped = 0;
    const failures = [];

    for (const row of result.rows || []) {
      if (String(row.encrypted_key || '').startsWith('v1:')) {
        skipped += 1;
        continue;
      }

      try {
        const plaintext = decodeLegacyCredential(row.encrypted_key);
        const encrypted = encryptCredential({ access_token: plaintext });
        await database.query(
          `UPDATE context_integrations
              SET encrypted_key = $1,
                  updated_at = NOW()
            WHERE integration_id = $2`,
          [encrypted, row.integration_id],
          'org-system'
        );
        migrated += 1;
      } catch (err) {
        failures.push({
          integration_id: row.integration_id,
          reason: err.message,
        });
      }
    }

    if (failures.length > 0) {
      throw new Error(`Validation failed for ${failures.length} credential record(s): ${failures.map((entry) => entry.integration_id).join(', ')}`);
    }

    const remaining = await database.query(
      `SELECT COUNT(*)::int AS remaining
         FROM context_integrations
        WHERE provider = ANY($1)
          AND encrypted_key IS NOT NULL
          AND encrypted_key NOT LIKE 'v1:%'`,
      [CREDENTIAL_PROVIDERS],
      'org-system'
    );
    const remainingCount = Number(remaining.rows?.[0]?.remaining || 0);
    if (remainingCount > 0) {
      throw new Error(`Migration left ${remainingCount} legacy credential record(s).`);
    }

    await database.query('COMMIT', [], 'org-system');
    return {
      migrated,
      skipped,
      total: (result.rows || []).length,
      remaining: remainingCount,
    };
  } catch (err) {
    await database.query('ROLLBACK', [], 'org-system');
    throw err;
  }
}

if (require.main === module) {
  migrateContextSourceCredentials()
    .then((result) => {
      console.log(`[migrate-context-source-credentials] Migrated ${result.migrated} credential record(s), skipped ${result.skipped}, total ${result.total}.`);
      process.exit(0);
    })
    .catch((err) => {
      console.error('[migrate-context-source-credentials] Failed:', err.message);
      process.exit(1);
    });
}

module.exports = { migrateContextSourceCredentials };
