'use strict';

// OAuth MCP authorization-server contract + flow tests.
//
// Runs standalone (plain `node tests/oauth-mcp-contracts.test.js`): NODE_ENV=test
// makes Redis an in-memory stub, and db.query is stubbed so no database is
// required. Exercises discovery docs, dynamic client registration validation,
// the authorize -> approve -> token (PKCE) happy path, and PKCE/redirect_uri
// failure modes.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const { test, after } = require('node:test');
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { hashApiKey } = require('../src/utils/security');

const apiRoot = path.resolve(__dirname, '..');
const SYS_KEY = process.env.DEERDAWN_API_KEY;

// Stub DB before requiring the router so token minting doesn't hit Postgres.
const db = require('../src/config/db');
const insertedKeys = [];
const revokedKeyHashes = [];
db.query = async (text, params) => {
  if (typeof text === 'string' && text.includes('INSERT INTO api_keys')) {
    insertedKeys.push(params);
  }
  if (typeof text === 'string' && text.includes('SET status = \'revoked\'')) {
    revokedKeyHashes.push(params[0]);
  }
  return { rows: [] };
};

// The in-memory Redis stub emulates TTL with setTimeout, which overflows the
// 32-bit timer range for our 90-day key TTL and would evict keys immediately.
// Real Redis handles large EX values fine; here we back it with a plain Map.
const { redis } = require('../src/config/redis');
const redisStore = new Map();
redis.set = async (key, value) => { redisStore.set(key, value); return 'OK'; };
redis.get = async (key) => (redisStore.has(key) ? redisStore.get(key) : null);
redis.del = async (...keys) => {
  let deleted = 0;
  keys.flat().forEach((key) => { if (redisStore.delete(key)) deleted += 1; });
  return deleted;
};

const oauthRoutes = require('../src/routes/oauth');

const app = express();
app.use(express.json());
app.use('/', oauthRoutes);

// Bind ONE ephemeral server for the whole file and reuse it. Passing the bare
// `app` makes supertest listen() and close() a fresh server per request — 50+
// listen/close cycles per run — and under that churn a connection occasionally
// fails, surfacing as ETIMEDOUT from supertest's close handler, or as a 200
// with an unparsed (empty) body that turns into "Invalid URL" downstream.
const server = app.listen(0);
after(() => new Promise((resolve) => server.close(resolve)));

function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function registerClient(redirectUri = 'https://claude.ai/api/mcp/auth_callback') {
  const res = await request(server)
    .post('/api/v1/oauth/register')
    .send({ redirect_uris: [redirectUri], client_name: 'Test Client' });
  return res;
}

async function getCode(
  clientId,
  redirectUri,
  challenge,
  state = 'xyz',
  resource = 'https://api.deerdawn.test/mcp',
  scope
) {
  const authRes = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    resource,
    ...(scope ? { scope } : {}),
  });
  assert.strictEqual(authRes.status, 302, 'authorize should redirect to consent');
  const reqId = new URL(authRes.headers.location).searchParams.get('req');
  assert.ok(reqId, 'authorize redirect carries a req id');

  const approveRes = await request(server)
    .post('/api/v1/oauth/approve')
    .set('x-api-key', SYS_KEY)
    .send({ req: reqId });
  assert.strictEqual(approveRes.status, 200, 'approve should succeed for authed user');
  const redirect = new URL(approveRes.body.redirect);
  assert.strictEqual(redirect.searchParams.get('state'), state, 'state is preserved');
  const code = redirect.searchParams.get('code');
  assert.ok(code, 'approve returns an authorization code');
  return code;
}

test('protected-resource discovery doc points at the MCP endpoint', async () => {
  const res = await request(server).get('/.well-known/oauth-protected-resource');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.resource, 'https://api.deerdawn.test/mcp');
  assert.ok(res.body.authorization_servers.includes('https://api.deerdawn.test'));
});

test('temporary well-known publisher challenge is exact and fail-closed', async () => {
  process.env.DOMAIN_VERIFICATION_FILENAME = 'openai-domain-check.txt';
  process.env.DOMAIN_VERIFICATION_CONTENT = 'deerdawn-verification-value';
  const ok = await request(server).get('/.well-known/openai-domain-check.txt');
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.text, 'deerdawn-verification-value');
  assert.strictEqual(ok.headers['cache-control'], 'no-store');
  const miss = await request(server).get('/.well-known/wrong-file.txt');
  assert.strictEqual(miss.status, 404);
  delete process.env.DOMAIN_VERIFICATION_FILENAME;
  delete process.env.DOMAIN_VERIFICATION_CONTENT;
});

test('protected-resource doc is also served at the path-suffixed location', async () => {
  const res = await request(server).get('/.well-known/oauth-protected-resource/mcp');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.resource, 'https://api.deerdawn.test/mcp');
});

test('Claude protected-resource discovery preserves the exact submitted endpoint', async () => {
  const res = await request(server).get('/.well-known/oauth-protected-resource/mcp/claude');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.resource, 'https://api.deerdawn.test/mcp/claude');
});

test('legacy protected-resource discovery path advertises the canonical resource', async () => {
  const res = await request(server).get('/.well-known/oauth-protected-resource/api/v1/mcp');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.resource, 'https://api.deerdawn.test/mcp');
});

test('authorization-server metadata advertises PKCE + DCR endpoints', async () => {
  const res = await request(server).get('/.well-known/oauth-authorization-server');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.registration_endpoint, 'https://api.deerdawn.test/api/v1/oauth/register');
  assert.strictEqual(res.body.authorization_endpoint, 'https://api.deerdawn.test/api/v1/oauth/authorize');
  assert.strictEqual(res.body.token_endpoint, 'https://api.deerdawn.test/api/v1/oauth/token');
  assert.strictEqual(res.body.revocation_endpoint, 'https://api.deerdawn.test/api/v1/oauth/revoke');
  assert.ok(res.body.protected_resources.includes('https://api.deerdawn.test/mcp/claude'));
  assert.strictEqual(res.body.client_id_metadata_document_supported, true);
  assert.deepStrictEqual(res.body.code_challenge_methods_supported, ['S256']);
  assert.deepStrictEqual(res.body.response_types_supported, ['code']);
  assert.deepStrictEqual(res.body.protected_resources, [
    'https://api.deerdawn.test/mcp',
    'https://api.deerdawn.test/mcp/claude',
  ]);
  assert.strictEqual(res.body.agent_auth.skill, 'https://deerdawn.com/auth.md');
  assert.strictEqual(res.body.agent_auth.register_uri, 'https://api.deerdawn.test/api/v1/oauth/register');
  assert.ok(
    res.body.agent_auth.credential_types_supported.includes('oauth2_authorization_code_pkce'),
    'agent_auth should advertise the OAuth PKCE credential type'
  );
});

test('dynamic client registration issues a public client id', async () => {
  const res = await registerClient();
  assert.strictEqual(res.status, 201);
  assert.ok(res.body.client_id.startsWith('mcp_'));
  assert.strictEqual(res.body.token_endpoint_auth_method, 'none');
  // The identity must be DURABLE, not merely un-expiring. It previously lived
  // only in Redis with the TTL removed, which survives the clock and nothing
  // else: a restart, failover or eviction deleted it, and the client — which
  // has the id written into its local config and never re-registers — hit an
  // unrecoverable `invalid_client` on a connector it had used for weeks.
  const oauthSource = fs.readFileSync(path.join(apiRoot, 'src/routes/oauth.js'), 'utf8');
  assert.ok(
    oauthSource.includes('oauthClientStore.saveClient(client)'),
    'DCR client identity must be persisted through oauthClientStore, not straight into Redis'
  );
  assert.ok(
    !/redis\.set\(`oauth:client:/.test(oauthSource),
    'oauth.js must not write client registrations directly to Redis — Redis is a cache in front of the record'
  );
});

test('DCR accepts the target-client HTTPS and loopback callback families', async () => {
  const redirectUris = [
    'https://chatgpt.com/connector/oauth/reviewer-callback',
    'https://chatgpt.com/connector_platform_oauth_redirect',
    'https://claude.ai/api/mcp/auth_callback',
    'http://127.0.0.1:6274/oauth/callback',
    'http://localhost:3210/oauth/callback',
  ];
  const res = await request(server).post('/api/v1/oauth/register').send({
    redirect_uris: redirectUris,
    client_name: 'Target clients',
  });
  assert.strictEqual(res.status, 201);
  assert.deepStrictEqual(res.body.redirect_uris, redirectUris);
});

for (const clientMetadata of [
  {
    name: 'ChatGPT',
    clientId: 'https://chatgpt.com/oauth/deerdawn/client.json',
    redirectUri: 'https://chatgpt.com/connector/oauth/deerdawn-review',
  },
  {
    name: 'Claude',
    clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata/deerdawn',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
  },
]) test(`CIMD resolves ${clientMetadata.name} HTTPS metadata without DCR`, async () => {
  const { clientId, redirectUri, name } = clientMetadata;
  const originalFetch = global.fetch;
  let fetchedUrl = null;
  global.fetch = async (url) => {
    fetchedUrl = String(url);
    return {
      ok: true,
      headers: { get: () => null },
      text: async () => JSON.stringify({
        client_id: clientId,
        client_name: name,
        redirect_uris: [redirectUri],
        token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'],
      }),
    };
  };
  try {
    const { challenge } = pkcePair();
    const res = await request(server).get('/api/v1/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://api.deerdawn.test/mcp',
    });
    assert.strictEqual(res.status, 302);
    assert.ok(res.headers.location.startsWith('https://app.deerdawn.test/oauth/consent'));
    assert.strictEqual(fetchedUrl, clientId);
  } finally {
    global.fetch = originalFetch;
  }
});

test('CIMD rejects metadata origins outside the explicit server allowlist', async () => {
  const { challenge } = pkcePair();
  const res = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: 'https://attacker.example/oauth/client.json',
    redirect_uri: 'https://attacker.example/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'https://api.deerdawn.test/mcp',
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /invalid_client/);
});

test('registration rejects non-https redirect URIs', async () => {
  const res = await request(server)
    .post('/api/v1/oauth/register')
    .send({ redirect_uris: ['ftp://evil.example/callback'] });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'invalid_redirect_uri');
});

test('registration requires at least one redirect URI', async () => {
  const res = await request(server).post('/api/v1/oauth/register').send({});
  assert.strictEqual(res.status, 400);
});

test('authorize rejects an unregistered redirect_uri (no open redirect)', async () => {
  const reg = await registerClient('https://claude.ai/api/mcp/auth_callback');
  const res = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: 'https://attacker.example/steal',
    code_challenge: 'abc',
    code_challenge_method: 'S256',
  });
  assert.strictEqual(res.status, 400);
});

test('authorize requires PKCE (redirects error to a valid redirect_uri)', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const res = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: redirectUri,
    state: 's1',
  });
  assert.strictEqual(res.status, 302);
  const loc = new URL(res.headers.location);
  assert.strictEqual(loc.origin + loc.pathname, 'https://claude.ai/api/mcp/auth_callback');
  assert.strictEqual(loc.searchParams.get('error'), 'invalid_request');
  assert.strictEqual(loc.searchParams.get('state'), 's1');
});

test('authorize rejects a resource outside the canonical MCP audience', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { challenge } = pkcePair();
  const res = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'https://api.deerdawn.test/api/v1/context',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(new URL(res.headers.location).searchParams.get('error'), 'invalid_target');
});

test('authorize rejects unsupported OAuth scopes', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { challenge } = pkcePair();
  const res = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: reg.body.client_id,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    resource: 'https://api.deerdawn.test/mcp',
    scope: 'context:read account:admin',
  });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(new URL(res.headers.location).searchParams.get('error'), 'invalid_scope');
});

test('legacy MCP resource aliases normalize to the canonical audience', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(
    reg.body.client_id,
    redirectUri,
    challenge,
    'legacy-resource',
    'https://api.deerdawn.test/api/v1/mcp'
  );
  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: reg.body.client_id,
    redirect_uri: redirectUri,
    resource: 'https://api.deerdawn.test/mcp',
  });
  assert.strictEqual(tokenRes.status, 200);
  assert.strictEqual(tokenRes.body.resource, 'https://api.deerdawn.test/mcp');
});

async function startAuthorize(clientId, redirectUri, challenge, resource = 'https://api.deerdawn.test/mcp') {
  const authRes = await request(server).get('/api/v1/oauth/authorize').query({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'consent-state',
    resource,
  });
  assert.strictEqual(authRes.status, 302, 'authorize should redirect to consent');
  return new URL(authRes.headers.location).searchParams.get('req');
}

test('consent details expose the DCR client destination and flag it unverified', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { challenge } = pkcePair();
  const reqId = await startAuthorize(reg.body.client_id, redirectUri, challenge);

  const res = await request(server).get(`/api/v1/oauth/consent/${reqId}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.client_name, 'Test Client');
  assert.strictEqual(res.body.redirect_host, 'claude.ai');
  assert.strictEqual(res.body.verified, false, 'self-registered DCR clients are never verified');
  // Non-secret only: the code_challenge and owner must never leak here.
  assert.strictEqual(res.body.code_challenge, undefined);
  assert.strictEqual(res.body.owner_id, undefined);
});

test('consent details mark an allowlisted CIMD client as verified', async () => {
  const clientId = 'https://claude.ai/oauth/mcp-oauth-client-metadata/deerdawn';
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const originalFetch = global.fetch;
  global.fetch = async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => JSON.stringify({
      client_id: clientId,
      client_name: 'Claude',
      redirect_uris: [redirectUri],
      token_endpoint_auth_methods_supported: ['none'],
    }),
  });
  try {
    const { challenge } = pkcePair();
    const reqId = await startAuthorize(clientId, redirectUri, challenge);
    const res = await request(server).get(`/api/v1/oauth/consent/${reqId}`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.verified, true, 'CIMD clients from the allowlist are verified');
    assert.strictEqual(res.body.redirect_host, 'claude.ai');
  } finally {
    global.fetch = originalFetch;
  }
});

test('consent details reject malformed and unknown request ids', async () => {
  const malformed = await request(server).get('/api/v1/oauth/consent/not-a-real-id');
  assert.strictEqual(malformed.status, 400);
  const unknown = await request(server).get(`/api/v1/oauth/consent/${'a'.repeat(48)}`);
  assert.strictEqual(unknown.status, 404);
});

test('approve response surfaces the redirect host and verification status', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { challenge } = pkcePair();
  const reqId = await startAuthorize(reg.body.client_id, redirectUri, challenge);
  const approveRes = await request(server)
    .post('/api/v1/oauth/approve')
    .set('x-api-key', SYS_KEY)
    .send({ req: reqId });
  assert.strictEqual(approveRes.status, 200);
  assert.strictEqual(approveRes.body.redirect_host, 'claude.ai');
  assert.strictEqual(approveRes.body.verified, false);
});

test('full authorize -> approve -> token exchange returns a usable dd_ access token', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge);

  const tokenRes = await request(server)
    .post('/api/v1/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: reg.body.client_id,
      redirect_uri: redirectUri,
    });

  assert.strictEqual(tokenRes.status, 200);
  assert.ok(tokenRes.body.access_token.startsWith('dd_'), 'access token is a DeerDawn API key');
  assert.strictEqual(tokenRes.body.token_type, 'Bearer');
  assert.ok(tokenRes.body.refresh_token.startsWith('ddr_'));
  assert.ok(tokenRes.body.expires_in > 0);
  assert.ok(insertedKeys.length > 0, 'an api_keys row was minted');
  assert.strictEqual(tokenRes.body.resource, 'https://api.deerdawn.test/mcp');
  assert.strictEqual(insertedKeys.at(-1)[9], 'https://api.deerdawn.test/mcp', 'access token persists its MCP resource binding');
});

test('Claude endpoint completes OAuth with its exact audience', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const resource = 'https://api.deerdawn.test/mcp/claude';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge, 'claude-resource', resource);

  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: reg.body.client_id,
    redirect_uri: redirectUri,
    resource,
  });

  assert.strictEqual(tokenRes.status, 200);
  assert.strictEqual(tokenRes.body.resource, resource);
  assert.strictEqual(insertedKeys.at(-1)[9], resource, 'Claude token persists the Claude endpoint audience');
});

test('token exchange fails PKCE with a wrong verifier', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge);

  const tokenRes = await request(server)
    .post('/api/v1/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      code,
      code_verifier: 'the-wrong-verifier',
      client_id: reg.body.client_id,
      redirect_uri: redirectUri,
    });

  assert.strictEqual(tokenRes.status, 400);
  assert.strictEqual(tokenRes.body.error, 'invalid_grant');
});

test('read-only consent mints a least-privilege context:read token', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(
    reg.body.client_id,
    redirectUri,
    challenge,
    'read-only',
    'https://api.deerdawn.test/mcp',
    'context:read'
  );
  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: reg.body.client_id,
    redirect_uri: redirectUri,
    resource: 'https://api.deerdawn.test/mcp',
  });
  assert.strictEqual(tokenRes.status, 200);
  assert.strictEqual(tokenRes.body.scope, 'context:read');
  assert.deepStrictEqual(insertedKeys.at(-1)[8], ['context:read']);
});

test('authorization codes are single-use', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge);

  const first = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: redirectUri,
  });
  assert.strictEqual(first.status, 200);

  const second = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: redirectUri,
  });
  assert.strictEqual(second.status, 400, 'reused code is rejected');
});

test('refresh_token grant rotates and returns a new access token', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge);

  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id, redirect_uri: redirectUri,
  });
  const refreshToken = tokenRes.body.refresh_token;
  const originalAccessHash = hashApiKey(tokenRes.body.access_token);

  const refreshed = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'refresh_token', refresh_token: refreshToken,
  });
  assert.strictEqual(refreshed.status, 200);
  assert.ok(refreshed.body.access_token.startsWith('dd_'));
  assert.notStrictEqual(refreshed.body.refresh_token, refreshToken, 'refresh token is rotated');
  assert.strictEqual(refreshed.body.resource, 'https://api.deerdawn.test/mcp');
  assert.ok(revokedKeyHashes.includes(originalAccessHash), 'refresh rotation revokes the superseded access token');
});

// RFC 8707 §2.2: `resource` is OPTIONAL on a refresh. An omitted parameter
// normalizes to the DEFAULT resource (/mcp), so a grant issued for /mcp/claude —
// which is what Claude.ai connects to — was refused invalid_target on every
// refresh that left it out, and the connection died at the first token expiry.
test('a refresh without `resource` defaults to the resource the grant was issued for', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge, 'claude-state', 'https://api.deerdawn.test/mcp/claude');

  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id,
    redirect_uri: redirectUri, resource: 'https://api.deerdawn.test/mcp/claude',
  });
  assert.strictEqual(tokenRes.status, 200, JSON.stringify(tokenRes.body));
  assert.strictEqual(tokenRes.body.resource, 'https://api.deerdawn.test/mcp/claude');

  const refreshed = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'refresh_token', refresh_token: tokenRes.body.refresh_token, client_id: reg.body.client_id,
  });
  assert.strictEqual(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.strictEqual(refreshed.body.resource, 'https://api.deerdawn.test/mcp/claude',
    'the refreshed token stays bound to the audience it was granted for');
});

// Omission is a default, never a widening: a resource that is PRESENT and names
// a different audience is still refused, so a token for /mcp/claude can never be
// swapped for one that works against /mcp.
test('a refresh naming a DIFFERENT resource is still invalid_target', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge, 'claude-state-2', 'https://api.deerdawn.test/mcp/claude');
  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.body.client_id,
    redirect_uri: redirectUri, resource: 'https://api.deerdawn.test/mcp/claude',
  });
  assert.strictEqual(tokenRes.status, 200, JSON.stringify(tokenRes.body));

  const mismatched = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'refresh_token', refresh_token: tokenRes.body.refresh_token, client_id: reg.body.client_id,
    resource: 'https://api.deerdawn.test/mcp',
  });
  assert.strictEqual(mismatched.status, 400);
  assert.strictEqual(mismatched.body.error, 'invalid_target');

  const junk = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'refresh_token', refresh_token: tokenRes.body.refresh_token, client_id: reg.body.client_id,
    resource: 'https://evil.example/mcp',
  });
  assert.strictEqual(junk.status, 400);
  assert.strictEqual(junk.body.error, 'invalid_target');
});

test('revocation invalidates OAuth access and refresh tokens without revealing unknown tokens', async () => {
  const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
  const reg = await registerClient(redirectUri);
  const { verifier, challenge } = pkcePair();
  const code = await getCode(reg.body.client_id, redirectUri, challenge, 'revoke');
  const tokenRes = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code, code_verifier: verifier,
    client_id: reg.body.client_id, redirect_uri: redirectUri,
    resource: 'https://api.deerdawn.test/mcp',
  });

  const accessRevoke = await request(server).post('/api/v1/oauth/revoke').type('form').send({
    token: tokenRes.body.access_token,
    token_type_hint: 'access_token',
  });
  assert.strictEqual(accessRevoke.status, 200);
  assert.ok(revokedKeyHashes.includes(hashApiKey(tokenRes.body.access_token)), 'access-token hash was revoked in api_keys');

  const refreshRevoke = await request(server).post('/api/v1/oauth/revoke').type('form').send({
    token: tokenRes.body.refresh_token,
    token_type_hint: 'refresh_token',
  });
  assert.strictEqual(refreshRevoke.status, 200);
  const refreshAttempt = await request(server).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'refresh_token',
    refresh_token: tokenRes.body.refresh_token,
    resource: 'https://api.deerdawn.test/mcp',
  });
  assert.strictEqual(refreshAttempt.status, 400);
  assert.strictEqual(refreshAttempt.body.error, 'invalid_grant');

  const unknown = await request(server).post('/api/v1/oauth/revoke').type('form').send({ token: 'unknown' });
  assert.strictEqual(unknown.status, 200);
});

test('MCP endpoint advertises OAuth resource metadata on 401', () => {
  const mcpSource = fs.readFileSync(path.join(apiRoot, 'src/routes/mcp.js'), 'utf8');
  assert.ok(mcpSource.includes('WWW-Authenticate'), 'mcp route sets WWW-Authenticate');
  assert.ok(mcpSource.includes('resource_metadata'), 'mcp route references resource_metadata');
  assert.ok(mcpSource.includes('oauth-protected-resource'), 'mcp route points at the discovery doc');
  assert.ok(mcpSource.includes('oauth-protected-resource${resourcePath}'), 'challenge points at request-specific path-suffixed metadata');
});

test('OAuth access keys are persisted and enforced as MCP audience-bound tokens', () => {
  const oauthSource = fs.readFileSync(path.join(apiRoot, 'src/routes/oauth.js'), 'utf8');
  const authSource = fs.readFileSync(path.join(apiRoot, 'src/middleware/auth.js'), 'utf8');
  assert.ok(oauthSource.includes('oauth_resource'), 'OAuth minting persists the resource binding');
  assert.ok(authSource.includes('keyData.oauth_resource'), 'auth middleware reads the resource binding');
  assert.ok(authSource.includes('mcpResourceForRequest'), 'resource-bound tokens are restricted to their exact MCP request audience');
  assert.ok(authSource.includes('error: \'invalid_token\''), 'wrong-audience tokens fail as invalid_token');
});

test('OAuth router is mounted above the bootstrap gate in app.js', () => {
  const appSource = fs.readFileSync(path.join(apiRoot, 'src/app.js'), 'utf8');
  const mountIdx = appSource.indexOf('app.use(\'/\', oauthRoutes)');
  const gateIdx = appSource.indexOf('getBootstrapState()');
  assert.ok(mountIdx !== -1, 'oauth router is mounted');
  assert.ok(gateIdx === -1 || mountIdx < gateIdx, 'oauth router is mounted before the bootstrap gate');
});

test('app advertises /mcp as canonical while retaining the legacy endpoint alias', () => {
  const appSource = fs.readFileSync(path.join(apiRoot, 'src/app.js'), 'utf8');
  assert.ok(appSource.includes('app.use(MCP_RESOURCE_PATH, observeMcpRequest, mcpUnauthenticatedIpLimiter, mcpToolLimiter, mcpRoutes)'), 'canonical MCP route is mounted with production guardrails');
  assert.ok(appSource.includes('app.use(CLAUDE_MCP_RESOURCE_PATH, observeMcpRequest, mcpUnauthenticatedIpLimiter, mcpToolLimiter, mcpRoutes)'), 'Claude MCP route is mounted with production guardrails');
  assert.ok(appSource.includes('LEGACY_MCP_RESOURCE_PATHS'), 'legacy MCP route aliases remain mounted');
});
