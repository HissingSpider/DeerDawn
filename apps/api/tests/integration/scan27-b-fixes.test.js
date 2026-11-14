/**
 * SCAN 27 (b).
 *
 *   HIGH: closing an account left behind a second workspace the person was the
 *   last one in, still billing. DELETE /orgs cancelled, purged and deleted the
 *   HOME org only; listSoleOwnedTeams (the sole_owner 409) flags only teams that
 *   still have OTHER members. So a workspace created through POST
 *   /teams/workspaces that everybody else had since left survived with its org
 *   row, its projects and graph and a live subscription, on a roster holding
 *   nothing but tombstones — nobody left who could manage or cancel it. The
 *   Clerk user.deleted webhook had the same gap.
 *
 *   Now both close every workspace where the closing person is the only ACTIVE
 *   occupant, through the home org's own sequence (billing cancelled first,
 *   then re-home, purge and org row in one transaction), and DELETE /orgs names
 *   them in `closed_workspaces`. Workspaces with anybody else active in them keep
 *   today's behaviour.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan27-b-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
// A configured Stripe client, so cancelSubscriptionForDeletion reaches the
// (stubbed) API instead of answering stripe_not_configured. Before any require.
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || 'sk_test_scan27b';
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
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const stripeService = require('../../src/services/stripeService');
const webhookRouter = require('../../src/routes/auth-webhooks');

const q = (sql, params) => db.query(sql, params, 'org-system');
// Stripe ids are unique per organizations row, and the test DB persists across
// runs: every run gets its own.
const RUN = uuidv4().slice(0, 8);
const sub = (name) => `sub_${name}_${RUN}`;

// ── Stripe, stubbed at the API edge ─────────────────────────────────────────
const cancels = [];
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
  if (failing.has(id)) throw new Error('card network on fire');
  return { id, status: 'canceled' };
};

async function makeOrg(label, plan = 'free') {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { clerk = false } = {}) {
  const orgId = await makeOrg(label);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  const subject = clerk ? `user_clerk_${uuidv4().slice(0, 12)}` : null;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id, auth_provider, auth_subject) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [userId, email, await hashPassword('password123'), 'admin', orgId, clerk ? 'clerk' : null, subject],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt, subject };
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function join(ownerKey, owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(ownerKey, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

// A second workspace, created the way the product creates one, then upgraded
// and billing — the state the finding describes.
async function makeSideWorkspace(owner, name, sub) {
  const res = await createTeamWorkspaceFixture(owner, name);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const W = res.body.workspace;
  await q(
    `UPDATE organizations SET plan = 'developer_pro', plan_tier = 'developer_pro', subscription_status = 'active',
            stripe_subscription_id = $2, stripe_customer_id = $3, purchased_seats = 5 WHERE org_id = $1`,
    [W, sub, `cus_${sub}`],
  );
  return W;
}

async function seedContent(ws, authorId) {
  const projectId = `proj-${uuidv4()}`;
  await q(
    `INSERT INTO context_projects (project_id, owner_key, owner_user_id, visibility, project_name)
     VALUES ($1, $2, $3, 'shared', $4)`,
    [projectId, ws, authorId, `side ${projectId.slice(5, 13)}`],
  );
  await q(
    `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, source_tool)
     VALUES ($1, $2, $3, 'decision', $4, 'Use Kafka for payouts', 'test')`,
    [`node-${uuidv4()}`, ws, projectId, `kafka-${uuidv4().slice(0, 8)}`],
  );
  return projectId;
}

const count = async (sql, params) => (await q(sql, params)).rows[0].n;
const orgExists = async (ws) => (await count('SELECT count(*)::int AS n FROM organizations WHERE org_id = $1', [ws])) === 1;
const projects = (ws) => count('SELECT count(*)::int AS n FROM context_projects WHERE owner_key = $1', [ws]);
const nodes = (ws) => count('SELECT count(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1', [ws]);
const CLOSE = (person) => ({ password: 'password123', confirm_email: person.email });

// ── 1. DELETE /orgs ─────────────────────────────────────────────────────────

test('1: closing an account closes a second workspace everybody else has left (p50)', async () => {
  const O = await makePerson('s27b-o');
  const W = await makeSideWorkspace(O, 'Side Team 27b', sub('s27b_1'));
  await seedContent(W, O.userId);
  // A teammate joined, then left: W's roster is O plus a tombstone.
  const M = await makePerson('s27b-m');
  await join(W, O, M);
  const left = await as('delete', `/api/v1/teams/members/${M.userId}`, M, W);
  assert.equal(left.status, 200, JSON.stringify(left.body));

  cancels.length = 0;
  const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.ok(cancels.includes(sub('s27b_1')), `W's subscription must be cancelled; cancelled: ${JSON.stringify(cancels)}`);
  assert.equal(await orgExists(W), false, 'W\'s organizations row must go with the account');
  assert.equal(await projects(W), 0, 'W\'s projects must be erased');
  assert.equal(await nodes(W), 0, 'W\'s knowledge graph must be erased');
  assert.equal(await count('SELECT count(*)::int AS n FROM workspace_members WHERE owner_key = $1', [W]), 0);
  assert.deepEqual(res.body.closed_workspaces, [{ workspace: W, name: 'Side Team 27b' }],
    'the response names every workspace that closed with the account');

  // The home org went as before; the teammate who left is untouched.
  assert.equal(await orgExists(O.orgId), false);
  assert.equal(await count('SELECT count(*)::int AS n FROM users WHERE user_id = $1', [M.userId]), 1);
  assert.equal(await orgExists(M.orgId), true);
});

test('1b: a legacy resident removed from W is re-homed, not erased, when W closes', async () => {
  const O = await makePerson('s27b-o2');
  const W = await makeSideWorkspace(O, 'Side Team 27b-2', sub('s27b_2'));
  const L = await makePerson('s27b-l');
  await join(W, O, L);
  // L's users.org_id IS W (the legacy invite path), and W removed them.
  await q('UPDATE users SET org_id = $1 WHERE user_id = $2', [W, L.userId]);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [W, L.userId]);

  const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(await orgExists(W), false);
  const row = (await q('SELECT org_id FROM users WHERE user_id = $1', [L.userId])).rows[0];
  assert.ok(row, 'the removed resident\'s account must survive somebody else\'s close');
  assert.notEqual(row.org_id, W);
  assert.equal(await orgExists(row.org_id), true, 'and stand in a workspace of their own');
});

test('2: a workspace with another ACTIVE member is not closed — the sole-owner gate holds', async () => {
  const O = await makePerson('s27b-o3');
  const W = await makeSideWorkspace(O, 'Side Team 27b-3', sub('s27b_3'));
  await seedContent(W, O.userId);
  const M = await makePerson('s27b-m3');
  await join(W, O, M);

  cancels.length = 0;
  const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error, 'sole_owner');
  assert.deepEqual(cancels, [], 'nothing is cancelled when the close is refused');
  assert.equal(await orgExists(W), true);
  assert.equal(await orgExists(O.orgId), true);
  assert.equal(await projects(W), 1);
});

test('2b: a plain member of somebody else\'s active workspace leaves it standing', async () => {
  const T = await makePerson('s27b-t');
  const W = await makeSideWorkspace(T, 'Side Team 27b-4', sub('s27b_4'));
  await seedContent(W, T.userId);
  const O = await makePerson('s27b-o4');
  await join(W, T, O);

  cancels.length = 0;
  const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.closed_workspaces, []);
  assert.ok(!cancels.includes(sub('s27b_4')), 'the team\'s subscription is not the leaving member\'s to cancel');
  assert.equal(await orgExists(W), true);
  assert.equal(await projects(W), 1);
  const oRows = await count('SELECT count(*)::int AS n FROM workspace_members WHERE owner_key = $1 AND user_id = $2', [W, O.userId]);
  assert.equal(oRows, 0, 'the closing member is taken off the roster');
});

test('3: a subscription that cannot be cancelled on W stops the close; nothing is deleted', async () => {
  const O = await makePerson('s27b-o5');
  const W = await makeSideWorkspace(O, 'Side Team 27b-5', sub('s27b_5'));
  await seedContent(W, O.userId);
  failing.add(sub('s27b_5'));
  try {
    const res = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
    assert.equal(res.status, 502, JSON.stringify(res.body));
    assert.equal(res.body.error, 'billing_cancellation_failed');
    assert.equal(res.body.workspace, W);
  } finally {
    failing.delete(sub('s27b_5'));
  }
  assert.equal(await orgExists(W), true);
  assert.equal(await orgExists(O.orgId), true);
  assert.equal(await projects(W), 1);
  // And the retry goes through.
  const retry = await as('delete', '/api/v1/orgs', O).send(CLOSE(O));
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.equal(await orgExists(W), false);
});

// ── 4. Clerk user.deleted ───────────────────────────────────────────────────

async function deliverUserDeleted(subject) {
  const hook = express();
  hook.use('/webhooks', webhookRouter);
  const payload = JSON.stringify({
    id: `evt_${uuidv4()}`,
    type: 'user.deleted',
    data: { id: subject, deleted: true, object: 'user' },
    object: 'event',
  });
  const msgId = `msg_${uuidv4()}`;
  const ts = new Date();
  const sig = new Webhook(process.env.CLERK_WEBHOOK_SECRET).sign(msgId, ts, payload);
  return request(hook)
    .post('/webhooks/clerk')
    .set('svix-id', msgId)
    .set('svix-timestamp', String(Math.floor(ts.getTime() / 1000)))
    .set('svix-signature', sig)
    .set('content-type', 'application/json')
    .send(payload);
}

test('4: Clerk user.deleted closes the workspaces nobody else is left in, and only those', async () => {
  const O = await makePerson('s27b-co', { clerk: true });
  const W = await makeSideWorkspace(O, 'Side Team 27b-c', sub('s27b_c'));
  await seedContent(W, O.userId);
  const M = await makePerson('s27b-cm');
  await join(W, O, M);
  const left = await as('delete', `/api/v1/teams/members/${M.userId}`, M, W);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  // A removed legacy resident still pointing at W.
  const L = await makePerson('s27b-cl');
  await join(W, O, L);
  await q('UPDATE users SET org_id = $1 WHERE user_id = $2', [W, L.userId]);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [W, L.userId]);

  // And a team O is in alongside somebody still active: retained.
  const K = await makeSideWorkspace(O, 'Kept Team 27b-c', sub('s27b_k'));
  await seedContent(K, O.userId);
  const N = await makePerson('s27b-cn');
  await join(K, O, N);

  cancels.length = 0;
  const res = await deliverUserDeleted(O.subject);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.ok(cancels.includes(sub('s27b_c')), `W's subscription must be cancelled; cancelled: ${JSON.stringify(cancels)}`);
  assert.equal(await orgExists(W), false, 'W must not outlive the erasure of the last person in it');
  assert.equal(await projects(W), 0);
  assert.equal(await nodes(W), 0);
  const lRow = (await q('SELECT org_id FROM users WHERE user_id = $1', [L.userId])).rows[0];
  assert.ok(lRow && lRow.org_id !== W && await orgExists(lRow.org_id),
    'a removed legacy resident is re-homed, not erased');

  assert.ok(!cancels.includes(sub('s27b_k')), 'a team with somebody still in it keeps its subscription');
  assert.equal(await orgExists(K), true);
  assert.equal(await projects(K), 1);
  assert.equal(await orgExists(O.orgId), false, 'the home org is still erased as before');
});
