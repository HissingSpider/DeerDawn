/**
 * SCAN 35. What one person's workspace built, judged when a second arrives.
 *
 *   U1. The first invite SPLITS every node homed in one of the founder's
 *       projects that another of their projects' rebuilds landed on while the
 *       workspace was theirs alone: the other project gets its own
 *       `<key>::in.<project>` copy (identity only) with its evidence and edges.
 *       Sharing that other project later no longer publishes the first one's
 *       note (b/p110, a/p5), and the founder's own resolve in it hits its own
 *       copy (b/p110b).
 *   U2. Moving a project out of a one-person workspace takes its words with it:
 *       a node it homed that another project there still uses stays behind as
 *       identity only, instead of becoming the other project's writing — which
 *       the next move then carried "words and all" (b/p113). A one-person
 *       destination joins only the moving project's own row or an unmarked
 *       workspace-level one.
 *   U3. A project carried into a workspace nobody else works in drops the
 *       `::in.` mark there, so later plain-key writes find its nodes: no twins,
 *       and a resolve hits the carried decision (a/p1, b/p109b).
 *   U4. A rebuild in one project never re-stamps another project's edge with
 *       its session (a/p6).
 *   U5. The private_to index is built CONCURRENTLY, off the request path.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan35-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
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
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => uuidv4().slice(0, 6);
const today = () => new Date().toISOString();

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function mintKey(person, orgId) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.ok(accepted.ok, accepted.reason);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcpCall(key, ws, name, args) {
  let r = request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  r = await r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function share(person, ws, projectId, body) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

async function move(person, fromWs, projectId, toWs) {
  const res = await as('post', `/api/v1/teams/projects/${projectId}/move`, person, fromWs).send({ workspace: toWs });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
}

const upsert = (key, ws, args) => mcpCall(key, ws, 'manage_memory', { action: 'upsert_entities', ...args });
const recall = (key, ws, query) => mcpCall(key, ws, 'recall', { action: 'entities', query });

// The non-explicit POST /extraction every end-of-session flush makes: the delta
// is applied and the project's graph is rebuilt from its whole stored context.
async function flush(person, ws, projectId, delta, sessionId = `sess-${uuidv4()}`) {
  const res = await as('post', '/api/v1/context/extraction', person, ws).send({
    session_id: sessionId,
    tool: 'claude_code',
    project_id: projectId,
    chunk: { role: 'user', text: 'status update' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  await wait(300);
  return res;
}

// Non-sighting evidence from `inProject` on a node homed in `homeProject`.
const evidenceCrossing = async (ownerKey, homeProject, inProject) => (await q(
  `SELECT n.canonical_key FROM context_graph_evidence e JOIN context_graph_nodes n ON n.node_id = e.node_id
    WHERE e.owner_key = $1 AND n.project_id = $2 AND e.project_id = $3
      AND COALESCE(e.metadata->>'kind', '') <> 'sighting'`,
  [ownerKey, homeProject, inProject],
)).rows;

const nodesTitled = async (ownerKey, marker) => (await q(
  `SELECT node_id, node_type, canonical_key, project_id, summary, metadata->>'status' AS status,
          (SELECT COUNT(*) FROM context_graph_evidence e WHERE e.owner_key = n.owner_key AND e.node_id = n.node_id)::int AS evidence
     FROM context_graph_nodes n
    WHERE owner_key = $1 AND title ILIKE $2 AND node_type <> 'project'
    ORDER BY canonical_key`,
  [ownerKey, `%${marker}%`],
)).rows;

// ── U1. The first invite splits the founder's solo-era shared nodes ─────────

// A solo founder whose second project's flush lands on the first one's node.
async function soloFounderTwoProjects(label, { firstName, secondName }) {
  const F = await makePerson(label, { plan: 'developer_pro' });
  const fkey = await mintKey(F, F.orgId);
  const mk = tag();
  const A = await newProject(F, `${firstName}${mk}`);
  const B = await newProject(F, `${secondName}${mk}`);
  const D = `Decided to move billing to Paddle${mk}.`;
  const saved = await upsert(fkey, F.orgId, { project_id: A, entities: [
    { entity_type: 'decision', title: D, summary: `PRIVNOTE${mk}: because I am interviewing at Paddle next week.` },
    { entity_type: 'service', title: `Paddle${mk}`, summary: `PRIVSVC${mk}: my recruiter contact is there.` },
  ] });
  assert.equal(saved.err, false, saved.text);
  await flush(F, F.orgId, B, { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Paddle${mk}`], current_task: 'Wire Paddle webhooks' });
  // Precondition: the solo era landed B on A's nodes (one node each, plain key).
  assert.ok((await evidenceCrossing(F.orgId, A, B)).length >= 2, 'precondition: B\'s rebuild landed on A\'s nodes');
  return { F, fkey, mk, A, B, D };
}

test('U1 (b/p110): the founder shares the second of two solo-era projects: the first one\'s note stays theirs', async () => {
  const { F, fkey, mk, A, B } = await soloFounderTwoProjects('s35p110f', { firstName: 'JobHunt', secondName: 'Billing' });
  const M = await makePerson('s35p110m');
  await join(F, M);
  const mkey = await mintKey(M, F.orgId);

  await share(F, F.orgId, B, { visibility: 'shared' });
  const secret = new RegExp(`PRIVNOTE${mk}|PRIVSVC${mk}|JobHunt${mk}|${A}`);
  const decision = (await recall(mkey, F.orgId, `Paddle${mk}`)).text;
  assert.match(decision, new RegExp(`Decided to move billing to Paddle${mk}`), 'precondition: the teammate reads B\'s own decision');
  assert.doesNotMatch(decision, secret, decision);
  for (const path of [`/api/v1/context/graph/projects/${B}`, '/api/v1/context/workspace/entities?limit=50', '/api/v1/context/graph/export']) {
    const res = await as('get', path, M, F.orgId);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(JSON.stringify(res.body), secret, path);
  }
  assert.doesNotMatch((await mcpCall(mkey, F.orgId, 'start_session', { project_id: B })).text, secret);

  // The founder's next flush of B lands on B's copies and publishes nothing.
  await flush(F, F.orgId, B, { recent_decisions: [{ summary: `Decided to move billing to Paddle${mk}.`, decided_at: today() }], tech_stack: [`Paddle${mk}`] });
  assert.doesNotMatch((await recall(mkey, F.orgId, `Paddle${mk}`)).text, secret);
  // And the founder still reads their own note, where they wrote it.
  assert.match((await recall(fkey, F.orgId, `Paddle${mk}`)).text, new RegExp(`PRIVNOTE${mk}`));
  assert.deepEqual(await evidenceCrossing(F.orgId, A, B), [], 'B\'s evidence is on B\'s own copies');
});

test('U1 (a/p5): after the invite, sharing the second project serves neither the note nor the first project\'s name', async () => {
  const F = await makePerson('s35p5f', { plan: 'developer_pro' });
  const fkey = await mintKey(F, F.orgId);
  const mk = tag();
  const Q = await newProject(F, `SecretQ${mk}`);
  const H = await newProject(F, `PublicH${mk}`);
  const D = `Adopt Postgres${mk} for billing`;
  await flush(F, F.orgId, Q, { tech_stack: [`Stripe${mk}`], recent_decisions: [{ summary: D, decided_at: today() }] });
  const note = await upsert(fkey, F.orgId, { project_id: Q, entities: [{ entity_type: 'decision', title: D, summary: `QNOTE${mk}: this is for my stealth startup` }] });
  assert.equal(note.err, false, note.text);
  await flush(F, F.orgId, H, { tech_stack: [`Stripe${mk}`], recent_decisions: [{ summary: D, decided_at: today() }] });
  const M = await makePerson('s35p5m');
  await join(F, M);
  const mkey = await mintKey(M, F.orgId);
  await share(F, F.orgId, H, { visibility: 'shared' });

  const secret = new RegExp(`QNOTE${mk}|SecretQ${mk}|${Q}`);
  const decision = (await recall(mkey, F.orgId, `Postgres${mk}`)).text;
  assert.match(decision, new RegExp(D), 'precondition: the teammate reads H\'s decision');
  assert.doesNotMatch(decision, secret, decision);
  assert.doesNotMatch((await recall(mkey, F.orgId, `Stripe${mk}`)).text, secret);
  for (const path of [`/api/v1/context/graph/projects/${H}`, `/api/v1/context/projects/${H}/inject`, '/api/v1/context/workspace/entities?limit=50']) {
    const res = await as('get', path, M, F.orgId);
    assert.ok([200, 204].includes(res.status), path);
    assert.doesNotMatch(JSON.stringify(res.body), secret, path);
  }
});

test('U1 (b/p110b): after the split the founder\'s resolve in one project resolves that project\'s decision', async () => {
  const F = await makePerson('s35p110bf', { plan: 'developer_pro' });
  const fkey = await mintKey(F, F.orgId);
  const mk = tag();
  const A = await newProject(F, `Api${mk}`);
  const B = await newProject(F, `Web${mk}`);
  const D = `Decided to use Postgres${mk} for all persistence.`;
  await flush(F, F.orgId, A, { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Pg${mk}`], current_task: 'task A1' });
  await flush(F, F.orgId, B, { recent_decisions: [{ summary: D, decided_at: today() }], tech_stack: [`Pg${mk}`], current_task: 'task B1' });
  const M = await makePerson('s35p110bm');
  await join(F, M);
  await flush(F, F.orgId, B, { recent_decisions: [{ summary: D, decided_at: today() }, { summary: `Decided to ship SSR${mk}.`, decided_at: today() }], tech_stack: [`Pg${mk}`, `Next${mk}`], current_task: 'task B2' });

  const resolved = await mcpCall(fkey, F.orgId, 'manage_memory', { action: 'resolve', title: D, project_id: B });
  assert.match(resolved.text, /Marked resolved/, resolved.text);
  const after = (await nodesTitled(F.orgId, `Postgres${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(after.find((n) => n.project_id === B)?.status, 'resolved', JSON.stringify(after));
  assert.notEqual(after.find((n) => n.project_id === A)?.status, 'resolved', 'A\'s decision is A\'s');

  // B's Knowledge web no longer lists the decision as open through A's node.
  const brief = (await mcpCall(fkey, F.orgId, 'start_session', { project_id: B })).text;
  const web = (brief.match(/Knowledge web:[^\n]*/) || [''])[0];
  assert.doesNotMatch(web, new RegExp(`Postgres${mk} for all`), web);
  const graph = await as('get', `/api/v1/context/graph/projects/${B}`, F, F.orgId);
  const inB = JSON.stringify(graph.body);
  assert.doesNotMatch(inB, new RegExp(A), 'B\'s graph still reaches A\'s node');

  // A keeps its node with its evidence only; B's evidence is on B's own copy.
  assert.deepEqual(await evidenceCrossing(F.orgId, A, B), []);
  const decisions = (await nodesTitled(F.orgId, `Postgres${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(decisions.filter((n) => n.project_id === B).length, 1, JSON.stringify(decisions));
  assert.equal(decisions.filter((n) => n.project_id === A).length, 1, JSON.stringify(decisions));
});

test('U1 (guard): the split is idempotent and leaves workspace-level and project-root nodes alone', async () => {
  const F = await makePerson('s35splitg', { plan: 'developer_pro' });
  const fkey = await mintKey(F, F.orgId);
  const mk = tag();
  const A = await newProject(F, `Alpha${mk}`);
  const B = await newProject(F, `Beta${mk}`);
  await flush(F, F.orgId, A, { tech_stack: [`Kafka${mk}`] });
  await flush(F, F.orgId, B, { tech_stack: [`Kafka${mk}`] });
  const ws = await upsert(fkey, F.orgId, { entities: [{ entity_type: 'decision', title: `Decided to log every Kafka${mk} consumer lag metric`, summary: 'Every consumer group reports lag to the shared Grafana board.', scope: 'workspace' }] });
  assert.equal(ws.err, false, ws.text);
  await flush(F, F.orgId, B, { tech_stack: [`Kafka${mk}`], recent_decisions: [{ summary: `Decided to log every Kafka${mk} consumer lag metric`, decided_at: today() }] });

  const first = await workspace.splitCrossProjectLandings(F.orgId);
  assert.ok(first.nodes_copied >= 1 && first.evidence_repointed >= 1, JSON.stringify(first));
  const again = await workspace.splitCrossProjectLandings(F.orgId);
  assert.deepEqual(again, { nodes_copied: 0, evidence_repointed: 0, edges_repointed: 0, edges_merged: 0 });
  const rule = await nodesTitled(F.orgId, `Decided to log every Kafka${mk} consumer lag metric`);
  assert.equal(rule.length, 1, JSON.stringify(rule));
  assert.equal(rule[0].project_id, null, 'a workspace-level node is not split');
  const kafka = (await nodesTitled(F.orgId, `Kafka${mk}`)).filter((n) => n.node_type !== 'decision');
  assert.deepEqual(kafka.map((n) => n.project_id).sort(), [A, B].sort(), JSON.stringify(kafka));
  // Nothing dangles: every edge of B's still ends on a node of this workspace.
  const dangling = (await q(
    `SELECT COUNT(*)::int AS n FROM context_graph_edges ed
      WHERE ed.owner_key = $1 AND ed.project_id = $2
        AND NOT EXISTS (SELECT 1 FROM context_graph_nodes n WHERE n.owner_key = $1 AND n.node_id = ed.to_node_id)`,
    [F.orgId, B],
  )).rows[0].n;
  assert.equal(dangling, 0);
});

// ── U2. A move out of a one-person workspace takes its words with it ────────

test('U2 (b/p113): a member moves two solo projects in one by one and shares the second: the first one\'s note stays theirs', async () => {
  const O = await makePerson('s35p113o', { plan: 'developer_pro' });
  const M = await makePerson('s35p113m');
  const M2 = await makePerson('s35p113n');
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const W = M.orgId;
  const mhome = await mintKey(M, W);
  const mteam = await mintKey(M, T);
  const m2key = await mintKey(M2, T);
  const mk = tag();
  const A = await newProject(M, `JobHunt${mk}`, W);
  const B = await newProject(M, `Billing${mk}`, W);
  const D = `Decided to move billing to Paddle${mk}.`;
  const saved = await upsert(mhome, W, { project_id: A, entities: [
    { entity_type: 'decision', title: D, summary: `PRIVNOTE${mk}: because I am interviewing at Paddle next week.` },
  ] });
  assert.equal(saved.err, false, saved.text);
  await flush(M, W, B, { recent_decisions: [{ summary: D, decided_at: today() }], current_task: 'Wire Paddle webhooks' });
  assert.ok((await evidenceCrossing(W, A, B)).length >= 1, 'precondition: the solo era landed B on A\'s node');

  await move(M, W, A, T);
  await share(M, T, A, { visibility: 'personal' });
  await move(M, W, B, T);
  await share(M, T, B, { visibility: 'shared' });

  const secret = new RegExp(`PRIVNOTE${mk}|JobHunt${mk}|${A}`);
  const seen = (await recall(m2key, T, `Paddle${mk}`)).text;
  assert.match(seen, new RegExp(`Decided to move billing to Paddle${mk}`), 'precondition: the teammate reads B\'s decision');
  assert.doesNotMatch(seen, secret, seen);
  for (const path of [`/api/v1/context/graph/projects/${B}`, '/api/v1/context/graph/export']) {
    const res = await as('get', path, M2, T);
    assert.equal(res.status, 200, path);
    assert.doesNotMatch(JSON.stringify(res.body), secret, path);
  }
  // SCAN 36 (a/F1, b/p116) CHANGED THIS: nobody can say which project of a
  // one-person workspace wrote a node's words, so they no longer travel with
  // either move. The note stays at home, whole and private to its author, who
  // still reads it there; the team's copies carry none of it.
  assert.doesNotMatch((await recall(mteam, T, `Paddle${mk}`)).text, new RegExp(`PRIVNOTE${mk}`));
  assert.match((await recall(mhome, W, `Paddle${mk}`)).text, new RegExp(`PRIVNOTE${mk}`));
});

test('U2 (a/F1): a project moved into a one-person workspace does not join another project\'s node there', async () => {
  const O = await makePerson('s35f1o', { plan: 'developer_pro' });
  const M = await makePerson('s35f1m');
  await join(O, M);
  const T = O.orgId;
  const W = M.orgId;
  const mk = tag();
  const Q = await newProject(M, `Quiet${mk}`, W);
  await flush(M, W, Q, { tech_stack: [`Redis${mk}`] });
  const P = await newProject(M, `Side${mk}`, T);
  await share(M, T, P, { visibility: 'personal' });
  await flush(M, T, P, { tech_stack: [`Redis${mk}`] });

  await move(M, T, P, W);
  assert.deepEqual(await evidenceCrossing(W, Q, P), [], 'P\'s evidence joined Q\'s node');
  const redis = await nodesTitled(W, `Redis${mk}`);
  assert.deepEqual(redis.map((n) => n.project_id).sort(), [P, Q].sort(), JSON.stringify(redis));
});

// ── U3. A carry into a one-person workspace drops the scope mark ────────────

test('U3 (a/p1, b/p109b): a personal project carried home keeps one node per entity, and a resolve hits it', async () => {
  const O = await makePerson('s35p1o', { plan: 'developer_pro' });
  const M = await makePerson('s35p1m');
  await join(O, M);
  const T = O.orgId;
  const mk = tag();
  const D = `Decided to use UUID${mk} primary keys everywhere.`;
  const OP = await newProject(O, `TeamApi${mk}`, T);
  await flush(O, T, OP, { tech_stack: [`Pg${mk}`], recent_decisions: [{ summary: D, decided_at: today() }] });
  const MP = await newProject(M, `SideThing${mk}`, T);
  await share(M, T, MP, { visibility: 'personal' });
  await flush(M, T, MP, { tech_stack: [`Pg${mk}`], recent_decisions: [{ summary: D, decided_at: today() }] });
  assert.ok((await nodesTitled(T, `Pg${mk}`)).some((n) => n.canonical_key.includes('::in.')), 'precondition: M\'s project has its own scoped copies in the team');

  const left = await as('delete', `/api/v1/teams/members/${M.userId}`, M, T);
  assert.equal(left.status, 200, JSON.stringify(left.body).slice(0, 300));
  const home = await mintKey(M, M.orgId);
  await flush(M, M.orgId, MP, { tech_stack: [`Pg${mk}`, `Kafka${mk}`], current_task: 'after leaving', recent_decisions: [{ summary: D, decided_at: today() }] });

  const pg = (await nodesTitled(M.orgId, `Pg${mk}`)).filter((n) => n.node_type !== 'decision');
  assert.equal(pg.length, 1, JSON.stringify(pg));
  assert.doesNotMatch(pg[0].canonical_key, /::in\./);
  const listed = (await recall(home, M.orgId, `Pg${mk}`)).text;
  assert.equal(listed.split('\n').filter((line) => line.startsWith(`- Pg${mk}`)).length, 1, listed);

  const resolved = await mcpCall(home, M.orgId, 'manage_memory', { action: 'resolve', title: D, project_id: MP });
  assert.match(resolved.text, /Marked resolved/, resolved.text);
  const decisions = (await nodesTitled(M.orgId, `UUID${mk}`)).filter((n) => n.node_type === 'decision');
  assert.equal(decisions.length, 1, JSON.stringify(decisions));
  assert.equal(decisions[0].status, 'resolved');
  assert.ok(decisions[0].evidence >= 2, 'the resolve hit the carried node, with its history');
});

// ── U4. An edge keeps its own project's provenance ──────────────────────────

test('U4 (a/p6): a member\'s personal rebuild does not re-stamp the team\'s edge with their session', async () => {
  const O = await makePerson('s35p6o', { plan: 'developer_pro' });
  const M = await makePerson('s35p6m');
  const M2 = await makePerson('s35p6n');
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mk = tag();
  const dec = `Ship API${mk} behind a feature flag`;
  const task = `Migrate billing${mk} to the v2 ledger`;
  const saved = await upsert(okey, T, { entities: [
    { entity_type: 'decision', title: dec, summary: `${dec} until the rollout completes.`, scope: 'workspace' },
    { entity_type: 'task', title: task, summary: `${task} before the quarter closes.`, scope: 'workspace' },
  ] });
  assert.equal(saved.err, false, saved.text);
  const P = await newProject(O, 'TeamP', T);
  await share(O, T, P, { visibility: 'shared' });
  const sidO = `sess-O-${uuidv4()}`;
  await flush(O, T, P, { current_task: task, recent_decisions: [{ summary: dec, decided_at: today() }] }, sidO);
  const edges = async () => (await q(
    `SELECT e.project_id, e.source_session_id FROM context_graph_edges e
       JOIN context_graph_nodes a ON a.node_id = e.from_node_id
      WHERE e.owner_key = $1 AND a.title ILIKE $2 AND e.edge_type = 'related_to'`,
    [T, `%${mk}%`],
  )).rows;
  assert.ok((await edges()).some((e) => e.project_id === P && e.source_session_id === sidO), 'precondition: the team project drew the edge');

  const H = await newProject(M, 'MinePersonal', T);
  await share(M, T, H, { visibility: 'personal' });
  const sidM = `sess-M-PERSONAL-${uuidv4()}`;
  await flush(M, T, H, { current_task: task, recent_decisions: [{ summary: dec, decided_at: today() }] }, sidM);

  const after = await edges();
  assert.ok(!after.some((e) => e.project_id === P && e.source_session_id === sidM), JSON.stringify(after));
  for (const path of [`/api/v1/context/graph/projects/${P}`, '/api/v1/context/graph/export']) {
    const res = await as('get', path, M2, T);
    assert.equal(res.status, 200, path);
    assert.ok(!JSON.stringify(res.body).includes(sidM), `${path} serves the member's personal session`);
  }
});

// ── U5. The private_to index is built concurrently, off the request path ────

test('U5 (a/F4, guard): the private_to index is found with no table lock, and an invalid one is rebuilt', async () => {
  const store = require('../../src/store/contextSyncStore');
  const INDEX = 'idx_context_graph_nodes_private_to';
  const state = async () => (await q(
    'SELECT i.indisvalid AS valid, pg_get_indexdef(i.indexrelid) AS def FROM pg_index i WHERE i.indexrelid = to_regclass($1)',
    [INDEX],
  )).rows[0] || null;
  await store.ensureSchema();
  await store.ensurePrivateToIndex();
  assert.equal((await state())?.valid, true);

  // Every boot after the first: a catalog read, no lock on the table — it
  // returns while another transaction holds uncommitted graph writes (a plain
  // CREATE INDEX, even IF NOT EXISTS, queues behind that for a SHARE lock and
  // stalls every graph write queued behind it).
  const holder = await db.pool.connect();
  try {
    await holder.query('BEGIN');
    await holder.query('LOCK TABLE context_graph_nodes IN ROW EXCLUSIVE MODE');
    const started = Date.now();
    assert.equal(await store.ensurePrivateToIndex(), 'present');
    assert.ok(Date.now() - started < 2000, 'the second boot waited on the table');
  } finally {
    await holder.query('ROLLBACK');
    holder.release();
  }

  // A build that failed leaves an INVALID index under the name, which IF NOT
  // EXISTS would accept for ever: it is dropped and rebuilt.
  await q(`DROP INDEX IF EXISTS ${INDEX}`);
  await q(`CREATE UNIQUE INDEX CONCURRENTLY ${INDEX} ON context_graph_nodes (node_type)`).catch(() => {});
  assert.equal((await state())?.valid, false, 'precondition: an invalid index holds the name');
  assert.equal(await store.ensurePrivateToIndex(), 'built');
  const rebuilt = await state();
  assert.equal(rebuilt?.valid, true);
  assert.match(rebuilt.def, /private_to/);
  assert.match(rebuilt.def, /WHERE/);
});
