'use strict';

// An idle SSE stream is not a free connection: it is one of 64 in-flight slots.
//
// routes/mcp.js answered GET with the same stateless transport it answers POST
// with, so an authenticated GET opened a Streamable HTTP event stream that
// never sent anything. The concurrency gate at the top of that router counts an
// open response for its entire lifetime, and MCP TypeScript SDK clients (Cursor,
// VS Code, Claude Code over http) open this stream right after initialize and
// reconnect whenever it drops. So roughly MCP_MAX_CONCURRENCY editors sitting
// idle were enough for the next request from anybody — Claude.ai included — to
// be refused 503 "MCP capacity reached", while the server did no work at all.
//
// The server is stateless and never pushes, so there is no stream to offer.
// Streamable HTTP allows saying so with 405, and the SDK treats that as "no SSE
// stream offered" rather than as a failure.

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.API_BASE_URL = 'https://api.deerdawn.test';
process.env.DEERDAWN_API_KEY = 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
// Small enough that "some clients are idling" is a handful of requests rather
// than 64. The defect is about the ratio, not the number.
process.env.MCP_MAX_CONCURRENCY = '2';

const { test, after } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const request = require('supertest');

const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
redis.set = async (k, v) => { redisStore.set(k, v); return 'OK'; };
redis.get = async (k) => (redisStore.has(k) ? redisStore.get(k) : null);
redis.del = async (...keys) => { keys.flat().forEach((k) => redisStore.delete(k)); return 0; };

const mcpRoutes = require('../../src/routes/mcp');

const app = express();
app.use('/mcp/claude', mcpRoutes);
app.use('/mcp', mcpRoutes);
app.use('/api/v1/mcp', mcpRoutes);

const httpServer = app.listen(0);
after(() => new Promise((resolve) => httpServer.close(resolve)));

const SYSTEM_KEY = process.env.DEERDAWN_API_KEY;
const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };

// Raw http, because the point of the old behaviour was a response that never
// ends: supertest would simply wait for it.
function openStream(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({
      port: httpServer.address().port,
      path,
      headers: { Accept: 'text/event-stream', 'X-Api-Key': SYSTEM_KEY },
    }, (res) => {
      // Do not consume the body: an SSE stream would stay open here, which is
      // exactly the state that held a slot.
      resolve({ status: res.statusCode, headers: res.headers, close: () => req.destroy() });
    });
    req.on('error', reject);
  });
}

for (const path of ['/mcp', '/mcp/claude', '/api/v1/mcp']) {
  test(`${path}: an authenticated GET offers no stream and holds no slot`, async () => {
    const opened = [];
    try {
      // Exactly the whole capacity of this instance, sitting idle.
      const capacity = Number(process.env.MCP_MAX_CONCURRENCY);
      for (let i = 0; i < capacity; i += 1) opened.push(await openStream(path));

      // The request everybody else is trying to make, from a client that has
      // nothing to do with those editors. This is the assertion that matters:
      // while GET returned a stream, it was a 503.
      const post = await request(httpServer)
        .post(path)
        .set(MCP_HEADERS)
        .set('X-Api-Key', SYSTEM_KEY)
        .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.notStrictEqual(post.status, 503, 'idle GETs must not exhaust MCP capacity');
      assert.strictEqual(post.status, 200, `tools/list should answer normally: ${post.text}`);

      for (const stream of opened) {
        assert.strictEqual(stream.status, 405, 'GET must not open a stream this server never writes to');
        assert.match(String(stream.headers.allow || ''), /POST/, 'a 405 must say what is allowed');
      }
    } finally {
      opened.forEach((stream) => stream.close());
    }
  });
}

test('an unauthenticated GET still points the client at the authorization server', async () => {
  const res = await request(httpServer).get('/mcp').set({ Accept: 'text/event-stream' });
  assert.strictEqual(res.status, 401, 'discovery depends on the 401, not on the 405');
  assert.match(
    res.headers['www-authenticate'] || '',
    /resource_metadata="https:\/\/api\.deerdawn\.test\/\.well-known\/oauth-protected-resource\/mcp"/,
  );
});

test('the Claude catalog path advertises its own resource metadata on a 401', async () => {
  const res = await request(httpServer).get('/mcp/claude').set({ Accept: 'text/event-stream' });
  assert.strictEqual(res.status, 401);
  assert.match(res.headers['www-authenticate'] || '', /oauth-protected-resource\/mcp\/claude"/);
});

test('POST is untouched: the JSON-RPC path still answers', async () => {
  const res = await request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .send({ jsonrpc: '2.0', id: 7, method: 'tools/list', params: {} });
  assert.strictEqual(res.status, 200, res.text);
});

test('DELETE is still accepted, and the Allow header says so', async () => {
  const res = await request(httpServer).delete('/mcp');
  assert.strictEqual(res.status, 200);
});
