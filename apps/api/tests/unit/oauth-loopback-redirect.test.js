'use strict';

// A CLI's loopback redirect_uri carries a port it could not have registered.
//
// Claude Code publishes a client metadata document declaring
// `http://localhost/callback` and `http://127.0.0.1/callback`, then binds
// whatever loopback port is free and arrives as `http://localhost:3118/callback`.
// /authorize compared the two with `Array.includes`, so every `claude mcp add`
// against api.deerdawn.com died on a bare `invalid_request: redirect_uri does
// not match a registered URI` — the first thing a new user does, unfixable from
// their side, and invisible to us because the existing connector is already
// authorized.
//
// RFC 8252 s7.3 requires loopback redirect URIs to be matched ignoring the port.
// What this pins: the port is relaxed and NOTHING else — scheme, host and path
// still match exactly, and https redirects (claude.ai, chatgpt.com) are
// untouched, so a self-registered client cannot widen its own callback.

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

const productEvents = require('../../src/services/productEventsService');
const emitted = [];
productEvents.recordProductEvent = async (actor, input) => { emitted.push(input); return input; };

// The real document served at https://claude.ai/oauth/claude-code-client-metadata
// on 2026-09-04. Portless loopback callbacks are the whole point of the test.
const CLAUDE_CODE_CLIENT_ID = 'https://claude.ai/oauth/claude-code-client-metadata';
const CLAUDE_CODE_METADATA = {
  client_id: CLAUDE_CODE_CLIENT_ID,
  client_name: 'Claude Code',
  client_uri: 'https://claude.ai',
  redirect_uris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  token_endpoint_auth_method: 'none',
};

global.fetch = async (url) => {
  assert.equal(String(url), CLAUDE_CODE_CLIENT_ID);
  const body = JSON.stringify(CLAUDE_CODE_METADATA);
  return {
    ok: true,
    headers: { get: (name) => (name === 'content-length' ? String(Buffer.byteLength(body)) : null) },
    text: async () => body,
  };
};

const oauthRoutes = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use('/', oauthRoutes);

const flush = () => new Promise((resolve) => setImmediate(resolve));

function authorize(clientId, redirectUri) {
  return request(app).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: crypto.randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'context:read context:write',
    resource: 'https://api.deerdawn.test/mcp/claude',
  });
}

async function registerClient(redirectUris) {
  const res = await request(app)
    .post('/api/v1/oauth/register')
    .send({ client_name: 'Test Client', redirect_uris: redirectUris });
  assert.equal(res.status, 201);
  return res.body.client_id;
}

test('a Claude Code loopback callback with an ephemeral port reaches consent', async () => {
  const res = await authorize(CLAUDE_CODE_CLIENT_ID, 'http://localhost:3118/callback');
  assert.equal(res.status, 302, res.text);
  assert.match(res.headers.location, /^https:\/\/app\.deerdawn\.test\/oauth\/consent\?req=/);
});

test('the 127.0.0.1 form is accepted with a port too', async () => {
  const res = await authorize(CLAUDE_CODE_CLIENT_ID, 'http://127.0.0.1:54321/callback');
  assert.equal(res.status, 302, res.text);
});

test('the portless registered form still matches exactly', async () => {
  const res = await authorize(CLAUDE_CODE_CLIENT_ID, 'http://localhost/callback');
  assert.equal(res.status, 302, res.text);
});

test('only the port is relaxed: a different path on loopback is still rejected', async () => {
  const res = await authorize(CLAUDE_CODE_CLIENT_ID, 'http://localhost:3118/steal');
  assert.equal(res.status, 400);
  assert.match(res.text, /redirect_uri does not match/);
});

test('a non-loopback host is never port-relaxed', async () => {
  const clientId = await registerClient(['https://evil.test/callback']);
  const res = await authorize(clientId, 'https://evil.test:8443/callback');
  assert.equal(res.status, 400);
  assert.match(res.text, /redirect_uri does not match/);
});

test('a loopback request cannot match an https registration', async () => {
  const clientId = await registerClient(['https://claude.ai/api/mcp/auth_callback']);
  const res = await authorize(clientId, 'http://localhost:3118/api/mcp/auth_callback');
  assert.equal(res.status, 400);
  assert.match(res.text, /redirect_uri does not match/);
});

test('a rejected redirect_uri still reports the reason it was rejected', async () => {
  emitted.length = 0;
  await authorize(CLAUDE_CODE_CLIENT_ID, 'http://localhost:3118/steal');
  await flush();
  const rejection = emitted.find((e) => e.event_name === 'connector_authorize_rejected');
  assert.ok(rejection, 'no rejection event emitted');
  assert.equal(rejection.metadata.reason, 'redirect_uri_mismatch');
});

test('a missing redirect_uri is reported as missing, not as a mismatch', async () => {
  emitted.length = 0;
  const res = await request(app).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: CLAUDE_CODE_CLIENT_ID,
    code_challenge: crypto.randomBytes(32).toString('base64url'),
    code_challenge_method: 'S256',
    resource: 'https://api.deerdawn.test/mcp/claude',
  });
  assert.equal(res.status, 400);
  await flush();
  const rejection = emitted.find((e) => e.event_name === 'connector_authorize_rejected');
  assert.ok(rejection);
  assert.equal(rejection.metadata.reason, 'missing_redirect_uri');
});
