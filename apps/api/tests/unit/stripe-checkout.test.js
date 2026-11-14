const test = require('node:test');
const assert = require('node:assert');

process.env.STRIPE_SECRET_KEY = 'sk_test_checkout';
process.env.STRIPE_PRICE_DEVELOPER_BASIC = 'price_developer_basic_monthly';

const checkoutCalls = [];

class MockStripe {
    constructor() {
        this.customers = {
            create: async () => ({ id: 'cus_test_123' }),
        };
        this.checkout = {
            sessions: {
                create: async (payload) => {
                    checkoutCalls.push(payload);
                    return { url: 'https://checkout.stripe.test/session_123' };
                },
            },
        };
        this.billingPortal = {
            sessions: {
                create: async () => ({ url: 'https://billing.stripe.test/portal_123' }),
            },
        };
        this.subscriptions = {
            retrieve: async () => ({ items: { data: [] } }),
        };
        this.billing = {
            meterEvents: {
                create: async () => ({}),
            },
        };
        this.subscriptionItems = {
            createUsageRecord: async () => ({}),
        };
    }
}

require.cache[require.resolve('stripe')] = {
    exports: MockStripe,
};

require.cache[require.resolve('../../src/config/db')] = {
    exports: {
        query: async (sql) => {
            if (sql.includes('SELECT stripe_customer_id FROM organizations')) {
                return { rows: [{ stripe_customer_id: null }] };
            }
            if (sql.includes('UPDATE organizations SET stripe_customer_id')) {
                return { rows: [] };
            }
            return { rows: [] };
        },
    },
};

const { createCheckoutSession } = require('../../src/services/stripeService');

test('Stripe checkout session enables promotion codes for self-serve plans', async () => {
    checkoutCalls.length = 0;

    const url = await createCheckoutSession(
        'org-checkout-test',
        'billing@test.com',
        'developer_basic',
        {
            dashboardUrl: 'https://app.deerdawn.com',
            billingCycle: 'monthly',
        },
    );

    assert.strictEqual(url, 'https://checkout.stripe.test/session_123');
    assert.strictEqual(checkoutCalls.length, 1);
    assert.strictEqual(checkoutCalls[0].allow_promotion_codes, true);
});
