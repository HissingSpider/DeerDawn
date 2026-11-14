/**
 * SCAN 25 (b).
 *
 *   1. HIGH (round-24 regression): DELETE /context/account ("empty my
 *      workspace") swept workspace_members and took the CALLER'S OWN owner row
 *      with it. The owner kept working through resolveRole's own-workspace
 *      fallback while every count of the workspace's people was one short: the
 *      next invitee was the whole roster, solo-era projects never flipped to
 *      personal (so a new co-owner read them), the co-owner could neither leave
 *      nor be demoted (last_owner), and a SECOND empty with a teammate aboard
 *      answered 200 and erased the teammate's project, keys and roster row.
 *   2. MEDIUM: POST /teams/projects/:id/move checked only authorship, so a
 *      member carried a SHARED team project — the owner's decisions and cards
 *      in it — into their personal workspace. A non-owner may move only a
 *      personal project they wrote; shared and private need a workspace owner.
 *   3. MEDIUM: the teams router checked no scopes, so a read-only key could
 *      leave the team (revoking every key), and an owner's could remove, re-role,
 *      invite, re-share and move. Non-GET teams routes need a write-granted key.
 *   4. LOW: leaving wrote the same record an owner removal does, so the domain
 *      door refused a leaver with "You were removed". left_voluntarily splits
 *      the two; only an owner removal bars the door.
 *   5. LOW: a read over MCP (manage_tasks list) filed an mcp_tool_write audit
 *      row and touched the hosted session. Both are now keyed on callWrites.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan25-b-fixes.test.js
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
const EMPTY = { confirmation: 'DELETE MY DEERDAWN ACCOUNT' };

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free', domain = 'e2e.test' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@${domain}`;
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

// The dashboard's own path: invite over REST, accept over REST.
async function inviteAndAccept(owner, ws, joiner, role) {
  const inv = await as('post', '/api/v1/teams/invite', owner, ws).send({ email: joiner.email, role });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const token = new URL(inv.body.invite_link).searchParams.get('token');
  const acc = await as('post', '/api/v1/teams/invite/accept', joiner).send({ token });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

function asKey(method, path, key, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${key}`);
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

const rosterOf = async (owner, ws) => {
  const r = await as('get', '/api/v1/teams/members', owner, ws);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return (r.body.members || []).filter((m) => m.status === 'active').map((m) => [m.id, m.role]).sort();
};

// ─── 1. Emptying the workspace keeps the person emptying it ─────────────────

test('1a: after an empty, the owner is still on the roster and a new co-owner behaves as one (p28)', async () => {
  const O = await makePerson('own28', { plan: 'developer_pro' });
  const T = O.orgId;
  const emptied = await as('delete', '/api/v1/context/account', O, T).send(EMPTY);
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body));
  const row = await workspace.getMembership(T, O.userId);
  assert.equal(row?.role, 'owner', 'the owner who emptied the workspace keeps an active owner row');

  // Solo-era work, then the first teammate — a co-owner.
  const P = (await as('post', '/api/v1/context/projects', O, T).send({ project_name: 'Solo-era secret' })).body.project;
  await as('patch', `/api/v1/context/projects/${P.project_id}/context`, O, T).send({ current_task: 'secret owner task' });
  const C = await makePerson('co28');
  await inviteAndAccept(O, T, C, 'owner');

  assert.deepEqual(await rosterOf(O, T), [[C.userId, 'owner'], [O.userId, 'owner']].sort(),
    'both owners are on the roster');
  assert.equal((await store.getProject(T, P.project_id)).visibility, 'personal',
    'the 1->2 join flips solo-era work to personal, as it does for any founder');
  const ckey = await mintKey(C, T);
  const read = await mcpCall(ckey, T, 'recall', { action: 'context', project_id: P.project_id });
  assert.ok(!/secret owner task/.test(read.text), `the new co-owner must not read the solo-era project: ${read.text.slice(0, 200)}`);

  // The co-owner is not the last owner: O can demote them, and they can leave.
  const demote = await as('patch', `/api/v1/teams/members/${C.userId}`, O, T).send({ role: 'member' });
  assert.equal(demote.status, 200, JSON.stringify(demote.body));
  const leave = await as('delete', `/api/v1/teams/members/${C.userId}`, C, T);
  assert.equal(leave.status, 200, JSON.stringify(leave.body));
});

test('1b: a second empty with a teammate aboard is refused, as it is without the first (p36)', async () => {
  const O = await makePerson('ownE', { plan: 'developer_pro' });
  const T = O.orgId;
  assert.equal((await as('delete', '/api/v1/context/account', O, T).send(EMPTY)).status, 200);
  const M = await makePerson('mem36');
  await inviteAndAccept(O, T, M, 'member');
  const mkey = await mintKey(M, T);
  const created = await mcpCall(mkey, T, 'manage_projects', { action: 'create', project_name: 'Member shared work' });
  assert.equal(created.err, false, created.text);
  const row = (await q('SELECT project_id, visibility FROM context_projects WHERE project_name = $1 AND owner_key = $2', ['Member shared work', T])).rows[0];
  // Round 4: a project a tool creates in a team starts personal (the owner's
  // decision). The member shares it, as the create reply tells them to, so
  // this is still the team's shared work the empty must not take.
  assert.equal(row.visibility, 'personal', 'a project a tool creates in a two-person workspace starts personal');
  const shared = await as('patch', `/api/v1/teams/projects/${row.project_id}/sharing`, M, T).send({ visibility: 'shared' });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));

  const second = await as('delete', '/api/v1/context/account', O, T).send(EMPTY);
  assert.equal(second.status, 409, JSON.stringify(second.body));
  assert.equal(second.body.error, 'workspace_has_members');
  assert.equal((await q('SELECT count(*)::int AS n FROM context_projects WHERE project_id = $1', [row.project_id])).rows[0].n, 1,
    'the teammate project survives');
  const again = await mcpCall(mkey, T, 'start_session', {});
  assert.equal(again.err, false, `the teammate's key still works: ${again.text.slice(0, 200)}`);
});

test('1c: a founder missing from a roster that has rows is restored before the empty is gated, so it is refused', async () => {
  const O = await makePerson('ownRowless', { plan: 'developer_pro' });
  const M = await makePerson('memRowless');
  await join(O, M);
  // The pre-fix end state, however it is reached: the founder's row is gone.
  await q('DELETE FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [O.orgId, O.userId]);
  const r = await as('delete', '/api/v1/context/account', O, O.orgId).send(EMPTY);
  assert.equal(r.status, 409, JSON.stringify(r.body));
});

// ─── 2. A member cannot carry the team's work out of the team ────────────────

test('2: a member may move out only their own personal project; shared and private need an owner (p31)', async () => {
  const O = await makePerson('own31', { plan: 'developer_pro' });
  const M = await makePerson('mem31');
  await join(O, M);
  const T = O.orgId;
  const created = await as('post', '/api/v1/context/projects', M, T).send({ project_name: 'Team Shared By M' });
  const P = created.body.project.project_id;
  assert.equal(created.body.project.visibility, 'shared');
  const okey = await mintKey(O, T);
  await mcpCall(okey, T, 'manage_memory', { action: 'update', project_id: P, task: 'Owner task', summary: 'Owner decided to use Temporal for workflows.' });

  const shared = await as('post', `/api/v1/teams/projects/${P}/move`, M, T).send({ workspace: M.orgId });
  assert.equal(shared.status, 403, JSON.stringify(shared.body));
  assert.equal(shared.body.error, 'owner_required_to_move');
  assert.equal((await q('SELECT owner_key FROM context_projects WHERE project_id = $1', [P])).rows[0].owner_key, T);
  assert.deepEqual((await as('get', '/api/v1/context/projects', O, T)).body.projects.map((p) => p.project_id), [P]);

  // Private: org-owned work an owner reads. Also an owner's call.
  const P2 = (await as('post', '/api/v1/context/projects', M, T).send({ project_name: 'M Private' })).body.project.project_id;
  assert.equal((await as('patch', `/api/v1/teams/projects/${P2}/sharing`, M, T).send({ visibility: 'private' })).status, 200);
  const priv = await as('post', `/api/v1/teams/projects/${P2}/move`, M, T).send({ workspace: M.orgId });
  assert.equal(priv.status, 403, JSON.stringify(priv.body));

  // Personal: nobody else could read it, so it is the author's to take home.
  const P3 = (await as('post', '/api/v1/context/projects', M, T).send({ project_name: 'M Personal' })).body.project.project_id;
  assert.equal((await as('patch', `/api/v1/teams/projects/${P3}/sharing`, M, T).send({ visibility: 'personal' })).status, 200);
  const personal = await as('post', `/api/v1/teams/projects/${P3}/move`, M, T).send({ workspace: M.orgId });
  assert.equal(personal.status, 200, JSON.stringify(personal.body));

  // And an owner moving their own shared project out of the workspace still can.
  const OwnerTeam = await makeOrg('own31-second', 'developer_pro');
  await workspace.ensureOwnerMembership(OwnerTeam, O.userId);
  const P4 = (await as('post', '/api/v1/context/projects', O, T).send({ project_name: 'Owner Shared' })).body.project.project_id;
  const byOwner = await as('post', `/api/v1/teams/projects/${P4}/move`, O, T).send({ workspace: OwnerTeam });
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
});

// ─── 3. A read-only key changes nothing through /teams ───────────────────────

test('3: a read-only key cannot leave, remove, re-role, invite, share or move; a write key still can', async () => {
  const O = await makePerson('own3', { plan: 'developer_pro' });
  const M = await makePerson('mem3');
  const V = await makePerson('vie3');
  await join(O, M);
  await join(O, V);
  const T = O.orgId;
  const P = (await as('post', '/api/v1/context/projects', O, T).send({ project_name: 'Scope Proj' })).body.project.project_id;

  // probe1 A: the member's read-only key took them off the team.
  const mRead = await mintKey(M, T, ['context:read']);
  const leave = await asKey('delete', `/api/v1/teams/members/${M.userId}`, mRead, T);
  assert.equal(leave.status, 403, JSON.stringify(leave.body));
  assert.equal(leave.body.error, 'insufficient_scope');
  assert.ok(await workspace.getMembership(T, M.userId), 'still a member');
  const live = (await q('SELECT count(*)::int AS n FROM api_keys WHERE owner_id = $1 AND org_id = $2 AND status = $3', [M.userId, T, 'active'])).rows[0].n;
  assert.equal(live, 1, 'no key was revoked');

  // The owner's read-only key administers nothing.
  const oRead = await mintKey(O, T, ['context:read']);
  const refused = [
    await asKey('delete', `/api/v1/teams/members/${V.userId}`, oRead, T),
    await asKey('patch', `/api/v1/teams/members/${V.userId}`, oRead, T).send({ role: 'viewer' }),
    await asKey('post', '/api/v1/teams/invite', oRead, T).send({ email: `x-${uuidv4().slice(0, 8)}@e2e.test`, role: 'member' }),
    await asKey('patch', `/api/v1/teams/projects/${P}/sharing`, oRead, T).send({ visibility: 'private' }),
    await asKey('post', `/api/v1/teams/projects/${P}/move`, oRead, T).send({ workspace: M.orgId }),
  ];
  assert.deepEqual(refused.map((r) => r.status), [403, 403, 403, 403, 403], JSON.stringify(refused.map((r) => r.body)));
  assert.equal((await workspace.getMembership(T, V.userId))?.role, 'member', 'the teammate is untouched');
  // Reads still work on the read-only key.
  assert.equal((await asKey('get', '/api/v1/teams/members', oRead, T)).status, 200);

  // A write key: the owner removes V, and M leaves on their own.
  const oWrite = await mintKey(O, T);
  assert.equal((await asKey('delete', `/api/v1/teams/members/${V.userId}`, oWrite, T)).status, 200);
  const mWrite = await mintKey(M, T);
  const left = await asKey('delete', `/api/v1/teams/members/${M.userId}`, mWrite, T);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.left, true);
});

// ─── 4. Leaving is not being removed: the domain door readmits a leaver ──────

test('4: after a voluntary leave the domain door readmits; after an owner removal it still refuses', async () => {
  const domain = `dd25-${uuidv4().slice(0, 6)}.example`;
  const O = await makePerson('own4', { plan: 'developer_pro', domain });
  const T = O.orgId;
  const added = await as('post', '/api/v1/teams/domains', O, T).send({ domain, role: 'member' });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const offered = async (person) => (await as('get', '/api/v1/teams/joinable', person)).body.joinable
    .some((o) => o.workspace === T);
  const accept = (person) => as('post', `/api/v1/teams/joinable/${T}/accept`, person).send({});

  const L = await makePerson('leaver4', { domain });
  assert.equal((await accept(L)).status, 200);
  const left = await as('delete', `/api/v1/teams/members/${L.userId}`, L, T);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(await offered(L), true, 'somebody who left is offered the team again');
  const back = await accept(L);
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal((await workspace.getMembership(T, L.userId))?.role, 'member');

  // Leave, rejoin, then an owner removes them: that removal is the owner's
  // decision and the rejoin must not have left it marked voluntary.
  assert.equal((await as('delete', `/api/v1/teams/members/${L.userId}`, O, T)).status, 200);
  assert.equal(await offered(L), false);
  const refused = await accept(L);
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error, 'removed_from_workspace');
});

// ─── 5. A read over MCP leaves no write behind ───────────────────────────────

test('5: a read call files no mcp_tool_write audit row and touches no session; a write does both', async () => {
  const O = await makePerson('own5', { plan: 'developer_pro' });
  const T = O.orgId;
  const P = (await as('post', '/api/v1/context/projects', O, T).send({ project_name: 'Audit Proj' })).body.project.project_id;
  const audits = async () => (await q(
    'SELECT count(*)::int AS n FROM context_audit_logs WHERE owner_key = $1 AND action = $2',
    [T, 'mcp_tool_write'],
  )).rows[0].n;
  const sessions = async () => (await q(
    'SELECT count(*)::int AS n, max(last_seen_at) AS seen FROM context_sessions WHERE owner_key = $1',
    [T],
  )).rows[0];

  // The listing from the probe: a read-only key.
  const rkey = await mintKey(O, T, ['context:read']);
  const listed = await mcpCall(rkey, T, 'manage_tasks', { action: 'list', project_id: P });
  assert.equal(listed.err, false, listed.text);
  assert.equal(await audits(), 0, 'a listing is not audited as a write');

  // The session touch, on one credential so it is one hosted session: opened by
  // start_session, left alone by a read, refreshed by a write.
  const wkey = await mintKey(O, T);
  assert.equal((await mcpCall(wkey, T, 'start_session', { project_id: P })).err, false);
  const opened = await sessions();
  assert.ok(opened.n >= 1, 'start_session opens the hosted session');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal((await mcpCall(wkey, T, 'manage_tasks', { action: 'list', project_id: P })).err, false);
  assert.deepEqual(await sessions(), opened, 'a listing does not touch the hosted session');
  assert.equal(await audits(), 0);

  const added = await mcpCall(wkey, T, 'manage_tasks', { action: 'add', project_id: P, todos: ['Audit card'] });
  assert.equal(added.err, false, added.text);
  assert.equal(await audits(), 1, 'a write is audited');
  assert.ok(new Date((await sessions()).seen) > new Date(opened.seen), 'a write touches the hosted session');
});
