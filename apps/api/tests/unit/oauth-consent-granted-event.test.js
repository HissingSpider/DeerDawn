'use strict';

// The approval leaves a server-side record (E-038, 2026-10-03).
//
// `oauth_consent_approved` is a browser event from the consent page, raced
// against the redirect back to the AI tool. On 10-03 a new ChatGPT account
// redeemed a code at 07:11 with no consent view and no approval recorded at all,
// so one in four of the day's approvals was invisible to every count built on
// that event. What this pins:
//   1. A successful approve emits `connector_consent_granted`, attributed to the
//      person who approved, with no connector session id (shared by every user
//      of a CIMD client; see recordTokenEvent in routes/oauth.js).
//   2. It carries no code, state or redirect URL.
//   3. An approve that fails (expired request, code not stored) emits nothing,
//      so the event counts only approvals that can actually be redeemed.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { hashApiKey } = require('../../src/utils/security');

const PERSON = { key: `dd_${'g'.repeat(40)}`, owner: 'user-granted', keyId: 'key-granted' };
const keyRow = {
  key_id: PERSON.keyId,
  owner_id: PERSON.owner,
  org_id: 'org-granted',
  environment: 'production',
  scopes: ['context:read', 'context:write'],
  status: 'active',
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  oauth_resource: null,
};

const db = require('../../src/config/db');
db.query = async (text, params = []) => {
  if (/SELECT \* FROM api_keys WHERE key_hash/.test(text)) {
    return { rows: params[0] === hashApiKey(PERSON.key) ? [keyRow] : [] };
  }
  return { rows: [] };
};

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
let failNextCodeWrite = false;
redis.set = async (key, value) => {
  if (failNextCodeWrite && key.startsWith('oauth:code:')) {
    failNextCodeWrite = false;
    throw new Error('redis down');
  }
  redisStore.set(key, value);
  return 'OK';
};
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const productEvents = require('../../src/services/productEventsService');
const emitted = [];
productEvents.recordProductEvent = async (actor, input) => {
  emitted.push({ actor, ...input });
  return input;
};

const oauthRoutes = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use('/', oauthRoutes);

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const granted = () => emitted.filter((e) => e.event_name === 'connector_consent_granted');

async function pendingRequest() {
  const reg = await request(app)
    .post('/api/v1/oauth/register')
    .send({ client_name: 'Claude', redirect_uris: [REDIRECT] });
  assert.equal(reg.status, 201, reg.text);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const authorize = await request(app).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: REDIRECT,
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'st-granted',
    scope: 'context:read context:write',
  });
  assert.equal(authorize.status, 302, authorize.text);
  assert.ok(authorize.headers.location.startsWith(CONSENT), authorize.headers.location);
  return authorize.headers.location.slice(CONSENT.length);
}

function approve(reqId) {
  return request(app).post('/api/v1/oauth/approve').set('X-Api-Key', PERSON.key).send({ req: reqId });
}

test('an approval is recorded server-side against the person who approved', async () => {
  const reqId = await pendingRequest();
  emitted.length = 0;
  const res = await approve(reqId);
  await flush();

  assert.equal(res.status, 200, res.text);
  const events = granted();
  assert.equal(events.length, 1);
  assert.equal(events[0].actor.owner_id, PERSON.owner);
  assert.equal(events[0].actor.org_id, 'org-granted');
  assert.equal(events[0].session_id, undefined);
  assert.equal(events[0].metadata.client_name, 'Claude');
  assert.equal(events[0].metadata.verified, false);

  const code = new URL(res.body.redirect).searchParams.get('code');
  const payload = JSON.stringify(events[0]);
  assert.ok(code && !payload.includes(code), 'the event must not carry the code');
  assert.ok(!payload.includes('st-granted'), 'the event must not carry the state');
  assert.ok(!payload.includes('auth_callback'), 'the event must not carry the redirect URL');
});

test('an approve that cannot be redeemed records nothing', async () => {
  emitted.length = 0;
  const expired = await approve('no-such-request');
  assert.equal(expired.status, 404);

  const reqId = await pendingRequest();
  emitted.length = 0;
  failNextCodeWrite = true;
  const unstored = await approve(reqId);
  await flush();
  assert.equal(unstored.status, 503);

  assert.equal(granted().length, 0);
});
