/**
 * THE INVITED TEAMMATE'S FIRST SESSION.
 *
 * Somebody accepts an invite, connects Claude.ai, and calls start_session. They
 * have authored nothing. On origin/main c9bf3afe:
 *
 *   - resolveActiveProject returned null for them (pinned as intended by a test
 *     that was about a different person), so the hosted connector answered with
 *     the workspace overview instead of a brief, team_context_received could not
 *     fire on the one session it exists for, and any call without a project_id
 *     threw "No active project".
 *   - hosted start_session ignored a project_id the caller passed.
 *   - the dashboard's onboarding signals were workspace-wide, so the invitee
 *     arrived already "has a project", "connected" and "first sync done" — all of
 *     them the founder's — and was walked past every setup step.
 *
 * Against the real app and a real database, as two people with their own
 * credentials. DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/invited-teammate-first-session.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  const { key, prefix, hash } = generateApiKey();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production', expiresAt, ['context:read', 'context:write']],
    orgId,
  );
  return { label, orgId, userId, email, apiKey: key };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

function as(req, person, workspaceKey) {
  const r = req.set('X-Api-Key', person.apiKey);
  return workspaceKey ? r.set('x-deerdawn-workspace', workspaceKey) : r;
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
}

async function hosted(person, workspaceKey, name, args) {
  const res = await as(request(httpServer).post('/mcp').set(MCP_HEADERS), person, workspaceKey).send(rpc(name, args));
  assert.equal(res.status, 200, res.text);
  return parseRpc(res);
}

async function createProject(person, workspaceKey, name, extra = {}) {
  const res = await as(request(httpServer).post('/api/v1/context/projects'), person, workspaceKey)
    .send({ project_name: name, description: 'team work', goals: [], ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.project?.project_id || res.body.project_id;
}

/**
 * Make `projectId` the workspace's most recently updated project, relative to
 * the NEWEST ROW, not to the database clock.
 *
 * The service stamps updated_at from the API process's clock (isoNow()), and
 * this used to set `NOW() + 1 second` from the database's. Two clocks: whenever
 * the API host ran more than a second ahead of Postgres — Docker Desktop's VM
 * clock lags the Mac's after the laptop sleeps — the OTHER project's app-stamped
 * updated_at was still the newer one, and the invitee was (correctly) handed
 * "Ledger Service", failing tests 1-2 in a long full-suite run while passing
 * alone. Reproduced by running this file with Date shifted +3s.
 */
async function makeMostRecent(ownerKey, projectId) {
  await db.query(
    `UPDATE context_projects
        SET updated_at = (SELECT MAX(updated_at) FROM context_projects WHERE owner_key = $2) + INTERVAL '1 second'
      WHERE project_id = $1`,
    [projectId, ownerKey],
    'org-system',
  );
}

/** A founder with history, and a colleague who has just accepted their invite. */
async function teamWithNewInvitee() {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const team = sarah.orgId;
  await workspace.addMember(team, sarah.userId, { role: 'owner' });

  const MARK = `TEAMBRIEF-${uuidv4().slice(0, 8)}`;
  const sharedId = await createProject(sarah, null, `Payments API ${uuidv4().slice(0, 6)}`);
  const otherId = await createProject(sarah, null, `Ledger Service ${uuidv4().slice(0, 6)}`);
  await as(request(httpServer).patch(`/api/v1/context/projects/${sharedId}/context`), sarah)
    .send({ current_task: `Ship idempotency keys ${MARK}` });

  // The founder's own evidence of being connected and activated.
  for (const eventName of ['mcp_start_session_succeeded', 'first_sync_completed']) {
    await db.query(
      `INSERT INTO product_events (event_id, event_name, org_id, user_id, source, surface, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, '{}'::jsonb)`,
      [crypto.randomUUID(), eventName, team, sarah.userId, eventName.startsWith('mcp_') ? 'mcp' : 'api', 'claude_code'],
      team,
    );
  }

  const invite = await workspace.createInvite(team, marcus.email, { role: 'member', invitedBy: sarah.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: marcus.userId, email: marcus.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);

  // Inviting somebody flips what predates them to personal. Sarah shares two.
  for (const id of [sharedId, otherId]) {
    await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [id, 'shared'], 'org-system');
  }
  // The one with the marker is the most recently active.
  await makeMostRecent(team, sharedId);

  return { sarah, marcus, team, sharedId, otherId, MARK };
}

test('an invited teammate\'s first hosted start_session opens the team\'s shared brief', async () => {
  const fx = await teamWithNewInvitee();
  try {
    const payload = await hosted(fx.marcus, fx.team, 'start_session', {});
    assert.ok(!payload.error, JSON.stringify(payload.error));
    const text = payload.result?.content?.[0]?.text || '';
    assert.ok(
      text.includes(fx.MARK),
      `THE BUG: the invitee got the workspace overview, not the shared project's brief. Got: ${text.slice(0, 400)}`
    );
    assert.match(text, /no project of your own yet/, 'the brief should say why this project was chosen');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('an invited teammate can read and write without naming a project', async () => {
  const fx = await teamWithNewInvitee();
  try {
    const read = await hosted(fx.marcus, fx.team, 'recall', { action: 'context', sections: ['task'] });
    assert.ok(!read.error, `THE BUG: an id-less read threw for the invitee: ${JSON.stringify(read.error)}`);
    assert.ok((read.result?.content?.[0]?.text || '').includes(fx.MARK));

    const NOTE = `Marcus reviewed the retry policy. INVITEE-${uuidv4().slice(0, 8)}`;
    const write = await hosted(fx.marcus, fx.team, 'update_context', { summary: NOTE });
    assert.ok(!write.error, `an id-less write threw for the invitee: ${JSON.stringify(write.error)}`);
    assert.equal(write.result?.structuredContent?.project_id, fx.sharedId, 'the write landed somewhere other than the shared project');
    assert.equal(write.result?.structuredContent?.stored, true);

    // And the founder reads it back: the write reached the shared brief.
    const asSarah = await hosted(fx.sarah, null, 'recall', { action: 'context', project_id: fx.sharedId, sections: ['decisions'] });
    assert.ok((asSarah.result?.content?.[0]?.text || '').includes(NOTE));
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

// Most invitees have written something of their own before they join. That
// makes the shared project a READ for them, not a write target (their next
// id-less save could be about their own work), but it must not cost them the
// team's brief on their first session, which is what this whole file is for.
test('an invitee who already has a personal project still opens the team\'s shared brief, read-only', async () => {
  const fx = await teamWithNewInvitee();
  try {
    const ownName = `Marcus Side Project ${uuidv4().slice(0, 6)}`;
    const ownId = await createProject(fx.marcus, null, ownName);

    const payload = await hosted(fx.marcus, fx.team, 'start_session', {});
    assert.ok(!payload.error, JSON.stringify(payload.error));
    const text = payload.result?.content?.[0]?.text || '';
    // "Resuming", not only the marker: the workspace overview a null resolution
    // falls back to also quotes the shared project's task.
    assert.match(text, /(^|\n)Resuming /, `the invitee with a personal project got no shared brief. Got: ${text.slice(0, 400)}`);
    assert.ok(text.includes(fx.MARK), `and not the team's shared brief. Got: ${text.slice(0, 400)}`);
    assert.match(text, /your own projects are in another workspace you belong to/, 'the brief says why they are seeing it');
    assert.ok(!/no project of your own yet/.test(text), 'the newcomer line would be false for them');
    assert.ok(!text.includes(ownName) && !text.includes(ownId), 'their personal project is not named into the team');

    const write = await hosted(fx.marcus, fx.team, 'manage_memory', { action: 'update', summary: `NOT-FOR-THE-TEAM-${uuidv4().slice(0, 8)}` });
    assert.equal(write.result?.isError, true, `an id-less save is refused for them: ${JSON.stringify(write.result || write.error).slice(0, 300)}`);
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('hosted start_session opens the project the caller names', async () => {
  const fx = await teamWithNewInvitee();
  try {
    const OTHER = `LEDGER-${uuidv4().slice(0, 8)}`;
    await as(request(httpServer).patch(`/api/v1/context/projects/${fx.otherId}/context`), fx.sarah)
      .send({ current_task: `Reconcile the ledger ${OTHER}` });
    // Keep the OTHER project the less recent one, so only project_id can pick it.
    await makeMostRecent(fx.team, fx.sharedId);

    const payload = await hosted(fx.sarah, null, 'start_session', { project_id: fx.otherId });
    assert.ok(!payload.error, `THE BUG: project_id was refused at validation: ${JSON.stringify(payload.error)}`);
    const text = payload.result?.content?.[0]?.text || '';
    assert.ok(text.includes(OTHER), `THE BUG: start_session ignored project_id. Got: ${text.slice(0, 300)}`);
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('start_session does not confirm a project the caller may not see', async () => {
  const fx = await teamWithNewInvitee();
  try {
    const SECRET = `SECRETTASK-${uuidv4().slice(0, 8)}`;
    const personalId = await createProject(fx.sarah, null, `Sarah side project ${uuidv4().slice(0, 6)}`);
    await as(request(httpServer).patch(`/api/v1/context/projects/${personalId}/context`), fx.sarah)
      .send({ current_task: SECRET });
    await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [personalId, 'personal'], 'org-system');

    const payload = await hosted(fx.marcus, fx.team, 'start_session', { project_id: personalId });
    const text = JSON.stringify(payload);
    assert.ok(!text.includes(SECRET), 'a personal project\'s task reached a colleague through start_session');
    assert.ok(!text.includes('Sarah side project'), 'a personal project\'s name reached a colleague');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('the dashboard does not tell an invitee they are already connected and briefed', async () => {
  const fx = await teamWithNewInvitee();
  try {
    const asMarcus = await as(request(httpServer).get('/api/v1/dashboard/bootstrap'), fx.marcus, fx.team);
    assert.equal(asMarcus.status, 200, asMarcus.text);
    const his = asMarcus.body.sync_health || asMarcus.body.data?.sync_health;
    assert.ok(his, `no sync_health in the bootstrap payload: ${Object.keys(asMarcus.body)}`);
    assert.equal(his.mcp_registered, false, 'THE BUG: the invitee inherited the founder\'s MCP connection');
    assert.equal(his.has_first_sync, false, 'THE BUG: the invitee inherited the founder\'s first sync');
    assert.equal(his.has_projects, false, 'THE BUG: the invitee inherited the founder\'s projects as their own brief');

    // The founder is untouched by the scoping.
    const asSarah = await as(request(httpServer).get('/api/v1/dashboard/bootstrap'), fx.sarah);
    const hers = asSarah.body.sync_health || asSarah.body.data?.sync_health;
    assert.equal(hers.mcp_registered, true);
    assert.equal(hers.has_first_sync, true);
    assert.equal(hers.has_projects, true);
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

// Journey round 5 (owner decision): a row with no person on it is credited to
// nobody. This test used to pin the opposite (an owner kept them, so the founder
// whose history predates per-user attribution was not sent back through
// onboarding the day they invited somebody). Now neither the founder nor the
// invitee reads unowned history as their own; what the founder did as a person
// still counts.
test('once there are two people, history that carries no person is credited to neither of them', async () => {
  const fx = await teamWithNewInvitee();
  try {
    // What an account created before events carried a user_id looks like.
    await db.query('UPDATE product_events SET user_id = NULL WHERE org_id = $1', [fx.team], fx.team);
    await db.query('UPDATE context_projects SET owner_user_id = NULL WHERE owner_key = $1', [fx.team], 'org-system');

    const asSarah = await as(request(httpServer).get('/api/v1/dashboard/bootstrap'), fx.sarah);
    const hers = asSarah.body.sync_health || asSarah.body.data?.sync_health;
    assert.equal(hers.mcp_registered, false, 'unowned MCP events were credited to the founder');
    assert.equal(hers.has_first_sync, false);
    assert.equal(hers.has_projects, false);

    const asMarcus = await as(request(httpServer).get('/api/v1/dashboard/bootstrap'), fx.marcus, fx.team);
    const his = asMarcus.body.sync_health || asMarcus.body.data?.sync_health;
    assert.equal(his.mcp_registered, false, 'unattributed founder history was handed to the invitee');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});
