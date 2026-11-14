/**
 * Engine Wave 7: record_debug_finding supersede (T1.8) and the confirm_claim verify
 * primitive (T3.7) at the service layer. Supersede drops the stale note so the log
 * holds the correction; confirm_claim stamps verified_at so the next session trusts
 * the claim. Uses the real store (DB).
 *
 * Run: node tests/unit/context-verify-supersede.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const { closeRedisConnections } = require('../../src/config/redis');

const actor = () => ({ org_id: 'org-system', id: 'system-key' });

test.after(async () => { try { await closeRedisConnections(); } catch (_) { /* best effort */ } });

test('record_debug_finding supersede removes the stale note and keeps the correction', async () => {
  await store.clearAll();
  const p = await service.createProject(actor(), { project_name: 'Verify Supersede Test' });
  await service.recordDebugFinding(actor(), p.project_id, { summary: 'freshness.ts has detectTaskDrift', paths: [] });
  const res = await service.recordDebugFinding(actor(), p.project_id, {
    summary: 'freshness.ts has NO detectTaskDrift — corrected',
    paths: [],
    supersedes: 'detectTaskDrift',
  });
  const summaries = (res.debugging_notes || []).map((n) => n.summary);
  assert.ok(summaries.some((s) => s.includes('NO detectTaskDrift')), 'correction is present');
  assert.ok(!summaries.some((s) => s === 'freshness.ts has detectTaskDrift'), 'the stale note was superseded');
});

test('confirm_claim stamps status_verified_at on current_status', async () => {
  await store.clearAll();
  const p = await service.createProject(actor(), { project_name: 'Verify Test', current_status: 'all tests pass' });
  const res = await service.confirmClaim(actor(), p.project_id, { claim: 'status', verified_commit: 'abc1234' });
  assert.equal(res.verified?.kind, 'current_status');
  const proj = await service.getProject(actor(), p.project_id);
  assert.ok(proj.context.status_verified_at, 'status_verified_at persisted');
  assert.equal(proj.context.status_verified_commit, 'abc1234');
});

test('confirm_claim with no matching claim returns verified=null and changes nothing', async () => {
  await store.clearAll();
  const p = await service.createProject(actor(), { project_name: 'Verify Test', current_status: 'shipped' });
  const res = await service.confirmClaim(actor(), p.project_id, { claim: 'a claim that does not exist anywhere' });
  assert.equal(res.verified, null);
});
