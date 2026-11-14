/**
 * Enforcement Entitlements Tests
 *
 * Ensures we don't do redundant DB work on the decision hot path.
 */

const assert = require('assert');

// Mock redis with in-memory backing
const redisStore = new Map();
const mockRedis = {
    get: async (key) => redisStore.get(key) || null,
    setex: async (key, _ttl, value) => {
        redisStore.set(key, value);
        return 'OK';
    },
    del: async (key) => {
        redisStore.delete(key);
        return 1;
    }
};

require.cache[require.resolve('../../src/config/redis')] = {
    exports: { redis: mockRedis }
};

let queryCount = 0;
const mockDb = {
    query: async (text) => {
        queryCount += 1;

        if (text.includes('FROM organizations')) {
            return {
                rows: [{
                    org_id: 'org-test',
                    subscription_status: 'active',
                    plan_tier: 'enterprise',
                    is_locked: false
                }]
            };
        }

        throw new Error(`Unexpected query in test: ${text}`);
    }
};

require.cache[require.resolve('../../src/config/db')] = {
    exports: mockDb
};

const { checkEnforcement } = require('../../src/services/enforcementService');

(async () => {
    console.log('[TEST] Running Enforcement Entitlements Tests...\n');

    // Cold path: redis miss -> 1 DB query for org, 0 extra for entitlements
    queryCount = 0;
    const first = await checkEnforcement('org-test');
    assert.strictEqual(first.allowed, true);
    assert.strictEqual(first.entitlements.tier, 'enterprise');
    assert.strictEqual(queryCount, 1, 'Expected exactly 1 DB query on cold path');
    console.log('✓ Test 1: Cold path uses 1 DB query');

    // Warm path: redis hit -> 0 DB queries
    queryCount = 0;
    const second = await checkEnforcement('org-test');
    assert.strictEqual(second.allowed, true);
    assert.strictEqual(second.entitlements.tier, 'enterprise');
    assert.strictEqual(queryCount, 0, 'Expected 0 DB queries on warm path');
    console.log('✓ Test 2: Warm path uses 0 DB queries');

    console.log('\nEnforcement Entitlements Tests passed');
})().catch((err) => {
    console.error('✗ Enforcement Entitlements Tests failed:', err);
    process.exit(1);
});
