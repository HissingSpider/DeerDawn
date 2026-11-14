/**
 * Enforcement Usage-Source Tests
 *
 * Verifies the free/starter hard-cap gate in checkEnforcement():
 *   1. Sources its "used" count from product_events (event_name='context_delivered')
 *      — the SAME signal the Usage & value dashboard shows (billing.js getUsageSummary)
 *      — and never from the legacy, no-longer-populated usage_counters.decisions_count.
 *      (The dead incrementUsage() writer that used to feed usage_counters was removed.)
 *   2. Treats a null included_decisions as "uncapped": free has no volume cap, so the
 *      gate is skipped entirely (no COUNT, always allowed). This guards the
 *      `used >= null` -> `used >= 0` footgun that would otherwise block every free org.
 */

const test = require('node:test');
const assert = require('node:assert');

// --- In-memory redis mock (injected before requiring the service) ---
const redisStore = new Map();
const mockRedis = {
    get: async (key) => (redisStore.has(key) ? redisStore.get(key) : null),
    setex: async (key, _ttl, value) => { redisStore.set(key, String(value)); return 'OK'; },
    del: async (key) => { redisStore.delete(key); return 1; },
};
require.cache[require.resolve('../../src/config/redis')] = { exports: { redis: mockRedis } };

// --- DB mock: a configurable org tier + product_events count. Any read of the legacy
//     usage_counters table is fatal, proving the gate no longer depends on it. ---
let deliveredCount = 0;
let orgPlanTier = 'starter';
const queries = [];
const mockDb = {
    query: async (text) => {
        queries.push(text);
        if (text.includes('FROM organizations')) {
            return {
                rows: [{
                    org_id: 'org-test',
                    subscription_status: 'active',
                    plan: orgPlanTier,
                    plan_tier: orgPlanTier,
                    is_locked: false,
                    billing_period_start: '2026-06-01T00:00:00.000Z',
                    billing_cycle_anchor: null,
                    referral_premium_until: null,
                }],
            };
        }
        if (text.includes('FROM product_events')) {
            return { rows: [{ used: deliveredCount }] };
        }
        if (text.includes('usage_counters')) {
            throw new Error('checkEnforcement must NOT read usage_counters anymore');
        }
        throw new Error(`Unexpected query in test: ${text}`);
    },
};
require.cache[require.resolve('../../src/config/db')] = { exports: mockDb };

const { checkEnforcement } = require('../../src/services/enforcementService');

const productEventCounts = () => queries.filter((q) => q.includes('FROM product_events')).length;

function reset(count, tier = 'starter') {
    redisStore.clear();
    queries.length = 0;
    deliveredCount = count;
    orgPlanTier = tier;
}

test('checkEnforcement sources usage from product_events', async (t) => {
    // starter plan included_decisions = 5000 (a capped tier)

    await t.test('under the limit -> allowed, counting product_events not usage_counters', async () => {
        reset(5, 'starter');
        const res = await checkEnforcement('org-test');
        assert.strictEqual(res.allowed, true);
        assert.ok(
            queries.some((q) => q.includes('FROM product_events') && q.includes('context_delivered')),
            'gate should COUNT product_events context_delivered'
        );
        assert.ok(
            !queries.some((q) => q.includes('usage_counters')),
            'gate must not touch the legacy usage_counters table'
        );
    });

    await t.test('at the limit -> blocked with decision_limit_exceeded (>= is inclusive)', async () => {
        reset(5000, 'starter');
        const res = await checkEnforcement('org-test');
        assert.strictEqual(res.allowed, false);
        assert.strictEqual(res.error, 'decision_limit_exceeded');
        assert.strictEqual(res.upgrade_required, true);
    });

    await t.test('count is cached in Redis: no second COUNT within the TTL', async () => {
        reset(5, 'starter');
        await checkEnforcement('org-test');
        assert.strictEqual(productEventCounts(), 1, 'first call runs one COUNT');
        await checkEnforcement('org-test');
        assert.strictEqual(productEventCounts(), 1, 'second call serves usage from the Redis recount cache');
    });

    await t.test('Redis failure falls back to a direct count and still gates', async () => {
        reset(5000, 'starter');
        const origGet = mockRedis.get;
        mockRedis.get = async () => { throw new Error('redis down'); };
        try {
            const res = await checkEnforcement('org-test');
            assert.strictEqual(res.allowed, false);
            assert.strictEqual(res.error, 'decision_limit_exceeded');
            assert.ok(productEventCounts() >= 1, 'should count product_events directly when Redis is down');
        } finally {
            mockRedis.get = origGet;
        }
    });

    await t.test('free is uncapped (null limit): allowed without any COUNT, even past old 1000 cap', async () => {
        reset(999999, 'free');
        const res = await checkEnforcement('org-test');
        assert.strictEqual(res.allowed, true);
        assert.strictEqual(productEventCounts(), 0, 'uncapped tier must skip the usage COUNT entirely');
    });
});
