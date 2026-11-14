#!/usr/bin/env node
'use strict';

/**
 * OWNER-RUN: record the real price and the pending cancellation of every
 * workspace's Stripe subscription (journey r6, billing). Never run at boot, never
 * run by CI, never run by an agent.
 *
 * WHY. The Stripe webhook now records, on each subscription event, the price the
 * subscription is billed at (amount, currency, interval) and its pending
 * cancellation (cancel_at_period_end, cancel_at). A workspace that has had no
 * event since that shipped has neither on record, and its plan page falls back to
 * today's list price: a subscriber who joined at $10 reads $12. This reads each
 * workspace's subscription from Stripe once and writes the same record the webhook
 * would, through the same writer (services/billingRecord.js).
 *
 * WHAT IT DOES
 *  - Read-only against Stripe: subscriptions.list for each workspace's customer,
 *    paginated. Nothing is created, updated or cancelled in Stripe.
 *  - Writes ONLY the record columns (cancel_at_period_end, cancel_at,
 *    price_unit_amount_cents, price_currency, price_interval, price_interval_count)
 *    of the workspace's recorded subscription. It never changes the plan, the
 *    status, the seats, the period, the subscription id or anything about access.
 *  - Skips a workspace with no Stripe customer, with no recorded subscription, whose
 *    recorded subscription Stripe does not list, or whose subscription has ended
 *    (the webhook settles those).
 *  - Idempotent: a workspace whose row already says what Stripe says is left alone.
 *  - Rate-limit friendly: one workspace at a time, a pause between them, and a
 *    rate-limited or transient Stripe answer is retried with backoff (then that
 *    workspace is reported as failed and the run goes on).
 *  - No database connection is held while Stripe is read, and there is no
 *    transaction: each workspace is one read of the row, one Stripe read, one
 *    guarded UPDATE.
 *
 * USAGE (from apps/api, with DATABASE_URL and STRIPE_SECRET_KEY set)
 *   node scripts/owner-run/backfill-subscription-prices.js            dry run: prints, writes nothing
 *   node scripts/owner-run/backfill-subscription-prices.js --apply    writes
 *   --org <org_id>      only this workspace
 *   --delay-ms <n>      pause between workspaces (default 150)
 *   --page-size <n>     workspaces read from the database at a time (default 100)
 *
 * Exit code 1 when any workspace failed.
 */
const { billingRecordOf, recordColumns } = require('../../src/services/billingRecord');

const ENDED = new Set(['canceled', 'incomplete_expired']);
const COLUMNS = ['cancel_at_period_end', 'cancel_at', 'price_unit_amount_cents', 'price_currency', 'price_interval', 'price_interval_count'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function retryable(err) {
  const type = err?.type || err?.rawType || '';
  if (['StripeRateLimitError', 'rate_limit_error', 'StripeConnectionError', 'StripeAPIError', 'api_error'].includes(type)) return true;
  const status = Number(err?.statusCode);
  return Number.isFinite(status) && (status === 429 || status >= 500);
}

/** Every subscription of a customer, following Stripe's pagination. */
async function listAll(stripe, customer, { retries, backoffMs }) {
  const all = [];
  let startingAfter;
  for (;;) {
    let page;
    for (let attempt = 0; ; attempt += 1) {
      try {
        page = await stripe.subscriptions.list({ customer, status: 'all', limit: 100, ...(startingAfter ? { starting_after: startingAfter } : {}) });
        break;
      } catch (err) {
        if (!retryable(err) || attempt >= retries) throw err;
        await sleep(backoffMs * 2 ** attempt);
      }
    }
    const data = Array.isArray(page?.data) ? page.data : [];
    all.push(...data);
    if (!page?.has_more || !data.length) return all;
    startingAfter = data[data.length - 1].id;
  }
}

const same = (a, b) => {
  const norm = (v) => (v instanceof Date ? v.getTime() : v === undefined ? null : v);
  return norm(a) === norm(b);
};

/**
 * @param {object} opts
 * @param {{ query: Function }} opts.db       query(text, params, scope)
 * @param {object} opts.stripe                the Stripe client (only subscriptions.list is called)
 * @param {boolean} [opts.apply]              false = dry run
 * @returns {Promise<{ examined, wouldWrite, written, unchanged, skipped: object, failed: Array }>}
 */
async function run({ db, stripe, apply = false, org = null, pageSize = 100, delayMs = 150, retries = 3, backoffMs = 500, log = console.log } = {}) {
  if (!db || !stripe) throw new Error('db and stripe are required');
  const summary = { examined: 0, wouldWrite: 0, written: 0, unchanged: 0, skipped: {}, failed: [] };
  const skip = (why) => { summary.skipped[why] = (summary.skipped[why] || 0) + 1; };
  log(`[backfill-subscription-prices] ${apply ? 'APPLY' : 'DRY RUN (nothing is written; pass --apply to write)'}`);

  let after = '';
  for (;;) {
    const page = await db.query(
      `SELECT org_id, stripe_customer_id, stripe_subscription_id, ${COLUMNS.join(', ')}
         FROM organizations
        WHERE org_id > $1 AND ($3::text IS NULL OR org_id = $3)
          AND stripe_customer_id IS NOT NULL
        ORDER BY org_id LIMIT $2`,
      [after, pageSize, org],
      'org-system'
    );
    if (!page.rows.length) break;
    for (const row of page.rows) {
      after = row.org_id;
      summary.examined += 1;
      if (!row.stripe_subscription_id) { skip('no recorded subscription'); continue; }
      try {
        const subs = await listAll(stripe, row.stripe_customer_id, { retries, backoffMs });
        const sub = subs.find((s) => s?.id === row.stripe_subscription_id);
        if (!sub) { skip('recorded subscription not listed by Stripe'); continue; }
        if (ENDED.has(sub.status)) { skip('subscription has ended'); continue; }
        const want = recordColumns(billingRecordOf(sub));
        const changed = Object.entries(want).filter(([column, value]) => !same(row[column], value));
        if (!changed.length) { summary.unchanged += 1; continue; }
        const shown = changed.map(([column, value]) => `${column}=${value instanceof Date ? value.toISOString() : value}`).join(' ');
        if (!apply) {
          summary.wouldWrite += 1;
          log(`  would write ${row.org_id} (${row.stripe_subscription_id}): ${shown}`);
        } else {
          const sets = changed.map(([column], i) => `${column} = $${i + 3}`).join(', ');
          // Only the record columns, only for the subscription the row records.
          const res = await db.query(
            `UPDATE organizations SET ${sets} WHERE org_id = $1 AND stripe_subscription_id = $2`,
            [row.org_id, row.stripe_subscription_id, ...changed.map(([, value]) => value)],
            'org-system'
          );
          if (res.rowCount) { summary.written += 1; log(`  wrote ${row.org_id} (${row.stripe_subscription_id}): ${shown}`); } else skip('row changed while it was read');
        }
      } catch (err) {
        summary.failed.push({ org_id: row.org_id, error: err.message });
        log(`  FAILED ${row.org_id}: ${err.message}`);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
    if (org) break;
  }

  log(`[backfill-subscription-prices] examined ${summary.examined}; ${apply ? `written ${summary.written}` : `would write ${summary.wouldWrite}`}; `
    + `unchanged ${summary.unchanged}; skipped ${JSON.stringify(summary.skipped)}; failed ${summary.failed.length}`);
  return summary;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const db = require('../../src/config/db');
  const { stripe } = require('../../src/services/stripeService');
  if (!stripe) {
    console.error('STRIPE_SECRET_KEY is not set: nothing to read from.');
    process.exit(1);
  }
  let summary;
  try {
    summary = await run({
      db,
      stripe,
      apply: flag('--apply'),
      org: value('--org', null),
      delayMs: Number(value('--delay-ms', 150)),
      pageSize: Number(value('--page-size', 100)),
    });
  } finally {
    await db.pool.end().catch(() => {});
  }
  process.exitCode = summary.failed.length ? 1 : 0;
}

module.exports = { run };
if (require.main === module) main();
