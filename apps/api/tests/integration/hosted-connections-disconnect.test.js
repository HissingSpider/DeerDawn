/**
 * THE CONSENT SCREEN PROMISED A REVOKE THAT DID NOT EXIST.
 *
 * "You can revoke access any time from your dashboard settings." Nothing listed
 * a person's hosted connections and nothing disconnected one. GET /api/v1/keys
 * hides the OAuth-minted keys on purpose (a new one is minted on every
 * refresh), and deleting one through DELETE /api/v1/keys/:id was undone by the
 * client's next refresh, which never checked that the key it was rotating had
 * been taken away (walker, 2026-09-27: "D refresh after key delete: 200 NEW
 * TOKEN MINTED").
 *
 * What must hold:
 *   - a person lists their own hosted connections, one row per client (not per
 *     rotating key), with where it connects and when it was authorised and
 *     last used;
 *   - disconnecting one retires its access AND refresh tokens, so the old
 *     token is refused and a refresh answers invalid_grant; the reply is built
 *     from a read-back;
 *   - every other connection keeps working: the same person's other clients,
 *     and anybody else's;
 *   - deleting the key through the keys route can no longer be refreshed away;
 *   - an ordinary refresh still rotates, and a refresh racing another refresh
 *     of the same grant is rotation, not revocation;
 *   - it is strictly the person's own: nobody else, a workspace owner included,
 *     can list or disconnect it through this route.
 *
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/hosted-connections-disconnect.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
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
const { redis } = require('../../src/config/redis');
const { generateToken, hashPassword, generateApiKey, hashApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const BASE = process.env.API_BASE_URL.replace(/\/+$/, '');
const CONSENT = 'https://app.deerdawn.test/oauth/consent?req=';
const created = { orgs: [], users: [] };
const refreshKeyOf = (token) => `oauth:refresh:${crypto.createHash('sha256').update(token).digest('hex')}`;

test.after(async () => {
  await db.query('DELETE FROM api_keys WHERE owner_id = ANY($1) OR org_id = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE user_id = ANY($1) OR owner_key = ANY($2)', [created.users, created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM product_events WHERE org_id = ANY($1)', [created.orgs], 'org-system').catch(() => {});
  await db.query('DELETE FROM users WHERE user_id = ANY($1)', [created.users], 'org-system').catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = ANY($1)', [created.orgs], 'org-system').catch(() => {});
});

async function makePerson(label, { plan = 'developer_pro' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, `${label}-${uuidv4().slice(0, 8)}@connections.test`, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  created.orgs.push(orgId);
  created.users.push(userId);
  return { label, orgId, userId, jwt: generateToken({ user_id: userId, org_id: orgId, role: 'admin' }) };
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
async function use(conn, access = conn.access) {
  const res = await request(httpServer).post(conn.path)
    .set({ Accept: 'application/json, text/event-stream', Authorization: `Bearer ${access}` })
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'recall', arguments: { action: 'projects' } } });
  return res.status;
}

async function refresh(conn, token = conn.refresh) {
  const res = await request(httpServer).post('/api/v1/oauth/token').type('form')
    .send({ grant_type: 'refresh_token', refresh_token: token, client_id: conn.clientId });
  return res;
}

/** Refresh and keep the new pair, as a client does. */
async function rotate(conn) {
  const res = await refresh(conn);
  assert.equal(res.status, 200, `an ordinary refresh must rotate: ${res.text}`);
  conn.access = res.body.access_token;
  conn.refresh = res.body.refresh_token;
  return res;
}

function listConnections(person, headers = { Authorization: `Bearer ${person.jwt}` }) {
  return request(httpServer).get('/api/v1/connections').set(headers);
}

function disconnect(person, connectionId, headers = { Authorization: `Bearer ${person.jwt}` }) {
  return request(httpServer).delete(`/api/v1/connections/${encodeURIComponent(connectionId)}`).set(headers);
}

async function connectionFor(person, conn) {
  const res = await listConnections(person);
  assert.equal(res.status, 200, `THE BUG: there is no list of hosted connections: ${res.status} ${res.text}`);
  return (res.body.connections || []).find((c) => c.client_id === conn.clientId) || null;
}

test('a person lists their hosted connections, one row per client, however often it rotated', async () => {
  const person = await makePerson('lister');
  const claude = await connect(person, CLIENTS.claude);
  const chatgpt = await connect(person, CLIENTS.chatgpt);
  await rotate(claude);
  await rotate(claude);
  assert.equal(await use(claude), 200);
  assert.equal(await use(chatgpt), 200);
  // last_used_at is written after the response, off the request path.
  await new Promise((r) => setTimeout(r, 200));

  const res = await listConnections(person);
  assert.equal(res.status, 200, `THE BUG: there is no list of hosted connections: ${res.status} ${res.text}`);
  const rows = res.body.connections;
  assert.equal(rows.length, 2, `one row per client, not per key: ${JSON.stringify(rows)}`);

  const c = rows.find((r) => r.client_id === claude.clientId);
  assert.equal(c.client_name, 'Claude');
  assert.equal(c.identified, true);
  assert.equal(c.surface, 'claude_web');
  assert.equal(c.resource, `${BASE}/mcp/claude`);
  assert.ok(c.connection_id && /^[A-Za-z0-9_-]+$/.test(c.connection_id), `an opaque, path-safe id: ${c.connection_id}`);
  assert.ok(Date.parse(c.first_authorized_at) <= Date.parse(c.last_used_at), JSON.stringify(c));

  const g = rows.find((r) => r.client_id === chatgpt.clientId);
  assert.equal(g.client_name, 'ChatGPT');
  assert.equal(g.surface, 'chatgpt_web');
  assert.equal(g.resource, `${BASE}/mcp`);

  // Nothing a credential is made of rides along.
  const text = JSON.stringify(res.body);
  assert.ok(!/key_hash|dd_[0-9a-f]|ddr_/.test(text), `a credential leaked into the listing: ${text}`);
});

test('disconnecting one client retires its access and refresh tokens, and nothing else', async () => {
  const person = await makePerson('disconnector');
  const other = await makePerson('bystander');
  const claude = await connect(person, CLIENTS.claude);
  const chatgpt = await connect(person, CLIENTS.chatgpt);
  const theirs = await connect(other, CLIENTS.claude);
  await rotate(claude);

  const target = await connectionFor(person, claude);
  assert.ok(target, 'the connection is listed');
  const res = await disconnect(person, target.connection_id);
  assert.equal(res.status, 200, res.text);
  assert.equal(res.body.disconnected, true);
  assert.equal(res.body.connection.client_name, 'Claude');
  assert.deepEqual(res.body.remaining, { access_tokens: 0, refresh_tokens: 0 },
    'the reply must be the read-back, and the read-back must be empty');
  assert.ok(res.body.revoked.access_tokens >= 1, JSON.stringify(res.body));

  assert.equal(await use(claude), 401, 'the disconnected client\'s access token still works');
  const r = await refresh(claude);
  assert.equal(r.status, 400, `the disconnected client refreshed its way back in: ${r.text}`);
  assert.equal(r.body.error, 'invalid_grant');

  assert.equal(await use(chatgpt), 200, 'the same person\'s other client was cut off too');
  await rotate(chatgpt);
  assert.equal(await use(chatgpt), 200);
  assert.equal(await use(theirs), 200, 'someone else\'s connection was cut off');
  await rotate(theirs);
  assert.equal(await use(theirs), 200);

  assert.equal(await connectionFor(person, claude), null, 'the disconnected client is still listed');
  assert.ok(await connectionFor(person, chatgpt), 'the other client vanished from the list');

  const again = await disconnect(person, target.connection_id);
  assert.equal(again.status, 404, `disconnecting what is already gone should say so: ${again.text}`);
});

test('deleting the key through the keys route cannot be refreshed away', async () => {
  // The walker's reproduction, exactly: DELETE /api/v1/keys/:id answered 200,
  // the token died, and the client's next refresh minted a working one.
  const person = await makePerson('keydelete');
  const conn = await connect(person, CLIENTS.chatgpt);
  const bystander = await connect(person, CLIENTS.claude);
  const { rows } = await db.query('SELECT key_id FROM api_keys WHERE key_hash = $1', [hashApiKey(conn.access)], 'org-system');
  assert.equal(rows.length, 1);

  const del = await request(httpServer).delete(`/api/v1/keys/${rows[0].key_id}`).set('Authorization', `Bearer ${person.jwt}`);
  assert.equal(del.status, 200, del.text);
  assert.equal(await use(conn), 401);

  const r = await refresh(conn);
  assert.equal(r.status, 400, `THE BUG: a refresh undid the key's deletion and minted a new token: ${r.text}`);
  assert.equal(r.body.error, 'invalid_grant');
  assert.equal(await use(bystander), 200, 'deleting one key cut off another client');
});

test('an ordinary refresh still rotates, again and again', async () => {
  const person = await makePerson('rotator');
  const conn = await connect(person, CLIENTS.claude);
  const first = { access: conn.access, refresh: conn.refresh };
  await rotate(conn);
  assert.equal(await use(conn), 200, 'the new token works');
  assert.equal(await use(conn, first.access), 401, 'the rotated-out token is retired');
  const stale = await refresh(conn, first.refresh);
  assert.equal(stale.status, 400, 'a consumed refresh token is single-use');
  await rotate(conn);
  await rotate(conn);
  assert.equal(await use(conn), 200);
});

test('a refresh racing another refresh of the same grant is rotation, not revocation', async () => {
  // Two refreshes of one token in flight: the second read the record before
  // the first consumed it, and checks the old key after the first retired it.
  // That key was retired by ROTATION, and must not be read as the person
  // taking the connection away. Simulated deterministically: the second
  // request is served the record once, as it was when it read it.
  const person = await makePerson('racer');
  const conn = await connect(person, CLIENTS.chatgpt);
  const key = refreshKeyOf(conn.refresh);
  const snapshot = await redis.get(key);
  const original = conn.refresh;
  await rotate(conn); // the first refresh wins and retires the old pair

  const realGet = redis.get.bind(redis);
  let served = false;
  redis.get = async (k) => {
    if (k === key && !served) { served = true; return snapshot; }
    return realGet(k);
  };
  try {
    const second = await refresh(conn, original);
    assert.equal(second.status, 200, `a concurrent rotation was mistaken for a revocation: ${second.text}`);
    assert.equal(await use(conn, second.body.access_token), 200);
  } finally {
    redis.get = realGet;
  }
  assert.equal(await use(conn), 200, 'the first refresh\'s pair still works');
});

test('a disconnect that lands while a refresh is minting still wins', async () => {
  // The refresh checked the key, then the person disconnected, then the
  // refresh minted. The disconnect revoked every key the connection had at
  // that moment, which did not include the one about to be minted; the grant
  // looks again after minting and withdraws it. Interleaved deterministically:
  // the disconnect runs at the instant the refresh inserts its new key.
  const person = await makePerson('interleave');
  const conn = await connect(person, CLIENTS.claude);
  const target = await connectionFor(person, conn);
  const { hostedConnections } = require('../../src/routes/oauth');
  const realQuery = db.query;
  let armed = true;
  db.query = async (text, ...rest) => {
    if (armed && /^INSERT INTO api_keys/.test(String(text))) {
      armed = false;
      await hostedConnections.disconnect([person.userId], target.connection_id);
    }
    return realQuery.call(db, text, ...rest);
  };
  let res;
  try {
    res = await refresh(conn);
  } finally {
    db.query = realQuery;
  }
  assert.equal(armed, false, 'the interleaving did not happen');
  assert.equal(res.status, 400, `a pair minted across the disconnect survived it: ${res.text}`);
  assert.equal(res.body.error, 'invalid_grant');
  assert.equal(await use(conn), 401);
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM api_keys WHERE owner_id = $1 AND status = \'active\'',
    [person.userId], 'org-system',
  );
  assert.equal(rows[0].n, 0, 'a live key outlived the disconnect');
  assert.equal(await connectionFor(person, conn), null);
});

test('only the person sees or disconnects their connections: not a stranger, not a workspace owner', async () => {
  const owner = await makePerson('owner', { plan: 'enterprise' });
  await workspace.ensureOwnerMembership(owner.orgId, owner.userId);
  const member = await makePerson('member');
  await workspace.ensureOwnerMembership(member.orgId, member.userId);
  await workspace.addMember(owner.orgId, member.userId, { role: 'member', invitedBy: owner.userId });
  const stranger = await makePerson('stranger');

  const mine = await connect(member, CLIENTS.claude);
  const ownerConn = await connect(owner, CLIENTS.chatgpt);
  const target = await connectionFor(member, mine);
  assert.ok(target);

  for (const [who, person, headers] of [
    ['a stranger', stranger, undefined],
    ['the workspace owner', owner, undefined],
    ['the workspace owner, bound to the team', owner, { Authorization: `Bearer ${owner.jwt}`, 'x-deerdawn-workspace': owner.orgId }],
  ]) {
    const listed = await listConnections(person, headers);
    assert.equal(listed.status, 200, listed.text);
    assert.ok(!listed.body.connections.some((c) => c.client_id === mine.clientId), `${who} can list a colleague's connection`);
    const res = await disconnect(person, target.connection_id, headers);
    assert.equal(res.status, 404, `${who} could disconnect someone else's connection: ${res.status} ${res.text}`);
  }
  assert.equal(await use(mine), 200, 'the member\'s connection was cut off by somebody else');
  await rotate(mine);
  assert.equal(await use(ownerConn), 200);

  // And the member, bound to the team, still sees their own.
  const own = await listConnections(member, { Authorization: `Bearer ${member.jwt}`, 'x-deerdawn-workspace': owner.orgId });
  assert.equal(own.status, 200, own.text);
  assert.ok(own.body.connections.some((c) => c.client_id === mine.clientId), 'a teammate in the team workspace cannot see their own connection');
});

test('a credential cannot disconnect a connection', async () => {
  const person = await makePerson('credential');
  const conn = await connect(person, CLIENTS.claude);
  const target = await connectionFor(person, conn);
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'backend', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
    person.orgId,
  );
  const byKey = await disconnect(person, target.connection_id, { 'X-Api-Key': key });
  assert.equal(byKey.status, 403, `an API key disconnected a connection: ${byKey.text}`);
  // An MCP token is bound to its MCP audience and reaches no REST route at all.
  const byToken = await disconnect(person, target.connection_id, { Authorization: `Bearer ${conn.access}` });
  assert.equal(byToken.status, 401, byToken.text);
  assert.equal(await use(conn), 200);
});

test('a connection from before keys carried their client is still listed, and disconnecting it sticks', async () => {
  // Keys minted before the client columns existed name no client, and their
  // refresh tokens predate the per-owner index, so neither can be found by
  // client. The row is its own connection, and revoking it is what stops the
  // refresh: the grant refuses to rotate a key its person took away.
  const person = await makePerson('legacy');
  const { key, prefix, hash } = generateApiKey();
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes, oauth_resource)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [`key-${uuidv4()}`, prefix, hash, 'DeerDawn MCP (OAuth)', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write'], `${BASE}/mcp`],
    person.orgId,
  );
  const refreshToken = `ddr_${crypto.randomBytes(32).toString('hex')}`;
  await redis.set(refreshKeyOf(refreshToken), JSON.stringify({
    owner_id: person.userId, org_id: person.orgId, client_id: 'mcp_legacyclient', scope: 'context:read context:write',
    resource: `${BASE}/mcp`, access_key_hash: hash,
  }));
  const conn = { path: '/mcp', access: key, refresh: refreshToken, clientId: 'mcp_legacyclient' };
  assert.equal(await use(conn), 200);

  const listed = await listConnections(person);
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.body.connections.length, 1, JSON.stringify(listed.body));
  assert.equal(listed.body.connections[0].identified, false, 'a connection nobody named must not claim a name');
  assert.equal(listed.body.connections[0].surface, '');
  const res = await disconnect(person, listed.body.connections[0].connection_id);
  assert.equal(res.status, 200, res.text);
  assert.equal(await use(conn), 401);
  const r = await refresh(conn);
  assert.equal(r.status, 400, `an unindexed refresh token outlived the disconnect: ${r.text}`);
});
