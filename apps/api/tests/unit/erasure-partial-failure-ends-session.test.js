'use strict';

/**
 * A PARTIAL erasure must still end the live session.
 *
 * purgeOwnerData invalidates the owner's cached API keys and revokes their
 * refresh tokens "on every outcome" — its own comment — but did so BELOW the
 * strict-mode throw. So when one table's DELETE failed, the api_keys rows were
 * already gone, the function threw erasure_incomplete, and every one of those
 * keys kept authenticating out of the 5-minute cache against a half-deleted
 * owner. The outcome that most needs the session ended was the one that skipped it.
 *
 * No database: purgeOwnerData takes its query function, so one failing DELETE is
 * scripted here rather than provoked.
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = process.env.DISABLE_REDIS || 'true';

const test = require('node:test');
const assert = require('node:assert/strict');

const apiKeyCache = require('../../src/services/apiKeyCache');
const posthog = require('../../src/services/posthog');
const erasure = require('../../src/services/dataErasureService');
const { closeRedisConnections } = require('../../src/config/redis');

test.after(async () => { await closeRedisConnections().catch(() => {}); });

test('a strict erasure that fails on one table still invalidates the cached keys before it throws', async () => {
  const invalidated = [];
  const realInvalidate = apiKeyCache.invalidateApiKey;
  const realCapture = posthog.captureProductEvent;
  apiKeyCache.invalidateApiKey = async (hash) => { invalidated.push(hash); };
  posthog.captureProductEvent = () => {};

  let failedOnce = false;
  const query = async (text) => {
    if (/SELECT key_hash FROM api_keys/.test(text)) return { rows: [{ key_hash: 'hash-one' }, { key_hash: 'hash-two' }], rowCount: 2 };
    if (/^\s*DELETE/i.test(text) && !failedOnce) {
      failedOnce = true;
      throw new Error('deadlock detected');
    }
    return { rows: [], rowCount: 0 };
  };

  try {
    await assert.rejects(
      () => erasure.purgeOwnerData('org-partial-erasure', { strict: true, query }),
      (err) => err.code === 'erasure_incomplete',
    );
    assert.ok(failedOnce, 'the scripted DELETE failure never fired, so this proved nothing');
    assert.deepStrictEqual(
      invalidated.sort(),
      ['hash-one', 'hash-two'],
      'THE BUG: the erasure threw before ending the session, so deleted keys kept working from the cache',
    );
  } finally {
    apiKeyCache.invalidateApiKey = realInvalidate;
    posthog.captureProductEvent = realCapture;
  }
});

// ─── A caller that owns the transaction ──────────────────────────────────────
//
// DELETE /orgs runs purgeOwnerData inside its own BEGIN…COMMIT. Revoking
// sessions and asking the analytics provider to erase a person cannot be rolled
// back, and both used to fire from inside that uncommitted transaction: a later
// failure rolled the database back to a fully intact account that had been
// signed out everywhere and erased from analytics.

function scriptedQuery({ failDeletes = false } = {}) {
  return async (text) => {
    if (/SELECT key_hash FROM api_keys/.test(text)) return { rows: [{ key_hash: 'hash-one' }], rowCount: 1 };
    if (/SELECT user_id FROM users/.test(text)) return { rows: [{ user_id: 'user-deferred' }], rowCount: 1 };
    if (failDeletes && /^\s*DELETE/i.test(text)) throw new Error('deadlock detected');
    return { rows: [], rowCount: 0 };
  };
}

test('with deferSideEffects nothing irreversible happens until the caller says it has committed', async () => {
  const invalidated = [];
  const erased = [];
  const realInvalidate = apiKeyCache.invalidateApiKey;
  const realCapture = posthog.captureProductEvent;
  apiKeyCache.invalidateApiKey = async (hash) => { invalidated.push(hash); };
  posthog.captureProductEvent = (payload) => { erased.push(payload); };
  try {
    const result = await erasure.purgeOwnerData('org-deferred', { strict: true, query: scriptedQuery(), deferSideEffects: true });
    assert.deepStrictEqual(invalidated, [], 'THE BUG: sessions were revoked from inside the caller\'s uncommitted transaction');
    assert.equal(erased.length, 0, 'the analytics identity was erased before the commit');
    assert.equal(typeof result.runSideEffects, 'function');
    assert.ok(!Object.keys(result).includes('runSideEffects'), 'the per-table report must still serialise as plain data');

    await result.runSideEffects();
    assert.deepStrictEqual(invalidated, ['hash-one']);
  } finally {
    apiKeyCache.invalidateApiKey = realInvalidate;
    posthog.captureProductEvent = realCapture;
  }
});

test('a deferred erasure that fails, and will be rolled back, revokes nothing', async () => {
  const invalidated = [];
  const realInvalidate = apiKeyCache.invalidateApiKey;
  apiKeyCache.invalidateApiKey = async (hash) => { invalidated.push(hash); };
  try {
    await assert.rejects(
      () => erasure.purgeOwnerData('org-deferred-fail', { strict: true, query: scriptedQuery({ failDeletes: true }), deferSideEffects: true }),
      (err) => err.code === 'erasure_incomplete',
    );
    assert.deepStrictEqual(invalidated, [], 'the keys are still rows after the rollback; ending their sessions is the wrong half of an erasure that did not happen');
  } finally {
    apiKeyCache.invalidateApiKey = realInvalidate;
  }
});

test('a refresh-token sweep that hits its bound says so instead of reporting a clean sweep', async () => {
  const { redis } = require('../../src/config/redis');
  const real = { scan: redis.scan, smembers: redis.smembers, del: redis.del, get: redis.get };
  let scans = 0;
  redis.smembers = async () => [];
  redis.del = async () => 0;
  redis.get = async () => null;
  // A keyspace larger than the bound: the cursor never comes back to '0'.
  redis.scan = async () => { scans += 1; return [String(scans), []]; };
  const realCapture = posthog.captureProductEvent;
  posthog.captureProductEvent = () => {};
  try {
    const report = await erasure.purgeOwnerData('org-big-keyspace', { query: scriptedQuery() });
    assert.ok(scans >= 200, 'the sweep should still be bounded, and should run to its bound');
    assert.equal(
      report.refresh_token_sweep_incomplete,
      true,
      'THE BUG: a sweep that stopped with keys unread reported exactly like one that finished',
    );
  } finally {
    Object.assign(redis, real);
    posthog.captureProductEvent = realCapture;
  }
});
