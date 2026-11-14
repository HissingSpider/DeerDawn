/**
 * Plain HTTP on a SELF-HOSTED install (NODE_ENV=production, SELF_HOSTED=true).
 *
 * The quickstart serves http://localhost:3000, so a self-host accepts plain
 * HTTP addressed to localhost / 127.0.0.1 / ::1 on every route, MCP and OAuth
 * included, and does not mark its session cookies Secure there (Safari drops a
 * Secure cookie on http://localhost). Plain HTTP to any other host is refused
 * with https_required and a message telling the operator how to get HTTPS.
 * Hosted (SELF_HOSTED unset) is exactly as before: MCP/OAuth need HTTPS,
 * everything else passes, cookies are Secure in production.
 *
 * The middleware runs behind Express with trust proxy = 1, as in app.js, so
 * X-Forwarded-Host / X-Forwarded-Proto from the proxy hop (Caddy, or the
 * dashboard's internal fetch) decide the host and scheme.
 */
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

const { transportGuard } = require('../../src/middleware/transportGuard');
const {
  isLocalHostname,
  selfHostedPlainHttp,
  sessionCookieSecure,
} = require('../../src/config/selfHosted');

const KEYS = ['NODE_ENV', 'SELF_HOSTED', 'PUBLIC_URL'];
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) {
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return await fn();
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function app() {
  const a = express();
  a.set('trust proxy', 1);
  a.use(transportGuard);
  a.all('*', (req, res) => res.json({ ok: true, cookieSecure: sessionCookieSecure(req) }));
  return a;
}

const SELF = { NODE_ENV: 'production', SELF_HOSTED: 'true', PUBLIC_URL: 'http://localhost:3000' };
const HOSTED = { NODE_ENV: 'production', SELF_HOSTED: undefined, PUBLIC_URL: undefined };

test('local hostnames are the loopback names and *.localhost, nothing else', () => {
  for (const h of ['localhost', 'LOCALHOST', '127.0.0.1', '::1', '[::1]', 'app.localhost']) assert.ok(isLocalHostname(h), h);
  for (const h of ['', 'api', '10.0.0.5', '192.168.1.20', 'deerdawn.example.com', 'localhost.example.com', '127.0.0.2']) {
    assert.ok(!isLocalHostname(h), h);
  }
});

test('self-hosted, plain HTTP at localhost: every route passes, MCP and OAuth included', () => withEnv(SELF, async () => {
  for (const path of ['/mcp', '/api/v1/oauth/authorize', '/.well-known/oauth-authorization-server', '/api/v1/auth/signup']) {
    const res = await request(app()).post(path).set('Host', 'localhost:3000');
    assert.equal(res.status, 200, path);
  }
  const ipv4 = await request(app()).get('/mcp').set('Host', '127.0.0.1:3000');
  assert.equal(ipv4.status, 200);
  const ipv6 = await request(app()).get('/mcp').set('Host', '[::1]:3000');
  assert.equal(ipv6.status, 200);
}));

test('self-hosted, plain HTTP at localhost: session cookies are not Secure', () => withEnv(SELF, async () => {
  const res = await request(app()).post('/api/v1/auth/login').set('Host', 'localhost:3000');
  assert.equal(res.body.cookieSecure, false);
}));

test('self-hosted, the dashboard server calling the api service carries the public host', () => withEnv(SELF, async () => {
  // internal-fetch.cjs sends to http://api:8080 with these headers.
  const res = await request(app()).post('/api/v1/oauth/consent')
    .set('Host', 'api:8080')
    .set('X-Forwarded-Host', 'localhost:3000')
    .set('X-Forwarded-Proto', 'http');
  assert.equal(res.status, 200);
  const bare = await request(app()).post('/api/v1/oauth/consent').set('Host', 'api:8080');
  assert.equal(bare.status, 400, 'without them it is a non-local host over plain HTTP');
}));

test('self-hosted, plain HTTP at any other host is refused with how to get HTTPS', () => withEnv(SELF, async () => {
  for (const path of ['/api/v1/auth/login', '/mcp', '/api/v1/context/projects', '/']) {
    const res = await request(app()).post(path).set('Host', '192.168.1.20:3000');
    assert.equal(res.status, 400, path);
    assert.equal(res.body.error, 'https_required');
    assert.match(res.body.message, /plain HTTP at 192\.168\.1\.20/);
    assert.match(res.body.message, /only on localhost/);
    assert.match(res.body.message, /init\.sh --domain/);
    assert.match(res.body.message, /docker-compose\.https\.yml/);
  }
}));

test('self-hosted: the health checks answer over plain HTTP on any host', () => withEnv(SELF, async () => {
  for (const path of ['/healthz', '/healthz/ready', '/health/live']) {
    const res = await request(app()).get(path).set('Host', 'api:8080');
    assert.equal(res.status, 200, path);
  }
}));

test('self-hosted behind HTTPS (Caddy on a domain): everything passes, cookies Secure', () => withEnv({ ...SELF, PUBLIC_URL: 'https://dd.example.com' }, async () => {
  const res = await request(app()).post('/mcp').set('Host', 'dd.example.com').set('X-Forwarded-Proto', 'https');
  assert.equal(res.status, 200);
  assert.equal(res.body.cookieSecure, true);
}));

test('self-hosted with an https PUBLIC_URL: TLS ends in front of the bundled proxy', () => withEnv({ ...SELF, PUBLIC_URL: 'https://dd.example.com' }, async () => {
  // Caddy in :80 mode replaces X-Forwarded-Proto with http; the operator's
  // own TLS proxy sits in front of it.
  const res = await request(app()).post('/api/v1/auth/login').set('Host', 'dd.example.com').set('X-Forwarded-Proto', 'http');
  assert.equal(res.status, 200);
  assert.equal(res.body.cookieSecure, true);
  assert.equal(selfHostedPlainHttp({ secure: false, hostname: 'dd.example.com', headers: {} }), null);
}));

test('hosted is unchanged: MCP/OAuth need HTTPS, other routes pass, cookies Secure, localhost gets no exception', () => withEnv(HOSTED, async () => {
  const mcp = await request(app()).post('/mcp').set('Host', 'localhost:8080');
  assert.equal(mcp.status, 400);
  assert.deepEqual(mcp.body, { error: 'https_required', message: 'MCP and OAuth requests require HTTPS.' });
  const oauth = await request(app()).get('/api/v1/oauth/authorize').set('Host', 'api.deerdawn.com');
  assert.equal(oauth.status, 400);
  const viaProxy = await request(app()).post('/mcp').set('Host', 'api.deerdawn.com').set('X-Forwarded-Proto', 'https');
  assert.equal(viaProxy.status, 200);
  const login = await request(app()).post('/api/v1/auth/login').set('Host', '10.0.0.5');
  assert.equal(login.status, 200);
  assert.equal(login.body.cookieSecure, true);
  const local = await request(app()).post('/api/v1/auth/login').set('Host', 'localhost:8080');
  assert.equal(local.body.cookieSecure, true);
  assert.equal(selfHostedPlainHttp({ secure: false, hostname: 'localhost', headers: {} }), null);
}));

test('outside production nothing is refused (local dev and the test suites)', () => withEnv({ ...SELF, NODE_ENV: 'test' }, async () => {
  const res = await request(app()).post('/mcp').set('Host', '192.168.1.20');
  assert.equal(res.status, 200);
  assert.equal(res.body.cookieSecure, false);
}));
