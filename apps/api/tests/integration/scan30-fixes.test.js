/**
 * SCAN 30. Rounds 28, 29 and 30 each broke a different case of ONE rule: where
 * manage_memory(upsert_entities) files an entity that names no project of its
 * own. The rule is now one piece (service.upsertWorkspaceEntities,
 * workingProject); the dispatchers only say which project the caller is
 * working in (filed_by_default).
 *
 *   1. A NEW entity is filed under the working project only in a SHARED
 *      workspace, when that project is personal or private, and when the
 *      caller may edit the entity's section there (else refused, naming it).
 *      Everywhere else it is workspace-level, as before round 28:
 *        - a solo user's services are cross-project again (portfolio, p66);
 *        - a member working in a teammate's shared project saves services,
 *          tools and relations without a share refusal (p72);
 *        - a member cannot put nodes into a view-only share by default (p71).
 *      A fuzzy-dedup match does not change that: the write inserts under the
 *      entity's own key, so it keeps the filing (p1: a member's personal
 *      entity was published at workspace level).
 *   2. An EXISTING node keeps its own home; one in an archived project is
 *      judged as an existing node (archived allowed) — p4.
 *   3. A resolve/reopen goes to the working project when ITS decision log
 *      carries the decision (p3, p3b, p64, p65, p58), and only otherwise to
 *      the node's own project, named in the reply (the scan-29 case).
 *   4. Auto-promotion never adopts a workspace-level node into a project
 *      (p2, p68).
 *   5. A NEW node in a project needs edit on its sections, by every door (p71).
 *   7. A new summary the store does not take is said, not hidden (F5).
 *
 * Scan 31 revised rule 1 (tests/integration/scan31-fixes.test.js): a new entity
 * is filed under the working project whenever the caller may edit its section
 * there, and workspace-level only when a teammate's share withholds it. The
 * p72, p66, p65 and p69 assertions below say what changed and why.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan30-fixes.test.js
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
const store = require('../../src/store/contextSyncStore');

const q = (sql, params) => db.query(sql, params, 'org-system');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => uuidv4().slice(0, 6);

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

async function mcpCall(key, ws, name, args, path = '/mcp') {
  const r = await request(httpServer).post(path).set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`).set('x-deerdawn-workspace', ws)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
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

async function setVisibility(person, ws, projectId, visibility) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const rowsLike = async (ownerKey, marker, types = null) => (await q(
  `SELECT node_type, title, summary, project_id, metadata->>'scope' AS scope, metadata->>'status' AS status FROM context_graph_nodes
   WHERE owner_key = $1 AND (title ILIKE $2 OR summary ILIKE $2) ${types ? 'AND node_type = ANY($3)' : ''} ORDER BY created_at`,
  types ? [ownerKey, `%${marker}%`, types] : [ownerKey, `%${marker}%`],
)).rows;

const decisionsOf = async (ownerKey, projectId) => Object.fromEntries(((await store.getProject(ownerKey, projectId)).context.recent_decisions || [])
  .map((d) => [d.summary, Boolean(d.resolved)]));

// An owner and two members, keys for all three.
async function team(label) {
  const O = await makePerson(`${label}o`, { plan: 'developer_pro' });
  const M = await makePerson(`${label}m`);
  const M2 = await makePerson(`${label}n`);
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const keys = { O: await mintKey(O, T), M: await mintKey(M, T), M2: await mintKey(M2, T) };
  return { O, M, M2, T, keys };
}

// Record `summary` in a project's decision log the everyday way.
async function record(key, ws, projectId, summary) {
  const r = await mcpCall(key, ws, 'manage_memory', { action: 'update', project_id: projectId, summary });
  assert.equal(r.err, false, r.text);
  await wait(700);
}

// ── 1. New entities ─────────────────────────────────────────────────────────

test('1 (p1): a fuzzy match on a team node does not publish a member\'s NEW personal-project entity', async () => {
  const t = await team('s30f1');
  const Pm = await newProject(t.M, 'Mine', t.T);
  await setVisibility(t.M, t.T, Pm, 'personal');
  const mk = `Stagingcluster${tag()}`;
  const first = await mcpCall(t.keys.O, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'knowledge', title: `The ${mk} lives in eu-west-2`, summary: 'Every team deploys staging there.', scope: 'workspace' }],
  });
  assert.equal(first.err, false, first.text);
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Pm });
  const mine = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'knowledge', title: `The ${mk} lives in eu-west-2 for the Acme buyout`, summary: 'Every team deploys staging there. SECRET: Acme buyout talks.' }],
  });
  assert.equal(mine.err, false, mine.text);
  const rows = await rowsLike(t.T, mk);
  assert.deepEqual(rows.map((r) => [r.project_id, r.scope]), [[null, 'workspace'], [Pm, 'project']], JSON.stringify(rows));
  const seen = await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query: `${mk} Acme buyout` });
  assert.doesNotMatch(seen.text, /Acme buyout/, seen.text);
  const rest = await as('get', `/api/v1/context/workspace/entities?query=${mk}&format=json`, t.M2, t.T);
  assert.deepEqual((rest.body.entities || []).filter((e) => /Acme/.test(`${e.title} ${e.summary}`)), [], JSON.stringify(rest.body));
});

// Scan 31 (rule 1 revised): what the member may edit there is filed there — a
// person (default sections) — and only what the share withholds from them
// (services and tools need tech_stack) is workspace-level. Still no refusal.
test('1 (p72): a member working in a teammate\'s default-shared project saves services, tools and relations; what the share withholds is workspace-level', async () => {
  const t = await team('s30f72');
  const P = await newProject(t.O, 'Team repo', t.T);
  const vis = (await q('SELECT visibility FROM context_projects WHERE project_id = $1', [P])).rows[0].visibility;
  assert.equal(vis, 'shared');
  const mk = tag();
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: P });
  const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [
      { entity_type: 'service', title: `Redis session cache ${mk}`, summary: 'Redis caches session tokens for the API tier.' },
      { entity_type: 'tool', title: `Grafana ${mk}`, summary: 'Grafana hosts the latency dashboards for on-call.' },
      { entity_type: 'person', title: `Dana Lee ${mk}`, summary: 'Dana Lee owns the billing API and reviews schema changes.' },
    ],
    relations: [{ from_canonical_key: `person:dana-lee-${mk}`, to_canonical_key: `service:redis-session-cache-${mk}`, relation_type: 'owns' }],
  });
  assert.equal(r.err, false, r.text);
  // The filing note (journey r5) sits between the count and the relations.
  assert.match(r.text, /Upserted 3 workspace entities\..*Recorded 1 relation\./, r.text);
  assert.doesNotMatch(r.text, /Skipped|Did not record/, r.text);
  const rows = await rowsLike(t.T, mk);
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const expected = row.node_type === 'person' ? [P, 'project'] : [null, 'workspace'];
    assert.deepEqual([row.project_id, row.scope], expected, row.title);
  }
  const owner = await mcpCall(t.keys.O, t.T, 'recall', { action: 'entities', query: `Redis session cache ${mk}` });
  assert.match(owner.text, /Redis session cache/i, owner.text);
});

// Scan 31 (rule 1 revised): a solo user's entities are filed under the project
// they were saved in — a workspace-level node is published to the first
// colleague invited — and one saved again from another project keeps its home
// and records a sighting there, which is what makes it cross-project.
test('1 (p66) + 7 (F5): a solo user\'s services are cross-project by sighting, and a kept description is said', async () => {
  const S = await makePerson('s30f66', { plan: 'developer_basic' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Web app');
  const B = await newProject(S, 'Mobile app');
  const mk = tag();
  await mcpCall(key, S.orgId, 'start_session', { project_id: A });
  const u1 = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [
      { entity_type: 'service', title: `Stripe billing ${mk}`, summary: 'Stripe handles all subscription billing for every app we ship.' },
      { entity_type: 'service', title: `Auth0 login ${mk}`, summary: 'Auth0 provides login for the web app and the admin console.' },
    ],
  });
  assert.equal(u1.err, false, u1.text);
  const rows = await rowsLike(S.orgId, mk);
  assert.deepEqual(rows.map((r) => [r.project_id, r.scope]), [[A, 'project'], [A, 'project']], JSON.stringify(rows));
  // scope:"project" with no project_id asks for the working project: filed there.
  const asked = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'service', title: `Static CDN ${mk}`, summary: 'Fronts the web app static assets only.', scope: 'project' }],
  });
  assert.equal(asked.err, false, asked.text);
  assert.deepEqual((await rowsLike(S.orgId, `CDN ${mk}`)).map((r) => [r.project_id, r.scope]), [[A, 'project']]);
  await mcpCall(key, S.orgId, 'start_session', { project_id: B });
  const u2 = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'service', title: `Stripe billing ${mk}`, summary: 'Stripe also bills in-app purchases for the mobile app via web checkout.' }],
  });
  assert.equal(u2.err, false, u2.text);
  assert.match(u2.text, /Upserted 1 workspace entity/, u2.text);
  assert.match(u2.text, new RegExp(`Kept the existing description of "Stripe Billing ${mk}"[^.]*: a stored description is not replaced`, 'i'), u2.text);
  const after = (await rowsLike(S.orgId, `Stripe billing ${mk}`))[0];
  assert.equal(after.project_id, A);
  assert.equal(after.summary, 'Stripe handles all subscription billing for every app we ship.');
  const portfolio = await mcpCall(key, S.orgId, 'recall', { action: 'portfolio' });
  assert.match(portfolio.text, new RegExp(`Stripe Billing ${mk} \\(service\\): (Web app|Mobile app) [a-f0-9]+, (Web app|Mobile app) [a-f0-9]+`, 'i'), portfolio.text);
  // An unchanged summary is not remarked on.
  const same = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'service', title: `Stripe billing ${mk}`, summary: 'Stripe handles all subscription billing for every app we ship.' }],
  });
  assert.doesNotMatch(same.text, /Kept the existing description/, same.text);
});

test('1: a NEW entity in a personal/private working project the caller cannot edit is refused, naming the section, nothing stored', async () => {
  const t = await team('s30fpriv');
  const Pp = await newProject(t.M, 'Private', t.T);
  await setVisibility(t.M, t.T, Pp, 'private');
  const mk = `Lockbox${tag()}`;
  // The owner may READ a member's private project, not write it.
  const r = await mcpCall(t.keys.O, t.T, 'manage_memory', {
    action: 'upsert_entities', project_id: Pp,
    entities: [{ entity_type: 'knowledge', title: `The ${mk} vendor shortlist is final`, summary: 'Three vendors made the shortlist this week.' }],
  });
  assert.equal(r.err, true, r.text);
  assert.match(r.text, /share_write_forbidden: nothing was saved\..*you cannot edit [a-z_, ]+ there\. That project is private/, r.text);
  assert.deepEqual(await rowsLike(t.T, mk), []);
  // The author still files there.
  const own = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities', project_id: Pp,
    entities: [{ entity_type: 'knowledge', title: `The ${mk} vendor shortlist is final`, summary: 'Three vendors made the shortlist this week.' }],
  });
  assert.equal(own.err, false, own.text);
  assert.deepEqual((await rowsLike(t.T, mk)).map((row) => row.project_id), [Pp]);
});

// ── 5. A new node in a project needs edit on its section (p71) ─────────────

test('5 (p71): a view-only share admits no new node into the owner\'s project, by any door', async () => {
  const t = await team('s30f71');
  const P = await newProject(t.O, 'ViewOnly', t.T);
  const sections = ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'tech_stack', 'open_questions'];
  const share = await as('patch', `/api/v1/teams/projects/${P}/sharing`, t.O, t.T)
    .send({ visibility: 'shared', sections: sections.map((s) => ({ section_key: s, can_view: true, can_edit: false })), members: [] });
  assert.equal(share.status, 200, JSON.stringify(share.body));
  const mk = tag();
  const inP = async () => (await rowsLike(t.T, mk)).filter((row) => row.project_id === P);
  // Default filing: a shared working project files new entities workspace-level.
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: P });
  const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [
      { entity_type: 'decision', title: `Decided to drop Postgres and move the ${mk} ledger to DynamoDB.` },
      { entity_type: 'service', title: `MongoDB Atlas ${mk}`, summary: 'MongoDB Atlas is now the primary datastore for the ledger.' },
    ],
  });
  assert.equal(r.err, false, r.text);
  assert.deepEqual(await inP(), []);
  // A per-entity project_id naming P.
  const named = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'decision', title: `Decided to cut the ${mk} ledger over to Cassandra next quarter.`, project_id: P }],
  });
  assert.equal(named.err, true, named.text);
  assert.match(named.text, /share_write_forbidden.*recent_decisions/, named.text);
  // The REST door.
  const rest = await as('post', '/api/v1/context/graph/nodes', t.M, t.T)
    .send({ node_type: 'service', title: `Cassandra ring ${mk}`, project_id: P, summary: 'A new ring for the ledger.' });
  assert.equal(rest.status, 403, JSON.stringify(rest.body));
  assert.deepEqual(await inP(), []);
  // The owner still adds to their own project.
  const owner = await mcpCall(t.keys.O, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'service', title: `Ledger writer ${mk}`, summary: 'Writes every ledger entry exactly once.', project_id: P }],
  });
  assert.equal(owner.err, false, owner.text);
  assert.equal((await inP()).length, 1);
});

// ── 2. Existing nodes ───────────────────────────────────────────────────────

test('2/6 (p4): re-saving an entity whose node lives in an ARCHIVED project succeeds and leaves it there', async () => {
  const S = await makePerson('s30f4', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const Q = await newProject(S, 'Old');
  const mk = `Billing${tag()}`;
  const first = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities', entities: [{ entity_type: 'service', title: `Stripe ${mk} platform`, summary: 'Handles invoices and payouts for every region.', project_id: Q }],
  });
  assert.equal(first.err, false, first.text);
  assert.equal((await as('post', `/api/v1/context/projects/${Q}/archive`, S, S.orgId).send({})).status, 200);
  const P = await newProject(S, 'New');
  await mcpCall(key, S.orgId, 'start_session', { project_id: P });
  const again = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities', entities: [{ entity_type: 'service', title: `Stripe ${mk} platform`, summary: 'Handles invoices and payouts for every region; now also refunds.' }],
  });
  assert.equal(again.err, false, again.text);
  assert.match(again.text, /Upserted 1 workspace entity/, again.text);
  assert.deepEqual((await rowsLike(S.orgId, mk)).map((row) => row.project_id), [Q]);
});

// ── 4. Auto-promotion never adopts a workspace node (p2, p68) ───────────────

test('4 (p2/p68): a member\'s update in a personal project leaves the team\'s workspace decision and preference workspace-level', async () => {
  const t = await team('s30f68');
  const Pm = await newProject(t.M, 'Side', t.T);
  await setVisibility(t.M, t.T, Pm, 'personal');
  const mk = tag();
  const D = `Decided all ${mk} services log in structured JSON with a request id.`;
  const pref = `Always run ${mk} migrations behind a feature flag`;
  const seed = await mcpCall(t.keys.O, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'decision', title: D, scope: 'workspace' }, { entity_type: 'preference', title: pref, scope: 'workspace' }],
  });
  assert.equal(seed.err, false, seed.text);
  // The MCP update path (extraction) and the REST context write.
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: Pm });
  const up = await mcpCall(t.keys.M, t.T, 'manage_memory', { action: 'update', project_id: Pm, summary: D });
  assert.equal(up.err, false, up.text);
  const patch = await as('patch', `/api/v1/context/projects/${Pm}/context`, t.M, t.T).send({ recent_decisions: [{ summary: D }], recurring_context: [pref] });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  await wait(1500);
  const rows = await rowsLike(t.T, mk, ['decision', 'preference']);
  assert.equal(rows.length, 2, JSON.stringify(rows));
  for (const row of rows) assert.deepEqual([row.project_id, row.scope], [null, 'workspace'], row.title);
  for (const who of ['O', 'M2']) {
    const seen = await mcpCall(t.keys[who], t.T, 'recall', { action: 'entities', query: `structured JSON ${mk}` });
    assert.match(seen.text, /structured JSON/, `${who}: ${seen.text}`);
  }

  // ...and resolving it in Pm's own log (id-less) resolves Pm's entry, not the
  // team's workspace node.
  const res = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities', entities: [{ entity_type: 'decision', title: D, metadata: { status: 'resolved' } }],
  });
  assert.equal(res.err, false, res.text);
  assert.match(res.text, /Resolved in the decision log of .*whole workspace's and was left as it is/, res.text);
  assert.equal((await decisionsOf(t.T, Pm))[D], true);
  const node = (await rowsLike(t.T, mk, ['decision']))[0];
  assert.equal(node.project_id, null);
  assert.notEqual(node.status, 'resolved', 'the team\'s node is still open for everybody');
});

// ── 3. Status changes go to the working project's own log ───────────────────

for (const form of ['active', 'top-level']) {
  test(`3 (p3${form === 'active' ? '' : 'b'}): a member resolves in THEIR project (${form}); the colleague's project holding the node is untouched`, async () => {
    const t = await team(`s30f3${form[0]}`);
    const B = await newProject(t.O, 'Obase', t.T);
    const A = await newProject(t.M, 'Mine', t.T);
    const D = `Decided to adopt Temporal ${tag()} for the payout workflow orchestration.`;
    await record(t.keys.O, t.T, B, D);
    await record(t.keys.M, t.T, A, D);
    const nodes = (await q('SELECT project_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\' AND title = $2', [t.T, D])).rows;
    assert.deepEqual(nodes.map((n) => n.project_id), [B], 'one node, filed under the colleague\'s B');
    let args = { action: 'upsert_entities', entities: [{ entity_type: 'decision', title: D, metadata: { status: 'resolved' } }] };
    if (form === 'active') await mcpCall(t.keys.M, t.T, 'start_session', { project_id: A });
    else args = { ...args, project_id: A };
    const r = await mcpCall(t.keys.M, t.T, 'manage_memory', args);
    assert.equal(r.err, false, r.text);
    assert.match(r.text, /Resolved in the decision log of Mine/, r.text);
    assert.equal((await decisionsOf(t.T, A))[D], true, 'A resolved');
    assert.equal((await decisionsOf(t.T, B))[D], false, 'the colleague\'s B untouched');
  });
}

test('3 (p64 solo): upsert resolve with top-level project_id B resolves B, not A where the node lives', async () => {
  const S = await makePerson('s30f64');
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to use Postgres 16 ${tag()} for the primary database.`;
  await record(key, S.orgId, A, D);
  await record(key, S.orgId, B, D);
  const r = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities', project_id: B, entities: [{ title: D, entity_type: 'decision', metadata: { status: 'resolved' } }],
  });
  assert.equal(r.err, false, r.text);
  assert.match(r.text, /Resolved in the decision log of Repo B/, r.text);
  assert.equal((await decisionsOf(S.orgId, B))[D], true);
  assert.equal((await decisionsOf(S.orgId, A))[D], false);
});

for (const vis of ['private', 'personal']) {
  test(`3 (p65 ${vis}): a member resolves their own decision when the node lives in the owner's ${vis} project`, async () => {
    const t = await team(`s30f65${vis[1]}`);
    const OP = await newProject(t.O, 'Owner proj', t.T);
    await setVisibility(t.O, t.T, OP, vis);
    const MP = await newProject(t.M, 'Member proj', t.T);
    const E = `Decided to deploy ${tag()} on Fly.io in the iad region.`;
    await record(t.keys.O, t.T, OP, E);
    await record(t.keys.M, t.T, MP, E);
    await mcpCall(t.keys.M, t.T, 'start_session', { project_id: MP });
    const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
      action: 'upsert_entities', entities: [{ title: E, entity_type: 'decision', metadata: { status: 'resolved' } }],
    });
    assert.equal(r.err, false, r.text);
    // Scan 31: the member's own decision node now exists in MP (the owner's
    // hidden node no longer blocks its key — scopedEntityKey), so the resolve
    // is an ordinary one on it rather than a brief-only one.
    assert.doesNotMatch(r.text, /Not resolved/, r.text);
    assert.equal((await decisionsOf(t.T, MP))[E], true);
    assert.equal((await decisionsOf(t.T, OP))[E], false);
  });
}

test('3 (p58): a reopen in the member\'s project does not reopen the colleague\'s resolved one', async () => {
  const t = await team('s30f58');
  const C1 = await newProject(t.O, 'API child', t.T);
  const C2 = await newProject(t.M, 'Web child', t.T);
  const Z = `Decided both ${tag()} children log in structured JSON with a request id.`;
  await record(t.keys.O, t.T, C1, Z);
  await record(t.keys.M, t.T, C2, Z);
  const closed = await mcpCall(t.keys.O, t.T, 'manage_memory', {
    action: 'upsert_entities', project_id: C1, entities: [{ entity_type: 'decision', title: Z, metadata: { status: 'resolved' } }],
  });
  assert.equal(closed.err, false, closed.text);
  assert.equal((await decisionsOf(t.T, C1))[Z], true);
  const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities', project_id: C2, entities: [{ entity_type: 'decision', title: Z, summary: Z, metadata: { status: 'active' } }],
  });
  assert.equal(r.err, false, r.text);
  assert.match(r.text, /already open in the decision log of Web child/, r.text);
  assert.equal((await decisionsOf(t.T, C1))[Z], true, 'C1 is still resolved');
  assert.equal((await decisionsOf(t.T, C2))[Z], false);
  const node = (await q('SELECT metadata->>\'status\' AS status FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\' AND title = $2', [t.T, Z])).rows;
  assert.deepEqual(node.map((n) => n.status), ['resolved'], 'C1\'s node keeps C1\'s status');
});

test('3 (scan 29 case): a resolve the working project does not record goes to the node\'s own project, named', async () => {
  const S = await makePerson('s30f3h', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Alpha');
  const B = await newProject(S, 'Beta');
  const D = `Decided to adopt Temporal ${tag()} for the payout workflow orchestration.`;
  await record(key, S.orgId, B, D);
  await mcpCall(key, S.orgId, 'start_session', { project_id: A });
  const r = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities', entities: [{ entity_type: 'decision', title: D, metadata: { status: 'resolved' } }],
  });
  assert.equal(r.err, false, r.text);
  assert.match(r.text, /Resolved in the decision log of Beta [a-f0-9]+, the project this decision is filed under/, r.text);
  assert.equal((await decisionsOf(S.orgId, B))[D], true);
});

test('3 (p69, the local path): POST /workspace/entities with filed_by_default resolves the working project, old and new client shapes', async () => {
  const S = await makePerson('s30f69');
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to use Postgres 16 ${tag()} for the primary database.`;
  await record(key, S.orgId, A, D);
  await record(key, S.orgId, B, D);
  // The shape the local dispatcher posts now...
  const r = await as('post', '/api/v1/context/workspace/entities', S, S.orgId)
    .send({ entities: [{ entity_type: 'decision', title: D, project_id: B, filed_by_default: true, metadata: { status: 'resolved' } }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.decision_resolves_note, /Resolved in the decision log of Repo B/, JSON.stringify(r.body));
  assert.equal((await decisionsOf(S.orgId, B))[D], true);
  assert.equal((await decisionsOf(S.orgId, A))[D], false);
  // ...and the one an older client posts (scope:"project" beside the flag):
  // a NEW entity is filed under the working project (scan 31: for a solo
  // account too — rule 1 files where the caller may edit).
  const mk = `Kafka${tag()}`;
  const old = await as('post', '/api/v1/context/workspace/entities', S, S.orgId)
    .send({ entities: [{ entity_type: 'service', title: `${mk} event bus`, summary: 'Carries every domain event between services.', project_id: A, scope: 'project', filed_by_default: true }] });
  assert.equal(old.status, 200, JSON.stringify(old.body));
  assert.deepEqual((await rowsLike(S.orgId, mk)).map((row) => [row.project_id, row.scope]), [[A, 'project']]);
});
