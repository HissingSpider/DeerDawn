/**
 * JOURNEY R4 — A SUB-PROJECT A TOOL CREATES STARTS WITH ITS PARENT'S VISIBILITY.
 *
 * Round 4 made a project an AI tool creates in a team start `personal`. That
 * held for sub-projects too, so the team read a shared parent and not the
 * child a tool had just filed under it. The owner's decision: a sub-project a
 * tool creates takes its parent's visibility (shared under shared, personal
 * under personal, private under private); a top-level one still starts
 * personal; the create reply says the truth in each case.
 *
 * Two things pinned beside it:
 *  - the caller must be able to READ the parent. It was not so: the parent was
 *    read raw, so a member could file a sub-project under a colleague's
 *    personal project. Now "not found", as for any project they cannot read
 *    (for a create and for a move).
 *  - moving a project under a parent later does not change its visibility.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-subproject-visibility.test.js
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
const workspace = require('../../src/services/workspaceService');
const { hashPassword, generateApiKey, generateToken } = require('../../src/utils/security');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrgUser(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'developer_pro', 'developer_pro', 'active', 5],
  );
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  return { label, orgId, userId, email, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin', email }) };
}

async function keyFor(person, ws, { hosted = false, scopes = ['context:read', 'context:write'] } = {}) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [`key-${uuidv4()}`, prefix, hash, `${person.label} key`, person.userId, ws, 'production',
      new Date(Date.now() + 86400000).toISOString(), scopes,
      hosted ? `https://claude.ai/${uuidv4()}` : null, hosted ? 'Claude' : null],
  );
  return key;
}

async function cleanup(people, ws) {
  for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
    await q(`DELETE FROM ${table} WHERE owner_key = $1`, [ws]).catch(() => {});
  }
  await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [ws]).catch(() => {});
  await q('DELETE FROM context_session_loads WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM context_sessions WHERE owner_key = $1', [ws]).catch(() => {});
  await q('UPDATE context_projects SET parent_project_id = NULL WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM context_projects WHERE owner_key = $1', [ws]).catch(() => {});
  await q('DELETE FROM workspace_members WHERE owner_key = $1', [ws]).catch(() => {});
  for (const person of people) {
    await q('DELETE FROM product_events WHERE org_id = $1 OR user_id = $2', [person.orgId, person.userId]).catch(() => {});
    await q('DELETE FROM api_keys WHERE owner_id = $1', [person.userId]).catch(() => {});
    await q('DELETE FROM users WHERE user_id = $1', [person.userId]).catch(() => {});
    await q('DELETE FROM organizations WHERE org_id = $1', [person.orgId]).catch(() => {});
  }
}

async function hosted(key, name, args) {
  const res = await request(httpServer).post('/mcp')
    .set({ Accept: 'application/json, text/event-stream' })
    .set('X-Api-Key', key)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return {
    text: (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n') || JSON.stringify(body.error || {}),
    data: body.result?.structuredContent,
    isError: body.result?.isError === true || Boolean(body.error),
  };
}

const dashboard = (person, ws, method, path) => request(httpServer)[method](path)
  .set('Authorization', `Bearer ${person.jwt}`).set('x-deerdawn-workspace', ws);
const withKey = (key, method, path) => request(httpServer)[method](path).set('X-Api-Key', key);
const visibilityOf = async (projectId) => (await q('SELECT visibility FROM context_projects WHERE project_id = $1', [projectId])).rows[0]?.visibility;
const countNamed = async (name) => (await q('SELECT count(*)::int AS n FROM context_projects WHERE project_name = $1', [name])).rows[0].n;

async function team() {
  const olivia = await makeOrgUser('olivia');
  const omar = await makeOrgUser('omar');
  const marcus = await makeOrgUser('marcus');
  const ws = olivia.orgId;
  await workspace.addMember(ws, olivia.userId, { role: 'owner' });
  await workspace.addMember(ws, omar.userId, { role: 'owner' });
  await workspace.addMember(ws, marcus.userId, { role: 'member' });
  const label = `"${(await q('SELECT name FROM organizations WHERE org_id = $1', [ws])).rows[0].name}"`;
  return { olivia, omar, marcus, ws, label, people: [olivia, omar, marcus] };
}

async function readers(fx, projectId) {
  const out = [];
  for (const person of fx.people) {
    const key = await keyFor(person, fx.ws, { scopes: ['context:read'] });
    const res = await withKey(key, 'get', `/api/v1/context/projects/${projectId}/inject?format=json`);
    if (res.status === 200) out.push(person.label);
  }
  return out.sort();
}

const SHARE_HOW = 'To share it with the team, open the dashboard\'s team settings and set it to "Shared with the team" under "What this team can see".';

test('a member\'s hosted tool files a sub-project under a shared parent: it is shared, and the reply says so', async () => {
  const fx = await team();
  try {
    const parent = await dashboard(fx.olivia, fx.ws, 'post', '/api/v1/context/projects').send({ project_name: `Platform ${uuidv4().slice(0, 6)}` });
    assert.equal(parent.status, 201, parent.text);
    const parentId = parent.body.project.project_id;
    assert.equal(await visibilityOf(parentId), 'shared');

    const key = await keyFor(fx.marcus, fx.ws, { hosted: true });
    const name = `Billing worker ${uuidv4().slice(0, 6)}`;
    const created = await hosted(key, 'manage_projects', { action: 'create', project_name: name, parent_project_id: parentId });
    assert.equal(created.isError, false, created.text);
    const id = created.data.project_id;
    assert.equal(await visibilityOf(id), 'shared', 'THE BUG: a sub-project under a shared parent started personal');
    assert.equal(created.text, `Created project "${name}" (${id}) (subproject of ${parentId}). This connection now works in "${name}". Other connections are unchanged. It belongs to the workspace ${fx.label} and is shared with the members of ${fx.label}.`);
    assert.deepEqual(await readers(fx, id), ['marcus', 'olivia', 'omar']);
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});

test('under a personal parent a tool\'s sub-project is personal; under a private one, private; top-level is still personal', async () => {
  const fx = await team();
  try {
    const key = await keyFor(fx.olivia, fx.ws);
    // Top level by a tool: personal, as round 4 decided.
    const top = await withKey(key, 'post', '/api/v1/context/projects').send({ project_name: `Side ${uuidv4().slice(0, 6)}` });
    assert.equal(top.status, 201, top.text);
    const topId = top.body.project.project_id;
    assert.equal(await visibilityOf(topId), 'personal');
    const underPersonal = await withKey(key, 'post', '/api/v1/context/projects').send({ project_name: `Side child ${uuidv4().slice(0, 6)}`, parent_project_id: topId });
    assert.equal(underPersonal.status, 201, underPersonal.text);
    assert.equal(await visibilityOf(underPersonal.body.project.project_id), 'personal');
    assert.equal(underPersonal.body.placement_note, `It belongs to the workspace ${fx.label} and is personal, readable only by you. ${SHARE_HOW}`);

    // A private parent: the owner's org work, not team-shared.
    const priv = await dashboard(fx.olivia, fx.ws, 'post', '/api/v1/context/projects').send({ project_name: `Payroll ${uuidv4().slice(0, 6)}` });
    const privId = priv.body.project.project_id;
    const set = await dashboard(fx.olivia, fx.ws, 'patch', `/api/v1/teams/projects/${privId}/sharing`).send({ visibility: 'private' });
    assert.equal(set.status, 200, set.text);
    const underPrivate = await withKey(key, 'post', '/api/v1/context/projects').send({ project_name: `Payroll child ${uuidv4().slice(0, 6)}`, parent_project_id: privId });
    assert.equal(underPrivate.status, 201, underPrivate.text);
    const childId = underPrivate.body.project.project_id;
    assert.equal(await visibilityOf(childId), 'private', 'THE BUG: a sub-project under a private parent started personal');
    assert.equal(underPrivate.body.placement_note, `It belongs to the workspace ${fx.label} and is private to you and the workspace's owners.`);
    assert.deepEqual(await readers(fx, childId), ['olivia', 'omar'], 'private: its author and the owners');
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});

test('the caller must be able to read the parent: a colleague\'s personal project is not found, for a create and for a move', async () => {
  const fx = await team();
  try {
    const oliviaKey = await keyFor(fx.olivia, fx.ws);
    const hers = await withKey(oliviaKey, 'post', '/api/v1/context/projects').send({ project_name: `Olivia private notes ${uuidv4().slice(0, 6)}` });
    const hersId = hers.body.project.project_id;
    assert.equal(await visibilityOf(hersId), 'personal');

    const marcusKey = await keyFor(fx.marcus, fx.ws, { hosted: true });
    const name = `Under hers ${uuidv4().slice(0, 6)}`;
    const created = await hosted(marcusKey, 'manage_projects', { action: 'create', project_name: name, parent_project_id: hersId });
    assert.equal(created.isError, true, `THE BUG: a member filed a sub-project under a colleague's personal project: ${created.text}`);
    assert.equal(await countNamed(name), 0, 'nothing was created');
    const viaRest = await withKey(await keyFor(fx.marcus, fx.ws), 'post', '/api/v1/context/projects').send({ project_name: `${name} rest`, parent_project_id: hersId });
    assert.ok(viaRest.status >= 400, viaRest.text);
    assert.equal(await countNamed(`${name} rest`), 0);

    // A move under it is refused the same way.
    const own = await withKey(await keyFor(fx.marcus, fx.ws), 'post', '/api/v1/context/projects').send({ project_name: `Marcus own ${uuidv4().slice(0, 6)}` });
    const move = await withKey(await keyFor(fx.marcus, fx.ws), 'post', `/api/v1/context/projects/${own.body.project.project_id}/parent`).send({ parent_project_id: hersId });
    assert.ok(move.status >= 400, `THE BUG: a member moved a project under a colleague's personal project: ${move.text}`);
    const parentNow = (await q('SELECT parent_project_id FROM context_projects WHERE project_id = $1', [own.body.project.project_id])).rows[0].parent_project_id;
    assert.equal(parentNow, null);
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});

test('as today: moving a project under a parent later does not change its visibility', async () => {
  const fx = await team();
  try {
    const parent = await dashboard(fx.olivia, fx.ws, 'post', '/api/v1/context/projects').send({ project_name: `Shared parent ${uuidv4().slice(0, 6)}` });
    const parentId = parent.body.project.project_id;
    const key = await keyFor(fx.marcus, fx.ws);
    const mine = await withKey(key, 'post', '/api/v1/context/projects').send({ project_name: `Mine ${uuidv4().slice(0, 6)}` });
    const mineId = mine.body.project.project_id;
    assert.equal(await visibilityOf(mineId), 'personal');
    const moved = await withKey(key, 'post', `/api/v1/context/projects/${mineId}/parent`).send({ parent_project_id: parentId });
    assert.ok(moved.status < 300, moved.text);
    assert.equal(await visibilityOf(mineId), 'personal', 'a move keeps the visibility it had');
    assert.deepEqual(await readers(fx, mineId), ['marcus']);
  } finally {
    await cleanup(fx.people, fx.ws);
  }
});
