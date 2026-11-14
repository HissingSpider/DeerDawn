'use strict';

/**
 * THE OWNER-RUN BACKFILL OF SUBSCRIPTION PRICES (journey r6, billing).
 *
 * scripts/owner-run/backfill-subscription-prices.js reads each workspace's
 * subscription from Stripe (a stubbed client here: nothing is sent anywhere) and
 * records the price and the pending cancellation. A dry run writes nothing;
 * --apply writes the record and NOTHING else (plan, status, seats, period and
 * subscription id are untouched); a second run changes nothing.
 *
 * DB-backed: bash scripts/run-db-test.sh node --test tests/integration/journey-r6-backfill-subscription-prices.test.js
 */
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { run } = require('../../scripts/owner-run/backfill-subscription-prices');

const TAG = crypto.randomBytes(4).toString('hex');
const q = (sql, params) => db.query(sql, params, 'org-system');
const made = [];

async function org(label, { customer = true, subscription = true, status = 'active' } = {}) {
  const orgId = `org-${uuidv4()}`;
  made.push(orgId);
  await q(
    `INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats, stripe_customer_id, stripe_subscription_id,
                                billing_period_start, billing_period_end)
     VALUES ($1, $2, 'developer_pro', 'developer_pro', $3, 3, $4, $5, NOW() - interval '1 day', NOW() + interval '29 days')`,
    [orgId, `r6 backfill ${label}`, status, customer ? `cus_bf_${TAG}_${label}` : null, subscription ? `sub_bf_${TAG}_${label}` : null],
  );
  return { orgId, customer: `cus_bf_${TAG}_${label}`, subscription: `sub_bf_${TAG}_${label}` };
}

const sub = (id, customer, extra = {}) => ({
  id, customer, status: 'active', cancel_at_period_end: false, cancel_at: null,
  items: { data: [{ quantity: 3, current_period_end: 2_000_000_000, price: { id: 'price_x', unit_amount: 1000, currency: 'usd', recurring: { interval: 'month', interval_count: 1 } } }] },
  ...extra,
});

function stripeStub(subs) {
  const calls = [];
  return {
    calls,
    subscriptions: {
      list: async (params) => {
        calls.push(params);
        const mine = subs.filter((s) => s.customer === params.customer);
        const from = params.starting_after ? mine.findIndex((s) => s.id === params.starting_after) + 1 : 0;
        const data = mine.slice(from, from + 1); // one per page, to exercise pagination
        return { data, has_more: from + 1 < mine.length };
      },
      // Anything that would change Stripe must never be called.
      update: async () => { throw new Error('the backfill must not write to Stripe'); },
      cancel: async () => { throw new Error('the backfill must not write to Stripe'); },
    },
  };
}

const row = async (orgId) => (await q('SELECT * FROM organizations WHERE org_id = $1', [orgId])).rows[0];
const quiet = () => {};

test.after(async () => {
  await q('DELETE FROM organizations WHERE org_id = ANY($1::text[])', [made]).catch(() => {});
});

test('dry run writes nothing; apply writes the record and leaves plan, status, seats, period and subscription alone; a second run changes nothing', async () => {
  const a = await org('a');
  const before = await row(a.orgId);
  const stripe = stripeStub([
    // A second, older subscription first in the list, so the right one must be found across pages.
    sub(`sub_other_${TAG}`, a.customer, { status: 'canceled' }),
    sub(a.subscription, a.customer, { cancel_at_period_end: true, cancel_at: 1_990_000_000 }),
  ]);
  const lines = [];

  const dry = await run({ db, stripe, apply: false, org: a.orgId, delayMs: 0, log: (l) => lines.push(l) });
  assert.equal(dry.wouldWrite, 1);
  assert.equal(dry.written, 0);
  assert.match(lines.join('\n'), /DRY RUN/);
  assert.match(lines.join('\n'), new RegExp(`would write ${a.orgId}.*cancel_at_period_end=true.*price_unit_amount_cents=1000`));
  assert.deepEqual(await row(a.orgId), before, 'a dry run wrote nothing');
  assert.ok(stripe.calls.length >= 2, 'the listing was paginated');

  const applied = await run({ db, stripe, apply: true, org: a.orgId, delayMs: 0, log: quiet });
  assert.equal(applied.written, 1);
  const after = await row(a.orgId);
  assert.deepEqual(
    [after.price_unit_amount_cents, after.price_currency, after.price_interval, after.price_interval_count, after.cancel_at_period_end],
    [1000, 'usd', 'month', 1, true],
  );
  assert.equal(new Date(after.cancel_at).getTime(), 1_990_000_000_000);
  // Nothing else changed.
  const strip = (r) => { const c = { ...r }; for (const k of ['price_unit_amount_cents', 'price_currency', 'price_interval', 'price_interval_count', 'cancel_at_period_end', 'cancel_at']) delete c[k]; return c; };
  assert.deepEqual(strip(after), strip(before), 'plan, status, seats, period and subscription id are untouched');

  const again = await run({ db, stripe, apply: true, org: a.orgId, delayMs: 0, log: quiet });
  assert.equal(again.written, 0);
  assert.equal(again.unchanged, 1, 'idempotent');
});

test('it skips workspaces with no customer, no recorded subscription, an unlisted or ended subscription, and reports a failure without stopping', async () => {
  const noSub = await org('nosub', { subscription: false });
  const unlisted = await org('unlisted');
  const ended = await org('ended');
  const broken = await org('broken');
  const fine = await org('fine');
  await org('nocustomer', { customer: false });
  const stripe = stripeStub([sub(ended.subscription, ended.customer, { status: 'canceled' }), sub(fine.subscription, fine.customer)]);
  const realList = stripe.subscriptions.list;
  stripe.subscriptions.list = async (params) => {
    if (params.customer === broken.customer) throw Object.assign(new Error('No permission'), { type: 'StripePermissionError', statusCode: 403 });
    return realList(params);
  };
  const before = await Promise.all([noSub, unlisted, ended, broken].map((o) => row(o.orgId)));

  const summary = await run({ db, stripe, apply: true, delayMs: 0, backoffMs: 1, log: quiet });
  assert.ok(summary.skipped['no recorded subscription'] >= 1);
  assert.ok(summary.skipped['recorded subscription not listed by Stripe'] >= 1);
  assert.ok(summary.skipped['subscription has ended'] >= 1);
  assert.ok(summary.failed.some((f) => f.org_id === broken.orgId), 'a refused read is reported');
  assert.equal((await row(fine.orgId)).price_unit_amount_cents, 1000, 'and the run went on');
  const after = await Promise.all([noSub, unlisted, ended, broken].map((o) => row(o.orgId)));
  assert.deepEqual(after, before, 'skipped and failed workspaces are untouched');
});

test('a rate-limited Stripe is retried, and the script never calls a Stripe write', async () => {
  const w = await org('ratelimit');
  const stripe = stripeStub([sub(w.subscription, w.customer)]);
  const realList = stripe.subscriptions.list;
  let failures = 2;
  stripe.subscriptions.list = async (params) => {
    if (failures-- > 0) throw Object.assign(new Error('Too many requests'), { type: 'StripeRateLimitError', statusCode: 429 });
    return realList(params);
  };
  const summary = await run({ db, stripe, apply: true, org: w.orgId, delayMs: 0, backoffMs: 1, log: quiet });
  assert.equal(summary.written, 1);
  assert.equal(summary.failed.length, 0);
});
