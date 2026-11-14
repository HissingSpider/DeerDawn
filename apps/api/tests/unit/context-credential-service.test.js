const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ENCRYPTION_MASTER_KEY = '11'.repeat(32);

const {
  encryptCredential,
  decryptCredential,
} = require('../../src/services/contextCredentialService');
const {
  migrateContextSourceCredentials,
} = require('../../scripts/migrate-context-source-credentials');

test('encrypts and decrypts context credentials using authenticated ciphertext', () => {
  const credential = { access_token: 'secret-notion-token', refresh_token: 'refresh-token' };
  const encrypted = encryptCredential(credential);

  assert.match(encrypted, /^v1:/);
  assert.doesNotMatch(encrypted, /secret-notion-token/);
  assert.deepEqual(decryptCredential(encrypted), credential);
});

test('rejects plaintext and legacy base64 data when decrypting credentials', () => {
  assert.throws(
    () => decryptCredential(Buffer.from('legacy-token').toString('base64')),
    /Expected encrypted credential payload/
  );
});

test('migrates existing legacy integration keys once without rewriting encrypted entries', async () => {
  const encryptedExisting = encryptCredential({ access_token: 'already-secure' });
  const updates = [];
  const database = {
    query: async (sql, params) => {
      if (/^\s*(BEGIN|COMMIT|ROLLBACK)/.test(sql)) {
        return { rows: [] };
      }
      if (sql.includes('SELECT integration_id')) {
        assert.deepEqual(params[0], ['notion', 'slack', 'claude_agent']);
        return {
          rows: [
            { integration_id: 'notion-1', encrypted_key: Buffer.from('legacy-notion').toString('base64') },
            { integration_id: 'slack-1', encrypted_key: encryptedExisting },
          ],
        };
      }
      // Post-migration legacy-credential count must report zero remaining.
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ remaining: 0 }] };
      }
      updates.push(params);
      return { rows: [] };
    },
  };

  const result = await migrateContextSourceCredentials(database);

  // One legacy record migrated, the already-encrypted record skipped, zero legacy left.
  assert.deepEqual(result, { migrated: 1, skipped: 1, total: 2, remaining: 0 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0][1], 'notion-1');
  assert.deepEqual(decryptCredential(updates[0][0]), { access_token: 'legacy-notion' });
});
