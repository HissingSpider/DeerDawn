/**
 * Two guards on the public surface that were not guarding what they looked like
 * they were guarding.
 *
 * 1. The share-view rate limit was keyed on express-rate-limit's default, req.ip
 *    — and /s/:token is server-rendered, so req.ip is the RENDERER for every
 *    visitor in the world. One bucket for the entire share surface.
 * 2. originGuard's allowlist was real but was skipped wholesale whenever
 *    NODE_ENV was not exactly 'production'.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// The route module pulls in the DB pool and the shared-context package at
// require time; neither is touched by the pure key function under test, but the
// pool must not try to connect.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://unused:unused@127.0.0.1:1/unused';

const { isAllowedOrigin, buildOriginAllowlist } = require('../../src/middleware/originGuard');

const reqWith = (headers, ip = '203.0.113.9') => ({
  headers,
  ip,
  socket: { remoteAddress: ip },
});

test('a share view is counted against the VISITOR, not the server that rendered it', () => {
  const { shareVisitorKey, SHARE_CLIENT_IP_HEADER } = require('../../src/routes/public-content');

  // Two different readers of two different links, both arriving through the
  // same Next.js renderer. Before the fix these shared one 60/minute bucket
  // with every other share view on the site.
  const renderer = '198.51.100.7';
  const a = shareVisitorKey(reqWith({ [SHARE_CLIENT_IP_HEADER]: '203.0.113.10' }, renderer));
  const b = shareVisitorKey(reqWith({ [SHARE_CLIENT_IP_HEADER]: '203.0.113.11' }, renderer));

  assert.notEqual(a, b, 'two visitors must not share a bucket just because one server rendered both');
  assert.match(a, /203\.0\.113\.10/);
});

test('a junk or absent forwarded address falls back to the peer, never to a free pass', () => {
  const { shareVisitorKey, SHARE_CLIENT_IP_HEADER } = require('../../src/routes/public-content');

  const peer = '198.51.100.7';
  const fallback = shareVisitorKey(reqWith({}, peer));
  assert.equal(fallback, `peer:${peer}`);

  // A forged value that is not an address must not become a bucket of its own.
  for (const junk of ['not-an-ip', '', 'ip; DROP TABLE', 'x'.repeat(200)]) {
    assert.equal(
      shareVisitorKey(reqWith({ [SHARE_CLIENT_IP_HEADER]: junk }, peer)),
      `peer:${peer}`,
      `"${junk}" is not an address and must fall back to the peer bucket`
    );
  }
});

test('with a renderer secret configured, a forwarded address is believed only from the renderer', () => {
  const { shareVisitorKey, SHARE_CLIENT_IP_HEADER } = require('../../src/routes/public-content');
  const saved = process.env.SHARE_RENDERER_SECRET;
  process.env.SHARE_RENDERER_SECRET = 'renderer-secret-for-this-test';
  try {
    const attacker = '198.51.100.77';
    // Somebody calling the API directly, inventing a new visitor per request.
    const forgedA = shareVisitorKey(reqWith({ [SHARE_CLIENT_IP_HEADER]: '203.0.113.10' }, attacker));
    const forgedB = shareVisitorKey(reqWith({ [SHARE_CLIENT_IP_HEADER]: '203.0.113.11' }, attacker));
    assert.equal(forgedA, `peer:${attacker}`, 'THE BUG: a forged header bought a fresh bucket');
    assert.equal(forgedA, forgedB, 'every forged request must land in the caller\'s own bucket');

    const wrong = shareVisitorKey(reqWith({
      [SHARE_CLIENT_IP_HEADER]: '203.0.113.10',
      'x-deerdawn-renderer-secret': 'not-the-secret',
    }, attacker));
    assert.equal(wrong, `peer:${attacker}`);

    // The real renderer: believed, and keyed on the visitor.
    const renderer = '192.0.2.50';
    const real = shareVisitorKey(reqWith({
      [SHARE_CLIENT_IP_HEADER]: '203.0.113.10',
      'x-deerdawn-renderer-secret': 'renderer-secret-for-this-test',
    }, renderer));
    assert.equal(real, 'visitor:203.0.113.10');
  } finally {
    if (saved === undefined) delete process.env.SHARE_RENDERER_SECRET;
    else process.env.SHARE_RENDERER_SECRET = saved;
  }
});

test('with NO secret configured the forwarded address is still honoured, so a half-finished rollout does not collapse every visitor into one bucket', () => {
  const { shareVisitorKey, SHARE_CLIENT_IP_HEADER } = require('../../src/routes/public-content');
  const saved = process.env.SHARE_RENDERER_SECRET;
  delete process.env.SHARE_RENDERER_SECRET;
  try {
    assert.equal(
      shareVisitorKey(reqWith({ [SHARE_CLIENT_IP_HEADER]: '203.0.113.10' }, '192.0.2.50')),
      'visitor:203.0.113.10',
    );
  } finally {
    if (saved !== undefined) process.env.SHARE_RENDERER_SECRET = saved;
  }
});

test('originGuard allows the app\'s own origins and refuses everything else — in every environment', () => {
  const env = { NODE_ENV: 'production' };

  assert.equal(isAllowedOrigin(reqWith({ origin: 'https://deerdawn.com' }), env), true);
  assert.equal(isAllowedOrigin(reqWith({ origin: 'https://app.deerdawn.com' }), env), true);
  assert.equal(isAllowedOrigin(reqWith({ referer: 'https://www.deerdawn.com/tools/context-preview' }), env), true);

  assert.equal(isAllowedOrigin(reqWith({ origin: 'https://evil.example' }), env), false);
  // The classic near-miss: our name as a prefix of somebody else's domain.
  assert.equal(isAllowedOrigin(reqWith({ origin: 'https://deerdawn.com.evil.example' }), env), false);
  assert.equal(isAllowedOrigin(reqWith({ referer: 'https://evil.example/page' }), env), false);
  // No Origin and no Referer is a script, not one of our pages.
  assert.equal(isAllowedOrigin(reqWith({}), env), false);
});

test('the guard is not switched off outside production', () => {
  // This is the bug: `if (process.env.NODE_ENV !== 'production') return next()`
  // accepted every origin everywhere except prod.
  for (const NODE_ENV of ['test', 'staging', 'development', undefined]) {
    assert.equal(
      isAllowedOrigin(reqWith({ origin: 'https://evil.example' }), { NODE_ENV }),
      false,
      `NODE_ENV=${String(NODE_ENV)} must not wave a foreign origin through`
    );
  }
  // ...but local development still works, because localhost is ON the list
  // there rather than the list being ignored.
  assert.equal(isAllowedOrigin(reqWith({ origin: 'http://localhost:3001' }), { NODE_ENV: 'development' }), true);
  assert.equal(isAllowedOrigin(reqWith({ origin: 'http://localhost:3001' }), { NODE_ENV: 'production' }), false);
});

test('the allowlist follows the deployment, and ignores case and a trailing slash', () => {
  const env = { NODE_ENV: 'production', MARKETING_URL: 'https://Preview.DeerDawn.com/' };
  assert.equal(buildOriginAllowlist(env).has('https://preview.deerdawn.com'), true);
  assert.equal(isAllowedOrigin(reqWith({ origin: 'https://preview.deerdawn.com' }), env), true);
  assert.equal(isAllowedOrigin(reqWith({ origin: 'HTTPS://DEERDAWN.COM' }), env), true);
});
