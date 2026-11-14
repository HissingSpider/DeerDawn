/**
 * SCAN 13: the in-memory Redis stub lost every key whose TTL exceeded ~24.8 days.
 *
 * It expired keys with setTimeout(ttl * 1000). Node's timer ceiling is
 * 2^31-1 ms; anything longer is clamped to 1ms (TimeoutOverflowWarning). The
 * 365-day OAuth refresh TTL therefore deleted the refresh token about a
 * millisecond after it was written, and integration suites swapped in their own
 * Map to get a refresh grant to work at all. No DB.
 *
 *   NODE_ENV=test JWT_SECRET=test-secret DEERDAWN_API_KEY=dev-key DISABLE_REDIS=true \
 *     node --test tests/unit/redis-stub-ttl.test.js
 */
process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert');

const { redis } = require('../../src/config/redis');
const { REFRESH_TTL_SECONDS } = require('../../src/config/oauthTokens');

const later = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

test('a key with a TTL past the timer ceiling is still there afterwards', async () => {
  assert.ok(REFRESH_TTL_SECONDS * 1000 > 2 ** 31 - 1, 'the refresh TTL is the case that overflowed');
  await redis.set('scan13:refresh', 'grant', 'EX', REFRESH_TTL_SECONDS);
  await redis.setex('scan13:setex', 400 * 24 * 3600, 'grant');
  await later(25);
  assert.strictEqual(await redis.get('scan13:refresh'), 'grant', 'THE BUG: a 365-day key vanished within milliseconds');
  assert.strictEqual(await redis.get('scan13:setex'), 'grant', 'THE BUG: setex with a long TTL vanished too');
  await redis.del('scan13:refresh', 'scan13:setex');
});

test('a short TTL still expires', async () => {
  await redis.set('scan13:short', 'v', 'EX', 0.02);
  await redis.setex('scan13:short2', 0.02, 'v');
  assert.strictEqual(await redis.get('scan13:short'), 'v');
  await later(40);
  assert.strictEqual(await redis.get('scan13:short'), null);
  assert.strictEqual(await redis.get('scan13:short2'), null);
  assert.deepStrictEqual(await redis.keys('scan13:short*'), [], 'an expired key is not listed');
  assert.strictEqual(await redis.del('scan13:short'), 0, 'an expired key is not counted as deleted');
});

test('a plain SET clears an earlier TTL, as Redis does', async () => {
  await redis.set('scan13:reset', 'a', 'EX', 0.02);
  await redis.set('scan13:reset', 'b');
  await later(40);
  assert.strictEqual(await redis.get('scan13:reset'), 'b');
  await redis.del('scan13:reset');
});
