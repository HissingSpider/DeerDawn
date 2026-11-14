'use strict';

// The BUILT server's writes, validated by the API's REAL route.
//
// 1.0.54-pre (#523) changed getAgentSessionContext() to return `host: null`
// and every local write carried it in session_context. The API's
// ExtractionRouteInputSchema says `host: z.string().optional()`: an absent key
// passes, a null one is `400 invalid_payload`, which the client maps to a bare
// "-32602 Invalid request parameters". So EVERY manage_memory update with a
// summary failed, and import_local's seeding left an empty project behind.
//
// It shipped green because every test of the write path ran against a stub
// API that accepted any body. This file does not stub validation: it mounts
// the real `apps/api/src/routes/context/context-sync.js` router — the real zod
// schemas, the real handler up to the service call — and replaces only what
// needs a database or a network: the auth middleware (it would look the key up
// in Postgres), the rate limiter, and the three service functions the
// extraction handler hands a VALID payload to. Everything else the server asks
// for (the brief, the map, telemetry) is answered by a small stub in front of
// the router, because it is not what this file pins.
//
// Runs under `npm run test:node`, after the build. The API's dependencies are
// present wherever this package's tests run: CI does a root `npm ci`, which
// installs every workspace.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
// No home-like variable from the developer's shell reaches this file or the
// servers it starts: see ../../shared-context/tests/contain-home.cjs.
require('../../shared-context/tests/contain-home.cjs').containTestProcess(require('node:test').after);

const PKG = path.resolve(__dirname, '..');
const DIST = path.join(PKG, 'dist', 'index.js');
const API_SRC = path.resolve(PKG, '..', '..', 'apps', 'api', 'src');
const { Client } = require(require.resolve('@modelcontextprotocol/sdk/client/index.js', { paths: [PKG] }));
const { StdioClientTransport } = require(require.resolve('@modelcontextprotocol/sdk/client/stdio.js', { paths: [PKG] }));

const PROJECT_ID = 'project_real_route_pin';

// ── The real router, with only its database-bound collaborators replaced ──────
// Loaded before anything else touches the API tree so the cache entries win.
process.env.DISABLE_REDIS = 'true';
// The audit line the handler writes must never reach a real database from a
// developer's shell: point the pool at a port nothing listens on.
process.env.DATABASE_URL = 'postgres://pin:pin@127.0.0.1:1/real_route_pin';
function preload(rel, exports) {
  const file = require.resolve(path.join(API_SRC, rel));
  require.cache[file] = { id: file, filename: file, loaded: true, exports };
}
const passThrough = (_req, _res, next) => next();
preload('middleware/auth', {
  requireAuth: (req, _res, next) => {
    req.actor = { id: 'user_pin', org_id: 'org_pin', workspace_key: 'org_pin', scopes: ['context:write'] };
    next();
  },
  requireAnyScope: () => passThrough,
});
preload('middleware/rateLimit', new Proxy({}, { get: () => passThrough }));

// What the handler handed on — i.e. what PASSED validation.
const accepted = [];
const service = require(path.join(API_SRC, 'services', 'contextSyncService'));
const extractionService = require(path.join(API_SRC, 'services', 'extractionService'));
const storedProject = () => ({ project_id: PROJECT_ID, name: 'Real Route Pin', context: { current_task: 'Pin the write path' } });
service.recordExplicitUpdate = async (_actor, data) => {
  accepted.push({ kind: 'explicit', data });
  return { project: storedProject(), session: null, extraction: null, graph: null, stored: true };
};
service.applyExtraction = async (_actor, data) => {
  accepted.push({ kind: 'extraction', data });
  return { project: storedProject(), session: null, graph: null };
};
extractionService.runExtraction = async () => ({
  match_decision: 'matched_existing', confidence: 1, delta: {}, should_create_project: false, needs_user_confirmation: false,
});
const contextRouter = require(path.join(API_SRC, 'routes', 'context', 'context-sync.js'));
const express = require(require.resolve('express', { paths: [API_SRC] }));

/** Every request the server made, and what the API answered. */
const seen = [];

function startApi() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, res, next) => {
    const entry = { method: req.method, path: req.path, body: req.body };
    seen.push(entry);
    res.on('finish', () => { entry.status = res.statusCode; });
    // The routes under test go to the REAL router.
    if (req.method === 'POST' && req.path === '/api/v1/context/extraction') return next();
    if (req.path === '/api/v1/context/active') {
      return res.json({
        brief: 'Current task: pin the write path.',
        project_name: 'Real Route Pin',
        project_id: PROJECT_ID,
        last_updated: new Date().toISOString(),
      });
    }
    if (req.path === '/api/v1/context/map') {
      return res.json({ map: `[DeerDawn - 1 project]\nReal Route Pin (${PROJECT_ID})`, project_count: 1 });
    }
    if (req.method === 'POST' && req.path === '/api/v1/context/projects') {
      return res.json({ project: { project_id: PROJECT_ID, project_name: 'Real Route Pin', parent_project_id: null } });
    }
    return res.json({ ok: true, results: [], projects: [], todos: [], cards: [], skills: [] });
  });
  app.use('/api/v1/context', contextRouter);
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(done); }),
    }));
  });
}

async function connect(api, cwd, home) {
  const client = new Client({ name: 'real-route-pin', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [DIST],
    cwd,
    env: {
      PATH: process.env.PATH,
      HOME: home,
      USERPROFILE: home,
      DEERDAWN_API_URL: api.url,
      DEERDAWN_API_KEY: `dd_real_route_${'a'.repeat(32)}`,
      CLAUDE_PROJECT_DIR: cwd,
      DEERDAWN_CAPTURE: 'off',
    },
    stderr: 'pipe',
  }));
  return client;
}

const textOf = (result) => (result.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const extractionCalls = () => seen.filter((r) => r.method === 'POST' && r.path === '/api/v1/context/extraction');

test('the real route refuses a null host — the premise this file pins', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const res = await fetch(`${api.url}/api/v1/context/extraction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: 'agent-premise', tool: 'claude_code', project_id: PROJECT_ID, explicit: true,
      session_context: { cwd: '/r', host: null, status: 'active' },
      chunks: [{ role: 'assistant', text: 'premise' }],
    }),
  });
  // If the API starts accepting null this is no longer the regression's
  // shape — the client must STILL omit the key (asserted below), but this
  // line says the guard is now belt without braces.
  if (res.status === 202) t.diagnostic('the API now accepts host:null; the client-side omission is still pinned below');
  else assert.equal(res.status, 400, 'a null host should have been refused by the real schema');
});

test('manage_memory update with a summary is accepted by the real /extraction route', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-realroute-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-realroute-cwd-'));
  const client = await connect(api, cwd, home);
  t.after(() => client.close());

  await client.callTool({ name: 'start_session', arguments: {} });
  const before = extractionCalls().length;
  const result = await client.callTool({
    name: 'manage_memory',
    arguments: { action: 'update', project_id: PROJECT_ID, summary: 'Chose Postgres advisory locks for the widget queue.' },
  });

  const sent = extractionCalls().slice(before);
  assert.equal(sent.length, 1, `expected one extraction write, saw ${sent.length}`);
  const ctx = sent[0].body.session_context;
  assert.ok(ctx && typeof ctx === 'object', 'session_context missing from the write');
  assert.equal('host' in ctx, false, `session_context carries a host key: ${JSON.stringify(ctx)}`);
  for (const [key, value] of Object.entries(ctx)) assert.notEqual(value, null, `session_context.${key} is null`);
  assert.equal(sent[0].status, 202, `the real route refused the write: ${JSON.stringify(sent[0].body)}`);
  assert.ok(!result.isError, `manage_memory update failed: ${textOf(result)}`);
  assert.ok(accepted.some((a) => a.kind === 'explicit' && /advisory locks/.test(a.data.summary)), 'the summary never reached the service');
});

test('import_local seeding sends a body the real /extraction route accepts', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-realroute-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-realroute-cwd-'));
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), [
    '# Widget service',
    '',
    'The widget service parses incoming widget payloads, validates them against the',
    'registry, and queues them for the render workers. Retries are capped at five and',
    'the queue uses Postgres advisory locks so two workers never render the same widget.',
    '',
  ].join('\n'));
  const client = await connect(api, cwd, home);
  t.after(() => client.close());

  await client.callTool({ name: 'start_session', arguments: {} });
  const before = extractionCalls().length;
  const result = await client.callTool({ name: 'manage_memory', arguments: { action: 'import_local', confirmed: true } });

  const sent = extractionCalls().slice(before);
  assert.ok(sent.length >= 1, `import_local sent no extraction write: ${textOf(result)}`);
  for (const call of sent) {
    assert.equal('host' in (call.body.session_context || {}), false, 'import seeding carries a host key');
    assert.equal(call.status, 202, `the real route refused the import seeding: ${JSON.stringify(call.body.session_context)}`);
  }
  assert.ok(!result.isError, `import_local failed: ${textOf(result)}`);
});

test('the Stop hook body is accepted by the real /extraction route', async (t) => {
  const api = await startApi();
  t.after(() => api.close());
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-realroute-home-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'deerdawn-realroute-cwd-'));
  const transcript = path.join(home, 'session.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'Add trailing comma support to the widget tokenizer and keep it single-pass.' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Added trailing comma support in src/parser/widget.ts and wrote three tests.' }] } },
  ].map((line) => JSON.stringify(line)).join('\n') + '\n');

  const before = extractionCalls().length;
  const exit = await new Promise((resolve) => {
    const child = spawn(process.execPath, [DIST, 'flush-session'], {
      cwd,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, DEERDAWN_API_URL: api.url, DEERDAWN_API_KEY: `dd_real_route_${'b'.repeat(32)}`, CLAUDE_PROJECT_DIR: cwd },
    });
    child.stdin.end(JSON.stringify({ session_id: 'sess-real-route', transcript_path: transcript, cwd, hook_event_name: 'Stop' }));
    child.on('close', resolve);
  });
  assert.equal(exit, 0);
  const sent = extractionCalls().slice(before);
  assert.equal(sent.length, 1, 'the hook sent nothing');
  assert.equal(sent[0].status, 202, `the real route refused the hook body: ${JSON.stringify(sent[0].body.session_context)}`);
});
