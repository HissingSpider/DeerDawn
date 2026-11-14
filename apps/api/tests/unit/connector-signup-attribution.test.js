'use strict';

// A signup made mid-connect says which AI tool it came from (2026-09-26).
//
// Both signups on 2026-09-25 came in through ChatGPT's connector, and the only
// evidence was account_created landing seconds after connector_authorize_requested.
// The signup event is emitted by the Clerk webhook, which never sees the browser;
// the authorize request that knew the client's name lives ten minutes and is
// deleted on approve. The consent URL's `?req=` id is the one thing that crosses
// the sign-up, so authorize keeps a side record under it and the webhook reads
// the name back.
//
// What this pins:
//   1. /authorize writes the side record, and it outlives the request itself
//      (approve deletes oauth:req:<id>; the record must still resolve).
//   2. The name comes only from that record. A made-up, malformed or unknown id
//      resolves to nothing, so a browser cannot put a name on its own signup.
//   3. Lookup failures never throw into account creation.
//   4. The webhook stamps the result on account_created, signup_completed and
//      the person's first-touch properties.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
const ttls = new Map();
redis.set = async (key, value, mode, ttl) => {
  redisStore.set(key, value);
  if (mode === 'EX') ttls.set(key, ttl);
  return 'OK';
};
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const productEvents = require('../../src/services/productEventsService');
productEvents.recordProductEvent = async (_actor, input) => input;

const {
  CONNECTOR_REQUEST_CLIENT_TTL,
  clientRecordKey,
  resolveConnectorSignupProps,
} = require('../../src/services/connectorSignupAttribution');

const oauthRoutes = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use('/', oauthRoutes);

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

async function authorizeAs(clientName) {
  const reg = await request(app)
    .post('/api/v1/oauth/register')
    .send({ client_name: clientName, redirect_uris: [REDIRECT] });
  assert.equal(reg.status, 201);
  const res = await request(app).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: REDIRECT,
    code_challenge: crypto.randomBytes(32).toString('hex'),
    code_challenge_method: 'S256',
    scope: 'context:read context:write',
    resource: 'https://api.deerdawn.test/mcp',
  });
  assert.equal(res.status, 302);
  const requestId = new URL(res.headers.location).searchParams.get('req');
  assert.match(requestId, /^[a-f0-9]{48}$/);
  return requestId;
}

test('authorize leaves a record the signup webhook can name the client from', async () => {
  const requestId = await authorizeAs('ChatGPT');

  const props = await resolveConnectorSignupProps(redis, requestId);
  assert.deepEqual(props, { client_name: 'ChatGPT', client_verified: false, client_source: 'dcr' });

  // Longer-lived than the request: a sign-up with an email code or a detour
  // routinely takes longer than the request's ten minutes.
  assert.equal(ttls.get(clientRecordKey(requestId)), CONNECTOR_REQUEST_CLIENT_TTL);
  assert.ok(ttls.get(clientRecordKey(requestId)) > ttls.get(`oauth:req:${requestId}`));
});

test('the record survives the request being consumed on approve', async () => {
  const requestId = await authorizeAs('Cursor');
  await redis.del(`oauth:req:${requestId}`);

  const props = await resolveConnectorSignupProps(redis, requestId);
  assert.equal(props.client_name, 'Cursor');
});

test('only an id this server issued resolves; the browser cannot supply a name', async () => {
  const unknown = crypto.randomBytes(24).toString('hex');
  assert.deepEqual(await resolveConnectorSignupProps(redis, unknown), {});

  for (const bad of [undefined, null, '', 'ChatGPT', { client_name: 'x' }, 'A'.repeat(48), `${unknown}x`, '../oauth:req:x']) {
    assert.deepEqual(await resolveConnectorSignupProps(redis, bad), {}, `expected nothing for ${JSON.stringify(bad)}`);
  }
});

test('a lookup failure resolves to nothing instead of failing account creation', async () => {
  const requestId = crypto.randomBytes(24).toString('hex');
  const broken = { get: async () => { throw new Error('ECONNRESET'); } };
  assert.deepEqual(await resolveConnectorSignupProps(broken, requestId), {});

  const garbage = { get: async () => '{not json' };
  assert.deepEqual(await resolveConnectorSignupProps(garbage, requestId), {});

  assert.deepEqual(await resolveConnectorSignupProps(null, requestId), {});
});

test('a self-registered client cannot flood the property with its 200-character name', async () => {
  const requestId = await authorizeAs('x'.repeat(200));
  const props = await resolveConnectorSignupProps(redis, requestId);
  assert.equal(props.client_name.length, 100);
});

test('the webhook stamps the client on both signup events and on the person', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'routes', 'auth-webhooks.js'), 'utf8');

  // Resolved from the forwarded id, never read from the metadata as a name.
  assert.match(source, /resolveConnectorSignupProps\(redisClient, unsafe\.oauth_request_id\)/);
  assert.doesNotMatch(source, /unsafe\.client_name/);
  assert.match(source, /initialAttrProps\.initial_client_name = connectorProps\.client_name/);

  const created = source.slice(source.indexOf('event_name: \'account_created\''));
  const completedAt = created.indexOf('event_name: \'signup_completed\'');
  assert.ok(completedAt > -1);
  assert.match(created.slice(0, completedAt), /\.\.\.connectorProps/, 'account_created must carry the client');
  assert.match(created.slice(completedAt, completedAt + 800), /\.\.\.connectorProps/, 'signup_completed must carry the client');
});
