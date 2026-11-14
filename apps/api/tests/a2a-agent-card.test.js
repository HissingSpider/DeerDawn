'use strict';

// A2A Agent Card + JSON-RPC binding contract tests.
//
// Guards two things that must not drift apart:
//   1. The Agent Card served at /.well-known/agent-card.json satisfies the
//      required AgentCard fields in the A2A spec (§8, protojson field names).
//   2. The interface the card declares in `supportedInterfaces` is the route
//      actually mounted in src/app.js, and it speaks JSON-RPC — §8.3.1 requires
//      an interface entry to accurately declare its URL and transport.
//
// Runs standalone: NODE_ENV=test stubs Redis to in-memory; db.query is stubbed so
// no Postgres is needed.
//   node tests/a2a-agent-card.test.js

process.env.NODE_ENV = 'test';
process.env.DEERDAWN_API_KEY = process.env.DEERDAWN_API_KEY || 'dev-system-key-aaaaaaaaaaaaaaaaaaaa';
process.env.API_BASE_URL = 'https://api.deerdawn.test';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { privateSkipReason } = require('./helpers/privatePaths');
const express = require('express');
const request = require('supertest');

const apiRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(apiRoot, '../..');

// Stub DB so requireAuth's API-key lookup never hits Postgres.
const db = require('../src/config/db');
db.query = async () => ({ rows: [] });

// In-memory Redis (mirrors mcp-remote-auth-gate.test.js).
const { redis } = require('../src/config/redis');
const redisStore = new Map();
redis.set = async (k, v) => { redisStore.set(k, v); return 'OK'; };
redis.get = async (k) => (redisStore.has(k) ? redisStore.get(k) : null);
redis.del = async (...keys) => { keys.flat().forEach((k) => redisStore.delete(k)); return 0; };

const a2aRoutes = require('../src/routes/a2a');
const { buildAgentCard, A2A_BASE_PATH, A2A_SKILLS } = require('../src/config/agentCard');

const app = express();
// app.js parses every JSON body before any router runs; the A2A router no longer
// carries a second, shadowed parser of its own, so this harness does what the
// real app does.
app.use(express.json());
app.use('/', a2aRoutes.discoveryRouter);
app.use(A2A_BASE_PATH, a2aRoutes);

const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

const tests = [];
// `requires`: repo paths only the private repo has; reported as skipped where
// they are missing (the public export does not ship apps/marketing).
const test = (name, fn, { requires = [] } = {}) => tests.push([name, fn, privateSkipReason(...requires)]);

const appSource = fs.readFileSync(path.join(apiRoot, 'src/app.js'), 'utf8');

// ─── Card shape ───────────────────────────────────────────────────────────────

test('agent card carries every field the A2A spec marks REQUIRED', () => {
  const card = buildAgentCard();
  for (const field of [
    'name', 'description', 'supportedInterfaces', 'version',
    'capabilities', 'defaultInputModes', 'defaultOutputModes', 'skills',
  ]) {
    assert.ok(card[field] !== undefined, `AgentCard.${field} is required`);
  }
  assert.strictEqual(typeof card.name, 'string');
  assert.ok(card.name.length > 0);
  assert.ok(card.description.length > 20, 'description must actually describe the agent');
  assert.match(card.version, /^\d+\.\d+\.\d+$/);
  assert.ok(Array.isArray(card.defaultInputModes) && card.defaultInputModes.length > 0);
  assert.ok(Array.isArray(card.defaultOutputModes) && card.defaultOutputModes.length > 0);
});

test('supportedInterfaces declares an absolute HTTPS URL, binding, and protocol version', () => {
  const card = buildAgentCard();
  assert.ok(Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0);
  for (const iface of card.supportedInterfaces) {
    assert.ok(iface.url, 'AgentInterface.url is required');
    assert.ok(iface.protocolBinding, 'AgentInterface.protocolBinding is required');
    assert.ok(iface.protocolVersion, 'AgentInterface.protocolVersion is required');
    const parsed = new URL(iface.url);
    assert.strictEqual(parsed.protocol, 'https:', 'production interfaces must be HTTPS');
    assert.ok(
      ['JSONRPC', 'GRPC', 'HTTP+JSON'].includes(iface.protocolBinding),
      `unknown protocolBinding ${iface.protocolBinding}`,
    );
  }
});

test('every skill has id, name, description, and tags', () => {
  const card = buildAgentCard();
  assert.ok(Array.isArray(card.skills) && card.skills.length > 0);
  const ids = new Set();
  for (const skill of card.skills) {
    for (const field of ['id', 'name', 'description', 'tags']) {
      assert.ok(skill[field] !== undefined, `AgentSkill.${field} is required (skill ${skill.id})`);
    }
    assert.ok(!ids.has(skill.id), `duplicate skill id ${skill.id}`);
    ids.add(skill.id);
    assert.ok(Array.isArray(skill.tags) && skill.tags.length > 0);
    assert.ok(skill.description.length > 20, `skill ${skill.id} needs a real description`);
  }
});

test('capabilities are declared honestly — no streaming, no push', () => {
  const card = buildAgentCard();
  // The JSON-RPC binding below rejects SendStreamingMessage/SubscribeToTask and
  // the push-config methods. If either capability is ever flipped on, the
  // corresponding handlers must stop returning UnsupportedOperation.
  assert.strictEqual(card.capabilities.streaming, false);
  assert.strictEqual(card.capabilities.pushNotifications, false);
  assert.strictEqual(card.capabilities.extendedAgentCard, false);
});

test('every advertised skill has a handler, and every handler is advertised', () => {
  const advertised = A2A_SKILLS.map((s) => s.id).sort();
  const implemented = Object.keys(a2aRoutes.SKILL_HANDLERS).sort();
  assert.deepStrictEqual(implemented, advertised);
});

test('read-task-board is a READ: it dispatches read_tasks, never a write-scoped tool', () => {
  // The dispatched tool decides the scope the caller must hold. Routed through
  // manage_todos (context:write even for a list), a read-only credential could
  // not look at the board — the caveat #290 shipped with, closed here.
  const a2aSource = fs.readFileSync(path.join(apiRoot, 'src/routes/a2a.js'), 'utf8');
  const handler = a2aSource.slice(a2aSource.indexOf('\'read-task-board\''));
  const body = handler.slice(0, handler.indexOf('),') + 2);
  assert.match(body, /dispatchTool\(\s*'read_tasks'/, 'the board read must go through read_tasks');
  assert.ok(!body.includes('manage_todos'), 'a read skill must not dispatch a write-scoped tool');
});

test('the declared interface URL is the route app.js actually mounts', () => {
  const card = buildAgentCard();
  const declared = new URL(card.supportedInterfaces[0].url);
  assert.strictEqual(declared.pathname, A2A_BASE_PATH);
  assert.ok(
    appSource.includes('app.use(A2A_BASE_PATH, mcpUnauthenticatedIpLimiter, mcpToolLimiter, a2aRoutes)'),
    'app.js must mount the A2A router at the path the card declares',
  );
  assert.ok(
    appSource.includes('app.use(\'/\', a2aRoutes.discoveryRouter)'),
    'app.js must mount the agent-card discovery router',
  );
});

// ─── Well-known URI ───────────────────────────────────────────────────────────

test('GET /.well-known/agent-card.json returns 200 JSON', async () => {
  const res = await request(app).get('/.well-known/agent-card.json');
  assert.strictEqual(res.status, 200);
  assert.match(res.headers['content-type'], /application\/json/);
  assert.strictEqual(res.body.name, 'DeerDawn');
  assert.ok(Array.isArray(res.body.skills) && res.body.skills.length > 0);
});

// ─── JSON-RPC binding ─────────────────────────────────────────────────────────

test('GetAgentCard is answerable without credentials', async () => {
  const res = await request(app).post(A2A_BASE_PATH).send(rpc('GetAgentCard'));
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.body.jsonrpc, '2.0');
  assert.strictEqual(res.body.id, 1);
  assert.deepStrictEqual(res.body.result, JSON.parse(JSON.stringify(buildAgentCard())));
});

test('SendMessage without credentials is 401 with an RFC 9728 pointer', async () => {
  const res = await request(app)
    .post(A2A_BASE_PATH)
    .send(rpc('SendMessage', { message: { role: 'ROLE_USER', parts: [{ text: 'hi' }] } }));
  assert.strictEqual(res.status, 401);
  assert.match(
    res.headers['www-authenticate'] || '',
    /resource_metadata="https:\/\/api\.deerdawn\.test\/\.well-known\/oauth-protected-resource\/a2a\/v1"/,
  );
});

test('every non-discovery method is auth-gated', async () => {
  for (const [method, entry] of Object.entries(a2aRoutes.METHODS)) {
    if (entry.auth === false) continue;
    const res = await request(app).post(A2A_BASE_PATH).send(rpc(method, {}));
    assert.strictEqual(res.status, 401, `${method} must require auth`);
  }
});

test('an unknown method is auth-gated like any other non-discovery call', async () => {
  // MethodNotFound (-32601) is reachable, but only past the auth gate — an
  // anonymous caller learns nothing about the method table.
  const res = await request(app).post(A2A_BASE_PATH).send(rpc('DoTheThing'));
  assert.strictEqual(res.status, 401);
});

test('malformed and batch requests return InvalidRequest (-32600) before auth', async () => {
  const malformed = await request(app).post(A2A_BASE_PATH).send({ id: 1, method: 'GetAgentCard' });
  assert.strictEqual(malformed.body.error.code, -32600);

  const batch = await request(app).post(A2A_BASE_PATH).send([rpc('GetAgentCard')]);
  assert.strictEqual(batch.body.error.code, -32600);
});

// ─── Message interpretation ───────────────────────────────────────────────────

test('a plain-text message routes to the default search skill', () => {
  const { skill, input } = a2aRoutes.readMessage({
    role: 'ROLE_USER',
    parts: [{ text: 'what did we decide about pricing' }],
  });
  assert.strictEqual(skill, 'search-memory');
  assert.strictEqual(input.query, 'what did we decide about pricing');
});

test('a data part selects the skill and carries its arguments', () => {
  const { skill, input } = a2aRoutes.readMessage({
    role: 'ROLE_USER',
    parts: [{ data: { skill: 'load-project-brief', projectId: 'project_abc' } }],
  });
  assert.strictEqual(skill, 'load-project-brief');
  assert.strictEqual(input.projectId, 'project_abc');
});

test('text and data parts combine — data wins on conflict', () => {
  const { skill, input } = a2aRoutes.readMessage({
    role: 'ROLE_USER',
    parts: [
      { text: 'shipped the auth migration' },
      { data: { skill: 'record-memory-update', projectId: 'project_abc' } },
    ],
  });
  assert.strictEqual(skill, 'record-memory-update');
  assert.strictEqual(input.summary, 'shipped the auth migration');
  assert.strictEqual(input.projectId, 'project_abc');
});

test('an empty or unknown-skill message is rejected as InvalidParams', () => {
  for (const message of [
    null,
    { role: 'ROLE_USER', parts: [] },
    { role: 'ROLE_USER', parts: [{ data: { skill: 'delete-everything' } }] },
  ]) {
    assert.throws(
      () => a2aRoutes.readMessage(message),
      (err) => err instanceof a2aRoutes.RpcError && err.code === -32602,
      `expected -32602 for ${JSON.stringify(message)}`,
    );
  }
});

// ─── Cross-host parity ────────────────────────────────────────────────────────

test('the marketing copy of the card matches this one', () => {
  const marketing = fs.readFileSync(
    path.join(repoRoot, 'apps/marketing/src/lib/agentDiscovery.ts'),
    'utf8',
  );
  const card = buildAgentCard();

  assert.ok(marketing.includes(card.description), 'card description drifted');
  assert.ok(marketing.includes(`A2A_AGENT_VERSION = '${card.version}'`), 'card version drifted');
  assert.ok(
    marketing.includes(`A2A_PROTOCOL_VERSION = '${card.supportedInterfaces[0].protocolVersion}'`),
    'protocol version drifted',
  );
  assert.ok(marketing.includes(`protocolBinding: '${card.supportedInterfaces[0].protocolBinding}'`));
  assert.ok(marketing.includes(A2A_BASE_PATH), 'A2A endpoint path drifted');

  for (const skill of card.skills) {
    assert.ok(marketing.includes(`id: '${skill.id}'`), `skill ${skill.id} missing from marketing card`);
    assert.ok(marketing.includes(skill.name), `skill name for ${skill.id} drifted`);
    assert.ok(marketing.includes(skill.description), `skill description for ${skill.id} drifted`);
  }
}, { requires: ['apps/marketing'] });

test('the marketing site serves the card at the well-known URI', () => {
  const route = path.join(repoRoot, 'apps/marketing/src/pages/.well-known/agent-card.json.ts');
  assert.ok(fs.existsSync(route), 'apex host must serve /.well-known/agent-card.json');
  const source = fs.readFileSync(route, 'utf8');
  assert.ok(source.includes('buildA2aAgentCard'));
  assert.ok(source.includes('application/json'));
}, { requires: ['apps/marketing'] });

// ─── Runner ───────────────────────────────────────────────────────────────────

(async () => {
  let failed = 0;
  for (const [name, fn, skip] of tests) {
    if (skip) {
      console.log(`  - ${name} (skipped: ${skip})`);
      continue;
    }
    try {
      await fn();
      console.log(`  ✓ ${name}`);
    } catch (err) {
      failed += 1;
      console.error(`  ✗ ${name}\n    ${err.message}`);
    }
  }
  console.log(failed ? `\n${failed} failing` : `\n${tests.length} passing`);
  process.exit(failed ? 1 : 0);
})();
