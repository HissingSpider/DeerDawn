'use strict';

/**
 * DELETING AN ACCOUNT CANCELS EVERY SUBSCRIPTION THAT COULD STILL BILL IT.
 *
 * cancelSubscriptionForDeletion cancelled organizations.stripe_subscription_id
 * and nothing else, and answered `no_subscription` (ok) when that column was
 * empty. But a Stripe customer can carry a subscription the row does not name:
 * a second checkout opened while the webhook for the first was late, one made
 * by hand in the Stripe dashboard, one left behind after a refund cleared the
 * column. DELETE /orgs then reported success, every row was erased, and the
 * other subscription went on charging a card for an account that no longer
 * exists anywhere but Stripe — with nothing left for its webhooks to find.
 *
 * The contract these tests pin: every subscription on the org's Stripe customer
 * that is not already over is cancelled, each judged by Stripe's read-back; and
 * `ok: false` — the answer that makes the interactive routes refuse to delete —
 * whenever any of them could not be confirmed cancelled.
 */

process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_every_subscription';

const test = require('node:test');
const assert = require('node:assert');

const DB_PATH = require.resolve('../../src/config/db');
const STRIPE_SERVICE_PATH = require.resolve('../../src/services/stripeService');

/** A fresh stripeService over an org row, with Stripe's subscription calls replaced. */
function loadService({ orgRow, subscriptions = [], listError = null, cancelOutcome = null, withStripe = true }) {
    delete require.cache[STRIPE_SERVICE_PATH];
    delete require.cache[DB_PATH];
    require.cache[DB_PATH] = {
        id: DB_PATH,
        filename: DB_PATH,
        loaded: true,
        exports: {
            query: async (text) => {
                if (/FROM organizations/.test(text)) return { rows: orgRow ? [orgRow] : [], rowCount: orgRow ? 1 : 0 };
                return { rows: [], rowCount: 0 };
            },
            pool: { connect: async () => { throw new Error('not used here'); } },
        },
    };

    const savedKey = process.env.STRIPE_SECRET_KEY;
    if (!withStripe) delete process.env.STRIPE_SECRET_KEY;
    const svc = require(STRIPE_SERVICE_PATH);
    if (!withStripe) process.env.STRIPE_SECRET_KEY = savedKey;

    const calls = { cancelled: [], lists: [] };
    if (svc.stripe) {
        svc.stripe.subscriptions.list = async (params) => {
            calls.lists.push(params);
            if (listError) throw listError;
            return { data: subscriptions.filter((s) => s.customer === params.customer), has_more: false };
        };
        svc.stripe.subscriptions.cancel = async (id) => {
            calls.cancelled.push(id);
            if (cancelOutcome) return cancelOutcome(id);
            return { id, status: 'canceled' };
        };
    }
    return { svc, calls };
}

const sub = (id, status = 'active') => ({ id, status, customer: 'cus_1' });

test('a second live subscription the org row does not name is cancelled too', async () => {
    const { svc, calls } = loadService({
        orgRow: { stripe_subscription_id: 'sub_recorded', stripe_customer_id: 'cus_1' },
        subscriptions: [sub('sub_recorded'), sub('sub_second')],
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');

    assert.deepStrictEqual([...calls.cancelled].sort(), ['sub_recorded', 'sub_second'],
        `only ${calls.cancelled.join(', ')} was cancelled — the other one keeps charging a deleted account`);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.strictEqual(out.cancelled, true);
});

test('live subscriptions with none recorded are not "no subscription"', async () => {
    // A refund, or a webhook that never landed, leaves the column empty while
    // the customer is still being charged.
    const { svc, calls } = loadService({
        orgRow: { stripe_subscription_id: null, stripe_customer_id: 'cus_1' },
        subscriptions: [sub('sub_orphan')],
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');

    assert.deepStrictEqual(calls.cancelled, ['sub_orphan'],
        `answered ${JSON.stringify(out)} without cancelling the live subscription`);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.cancelled, true);
});

test('anything that can still bill is cancelled, whatever its status; what is over is left alone', async () => {
    const { svc, calls } = loadService({
        orgRow: { stripe_subscription_id: null, stripe_customer_id: 'cus_1' },
        subscriptions: [
            sub('sub_trial', 'trialing'),
            sub('sub_past_due', 'past_due'),
            sub('sub_unpaid', 'unpaid'),
            sub('sub_incomplete', 'incomplete'),
            sub('sub_done', 'canceled'),
            sub('sub_expired', 'incomplete_expired'),
        ],
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');

    assert.deepStrictEqual([...calls.cancelled].sort(), ['sub_incomplete', 'sub_past_due', 'sub_trial', 'sub_unpaid']);
    assert.strictEqual(out.ok, true);
});

test('one subscription that cannot be confirmed cancelled refuses the whole deletion', async () => {
    const { svc } = loadService({
        orgRow: { stripe_subscription_id: 'sub_recorded', stripe_customer_id: 'cus_1' },
        subscriptions: [sub('sub_recorded'), sub('sub_second')],
        cancelOutcome: (id) => ({ id, status: id === 'sub_second' ? 'active' : 'canceled' }),
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');
    assert.strictEqual(out.ok, false,
        'the recorded subscription was cancelled, the other one is still live, and deletion was allowed to proceed');
});

test('a list call Stripe does not answer refuses the deletion — unknown is not permission', async () => {
    const outage = Object.assign(new Error('An error occurred with our connection to Stripe.'), { type: 'StripeConnectionError' });
    const { svc } = loadService({
        orgRow: { stripe_subscription_id: 'sub_recorded', stripe_customer_id: 'cus_1' },
        subscriptions: [sub('sub_recorded')],
        listError: outage,
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');
    assert.strictEqual(out.ok, false, JSON.stringify(out));
});

test('a customer Stripe no longer has is not a failure: its subscriptions went with it', async () => {
    const gone = Object.assign(new Error('No such customer: cus_1'), { code: 'resource_missing', statusCode: 400 });
    const { svc } = loadService({
        orgRow: { stripe_subscription_id: null, stripe_customer_id: 'cus_1' },
        listError: gone,
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');
    assert.strictEqual(out.ok, true, JSON.stringify(out));
});

test('a customer with nothing live cancels nothing and may be deleted', async () => {
    const { svc, calls } = loadService({
        orgRow: { stripe_subscription_id: null, stripe_customer_id: 'cus_1' },
        subscriptions: [sub('sub_done', 'canceled')],
    });

    const out = await svc.cancelSubscriptionForDeletion('org-1');
    assert.deepStrictEqual(calls.cancelled, []);
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.cancelled, false);
});

test('a Stripe customer with no way to reach Stripe is a failure, not a pass', async () => {
    const { svc } = loadService({
        orgRow: { stripe_subscription_id: null, stripe_customer_id: 'cus_1' },
        withStripe: false,
    });
    assert.strictEqual(svc.stripe, null);
    const out = await svc.cancelSubscriptionForDeletion('org-1');
    assert.strictEqual(out.ok, false, JSON.stringify(out));
});
