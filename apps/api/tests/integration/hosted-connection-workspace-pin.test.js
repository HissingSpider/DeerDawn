/**
 * A HOSTED CONNECTION ACTS IN THE WORKSPACE IT WAS APPROVED FOR, AND NOWHERE ELSE.
 *
 * An OAuth token (Claude, ChatGPT, an editor on the hosted endpoint) used to
 * follow whichever workspace its person had selected in the dashboard at the
 * moment of each call. So flipping the switcher to "personal" silently moved a
 * tool that a team owner could see (and be held to) as a TEAM connection, and a
 * tool approved in a personal workspace started writing to the team. Decided by
 * the owner:
 *
 *   - a token reads and writes only the workspace stamped on it at consent
 *     (api_keys.oauth_workspace_key); switching workspace moves nothing;
 *   - a person who is no longer a member of the stamped workspace is REFUSED,
 *     with the reason, not moved somewhere else; the refresh grant refuses too;
 *   - a hosted connection cannot switch itself: an x-deerdawn-workspace header
 *     naming another workspace is refused;
 *   - grants from before the stamp were stamped once, at boot, with the
 *     workspace their person had selected right then, so nothing moved
 *     overnight and owners see them.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/hosted-connection-workspace-pin.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
process.env.ENCRYPTION_MASTER_KEY = process.env.ENCRYPTION_MASTER_KEY || 'a'.repeat(64);
process.env.API_BASE_URL = process.env.API_BASE_URL || 'https://api.deerdawn.test';
process.env.DASHBOARD_URL = 'https://app.deerdawn.test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const app = require('../../src/app');
const db = require('../../src/config/db');
const { redis } = require('../../src/config/redis');
const workspace = require('../../src/services/workspaceService');
const service = require('../../src/services/contextSyncService');
const { backfillHostedConnectionWorkspaces, backfillRefreshRecordWorkspaces } = require('../../src/config/autoMigrate');
const { generateToken, hashPassword, generateApiKey, hashApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const BASE = process.env.API_BASE_URL.replace(/\/+$/, '');
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';
const created = { orgs: [], users: [] };
const refreshKeyOf = (token) => `oauth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;

test.after(async () => {
  await db.query('DELETE FROM context_audit_logs WHERE owner_key = ANY($1)', [created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM api_keys WHERE owner_id = ANY($1) OR org_id = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = ANY($1)', [created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE user_id = ANY($1) OR owner_key = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM product_events WHERE org_id = ANY($1)', [created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM users WHERE user_id = ANY($1)', [created.users], 'org-system').catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = ANY($1)', [created.orgs], 'org-system').catch(() => {});
});

async function makePerson(label, { plan = 'enterprise' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@pin.test`;
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
  created.orgs.push(orgId);
  created.users.push(userId);
  return { label, email, orgId, userId, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
}

async function makeTeam(label) {
  const owner = await makePerson(`${label}-owner`);
  await workspace.ensureOwnerMembership(owner.orgId, owner.userId);
  return { owner, key: owner.orgId };
}

async function join(team, person, role = 'member') {
  await workspace.ensureOwnerMembership(person.orgId, person.userId);
  await workspace.addMember(team.key, person.userId, { role, invitedBy: team.owner.userId });
}

/** Where this person is working (the dashboard switcher); null is their own workspace. */
const workIn = (person, key) => workspace.setActiveWorkspace({ id: person.userId, org_id: person.orgId }, key);

/** A project the person can be shown, written into exactly one workspace. */
async function seedProject(inKey, author, name) {
  await service.createProject(
    { type: 'user', id: author.userId, org_id: author.orgId, workspace_key: inKey, role: 'admin' },
    { project_name: name },
  );
  return name;
}

const CLIENTS = {
  claude: { client_name: 'Claude', redirect: 'https://claude.ai/api/mcp/auth_callback', path: '/mcp/claude' },
  chatgpt: { client_name: 'ChatGPT', redirect: 'https://chatgpt.com/connector_platform_oauth_redirect', path: '/mcp' },
};

async function connect(person, client) {
  const reg = await request(httpServer).post('/api/v1/oauth/register').send({
    client_name: client.client_name, redirect_uris: [client.redirect], token_endpoint_auth_method: 'none',
  });
  assert.equal(reg.status, 201, reg.text);
  const clientId = reg.body.client_id;
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const resource = `${BASE}${client.path}`;
  const authorize = await request(httpServer).get('/api/v1/oauth/authorize').query({
    response_type: 'code', client_id: clientId, redirect_uri: client.redirect,
    code_challenge: challenge, code_challenge_method: 'S256', state: 's',
    scope: 'context:read context:write', resource,
  });
  assert.equal(authorize.status, 302, authorize.text);
  const approve = await request(httpServer).post('/api/v1/oauth/approve')
    .set('Authorization', `Bearer ${person.jwt}`)
    .send({ req: authorize.headers.location.slice(CONSENT.length) });
  assert.equal(approve.status, 200, approve.text);
  const token = await request(httpServer).post('/api/v1/oauth/token').type('form').send({
    grant_type: 'authorization_code', code: new URL(approve.body.redirect).searchParams.get('code'),
    code_verifier: verifier, client_id: clientId, redirect_uri: client.redirect, resource,
  });
  assert.equal(token.status, 200, token.text);
  return { ...client, clientId, access: token.body.access_token, refresh: token.body.refresh_token };
}

/** What this connection is shown when it lists projects. */
async function projects(conn, headers = {}) {
  const res = await request(httpServer).post(conn.path)
    .set({ Accept: 'application/json, text/event-stream', Authorization: `Bearer ${conn.access}`, ...headers })
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { action: 'projects' } } });
  return { status: res.status, text: res.text, headers: res.headers };
}

async function callTool(conn, name, args = {}) {
  const res = await request(httpServer).post(conn.path)
    .set({ Accept: 'application/json, text/event-stream', Authorization: `Bearer ${conn.access}` })
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  return { status: res.status, text: res.text };
}

function refresh(conn) {
  return request(httpServer).post('/api/v1/oauth/token').type('form')
    .send({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId });
}

const stampOf = async (conn) => (await db.query(
  'SELECT oauth_workspace_key FROM api_keys WHERE key_hash = $1',
  [hashApiKey(conn.access)], 'org-system')).rows[0]?.oauth_workspace_key;

async function teamWithColleague(label) {
  const team = await makeTeam(label);
  const colleague = await makePerson(`${label}-colleague`);
  await join(team, colleague);
  const teamProject = await seedProject(team.key, team.owner, `TeamAtlas-${uuidv4().slice(0, 6)}`);
  const ownProject = await seedProject(colleague.orgId, colleague, `OwnAtlas-${uuidv4().slice(0, 6)}`);
  return { team, colleague, teamProject, ownProject };
}

for (const client of [CLIENTS.chatgpt, CLIENTS.claude]) {
  test(`a token approved for the team keeps reading the team after the person switches to personal (${client.path})`, async () => {
    const { team, colleague, teamProject, ownProject } = await teamWithColleague('pinned');
    await workIn(colleague, team.key);
    const conn = await connect(colleague, client);
    const before = await projects(conn);
    assert.equal(before.status, 200, before.text);
    assert.ok(before.text.includes(teamProject), `the team project is not shown while working in the team: ${before.text}`);

    await workIn(colleague, null);
    const after = await projects(conn);
    assert.equal(after.status, 200, after.text);
    assert.ok(after.text.includes(teamProject), `THE BUG: switching to personal moved the tool out of the team: ${after.text}`);
    assert.ok(!after.text.includes(ownProject), `the personal workspace leaked into a team-pinned tool: ${after.text}`);

    const rotated = await refresh(conn);
    assert.equal(rotated.status, 200, rotated.text);
    conn.access = rotated.body.access_token;
    const later = await projects(conn);
    assert.ok(later.text.includes(teamProject), `a refresh moved the pin: ${later.text}`);
    assert.equal(await stampOf(conn), team.key, 'the refreshed key lost its stamp');
  });

  test(`a token approved in the personal workspace cannot read the team after a switch (${client.path})`, async () => {
    const { team, colleague, teamProject, ownProject } = await teamWithColleague('personal');
    await workIn(colleague, null);
    const conn = await connect(colleague, client);
    const before = await projects(conn);
    assert.ok(before.text.includes(ownProject), before.text);

    await workIn(colleague, team.key);
    const after = await projects(conn);
    assert.equal(after.status, 200, after.text);
    assert.ok(!after.text.includes(teamProject), `THE BUG: a personal tool started reading the team after a switch: ${after.text}`);
    assert.ok(after.text.includes(ownProject), after.text);
  });
}

test('a person removed from the stamped workspace is refused with the reason, not moved elsewhere', async () => {
  const { team, colleague, teamProject, ownProject } = await teamWithColleague('removed');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  assert.equal((await projects(conn)).status, 200);

  await workspace.removeMember(team.key, colleague.userId);
  const res = await projects(conn);
  assert.equal(res.status, 401, `a removed member's tool was moved somewhere, or refused without a reconnect: ${res.status} ${res.text}`);
  // The same challenge every other 401 on /mcp carries, so Claude and ChatGPT start the OAuth flow again.
  assert.match(String(res.headers['www-authenticate'] || ''), /^Bearer resource_metadata=".*\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.match(res.text, /no longer a member of the workspace/i);
  assert.ok(!res.text.includes(teamProject) && !res.text.includes(ownProject), 'it read a workspace anyway');

  const r = await refresh(conn);
  assert.equal(r.status, 400, `the refresh grant kept minting for a removed member: ${r.text}`);
  assert.equal(r.body.error, 'invalid_grant');
});

test('a hosted connection cannot switch itself to another workspace with a header', async () => {
  const { team, colleague, teamProject } = await teamWithColleague('header');
  const other = await makeTeam('header-other');
  await join(other, colleague);
  const otherProject = await seedProject(other.key, other.owner, `OtherAtlas-${uuidv4().slice(0, 6)}`);
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);

  const res = await projects(conn, { 'x-deerdawn-workspace': other.key });
  assert.equal(res.status, 403, `a header moved a pinned connection: ${res.status} ${res.text}`);
  assert.ok(!res.text.includes(otherProject));
  assert.match(res.text, /workspace_pinned|approved for another workspace/);
  // Naming the workspace it is already in changes nothing.
  const same = await projects(conn, { 'x-deerdawn-workspace': team.key });
  assert.equal(same.status, 200, same.text);
  assert.ok(same.text.includes(teamProject));
});

test('the boot backfill stamps each old grant with the workspace its person has selected now, once', async () => {
  const { team, colleague } = await teamWithColleague('backfill');
  const solo = await makePerson('backfill-solo');
  const drifter = await makePerson('backfill-removed');
  await join(team, drifter);

  const old = async (person, tag) => {
    const { key, prefix, hash } = generateApiKey();
    await db.query(
      `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_resource, oauth_client_id, oauth_client_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [`key-${uuidv4()}`, prefix, hash, 'DeerDawn MCP (OAuth)', person.userId, person.orgId, 'production',
        new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'], `${BASE}/mcp`, `mcp_old_${tag}`, 'Claude'],
      person.orgId,
    );
    const refreshToken = `ddr_${crypto.randomBytes(32).toString('hex')}`;
    await redis.set(refreshKeyOf(refreshToken), JSON.stringify({
      owner_id: person.userId, org_id: person.orgId, client_id: `mcp_old_${tag}`, client_name: 'Claude',
      scope: 'context:read context:write', resource: `${BASE}/mcp`, access_key_hash: hash,
    }));
    await redis.sadd(`oauth:refresh:owner:${person.orgId}`, refreshKeyOf(refreshToken));
    return { key, hash, refreshToken, tag };
  };
  const stamp = async (grant) => (await db.query('SELECT oauth_workspace_key FROM api_keys WHERE key_hash = $1', [grant.hash], 'org-system')).rows[0].oauth_workspace_key;
  const recordStamp = async (grant) => JSON.parse(await redis.get(refreshKeyOf(grant.refreshToken))).workspace_key;

  await workIn(colleague, team.key);
  const inTeam = await old(colleague, 'team');
  const home = await old(solo, 'solo');
  // Selected a team, then was removed from it: nothing selected any more.
  await workIn(drifter, team.key);
  const removedFrom = await old(drifter, 'removed');
  await workspace.removeMember(team.key, drifter.userId);

  await backfillHostedConnectionWorkspaces();
  await backfillRefreshRecordWorkspaces();
  assert.equal(await stamp(inTeam), team.key, 'a grant of somebody working in the team is not stamped with the team');
  assert.equal(await recordStamp(inTeam), team.key, 'its refresh record is not stamped');
  assert.equal(await stamp(home), solo.orgId, 'nobody selected: it should be their personal workspace');
  assert.equal(await recordStamp(home), solo.orgId);
  assert.equal(await stamp(removedFrom), drifter.orgId, 'a removed member falls back to their personal workspace');

  // Idempotent: a second pass after the person moved changes nothing.
  await workIn(colleague, null);
  await backfillHostedConnectionWorkspaces();
  await backfillRefreshRecordWorkspaces();
  assert.equal(await stamp(inTeam), team.key, 'a second boot restamped a grant');
  assert.equal(await recordStamp(inTeam), team.key);

  // And the owner now sees it.
  const list = await request(httpServer).get('/api/v1/teams/connections').set('Authorization', `Bearer ${team.owner.jwt}`);
  assert.equal(list.status, 200, list.text);
  const row = list.body.connections.find((c) => c.client_id === 'mcp_old_team');
  assert.ok(row, `a backfilled grant is not in the owner's list: ${JSON.stringify(list.body)}`);
  assert.equal(row.person.user_id, colleague.userId);
  assert.ok(!list.body.connections.some((c) => c.client_id === 'mcp_old_solo'), 'a personal grant is in the owner list');
});

test('an old refresh record with no stamp is stamped from its key when it is next used', async () => {
  const { team, colleague, teamProject } = await teamWithColleague('lazy');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  // Make it look like a grant from before the stamp: no stamp on the record or the key.
  const recordKey = refreshKeyOf(conn.refresh);
  const record = JSON.parse(await redis.get(recordKey));
  delete record.workspace_key;
  await redis.set(recordKey, JSON.stringify(record));
  await db.query('UPDATE api_keys SET oauth_workspace_key = $2 WHERE key_hash = $1',
    [hashApiKey(conn.access), team.key], 'org-system');
  await workIn(colleague, null);

  const rotated = await refresh(conn);
  assert.equal(rotated.status, 200, rotated.text);
  conn.access = rotated.body.access_token;
  assert.equal(await stampOf(conn), team.key, 'the rotated key was not stamped from the old one');
  assert.ok((await projects(conn)).text.includes(teamProject));
});

// ── Removing or leaving takes the connections stamped for that workspace with it ──

const removeMemberRoute = (asPerson, userId, workspaceKey) => request(httpServer)
  .delete(`/api/v1/teams/members/${encodeURIComponent(userId)}`)
  .set({ Authorization: `Bearer ${asPerson.jwt}`, ...(workspaceKey ? { 'x-deerdawn-workspace': workspaceKey } : {}) });

for (const via of ['an owner removes them', 'they leave']) {
  test(`when ${via}, every connection stamped for the workspace is revoked and a re-invite does not revive it`, async () => {
    const { team, colleague, teamProject, ownProject } = await teamWithColleague(via === 'they leave' ? 'leaves' : 'removes');
    const other = await makeTeam(`${via}-other`);
    await join(other, colleague);

    await workIn(colleague, team.key);
    const claude = await connect(colleague, CLIENTS.claude);
    const chatgpt = await connect(colleague, CLIENTS.chatgpt);
    await workIn(colleague, other.key);
    const elsewhere = await connect(colleague, CLIENTS.claude);
    await workIn(colleague, null);
    const personal = await connect(colleague, CLIENTS.chatgpt);
    await workIn(colleague, team.key);
    assert.equal((await projects(chatgpt)).status, 200);

    const res = via === 'they leave'
      ? await removeMemberRoute(colleague, colleague.userId, team.key)
      : await removeMemberRoute(team.owner, colleague.userId);
    assert.equal(res.status, 200, res.text);

    for (const conn of [claude, chatgpt]) {
      const after = await projects(conn);
      assert.equal(after.status, 401, `THE BUG: a removed member's team connection still answers: ${after.status} ${after.text}`);
      assert.ok(!after.text.includes(teamProject));
      const r = await refresh(conn);
      assert.equal(r.status, 400, `a removed member's refresh token still mints: ${r.text}`);
      assert.equal(r.body.error, 'invalid_grant');
    }
    assert.equal(res.body.connections_revoked, 2, JSON.stringify(res.body));

    // Re-invited without re-consent: nothing comes back.
    await workspace.addMember(team.key, colleague.userId, { role: 'member', invitedBy: team.owner.userId });
    await workIn(colleague, team.key);
    for (const conn of [claude, chatgpt]) {
      assert.equal((await projects(conn)).status, 401, 'THE BUG: a re-invite revived the old connection');
      assert.equal((await refresh(conn)).status, 400, 'a re-invite revived the old refresh token');
    }
    assert.equal((await db.query(
      'SELECT count(*)::int AS n FROM api_keys WHERE owner_id = $1 AND oauth_workspace_key = $2 AND status = \'active\'',
      [colleague.userId, team.key], 'org-system')).rows[0].n, 0);

    // Only what was stamped for this workspace: their other connections are theirs.
    assert.equal((await projects(elsewhere)).status, 200, 'a connection for another workspace was revoked');
    const stillPersonal = await projects(personal);
    assert.equal(stillPersonal.status, 200, 'a personal connection was revoked');
    assert.ok(stillPersonal.text.includes(ownProject));
  });
}

test('a removal that finds no connections still succeeds and says so', async () => {
  const { team, colleague } = await teamWithColleague('noconn');
  const res = await removeMemberRoute(team.owner, colleague.userId);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.connections_revoked, 0);
});

// ── A pinned connection says which workspace it is in ────────────────────────

test('a personal connection of somebody who joined a team and switched to it says where it works', async () => {
  const { team, colleague, ownProject } = await teamWithColleague('notice-personal');
  await workIn(colleague, null);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  await workIn(colleague, team.key);

  const res = await callTool(conn, 'start_session', {});
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /This connection works in your personal workspace/);
  assert.ok(res.text.includes(`To use it in ${team.owner.label} workspace`), `the team is not named: ${res.text.slice(0, 600)}`);
  assert.match(res.text, /approve the connection again from that workspace/i);
  assert.ok(res.text.includes(ownProject) || res.status === 200);
});

test('a team connection of somebody who switched to personal says where it works', async () => {
  const { team, colleague } = await teamWithColleague('notice-team');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.claude);
  await workIn(colleague, null);

  const res = await callTool(conn, 'start_session', {});
  assert.equal(res.status, 200, res.text);
  assert.ok(res.text.includes(`This connection works in ${team.owner.label} workspace`), res.text.slice(0, 600));
  assert.match(res.text, /To use it in your personal workspace, approve the connection again from that workspace/);
});

test('a connection in the workspace the person has selected says nothing, and neither does a solo account', async () => {
  const { team, colleague } = await teamWithColleague('notice-quiet');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  const same = await callTool(conn, 'start_session', {});
  assert.doesNotMatch(same.text, /This connection works in/);

  const solo = await makePerson('notice-solo');
  const soloConn = await connect(solo, CLIENTS.chatgpt);
  const alone = await callTool(soloConn, 'start_session', {});
  assert.equal(alone.status, 200, alone.text);
  assert.doesNotMatch(alone.text, /This connection works in/);
});

test('a personal connection of a team member who has not selected the team still hears about the team', async () => {
  const { team, colleague } = await teamWithColleague('notice-member');
  await workIn(colleague, null);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  const res = await callTool(conn, 'start_session', {});
  assert.match(res.text, /This connection works in your personal workspace/);
  assert.ok(res.text.includes(`${team.owner.label} workspace`), res.text.slice(0, 600));
});

// ── The boot pass must never bring a refresh record back ─────────────────────

test('stamping refresh records does not recreate one that was deleted after it was read', async () => {
  const { team, colleague } = await teamWithColleague('xx');
  await workIn(colleague, team.key);
  const tokenKey = refreshKeyOf(`ddr_${crypto.randomBytes(32).toString('hex')}`);
  const { prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_resource, oauth_client_id, oauth_client_name, oauth_workspace_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [`key-${uuidv4()}`, prefix, hash, 'DeerDawn MCP (OAuth)', colleague.userId, colleague.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read'], `${BASE}/mcp`, 'mcp_xx', 'Claude', team.key],
    colleague.orgId,
  );
  await redis.set(tokenKey, JSON.stringify({
    owner_id: colleague.userId, org_id: colleague.orgId, client_id: 'mcp_xx', scope: 'context:read',
    resource: `${BASE}/mcp`, access_key_hash: hash,
  }), 'EX', 3600);
  await redis.sadd(`oauth:refresh:owner:${colleague.orgId}`, tokenKey);

  // The record is read by the pass, then rotated away before the pass writes it back.
  const realGet = redis.get.bind(redis);
  redis.get = async (key) => {
    const value = await realGet(key);
    if (key === tokenKey) await redis.del(key);
    return value;
  };
  try {
    await backfillRefreshRecordWorkspaces();
  } finally {
    redis.get = realGet;
  }
  assert.equal(await realGet(tokenKey), null, 'THE BUG: the pass resurrected a deleted refresh token');
});

// ── A failed revoke must not leave a removal half done ───────────────────────

const { hostedConnections } = require('../../src/routes/oauth');

test('a removal whose connection revoke fails removes nobody, and the retry completes both', async () => {
  const { team, colleague } = await teamWithColleague('retry');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  assert.equal((await projects(conn)).status, 200);

  const real = hostedConnections.revokeForPersonInWorkspace;
  hostedConnections.revokeForPersonInWorkspace = async () => { throw new Error('forced revoke failure'); };
  let failed;
  try {
    failed = await removeMemberRoute(team.owner, colleague.userId);
  } finally {
    hostedConnections.revokeForPersonInWorkspace = real;
  }
  assert.equal(failed.status, 500, failed.text);
  assert.match(failed.body.message || '', /nothing was changed|Try again/i, 'the failure must say it is retryable');
  assert.ok(await workspace.getMembership(team.key, colleague.userId), 'THE BUG: the member was removed although the revoke failed');

  const retry = await removeMemberRoute(team.owner, colleague.userId);
  assert.equal(retry.status, 200, `the retry never reached the revoke: ${retry.status} ${retry.text}`);
  assert.equal(await workspace.getMembership(team.key, colleague.userId), null);
  assert.equal((await projects(conn)).status, 401, 'the retry did not revoke the connection');
});

test('a leave whose connection revoke fails keeps the person in, and the retry completes both', async () => {
  const { team, colleague } = await teamWithColleague('retry-leave');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.claude);
  const real = hostedConnections.revokeForPersonInWorkspace;
  hostedConnections.revokeForPersonInWorkspace = async () => { throw new Error('forced revoke failure'); };
  let failed;
  try {
    failed = await removeMemberRoute(colleague, colleague.userId, team.key);
  } finally {
    hostedConnections.revokeForPersonInWorkspace = real;
  }
  assert.equal(failed.status, 500, failed.text);
  assert.ok(await workspace.getMembership(team.key, colleague.userId), 'the person left although the revoke failed');
  const retry = await removeMemberRoute(colleague, colleague.userId, team.key);
  assert.equal(retry.status, 200, retry.text);
  assert.equal((await projects(conn)).status, 401);
});

// ── Belt and braces: joining again never revives an old grant ────────────────

test('a re-invite after a leftover grant does not revive it', async () => {
  const { team, colleague, teamProject } = await teamWithColleague('revive');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  // Removed by a path that revokes nothing (the service, not the route): the grant is left over.
  await workspace.removeMember(team.key, colleague.userId);
  assert.equal((await projects(conn)).status, 401, 'a removed member is refused while out');

  await workspace.addMember(team.key, colleague.userId, { role: 'member', invitedBy: team.owner.userId });
  await workIn(colleague, team.key);
  const back = await projects(conn);
  assert.equal(back.status, 401, `THE BUG: a re-invite revived the old connection: ${back.status}`);
  assert.ok(!back.text.includes(teamProject));
  assert.equal((await refresh(conn)).status, 400, 'a re-invite revived the old refresh token');

  // Consent again and it works: nothing was made permanent.
  const fresh = await connect(colleague, CLIENTS.chatgpt);
  assert.ok((await projects(fresh)).text.includes(teamProject));
});

test('adding somebody who is already a member leaves their connections alone', async () => {
  const { team, colleague } = await teamWithColleague('already');
  await workIn(colleague, team.key);
  const conn = await connect(colleague, CLIENTS.chatgpt);
  await workspace.addMember(team.key, colleague.userId, { role: 'member', invitedBy: team.owner.userId });
  assert.equal((await projects(conn)).status, 200, 'a repeat add revoked a live connection');
});
