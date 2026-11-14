/**
 * A WORKSPACE OWNER CAN SEE, AND CUT OFF, THE AI TOOLS A COLLEAGUE LET INTO
 * THE TEAM WORKSPACE.
 *
 * A hosted connection (Claude, ChatGPT, an editor on the hosted endpoint) is a
 * person's credential, and until now only the person who approved it could list
 * or remove it. When the connection was approved for the TEAM workspace it
 * reads and writes the team's memory, so the owner of that workspace must be
 * able to see it and take it back. Decided by the owner (BLOCKED 11):
 *
 *   - an owner of W lists every member's connection approved FOR W: the tool,
 *     the person, when it was approved, when it was last used;
 *   - nothing about a member's personal workspace or any other workspace, and
 *     never a token or a secret;
 *   - members and viewers see and remove their own only (GET /api/v1/connections,
 *     unchanged), and cannot use the owner routes;
 *   - the owner's disconnect really revokes: the next MCP call on the token is
 *     refused and the refresh grant answers invalid_grant;
 *   - an owner of W cannot reach a connection a colleague approved for another
 *     workspace, and the action is audited.
 *
 * "Approved for W" is the workspace the person was working in when they
 * approved (their active workspace at consent), stamped on the grant.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/workspace-connections-owner.test.js
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
const workspace = require('../../src/services/workspaceService');
const { generateToken, hashPassword, generateApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const BASE = process.env.API_BASE_URL.replace(/\/+$/, '');
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';
const created = { orgs: [], users: [] };

test.after(async () => {
  await db.query('DELETE FROM context_audit_logs WHERE owner_key = ANY($1)', [created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM api_keys WHERE owner_id = ANY($1) OR org_id = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE user_id = ANY($1) OR owner_key = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM product_events WHERE org_id = ANY($1)', [created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM users WHERE user_id = ANY($1)', [created.users], 'org-system').catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = ANY($1)', [created.orgs], 'org-system').catch(() => {});
});

async function makePerson(label, { plan = 'developer_pro' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@wsconnections.test`;
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

/** An enterprise workspace owned by `owner`, with the given members. */
async function makeTeam(label, members = []) {
  const owner = await makePerson(`${label}-owner`, { plan: 'enterprise' });
  await workspace.ensureOwnerMembership(owner.orgId, owner.userId);
  await workspace.setActiveWorkspace({ id: owner.userId, org_id: owner.orgId }, owner.orgId);
  return { owner, workspaceKey: owner.orgId, members };
}

async function join(team, person, role) {
  await workspace.ensureOwnerMembership(person.orgId, person.userId);
  await workspace.addMember(team.workspaceKey, person.userId, { role, invitedBy: team.owner.userId });
}

/** Where this person is working when they next approve a connection. */
async function workIn(person, workspaceKey) {
  await workspace.setActiveWorkspace({ id: person.userId, org_id: person.orgId }, workspaceKey);
}

const CLIENTS = {
  claude: { client_name: 'Claude', redirect: 'https://claude.ai/api/mcp/auth_callback', path: '/mcp/claude' },
  chatgpt: { client_name: 'ChatGPT', redirect: 'https://chatgpt.com/connector_platform_oauth_redirect', path: '/mcp' },
};

/** register -> authorize -> approve (as the person) -> token. */
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

/** One authenticated tools/call on this connection's access token. */
async function use(conn) {
  const res = await request(httpServer).post(conn.path)
    .set({ Accept: 'application/json, text/event-stream', Authorization: `Bearer ${conn.access}` })
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { action: 'projects' } } });
  return res.status;
}

function refresh(conn) {
  return request(httpServer).post('/api/v1/oauth/token').type('form')
    .send({ grant_type: 'refresh_token', refresh_token: conn.refresh, client_id: conn.clientId });
}

const as = (person) => ({ Authorization: `Bearer ${person.jwt}` });
const listTeam = (person) => request(httpServer).get('/api/v1/teams/connections').set(as(person));
const disconnectTeam = (person, id) => request(httpServer)
  .delete(`/api/v1/teams/connections/${encodeURIComponent(id)}`).set(as(person));

test('an owner lists what a colleague approved for the team: tool, person, dates, no secrets', async () => {
  const team = await makeTeam('lists');
  const colleague = await makePerson('colleague');
  await join(team, colleague, 'member');
  await workIn(colleague, team.workspaceKey);

  const claude = await connect(colleague, CLIENTS.claude);
  assert.equal(await use(claude), 200);
  await new Promise((r) => setTimeout(r, 200)); // last_used_at is written off the request path

  const res = await listTeam(team.owner);
  assert.equal(res.status, 200, `THE BUG: an owner cannot list the team's hosted connections: ${res.status} ${res.text}`);
  const row = res.body.connections.find((c) => c.client_id === claude.clientId);
  assert.ok(row, `the colleague's team connection is not listed: ${JSON.stringify(res.body)}`);
  assert.equal(row.client_name, 'Claude');
  assert.equal(row.surface, 'claude_web');
  assert.equal(row.person.user_id, colleague.userId);
  assert.equal(row.person.display_name, colleague.email);
  assert.ok(Date.parse(row.first_authorized_at) <= Date.parse(row.last_used_at), JSON.stringify(row));
  assert.ok(/^conn_[0-9a-f]{32}$/.test(row.connection_id), row.connection_id);

  const text = JSON.stringify(res.body);
  assert.ok(!/key_hash|key_id|dd_[0-9a-f]|ddr_|access_token|refresh_token/.test(text), `a credential leaked into the listing: ${text}`);
});

test('an owner does not see a colleague personal-workspace connection, or another team', async () => {
  const team = await makeTeam('scope');
  const other = await makeTeam('scope-other');
  const colleague = await makePerson('twice-a-member');
  await join(team, colleague, 'member');
  await join(other, colleague, 'member');

  await workIn(colleague, null); // working in their own workspace
  const personal = await connect(colleague, CLIENTS.chatgpt);
  await workIn(colleague, other.workspaceKey);
  const elsewhere = await connect(colleague, CLIENTS.claude);
  await workIn(colleague, team.workspaceKey);
  const forTeam = await connect(colleague, CLIENTS.claude);

  const mine = await listTeam(team.owner);
  assert.equal(mine.status, 200, mine.text);
  const ids = mine.body.connections.map((c) => c.client_id);
  assert.ok(ids.includes(forTeam.clientId), 'the team connection is listed');
  assert.ok(!ids.includes(personal.clientId), `the colleague's PERSONAL-workspace connection is visible to the owner: ${JSON.stringify(mine.body)}`);
  assert.ok(!ids.includes(elsewhere.clientId), `a connection approved for ANOTHER workspace is visible: ${JSON.stringify(mine.body)}`);

  const theirs = await listTeam(other.owner);
  assert.deepEqual(theirs.body.connections.map((c) => c.client_id), [elsewhere.clientId]);
});

test('a grant with no stamp yet (the boot backfill has not reached it) is not shown to an owner', async () => {
  const team = await makeTeam('legacy');
  const colleague = await makePerson('legacy-colleague');
  await join(team, colleague, 'member');
  await workIn(colleague, team.workspaceKey);
  const { prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_resource, oauth_client_id, oauth_client_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [`key-${uuidv4()}`, prefix, hash, 'DeerDawn MCP (OAuth)', colleague.userId, colleague.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'], `${BASE}/mcp`, 'mcp_prestamp', 'Claude'],
    colleague.orgId,
  );
  const res = await listTeam(team.owner);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.connections.length, 0, `an unstamped grant was attributed to the team: ${JSON.stringify(res.body)}`);
});

test('a member or a viewer cannot list the others, or remove anything through the owner routes', async () => {
  const team = await makeTeam('roles');
  const member = await makePerson('plain-member');
  const viewer = await makePerson('plain-viewer');
  const colleague = await makePerson('roles-colleague');
  await join(team, member, 'member');
  await join(team, viewer, 'viewer');
  await join(team, colleague, 'member');
  await workIn(colleague, team.workspaceKey);
  const theirs = await connect(colleague, CLIENTS.claude);
  const target = (await listTeam(team.owner)).body.connections.find((c) => c.client_id === theirs.clientId);
  assert.ok(target, 'the owner sees it');

  for (const [who, person] of [['a member', member], ['a viewer', viewer]]) {
    await workIn(person, team.workspaceKey);
    const listed = await listTeam(person);
    assert.equal(listed.status, 403, `${who} listed the team's connections: ${listed.status} ${listed.text}`);
    const removed = await disconnectTeam(person, target.connection_id);
    assert.equal(removed.status, 403, `${who} removed a colleague's connection: ${removed.status} ${removed.text}`);
    // What they always could: their own list, which is not the colleague's.
    const own = await request(httpServer).get('/api/v1/connections').set({ ...as(person), 'x-deerdawn-workspace': team.workspaceKey });
    assert.equal(own.status, 200, own.text);
    assert.ok(!own.body.connections.some((c) => c.client_id === theirs.clientId), `${who} sees a colleague's connection on their own list`);
  }
  assert.equal(await use(theirs), 200, 'the colleague was cut off by somebody who may not');
});

test('the owner disconnecting a colleague connection really revokes it, and says so in the audit', async () => {
  const team = await makeTeam('revoke');
  const colleague = await makePerson('revoked-colleague');
  const bystander = await makePerson('bystander');
  await join(team, colleague, 'member');
  await join(team, bystander, 'member');
  await workIn(colleague, team.workspaceKey);
  await workIn(bystander, team.workspaceKey);
  const claude = await connect(colleague, CLIENTS.claude);
  const chatgpt = await connect(colleague, CLIENTS.chatgpt);
  const kept = await connect(bystander, CLIENTS.claude);
  // A refresh mints a new key row; the stamp has to ride along or the
  // connection drops out of the owner's view after its first token expiry.
  const rotated = await refresh(claude);
  assert.equal(rotated.status, 200, rotated.text);
  claude.access = rotated.body.access_token;
  claude.refresh = rotated.body.refresh_token;
  assert.equal(await use(claude), 200);

  const listed = (await listTeam(team.owner)).body.connections;
  const mineOfHers = listed.filter((c) => c.client_id === claude.clientId && c.person.user_id === colleague.userId);
  assert.equal(mineOfHers.length, 1, `one row for a rotated connection: ${JSON.stringify(listed)}`);
  const target = mineOfHers[0];

  const res = await disconnectTeam(team.owner, target.connection_id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.disconnected, true);
  assert.equal(res.body.connection.client_name, 'Claude');
  assert.deepEqual(res.body.remaining, { access_tokens: 0, refresh_tokens: 0 });

  assert.equal(await use(claude), 401, 'THE POINT: the disconnected token still worked on /mcp');
  const r = await refresh(claude);
  assert.equal(r.status, 400, `the refresh grant minted the connection back: ${r.text}`);
  assert.equal(r.body.error, 'invalid_grant');

  assert.equal(await use(chatgpt), 200, 'the colleague\'s other connection was cut too');
  assert.equal(await use(kept), 200, 'somebody else\'s connection was cut too');
  const after = (await listTeam(team.owner)).body.connections;
  assert.ok(!after.some((c) => c.connection_id === target.connection_id), 'still listed after the disconnect');

  const audit = await db.query(
    `SELECT action, actor_user_id, metadata FROM context_audit_logs
      WHERE owner_key = $1 AND action = 'connection_disconnected_by_owner'`,
    [team.workspaceKey], 'org-system');
  assert.equal(audit.rows.length, 1, 'the disconnect is not in the team audit');
  assert.equal(audit.rows[0].actor_user_id, team.owner.userId);
  assert.equal(audit.rows[0].metadata.person_id, colleague.userId);
  assert.equal(audit.rows[0].metadata.client_name, 'Claude');
  assert.ok(!/dd_[0-9a-f]|ddr_/.test(JSON.stringify(audit.rows[0].metadata)), 'a credential in the audit row');
});

test('an owner cannot disconnect a connection a colleague approved for another workspace', async () => {
  const team = await makeTeam('cross-a');
  const other = await makeTeam('cross-b');
  const colleague = await makePerson('cross-colleague');
  await join(team, colleague, 'member');
  await join(other, colleague, 'member');

  await workIn(colleague, other.workspaceKey);
  const forOther = await connect(colleague, CLIENTS.claude);
  await workIn(colleague, null);
  const personal = await connect(colleague, CLIENTS.chatgpt);
  const otherRow = (await listTeam(other.owner)).body.connections.find((c) => c.client_id === forOther.clientId);
  assert.ok(otherRow, 'the other workspace\'s owner sees it');

  // The id belongs to the other workspace; this owner has never seen it.
  const res = await disconnectTeam(team.owner, otherRow.connection_id);
  assert.equal(res.status, 404, `an owner of one workspace revoked another's connection: ${res.status} ${res.text}`);
  // Nor can they reach the colleague's personal one, by any id the colleague's own list shows.
  const own = await request(httpServer).get('/api/v1/connections').set(as(colleague));
  const personalRow = own.body.connections.find((c) => c.client_id === personal.clientId);
  assert.ok(personalRow);
  const viaOwnId = await disconnectTeam(team.owner, personalRow.connection_id);
  assert.equal(viaOwnId.status, 404, `an owner reached a personal-workspace connection: ${viaOwnId.status} ${viaOwnId.text}`);

  assert.equal(await use(forOther), 200, 'the other workspace connection was revoked');
  assert.equal(await use(personal), 200, 'the personal connection was revoked');
});

test('a credential cannot use the owner disconnect', async () => {
  const team = await makeTeam('cred');
  const colleague = await makePerson('cred-colleague');
  await join(team, colleague, 'member');
  await workIn(colleague, team.workspaceKey);
  const theirs = await connect(colleague, CLIENTS.claude);
  const target = (await listTeam(team.owner)).body.connections.find((c) => c.client_id === theirs.clientId);
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'backend', team.owner.userId, team.owner.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write', 'context:admin']],
    team.owner.orgId,
  );
  const res = await request(httpServer).delete(`/api/v1/teams/connections/${target.connection_id}`).set({ 'X-Api-Key': key });
  assert.equal(res.status, 403, `an API key disconnected a colleague's connection: ${res.status} ${res.text}`);
  assert.equal(await use(theirs), 200);
});

test('on a lapsed team the owner can still list and disconnect: it is recovery, like the roster', async () => {
  const team = await makeTeam('lapsed');
  const colleague = await makePerson('lapsed-colleague');
  await join(team, colleague, 'member');
  await workIn(colleague, team.workspaceKey);
  const theirs = await connect(colleague, CLIENTS.claude);

  await db.query('UPDATE organizations SET subscription_status = \'past_due\' WHERE org_id = $1', [team.workspaceKey], 'org-system');

  const listed = await listTeam(team.owner);
  assert.equal(listed.status, 200, `THE BUG: a lapsed team's owner cannot list connections: ${listed.status} ${listed.text}`);
  const target = listed.body.connections.find((c) => c.client_id === theirs.clientId);
  assert.ok(target);
  const res = await disconnectTeam(team.owner, target.connection_id);
  assert.equal(res.status, 200, `THE BUG: a lapsed team's owner cannot disconnect: ${res.status} ${res.text}`);
  assert.equal(await use(theirs), 401);
});
