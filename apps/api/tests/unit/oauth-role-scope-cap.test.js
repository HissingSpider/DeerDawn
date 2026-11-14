'use strict';

// OAuth tokens store what the person APPROVED; the role ceiling is per request.
//
// The first fix for "a viewer's OAuth token carried context:write" capped scopes
// here, at mint and refresh, by the role in the person's ACTIVE workspace. That
// baked a team role into a token that also acts in the person's own personal
// workspace — a team viewer's token was read-only at home for 90 days. The cap
// now lives in middleware/auth.js (capCredentialScopesToBoundRole, pinned by
// tests/unit/key-scopes-bound-workspace.test.js). These pin the other half: the
// token endpoint neither narrows the stored scopes nor mis-reports them.

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
const minted = []; // scopes of every api_keys insert, in order

db.query = async (text, params = []) => {
  if (/INSERT INTO api_keys/.test(text)) {
    minted.push(params[8]);
    return { rows: [] };
  }
  return { rows: [] };
};

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
redis.set = async (key, value) => { redisStore.set(key, value); return 'OK'; };
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const apiKeyCache = require('../../src/services/apiKeyCache');
apiKeyCache.invalidateApiKey = async () => {};

// The roster: which workspace the person is working in, and their row there.
const workspace = require('../../src/services/workspaceService');
let activeWorkspace = null;
let roster = new Map(); // `${ownerKey}|${userId}` -> role
workspace.getActiveWorkspace = async () => activeWorkspace;
workspace.getMembership = async (ownerKey, userId) => {
  const role = roster.get(`${ownerKey}|${userId}`);
  return role ? { owner_key: ownerKey, user_id: userId, role } : null;
};

const oauthRouter = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use(oauthRouter);

const RESOURCE = 'https://api.deerdawn.test/mcp';
const CLIENT_ID = 'client-scope-cap';
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const PERSONAL = 'org-viewer-personal';
const TEAM = 'org-team';
const PERSON = 'user-viewer';

const refreshKey = (token) => `oauth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;

beforeEach(() => {
  minted.length = 0;
  redisStore.clear();
  activeWorkspace = TEAM;
  roster = new Map([
    [`${PERSONAL}|${PERSON}`, 'owner'],
    [`${TEAM}|${PERSON}`, 'viewer'],
  ]);
});

async function exchangeCode() {
  const verifier = crypto.randomBytes(32).toString('hex');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const code = crypto.randomBytes(16).toString('hex');
  redisStore.set(`oauth:code:${code}`, JSON.stringify({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    scope: 'context:read context:write',
    resource: RESOURCE,
    owner_id: PERSON,
    org_id: PERSONAL,
  }));
  return request(app)
    .post('/api/v1/oauth/token')
    .type('form')
    .send({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CLIENT_ID, redirect_uri: REDIRECT, resource: RESOURCE });
}

function refresh(token) {
  return request(app)
    .post('/api/v1/oauth/token')
    .type('form')
    .send({ grant_type: 'refresh_token', refresh_token: token, client_id: CLIENT_ID, resource: RESOURCE });
}

test('a team viewer\'s OAuth token stores the approved scopes, uncapped at mint', async () => {
  const res = await exchangeCode();
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(minted[0], ['context:read', 'context:write'],
    'the token must not bake in the ACTIVE workspace\'s role; it also acts in the personal one');
  assert.strictEqual(res.body.scope, 'context:read context:write', 'the response reports what the token carries');
});

test('a refresh carries the approved scopes forward whatever the role is at the time', async () => {
  const first = await exchangeCode();
  roster.set(`${TEAM}|${PERSON}`, 'member');
  const refreshed = await refresh(first.body.refresh_token);
  assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.deepStrictEqual(minted[1], ['context:read', 'context:write']);
  assert.strictEqual(refreshed.body.scope, 'context:read context:write');
});

test('a read-only approval stays read-only', async () => {
  const legacy = `ddr_${'b'.repeat(64)}`;
  redisStore.set(refreshKey(legacy), JSON.stringify({
    owner_id: PERSON,
    org_id: PERSONAL,
    client_id: CLIENT_ID,
    scope: 'context:read',
    resource: RESOURCE,
    access_key_hash: 'old-hash',
  }));
  roster.set(`${TEAM}|${PERSON}`, 'owner');
  const res = await refresh(legacy);
  assert.strictEqual(res.status, 200, JSON.stringify(res.body));
  assert.deepStrictEqual(minted[0], ['context:read']);
  assert.strictEqual(res.body.scope, 'context:read');
});
