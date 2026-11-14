'use strict';

// Deleting an account must cancel its Stripe subscription — and must cancel it
// FIRST. Until 2026-09-03 all three deletion paths (DELETE /account, the org
// delete route, the Clerk user.deleted webhook) erased the data and left the
// subscription billing a customer who no longer existed anywhere but Stripe.
// The org route was the worst case: it deleted the organizations row, so even
// Stripe's own webhooks had nothing left to reconcile.
//
// The contract these tests pin:
//   1. cancel happens BEFORE the purge, on every path;
//   2. the interactive routes REFUSE to delete when the cancel fails — the one
//      end state this fix exists to prevent is "data gone, billing alive";
//   3. success is judged from Stripe's read-back, not from having asked;
//   4. already-cancelled / already-gone counts as success, so a retry after a
//      half-failure is not bricked.

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_account_delete';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const DB_PATH = require.resolve('../../src/config/db');

/** Load a fresh stripeService with the db module replaced. */
function loadService({ orgRow = {}, failLookup = false } = {}) {
  const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');
  delete require.cache[STRIPE_SERVICE_PATH];
  delete require.cache[DB_PATH];
  require.cache[DB_PATH] = {
    id: DB_PATH,
    filename: DB_PATH,
    loaded: true,
    exports: {
      query: async (text) => {
        if (failLookup) throw new Error('db unavailable');
        if (/SELECT stripe_subscription_id FROM organizations/.test(text)) {
          return { rows: [orgRow], rowCount: orgRow ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      pool: { connect: async () => { throw new Error('not used here'); } },
    },
  };
  return require(STRIPE_SERVICE_PATH);
}

test('no subscription on record: deletion may proceed, nothing to cancel', async () => {
  const svc = loadService({ orgRow: { stripe_subscription_id: null } });
  const out = await svc.cancelSubscriptionForDeletion('org-1');
  assert.deepEqual({ ok: out.ok, cancelled: out.cancelled }, { ok: true, cancelled: false });
});

test('a live subscription is cancelled, and success comes from the read-back', async () => {
  const svc = loadService({ orgRow: { stripe_subscription_id: 'sub_live_1' } });
  const cancelled = [];
  svc.stripe.subscriptions.cancel = async (id) => { cancelled.push(id); return { id, status: 'canceled' }; };
  const out = await svc.cancelSubscriptionForDeletion('org-1');
  assert.deepEqual(cancelled, ['sub_live_1']);
  assert.equal(out.ok, true);
  assert.equal(out.cancelled, true);
});

test('a cancel whose read-back is not canceled is a FAILURE, not a success', async () => {
  // The silent-success family: asking is not the same as it happening.
  const svc = loadService({ orgRow: { stripe_subscription_id: 'sub_live_2' } });
  svc.stripe.subscriptions.cancel = async (id) => ({ id, status: 'active' });
  const out = await svc.cancelSubscriptionForDeletion('org-1');
  assert.equal(out.ok, false);
});

test('already gone from Stripe, or already cancelled: idempotent success', async () => {
  const svc = loadService({ orgRow: { stripe_subscription_id: 'sub_gone' } });

  const missing = new Error('No such subscription');
  missing.code = 'resource_missing';
  svc.stripe.subscriptions.cancel = async () => { throw missing; };
  assert.equal((await svc.cancelSubscriptionForDeletion('org-1')).ok, true);

  svc.stripe.subscriptions.cancel = async () => { throw new Error('This subscription has been canceled already.'); };
  assert.equal((await svc.cancelSubscriptionForDeletion('org-1')).ok, true);
});

test('any other Stripe error blocks: the caller must not delete', async () => {
  const svc = loadService({ orgRow: { stripe_subscription_id: 'sub_live_3' } });
  svc.stripe.subscriptions.cancel = async () => { throw new Error('Stripe is on fire'); };
  const out = await svc.cancelSubscriptionForDeletion('org-1');
  assert.equal(out.ok, false);
});

test('a failed org lookup blocks too — unknown billing state is not permission', async () => {
  const svc = loadService({ failLookup: true });
  const out = await svc.cancelSubscriptionForDeletion('org-1');
  assert.equal(out.ok, false);
});

// ---------------------------------------------------------------------------
// The wiring: every deletion path cancels, cancels FIRST, and the interactive
// paths abort on failure. Position assertions rather than spelling ones.
// ---------------------------------------------------------------------------

function read(rel) {
  return fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
}

test('DELETE /account cancels before it purges, and refuses on failure', () => {
  const src = read('src/routes/context/context-sync.js');
  const handlerStart = src.indexOf('router.delete(\'/account\'');
  assert.ok(handlerStart > -1);
  const handler = src.slice(handlerStart, src.indexOf('router.', handlerStart + 20));
  const cancelAt = handler.indexOf('cancelSubscriptionForDeletion');
  const purgeAt = handler.indexOf('purgeOwnerData');
  assert.ok(cancelAt > -1, 'the account route must cancel the subscription');
  assert.ok(purgeAt > -1);
  assert.ok(cancelAt < purgeAt, 'cancel must come BEFORE the purge — the reverse recreates the bug on a Stripe failure');
  assert.ok(/billing_cancellation_failed/.test(handler), 'a failed cancel must refuse the deletion, not proceed');
});

test('the org delete route cancels before its transaction, and refuses on failure', () => {
  const src = read('src/routes/shared/orgs.js');
  const cancelAt = src.indexOf('cancelSubscriptionForDeletion(orgId)');
  const beginAt = src.indexOf('client.query(\'BEGIN\')');
  assert.ok(cancelAt > -1, 'the org route must cancel the subscription');
  assert.ok(beginAt > -1);
  assert.ok(cancelAt < beginAt, 'cancel must come before the deletion transaction opens');
  assert.ok(/billing_cancellation_failed/.test(src));
});

test('the Clerk user.deleted webhook cancels before purging, and a failure is reported, not logged', () => {
  const src = read('src/routes/auth-webhooks.js');
  const cancelAt = src.indexOf('cancelSubscriptionForDeletion(orgId)');
  const purgeAt = src.indexOf('purgeOwnerData(orgId');
  assert.ok(cancelAt > -1, 'the webhook path must cancel the subscription');
  assert.ok(purgeAt > -1);
  assert.ok(cancelAt < purgeAt, 'cancel before purge, same as the interactive routes');
  assert.ok(/erasure_subscription_cancel_failed/.test(src),
    'the webhook cannot abort (the Clerk identity is already gone), so a failed cancel must reach reportSwallowed');
});
