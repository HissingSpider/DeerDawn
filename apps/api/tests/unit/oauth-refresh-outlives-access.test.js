'use strict';

// A refresh token that dies with its access token is not a refresh token.
//
// REFRESH_TTL and ACCESS_TOKEN_TTL_DAYS were both 90 days and the pair was
// minted in one breath, so they expired at the same instant. The refresh grant
// is presented exactly once in a connection's life — when the access token
// stops working — and by then the Redis key behind it was already gone. Every
// hosted connection (Claude.ai, ChatGPT, Cursor, Codex) therefore answered
// invalid_grant at day 90 and needed the user to run consent again. OAuth
// shipped 2026-06-02, so the first cohort reached that in early September.
//
// The Redis stand-in here carries an explicit clock so expiry is a real
// behaviour rather than an inspected number: the test walks past the access
// token's own expiry and presents the refresh grant the way a client does.

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

const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

// ── Redis stand-in with a clock ──────────────────────────────────────────────
// Every value carries the absolute second it expires at, and reads past that
// second return nothing, exactly as Redis would.
const { redis } = require('../../src/config/redis');
let now = 0;
const store = new Map(); // key -> { value, expiresAt | null }

const live = (key) => {
  const entry = store.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && now >= entry.expiresAt) {
    store.delete(key);
    return null;
  }
  return entry;
};

redis.set = async (key, value, mode, ttl) => {
  const seconds = mode === 'EX' && Number.isFinite(Number(ttl)) ? Number(ttl) : null;
  store.set(key, { value, expiresAt: seconds === null ? null : now + seconds });
  return 'OK';
};
redis.get = async (key) => live(key)?.value ?? null;
redis.ttl = async (key) => {
  const entry = live(key);
  if (!entry) return -2;
  return entry.expiresAt === null ? -1 : entry.expiresAt - now;
};
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (store.delete(key)) deleted += 1; });
  return deleted;
};
redis.sadd = async () => 1;
redis.smembers = async () => [];
redis.srem = async () => 1;
redis.expire = async () => 1;

const apiKeyCache = require('../../src/services/apiKeyCache');
apiKeyCache.invalidateApiKey = async () => {};

const oauthRouter = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use(oauthRouter);

const RESOURCE = 'https://api.deerdawn.test/mcp';
const CLIENT_ID = 'https://claude.ai/oauth/mcp-oauth-client-metadata/deerdawn';
const refreshKey = (token) => `oauth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;

beforeEach(() => {
  now = 0;
  store.clear();
});

// The consent step already happened; this is the authorization code it left
// behind, which is what the token endpoint actually consumes.
async function exchangeCode() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = crypto.randomBytes(32).toString('hex');
  await redis.set(`oauth:code:${code}`, JSON.stringify({
    client_id: CLIENT_ID,
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    code_challenge: challenge,
    scope: 'context:read context:write',
    resource: RESOURCE,
    owner_id: 'user-1',
    org_id: 'org-1',
  }), 'EX', 60);

  const res = await request(app)
    .post('/api/v1/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: CLIENT_ID,
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      resource: RESOURCE,
    });
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const refresh = (token) => request(app)
  .post('/api/v1/oauth/token')
  .type('form')
  .send({ grant_type: 'refresh_token', refresh_token: token, client_id: CLIENT_ID, resource: RESOURCE });

test('the refresh token outlives the access token it refreshes', async () => {
  const granted = await exchangeCode();
  const remaining = await redis.ttl(refreshKey(granted.refresh_token));
  assert.ok(
    remaining > granted.expires_in,
    `refresh TTL (${remaining}s) must outlive the access token (${granted.expires_in}s), not expire with it`
  );
  // Wide enough that a client which only ever refreshes on expiry still finds
  // it, not merely wide enough to pass a greater-than.
  assert.ok(
    remaining - granted.expires_in > 30 * 24 * 60 * 60,
    `the margin is only ${(remaining - granted.expires_in) / 86400} days`
  );
});

test('a refresh presented after the access token expired still works', async () => {
  const granted = await exchangeCode();

  // The client uses the access token happily until it stops working, then
  // presents the refresh grant. That is the ONLY moment this token is used.
  now = granted.expires_in + 60;

  const res = await refresh(granted.refresh_token);
  assert.strictEqual(
    res.status,
    200,
    `the connection must survive its first access-token expiry: ${JSON.stringify(res.body)}`
  );
  assert.match(res.body.refresh_token, /^ddr_/);
  assert.notStrictEqual(res.body.refresh_token, granted.refresh_token);
});

test('rotation hands back a full window, so a live connection never ages out', async () => {
  const granted = await exchangeCode();
  const firstWindow = await redis.ttl(refreshKey(granted.refresh_token));

  now = granted.expires_in + 60;
  const rotated = await refresh(granted.refresh_token);
  assert.strictEqual(rotated.status, 200, JSON.stringify(rotated.body));

  const secondWindow = await redis.ttl(refreshKey(rotated.body.refresh_token));
  assert.strictEqual(secondWindow, firstWindow, 'a rotated refresh token starts its window over');
  assert.strictEqual(await redis.get(refreshKey(granted.refresh_token)), null, 'the old token is retired');
});

test('a refresh token really does expire eventually', async () => {
  const granted = await exchangeCode();
  const remaining = await redis.ttl(refreshKey(granted.refresh_token));

  // A connection nobody has touched for a full window is gone, not immortal.
  now = remaining + 1;
  const res = await refresh(granted.refresh_token);
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_grant');
});

test('the erasure index outlives the refresh tokens it is the only pointer to', () => {
  const { REFRESH_TTL_SECONDS, REFRESH_INDEX_TTL_SECONDS } = require('../../src/config/oauthTokens');
  // A token's Redis key is a hash of the token, so this index is the only way
  // to find a person's live refresh tokens. If it expires first, an erased
  // account can refresh its way back to a working access key.
  assert.ok(
    REFRESH_INDEX_TTL_SECONDS > REFRESH_TTL_SECONDS,
    `index TTL ${REFRESH_INDEX_TTL_SECONDS}s does not outlive refresh TTL ${REFRESH_TTL_SECONDS}s`
  );
});
