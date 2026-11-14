'use strict';

// The hosted brief could not have its HEADLINE corrected.
//
// `manage_memory(action:"update", task:"…")` is the only way to set the brief's
// current task — extraction has never been able to write that field, which is
// documented at the update_context handler in routes/mcp.js. The handler reads
// `task`, resolves the project, writes it through updateProjectContext and reads
// it back. All of that was live. What was missing was one line in the ADVERTISED
// inputSchema: `task` was never declared, and services/mcpSafety.js hardens every
// advertised schema to additionalProperties:false, so the argument was refused at
// validation with "arguments.task is not a supported argument" and never reached
// the handler at all.
//
// So the hosted connectors — which is how most people connect — had a write path
// whose own dispatcher supported it, whose local twin advertises it, and which
// the server refused. This is why briefs go stale on the headline: the field
// cannot be corrected in the normal loop, so nobody corrects it. The same fix was
// made once before on the LOCAL server (deerdawn-write-path-bugs-2026-08, #2) and
// the hosted half was never copied — the two-dispatcher tax again.
//
// Fixed by ACCEPTING more than is advertised, not by changing the catalog: the
// ChatGPT app resubmission is in review against a cached scan of tools/list, so
// the published schema must stay byte-identical. See HELD_UNADVERTISED_PROPERTIES
// in services/mcpSafety.js — the mirror image of ADVERTISED_HELD_FIELD_LIMITS
// beside it.

process.env.NODE_ENV = 'test';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';

const { test, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');

const db = require('../../src/config/db');
db.query = async () => ({ rows: [] });

const { redis } = require('../../src/config/redis');
const redisStore = new Map();
redis.set = async (k, v) => { redisStore.set(k, v); return 'OK'; };
redis.get = async (k) => (redisStore.has(k) ? redisStore.get(k) : null);
redis.del = async (...keys) => { keys.flat().forEach((k) => redisStore.delete(k)); return 0; };

const service = require('../../src/services/contextSyncService');

// The stored brief, so the read-back is a read of something that was written
// rather than an echo of the request. deerdawn-write-path-bugs-2026-08 is four
// write paths whose success string did not describe what happened; a test that
// asserts on the response alone cannot tell those apart.
let stored = null;
const patches = [];
service.resolveActiveProject = async () => ({ project_id: 'proj-1', project_name: 'Aurora' });
service.updateProjectContext = async (actor, projectId, delta) => {
  patches.push({ projectId, delta });
  stored = { ...(stored || {}), ...delta };
  return { project_id: projectId, project_name: 'Aurora', context: { ...stored } };
};
service.getProject = async (actor, projectId) => ({
  project_id: projectId,
  project_name: 'Aurora',
  context: { ...(stored || {}) },
});

const mcpRoutes = require('../../src/routes/mcp');

const app = express();
app.use('/mcp/claude', mcpRoutes);
app.use('/mcp', mcpRoutes);
const httpServer = app.listen(0);
after(() => new Promise((resolve) => httpServer.close(resolve)));

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const parse = (res) => {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
};

const call = (pathname, args, id) => request(httpServer).post(pathname)
  .set(MCP_HEADERS)
  .set('x-api-key', process.env.DEERDAWN_API_KEY)
  .send(rpc('tools/call', { name: 'manage_memory', arguments: args }, id));

const listManageMemory = async (pathname) => {
  const res = await request(httpServer).post(pathname).set(MCP_HEADERS).send(rpc('tools/list', {}, 99));
  return parse(res).result.tools.find((t) => t.name === 'manage_memory');
};

beforeEach(() => {
  stored = { current_task: 'ship the thing that already shipped' };
  patches.length = 0;
});

test('hosted manage_memory accepts task and the brief reads it back', async () => {
  for (const pathname of ['/mcp', '/mcp/claude']) {
    stored = { current_task: 'ship the thing that already shipped' };
    patches.length = 0;
    const res = await call(pathname, { action: 'update', task: 'cut the 2.0.2 submission' }, 11);
    const body = res.text || JSON.stringify(res.body);
    assert.ok(
      !body.includes('not a supported argument'),
      `${pathname} refused the task argument it needs to set the brief headline: ${body.slice(0, 300)}`,
    );

    // The value LANDED, and it landed in the task field specifically.
    assert.deepStrictEqual(
      patches.map((p) => p.delta),
      [{ current_task: 'cut the 2.0.2 submission' }],
      `${pathname} must write current_task directly, not through extraction`,
    );
    assert.strictEqual(stored.current_task, 'cut the 2.0.2 submission', pathname);

    // And the caller is told it landed — read back from the store, not echoed.
    const payload = parse(res).result;
    const text = (payload.content || []).map((c) => c.text).join('\n');
    assert.match(text, /cut the 2\.0\.2 submission/, pathname);
    assert.doesNotMatch(text, /NOT changed/, `${pathname} must not report the read-back failure`);
  }
});

test('a task that does not land is reported as not changed, never as success', async () => {
  // The read-back is the point: this is the fourth write path in this family
  // whose success string was written from the REQUEST.
  service.updateProjectContext = async (actor, projectId) => ({
    project_id: projectId, project_name: 'Aurora', context: { current_task: 'something else entirely' },
  });
  const res = await call('/mcp', { action: 'update', task: 'cut the 2.0.2 submission' }, 12);
  const text = (parse(res).result.content || []).map((c) => c.text).join('\n');
  assert.match(text, /NOT changed/, 'a write that did not take must say so');
  service.updateProjectContext = async (actor, projectId, delta) => {
    patches.push({ projectId, delta });
    stored = { ...(stored || {}), ...delta };
    return { project_id: projectId, project_name: 'Aurora', context: { ...stored } };
  };
});

test('task is still length-capped and type-checked like any other field', async () => {
  // Asserted on the REASON, not just on the refusal: while `task` was undeclared
  // both of these were refused as "not a supported argument", so a test that only
  // checked for invalid_arguments passed on the bug it exists to outlive.
  const tooLong = await call('/mcp', { action: 'update', task: 'x'.repeat(2_001) }, 13);
  assert.match(tooLong.text || JSON.stringify(tooLong.body), /2000 character limit/, 'capped at FIELD_LIMITS.task');
  const wrongType = await call('/mcp', { action: 'update', task: 42 }, 14);
  assert.match(wrongType.text || JSON.stringify(wrongType.body), /must be string/, 'a number is not a task');
});

// ─── HELD: the shop window does not move while the review is open ────────────

test('HELD: the advertised manage_memory schema still does not declare task', async () => {
  for (const pathname of ['/mcp', '/mcp/claude']) {
    const tool = await listManageMemory(pathname);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(tool.inputSchema.properties, 'task'),
      `${pathname}: tools/list must stay byte-identical while the ChatGPT resubmission is in review`,
    );
  }
});

test('the advertised manage_memory schema declares the task it accepts', { skip: 'held: the hosted catalog stays byte-identical while the ChatGPT resubmission is in review (see HELD_UNADVERTISED_PROPERTIES in services/mcpSafety.js)' }, async () => {
  for (const pathname of ['/mcp', '/mcp/claude']) {
    const tool = await listManageMemory(pathname);
    assert.strictEqual(tool.inputSchema.properties.task?.type, 'string', pathname);
  }
});
