process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

// The route the local DeerDawn server's start_session reads (GET /active with
// mark_session=1). When it answers recently_loaded:true, that server replies
// "Context already loaded moments ago via your other DeerDawn connection - not
// repeating it." and sends no task and no decisions. So this is where a second
// LOCAL tool opening the same project lost its brief: Claude Code, then Cursor
// 20 seconds later, and Cursor was told it already had what it never had.
//
// And the other side of the same line: ONE local process calling start_session
// twice inside the window (the model calls it again, or a hook and the tool
// both load) does already have the brief, and is told so. The route passes the
// process's own session id (the local server sends a per-process
// `agent-<pid>-<hex>` as session_id on every /active call) so the dedup can
// tell that process from another one.
//
// Run: bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/active-dedup-local-surfaces.test.js

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('../helpers/runtimeSchema');

const systemKey = process.env.DEERDAWN_API_KEY || 'dev-key';
const auth = (req) => req.set('X-Api-Key', systemKey);
const RUN = crypto.randomBytes(4).toString('hex');
const created = [];
const orgs = [];
const q = (sql, params) => db.query(sql, params, 'org-system');

async function linkedProject(label) {
  const repoPath = `/tmp/dd-dedup-${label}-${RUN}`;
  const res = await auth(request(httpServer).post('/api/v1/context/projects')).send({
    project_name: `Dedup ${label} ${RUN}`,
    current_task: `Ship the ${label} exporter`,
    linked_paths: [repoPath],
  });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  created.push(res.body.project.project_id);
  return { projectId: res.body.project.project_id, repoPath };
}

const processId = (tool) => `agent-${tool}-${crypto.randomBytes(3).toString('hex')}`;

// `sessionId` is the calling process's id; a fresh one per call is a new process.
function startSession(repoPath, tool, sessionId = processId(tool)) {
  return auth(request(httpServer).get('/api/v1/context/active'))
    .set('x-deerdawn-cwd', encodeURIComponent(repoPath))
    .query({ tool, mark_session: 1, ...(sessionId ? { session_id: sessionId } : {}) });
}

// One person with both a dashboard session (JWT) and an API key, the shape the
// auth middleware mints for each.
async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  orgs.push(orgId);
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'free', 'free', 'active'],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { orgId, userId, jwt, key };
}

test('start_session dedup across tools on GET /active', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'active dedup surfaces')) return;
  if (!await ensureDatabaseAvailable(t, db, 'active dedup surfaces')) return;
  await ensureRuntimeSchema();

  await t.test('Claude Code, then Cursor on the same project: Cursor gets its brief', async () => {
    const { projectId, repoPath } = await linkedProject('local-pair');
    const first = await startSession(repoPath, 'claude_code');
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.project_id, projectId);
    assert.strictEqual(first.body.recently_loaded, false);

    const second = await startSession(repoPath, 'cursor');
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.project_id, projectId);
    assert.strictEqual(second.body.recently_loaded, false, 'Cursor was told the brief Claude Code loaded was already in its own context');
    assert.ok(String(second.body.brief || '').includes('local-pair exporter'), 'the brief itself carries the task');
  });

  await t.test('a second Claude Code process is a second session too', async () => {
    const { repoPath } = await linkedProject('two-terminals');
    await startSession(repoPath, 'claude_code');
    const second = await startSession(repoPath, 'claude_code');
    assert.strictEqual(second.body.recently_loaded, false);
  });

  await t.test('the same process calling start_session twice is told it already has the brief', async () => {
    const { repoPath } = await linkedProject('same-process');
    const me = processId('claude_code');
    const first = await startSession(repoPath, 'claude_code', me);
    assert.strictEqual(first.body.recently_loaded, false);
    const again = await startSession(repoPath, 'claude_code', me);
    assert.strictEqual(again.body.recently_loaded, true, 'the same process was handed the brief a second time and booked a second session');
    assert.strictEqual(again.body.recently_loaded_other_surface, null, 'it is not "your other DeerDawn connection"');
    assert.strictEqual(again.body.catchup ?? null, null, 'a repeat load is not a second session');
  });

  await t.test('a load that does not say which process it is never counts as the same process', async () => {
    const { repoPath } = await linkedProject('no-process-id');
    await startSession(repoPath, 'claude_code', null);
    const second = await startSession(repoPath, 'claude_code', null);
    assert.strictEqual(second.body.recently_loaded, false);
  });

  await t.test('a hosted load beside a local one still dedups, and says so', async () => {
    const { repoPath } = await linkedProject('mixed');
    // The route's `tool` is the rendering profile; claude_web is what a hosted
    // connection records on the same marker (routes/mcp.js detectWebSurface).
    await startSession(repoPath, 'claude_web');
    const local = await startSession(repoPath, 'claude_code');
    assert.strictEqual(local.body.recently_loaded, true);
    assert.strictEqual(local.body.recently_loaded_other_surface, 'claude_web');
  });

  await t.test('a person\'s dashboard read marks nothing and is never a duplicate', async () => {
    const person = await makePerson('dedup-dashboard');
    const repoPath = `/tmp/dd-dedup-person-${RUN}`;
    const createdByTool = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', person.key)
      .send({ project_name: `Person Dedup ${RUN}`, current_task: 'Ship the person exporter', linked_paths: [repoPath] });
    assert.strictEqual(createdByTool.status, 201, JSON.stringify(createdByTool.body));
    // As a HOSTED surface on purpose: had the read marked, the tool load below
    // would be a hosted + local pair, which is a duplicate.
    const read = (sessionId) => request(httpServer).get('/api/v1/context/active')
      .set('Authorization', `Bearer ${person.jwt}`)
      .set('x-deerdawn-cwd', encodeURIComponent(repoPath))
      .query({ tool: 'claude_web', mark_session: 1, session_id: sessionId });
    const sameTab = `dash-${RUN}`;
    const firstRead = await read(sameTab);
    assert.strictEqual(firstRead.status, 200, JSON.stringify(firstRead.body));
    assert.strictEqual(firstRead.body.recently_loaded, false);
    const secondRead = await read(sameTab);
    assert.strictEqual(secondRead.body.recently_loaded, false, 'a person reading twice is not a duplicate load');

    const tool = await request(httpServer).get('/api/v1/context/active').set('X-Api-Key', person.key)
      .set('x-deerdawn-cwd', encodeURIComponent(repoPath))
      .query({ tool: 'claude_code', mark_session: 1, session_id: processId('claude_code') });
    assert.strictEqual(tool.status, 200, JSON.stringify(tool.body));
    assert.strictEqual(tool.body.recently_loaded, false, 'the dashboard read left a marker the tool then tripped on');
  });

  await t.test('cleanup', async () => {
    for (const projectId of created) {
      await q('DELETE FROM context_sessions WHERE project_id = $1', [projectId]).catch(() => {});
      await q('DELETE FROM context_events WHERE project_id = $1', [projectId]).catch(() => {});
      await q('DELETE FROM context_projects WHERE project_id = $1', [projectId]).catch(() => {});
    }
    for (const orgId of orgs) {
      await q('DELETE FROM context_session_loads WHERE owner_key = $1', [orgId]).catch(() => {});
      await q('DELETE FROM context_sessions WHERE owner_key = $1', [orgId]).catch(() => {});
      await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId]).catch(() => {});
      await q('DELETE FROM context_projects WHERE owner_key = $1', [orgId]).catch(() => {});
      await q('DELETE FROM api_keys WHERE org_id = $1', [orgId]).catch(() => {});
      await q('DELETE FROM workspace_members WHERE owner_key = $1', [orgId]).catch(() => {});
    }
  });

  await closeRedisConnections();
  await db.pool.end();
});
