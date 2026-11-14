'use strict';

// What a user sees when the sign-in link has gone stale.
//
// The device code lives DEVICE_CODE_TTL = 10 minutes, and the link is handed to
// a human in a terminal who has to notice it and walk it to a browser. Arriving
// late is therefore not an edge case; it is the most likely way this page is
// ever reached in failure. It answered with a bare `{ error: 'invalid_user_code' }`
// and no message, and the dashboard renders `body.message || \`HTTP ${status}\``,
// so the user read the words "HTTP 404" — which names neither what expired nor
// the one action that fixes it. Observed 2026-09-06.
//
// The remedy is never retrying this link. It is minting a new one from the tool,
// so the response has to say that, and has to be distinguishable from a fault
// where retrying IS right.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const request = require('supertest');

// Stub requireAuth BEFORE the router destructures it at load time.
const authMiddleware = require('../../src/middleware/auth');
authMiddleware.requireAuth = (req, _res, next) => {
  req.actor = { id: 'user-test', org_id: 'org-test' };
  next();
};

const redisModule = require('../../src/config/redis');
const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

const productEvents = require('../../src/services/productEventsService');
productEvents.recordProductEvent = async () => ({});

const router = require('../../src/routes/shared/mcp-auth');

function appWith() {
  const app = express();
  app.use(express.json());
  app.use('/auth/mcp', router);
  return app;
}

function stubRedis(overrides) {
  const original = {};
  for (const k of Object.keys(overrides)) {
    original[k] = redisModule.redis[k];
    redisModule.redis[k] = overrides[k];
  }
  return () => { for (const k of Object.keys(original)) redisModule.redis[k] = original[k]; };
}

const CODE = '6FC02C66';
const authorize = (app) => request(app).post('/auth/mcp/authorize').send({ user_code: CODE });

// Ten minutes is short for a link a human has to carry from a terminal to a
// browser, but it cannot just be raised: a client at 1.0.44 polls /token for a
// hardcoded ten minutes, so a longer server window would let somebody authorize
// at minute 20 into a tool that stopped listening at minute 10 — browser says
// "Authorized", key is minted, tool never sees it. A quiet lie is worse than the
// loud 404 it replaces. So the client asks for the long window only if it will
// actually wait that long, and an old client is untouched.
test('the sign-in window is what the client can honour, not what we hope', async () => {
  const ttls = [];
  const restore = stubRedis({
    multi: () => ({
      set(_key, _value, _mode, ttl) { ttls.push(ttl); return this; },
      exec: async () => [],
    }),
  });
  try {
    const legacy = await request(appWith()).post('/auth/mcp/start').send({});
    assert.strictEqual(legacy.status, 200);
    assert.strictEqual(legacy.body.expires_in, 600, 'a client that polls a fixed window keeps the short one');
    assert.deepStrictEqual(ttls, [600, 600], 'both keys must agree with what we advertised');

    ttls.length = 0;
    const modern = await request(appWith()).post('/auth/mcp/start').send({ honors_server_expiry: true });
    assert.strictEqual(modern.body.expires_in, 1800);
    assert.deepStrictEqual(ttls, [1800, 1800]);

    // The client reads expires_at to size its poll; sending only expires_in is
    // how every client-side expiry check came to be reading undefined.
    assert.ok(modern.body.expires_at, 'expires_at must be sent, not just expires_in');
    const declared = Date.parse(modern.body.expires_at) - Date.now();
    assert.ok(declared > 1700000 && declared <= 1800000, `expires_at should match expires_in, got ${declared}ms`);
  } finally {
    restore();
  }
});

test('an expired link explains itself and points at the one action that works', async () => {
  // TTL elapsed: the key is simply gone.
  const restore = stubRedis({ get: async () => null });
  try {
    const res = await authorize(appWith());
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.terminal, true, 'the client needs to know this link cannot be retried');
    assert.ok(res.body.message, 'a bare error code renders to the user as "HTTP 404"');
    assert.match(res.body.message, /expired|already been used/i);
    assert.match(res.body.message, /again in your AI tool/i, 'must name the step that actually gets a new link');
  } finally {
    restore();
  }
});

// A device code whose user_code key survived but whose device key did not is the
// same dead end, and must read the same way.
test('a half-expired link is reported as expired, not as a mystery', async () => {
  const restore = stubRedis({
    get: async (key) => (key.startsWith('mcp:user:') ? 'devicecode123' : null),
  });
  try {
    const res = await authorize(appWith());
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.terminal, true);
    assert.match(res.body.message, /again in your AI tool/i);
  } finally {
    restore();
  }
});

// The distinction that matters: retrying is right here, and sending this user off
// to re-run a sign-in would be wrong.
test('a Redis outage is retryable and never blamed on the link', async () => {
  const restore = stubRedis({
    get: async () => { throw new Error('Connection is closed.'); },
  });
  try {
    const res = await authorize(appWith());
    assert.strictEqual(res.status, 503);
    assert.notStrictEqual(res.body.terminal, true);
    assert.match(res.body.message, /try again/i);
    assert.doesNotMatch(res.body.message, /expired/i, 'an outage is not an expiry');
  } finally {
    restore();
  }
});

test('a link that was already used says so instead of failing blankly', async () => {
  const restore = stubRedis({
    get: async (key) => (
      key.startsWith('mcp:user:')
        ? 'devicecode123'
        : JSON.stringify({ status: 'authorized', user_code: CODE })
    ),
  });
  try {
    const res = await authorize(appWith());
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.body.terminal, true);
    assert.match(res.body.message, /already been used/i);
  } finally {
    restore();
  }
});
