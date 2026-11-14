/**
 * WHICH WORKSPACE A REQUEST LANDS IN, AND WHAT HAPPENS WHEN THAT WORKSPACE IS
 * REFUSING.
 *
 * Three defects reproduced against the real app and a real database, as several
 * people with their own credentials:
 *
 *   1. Accepting an invite auto-activates the team, and EVERY header-less
 *      credential followed that is_active row. So the personal API key somebody
 *      had been using for months silently moved into the team: their own
 *      projects vanished from it, and the next project they created was
 *      published to colleagues. CLAUDE.md says API keys are workspace
 *      credentials, and the invite page promises joining "does not touch your
 *      own projects, they stay private to you".
 *   2. A lapsed Team subscription locked every invited member out of their OWN
 *      personal account, with no exit: the switcher, the workspace list and the
 *      member roster were all gated on the dead workspace, and the member is not
 *      the person who can pay the bill.
 *   3. The project-ownership backfill ran on every 1->2 member transition, so a
 *      two-person team that lost somebody and hired a replacement flipped every
 *      org-owned 'private' project to 'personal' and the owner lost access to
 *      work she had been reading that morning.
 *
 * Plus the default key name, which was unique per WORKSPACE while the list is
 * per PERSON, so the second teammate to click "Create key" got a 409 against a
 * key they could not see.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/teams-workspace-binding.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  try { return JSON.parse(line ? line.slice(6) : res.text); } catch { return { raw: res.text }; }
}

async function mintKey(userId, orgId, { name = 'seed key', oauthResource = null, scopes = ['context:read', 'context:write'] } = {}) {
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_resource)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [`key-${uuidv4()}`, prefix, hash, name, userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), scopes, oauthResource],
    'org-system',
  );
  return key;
}

async function makePerson(label, { plan = 'free', purchasedSeats = null } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', purchasedSeats],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  const apiKey = await mintKey(userId, orgId, { name: `${label} personal key` });
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin' });
  return { label, orgId, userId, email, apiKey, jwt };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_ownership_backfills WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1 OR user_id = $2', [person.orgId, person.userId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1 OR owner_id = $2', [person.orgId, person.userId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await invalidateOrgCache(person.orgId).catch(() => {});
  }
}

const asKey = (req, key, ws) => {
  const r = req.set('X-Api-Key', key);
  return ws ? r.set('x-deerdawn-workspace', ws) : r;
};
const asUser = (req, person, ws) => {
  const r = req.set('Authorization', `Bearer ${person.jwt}`);
  return ws ? r.set('x-deerdawn-workspace', ws) : r;
};

async function hostedWithKey(key, name, args = {}, ws) {
  const res = await asKey(request(httpServer).post('/mcp').set(MCP_HEADERS), key, ws).send(rpc(name, args));
  return { status: res.status, payload: parseRpc(res), headers: res.headers };
}

async function createProjectWithKey(key, name, ws) {
  const res = await asKey(request(httpServer).post('/api/v1/context/projects'), key, ws)
    .send({ project_name: name, description: 'work', goals: [] });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project?.project_id || res.body.project_id;
}

async function join(owner, joiner, { role = 'member' } = {}) {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
  return accepted;
}

function projectRow(projectId) {
  return db.query(
    'SELECT owner_key, visibility, owner_user_id FROM context_projects WHERE project_id = $1',
    [projectId],
    'org-system',
  ).then((r) => r.rows[0]);
}

// ---------------------------------------------------------------------------
// 1. A credential that names its own workspace keeps it.
// ---------------------------------------------------------------------------

test('accepting an invite leaves the personal API key in the personal workspace', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    const sideId = await createProjectWithKey(marcus.apiKey, `Marcus side hustle ${uuidv4().slice(0, 5)}`);
    await join(sarah, marcus);
    assert.equal(await workspace.getActiveWorkspace({ id: marcus.userId }), sarah.orgId,
      'the fixture depends on accept auto-activating the team');

    // Header-less, which is all a local stdio tool ever sends.
    const list = await asKey(request(httpServer).get('/api/v1/context/projects'), marcus.apiKey);
    assert.equal(list.status, 200, list.text);
    const ids = (list.body.projects || []).map((p) => p.project_id);
    assert.ok(
      ids.includes(sideId),
      `THE BUG: accepting an invite moved the personal key into the team, so its own projects were gone. Saw: ${JSON.stringify(ids)}`,
    );

    const secondId = await createProjectWithKey(marcus.apiKey, `Marcus second side project ${uuidv4().slice(0, 5)}`);
    const row = await projectRow(secondId);
    assert.equal(row.owner_key, marcus.orgId,
      'THE BUG: a project created with the personal key landed in the team workspace');
    assert.notEqual(row.visibility, 'shared',
      'THE BUG: it was published to colleagues, which the invite page promises will not happen');

    const sarahSees = await asKey(request(httpServer).get('/api/v1/context/projects'), sarah.apiKey);
    const sarahIds = (sarahSees.body.projects || []).map((p) => p.project_id);
    assert.ok(!sarahIds.includes(secondId), 'the invitee\'s side project reached the workspace owner');
  } finally {
    await cleanup([sarah, marcus]);
  }
});

test('a key minted in one team keeps resolving to it when another is active', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const priya = await makePerson('priya', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    // A key minted against Sarah's workspace, the way keys.js and the device
    // flow stamp one: with THAT workspace's org_id on the row.
    const sarahTeamKey = await mintKey(marcus.userId, sarah.orgId, { name: 'sarah team key' });

    // Marcus then joins Priya's workspace and switches to it.
    await join(priya, marcus);
    await workspace.setActiveWorkspace({ id: marcus.userId, org_id: marcus.orgId }, priya.orgId);
    assert.equal(await workspace.getActiveWorkspace({ id: marcus.userId }), priya.orgId);

    const teamProjectId = await createProjectWithKey(sarahTeamKey, `Payments API ${uuidv4().slice(0, 5)}`);
    const row = await projectRow(teamProjectId);
    assert.equal(row.owner_key, sarah.orgId,
      `THE BUG: a key minted in Sarah's workspace wrote into Priya's because that was the active one. Landed in: ${row.owner_key}`);
  } finally {
    await cleanup([sarah, priya, marcus]);
  }
});

test('an OAuth-issued MCP token still follows the active workspace', async () => {
  // The whole reason the fallback exists: an OAuth token carries the person's
  // PERSONAL org and its client cannot send a header, so without it an invited
  // teammate could never reach the team from Claude.ai or ChatGPT.
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  const previousBase = process.env.API_BASE_URL;
  try {
    await join(sarah, marcus);
    const teamProjectId = await createProjectWithKey(sarah.apiKey, `Ledger Service ${uuidv4().slice(0, 5)}`);
    await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [teamProjectId, 'shared'], 'org-system');

    const { port } = httpServer.address();
    process.env.API_BASE_URL = `http://127.0.0.1:${port}`;
    const oauthToken = await mintKey(marcus.userId, marcus.orgId, {
      name: 'DeerDawn MCP (OAuth)',
      oauthResource: `${process.env.API_BASE_URL}/mcp`,
    });

    const res = await hostedWithKey(oauthToken, 'recall', { action: 'projects' });
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    const text = JSON.stringify(res.payload);
    assert.ok(
      text.includes(teamProjectId),
      `an OAuth token must still reach the team it was switched into. Got: ${text.slice(0, 400)}`,
    );
  } finally {
    if (previousBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = previousBase;
    await cleanup([sarah, marcus]);
  }
});

test('a removed member\'s team key is refused', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    const teamKey = await mintKey(marcus.userId, sarah.orgId, { name: 'marcus team key' });
    await workspace.removeMember(sarah.orgId, marcus.userId);

    const res = await asKey(request(httpServer).get('/api/v1/context/projects'), teamKey);
    assert.equal(res.status, 403, `a removed member kept reading the workspace: ${res.status} ${res.text}`);
    assert.equal(res.body.error, 'workspace_forbidden');
  } finally {
    await cleanup([sarah, marcus]);
  }
});

// ---------------------------------------------------------------------------
// 2. A workspace somebody else stopped paying for is not a locked door.
// ---------------------------------------------------------------------------

async function setBilling(orgId, { plan, status, seats = null }) {
  await db.query(
    'UPDATE organizations SET plan = $2, plan_tier = $2, subscription_status = $3, purchased_seats = $4 WHERE org_id = $1',
    [orgId, plan, status, seats],
    orgId,
  );
  await invalidateOrgCache(orgId).catch(() => {});
}

test('a delinquent team does not lock a teammate out of their own account', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    const mineId = await createProjectWithKey(marcus.apiKey, `Marcus own work ${uuidv4().slice(0, 5)}`);
    await join(sarah, marcus);
    // A card decline, mid-dunning: the plan is still the paid one, so the gate
    // is doing its job for the team. It must not reach past it.
    await setBilling(sarah.orgId, { plan: 'developer_pro', status: 'past_due', seats: 5 });

    const list = await asUser(request(httpServer).get('/api/v1/context/projects'), marcus);
    assert.equal(list.status, 200,
      `THE BUG: the invitee was 403'd out of their own account because somebody else's card declined: ${list.text}`);
    const ids = (list.body.projects || []).map((p) => p.project_id);
    assert.ok(ids.includes(mineId), 'the fallback must land in their own workspace, not an empty one');
    assert.equal(list.headers['x-deerdawn-workspace-fallback'], sarah.orgId,
      'a request served from a different workspace than the one bound must say so');

    // The exits, which are the only way to make the change stick.
    const workspaces = await asUser(request(httpServer).get('/api/v1/teams/workspaces'), marcus);
    assert.equal(workspaces.status, 200, `the workspace list is the exit and must stay open: ${workspaces.text}`);
    const home = await asUser(request(httpServer).post('/api/v1/teams/active'), marcus, sarah.orgId).send({ workspace: null });
    assert.equal(home.status, 200, `THE BUG: the switcher itself was gated on the dead workspace: ${home.text}`);
    assert.equal(home.body.active_workspace, null, 'the dashboard expresses "personal" as workspace: null');
    assert.equal(await workspace.getActiveWorkspace({ id: marcus.userId }), null);
  } finally {
    await cleanup([sarah, marcus]);
  }
});

test('the owner of a delinquent team can still find her way out and take her data', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    await setBilling(sarah.orgId, { plan: 'developer_pro', status: 'past_due', seats: 5 });

    // Sarah's own org IS the team, so there is nowhere for her to fall back to.
    // These routes are her way out, and the billing gate must not close them.
    const workspaces = await asUser(request(httpServer).get('/api/v1/teams/workspaces'), sarah);
    assert.equal(workspaces.status, 200, `THE BUG: the owner could not see where she may go: ${workspaces.text}`);

    const exported = await asUser(request(httpServer).get('/api/v1/context/export'), sarah);
    assert.equal(exported.status, 200, `THE BUG: the owner could not export her own data: ${exported.text}`);

    // Billing itself has always been exempt, and is where she actually fixes it.
    const usage = await asUser(request(httpServer).get('/api/v1/billing/usage-summary'), sarah);
    assert.equal(usage.status, 200, usage.text);

    // Everything else stays refused: she is genuinely on a paid plan she has
    // not paid for.
    const projects = await asUser(request(httpServer).get('/api/v1/context/projects'), sarah);
    assert.equal(projects.status, 403, 'the billing gate itself must still bite on a paid plan');
    assert.equal(projects.body.error, 'subscription_inactive');
  } finally {
    await cleanup([sarah, marcus]);
  }
});

test('the roster and member removal are past the billing gate', async () => {
  // Asserted at this layer only: that the BILLING gate does not refuse these.
  // routes/shared/teams.js gates them a second time on the `team_management`
  // FEATURE, which entitlementService reports absent for any inactive status —
  // the half tested directly below.
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  try {
    await setBilling(sarah.orgId, { plan: 'developer_pro', status: 'past_due', seats: 5 });
    const members = await asUser(request(httpServer).get('/api/v1/teams/members'), sarah);
    assert.notEqual(members.body.error, 'subscription_inactive',
      `THE BUG: the roster was refused on billing status: ${members.text}`);
    const removed = await asUser(request(httpServer).delete(`/api/v1/teams/members/${sarah.userId}`), sarah);
    assert.notEqual(removed.body.error, 'subscription_inactive',
      `THE BUG: shedding a seat was refused on billing status: ${removed.text}`);
  } finally {
    await cleanup([sarah]);
  }
});

test('a lapsed team\'s owner can still see her roster and shrink it', async () => {
  // The other half of the test above. `team_management` is false the moment a
  // subscription goes past_due, so the second gate refused the owner the roster
  // and the remove button: the one person who can fix the bill could not see
  // who she was being billed for, and could not shrink the team to what she is
  // willing to pay for. Growing it stays refused — a workspace nobody is paying
  // for may not add people.
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    await setBilling(sarah.orgId, { plan: 'developer_pro', status: 'past_due', seats: 5 });

    const roster = await asUser(request(httpServer).get('/api/v1/teams/members'), sarah, sarah.orgId);
    assert.equal(roster.status, 200,
      `THE BUG: the owner of a lapsed team could not see who was in it: ${roster.text}`);
    assert.ok((roster.body.members || []).some((m) => m.id === marcus.userId),
      'the roster has to name the people she is paying for');
    // And it must say WHY it looks like this, or the dashboard has to guess
    // between "lapsed" and "never had a team" and will sell her an upgrade she
    // already bought.
    assert.equal(roster.body.team_management, false, JSON.stringify(roster.body.billing));
    assert.equal(roster.body.billing?.subscription_status, 'past_due');

    const invited = await asUser(request(httpServer).post('/api/v1/teams/invite'), sarah, sarah.orgId)
      .send({ email: `new-${uuidv4().slice(0, 6)}@e2e.test`, role: 'member' });
    assert.equal(invited.status, 403, `growing a team nobody is paying for must stay refused: ${invited.text}`);

    const removed = await asUser(request(httpServer).delete(`/api/v1/teams/members/${marcus.userId}`), sarah, sarah.orgId);
    assert.equal(removed.status, 200,
      `THE BUG: she could not shrink the team to what she will pay for: ${removed.text}`);
  } finally {
    await cleanup([sarah, marcus]);
  }
});

test('a workspace that never had a team still gets the upgrade refusal', async () => {
  // The recovery exemption is for a team that lapsed, not a door into the team
  // routes for everybody: a solo Free account has nobody to see and nobody to
  // remove.
  const nadia = await makePerson('nadia');
  try {
    const roster = await asUser(request(httpServer).get('/api/v1/teams/members'), nadia, nadia.orgId);
    assert.equal(roster.status, 403, roster.text);
    assert.equal(roster.body.upgrade_required, true);
  } finally {
    await cleanup([nadia]);
  }
});

test('a cancelled subscription is a drop to Free, not a locked account', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  try {
    const projectId = await createProjectWithKey(sarah.apiKey, `Payments API ${uuidv4().slice(0, 5)}`);
    // Exactly what customer.subscription.deleted writes.
    await setBilling(sarah.orgId, { plan: 'free', status: 'cancelled', seats: null });

    const list = await asUser(request(httpServer).get('/api/v1/context/projects'), sarah);
    assert.equal(list.status, 200,
      `THE BUG: churning to Free made the whole account unreachable, with nothing left to pay for: ${list.text}`);
    const ids = (list.body.projects || []).map((p) => p.project_id);
    assert.ok(ids.includes(projectId), 'a churned account keeps its work, on Free terms');
  } finally {
    await cleanup([sarah]);
  }
});

test('a paid plan that has not been paid for is still refused', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  try {
    await setBilling(sarah.orgId, { plan: 'developer_pro', status: 'unpaid', seats: 5 });
    const list = await asUser(request(httpServer).get('/api/v1/context/projects'), sarah);
    assert.equal(list.status, 403, 'dropping the lockout for Free must not drop it for an unpaid paid plan');
    assert.equal(list.body.error, 'subscription_inactive');
  } finally {
    await cleanup([sarah]);
  }
});

// ---------------------------------------------------------------------------
// 3. The ownership backfill runs once per workspace, ever.
// ---------------------------------------------------------------------------

test('inviting the first colleague still makes pre-team history personal', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    const beforeId = await createProjectWithKey(sarah.apiKey, `Solo notes ${uuidv4().slice(0, 5)}`);
    assert.equal((await projectRow(beforeId)).visibility, 'private', 'a solo workspace creates private projects');

    await join(sarah, marcus);
    assert.equal((await projectRow(beforeId)).visibility, 'personal',
      'inviting a colleague must never publish what predates them, not even to a future co-owner');
  } finally {
    await cleanup([sarah, marcus]);
  }
});

test('a departure and a replacement do not hand org-owned work to the person who left', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  const priya = await makePerson('priya');
  try {
    await join(sarah, marcus);
    const marcusTeamKey = await mintKey(marcus.userId, sarah.orgId, { name: 'marcus team key' });
    const projectId = await createProjectWithKey(marcusTeamKey, `Billing engine ${uuidv4().slice(0, 5)}`);
    // Org-owned but not team-shared: the state that exists so the org keeps its
    // work when the author leaves.
    await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [projectId, 'private'], 'org-system');

    const beforeRead = await asUser(request(httpServer).get(`/api/v1/context/projects/${projectId}/map`), sarah);
    assert.equal(beforeRead.status, 200, `the owner reads org-owned private work: ${beforeRead.text}`);

    await workspace.removeMember(sarah.orgId, marcus.userId);
    await join(sarah, priya);

    const row = await projectRow(projectId);
    assert.equal(row.visibility, 'private',
      'THE BUG: hiring a replacement re-ran the backfill and flipped org-owned work to the departed author\'s personal');
    const afterRead = await asUser(request(httpServer).get(`/api/v1/context/projects/${projectId}/map`), sarah);
    assert.equal(afterRead.status, 200,
      `THE BUG: the owner got resource_not_found on work she was reading that morning: ${afterRead.text}`);
  } finally {
    await cleanup([sarah, marcus, priya]);
  }
});

test('a workspace that was already shared before the marker existed is not re-backfilled', async () => {
  // Every team in production predates workspace_ownership_backfills. Growing one
  // must not run the backfill for the "first" time on work the team already
  // shares.
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  const priya = await makePerson('priya');
  try {
    await join(sarah, marcus);
    const projectId = await createProjectWithKey(sarah.apiKey, `Ledger ${uuidv4().slice(0, 5)}`);
    await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [projectId, 'private'], 'org-system');
    // Erase the marker: this is now indistinguishable from a workspace that
    // became shared before the table was added.
    await db.query('DELETE FROM workspace_ownership_backfills WHERE owner_key = $1', [sarah.orgId], 'org-system');

    await join(sarah, priya);
    assert.equal((await projectRow(projectId)).visibility, 'private',
      'a pre-existing team must be recognised as already backfilled, not backfilled again');
  } finally {
    await cleanup([sarah, marcus, priya]);
  }
});

// ---------------------------------------------------------------------------
// 4. The default key name belongs to a person, not to a workspace.
// ---------------------------------------------------------------------------

test('two teammates can each mint a key with the dashboard\'s default name', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    const body = { name: 'Primary key', environment: 'production', scopes: ['context:read', 'context:write'] };

    const hers = await asUser(request(httpServer).post('/api/v1/keys'), sarah, sarah.orgId).send(body);
    assert.equal(hers.status, 201, hers.text);

    const his = await asUser(request(httpServer).post('/api/v1/keys'), marcus, sarah.orgId).send(body);
    assert.equal(his.status, 201,
      `THE BUG: the second teammate was refused the default name against a key they cannot see: ${his.text}`);

    // And one person still cannot have two of their own with the same name.
    const again = await asUser(request(httpServer).post('/api/v1/keys'), marcus, sarah.orgId).send(body);
    assert.equal(again.status, 409, 'uniqueness within one person\'s own inventory still holds');
  } finally {
    await cleanup([sarah, marcus]);
  }
});

test('a hosted session served from the personal workspace says so in words', async () => {
  // The fallback above is silent from inside the tool: an OAuth connector has
  // no headers to read, so from the user's side their brief simply changed —
  // different projects, no teammates, no reason given. The response header
  // exists for a browser; start_session has to say it in the reply.
  const sarah = await makePerson('sarah', { plan: 'developer_pro', purchasedSeats: 5 });
  const marcus = await makePerson('marcus');
  const previousBase = process.env.API_BASE_URL;
  try {
    await join(sarah, marcus);
    const { port } = httpServer.address();
    process.env.API_BASE_URL = `http://127.0.0.1:${port}`;
    const oauthToken = await mintKey(marcus.userId, marcus.orgId, {
      name: 'DeerDawn MCP (OAuth)',
      oauthResource: `${process.env.API_BASE_URL}/mcp`,
    });
    await setBilling(sarah.orgId, { plan: 'developer_pro', status: 'past_due', seats: 5 });

    const res = await hostedWithKey(oauthToken, 'start_session', {});
    assert.equal(res.status, 200, JSON.stringify(res.payload));
    assert.equal(res.headers['x-deerdawn-workspace-fallback'], sarah.orgId,
      'precondition: the request must actually have been re-bound to the personal workspace');
    const text = res.payload.result?.content?.[0]?.text || '';
    assert.match(text, /subscription is inactive/,
      `THE BUG: the session silently changed workspace and said nothing. Got: ${text.slice(0, 400)}`);
  } finally {
    if (previousBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = previousBase;
    await cleanup([sarah, marcus]);
  }
});
