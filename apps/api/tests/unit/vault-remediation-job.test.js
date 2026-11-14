const test = require('node:test');
const assert = require('node:assert');
const { runVaultRemediation } = require('../../src/jobs/vaultRemediationJob');
const db = require('../../src/config/db');

// Runs every remediation phase against the real DB. Each phase is isolated in
// its own try/catch (see runPhase in vaultRemediationJob.js) and logs
// "[VAULT-REMEDIATION] Phase N (...) failed:" on error rather than aborting the
// rest of the run — so we assert that no phase logged a failure.
// This would have caught the Phase 8 updated_at text/timestamptz type error that
// only surfaced in prod.
test('runVaultRemediation executes all phases without a failure', async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await runVaultRemediation();
  } finally {
    console.error = originalError;
  }
  const failed = errors.find((line) => line.includes('[VAULT-REMEDIATION]') && line.includes('failed'));
  assert.strictEqual(failed, undefined, `remediation phase failed: ${failed}`);
  await db.pool.end();
});
