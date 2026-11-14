'use strict';

// Append-only ledger of subscription lifecycle events, the raw data behind
// retention/MRR/churn. Kept separate from billing state (organizations) so it is
// a durable audit trail even as the live subscription row changes. Reads fold
// through retentionMetrics.computeRetentionMetrics.

const db = require('../config/db');
const { computeRetentionMetrics } = require('./retentionMetrics');

let ensured = false;

async function ensureTable() {
  if (ensured) return;
  await db.query(
    `CREATE TABLE IF NOT EXISTS subscription_events (
      event_pk BIGSERIAL PRIMARY KEY,
      org_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      plan_tier TEXT,
      mrr_cents INTEGER NOT NULL DEFAULT 0,
      stripe_event_id TEXT,
      billing_reason TEXT,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (stripe_event_id, event_type)
    )`,
    [],
    'org-system'
  );
  ensured = true;
}

// 'plan_changed' captures a mid-cycle upgrade/downgrade so MRR re-prices on the
// event instead of staying stale until the next renewal. It is neither a renewal
// nor churn — computeRetentionMetrics folds it as a re-pricing only.
const VALID_EVENT_TYPES = new Set(['created', 'renewed', 'plan_changed', 'cancelled', 'refunded', 'payment_failed']);

// Best-effort: callers (the Stripe webhook) record after their own commit and
// must not fail the webhook if the ledger write fails. The UNIQUE on
// (stripe_event_id, event_type) makes a retried webhook idempotent.
async function recordSubscriptionEvent(event) {
  if (!event?.org_id || !VALID_EVENT_TYPES.has(event.event_type)) return;
  await ensureTable();
  await db.query(
    `INSERT INTO subscription_events
       (org_id, event_type, plan_tier, mrr_cents, stripe_event_id, billing_reason, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, NOW()))
     ON CONFLICT (stripe_event_id, event_type) DO NOTHING`,
    [
      event.org_id,
      event.event_type,
      event.plan_tier || null,
      Math.max(0, Math.round(Number(event.mrr_cents || 0))),
      event.stripe_event_id || null,
      event.billing_reason || null,
      event.occurred_at || null,
    ],
    'org-system'
  );
}

async function listSubscriptionEvents() {
  await ensureTable();
  const result = await db.query(
    `SELECT org_id, event_type, plan_tier, mrr_cents, occurred_at
       FROM subscription_events
      ORDER BY occurred_at ASC, event_pk ASC`,
    [],
    'org-system'
  );
  return (result.rows || []).map((row) => ({
    org_id: row.org_id,
    event_type: row.event_type,
    plan_tier: row.plan_tier,
    mrr_cents: Number(row.mrr_cents || 0),
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
  }));
}

async function getRetentionMetrics(now = Date.now()) {
  const events = await listSubscriptionEvents();
  return computeRetentionMetrics(events, now);
}

module.exports = { ensureTable, recordSubscriptionEvent, listSubscriptionEvents, getRetentionMetrics };
