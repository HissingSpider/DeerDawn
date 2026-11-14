/**
 * JOURNEY R4 — A PROJECT AN AI TOOL CREATES STARTS PERSONAL.
 *
 * In a workspace with more than one member, a new project defaulted to
 * `shared` whoever created it. An assistant asked to "start a project for my
 * tax paperwork" in the middle of a team conversation published it to every
 * member before the person had said a word about who should read it.
 *
 * The owner's decision: created through a tool (the hosted or the local
 * manage_projects create, and a project the capture path creates), it starts
 * `personal` — only its author reads it — and they can share it afterwards.
 * Created in the dashboard, it keeps today's default (`shared`). In a
 * workspace of one nothing changes (`private`). The create reply says the
 * truth for a personal project, and how to share it.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/journey-r4-tool-created-personal.test.js
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

async function makeOrgUser(label, plan = 'developer_pro') {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', 5],
  );
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  return { label, orgId, userId, email, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin', email }) };
}

/** A credential for `person` in `ws`: a hosted connector, or a plain key as the local server holds. */
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

async function cleanup(people, workspaces) {
  for (const ws of workspaces) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await q(`DELETE FROM ${table} WHERE owner_key = $1`, [ws]).catch(() => {});
    }
    await q('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [ws]).catch(() => {});
    await q('DELETE FROM context_session_loads WHERE owner_key = $1', [ws]).catch(() => {});
    await q('DELETE FROM context_sessions WHERE owner_key = $1', [ws]).catch(() => {});
    await q('DELETE FROM context_projects WHERE owner_key = $1', [ws]).catch(() => {});
    await q('DELETE FROM workspace_members WHERE owner_key = $1', [ws]).catch(() => {});
  }
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
    text: (body.result?.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'),
    data: body.result?.structuredContent,
    isError: body.result?.isError === true || Boolean(body.error),
  };
}

const row = async (projectId) => (await q('SELECT visibility, owner_user_id, owner_key FROM context_projects WHERE project_id = $1', [projectId])).rows[0];

/** A team of four: two owners, a member, a viewer. */
async function team() {
  const olivia = await makeOrgUser('olivia');
  const omar = await makeOrgUser('omar');
  const marcus = await makeOrgUser('marcus');
  const vera = await makeOrgUser('vera');
  const ws = olivia.orgId;
  await workspace.addMember(ws, olivia.userId, { role: 'owner' });
  await workspace.addMember(ws, omar.userId, { role: 'owner' });
  await workspace.addMember(ws, marcus.userId, { role: 'member' });
  await workspace.addMember(ws, vera.userId, { role: 'viewer' });
  // As workspaceLabel prints it: the name, quoted.
  const label = `"${(await q('SELECT name FROM organizations WHERE org_id = $1', [ws])).rows[0].name}"`;
  return { olivia, omar, marcus, vera, ws, label, people: [olivia, omar, marcus, vera] };
}

/** Who can open `projectId`: GET /projects/:id as each person, with a key in the workspace. */
async function readers(fx, projectId) {
  const out = [];
  for (const person of fx.people) {
    const key = await keyFor(person, fx.ws, { scopes: ['context:read'] });
    const res = await request(httpServer).get(`/api/v1/context/projects/${projectId}/inject?format=json`).set('X-Api-Key', key);
    if (res.status === 200) out.push(person.label);
  }
  return out;
}

const SHARE_HOW = 'To share it with the team, open the dashboard\'s team settings and set it to "Shared with the team" under "What this team can see".';

test('hosted manage_projects create in a team: personal, the author alone reads it, and the reply says so and how to share it', async () => {
  const fx = await team();
  try {
    const key = await keyFor(fx.marcus, fx.ws, { hosted: true });
    const name = `Tax paperwork ${uuidv4().slice(0, 6)}`;
    const created = await hosted(key, 'manage_projects', { action: 'create', project_name: name });
    assert.equal(created.isError, false, created.text);
    const id = created.data.project_id;
    const stored = await row(id);
    assert.equal(stored.visibility, 'personal', `THE BUG: a project an AI tool created in a team was published as ${stored.visibility}`);
    assert.equal(stored.owner_user_id, fx.marcus.userId, 'attributed to the person, not the credential');
    assert.equal(stored.owner_key, fx.ws);
    assert.equal(
      created.text,
      `Created project "${name}" (${id}). This connection now works in "${name}". Other connections are unchanged. It belongs to the workspace ${fx.label} and is personal, readable only by you. ${SHARE_HOW}`,
    );
    assert.deepEqual(await readers(fx, id), ['marcus'], 'only its author reads a personal project — not even an owner');

    // And they can share it afterwards, as the reply says.
    const shared = await request(httpServer).patch(`/api/v1/teams/projects/${id}/sharing`)
      .set('Authorization', `Bearer ${fx.marcus.jwt}`).set('x-deerdawn-workspace', fx.ws)
      .send({ visibility: 'shared' });
    assert.equal(shared.status, 200, shared.text);
    assert.deepEqual((await readers(fx, id)).sort(), ['marcus', 'olivia', 'omar', 'vera']);
  } finally {
    await cleanup(fx.people, [fx.ws]);
  }
});

test('local manage_projects create (POST /projects with a key) in a team: personal, and the server hands the local reply its sentence', async () => {
  const fx = await team();
  try {
    const key = await keyFor(fx.olivia, fx.ws);
    const res = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', key)
      .send({ project_name: `Side project ${uuidv4().slice(0, 6)}` });
    assert.equal(res.status, 201, res.text);
    const id = res.body.project.project_id;
    assert.equal((await row(id)).visibility, 'personal', 'THE BUG: a tool-created project was published to the team');
    assert.equal(res.body.placement_note, `It belongs to the workspace ${fx.label} and is personal, readable only by you. ${SHARE_HOW}`);
    assert.deepEqual(await readers(fx, id), ['olivia'], 'the other owner does not read a personal project');
  } finally {
    await cleanup(fx.people, [fx.ws]);
  }
});

test('a project the capture path creates in a team is personal', async () => {
  const fx = await team();
  try {
    const key = await keyFor(fx.marcus, fx.ws);
    const name = `Captured ${uuidv4().slice(0, 6)}`;
    const res = await request(httpServer).post('/api/v1/context/extraction').set('X-Api-Key', key).send({
      session_id: `agent-${uuidv4().slice(0, 8)}`, tool: 'claude_code',
      chunks: [{ role: 'user', text: 'set up the new repo' }, { role: 'assistant', text: 'Scaffolded the service and chose Postgres.' }],
      extraction: {
        match_decision: 'new_project', confidence: 0.9, project_candidate: { project_name: name },
        delta: { current_status: 'Scaffolded the service.' }, should_create_project: true, needs_user_confirmation: false,
      },
    });
    assert.ok(res.status < 300, res.text);
    const id = res.body.project?.project_id;
    assert.ok(id, res.text);
    assert.equal((await row(id)).visibility, 'personal', 'THE BUG: a captured project was published to the team');
    assert.deepEqual(await readers(fx, id), ['marcus']);
  } finally {
    await cleanup(fx.people, [fx.ws]);
  }
});

test('as today: a project created in the dashboard in a team is shared', async () => {
  const fx = await team();
  try {
    const res = await request(httpServer).post('/api/v1/context/projects')
      .set('Authorization', `Bearer ${fx.marcus.jwt}`).set('x-deerdawn-workspace', fx.ws)
      .send({ project_name: `Dashboard project ${uuidv4().slice(0, 6)}` });
    assert.equal(res.status, 201, res.text);
    const id = res.body.project.project_id;
    assert.equal((await row(id)).visibility, 'shared');
    assert.equal(res.body.placement_note, `It belongs to the workspace ${fx.label} and is shared with the members of ${fx.label}.`);
    assert.deepEqual((await readers(fx, id)).sort(), ['marcus', 'olivia', 'omar', 'vera']);
  } finally {
    await cleanup(fx.people, [fx.ws]);
  }
});

test('as today: in a workspace of one, a tool-created project is private and the reply is unchanged', async () => {
  const solo = await makeOrgUser('solo', 'developer_pro');
  try {
    await workspace.addMember(solo.orgId, solo.userId, { role: 'owner' });
    const key = await keyFor(solo, solo.orgId, { hosted: true });
    const name = `Solo ${uuidv4().slice(0, 6)}`;
    const created = await hosted(key, 'manage_projects', { action: 'create', project_name: name });
    const id = created.data.project_id;
    assert.equal((await row(id)).visibility, 'private');
    assert.equal(created.text, `Created project "${name}" (${id}). This connection now works in "${name}". Other connections are unchanged.`);
    const local = await request(httpServer).post('/api/v1/context/projects').set('X-Api-Key', await keyFor(solo, solo.orgId))
      .send({ project_name: `Solo local ${uuidv4().slice(0, 6)}` });
    assert.equal((await row(local.body.project.project_id)).visibility, 'private');
    assert.equal(local.body.placement_note, undefined, 'nothing to say in a workspace of one');
  } finally {
    await cleanup([solo], [solo.orgId]);
  }
});
