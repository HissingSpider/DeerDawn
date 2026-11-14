'use strict';

// Cursor could not connect at all.
//
// Cursor self-registers (DCR) with a private-use native-app redirect URI,
// `cursor://anysphere.cursor-mcp/oauth/callback` — on versions before 3.10 as
// its ONLY redirect_uri, and from 3.10 alongside an https and a loopback one.
// /register refused the WHOLE registration whenever any URI was not https or
// http-loopback, so every Cursor user got `400 invalid_redirect_uri` before a
// consent screen ever rendered. RFC 8252 s7.1 is explicit that native apps use
// private-use schemes and that the authorization server should accept them.
//
// What this pins, end to end through the real routes (register -> authorize ->
// consent details -> approve -> token):
//   - both verbatim Cursor URI sets register (201)
//   - the cursor:// callback and the loopback callback each complete a grant,
//     and the code arrives on the custom-scheme URI with ?code=&state=
//   - the consent details show the SCHEME, so a native client cannot pass
//     itself off under another tool's host, and the DCR client is unverified
//   - the dangerous schemes are still refused, whatever else rides along
//
// It also pins the authorization_code `resource` default: a grant issued for
// /mcp/claude and exchanged without `resource` used to be refused
// invalid_target because an omitted resource normalized to /mcp.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.DISABLE_REDIS = 'true';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';
process.env.DEERDAWN_API_KEY = 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { hashApiKey } = require('../../src/utils/security');

const PERSON = { key: `dd_${'e'.repeat(40)}`, owner: 'user-cursor', keyId: 'key-cursor' };
const keyRow = {
  key_id: PERSON.keyId,
  owner_id: PERSON.owner,
  org_id: 'org-cursor',
  environment: 'production',
  scopes: ['context:read', 'context:write'],
  status: 'active',
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  oauth_resource: null,
};

const minted = []; // { resource } of every api_keys insert
const clients = new Map();
const db = require('../../src/config/db');
db.query = async (text, params = []) => {
  if (/SELECT \* FROM api_keys WHERE key_hash/.test(text)) {
    return { rows: params[0] === hashApiKey(PERSON.key) ? [keyRow] : [] };
  }
  if (/INSERT INTO api_keys/.test(text)) {
    minted.push({ resource: params[9] });
    return { rows: [] };
  }
  if (/INSERT INTO oauth_clients/i.test(text)) {
    clients.set(params[0], params);
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

const productEvents = require('../../src/services/productEventsService');
productEvents.recordProductEvent = async () => ({});

const fixture = require('../fixtures/oauth-real-clients.json');

const oauthRoutes = require('../../src/routes/oauth');
const app = express();
app.use(express.json());
app.use('/', oauthRoutes);

const ISSUER = 'https://api.deerdawn.test';
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';

const cursorObservations = fixture.observed_requests.filter((o) => o.kind === 'dcr_registration' && /cursor/i.test(o.label));
const CURSOR_CALLBACK = 'cursor://anysphere.cursor-mcp/oauth/callback';

beforeEach(() => {
  minted.length = 0;
});

async function register(redirectUris, clientName = 'Cursor') {
  return request(app)
    .post('/api/v1/oauth/register')
    .send({
      client_name: clientName,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
}

// register -> authorize -> consent details -> approve; returns what the
// consent page would navigate to plus the verifier needed to redeem it.
async function consentTo(clientId, redirectUri, { resource } = {}) {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const query = {
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'st-123',
    scope: 'context:read context:write',
  };
  if (resource) query.resource = resource;
  const authorize = await request(app).get('/api/v1/oauth/authorize').query(query);
  assert.equal(authorize.status, 302, `authorize: ${authorize.text}`);
  assert.ok(authorize.headers.location.startsWith(CONSENT), authorize.headers.location);
  const reqId = authorize.headers.location.slice(CONSENT.length);

  const details = await request(app).get(`/api/v1/oauth/consent/${reqId}`);
  assert.equal(details.status, 200, details.text);

  const approve = await request(app)
    .post('/api/v1/oauth/approve')
    .set('X-Api-Key', PERSON.key)
    .send({ req: reqId });
  assert.equal(approve.status, 200, `approve: ${approve.text}`);
  return { verifier, details: details.body, approve: approve.body };
}

function exchange(clientId, code, verifier, redirectUri, resource) {
  const body = { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: redirectUri };
  if (resource) body.resource = resource;
  return request(app).post('/api/v1/oauth/token').type('form').send(body);
}

test('the fixture carries both observed Cursor registrations', () => {
  assert.equal(cursorObservations.length, 2, 'expected the <3.10 and >=3.10 Cursor observations');
  for (const o of cursorObservations) {
    assert.ok(o.registration_body.redirect_uris.includes(CURSOR_CALLBACK), `${o.label}: no cursor:// callback`);
  }
});

for (const observed of cursorObservations) {
  test(`observed DCR registration is accepted: ${observed.label}`, async () => {
    const res = await request(app).post('/api/v1/oauth/register').send(observed.registration_body);
    assert.equal(res.status, 201, `this exact request produced "${observed.outcome_before_fix}": ${res.text}`);
    assert.deepEqual(res.body.redirect_uris, observed.registration_body.redirect_uris);
  });
}

test('Cursor completes a grant on its cursor:// callback, and the code arrives there', async () => {
  const newest = cursorObservations.find((o) => o.registration_body.redirect_uris.length > 1);
  const reg = await request(app).post('/api/v1/oauth/register').send(newest.registration_body);
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.body.client_id;

  const { verifier, details, approve } = await consentTo(clientId, CURSOR_CALLBACK);

  // The consent screen must show where the code goes INCLUDING the scheme —
  // the host alone ("anysphere.cursor-mcp") is spoofable by any app that
  // registers another scheme with the same authority.
  assert.equal(details.redirect_host, 'cursor://anysphere.cursor-mcp');
  assert.equal(details.verified, false, 'a DCR client is never shown as verified');
  assert.equal(approve.redirect_host, 'cursor://anysphere.cursor-mcp');

  // What the consent page assigns to window.location.href.
  const target = new URL(approve.redirect);
  assert.equal(target.protocol, 'cursor:');
  assert.equal(`${target.protocol}//${target.host}${target.pathname}`, CURSOR_CALLBACK);
  assert.equal(target.searchParams.get('state'), 'st-123');
  const code = target.searchParams.get('code');
  assert.match(code, /^[a-f0-9]{64}$/);

  const token = await exchange(clientId, code, verifier, CURSOR_CALLBACK, `${ISSUER}/mcp`);
  assert.equal(token.status, 200, token.text);
  assert.ok(token.body.access_token);
  assert.ok(token.body.refresh_token);
});

test('Cursor completes a grant on its loopback callback too', async () => {
  const newest = cursorObservations.find((o) => o.registration_body.redirect_uris.length > 1);
  const reg = await request(app).post('/api/v1/oauth/register').send(newest.registration_body);
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.body.client_id;
  const loopback = 'http://localhost:8787/callback';

  const { verifier, details, approve } = await consentTo(clientId, loopback);
  assert.equal(details.redirect_host, 'localhost:8787');
  const target = new URL(approve.redirect);
  const token = await exchange(clientId, target.searchParams.get('code'), verifier, loopback, `${ISSUER}/mcp`);
  assert.equal(token.status, 200, token.text);
});

test('a registered cursor:// client cannot be redirected to a different scheme or path', async () => {
  const reg = await register([CURSOR_CALLBACK]);
  assert.equal(reg.status, 201, reg.text);
  for (const other of [
    'evil://anysphere.cursor-mcp/oauth/callback',
    'cursor://anysphere.cursor-mcp/steal',
    'cursor://anysphere.cursor-mcp:1234/oauth/callback',
  ]) {
    const res = await request(app).get('/api/v1/oauth/authorize').query({
      response_type: 'code',
      client_id: reg.body.client_id,
      redirect_uri: other,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
    assert.equal(res.status, 400, `${other} must not match ${CURSOR_CALLBACK}`);
    assert.match(res.text, /redirect_uri does not match/);
  }
});

// PIN CHANGED (scan 12): this list used to accept
// `vscode://vscode.github-authentication/did-authenticate`. That is VS Code's
// built-in GitHub sign-in handler, not a callback any client registers with us,
// and admitting built-in handlers is the defect pinned below. A third-party
// extension callback takes its place.
test('reverse-domain native schemes register; bare unknown schemes do not', async () => {
  for (const ok of ['com.example.app:/oauth2redirect', 'com.example.app://callback', 'vscode://acme.deerdawn-connector/did-authenticate']) {
    const res = await register([ok], 'Native');
    assert.equal(res.status, 201, `${ok}: ${res.text}`);
  }
  for (const bad of ['myapp://callback', 'ms-settings:privacy', 'intent://x#Intent;end']) {
    const res = await register([bad], 'Native');
    assert.equal(res.status, 400, `${bad} must be refused`);
  }
});

test('dangerous schemes and non-loopback http are still refused, alone or alongside Cursor', async () => {
  const hostile = [
    'javascript:alert(document.cookie)',
    'JavaScript://anysphere.cursor-mcp/%0aalert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'vbscript:msgbox(1)',
    'blob:https://app.deerdawn.test/abc',
    'about:blank',
    'http://evil.com/callback',
    'http://localhost.evil.com/callback',
    'cursor://user:pw@anysphere.cursor-mcp/oauth/callback',
    'com.example.app:/cb#frag',
    'ftp://example.com/cb',
  ];
  for (const bad of hostile) {
    const alone = await register([bad], 'Hostile');
    assert.equal(alone.status, 400, `${bad} must be refused`);
    assert.equal(alone.body.error, 'invalid_redirect_uri');
    const smuggled = await register([CURSOR_CALLBACK, bad], 'Hostile');
    assert.equal(smuggled.status, 400, `${bad} must not ride in beside a valid URI`);
  }
});

test('a /mcp/claude grant exchanged WITHOUT resource mints for /mcp/claude', async () => {
  const reg = await register(['https://claude.ai/api/mcp/auth_callback'], 'Claude');
  const clientId = reg.body.client_id;
  const { verifier, approve } = await consentTo(clientId, 'https://claude.ai/api/mcp/auth_callback', { resource: `${ISSUER}/mcp/claude` });
  const code = new URL(approve.redirect).searchParams.get('code');

  const token = await exchange(clientId, code, verifier, 'https://claude.ai/api/mcp/auth_callback');
  assert.equal(token.status, 200, token.text);
  assert.equal(token.body.resource, `${ISSUER}/mcp/claude`);
  assert.deepEqual(minted.map((m) => m.resource), [`${ISSUER}/mcp/claude`]);
});

test('a grant that named /mcp/claude still cannot be exchanged for /mcp', async () => {
  const reg = await register(['https://claude.ai/api/mcp/auth_callback'], 'Claude');
  const clientId = reg.body.client_id;
  const { verifier, approve } = await consentTo(clientId, 'https://claude.ai/api/mcp/auth_callback', { resource: `${ISSUER}/mcp/claude` });
  const code = new URL(approve.redirect).searchParams.get('code');

  const token = await exchange(clientId, code, verifier, 'https://claude.ai/api/mcp/auth_callback', `${ISSUER}/mcp`);
  assert.equal(token.status, 400);
  assert.equal(token.body.error, 'invalid_target');
  assert.equal(minted.length, 0);
});

test('an /authorize that named no resource can be redeemed for /mcp/claude at /token', async () => {
  const reg = await register(['https://claude.ai/api/mcp/auth_callback'], 'Claude');
  const clientId = reg.body.client_id;
  const { verifier, approve } = await consentTo(clientId, 'https://claude.ai/api/mcp/auth_callback');
  const code = new URL(approve.redirect).searchParams.get('code');

  const token = await exchange(clientId, code, verifier, 'https://claude.ai/api/mcp/auth_callback', `${ISSUER}/mcp/claude`);
  assert.equal(token.status, 200, token.text);
  assert.equal(token.body.resource, `${ISSUER}/mcp/claude`);
  assert.deepEqual(minted.map((m) => m.resource), [`${ISSUER}/mcp/claude`]);

  // ...and the refresh token carries that audience forward.
  const refreshed = await request(app).post('/api/v1/oauth/token').type('form')
    .send({ grant_type: 'refresh_token', refresh_token: token.body.refresh_token, client_id: clientId });
  assert.equal(refreshed.status, 200, refreshed.text);
  assert.equal(minted[1].resource, `${ISSUER}/mcp/claude`);
});

test('an unnamed-resource grant still refuses a resource that is not ours', async () => {
  const reg = await register(['https://claude.ai/api/mcp/auth_callback'], 'Claude');
  const clientId = reg.body.client_id;
  const { verifier, approve } = await consentTo(clientId, 'https://claude.ai/api/mcp/auth_callback');
  const code = new URL(approve.redirect).searchParams.get('code');
  const token = await exchange(clientId, code, verifier, 'https://claude.ai/api/mcp/auth_callback', 'https://evil.test/mcp');
  assert.equal(token.status, 400);
  assert.equal(token.body.error, 'invalid_target');
});

// ─── Scan 12: a scheme is not a callback ─────────────────────────────────────
//
// #523 admitted the SCHEME and nothing else, so the consent page's Approve
// button could be registered to launch a handler that acts: VS Code's (and
// Cursor's) built-in git clone, VS Code's open-file handler, macOS System
// Settings. These are the four URIs the round-12 scanner registered.
const HANDLER_URIS = [
  ['macOS System Settings (a DOTTED OS scheme)', 'x-apple.systempreferences:com.apple.preference.security'],
  ['VS Code built-in git clone', 'vscode://vscode.git/clone?url=https%3A%2F%2Fevil.example%2Fpwn.git'],
  ['VS Code open-file handler', 'vscode://file/Users/victim/.ssh/config'],
  ['Cursor built-in git clone', 'cursor://vscode.git/clone?url=https%3A%2F%2Fevil.example%2Fpwn.git'],
];

for (const [label, uri] of HANDLER_URIS) {
  test(`DCR refuses a redirect_uri that launches a handler: ${label}`, async () => {
    const res = await register([uri], 'Totally Cursor');
    assert.equal(res.status, 400, `${uri} registered: ${res.text}`);
    assert.equal(res.body.error, 'invalid_redirect_uri');
    const smuggled = await register([CURSOR_CALLBACK, uri], 'Totally Cursor');
    assert.equal(smuggled.status, 400, `${uri} must not ride in beside Cursor's real callback`);
  });
}

test('editor redirects must name an extension callback, not a built-in handler', async () => {
  const refused = [
    'vscode://vscode.git/clone',
    'vscode://VSCode.Git/clone',
    'vscode://vscode%2Egit/clone',
    'vscode://vscode.github/checkout',
    'vscode://vscode.github-authentication/did-authenticate',
    'vscode://vscode.microsoft-authentication/did-authenticate',
    'vscode://ms-vscode-remote.remote-containers/cloneInVolume',
    'vscode://vscode-remote/ssh-remote+host/home',
    'vscode://file/etc/passwd',
    'vscode:extension/evil.pwn',
    'vscode-insiders://vscode.git/clone',
    'windsurf://vscode.git/clone',
    'cursor://file/Users/victim/.ssh/config',
    'cursor://anysphere.cursor-retrieval/oauth/callback',
    'cursor://anysphere.cursor-mcp:1234/oauth/callback',
    'vscode://acme.deerdawn-connector:99/cb',
  ];
  for (const bad of refused) {
    const res = await register([bad], 'Editor');
    assert.equal(res.status, 400, `${bad} must be refused: ${res.text}`);
  }
  for (const ok of [
    CURSOR_CALLBACK,
    'cursor://Anysphere.Cursor-MCP/oauth/callback',
    'vscode://acme.deerdawn-connector/oauth/callback',
    'vscode-insiders://acme.deerdawn-connector/oauth/callback',
    'windsurf://codeium.windsurf/oauth/callback',
  ]) {
    const res = await register([ok], 'Editor');
    assert.equal(res.status, 201, `${ok}: ${res.text}`);
  }
});

test('a native redirect cannot register a query of its own', async () => {
  for (const bad of [
    'com.example.app:/cb?url=https://evil.example',
    'com.example.app:/cb?',
    'vscode://acme.deerdawn-connector/cb?next=/x',
    'cursor://anysphere.cursor-mcp/oauth/callback?url=https%3A%2F%2Fevil.example',
  ]) {
    const res = await register([bad], 'Native');
    assert.equal(res.status, 400, `${bad} must be refused`);
  }
  // Web and loopback callbacks keep their queries: a browser page receives them,
  // not a launcher, and some clients carry one.
  const web = await register(['https://client.example/cb?tenant=a', 'http://127.0.0.1/cb?x=1'], 'Web');
  assert.equal(web.status, 201, web.text);
});

test('dotted schemes in an operating system namespace are refused; app namespaces are not', async () => {
  for (const bad of [
    'x-apple.systempreferences:com.apple.preference.security',
    'x-apple.systempreferences:',
    'com.apple.preference.security:/x',
    'ms-settings.privacy:/x',
    'microsoft.windows.camera:/x',
    'com.microsoft.teams:/x',
    'com.android.settings:/x',
  ]) {
    const res = await register([bad], 'Native');
    assert.equal(res.status, 400, `${bad} must be refused`);
  }
  for (const ok of ['com.example.app:/oauth2redirect', 'io.acme.desktop:/callback', 'net.xapp.client:/cb']) {
    const res = await register([ok], 'Native');
    assert.equal(res.status, 201, `${ok}: ${res.text}`);
  }
});

test('a redirect_uri with surrounding or embedded whitespace is refused, not trimmed', async () => {
  for (const bad of [
    ' https://claude.ai/api/mcp/auth_callback',
    'https://claude.ai/api/mcp/auth_callback ',
    'https://claude.ai/api/mcp/auth_callback\n',
    'https://claude.ai/api/mcp/\tauth_callback',
    `${CURSOR_CALLBACK}\r\n`,
    'http://localhost:8787/callback\u0000',
  ]) {
    const res = await register([bad], 'Spaced');
    assert.equal(res.status, 400, `${JSON.stringify(bad)} must be refused`);
  }
});

test('a client registered under the looser rule cannot reach consent with a handler URI', async () => {
  // Registrations made before this fix are stored; the rule is re-applied at
  // /authorize so an existing one cannot turn Approve into a launcher.
  const clientId = 'mcp_legacy_handler_client';
  const handler = 'vscode://vscode.git/clone?url=https%3A%2F%2Fevil.example%2Fpwn.git';
  const store = require('../../src/store/oauthClientStore');
  const original = store.loadClient;
  store.loadClient = async (id) => (id === clientId
    ? { client_id: clientId, client_name: 'Legacy', redirect_uris: [handler], registration_type: 'dcr' }
    : original(id));
  try {
    const res = await request(app).get('/api/v1/oauth/authorize').query({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: handler,
      code_challenge: 'x'.repeat(43),
      code_challenge_method: 'S256',
    });
    assert.equal(res.status, 400, res.text);
    assert.ok(!res.headers.location, 'no redirect to consent');
  } finally {
    store.loadClient = original;
  }
});

test('every real-client fixture callback is still a valid redirect', async () => {
  const uris = [
    ...fixture.clients.flatMap((c) => c.metadata.redirect_uris),
    ...fixture.observed_requests.filter((o) => o.kind === 'dcr_registration').flatMap((o) => o.registration_body.redirect_uris),
  ];
  assert.ok(uris.length >= 6);
  const res = await register(uris.slice(0, 10), 'Fixtures');
  assert.equal(res.status, 201, res.text);
});
