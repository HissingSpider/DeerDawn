/**
 * Retention ledger — append, idempotent dedup, and fold into metrics.
 *
 * DB-backed; isolated by an org_id prefix so it ignores any other rows.
 * Run via scripts/run-db-test.sh node tests/unit/retention-ledger.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const ledger = require('../../src/services/retentionLedger');
const { computeRetentionMetrics } = require('../../src/services/retentionMetrics');

const PREFIX = 'ret-test-';

async function cleanup() {
  await ledger.ensureTable();
  await db.query(`DELETE FROM subscription_events WHERE org_id LIKE '${PREFIX}%'`, [], 'org-system');
}

test('ledger records, dedupes by stripe event, rejects bad types, and folds into metrics', async () => {
  await cleanup();
  const now = Date.parse('2026-06-08T00:00:00.000Z');
  const iso = (daysAgo) => new Date(now - daysAgo * 86400000).toISOString();

  await ledger.recordSubscriptionEvent({ org_id: PREFIX + 'a', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, stripe_event_id: 'evt_1', occurred_at: iso(40) });
  await ledger.recordSubscriptionEvent({ org_id: PREFIX + 'a', event_type: 'renewed', plan_tier: 'pro', mrr_cents: 1000, stripe_event_id: 'evt_2', occurred_at: iso(5) });
  // Duplicate webhook delivery of the same event must not double-count.
  await ledger.recordSubscriptionEvent({ org_id: PREFIX + 'a', event_type: 'renewed', plan_tier: 'pro', mrr_cents: 1000, stripe_event_id: 'evt_2', occurred_at: iso(5) });
  await ledger.recordSubscriptionEvent({ org_id: PREFIX + 'b', event_type: 'created', plan_tier: 'pro', mrr_cents: 1000, stripe_event_id: 'evt_3', occurred_at: iso(20) });
  await ledger.recordSubscriptionEvent({ org_id: PREFIX + 'b', event_type: 'cancelled', plan_tier: 'free', mrr_cents: 0, stripe_event_id: 'evt_4', occurred_at: iso(2) });
  // Invalid event type is ignored.
  await ledger.recordSubscriptionEvent({ org_id: PREFIX + 'c', event_type: 'bogus', mrr_cents: 999 });

  const events = (await ledger.listSubscriptionEvents()).filter((e) => e.org_id.startsWith(PREFIX));
  assert.equal(events.length, 4, 'duplicate renewal deduped and bogus type rejected');

  const m = computeRetentionMetrics(events, now);
  assert.equal(m.active_subscriptions, 1, 'a active, b churned');
  assert.equal(m.mrr_cents, 1000);
  assert.equal(m.renewals, 1, 'one renewal in the window');
  assert.equal(m.churned, 1, 'one cancellation in the window');
});

test.after(async () => {
  await cleanup().catch(() => {});
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
