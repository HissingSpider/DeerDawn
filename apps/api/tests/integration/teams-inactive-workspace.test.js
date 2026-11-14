/**
 * WHAT THE PERSONAL-WORKSPACE FALLBACK IS ALLOWED TO DO.
 *
 * PR #504 added it for a good reason: a teammate whose team's card lapsed was
 * 403'd out of their own healthy account, and they are not the person who can
 * pay the bill. Three things it did that it should not.
 *
 *   1. It rebound the request to actor.org_id without running any of the checks
 *      the ordinary own-org binding runs. Somebody whose users.org_id IS a team
 *      workspace (the legacy invite path creates people directly inside the
 *      target org) could be REMOVED from it, refused it by header, and then
 *      handed it anyway the moment the team they had switched to lapsed.
 *   2. Every request was silently served by the personal workspace while
 *      GET /teams/workspaces — exempt from enforcement, therefore never rebound
 *      — went on answering `active: <the team>`. An invited teammate's
 *      dashboard is header-less by default, so POST /context/projects answered
 *      201 into the personal workspace while the switcher named the team. The
 *      only signal was a response header CORS did not expose.
 *   3. #504 also (correctly) made a plain API key stay in the workspace it was
 *      minted for, which left a teammate who ALREADY had a local install with no
 *      way to point it at the team, while three product surfaces promised it
 *      just worked.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/teams-inactive-workspace.test.js
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

/**
 * A token the way routes/oauth.js mints one: against the person's PERSONAL org,
 * audience-bound to this server's /mcp. The audience check in middleware/auth.js
 * compares against API_BASE_URL, so the test has to name the ephemeral port.
 */
async function mintOauthToken(person) {
  const { port } = httpServer.address();
  process.env.API_BASE_URL = `http://127.0.0.1:${port}`;
  return mintKey(person.userId, person.orgId, {
    name: 'DeerDawn MCP (OAuth)',
    oauthResource: `${process.env.API_BASE_URL}/mcp`,
  });
}

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
    orgId,
  );
  return orgId;
}

async function makeUserIn(label, orgId) {
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  const apiKey = await mintKey(userId, orgId, { name: `${label} key` });
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin' });
  return { label, orgId, userId, email, apiKey, jwt };
}

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = await makeOrg(label, plan);
  const person = await makeUserIn(label, orgId);
  await workspace.ensureOwnerMembership(orgId, person.userId);
  return person;
}

async function setBilling(orgId, plan, status) {
  await db.query(
    'UPDATE organizations SET plan = $2, plan_tier = $2, subscription_status = $3 WHERE org_id = $1',
    [orgId, plan, status],
    'org-system',
  );
  await invalidateOrgCache(orgId).catch(() => {});
}

async function join(owner, joiner, { role = 'member' } = {}) {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
  return accepted;
}

async function cleanup(orgIds, userIds = []) {
  for (const orgId of orgIds) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_ownership_backfills WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [orgId], orgId).catch(() => {});
    await invalidateOrgCache(orgId).catch(() => {});
  }
  for (const userId of userIds) {
    await db.query('DELETE FROM workspace_members WHERE user_id = $1', [userId], 'org-system').catch(() => {});
    await db.query('DELETE FROM api_keys WHERE owner_id = $1', [userId], 'org-system').catch(() => {});
    await db.query('DELETE FROM users WHERE user_id = $1', [userId], 'org-system').catch(() => {});
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

function projectRow(projectId) {
  return db.query(
    'SELECT owner_key, visibility FROM context_projects WHERE project_id = $1',
    [projectId],
    'org-system',
  ).then((r) => r.rows[0]);
}

// ---------------------------------------------------------------------------
// 1. The fallback target has to be admissible on its own terms.
// ---------------------------------------------------------------------------

test('a lapsed team does not hand a removed member the workspace their user row names', async () => {
  // Team X, owned by xavier. `legacy` was created directly INSIDE X, which is
  // what routes/shared/orgs.js does: users.org_id === X.
  const xavier = await makePerson('xavier', { plan: 'developer_pro' });
  const legacy = await makeUserIn('legacy', xavier.orgId);
  await workspace.addMember(xavier.orgId, legacy.userId, { role: 'member' });

  const yolanda = await makePerson('yolanda', { plan: 'developer_pro' });
  try {
    const made = await asUser(request(httpServer).post('/api/v1/context/projects'), xavier)
      .send({ project_name: `X roadmap ${uuidv4().slice(0, 5)}`, description: 'x', goals: [] });
    assert.equal(made.status, 201, made.text);
    const xProject = made.body.project?.project_id || made.body.project_id;
    await db.query('UPDATE context_projects SET visibility = \'shared\' WHERE project_id = $1', [xProject], 'org-system');

    // legacy joins team Y and is working there; then is removed from X.
    await join(yolanda, legacy);
    await workspace.removeMember(xavier.orgId, legacy.userId);

    // Control: naming X explicitly is refused, which is the honest answer.
    const byHeader = await asUser(request(httpServer).get('/api/v1/context/projects'), legacy, xavier.orgId);
    assert.equal(byHeader.status, 403, byHeader.text);
    assert.equal(byHeader.body.error, 'workspace_forbidden');

    // Y's card declines. A header-less request binds to Y, is refused on
    // billing, and used to fall back to org_id === X with no removal check.
    await setBilling(yolanda.orgId, 'developer_pro', 'past_due');
    const list = await asUser(request(httpServer).get('/api/v1/context/projects'), legacy);
    const ids = (list.body.projects || []).map((p) => p.project_id);

    assert.ok(
      !ids.includes(xProject),
      'THE BUG: the billing fallback served a removed member the workspace they were thrown out of',
    );
    assert.equal(
      list.status,
      403,
      `a fallback target that is not admissible leaves the original refusal standing. Got ${list.status}: ${list.text}`,
    );
  } finally {
    await cleanup([xavier.orgId, yolanda.orgId], [legacy.userId]);
  }
});

test('somebody with an ordinary personal org still falls back, and is told so', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    const own = await asUser(request(httpServer).post('/api/v1/context/projects'), marcus)
      .send({ project_name: `Marcus own ${uuidv4().slice(0, 5)}`, description: 'mine', goals: [] });
    assert.equal(own.status, 201, own.text);
    const ownId = own.body.project?.project_id || own.body.project_id;

    await join(sarah, marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    const list = await asUser(request(httpServer).get('/api/v1/context/projects'), marcus);
    assert.equal(list.status, 200, list.text);
    assert.equal(list.headers['x-deerdawn-workspace-fallback'], sarah.orgId);
    const ids = (list.body.projects || []).map((p) => p.project_id);
    assert.ok(ids.includes(ownId), 'their own healthy workspace must still be reachable');
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('an OAuth token falls back the same way a session does', async () => {
  // The case the fallback was built for: a hosted connector, whose token is
  // minted against the personal org and whose client cannot send a header.
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const previousBase = process.env.API_BASE_URL;
  try {
    await join(sarah, marcus);
    const oauthKey = await mintOauthToken(marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    const res = await asKey(request(httpServer).post('/mcp').set(MCP_HEADERS), oauthKey)
      .send(rpc('start_session', {}));
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['x-deerdawn-workspace-fallback'], sarah.orgId);
    const payload = parseRpc(res);
    const said = payload?.result?.content?.[0]?.text || '';
    assert.match(said, /personal workspace/i, `start_session must say which workspace this is: ${said.slice(0, 200)}`);
  } finally {
    if (previousBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = previousBase;
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

// ---------------------------------------------------------------------------
// 2. Reads may be served by the fallback. Writes may not.
// ---------------------------------------------------------------------------

test('the switcher reports the fallback instead of naming a workspace it is not serving', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    const res = await asUser(request(httpServer).get('/api/v1/teams/workspaces'), marcus);
    assert.equal(res.status, 200, res.text);
    // `active` keeps its meaning: the stored choice.
    assert.equal(res.body.active, sarah.orgId);
    assert.ok(res.body.fallback, 'THE BUG: the switcher said "active: the team" while everything was being served by personal');
    assert.equal(res.body.fallback.from, sarah.orgId);
    assert.equal(res.body.fallback.to, marcus.orgId);
    assert.equal(res.body.fallback.reason, 'subscription_inactive');
    assert.match(res.body.fallback.from_name, /sarah/i);
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('a healthy team reports no fallback at all', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    const res = await asUser(request(httpServer).get('/api/v1/teams/workspaces'), marcus);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.active, sarah.orgId);
    assert.equal(res.body.fallback, null);
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('a write under the fallback is refused rather than landing in the wrong workspace', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    const before = await db.query('SELECT COUNT(*)::int AS n FROM context_projects WHERE owner_key = $1', [marcus.orgId], 'org-system');
    const created = await asUser(request(httpServer).post('/api/v1/context/projects'), marcus)
      .send({ project_name: `team roadmap ${uuidv4().slice(0, 5)}`, description: 'meant for the team', goals: [] });

    assert.equal(created.status, 409,
      `THE BUG: 201 into the personal workspace while the switcher named the team. Got ${created.status}: ${created.text}`);
    assert.equal(created.body.error, 'workspace_inactive');
    assert.equal(created.body.workspace, sarah.orgId);
    assert.match(created.body.message, /nothing was changed/);
    assert.match(created.body.message, /sarah/i, 'the refusal names the workspace that is refusing');

    const after = await db.query('SELECT COUNT(*)::int AS n FROM context_projects WHERE owner_key = $1', [marcus.orgId], 'org-system');
    assert.equal(after.rows[0].n, before.rows[0].n, 'nothing may have been written anywhere');
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('a read under the fallback is still served, with the header', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    const res = await asUser(request(httpServer).get('/api/v1/context/projects'), marcus)
      .set('Origin', 'https://app.deerdawn.com');
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers['x-deerdawn-workspace-fallback'], sarah.orgId);
    // Set is not the same as readable: the browser drops any header the server
    // does not expose, and this one was set and never exposed.
    assert.match(
      String(res.headers['access-control-expose-headers'] || ''),
      /x-deerdawn-workspace-fallback/i,
      'THE BUG: the only signal that this came from somewhere else was invisible to the browser',
    );
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('the exits stay open while the team is refusing', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    // Switching to personal is the one write that must always work: it is how
    // somebody gets out of a workspace they cannot pay for.
    const switched = await asUser(request(httpServer).post('/api/v1/teams/active'), marcus).send({ workspace: null });
    assert.equal(switched.status, 200, `POST /teams/active: ${switched.text}`);
    assert.equal(await workspace.getActiveWorkspace({ id: marcus.userId }), null);

    // And once out, an ordinary write lands in their own workspace.
    const created = await asUser(request(httpServer).post('/api/v1/context/projects'), marcus)
      .send({ project_name: `Marcus own work ${uuidv4().slice(0, 5)}`, description: 'mine', goals: [] });
    assert.equal(created.status, 201, created.text);
    const row = await projectRow(created.body.project?.project_id || created.body.project_id);
    assert.equal(row.owner_key, marcus.orgId);

    // Telemetry and sign-out are exempt by prefix and must stay reachable, or
    // the dashboard cannot even render the state that explains the refusal.
    const events = await asUser(request(httpServer).post('/api/v1/product-events'), marcus)
      .send({ event_name: 'dashboard_viewed', properties: {} });
    assert.ok(events.status < 500, `product events: ${events.status} ${events.text}`);
    assert.notEqual(events.status, 409, 'telemetry must never be refused as a wrong-workspace write');
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('an MCP write still lands, and says where it went', async () => {
  // An MCP client cannot send x-deerdawn-workspace and has no switcher, so
  // refusing its writes would leave it with nowhere to work. It falls back, and
  // the reply says so.
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const previousBase = process.env.API_BASE_URL;
  try {
    await join(sarah, marcus);
    const oauthKey = await mintOauthToken(marcus);
    await setBilling(sarah.orgId, 'developer_pro', 'past_due');

    const res = await asKey(request(httpServer).post('/mcp').set(MCP_HEADERS), oauthKey)
      .send(rpc('manage_projects', { action: 'create', project_name: `MCP project ${uuidv4().slice(0, 5)}` }));
    assert.equal(res.status, 200, res.text);
    const payload = parseRpc(res);
    assert.ok(!payload?.error, `the write must still land: ${JSON.stringify(payload).slice(0, 300)}`);
    const said = payload?.result?.content?.[0]?.text || '';
    assert.match(
      said,
      /personal workspace/i,
      `THE BUG: the reply read exactly like a save into the team: ${said.slice(0, 300)}`,
    );
  } finally {
    if (previousBase === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = previousBase;
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

// ---------------------------------------------------------------------------
// 3. Pointing an existing install at the team.
// ---------------------------------------------------------------------------

test('the committable .mcp.json names the team workspace and still carries no credential', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);

    const res = await asUser(request(httpServer).get('/api/v1/teams/workspace-config'), marcus, sarah.orgId);
    assert.equal(res.status, 200, res.text);
    const contents = res.body.files[0].contents;

    assert.match(contents, /"DEERDAWN_WORKSPACE": "org-/,
      'THE BUG: the file named no workspace, so an existing install stayed in its own');
    assert.ok(contents.includes(sarah.orgId), 'it has to name THIS workspace');
    assert.equal(res.body.contains_secrets, false);
    assert.ok(!/DEERDAWN_API_KEY/.test(contents), 'a key in a committed file outlives every rotation');
    assert.ok(!/dd_/.test(contents), 'no credential of any shape may appear here');
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('a personal workspace config names no workspace', async () => {
  // There is nothing to point at: the only workspace this config could reach is
  // the one it already reaches.
  const solo = await makePerson('solo');
  try {
    const res = await asUser(request(httpServer).get('/api/v1/teams/workspace-config'), solo);
    assert.equal(res.status, 200, res.text);
    assert.ok(!/DEERDAWN_WORKSPACE/.test(res.body.files[0].contents), res.body.files[0].contents);
  } finally {
    await cleanup([solo.orgId]);
  }
});

test('a personal key may reach the team by header, and only while its holder is a member', async () => {
  // The sending side of the .mcp.json fix: DEERDAWN_WORKSPACE becomes
  // x-deerdawn-workspace, which is membership-checked on every request.
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const stranger = await makePerson('stranger');
  try {
    const made = await asUser(request(httpServer).post('/api/v1/context/projects'), sarah)
      .send({ project_name: `Team roadmap ${uuidv4().slice(0, 5)}`, description: 'team', goals: [] });
    assert.equal(made.status, 201, made.text);
    const teamProject = made.body.project?.project_id || made.body.project_id;
    await db.query('UPDATE context_projects SET visibility = \'shared\' WHERE project_id = $1', [teamProject], 'org-system');

    await join(sarah, marcus);
    // marcus.apiKey was minted against his PERSONAL org, before the invite.
    const admitted = await asKey(request(httpServer).get('/api/v1/context/projects'), marcus.apiKey, sarah.orgId);
    assert.equal(admitted.status, 200, admitted.text);
    const ids = (admitted.body.projects || []).map((p) => p.project_id);
    assert.ok(ids.includes(teamProject), `the header is the existing install's way in. Saw: ${JSON.stringify(ids)}`);

    const refused = await asKey(request(httpServer).get('/api/v1/context/projects'), stranger.apiKey, sarah.orgId);
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.body.error, 'workspace_forbidden');
  } finally {
    await cleanup([sarah.orgId, marcus.orgId, stranger.orgId]);
  }
});

test('a key-authed viewer reaching the team by header is capped to reading', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus, { role: 'viewer' });
    const res = await asKey(request(httpServer).post('/api/v1/context/projects'), marcus.apiKey, sarah.orgId)
      .send({ project_name: `Viewer write ${uuidv4().slice(0, 5)}`, description: 'nope', goals: [] });
    assert.ok(res.status === 403, `a viewer's key must not write into the team: ${res.status} ${res.text}`);

    // And the cap does not follow them home.
    const own = await asKey(request(httpServer).post('/api/v1/context/projects'), marcus.apiKey)
      .send({ project_name: `Own work ${uuidv4().slice(0, 5)}`, description: 'mine', goals: [] });
    assert.equal(own.status, 201, `the team's read-only ceiling must not reach their own account: ${own.text}`);
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('start_session tells a plain key holder that their team is somewhere this key cannot reach', async () => {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  try {
    await join(sarah, marcus);
    // A plain key, minted against his personal org before the invite, which is
    // exactly what an existing local install is holding.
    const res = await asKey(request(httpServer).post('/mcp').set(MCP_HEADERS), marcus.apiKey)
      .send(rpc('start_session', {}));
    assert.equal(res.status, 200, res.text);
    const said = parseRpc(res)?.result?.content?.[0]?.text || '';
    // Pinned on what the sentence has to SAY, not on its first wording: that
    // this key is personal, which team is therefore missing, and the way in.
    assert.match(said, /nothing from sarah[^.]* is in this session/i, `THE BUG: the brief was simply empty of the team, with no explanation: ${said.slice(0, 300)}`);
    assert.match(said, /\.mcp\.json|run setup/i, 'say how to reach it');
  } finally {
    await cleanup([sarah.orgId, marcus.orgId]);
  }
});

test('a solo account hears nothing about other workspaces', async () => {
  const solo = await makePerson('solo');
  try {
    const res = await asKey(request(httpServer).post('/mcp').set(MCP_HEADERS), solo.apiKey)
      .send(rpc('start_session', {}));
    assert.equal(res.status, 200, res.text);
    const said = parseRpc(res)?.result?.content?.[0]?.text || '';
    assert.ok(!/is in this session|also a member of/i.test(said), said.slice(0, 300));
  } finally {
    await cleanup([solo.orgId]);
  }
});
