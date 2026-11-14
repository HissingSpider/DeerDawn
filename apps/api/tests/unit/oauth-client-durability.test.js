'use strict';

// A registered connector must keep working. Three ways it stopped:
//
//   1. Redis was the only home for the registration, so a restart, failover or
//      maxmemory eviction deleted it. The client cannot notice or recover — the
//      client_id is in its local config and it resends it forever — so the user
//      met `invalid_client: unknown client_id (re-register the connector)` on a
//      connector they installed weeks ago (observed on Codex, 2026-09-05).
//   2. A transient Redis error was swallowed and fell into the SAME branch as a
//      genuine miss, so a blip told the user to destroy a good registration.
//   3. Registrations issued before the durable store existed live only in the
//      cache, and would break on the next Redis restart unless healed.
//
// Each test below is one of those. They pass through the real route, because
// the defect was in which branch the route took, not in any single function.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// ── A Postgres stand-in holding only the oauth_clients table ─────────────────
const db = require('../../src/config/db');
const clientRows = new Map();
let dbFails = false;

db.query = async (text, params = []) => {
  if (dbFails) throw new Error('connection terminated unexpectedly');
  if (/INSERT INTO oauth_clients/.test(text)) {
    const [client_id, redirect_uris, client_name, registration_type] = params;
    if (!clientRows.has(client_id)) {
      clientRows.set(client_id, { client_id, redirect_uris, client_name, registration_type, created_at: new Date() });
    }
    return { rows: [] };
  }
  if (/FROM oauth_clients/.test(text)) {
    const row = clientRows.get(params[0]);
    return { rows: row ? [row] : [] };
  }
  if (/UPDATE oauth_clients/.test(text)) return { rows: [] };
  return { rows: [] };
};

// ── A Redis stand-in that can be wiped or made to fail ───────────────────────
const { redis } = require('../../src/config/redis');
const redisStore = new Map();
let redisFails = false;

redis.set = async (key, value) => {
  if (redisFails) throw new Error('READONLY You can\'t write against a read only replica');
  redisStore.set(key, value);
  return 'OK';
};
redis.get = async (key) => {
  if (redisFails) throw new Error('Connection is closed.');
  return redisStore.has(key) ? redisStore.get(key) : null;
};
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const productEvents = require('../../src/services/productEventsService');
const emitted = [];
productEvents.recordProductEvent = async (actor, input) => { emitted.push(input); return input; };
// recordConnectorEvent defers with setImmediate so instrumentation never sits in
// the handshake's critical path.
const flush = () => new Promise((resolve) => setImmediate(resolve));
const lastRejection = () => emitted.filter((e) => e.event_name === 'connector_authorize_rejected').pop();

const oauthRouter = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use(oauthRouter);
const server = app;

const REDIRECT_URI = 'http://localhost:1455/auth/callback'; // Codex's loopback callback

async function registerConnector(name = 'Codex') {
  const res = await request(server)
    .post('/api/v1/oauth/register')
    .send({ redirect_uris: [REDIRECT_URI], client_name: name });
  assert.strictEqual(res.status, 201, `registration failed: ${JSON.stringify(res.body)}`);
  return res.body.client_id;
}

function authorize(clientId) {
  return request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_challenge: 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    code_challenge_method: 'S256',
    resource: 'https://api.deerdawn.test/mcp',
  });
}

function reset() {
  redisStore.clear();
  clientRows.clear();
  emitted.length = 0;
  redisFails = false;
  dbFails = false;
}

// 1. The reported failure: Redis loses everything, the connector still works.
test('a registration survives losing the entire Redis keyspace', async () => {
  reset();
  const clientId = await registerConnector();

  // A Redis restart / failover / eviction. Nothing else changes.
  redisStore.clear();

  const res = await authorize(clientId);
  assert.strictEqual(res.status, 302, `expected a redirect to consent, got ${res.status}: ${res.text}`);
  assert.ok(res.headers.location.startsWith('https://app.deerdawn.test/oauth/consent?req='));
});

// 2. An outage must never be reported as an unknown client — that advice tells
//    the user to delete a registration that is fine.
test('an unreachable client store answers 503 and retry, not invalid_client', async () => {
  reset();
  const clientId = await registerConnector();
  redisStore.clear();
  dbFails = true;

  const res = await authorize(clientId);
  assert.strictEqual(res.status, 503);
  assert.ok(!/re-register|not registered/i.test(res.text), `must not tell the user to re-register: ${res.text}`);
  assert.match(res.text, /retry/i);
  await flush();
  assert.strictEqual(lastRejection().metadata.reason, 'client_store_unavailable');
});

// A hard Redis outage still stops a NEW authorization — the consent request is
// short-lived flow state and Redis is the right home for it. What matters is
// that it fails as a transient fault the client can retry, and never as a
// verdict on the registration: nothing here tells anybody to re-register.
test('a failing Redis reports a transient fault, never an invalid client', async () => {
  reset();
  const clientId = await registerConnector();
  redisFails = true;

  const res = await authorize(clientId);
  assert.strictEqual(res.status, 302, `expected an error redirect to the client, got ${res.status}: ${res.text}`);
  const location = new URL(res.headers.location);
  assert.strictEqual(location.origin + location.pathname, 'http://localhost:1455/auth/callback');
  assert.strictEqual(location.searchParams.get('error'), 'temporarily_unavailable');

  await flush();
  const rejection = lastRejection();
  assert.ok(
    !rejection || rejection.metadata.reason !== 'unknown_client',
    'a cache outage must never be recorded as an unknown client'
  );

  // And the moment Redis is back, the same client_id works — the registration
  // was never touched.
  redisFails = false;
  assert.strictEqual((await authorize(clientId)).status, 302);
  assert.ok((await authorize(clientId)).headers.location.startsWith('https://app.deerdawn.test/oauth/consent?req='));
});

// 3. Connectors registered before the durable store must be healed, not left to
//    break on the next Redis restart.
test('a cache-only legacy registration is written through to the record on next use', async () => {
  reset();
  const legacyId = 'mcp_legacy0000000000000000000000';
  redisStore.set(`oauth:client:${legacyId}`, JSON.stringify({
    client_id: legacyId,
    redirect_uris: [REDIRECT_URI],
    client_name: 'Codex (pre-store)',
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    registration_type: 'dcr',
  }));

  assert.strictEqual((await authorize(legacyId)).status, 302);
  assert.ok(clientRows.has(legacyId), 'legacy registration should have been backfilled into the record');

  redisStore.clear();
  assert.strictEqual((await authorize(legacyId)).status, 302, 'healed registration should survive a Redis wipe');
});

// A client_id nobody ever registered is still a 400 — the branch must keep
// meaning what it says now that outages no longer land in it.
test('a genuinely unregistered client_id is still rejected', async () => {
  reset();
  const res = await authorize('mcp_neverregistered00000000000000');
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /invalid_client/);
  await flush();
  assert.strictEqual(lastRejection().metadata.reason, 'unknown_client');
});

// Registration must not report success it cannot keep: a client_id the client
// will treat as permanent, that we might not remember, is the original bug.
test('registration fails loudly when it cannot be made durable', async () => {
  reset();
  dbFails = true;
  const res = await request(server)
    .post('/api/v1/oauth/register')
    .send({ redirect_uris: [REDIRECT_URI], client_name: 'Codex' });
  assert.strictEqual(res.status, 503);
  assert.strictEqual(res.body.error, 'temporarily_unavailable');
});
