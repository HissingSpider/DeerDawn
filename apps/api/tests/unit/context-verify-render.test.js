/**
 * Engine Wave 7 / T3.7: the verify primitive (confirm_claim) stamps verified_at,
 * and the brief renders a stable "✓ verified" marker so the next session trusts
 * the claim instead of re-checking. The marker carries NO live timestamp, so it
 * doesn't churn the injection dedup fingerprint. Pure (no DB).
 *
 * Run: node tests/unit/context-verify-render.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatCodeInjection, formatConversationalInjection } = require('../../../../packages/shared-context/src/index.js');

const NOW = '2026-06-26T00:00:00.000Z';
// Critical so the decision is always selected ahead of status, regardless of budget.
const verifiedCtx = {
  project_name: 'X',
  current_status: 'auth service shipped',
  status_verified_at: NOW,
  recent_decisions: [{ summary: 'Use JWT for stateless auth', decided_at: NOW, importance: 'critical', verified_at: NOW }],
};

test('code injection renders ✓ verified on a verified decision and status', () => {
  const { body } = formatCodeInjection(verifiedCtx, 'standard', null, { now: NOW, tz: 'UTC' });
  assert.match(body, /Use JWT for stateless auth.*✓ verified/, 'verified decision marker');
  assert.match(body, /Current status:.*✓ verified/, 'verified status marker');
});

test('conversational injection renders ✓ verified on a verified decision', () => {
  const { body } = formatConversationalInjection(verifiedCtx, 'standard', null, { now: NOW, tz: 'UTC' });
  assert.match(body, /Use JWT for stateless auth.*✓ verified/, 'verified decision marker');
});

test('an unverified decision/status shows no marker', () => {
  const ctx = {
    project_name: 'X',
    current_status: 'auth service shipped',
    recent_decisions: [{ summary: 'Use JWT for stateless auth', decided_at: NOW, importance: 'critical' }],
  };
  const { body } = formatCodeInjection(ctx, 'standard', null, { now: NOW, tz: 'UTC' });
  assert.doesNotMatch(body, /✓ verified/, 'no marker without verified_at');
});
