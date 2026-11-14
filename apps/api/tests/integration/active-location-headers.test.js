process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

// Where the caller is (cwd, host, repo workspace key) used to reach these GETs
// only as query parameters, and a query string is the part of a request every
// hop writes to its access log. The MCP client now sends them as URI-encoded
// headers. This pins both halves of that contract:
//   - the headers resolve the project exactly as the query parameters did;
//   - the query parameters STILL work, because every installed client sends them.
//
// Run: bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/active-location-headers.test.js

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('../helpers/runtimeSchema');

const systemKey = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', systemKey);

test('location headers on the context GETs', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'location headers')) return;
  if (!await ensureDatabaseAvailable(t, db, 'location headers')) return;
  await ensureRuntimeSchema();
  await store.clearAll();

  const repoPath = '/tmp/dd-location-héaders/répo';
  let locatedId;
  let decoyId;

  await t.test('setup: a project linked to a path, and a NEWER decoy that recency would pick', async () => {
    const located = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'Located By Header',
      description: 'Resolved from the working directory.',
      linked_paths: [repoPath],
    });
    assert.strictEqual(located.status, 201, JSON.stringify(located.body));
    locatedId = located.body.project.project_id;

    const decoy = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'Recency Decoy',
      description: 'More recent, linked to nothing.',
    });
    assert.strictEqual(decoy.status, 201, JSON.stringify(decoy.body));
    decoyId = decoy.body.project.project_id;
    assert.notStrictEqual(locatedId, decoyId);
  });

  await t.test('/active resolves the project from x-deerdawn-cwd with NO cwd in the URL', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/active'))
      .set('x-deerdawn-cwd', encodeURIComponent(`${repoPath}/src`))
      .query({ format: 'json' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.context?.project_id, locatedId, 'the header cwd did not select the linked project');
    assert.strictEqual(res.headers['x-deerdawn-location'], 'header', 'a new client cannot tell its headers were read');
  });

  await t.test('an old client sending ?cwd= still resolves, and is not told "header"', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/active'))
      .query({ format: 'json', cwd: `${repoPath}/src` });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.context?.project_id, locatedId);
    assert.strictEqual(res.headers['x-deerdawn-location'], undefined);
  });

  await t.test('the header wins when both are sent', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/active'))
      .set('x-deerdawn-cwd', encodeURIComponent(repoPath))
      .query({ format: 'json', cwd: '/somewhere/else/entirely' });
    assert.strictEqual(res.body.context?.project_id, locatedId);
  });

  await t.test('a malformed escape does not fail the request', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/active'))
      .set('x-deerdawn-cwd', '/tmp/100%-broken')
      .query({ format: 'json' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok('context' in res.body);
  });

  await t.test('/map marks the active project from the header', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/map'))
      .set('x-deerdawn-cwd', encodeURIComponent(repoPath))
      .query({ mcp: 'true' });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.active_project_id, locatedId);
  });

  await t.test('x-deerdawn-host reaches the session row on a marked start', async () => {
    const sessionId = 'location-header-session-1';
    const res = await auth(request(httpServer).get('/api/v1/context/active'))
      .set('x-deerdawn-cwd', encodeURIComponent(repoPath))
      .set('x-deerdawn-host', encodeURIComponent('jane-macbook.local'))
      .query({ tool: 'claude_code', mark_session: 1, session_id: sessionId });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const sessions = await auth(request(httpServer).get('/api/v1/context/sessions'));
    const mine = (sessions.body.sessions || []).find((s) => s.session_id === sessionId);
    assert.ok(mine, 'the marked session was not recorded');
    assert.strictEqual(mine.host, 'jane-macbook.local');
  });

  await closeRedisConnections();
  await db.pool.end();
});
