/**
 * Retention metrics — the "can we measure pay-twice" brain.
 *
 * Pure-function tests (no DB). Deterministic: `now` is injected.
 *
 * Run: node tests/unit/retention-metrics.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { computeRetentionMetrics } = require('../../src/services/retentionMetrics');

const NOW = Date.parse('2026-06-08T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const at = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const monthOf = (iso) => iso.slice(0, 7); // YYYY-MM

test('empty ledger yields zeroed metrics', () => {
  const m = computeRetentionMetrics([], NOW);
  assert.equal(m.active_subscriptions, 0);
  assert.equal(m.mrr_cents, 0);
  assert.equal(m.renewals, 0);
  assert.equal(m.churned, 0);
  assert.deepEqual(m.cohort_retention, []);
});

test('folds a realistic ledger into active count, MRR, window stats, and cohorts', () => {
  const events = [
    // A: paying, renewed twice inside the window → active, contributes MRR.
    { org_id: 'A', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(60) },
    { org_id: 'A', event_type: 'renewed', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(20) },
    { org_id: 'A', event_type: 'renewed', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(1) },
    // B: churned inside the window.
    { org_id: 'B', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(50) },
    { org_id: 'B', event_type: 'cancelled', plan_tier: 'free', mrr_cents: 0, occurred_at: at(10) },
    // C: brand new inside the window.
    { org_id: 'C', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(5) },
    // D: active but payment just failed → counted active + past_due.
    { org_id: 'D', event_type: 'created', plan_tier: 'scale', mrr_cents: 2500, occurred_at: at(40) },
    { org_id: 'D', event_type: 'payment_failed', plan_tier: 'scale', mrr_cents: 2500, occurred_at: at(2) },
  ];
  const m = computeRetentionMetrics(events, NOW);

  assert.equal(m.active_subscriptions, 3, 'A, C, D active; B churned');
  assert.equal(m.mrr_cents, 4500, '1000 + 1000 + 2500');
  assert.equal(m.arr_cents, 54000);
  assert.equal(m.past_due, 1, 'D failed payment but is not yet churned');
  assert.equal(m.new_subscriptions, 1, 'only C first paid inside the 30d window');
  assert.equal(m.renewals, 2, 'both of A\'s renewals fall in the window');
  assert.equal(m.churned, 1, 'B cancelled in the window');
  // Denominator is customers active at the START of the window (A, B, D — not C,
  // which was acquired mid-window). B is the only one of that base that churned.
  assert.equal(m.churn_rate, 0.3333, '1 churned of 3 active-at-window-start');

  const apr = m.cohort_retention.find((c) => c.cohort === '2026-04');
  assert.ok(apr, 'April cohort exists');
  assert.equal(apr.size, 3, 'A, B, D first paid in April');
  assert.equal(apr.retained, 2, 'A and D still active; B churned');
  assert.equal(apr.retention, 0.6667);
});

test('win-back re-subscription does not inflate the original cohort', () => {
  const events = [
    { org_id: 'X', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(90) },   // Mar
    { org_id: 'X', event_type: 'cancelled', plan_tier: 'free', mrr_cents: 0, occurred_at: at(60) },    // Apr — churned out
    { org_id: 'X', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(3) },     // Jun — reacquired
  ];
  const m = computeRetentionMetrics(events, NOW);
  assert.equal(m.active_subscriptions, 1, 'latest state is active');
  assert.equal(m.mrr_cents, 1000);

  const orig = m.cohort_retention.find((c) => c.cohort === monthOf(at(90)));
  assert.ok(orig, 'original acquisition cohort exists');
  assert.equal(orig.retained, 0, 'the original cohort churned out — its return is NOT credited here');

  const reacq = m.cohort_retention.find((c) => c.cohort === monthOf(at(3)));
  assert.ok(reacq, 'reacquisition cohort exists');
  assert.equal(reacq.retained, 1, 'win-back counts as a fresh, currently-retained cohort');
});

test('mid-cycle plan change re-prices MRR immediately (not stale until renewal)', () => {
  const events = [
    { org_id: 'P', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, occurred_at: at(40) },
    // Upgrade between renewals — without a ledger event MRR would sit at 1000 until
    // the next renewal. plan_changed re-prices it now and is neither a renewal nor churn.
    { org_id: 'P', event_type: 'plan_changed', plan_tier: 'scale', mrr_cents: 2500, occurred_at: at(8) },
  ];
  const m = computeRetentionMetrics(events, NOW);
  assert.equal(m.active_subscriptions, 1);
  assert.equal(m.mrr_cents, 2500, 'MRR reflects the upgraded plan immediately');
  assert.equal(m.renewals, 0, 'a plan change is not a renewal');
  assert.equal(m.churned, 0, 'a plan change is not churn');
});
