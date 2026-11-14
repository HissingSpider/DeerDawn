/**
 * JOURNEY R1 / S2 — A PERSON LOOKING AT THE BRIEF IS NOT A TOOL READING IT.
 *
 * A new user writes a first brief in onboarding, connects nothing, opens
 * /projects and expands "What your AI reads next session". The dashboard asks
 * GET /projects/:id/inject?tool=claude_code for that preview, and the route
 * rendered it with every side effect of a real delivery switched on:
 * context_delivered, first_sync_completed (mirrored to an ad platform as an
 * activation) and connection_established for claude_code, plus a retrieval hit
 * on every graph node shown and an affinity between related projects. Today
 * then read "No tool has called in for 30 days" on a three-minute-old account.
 * GET /active did the same.
 *
 * Who asked is decided by how the request authenticated, never by a parameter:
 * a person's interactive session is an actor of type 'user'; every tool (the
 * local server, its hooks, the userscript) sends an API key. The tool path is
 * pinned below as the control, so this cannot pass by recording nothing at all.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r1-preview-side-effects.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
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
  return { orgId, userId, email, jwt, key };
}

// The dashboard: a person's session token.
const asPerson = (method, path, person) => request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
// A tool: the API key the local server and its hooks send.
const asTool = (method, path, person) => request(httpServer)[method](path).set('X-Api-Key', person.key);

const RECORDED = ['context_delivered', 'first_sync_completed', 'connection_established'];

async function events(person) {
  const res = await q(
    'SELECT event_name, COUNT(*)::int AS n FROM product_events WHERE (user_id = $1 OR org_id = $2) AND event_name = ANY($3) GROUP BY event_name',
    [person.userId, person.orgId, RECORDED],
  );
  return Object.fromEntries(res.rows.map((r) => [r.event_name, r.n]));
}

async function retrievalHits(person) {
  const res = await q(
    'SELECT COALESCE(SUM((metadata->>\'retrieval_hits\')::int), 0)::int AS n FROM context_graph_nodes WHERE owner_key = $1',
    [person.orgId],
  );
  return res.rows[0].n;
}

async function affinities(person) {
  const res = await q('SELECT COALESCE(SUM(co_occurrence_count), 0)::int AS n FROM context_project_affinity WHERE owner_key = $1', [person.orgId]);
  return res.rows[0].n;
}

async function sessionTraces(person) {
  const loads = await q('SELECT COUNT(*)::int AS n FROM context_session_loads WHERE owner_key = $1', [person.orgId]);
  const sessions = await q('SELECT COUNT(*)::int AS n FROM context_sessions WHERE owner_key = $1', [person.orgId]);
  return { loads: loads.rows[0].n, sessions: sessions.rows[0].n };
}

// Fire-and-forget emitters land after the response. An absence is only proven
// by waiting out the window a presence would have needed.
const settle = () => new Promise((resolve) => setTimeout(resolve, 1500));
async function waitFor(check, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * A three-minute-old account: two projects written from the dashboard, each
 * recording the same decision (so a render has graph nodes to reinforce and a
 * related project to strengthen an affinity with), and no tool connected.
 * Nothing here renders a brief, so nothing here records a delivery.
 */
async function freshAccount() {
  const P = await makePerson('fresh');
  const tag = uuidv4().slice(0, 8);
  const ids = [];
  for (const name of [`walk-g ${tag}`, `walk-h ${tag}`]) {
    const made = await asPerson('post', '/api/v1/context/projects', P).send({ project_name: name, current_task: 'Checking what the dashboard claims' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const projectId = made.body.project.project_id;
    ids.push(projectId);
    const line = `Decided to keep the ledger in Postgres ${tag}`;
    const res = await asPerson('post', '/api/v1/context/extraction', P).send({
      session_id: `onboarding-${uuidv4()}`,
      tool: 'claude_web',
      project_id: projectId,
      chunks: [{ role: 'user', text: line }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.9,
        project_candidate: { project_id: projectId, project_name: name },
        delta: { recent_decisions: [{ summary: line, decided_at: new Date().toISOString() }] },
        should_create_project: false,
        needs_user_confirmation: false,
        no_material_change: false,
      },
    });
    assert.equal(res.status, 202, `first brief: ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`);
  }
  return { P, projectId: ids[0], otherId: ids[1] };
}

test('S2: the dashboard\'s brief preview records no delivery, first sync, connection, retrieval hit or affinity', async () => {
  const { P, projectId } = await freshAccount();
  const hitsBefore = await retrievalHits(P);
  const affinityBefore = await affinities(P);

  for (const tool of ['claude_code', 'cursor', 'chatgpt_web']) {
    const res = await asPerson('get', `/api/v1/context/projects/${projectId}/inject?tool=${tool}&verbosity=standard`, P);
    assert.equal(res.status, 200, `${tool}: ${res.status} ${JSON.stringify(res.body)}`);
    assert.ok(res.body.payload?.body, 'the preview still renders the brief');
  }
  await settle();

  assert.deepEqual(await events(P), {}, 'THE BUG: previewing the brief in the dashboard recorded a tool delivery / first sync / connection');
  assert.equal(await retrievalHits(P), hitsBefore, 'a person reading the preview is not a retrieval by a tool');
  assert.equal(await affinities(P), affinityBefore, 'nor a co-occurrence of projects in a session');
});

test('S2: /active read by a person records nothing either, whatever parameters it carries', async () => {
  const { P } = await freshAccount();
  const hitsBefore = await retrievalHits(P);
  const tracesBefore = await sessionTraces(P);

  const plain = await asPerson('get', '/api/v1/context/active?tool=claude_code', P);
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.ok(plain.body.brief, 'the brief still renders');
  // A person's request cannot opt itself into a tool's session accounting by
  // adding the parameters a tool sends.
  const marked = await asPerson('get', `/api/v1/context/active?tool=claude_code&mark_session=1&session_id=sess-${uuidv4()}`, P);
  assert.equal(marked.status, 200, JSON.stringify(marked.body));
  await settle();

  assert.deepEqual(await events(P), {}, 'THE BUG: /active read from the dashboard recorded a tool delivery / first sync / connection');
  assert.equal(await retrievalHits(P), hitsBefore);
  assert.deepEqual(await sessionTraces(P), tracesBefore, 'no session load and no tool session row for a person\'s read');
});

test('S2 control: the same routes called by a TOOL still record exactly as before', async () => {
  const { P, projectId } = await freshAccount();
  const hitsBefore = await retrievalHits(P);

  const res = await asTool('get', `/api/v1/context/projects/${projectId}/inject?tool=claude_code&verbosity=standard`, P);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const recorded = await waitFor(async () => {
    const counts = await events(P);
    return RECORDED.every((name) => (counts[name] || 0) > 0);
  });
  assert.ok(recorded, `a tool's render records the delivery, first sync and connection: ${JSON.stringify(await events(P))}`);
  assert.ok(await waitFor(async () => (await retrievalHits(P)) > hitsBefore), 'and reinforces the nodes it delivered');
  assert.ok(await waitFor(async () => (await affinities(P)) > 0), 'and strengthens the affinity with the related project');

  const tracesBefore = await sessionTraces(P);
  const active = await asTool('get', `/api/v1/context/active?tool=claude_code&mark_session=1&session_id=sess-${uuidv4()}`, P);
  assert.equal(active.status, 200, JSON.stringify(active.body));
  const after = await sessionTraces(P);
  assert.ok(after.loads > tracesBefore.loads, 'a tool\'s marked session start is still counted');
  assert.ok(after.sessions > tracesBefore.sessions, 'and its session row is still recorded');
});
