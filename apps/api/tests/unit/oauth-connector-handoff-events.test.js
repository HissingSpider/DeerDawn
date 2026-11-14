'use strict';

// The connector handoff must leave a server-side trace (E-015, 2026-08-30).
//
// Between `mcp_config_copied` and `oauth_consent_viewed` the activation funnel
// emitted nothing at all: over the 30 days to 2026-08-30, 17 people copied a
// connector config and 2 reached the consent screen, and "never pasted the URL
// into their tool" was indistinguishable from "pasted it and the handshake died
// on the way". These events separate the two.
//
// What this pins:
//   1. A successful registration emits `connector_registration_requested`.
//   2. Every authorize attempt emits `connector_authorize_requested` — this is
//      the denominator consent has never had, and it must fire for clients that
//      skipped registration entirely (CIMD), not only for DCR ones.
//   3. The two hard-400 dead ends in /authorize emit a rejection with a reason.
//      They render a bare 400 in the user's browser mid-connect and, until now,
//      left no trace anywhere.
//   4. Every one of them is actor-less, so recordProductEvent suppresses the
//      PostHog person profile and the instrument cannot manufacture the fake
//      users E-007 and E-013 had to clean up (validity gate 6.1).
//   5. A rejection with no usable client_id still carries a session_id.
//      captureProductEvent drops any event with a falsy distinctId, so a null
//      there would write the Postgres row, report success, and never reach the
//      funnel the event exists to be read in.

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

const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
redis.set = async (key, value) => { redisStore.set(key, value); return 'OK'; };
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

// Stub the emitter, not PostHog: the point of these assertions is the shape of
// what the route hands the service, including the actor it does NOT pass.
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

// recordConnectorEvent defers with setImmediate so instrumentation can never sit
// in the handshake's critical path.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function named(name) {
  return emitted.filter((e) => e.event_name === name);
}

async function registerClient(name = 'Claude') {
  const res = await request(app)
    .post('/api/v1/oauth/register')
    .send({ client_name: name, redirect_uris: [REDIRECT] });
  assert.equal(res.status, 201);
  return res.body.client_id;
}

function authorizeQuery(clientId, overrides = {}) {
  return {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: crypto.randomBytes(32).toString('hex'),
    code_challenge_method: 'S256',
    scope: 'context:read context:write',
    resource: 'https://api.deerdawn.test/mcp',
    ...overrides,
  };
}

test('a successful registration is the first observable moment of the handoff', async () => {
  emitted.length = 0;
  const clientId = await registerClient('Claude');
  await flush();

  const events = named('connector_registration_requested');
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.client_name, 'Claude');
  assert.equal(events[0].metadata.redirect_host, 'claude.ai');
  assert.equal(events[0].metadata.registration_type, 'dcr');
  assert.equal(events[0].source, 'oauth');
  assert.equal(events[0].surface, 'connector_handoff');
  // Same client, same session id across both legs of one connector.
  assert.match(events[0].session_id, /^mcpcx-[0-9a-f]{32}$/);

  emitted.length = 0;
  await request(app).get('/api/v1/oauth/authorize').query(authorizeQuery(clientId));
  await flush();

  const authorized = named('connector_authorize_requested');
  assert.equal(authorized.length, 1);
  assert.equal(authorized[0].session_id, events[0].session_id);
  assert.equal(authorized[0].metadata.redirect_host, 'claude.ai');
  assert.equal(authorized[0].metadata.client_source, 'dcr');
});

test('authorize is instrumented before the consent redirect, so consent has a denominator', async () => {
  const clientId = await registerClient();
  emitted.length = 0;

  const res = await request(app).get('/api/v1/oauth/authorize').query(authorizeQuery(clientId));
  await flush();

  assert.equal(res.status, 302);
  assert.match(res.headers.location, /\/oauth\/consent\?req=/);
  assert.equal(named('connector_authorize_requested').length, 1);
  assert.equal(named('connector_authorize_rejected').length, 0);
});

test('the two hard-400 dead ends in authorize record a reason', async () => {
  const clientId = await registerClient();

  emitted.length = 0;
  const unknown = await request(app)
    .get('/api/v1/oauth/authorize')
    // Not a shape this server has ever issued. A well-formed `mcp_<32 hex>` id
    // we no longer hold is a LOST registration and is re-admitted instead: see
    // oauth-real-client-conformance, "a client_id we issued and then lost".
    .query(authorizeQuery('client-we-never-issued'));
  await flush();
  assert.equal(unknown.status, 400);
  assert.equal(named('connector_authorize_rejected')[0].metadata.reason, 'unknown_client');
  assert.equal(named('connector_authorize_requested').length, 0);

  emitted.length = 0;
  const mismatch = await request(app)
    .get('/api/v1/oauth/authorize')
    .query(authorizeQuery(clientId, { redirect_uri: 'https://evil.example/cb' }));
  await flush();
  assert.equal(mismatch.status, 400);
  assert.equal(named('connector_authorize_rejected')[0].metadata.reason, 'redirect_uri_mismatch');
  assert.equal(named('connector_authorize_requested').length, 0);
});

test('a rejected registration is recorded with its reason', async () => {
  emitted.length = 0;
  const res = await request(app)
    .post('/api/v1/oauth/register')
    .send({ client_name: 'Claude', redirect_uris: [] });
  await flush();

  assert.equal(res.status, 400);
  const events = named('connector_registration_rejected');
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.reason, 'missing_redirect_uris');
});

test('every handoff event is actor-less, so none of them can mint a person', async () => {
  emitted.length = 0;
  const clientId = await registerClient();
  await request(app).get('/api/v1/oauth/authorize').query(authorizeQuery(clientId));
  await request(app).get('/api/v1/oauth/authorize').query(authorizeQuery(clientId, { client_id: '' }));
  await flush();

  assert.ok(emitted.length >= 3);
  for (const event of emitted) {
    // No user, no org and no anonymous_id is precisely the condition
    // recordProductEvent uses to set $process_person_profile: false.
    assert.equal(event.actor, null);
    assert.equal(event.metadata.anonymous_id, undefined);
  }
});

test('a rejection with no client_id still gets a session id, or PostHog drops it', async () => {
  emitted.length = 0;
  const res = await request(app)
    .get('/api/v1/oauth/authorize')
    .query(authorizeQuery('x', { client_id: '' }));
  await flush();

  assert.equal(res.status, 400);
  const events = named('connector_authorize_rejected');
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.reason, 'missing_client_id');
  assert.equal(events[0].session_id, 'mcpcx-unattributed');
});

// ─── Rejection diagnostics (2026-09-30) ──────────────────────────────────────
// Thirteen unknown_client rejections in September carried nothing but the
// reason. Each property below is one question that could not be answered from
// them. None of them may carry the client_id itself.

function rejection() {
  const events = named('connector_authorize_rejected');
  assert.equal(events.length, 1, `expected one rejection, got ${events.length}`);
  return events[0].metadata;
}

const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

test('an unknown_client says what kind of client_id it was, without carrying it', async () => {
  const clientId = 'https://unlisted-tool.example/oauth/client-metadata.json';
  const previousFetch = global.fetch;
  global.fetch = async (url) => assert.fail(`an origin off the allowlist must never be fetched: ${url}`);
  try {
    emitted.length = 0;
    const res = await request(app)
      .get('/api/v1/oauth/authorize')
      .set('User-Agent', CHROME_UA)
      .set('Referer', 'https://unlisted-tool.example/settings/connectors')
      .query(authorizeQuery(clientId));
    await flush();

    assert.equal(res.status, 400);
    // The person is told the actual problem, not to reinstall something that
    // will fail identically.
    assert.match(res.text, /https:\/\/unlisted-tool\.example/);
    assert.doesNotMatch(res.text, /add it again/);

    const meta = rejection();
    assert.equal(meta.reason, 'unknown_client');
    assert.equal(meta.client_id_kind, 'cimd_origin_not_allowed');
    assert.equal(meta.client_id_origin, 'https://unlisted-tool.example');
    assert.match(meta.client_id_hash, /^[0-9a-f]{12}$/);
    assert.equal(meta.registration_found, false);
    assert.equal(meta.cimd_failure, 'not_a_fetchable_metadata_url');
    assert.equal(meta.redirect_host, 'claude.ai');
    assert.equal(meta.ua_family, 'chrome');
    assert.equal(meta.referer_host, 'unlisted-tool.example');
    assert.ok(!JSON.stringify(meta).includes(clientId), 'the full client_id must not be sent');
  } finally {
    global.fetch = previousFetch;
  }
});

test('a metadata document we fetched and refused names why', async () => {
  const clientId = 'https://claude.ai/oauth/some-retired-client-metadata';
  const previousFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, headers: { get: () => null }, text: async () => '' });
  try {
    emitted.length = 0;
    const res = await request(app).get('/api/v1/oauth/authorize').query(authorizeQuery(clientId));
    await flush();

    assert.equal(res.status, 400);
    const meta = rejection();
    assert.equal(meta.client_id_kind, 'cimd');
    assert.equal(meta.client_id_origin, 'https://claude.ai');
    assert.equal(meta.cimd_failure, 'http_404');
  } finally {
    global.fetch = previousFetch;
  }
});

test('a missing_client_id says who asked and which parameters did arrive', async () => {
  emitted.length = 0;
  const res = await request(app)
    .get('/api/v1/oauth/authorize')
    .set('User-Agent', 'curl/8.7.1')
    .query({ response_type: 'code', state: 'secret-looking-state-value' });
  await flush();

  assert.equal(res.status, 400);
  const meta = rejection();
  assert.equal(meta.reason, 'missing_client_id');
  assert.equal(meta.client_id_kind, 'missing');
  assert.equal(meta.client_id_hash, null);
  assert.equal(meta.ua_family, 'curl');
  assert.equal(meta.params_present, 'response_type,state');
  assert.ok(!JSON.stringify(meta).includes('secret-looking-state-value'), 'parameter values must not be sent');
});

test('a redirect mismatch says the registration was found', async () => {
  const clientId = await registerClient();
  emitted.length = 0;
  await request(app)
    .get('/api/v1/oauth/authorize')
    .query(authorizeQuery(clientId, { redirect_uri: 'https://evil.example/cb' }));
  await flush();

  const meta = rejection();
  assert.equal(meta.reason, 'redirect_uri_mismatch');
  assert.equal(meta.client_id_kind, 'dcr');
  assert.equal(meta.registration_found, true);
  assert.equal(meta.redirect_host, 'evil.example');
});

// ─── The token leg (E-032, 2026-09-27) ───────────────────────────────────────
//
// Four real people approved ChatGPT on the consent screen between 09-25 and
// 09-27 and none of them ever sent an authenticated `initialize`. Nothing
// between the approval and the handshake was observable, so "the code was never
// redeemed", "it was refused here" and "the token was refused after" read the
// same. What this pins:
//   6. A redeemed code emits `connector_token_issued`, attributed to the person
//      who approved, and WITHOUT the connector session id: that id is shared by
//      every user of a CIMD client, and recordProductEvent would adopt every
//      org-less row carrying it into this person's org.
//   7. Every refusal emits `connector_token_rejected` with a reason and the
//      grant, and never the code, verifier or token.
redis.sadd = redis.sadd || (async () => 1);
redis.srem = redis.srem || (async () => 1);
redis.expire = redis.expire || (async () => 1);

const CHATGPT_CLIENT = 'https://chatgpt.com/oauth/deerdawn/client.json';

function seedCode({ verifier = crypto.randomBytes(32).toString('hex'), ...overrides } = {}) {
  const code = crypto.randomBytes(16).toString('hex');
  redisStore.set(`oauth:code:${code}`, JSON.stringify({
    client_id: CHATGPT_CLIENT,
    client_name: 'ChatGPT',
    redirect_uri: 'https://chatgpt.com/connector_platform_oauth_redirect',
    code_challenge: crypto.createHash('sha256').update(verifier).digest('base64url'),
    scope: 'context:read context:write',
    resource: 'https://api.deerdawn.test/mcp',
    resource_indicated: true,
    owner_id: 'user-new-account',
    org_id: 'org-new-account',
    ...overrides,
  }));
  return { code, verifier };
}

function exchange(fields) {
  return request(app).post('/api/v1/oauth/token').type('form').send(fields);
}

test('a redeemed code is recorded against the person who approved, with no shared session id', async () => {
  emitted.length = 0;
  const { code, verifier } = seedCode();
  const res = await exchange({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: CHATGPT_CLIENT });
  await flush();

  assert.equal(res.status, 200, JSON.stringify(res.body));
  const issued = named('connector_token_issued');
  assert.equal(issued.length, 1);
  assert.equal(issued[0].actor.owner_id, 'user-new-account');
  assert.equal(issued[0].actor.org_id, 'org-new-account');
  assert.equal(issued[0].session_id, undefined);
  assert.equal(issued[0].metadata.client_name, 'ChatGPT');
  assert.equal(issued[0].metadata.grant_type, 'authorization_code');
  assert.equal(issued[0].metadata.resource_path, '/mcp');
  assert.equal(named('connector_token_rejected').length, 0);
  const payload = JSON.stringify(issued[0]);
  assert.ok(!payload.includes(code) && !payload.includes(verifier) && !payload.includes(res.body.access_token));
});

test('a refused redemption names its reason, and whose it was when the code was found', async () => {
  emitted.length = 0;
  const { code } = seedCode();
  const bad = await exchange({ grant_type: 'authorization_code', code, code_verifier: 'not-the-verifier', client_id: CHATGPT_CLIENT });
  await flush();
  assert.equal(bad.status, 400);
  let rejected = named('connector_token_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].metadata.reason, 'pkce_failed');
  assert.equal(rejected[0].actor.owner_id, 'user-new-account');
  assert.equal(rejected[0].session_id, undefined);
  assert.ok(!JSON.stringify(rejected[0]).includes('not-the-verifier'));

  // The code is single-use and was consumed above: a retry has no record, so
  // no person, and stays actor-less on the connector's session id.
  emitted.length = 0;
  const replay = await exchange({ grant_type: 'authorization_code', code, code_verifier: 'x', client_id: CHATGPT_CLIENT });
  await flush();
  assert.equal(replay.status, 400);
  rejected = named('connector_token_rejected');
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].metadata.reason, 'code_invalid_or_expired');
  assert.equal(rejected[0].actor, null);
  assert.match(rejected[0].session_id, /^mcpcx-[0-9a-f]{32}$/);
  assert.equal(named('connector_token_issued').length, 0);
});

test('refresh and unknown-grant refusals are recorded too', async () => {
  emitted.length = 0;
  await exchange({ grant_type: 'refresh_token', refresh_token: 'ddr_unknown', client_id: CHATGPT_CLIENT });
  await exchange({ grant_type: 'password' });
  await flush();
  const reasons = named('connector_token_rejected').map((e) => `${e.metadata.grant_type}:${e.metadata.reason}`);
  assert.deepEqual(reasons, ['refresh_token:refresh_invalid_or_expired', 'password:unsupported_grant_type']);
  assert.ok(!JSON.stringify(emitted).includes('ddr_unknown'));
});
