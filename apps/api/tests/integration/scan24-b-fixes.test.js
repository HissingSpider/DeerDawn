/**
 * SCAN 24 (b).
 *
 *   1. MEDIUM: the scope a hosted MCP call needed was keyed on the TOOL, and the
 *      grouped tools carry context:write, so manage_tasks(list) and
 *      manage_memory(export_trail) refused every read-only key — a viewer could
 *      not read the board on /mcp at all (read_tasks is not advertised there).
 *      The scope is now the CALL's: context:write only when callWrites says so.
 *   2. MEDIUM: DELETE /context/account ("empty my workspace, keep my account")
 *      ran the person-keyed half of the erasure, so a member emptying their OWN
 *      workspace was taken off every team they were on and their team keys were
 *      revoked. It now erases only what the emptied workspace owns.
 *   3. LOW: nobody but an owner could leave a team — DELETE /teams/members/:id
 *      was owners-only. Anybody may now remove THEMSELVES; an owner only while
 *      another active owner remains (409 last_owner, under the membership lock).
 *   5. LOW: with no project, a write said "…or call start_session first" — and
 *      on a brand-new account start_session creates nothing. It now names
 *      manage_projects(create), which every catalog advertises.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan24-b-fixes.test.js
 */


process.env.NODE_ENV = 'test';
// This file makes well over 120 API calls a minute (the per-minute apiLimiter),
// and a 429 is not what any of it is testing.
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

async function mintKey(person, orgId, scopes = ['context:read', 'context:write']) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), scopes],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcpCall(key, ws, name, args, path = '/mcp') {
  let req = request(httpServer).post(path).set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`);
  if (ws) req = req.set('x-deerdawn-workspace', ws);
  const r = await req.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}


async function board(orgId, projectId) {
  const c = (await store.getProject(orgId, projectId)).context;
  return (c.todo_items || []).map((t) => t.title).sort();
}

// ---------------------------------------------------------------------------
// 1. Read actions inside write-grouped tools need only context:read.
// ---------------------------------------------------------------------------

test('1: a viewer\'s read-only key lists the board and exports a Trail on /mcp and /mcp/claude, and still cannot write', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const V = await makePerson('viewer');
  await join(O, V, 'viewer');
  const T = O.orgId;
  const P = (await as('post', '/api/v1/context/projects', O, T).send({ project_name: `Viewer board ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  await as('patch', `/api/v1/context/projects/${P}/context`, O, T).send({ current_task: 'Owner task', add_todos: ['Card A', 'Card B'] });
  const readKey = await mintKey(V, T, ['context:read']);

  for (const path of ['/mcp', '/mcp/claude']) {
    // The Claude catalog's manage_tasks has no list action; it reads the board
    // through read_tasks, which it advertises and /mcp does not.
    const list = path === '/mcp'
      ? await mcpCall(readKey, T, 'manage_tasks', { action: 'list', project_id: P }, path)
      : await mcpCall(readKey, T, 'read_tasks', { project_id: P }, path);
    assert.equal(list.err, false, `${path} board listing with a read-only key: ${list.text}`);
    assert.match(list.text, /Card A/);
    assert.match(list.text, /Card B/);

    const trail = await mcpCall(readKey, T, 'manage_memory', { action: 'export_trail', project_id: P }, path);
    assert.equal(trail.err, false, `${path} export_trail is a read: ${trail.text}`);

    // Writes through the SAME tools are still refused by scope.
    const add = await mcpCall(readKey, T, 'manage_tasks', { action: 'add', project_id: P, todos: ['Viewer card'] }, path);
    assert.equal(add.err, true);
    assert.match(add.text, /insufficient_scope/);
    const upd = await mcpCall(readKey, T, 'manage_memory', { action: 'update', project_id: P, summary: 'Viewer decided to rewrite everything in Rust.' }, path);
    assert.equal(upd.err, true);
    assert.match(upd.text, /insufficient_scope/);
  }

  // A viewer holding a context:write key is refused by the workspace role.
  const writeKey = await mintKey(V, T);
  const roleAdd = await mcpCall(writeKey, T, 'manage_tasks', { action: 'add', project_id: P, todos: ['Viewer card'] });
  assert.equal(roleAdd.err, true, `a viewer's write must be refused: ${roleAdd.text}`);
  assert.deepEqual(await board(T, P), ['Card A', 'Card B']);
});

test('1: anybody\'s read-only key lists the board', async () => {
  const S = await makePerson('solo');
  const P = (await as('post', '/api/v1/context/projects', S).send({ project_name: `Solo board ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  await as('patch', `/api/v1/context/projects/${P}/context`, S).send({ add_todos: ['Solo card'] });
  const readKey = await mintKey(S, S.orgId, ['context:read']);
  const bare = await mcpCall(readKey, null, 'manage_tasks', { action: 'list', project_id: P });
  assert.equal(bare.err, false, bare.text);
  assert.match(bare.text, /Solo card/);
  const add = await mcpCall(readKey, null, 'manage_tasks', { action: 'add', project_id: P, todos: ['Nope'] });
  assert.match(add.text, /insufficient_scope/);
  assert.deepEqual(await board(S.orgId, P), ['Solo card']);
});

// ---------------------------------------------------------------------------
// 2. Emptying your own workspace does not take you out of anybody else's.
// ---------------------------------------------------------------------------

test('2: a member who empties their own workspace is still on the team roster, and their team key still works', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const teamKey = await mintKey(M, T);
  const shared = (await as('post', '/api/v1/context/projects', O, T).send({ project_name: `Team ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  await as('patch', `/api/v1/context/projects/${shared}/context`, O, T).send({ add_todos: ['Team card'] });
  // The member's own work: one project in their own workspace, and one
  // personal project inside the team.
  const own = (await as('post', '/api/v1/context/projects', M, M.orgId).send({ project_name: `Mine ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  const personalInTeam = (await as('post', '/api/v1/context/projects', M, T).send({ project_name: `M personal ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  const vis = await as('patch', `/api/v1/teams/projects/${personalInTeam}/sharing`, M, T).send({ visibility: 'personal' });
  assert.ok([200, 204].includes(vis.status), `visibility: ${vis.status} ${JSON.stringify(vis.body)}`);

  const erase = await as('delete', '/api/v1/context/account', M, M.orgId).send({ confirmation: 'DELETE MY DEERDAWN ACCOUNT' });
  assert.equal(erase.status, 200, `erase: ${erase.status} ${JSON.stringify(erase.body)}`);
  assert.deepEqual(erase.body.left_workspaces, []);
  assert.doesNotMatch(erase.body.message, /removed from/);

  // The emptied workspace is empty.
  assert.equal((await q('SELECT COUNT(*)::int AS n FROM context_projects WHERE project_id = $1', [own])).rows[0].n, 0);

  // The team membership is untouched.
  const member = (await q(
    'SELECT role, removed_at FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [T, M.userId],
  )).rows[0];
  assert.ok(member, 'the membership row survives');
  assert.equal(member.removed_at, null, 'and is not soft-removed');
  const roster = await as('get', '/api/v1/teams/members', O, T);
  assert.ok((roster.body.members || []).some((m) => m.email === M.email), 'the owner still sees them on the roster');

  // The team key still authenticates and still reaches the team's board.
  const status = (await q('SELECT status FROM api_keys WHERE owner_id = $1 AND org_id = $2', [M.userId, T])).rows;
  assert.ok(status.length && status.every((r) => r.status === 'active'), `team keys stay active: ${JSON.stringify(status)}`);
  const list = await mcpCall(teamKey, T, 'manage_tasks', { action: 'list', project_id: shared });
  assert.equal(list.err, false, list.text);
  assert.match(list.text, /Team card/);

  // Their personal project in the team is theirs, in a workspace they still
  // belong to: emptying a different workspace does not reach it.
  assert.equal((await q('SELECT owner_key FROM context_projects WHERE project_id = $1', [personalInTeam])).rows[0]?.owner_key, T);
});

// ---------------------------------------------------------------------------
// 3. Leaving a team is removing yourself.
// ---------------------------------------------------------------------------

test('3: a member leaves a team: removed there, keys there revoked, personal projects carried out, other teams untouched', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const O2 = await makePerson('owner2', { plan: 'developer_pro' });
  const M = await makePerson('member');
  const N = await makePerson('bystander');
  await join(O, M);
  await join(O, N);
  await join(O2, M);
  const T = O.orgId;
  const T2 = O2.orgId;
  const keyT = await mintKey(M, T);
  const keyT2 = await mintKey(M, T2);
  const personal = (await as('post', '/api/v1/context/projects', M, T).send({ project_name: `Leaving ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  await as('patch', `/api/v1/teams/projects/${personal}/sharing`, M, T).send({ visibility: 'personal' });
  const other = (await as('post', '/api/v1/context/projects', O2, T2).send({ project_name: `Other team ${uuidv4().slice(0, 6)}` })).body.project.project_id;
  await as('patch', `/api/v1/context/projects/${other}/context`, O2, T2).send({ add_todos: ['Other card'] });

  // Still owners-only for anybody else.
  const notYours = await as('delete', `/api/v1/teams/members/${N.userId}`, M, T);
  assert.equal(notYours.status, 403, JSON.stringify(notYours.body));

  const left = await as('delete', `/api/v1/teams/members/${M.userId}`, M, T);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.left, true);
  assert.equal(left.body.personal_projects_moved, 1);
  assert.equal(left.body.personal_projects_moved_to, M.orgId);

  const row = (await q('SELECT removed_at FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [T, M.userId])).rows[0];
  assert.ok(row?.removed_at, 'soft-removed from the team');
  const keysT = (await q('SELECT status FROM api_keys WHERE owner_id = $1 AND org_id = $2', [M.userId, T])).rows;
  assert.ok(keysT.length && keysT.every((k) => k.status === 'revoked'), 'their keys in the team are revoked');
  const refused = await mcpCall(keyT, T, 'manage_tasks', { action: 'list', project_id: other });
  assert.equal(refused.err, true, 'and stop authenticating');
  assert.equal((await q('SELECT owner_key FROM context_projects WHERE project_id = $1', [personal])).rows[0]?.owner_key, M.orgId);
  const audit = (await q(
    'SELECT actor_user_id FROM context_audit_logs WHERE owner_key = $1 AND action = \'member_left\'', [T],
  )).rows;
  assert.deepEqual(audit.map((r) => r.actor_user_id), [M.userId]);

  // The other team is untouched.
  const stillT2 = (await q('SELECT removed_at FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [T2, M.userId])).rows[0];
  assert.equal(stillT2?.removed_at, null);
  const list = await mcpCall(keyT2, T2, 'manage_tasks', { action: 'list', project_id: other });
  assert.equal(list.err, false, list.text);
  assert.match(list.text, /Other card/);
});

test('3: a viewer may leave; an owner may leave only while another owner remains', async () => {
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const V = await makePerson('viewer');
  const C = await makePerson('coowner');
  await join(O, V, 'viewer');
  const T = O.orgId;

  const viewerLeaves = await as('delete', `/api/v1/teams/members/${V.userId}`, V, T);
  assert.equal(viewerLeaves.status, 200, JSON.stringify(viewerLeaves.body));

  const soleOwner = await as('delete', `/api/v1/teams/members/${O.userId}`, O, T);
  assert.equal(soleOwner.status, 409, JSON.stringify(soleOwner.body));
  assert.equal(soleOwner.body.error, 'last_owner');
  assert.equal((await q('SELECT removed_at FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [T, O.userId])).rows[0]?.removed_at, null);

  await join(O, C, 'owner');
  const coOwnerLeaves = await as('delete', `/api/v1/teams/members/${C.userId}`, C, T);
  assert.equal(coOwnerLeaves.status, 200, JSON.stringify(coOwnerLeaves.body));
  // …which makes O the only owner again.
  const again = await as('delete', `/api/v1/teams/members/${O.userId}`, O, T);
  assert.equal(again.status, 409);
});

// ---------------------------------------------------------------------------
// 5. The no-project hint names the advertised tool that creates a project.
// ---------------------------------------------------------------------------

async function toolsList(key, path) {
  const r = await request(httpServer).post(path).set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  return (body.result?.tools || []).map((t) => t.name);
}

test('5: a brand-new account\'s first write is told to create a project, not to call start_session', async () => {
  const S = await makePerson('fresh');
  const key = await mintKey(S, S.orgId);
  for (const path of ['/mcp', '/mcp/claude']) {
    const advertised = await toolsList(key, path);
    assert.ok(advertised.includes('manage_projects') && advertised.includes('recall'), `${path} advertises what the hint names`);

    const update = await mcpCall(key, null, 'manage_memory', { action: 'update', summary: 'Decided to use Postgres for the ledger.' }, path);
    assert.equal(update.err, true, update.text);
    assert.match(update.text, /manage_projects\(action:"create", project_name:/);
    assert.doesNotMatch(update.text, /start_session first/);

    const question = await mcpCall(key, null, 'manage_memory', { action: 'resolve_question', question: 'Which queue?', answer: 'SQS' }, path);
    assert.equal(question.err, true, question.text);
    assert.match(question.text, /manage_projects\(action:"create", project_name:/);
    assert.doesNotMatch(question.text, /start_session first/);
  }
  // …and the hint works as written.
  const created = await mcpCall(key, null, 'manage_projects', { action: 'create', project_name: 'Ledger' });
  assert.equal(created.err, false, created.text);
});
