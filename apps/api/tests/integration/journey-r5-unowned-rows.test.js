/**
 * JOURNEY ROUND 5. A row that carries no person is credited to nobody.
 *
 * Older rows, and rows an internal job wrote, have no user id. In a workspace
 * with more than one person they were handed to every workspace owner: a
 * co-owner who had connected nothing read as connected and synced, the
 * activation events (first sync, connection) never fired for them, and their
 * "since your last session" was cut off by a load nobody made.
 *
 * Rule, the same one an unmatched git author follows (a blame email that matches
 * no member resolves to nobody, never to the importer): in a workspace that has
 * held more than one person, an unowned row counts for no individual, and it
 * shows as "workspace" where a name is displayed. A workspace that has only ever
 * held one person keeps reading its own legacy rows as that person's.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r5-unowned-rows.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const catchup = require('../../src/services/sessionCatchupService');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
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

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

// The person acting inside workspace `ws` (their own by default).
const actorOf = (person, ws = person.orgId) => ({ type: 'user', id: person.userId, org_id: ws, workspace_key: ws, role: 'admin' });

const healthOf = (res) => res.body.sync_health ?? (res.body.data && res.body.data.sync_health);

async function insertEvent(orgId, userId, eventName, source = 'api') {
  await db.query(
    `INSERT INTO product_events (event_id, event_name, org_id, user_id, source, surface, metadata)
     VALUES ($1, $2, $3, $4, $5, 'claude_code', '{}'::jsonb)`,
    [crypto.randomUUID(), eventName, orgId, userId, source],
    orgId,
  );
}

const countEvents = async (orgId, userId, name) => (await db.query(
  'SELECT COUNT(*)::int AS n FROM product_events WHERE org_id = $1 AND user_id = $2 AND event_name = $3',
  [orgId, userId, name],
  orgId,
)).rows[0].n;

// A workspace with a founder and a co-owner, whose only history is unowned.
async function teamWithOnlyUnownedHistory() {
  const O = await makePerson('r5un-o', { plan: 'developer_pro' });
  const C = await makePerson('r5un-c');
  const T = O.orgId;
  const P = await newProject(O, 'Legacy work');
  await join(O, C, 'owner');
  await insertEvent(T, null, 'mcp_start_session_succeeded', 'mcp');
  await insertEvent(T, null, 'first_sync_completed');
  await q('UPDATE context_projects SET owner_user_id = NULL WHERE owner_key = $1', [T]);
  return { O, C, T, P };
}

test('bootstrap: a co-owner who connected nothing does not read as connected, synced or briefed from unowned rows', async () => {
  const { O, C, T } = await teamWithOnlyUnownedHistory();
  for (const [who, person] of [['co-owner', C], ['founder', O]]) {
    const res = await as('get', '/api/v1/dashboard/bootstrap', person, T);
    assert.equal(res.status, 200, res.text);
    const health = healthOf(res);
    assert.ok(health, `no sync_health: ${Object.keys(res.body)}`);
    assert.equal(health.mcp_registered, false, `${who}: unowned MCP events were credited`);
    assert.equal(health.has_first_sync, false, `${who}: an unowned first sync was credited`);
    assert.equal(health.has_projects, false, `${who}: an unowned project was credited`);
  }
});

test('bootstrap: their own connection still counts, and a solo workspace still reads its legacy rows as its own', async () => {
  const { C, T } = await teamWithOnlyUnownedHistory();
  await insertEvent(T, C.userId, 'first_sync_completed');
  const res = await as('get', '/api/v1/dashboard/bootstrap', C, T);
  assert.equal(healthOf(res).has_first_sync, true);

  const solo = await makePerson('r5un-solo');
  await insertEvent(solo.orgId, null, 'first_sync_completed');
  const soloRes = await as('get', '/api/v1/dashboard/bootstrap', solo, solo.orgId);
  assert.equal(healthOf(soloRes).has_first_sync, true, 'a solo account is not reset');
});

test('activation: a co-owner\'s first sync and connection fire although unowned events exist; a solo account\'s do not repeat', async () => {
  const { C, T } = await teamWithOnlyUnownedHistory();
  await insertEvent(T, null, 'connection_established');
  const a = actorOf(C, T);
  assert.equal(await catchup.maybeEmitFirstSyncActivation(a, { tool: 'claude_code', projectId: null }), true,
    'THE BUG: an unowned first_sync_completed counted as the co-owner\'s');
  assert.equal(await catchup.maybeEmitConnectionEstablished(a, { tool: 'claude_code' }), true,
    'THE BUG: an unowned connection_established counted as the co-owner\'s');
  assert.equal(await countEvents(T, C.userId, 'first_sync_completed'), 1);
  assert.equal(await catchup.maybeEmitFirstSyncActivation(a, { tool: 'claude_code' }), false, 'once per person');

  const solo = await makePerson('r5un-solo2');
  await insertEvent(solo.orgId, null, 'first_sync_completed');
  await insertEvent(solo.orgId, null, 'connection_established');
  assert.equal(await catchup.maybeEmitFirstSyncActivation(actorOf(solo), { tool: 'claude_code' }), false, 'solo legacy rows still count');
  assert.equal(await catchup.maybeEmitConnectionEstablished(actorOf(solo), { tool: 'claude_code' }), false);
});

test('since-last-session: a load with no person is nobody\'s last session in a team', async () => {
  const { C, T, P } = await teamWithOnlyUnownedHistory();
  await store.recordSessionLoad(T, P, { userId: null });
  const load = await store.recordSessionLoad(T, P, { userId: C.userId, identities: [C.userId] });
  assert.equal(load.session_number, 1, 'THE BUG: an unowned load was counted as the co-owner\'s earlier session');
  assert.equal(load.last_session_at, null);
});

test('team_context_received: an entry with no author is not a colleague\'s work', async () => {
  const { C, T, P } = await teamWithOnlyUnownedHistory();
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [P, 'shared']);
  const context = { recent_decisions: [{ summary: 'use pgbouncer for the pool', decided_at: new Date().toISOString() }] };
  const result = await catchup.buildSessionCatchup(actorOf(C, T), { project_id: P, project_name: 'Legacy', context }, 'claude_code');
  assert.equal(result.team_delta, null);
  await new Promise((resolve) => setTimeout(resolve, 600));
  assert.equal(await countEvents(T, C.userId, 'team_context_received'), 0);
});

test('presence: a peer session with no person shows as "workspace"', async () => {
  const { C, T, P } = await teamWithOnlyUnownedHistory();
  await q(
    `INSERT INTO context_sessions (session_id, owner_key, user_id, tool, surface_type, project_id, status, routing_state, last_seen_at)
     VALUES ($1, $2, NULL, 'claude_code', 'cli', $3, 'active', 'matched', NOW())`,
    [`sess-${uuidv4()}`, T, P],
  );
  const peers = await service.getProjectPresence(actorOf(C, T), P, `self-${uuidv4()}`);
  assert.equal(peers.length, 1);
  assert.equal(peers[0].user_id, null);
  assert.equal(peers[0].display_name, 'workspace');
});

test('one rule everywhere: a workspace that once held two people credits unowned rows to nobody, whoever is left', async () => {
  const O = await makePerson('r5un-shrunk-o', { plan: 'developer_pro' });
  const M = await makePerson('r5un-shrunk-m');
  const T = O.orgId;
  await join(O, M);
  await insertEvent(T, null, 'mcp_start_session_succeeded', 'mcp');
  await insertEvent(T, null, 'first_sync_completed');
  await insertEvent(T, null, 'connection_established');
  // The member leaves: one ACTIVE member again, two roster rows.
  const left = await as('delete', `/api/v1/teams/members/${M.userId}`, M, T);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(await workspace.countActiveMembers(T), 1, 'precondition: one active member');

  // The dashboard and the emitters agree: the unowned rows are nobody's.
  const res = await as('get', '/api/v1/dashboard/bootstrap', O, T);
  const health = healthOf(res);
  assert.equal(health.has_first_sync, false, 'THE INCONSISTENCY: bootstrap counted unowned rows for the survivor');
  assert.equal(health.mcp_registered, false);
  const a = actorOf(O, T);
  assert.equal(await catchup.maybeEmitFirstSyncActivation(a, { tool: 'claude_code' }), true);
  assert.equal(await catchup.maybeEmitConnectionEstablished(a, { tool: 'claude_code' }), true);
  // And once emitted, neither repeats and the dashboard now shows the person's own.
  assert.equal(await catchup.maybeEmitFirstSyncActivation(a, { tool: 'claude_code' }), false, 'never a duplicate');
  assert.equal(await catchup.maybeEmitConnectionEstablished(a, { tool: 'claude_code' }), false);
  assert.equal(healthOf(await as('get', '/api/v1/dashboard/bootstrap', O, T)).has_first_sync, true);
});
