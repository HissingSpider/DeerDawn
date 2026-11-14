/**
 * SCAN 26 (b).
 *
 *   1. MEDIUM: emptying a workspace (DELETE /context/account, workspaceOnly +
 *      keepMembers) deleted every roster row but the caller's, TOMBSTONES
 *      included. A legacy-removed member — somebody whose users.org_id is still
 *      the team, removed without being re-homed — was barred only by that
 *      removed row. With it gone, resolveRole's own-org fallback read their org
 *      role (admin -> owner) and let them straight back in as an OWNER of the
 *      workspace they had been removed from, and the boot backfill would have
 *      re-inserted them as one. The purge now keeps removed rows, and the
 *      fallback itself refuses anybody the workspace has a removed row for.
 *   2. LOW: a key actor's org_id is the key's WORKSPACE, not the person's own.
 *      /teams/active and /teams/workspaces read it as the person's personal
 *      workspace, so a key minted in team T could not select T (POST /active
 *      {workspace: T} cleared the choice instead), GET /workspaces labelled T
 *      personal:true, and GET /active answered personal_workspace: T.
 *   3. LOW: the read-only-key refusal on /teams names the way out for somebody
 *      leaving (the dashboard) rather than only "get a write key" — viewers are
 *      only ever minted read-only keys.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan26-b-fixes.test.js
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
const EMPTY = { confirmation: 'DELETE MY DEERDAWN ACCOUNT' };

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

function asKey(method, path, key, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${key}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const roster = async (ws) => (await q(
  'SELECT user_id, role, removed_at IS NOT NULL AS removed FROM workspace_members WHERE owner_key = $1',
  [ws],
)).rows;

// ── 1. Emptying a workspace must not resurrect a removed member ──────────────

test('1: emptying a workspace keeps a legacy-removed member removed (no owner resurrection)', async () => {
  const O = await makePerson('s26b-o', { plan: 'developer_pro' });
  const T = O.orgId;
  const L = await makePerson('s26b-l', { plan: 'developer_pro' });
  await join(O, L, 'member');
  // The legacy population: L's users.org_id IS the team, and L was removed
  // without being re-homed (the pre-rehome removal path).
  await q('UPDATE users SET org_id = $1 WHERE user_id = $2', [T, L.userId]);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [T, L.userId]);
  L.jwt = generateToken({ user_id: L.userId, org_id: T, role: 'admin', email: L.email });

  const before = await as('get', '/api/v1/context/projects', L);
  assert.equal(before.status, 403, `a removed member is barred before the empty: ${JSON.stringify(before.body)}`);

  const emptied = await as('delete', '/api/v1/context/account', O, T).send(EMPTY);
  assert.equal(emptied.status, 200, JSON.stringify(emptied.body));

  // The tombstone survives; the caller's own owner row too.
  const rows = await roster(T);
  const lRow = rows.find((r) => r.user_id === L.userId);
  assert.ok(lRow, 'the removed member\'s tombstone must survive the empty');
  assert.equal(lRow.removed, true);
  const oRow = rows.find((r) => r.user_id === O.userId);
  assert.ok(oRow && !oRow.removed && oRow.role === 'owner', 'the caller stays the owner');

  const after = await as('get', '/api/v1/context/projects', L);
  assert.equal(after.status, 403, `still barred after the empty: ${after.status} ${JSON.stringify(after.body)}`);
  const members = await as('get', '/api/v1/teams/members', L);
  assert.notEqual(members.status, 200, 'a removed member must not read the roster');

  // resolveRole's own-org fallback is the root cause: it must not grant the
  // org role to somebody this workspace removed.
  const role = await workspace.resolveRole({ type: 'user', id: L.userId, org_id: T, role: 'admin' }, T);
  assert.notEqual(role, 'owner');
  assert.equal(workspace.canWrite(role), false, `removed person resolved to ${role}`);

  // And a restart's backfill does not re-add them.
  await workspace.backfillMembershipsFromUsers();
  const again = (await roster(T)).find((r) => r.user_id === L.userId);
  assert.equal(again.removed, true, 'the boot backfill must not re-admit a removed member');
});

test('1c: resolveRole never reads the org role for somebody the workspace removed (root cause, no purge involved)', async () => {
  const O = await makePerson('s26b-o3', { plan: 'developer_pro' });
  const L = await makePerson('s26b-l3', { plan: 'developer_pro' });
  await join(O, L, 'member');
  await q('UPDATE users SET org_id = $1 WHERE user_id = $2', [O.orgId, L.userId]);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [O.orgId, L.userId]);
  const role = await workspace.resolveRole({ type: 'user', id: L.userId, org_id: O.orgId, role: 'admin' }, O.orgId);
  assert.equal(workspace.canAdminister(role), false, `removed member resolved to ${role}`);
  assert.equal(workspace.canWrite(role), false, `removed member resolved to ${role}`);
});

test('1b: resolveRole fallback still admits a person to their own org with no row at all', async () => {
  const P = await makePerson('s26b-solo');
  await q('DELETE FROM workspace_members WHERE owner_key = $1', [P.orgId]);
  const role = await workspace.resolveRole({ type: 'user', id: P.userId, org_id: P.orgId, role: 'admin' }, P.orgId);
  assert.equal(role, 'owner');
});

// ── 2. A key's workspace is not the person's personal workspace ──────────────

test('2: a key minted in a team can select that team, and the team is never labelled personal', async () => {
  const O = await makePerson('s26b-ko', { plan: 'developer_pro' });
  const T = O.orgId;
  const M = await makePerson('s26b-km');
  await join(O, M, 'member');
  const key = await mintKey(M, T, ['context:read', 'context:write']);

  const set = await asKey('post', '/api/v1/teams/active', key).send({ workspace: T });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.equal(set.body.active_workspace, T, 'selecting the key\'s team must select it, not clear the choice');

  const read = await asKey('get', '/api/v1/teams/active', key);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.active_workspace, T);
  assert.equal(read.body.personal_workspace, M.orgId, 'personal_workspace is the person\'s own org, not the key\'s');

  const list = await asKey('get', '/api/v1/teams/workspaces', key);
  assert.equal(list.status, 200, JSON.stringify(list.body));
  const team = list.body.workspaces.find((w) => w.workspace === T);
  const mine = list.body.workspaces.find((w) => w.workspace === M.orgId);
  assert.ok(team, 'the team is listed');
  assert.equal(team.personal, false, 'the key\'s team must not be labelled personal');
  assert.equal(team.role, 'member');
  assert.ok(mine && mine.personal === true, 'the person\'s own workspace is the personal one');
  assert.equal(list.body.active, T, 'a header-less key request is bound to the key\'s workspace');

  // Choosing the person's own workspace is "go home": the choice is cleared.
  const home = await asKey('post', '/api/v1/teams/active', key).send({ workspace: M.orgId });
  assert.equal(home.status, 200, JSON.stringify(home.body));
  assert.equal(home.body.active_workspace, null);
  assert.equal(await workspace.getActiveWorkspace({ type: 'user', id: M.userId, org_id: M.orgId }), null);
});

test('2b: a session actor is unchanged — its own org is still personal', async () => {
  const P = await makePerson('s26b-sess');
  const r = await as('get', '/api/v1/teams/active', P);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.personal_workspace, P.orgId);
  assert.equal(await workspace.personalWorkspaceKey({ type: 'user', id: P.userId, org_id: P.orgId }), P.orgId);
});

// ── 3. A viewer's read-only key cannot leave, and the refusal says where to ──

test('3: a read-only key leaving is refused with the way out; the dashboard session still leaves', async () => {
  const O = await makePerson('s26b-vo', { plan: 'developer_pro' });
  const T = O.orgId;
  const V = await makePerson('s26b-vv');
  await join(O, V, 'viewer');
  const ro = await mintKey(V, T, ['context:read']);

  const leave = await asKey('delete', `/api/v1/teams/members/${V.userId}`, ro, T);
  assert.equal(leave.status, 403, JSON.stringify(leave.body));
  assert.equal(leave.body.error, 'insufficient_scope');
  assert.match(leave.body.message, /dashboard \(Settings → Team\)/);
  assert.match(leave.body.message, /write scope/);

  // Any other write keeps the general refusal.
  const other = await asKey('post', '/api/v1/teams/active', ro).send({ workspace: null });
  assert.equal(other.status, 403);
  assert.doesNotMatch(other.body.message, /Settings → Team/);

  // Still a member: the refusal changed nothing.
  assert.ok(await workspace.getMembership(T, V.userId));

  // The way out it names works for a viewer.
  const viaSession = await as('delete', `/api/v1/teams/members/${V.userId}`, V, T);
  assert.equal(viaSession.status, 200, JSON.stringify(viaSession.body));
  assert.equal(await workspace.getMembership(T, V.userId), null);
});

// ── 4. Closing an account closes ONE account ─────────────────────────────────

const authMiddleware = require('../../src/middleware/auth');

// A stand-in Clerk client that records which logins were deleted. Token
// verification through it fails (there is no Clerk secret), so requests still
// authenticate by the local JWT exactly as they do without it.
async function withClerkSpy(fn) {
  const adapter = authMiddleware._authAdapter;
  const saved = adapter.clerk;
  const deleted = [];
  adapter.clerk = {
    users: {
      deleteUser: async (subject) => { deleted.push(subject); return {}; },
      getUser: async () => { throw new Error('no clerk in tests'); },
    },
  };
  try {
    await fn(deleted);
  } finally {
    adapter.clerk = saved;
  }
  return deleted;
}

test('4: DELETE /orgs re-homes a legacy-removed member pointing at the org instead of deleting their account', async () => {
  const F = await makePerson('s26b-close-f', { plan: 'developer_pro' });
  const T = F.orgId;
  const L = await makePerson('s26b-close-l');
  const Lhome = L.orgId;
  await join(F, L, 'member');
  // L has a life outside T: a project in their own former workspace, and a
  // membership in somebody else's team.
  const Other = await makePerson('s26b-close-x', { plan: 'developer_pro' });
  await join(Other, L, 'member');
  // The legacy population: L's users.org_id IS the team, a Clerk login, and
  // removed from T without being re-homed.
  const subject = `user_clerk_${uuidv4().slice(0, 8)}`;
  await q('UPDATE users SET org_id = $1, auth_provider = $2, auth_subject = $3 WHERE user_id = $4', [T, 'clerk', subject, L.userId]);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [T, L.userId]);

  let res;
  const clerkDeleted = await withClerkSpy(async () => {
    res = await as('delete', '/api/v1/orgs', F).send({ password: 'password123' });
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // The caller is gone, and their org.
  assert.equal((await q('SELECT 1 FROM users WHERE user_id = $1', [F.userId])).rows.length, 0);
  assert.equal((await q('SELECT 1 FROM organizations WHERE org_id = $1', [T])).rows.length, 0);

  // L is not: a users row, in a fresh workspace that is theirs, their Clerk
  // login untouched, and their membership elsewhere intact.
  const lRow = (await q('SELECT org_id, role FROM users WHERE user_id = $1', [L.userId])).rows[0];
  assert.ok(lRow, 'a removed member\'s account must survive somebody else closing theirs');
  assert.notEqual(lRow.org_id, T);
  assert.ok((await q('SELECT 1 FROM organizations WHERE org_id = $1', [lRow.org_id])).rows.length, 'the new home exists');
  const own = await workspace.getMembership(lRow.org_id, L.userId);
  assert.equal(own?.role, 'owner', 'they own their new workspace');
  assert.ok(await workspace.getMembership(Other.orgId, L.userId), 'their membership in another team is untouched');
  assert.ok(await workspace.getMembership(Lhome, L.userId), 'their original workspace membership is untouched');
  assert.ok(!clerkDeleted.includes(subject), `L's Clerk login must not be deleted (deleted: ${clerkDeleted})`);
});

test('4b: DELETE /orgs refuses while a CURRENT legacy member (users.org_id = the org) is on the roster', async () => {
  const F = await makePerson('s26b-close-f2', { plan: 'developer_pro' });
  const T = F.orgId;
  const M = await makePerson('s26b-close-m2');
  await join(F, M, 'member');
  await q('UPDATE users SET org_id = $1 WHERE user_id = $2', [T, M.userId]);
  const res = await as('delete', '/api/v1/orgs', F).send({ password: 'password123' });
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, 'workspace_has_members');
  assert.ok((await q('SELECT 1 FROM users WHERE user_id = $1', [M.userId])).rows.length);
  assert.ok((await q('SELECT 1 FROM users WHERE user_id = $1', [F.userId])).rows.length);
});

// ── 5. A key's own workspace is not its holder's own account ────────────────

test('5: a key minted in a team whose holder has no row there any more cannot write to it', async () => {
  const O = await makePerson('s26b-cap-o', { plan: 'developer_pro' });
  const T = O.orgId;
  const N = await makePerson('s26b-cap-n');
  await join(O, N, 'viewer');
  const key = await mintKey(N, T, ['context:read', 'context:write']);
  await q('DELETE FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [T, N.userId]);

  const write = await asKey('post', '/api/v1/context/projects', key).send({ project_name: `s26b cap ${uuidv4().slice(0, 4)}` });
  assert.equal(write.status, 403, `no row in the team must not read as owning it: ${write.status} ${JSON.stringify(write.body)}`);
  const role = await workspace.resolveRole({ type: 'key', id: 'key-x', owner_id: N.userId, org_id: T, role: 'operator' }, T);
  assert.equal(workspace.canWrite(role), false, `resolved to ${role}`);
});

test('5b: a key in the holder\'s OWN org with no row there (pre-backfill) keeps its scopes', async () => {
  const P = await makePerson('s26b-cap-p');
  await q('DELETE FROM workspace_members WHERE owner_key = $1', [P.orgId]);
  const key = await mintKey(P, P.orgId, ['context:read', 'context:write']);
  const write = await asKey('post', '/api/v1/context/projects', key).send({ project_name: `s26b own ${uuidv4().slice(0, 4)}` });
  assert.equal(write.status, 201, JSON.stringify(write.body));
});
