'use strict';

// One address, many unrelated people.
//
// mcpAuthLimiter is keyed on client IP at 30 requests per 10 minutes, and it
// guarded four endpoints where the address is not the caller:
//
//   POST /api/v1/oauth/approve        reached through a Vercel server-side
//   POST /api/v1/auth/mcp/authorize   passthrough that forwards no client IP,
//                                     so every dashboard user is one bucket
//   POST /api/v1/oauth/token          called by Claude.ai's and ChatGPT's
//   POST /api/v1/oauth/revoke         BACKENDS, one egress per provider for
//                                     all of their users
//   POST /api/v1/oauth/register       same egress, and a connector that cannot
//                                     register cannot be installed at all
//
// So the thirty-first person to consent, or the thirty-first connection to
// refresh a token, was refused because of what thirty strangers had just done.
// The comment above the consent-details route in oauth.js describes exactly
// this hazard, and the limiter was removed from that one route only.
//
// The key is now the thing being protected: the PERSON for the two
// authenticated consent routes, the GRANT being exchanged for the token
// routes. A generous per-address floor still bounds an unauthenticated flood,
// because neither of those keys can.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'false';
process.env.RATE_LIMIT_FALLBACK = 'memory';
process.env.DISABLE_REDIS = 'true';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';
process.env.DEERDAWN_API_KEY = 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
// Lowered so a flood is a few hundred requests rather than a few thousand.
process.env.OAUTH_SHARED_EGRESS_LIMIT = '150';
process.env.OAUTH_ACTOR_LIMIT = '40';
process.env.OAUTH_GRANT_LIMIT = '20';

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { hashApiKey } = require('../../src/utils/security');

// Four people, each with their own credential, all arriving from one address.
// The per-person buckets are keyed on the person and not on the address, so a
// test that spends one person's budget has spent it everywhere: each pair here
// belongs to one scenario.
const PERSON_A = { key: `dd_${'a'.repeat(40)}`, owner: 'user-aaaa', keyId: 'key-a' };
const PERSON_B = { key: `dd_${'b'.repeat(40)}`, owner: 'user-bbbb', keyId: 'key-b' };
const PERSON_C = { key: `dd_${'c'.repeat(40)}`, owner: 'user-cccc', keyId: 'key-c' };
const PERSON_D = { key: `dd_${'d'.repeat(40)}`, owner: 'user-dddd', keyId: 'key-d' };
const keyRows = new Map([PERSON_A, PERSON_B, PERSON_C, PERSON_D].map((p) => [hashApiKey(p.key), {
  key_id: p.keyId,
  owner_id: p.owner,
  org_id: 'org-shared',
  environment: 'production',
  scopes: ['context:read', 'context:write'],
  status: 'active',
  expires_at: new Date(Date.now() + 86400000).toISOString(),
  oauth_resource: null,
}]));

const db = require('../../src/config/db');
db.query = async (text, params = []) => {
  if (/SELECT \* FROM api_keys WHERE key_hash/.test(text)) {
    const row = keyRows.get(params[0]);
    return { rows: row ? [row] : [] };
  }
  return { rows: [] };
};

const { redis } = require('../../src/config/redis');
redis.get = async () => null;
redis.set = async () => 'OK';
redis.del = async () => 0;

const productEvents = require('../../src/services/productEventsService');
productEvents.recordProductEvent = async () => ({});

const oauthRoutes = require('../../src/routes/oauth');
const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use('/', oauthRoutes);

const post = (path, ip, body, apiKey) => {
  const r = request(app).post(path).set('X-Forwarded-For', ip);
  if (apiKey) r.set('X-Api-Key', apiKey);
  return r.send(body);
};

const approve = (ip, person) => post('/api/v1/oauth/approve', ip, { req: 'a'.repeat(48) }, person.key);
const refreshWith = (ip, token) => request(app)
  .post('/api/v1/oauth/token')
  .set('X-Forwarded-For', ip)
  .type('form')
  .send({ grant_type: 'refresh_token', refresh_token: token, resource: 'https://api.deerdawn.test/mcp' });
const freshToken = () => `ddr_${crypto.randomBytes(32).toString('hex')}`;

async function repeat(times, fn) {
  const codes = [];
  for (let i = 0; i < times; i += 1) codes.push((await fn(i)).status);
  return codes;
}

test('one person consenting a lot does not lock out the next person on the same egress', async () => {
  const ip = '203.0.113.80';
  // More than the old 30-per-address budget, still inside this person's own.
  const mine = await repeat(35, () => approve(ip, PERSON_A));
  assert.ok(!mine.includes(429), `a single person's own budget should cover 35: ${mine.filter((c) => c === 429).length} refused`);

  const theirs = await approve(ip, PERSON_B);
  assert.notStrictEqual(theirs.status, 429, 'a colleague must not inherit somebody else\'s spent budget');
  assert.strictEqual(theirs.status, 404, 'and should get the ordinary expired-request answer');
});

test('a person\'s own consent budget is still finite', async () => {
  const ip = '203.0.113.81';
  const limit = Number(process.env.OAUTH_ACTOR_LIMIT);
  const codes = await repeat(limit + 6, () => approve(ip, PERSON_A));
  assert.ok(codes.includes(429), 'the per-person bucket must still close');
});

test('two connections refreshing from one provider egress do not share a budget', async () => {
  const ip = '198.51.100.20';
  // Each request presents a different refresh token, the way separate users'
  // connections do when Claude.ai refreshes them from one backend.
  const codes = await repeat(40, () => refreshWith(ip, freshToken()));
  assert.ok(!codes.includes(429), `unrelated grants must not share a bucket: ${codes.filter((c) => c === 429).length} refused`);
  assert.ok(codes.every((c) => c === 400), 'an unknown grant answers invalid_grant, not a rate limit');
});

test('one connection retrying the same grant is still bounded', async () => {
  const ip = '198.51.100.21';
  const token = freshToken();
  const limit = Number(process.env.OAUTH_GRANT_LIMIT);
  const codes = await repeat(limit + 5, () => refreshWith(ip, token));
  assert.ok(codes.includes(429), 'one grant hammering the token endpoint must still be refused');
});

test('an unauthenticated flood from one address is still bounded', async () => {
  const ip = '198.51.100.22';
  const ceiling = Number(process.env.OAUTH_SHARED_EGRESS_LIMIT);
  // A per-grant key cannot bound a caller inventing a grant per request, which
  // is what the address floor is for.
  const codes = await repeat(ceiling + 15, () => refreshWith(ip, freshToken()));
  assert.ok(codes.includes(429), 'the shared-egress floor must still close on a flood');
});

test('registration gets a budget a provider egress will not hit in normal use', async () => {
  const ip = '203.0.113.82';
  const codes = await repeat(40, (i) => post('/api/v1/oauth/register', ip, {
    client_name: `Client ${i}`,
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  }));
  assert.ok(!codes.includes(429), `40 registrations from one egress is normal: ${codes.filter((c) => c === 429).length} refused`);
  assert.ok(codes.every((c) => c === 201), 'and each one actually registers');
});

// The device flow's browser leg has the same shape and the same passthrough
// (apps/dashboard/src/pages/api/mcp-authorize.ts), but its limiter is mounted
// in app.js rather than in the route file, so these drive the real app.
const realApp = require('../../src/app');
const authorizeAs = (ip, person) => request(realApp)
  .post('/api/v1/auth/mcp/authorize')
  .set('X-Forwarded-For', ip)
  .set('X-Api-Key', person.key)
  .send({ user_code: 'ABCD1234' });

test('one person finishing device sign-ins does not lock out the next', async () => {
  const ip = '203.0.113.90';
  const mine = await repeat(35, () => authorizeAs(ip, PERSON_C));
  assert.ok(!mine.includes(429), `35 is inside one person's budget: ${mine.filter((c) => c === 429).length} refused`);

  const theirs = await authorizeAs(ip, PERSON_D);
  assert.notStrictEqual(theirs.status, 429, 'a colleague on the same dashboard egress must still be able to authorize');
  assert.strictEqual(theirs.status, 404, 'and should get the ordinary expired-link answer');
});

test('an unauthenticated flood on the device authorize leg is still bounded', async () => {
  const ip = '203.0.113.91';
  const ceiling = Number(process.env.OAUTH_SHARED_EGRESS_LIMIT);
  const codes = await repeat(ceiling + 15, () => request(realApp)
    .post('/api/v1/auth/mcp/authorize')
    .set('X-Forwarded-For', ip)
    .send({ user_code: 'ABCD1234' }));
  assert.ok(codes.includes(429), 'the address floor must still close on an unauthenticated flood');
});

test('registration is still bounded per address', async () => {
  const ip = '203.0.113.83';
  const limit = Number(process.env.OAUTH_REGISTER_LIMIT || 120);
  const codes = await repeat(limit + 5, (i) => post('/api/v1/oauth/register', ip, {
    client_name: `Flood ${i}`,
    redirect_uris: ['https://evil.test/callback'],
  }));
  assert.ok(codes.includes(429), 'registration must not be unlimited');
});
