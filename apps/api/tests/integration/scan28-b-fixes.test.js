/**
 * SCAN 28 (b).
 *
 *   HIGH (privacy): manage_memory(action:"upsert_entities") ignored its
 *   TOP-LEVEL project_id. The hosted dispatcher handed the service only
 *   { entities, relations }, and the service files an entity with no project_id
 *   of its own at WORKSPACE scope — so a member who wrote a career decision and
 *   a salary figure "into" their personal project served both to the owner and
 *   every other member through recall(entities), recall(search) and
 *   GET /workspace/entities. Omitting project_id did not use the active project
 *   either, whatever the schema said. Now an entity naming no project of its own
 *   is filed under the top-level project_id or, omitted, the active project;
 *   only an explicit scope:"workspace" keeps one out of every project.
 *
 *   LOW: a decision upsert with status "active" naming project B, on a node
 *   filed under A, returned early into the brief-only reopen and dropped the
 *   summary/metadata changes it carried behind "Upserted". They are now applied
 *   to the node when the caller may change it, and named when not.
 *
 *   MEDIUM: closing an account cancelled each side workspace's subscription
 *   BEFORE taking its membership lock, so somebody joining in between made
 *   DELETE /orgs answer 409 with the team alive and its subscription already
 *   cancelled (every retry then refused as sole_owner), and made the Clerk
 *   user.deleted webhook leave the team alive, unbilled. The workspace is now
 *   marked closing under the lock before any billing call, and addMember
 *   refuses a marked workspace.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan28-b-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
// A configured Stripe client, so cancelSubscriptionForDeletion reaches the
// (stubbed) API instead of answering stripe_not_configured. Before any require.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_scan28b';
process.env.CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET || 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const request = require('supertest');
const { Webhook } = require('svix');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { createTeamWorkspaceFixture } = require('../helpers/teamWorkspaceFixture');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const stripeService = require('../../src/services/stripeService');
const webhookRouter = require('../../src/routes/auth-webhooks');

const q = (sql, params) => db.query(sql, params, 'org-system');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RUN = uuidv4().slice(0, 6);

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

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

// An owner, two members, and one of the members' PERSONAL project.
async function team(label) {
  const O = await makePerson(`${label}-o`, { plan: 'developer_pro' });
  const M = await makePerson(`${label}-m`);
  const M2 = await makePerson(`${label}-m2`);
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const keys = { O: await mintKey(O, T), M: await mintKey(M, T), M2: await mintKey(M2, T) };
  const Pm = await newProject(M, 'Mine', T);
  const shared = await as('patch', `/api/v1/teams/projects/${Pm}/sharing`, M, T).send({ visibility: 'personal' });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  return { O, M, M2, T, keys, Pm };
}

const stored = async (ownerKey, marker) => (await q(
  `SELECT title, project_id, metadata->>'scope' AS scope FROM context_graph_nodes
   WHERE owner_key = $1 AND title ILIKE $2 ORDER BY created_at`,
  [ownerKey, `%${marker}%`],
)).rows;

// Nobody but the author reads the entities, through any of the three doors.
async function assertOnlyAuthorSees(t, marker, catalog) {
  const { O, T, keys } = t;
  for (const who of ['O', 'M2']) {
    const entities = await mcpCall(keys[who], T, 'recall', { action: 'entities', query: marker }, catalog);
    assert.doesNotMatch(entities.text, new RegExp(marker), `${who} recall entities: ${entities.text}`);
    const search = await mcpCall(keys[who], T, 'recall', { action: 'search', query: marker }, catalog);
    assert.doesNotMatch(search.text, new RegExp(marker), `${who} recall search: ${search.text}`);
  }
  const rest = await as('get', `/api/v1/context/workspace/entities?query=${marker}`, O, T);
  assert.equal(rest.status, 200);
  assert.deepEqual((rest.body.entities || []).filter((e) => e.title.includes(marker)).map((e) => e.title), [], 'owner REST');
  const mine = await mcpCall(keys.M, T, 'recall', { action: 'entities', query: marker }, catalog);
  assert.match(mine.text, new RegExp(marker), `the author still reads their own: ${mine.text}`);
}

// ── 1. The top-level project_id files the entities ──────────────────────────

for (const catalog of ['/mcp', '/mcp/claude']) {
  test(`1${catalog === '/mcp' ? 'a' : 'b'}: upsert_entities with a top-level project_id files into that project, not the workspace (${catalog}, p59)`, async () => {
    const t = await team(`s28b1${catalog === '/mcp' ? 'a' : 'b'}`);
    const marker = `Globex${RUN}${catalog.length}`;
    const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
      action: 'upsert_entities', project_id: t.Pm,
      entities: [
        { entity_type: 'decision', title: `Decided to interview with ${marker} before telling the team`, summary: 'Personal career decision, do not share.' },
        { entity_type: 'knowledge', title: `Salary band for the ${marker} offer is 180k`, summary: 'Recruiter said 180k base.' },
      ],
    }, catalog);
    assert.equal(r.err, false, r.text);
    assert.match(r.text, /Upserted 2/, r.text);
    const rows = await stored(t.T, marker);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.project_id, t.Pm, `${row.title} is filed under the named project`);
      assert.equal(row.scope, 'project');
    }
    await assertOnlyAuthorSees(t, marker, catalog);
  });
}

test('1c: omitted project_id files under the ACTIVE project', async () => {
  const t = await team('s28b1c');
  const marker = `Initrode${RUN}`;
  await mcpCall(t.keys.M, t.T, 'start_session', { project_id: t.Pm });
  const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'knowledge', title: `The ${marker} offer lapses on Friday`, summary: 'The written offer expires at noon on Friday.' }],
  });
  assert.equal(r.err, false, r.text);
  const rows = await stored(t.T, marker);
  assert.deepEqual(rows.map((row) => [row.project_id, row.scope]), [[t.Pm, 'project']]);
  await assertOnlyAuthorSees(t, marker, '/mcp');
});

test('1d: a per-entity project_id and an explicit scope:"workspace" are kept as given', async () => {
  const t = await team('s28b1d');
  const other = await newProject(t.M, 'Other', t.T);
  const own = `Umbrella${RUN}`;
  const ws = `Hooli${RUN}`;
  const r = await mcpCall(t.keys.M, t.T, 'manage_memory', {
    action: 'upsert_entities', project_id: t.Pm,
    entities: [
      { entity_type: 'knowledge', title: `The ${own} contract renews in March`, summary: 'Renewal notice is due sixty days before.', project_id: other },
      { entity_type: 'knowledge', title: `The ${ws} staging cluster lives in eu-west-2`, summary: 'Every team deploys staging there.', scope: 'workspace' },
    ],
  });
  assert.equal(r.err, false, r.text);
  assert.deepEqual((await stored(t.T, own)).map((row) => [row.project_id, row.scope]), [[other, 'project']]);
  assert.deepEqual((await stored(t.T, ws)).map((row) => [row.project_id, row.scope]), [[null, 'workspace']]);
});

test('1e: a top-level project_id the caller cannot see is refused, nothing stored', async () => {
  const t = await team('s28b1e');
  const marker = `Vandelay${RUN}`;
  // M2 names M's personal project.
  const r = await mcpCall(t.keys.M2, t.T, 'manage_memory', {
    action: 'upsert_entities', project_id: t.Pm,
    entities: [{ entity_type: 'knowledge', title: `${marker} imports latex goods`, summary: 'Importer and exporter of latex goods.' }],
  });
  assert.equal(r.err, true, r.text);
  assert.ok(r.text.includes(`No project "${t.Pm}" that you can see`), r.text);
  assert.deepEqual(await stored(t.T, marker), []);
});

// ── 2. A cross-project reopen keeps the rest of the upsert ─────────────────

// SCAN 36 (b/p114) CHANGED THE SECOND HALF: a save filed under B never rewrites
// A's node — summary or metadata — so the metadata change is reported as NOT
// applied, with that reason, instead of landing on A's entity (where sharing A
// would publish B's words).
test('2: status active naming B on A\'s node reopens B, and says the metadata change was not applied to A\'s node', async () => {
  const S = await makePerson('s28b2', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const A = await newProject(S, 'Repo A');
  const B = await newProject(S, 'Repo B');
  const D = `Decided to use Postgres 16 ${uuidv4().slice(0, 6)} for the primary ledger database.`;
  for (const P of [A, B]) { await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: D }); await wait(600); }
  const resolved = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'decision', scope: 'project', project_id: B, title: D, summary: D, metadata: { status: 'resolved' } }],
  });
  assert.match(resolved.text, /Resolved in the decision log/, resolved.text);
  const before = (await q(
    'SELECT node_id, project_id, summary, metadata FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\' AND title = $2',
    [S.orgId, D],
  )).rows;
  assert.equal(before.length, 1);
  assert.equal(before[0].project_id, A, 'the node is filed under A');
  const note = `${D} Chosen for logical replication into the warehouse.`;
  const r = await mcpCall(key, S.orgId, 'manage_memory', {
    action: 'upsert_entities',
    entities: [{ entity_type: 'decision', scope: 'project', project_id: B, title: D, summary: note, metadata: { status: 'active', surface: 'billing' } }],
  });
  assert.match(r.text, /Reopened in the decision log of Repo B/, r.text);
  assert.match(r.text, /your surface change was NOT applied, because a save from another project records that it is used there and never rewrites it/, r.text);
  const decisions = Object.fromEntries((await store.getProject(S.orgId, B)).context.recent_decisions.map((d) => [d.summary, Boolean(d.resolved)]));
  assert.equal(decisions[D], false, 'B is open again');
  const after = (await q('SELECT project_id, summary, metadata FROM context_graph_nodes WHERE node_id = $1', [before[0].node_id])).rows[0];
  assert.equal(after.project_id, A, 'still A\'s node');
  // The store keeps a decision node's first full summary on every upsert, this
  // path included, so the summary is not claimed as applied — and (scan 30) the
  // reply says it was kept rather than saying nothing.
  assert.doesNotMatch(r.text, /your [^)]*summary[^)]* change was applied/, r.text);
  assert.match(r.text, /Kept the existing description of "[^"]+": a stored description is not replaced/, r.text);
  assert.equal(after.metadata.surface, undefined, 'B\'s words stay off A\'s node');
  assert.equal(after.metadata.status || null, before[0].metadata.status || null, 'the node\'s own status is A\'s, untouched');
  const aDecisions = Object.fromEntries((await store.getProject(S.orgId, A)).context.recent_decisions.map((d) => [d.summary, Boolean(d.resolved)]));
  assert.equal(aDecisions[D], false, 'A was never touched');
});

// ── 3. A join cannot land in a workspace whose billing is being cancelled ───

// Stripe, stubbed at the API edge. `during[id]` runs INSIDE the cancel of that
// subscription: the moment the race needs.
const cancels = [];
const during = {};
const failing = new Set();
// Deletion sweeps EVERY live subscription on the org's Stripe customer, not only
// the recorded one, so it lists first. These fixtures seed the customer as
// `cus_<subscription id>`: answer with that one subscription, live.
stripeService.stripe.subscriptions.list = async ({ customer }) => ({
  data: [{ id: String(customer).replace(/^cus_/, ''), status: 'active', customer }],
  has_more: false,
});
stripeService.stripe.subscriptions.cancel = async (id) => {
  cancels.push(id);
  if (during[id]) await during[id]();
  if (failing.has(id)) throw new Error('card network on fire');
  return { id, status: 'canceled' };
};
const sub = (name) => `sub_${name}_${RUN}`;

async function makeClerkPerson(label) {
  const person = await makePerson(label);
  const subject = `user_clerk_${uuidv4().slice(0, 12)}`;
  await q('UPDATE users SET auth_provider = $2, auth_subject = $3 WHERE user_id = $1', [person.userId, 'clerk', subject]);
  return { ...person, subject };
}

async function sideWorkspace(owner, name, subscription) {
  const res = await createTeamWorkspaceFixture(owner, name);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const W = res.body.workspace;
  await q(
    `UPDATE organizations SET plan = 'developer_pro', plan_tier = 'developer_pro', subscription_status = 'active',
            stripe_subscription_id = $2, stripe_customer_id = $3, purchased_seats = 5 WHERE org_id = $1`,
    [W, subscription, `cus_${subscription}`],
  );
  return W;
}

// An invitation redeemed the way the product redeems one; its answer is kept.
async function tryJoin(W, owner, joiner) {
  const invite = await workspace.createInvite(W, joiner.email, { role: 'member', invitedBy: owner.userId });
  return workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
}

const orgExists = async (ws) => (await q('SELECT 1 FROM organizations WHERE org_id = $1', [ws])).rowCount === 1;
const activeMember = async (ws, userId) => (await q(
  'SELECT 1 FROM workspace_members WHERE owner_key = $1 AND user_id = $2 AND removed_at IS NULL', [ws, userId],
)).rowCount === 1;
const CLOSE = (person) => ({ password: 'password123', confirm_email: person.email });

function userDeleted(subject) {
  const hook = express();
  hook.use('/webhooks', webhookRouter);
  const payload = JSON.stringify({ id: `evt_${uuidv4()}`, type: 'user.deleted', data: { id: subject, deleted: true, object: 'user' }, object: 'event' });
  const msgId = `msg_${uuidv4()}`;
  const ts = new Date();
  const sig = new Webhook(process.env.CLERK_WEBHOOK_SECRET).sign(msgId, ts, payload);
  return request(hook).post('/webhooks/clerk')
    .set('svix-id', msgId)
    .set('svix-timestamp', String(Math.floor(ts.getTime() / 1000)))
    .set('svix-signature', sig)
    .set('content-type', 'application/json')
    .send(payload);
}

test('3a: DELETE /orgs — a join during the side workspace\'s cancel is refused, and the close completes (p5 D)', async () => {
  const O = await makePerson('s28b3a-o');
  const W = await sideWorkspace(O, 'Side 28b-3a', sub('s28b_3a'));
  const J = await makePerson('s28b3a-j');
  let joined = null;
  during[sub('s28b_3a')] = async () => { joined = await tryJoin(W, O, J); };
  const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(cancels.includes(sub('s28b_3a')));
  assert.equal(joined?.ok, false, `the join must be refused: ${JSON.stringify(joined)}`);
  assert.equal(joined.reason, 'workspace_closing');
  assert.equal(await activeMember(W, J.userId), false);
  assert.equal(await orgExists(W), false, 'W closed with the account, as its only occupant intended');
  assert.deepEqual(res.body.closed_workspaces, [{ workspace: W, name: 'Side 28b-3a' }]);
});

test('3b: Clerk user.deleted — a join during the side workspace\'s cancel is refused, and the close completes (p5 E)', async () => {
  const O = await makeClerkPerson('s28b3b-o');
  const W = await sideWorkspace(O, 'Side 28b-3b', sub('s28b_3b'));
  const J = await makePerson('s28b3b-j');
  let joined = null;
  during[sub('s28b_3b')] = async () => { joined = await tryJoin(W, O, J); };
  const res = await userDeleted(O.subject);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(cancels.includes(sub('s28b_3b')));
  assert.equal(joined?.ok, false, `the join must be refused: ${JSON.stringify(joined)}`);
  assert.equal(joined.reason, 'workspace_closing');
  assert.equal(await activeMember(W, J.userId), false);
  assert.equal(await orgExists(W), false, 'no live team is left behind with its billing cancelled');
});

test('3c: a close that stops (billing failed) opens the door again', async () => {
  const O = await makePerson('s28b3c-o');
  const W = await sideWorkspace(O, 'Side 28b-3c', sub('s28b_3c'));
  failing.add(sub('s28b_3c'));
  const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  failing.delete(sub('s28b_3c'));
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(await orgExists(W), true);
  const J = await makePerson('s28b3c-j');
  const joined = await tryJoin(W, O, J);
  assert.equal(joined.ok, true, `W is open again: ${JSON.stringify(joined)}`);
  assert.equal(await activeMember(W, J.userId), true);
});

test('3d: a stale closing mark (a close that died) does not shut the door for good', async () => {
  const O = await makePerson('s28b3d-o');
  const W = await sideWorkspace(O, 'Side 28b-3d', sub('s28b_3d'));
  await q('INSERT INTO workspace_closures (owner_key, started_at) VALUES ($1, NOW() - interval \'2 hours\')', [W]);
  const J = await makePerson('s28b3d-j');
  const joined = await tryJoin(W, O, J);
  assert.equal(joined.ok, true, JSON.stringify(joined));
  await q('DELETE FROM workspace_closures WHERE owner_key = $1', [W]);
});
