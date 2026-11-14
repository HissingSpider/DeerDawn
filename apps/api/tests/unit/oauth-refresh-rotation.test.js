'use strict';

// A refresh must never leave a connector with no working credential.
//
// The refresh grant used to revoke the old access token and delete the old
// refresh token BEFORE minting the replacement. When the api_keys insert (or
// the Redis write of the new refresh token) failed, the route returned 500 with
// both old tokens already destroyed: the client could not retry, could not keep
// using the old access token, and the user had to run OAuth consent again.
//
// These tests run through the real route with Postgres and Redis stand-ins.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

// ── Postgres stand-in: just the api_keys writes the token endpoint makes ─────
const db = require('../../src/config/db');
const apiKeys = new Map(); // key_hash -> { status }
let failMint = false;

db.query = async (text, params = []) => {
  if (/INSERT INTO api_keys/.test(text)) {
    if (failMint) throw new Error('connection terminated unexpectedly');
    apiKeys.set(params[2], { status: 'active' });
    return { rows: [] };
  }
  if (/UPDATE api_keys SET status = 'revoked'/.test(text)) {
    const row = apiKeys.get(params[0]);
    if (row) row.status = 'revoked';
    return { rows: [] };
  }
  return { rows: [] };
};

// ── Redis stand-in ───────────────────────────────────────────────────────────
const { redis } = require('../../src/config/redis');
const redisStore = new Map();
let failRedisSet = false;

redis.set = async (key, value) => {
  if (failRedisSet) throw new Error('READONLY You can\'t write against a read only replica');
  redisStore.set(key, value);
  return 'OK';
};
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const apiKeyCache = require('../../src/services/apiKeyCache');
apiKeyCache.invalidateApiKey = async () => {};

const oauthRouter = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use(oauthRouter);

const RESOURCE = 'https://api.deerdawn.test/mcp';
const CLIENT_ID = 'client-refresh-test';
const OLD_ACCESS_HASH = 'old-access-hash';
const OLD_REFRESH = `ddr_${'a'.repeat(64)}`;

const refreshKey = (token) => `oauth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;

beforeEach(() => {
  apiKeys.clear();
  redisStore.clear();
  failMint = false;
  failRedisSet = false;
  apiKeys.set(OLD_ACCESS_HASH, { status: 'active' });
  redisStore.set(refreshKey(OLD_REFRESH), JSON.stringify({
    owner_id: 'user-1',
    org_id: 'org-1',
    client_id: CLIENT_ID,
    scope: 'context:read context:write',
    resource: RESOURCE,
    access_key_hash: OLD_ACCESS_HASH,
  }));
});

function refresh() {
  return request(app)
    .post('/api/v1/oauth/token')
    .type('form')
    .send({ grant_type: 'refresh_token', refresh_token: OLD_REFRESH, client_id: CLIENT_ID, resource: RESOURCE });
}

test('a failed access-token mint leaves the old pair valid', async () => {
  failMint = true;
  const res = await refresh();
  assert.strictEqual(res.status, 500);
  assert.strictEqual(apiKeys.get(OLD_ACCESS_HASH).status, 'active', 'the old access token must not be revoked');
  assert.ok(redisStore.has(refreshKey(OLD_REFRESH)), 'the old refresh token must still exist');

  // And the client can simply retry once the fault clears.
  failMint = false;
  const retry = await refresh();
  assert.strictEqual(retry.status, 200, `retry should succeed: ${JSON.stringify(retry.body)}`);
});

test('a failed refresh-token write leaves the old pair valid and withdraws the orphan access token', async () => {
  failRedisSet = true;
  const res = await refresh();
  assert.strictEqual(res.status, 500);
  assert.strictEqual(apiKeys.get(OLD_ACCESS_HASH).status, 'active');
  assert.ok(redisStore.has(refreshKey(OLD_REFRESH)));
  const orphans = [...apiKeys.entries()].filter(([hash]) => hash !== OLD_ACCESS_HASH);
  assert.strictEqual(orphans.length, 1, 'exactly one new access token was minted');
  assert.strictEqual(orphans[0][1].status, 'revoked', 'the unpaired new access token must be revoked');
});

test('a successful refresh rotates: new pair issued, old pair retired', async () => {
  const res = await refresh();
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.ok(res.body.access_token);
  assert.match(res.body.refresh_token, /^ddr_/);
  assert.notStrictEqual(res.body.refresh_token, OLD_REFRESH);
  assert.ok(redisStore.has(refreshKey(res.body.refresh_token)), 'the new refresh token is stored');
  assert.ok(!redisStore.has(refreshKey(OLD_REFRESH)), 'the old refresh token is deleted');
  assert.strictEqual(apiKeys.get(OLD_ACCESS_HASH).status, 'revoked', 'the old access token is revoked');
});
