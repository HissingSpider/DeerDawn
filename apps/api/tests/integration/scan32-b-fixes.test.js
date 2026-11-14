/**
 * SCAN 32 (B). The global "You" profile is a PERSON's, not the workspace's.
 *
 * It was stored and read per workspace (context_globals keyed by owner_key), so
 * the day a solo founder invited a colleague, the colleague's own brief opened
 * with the founder's profile — "You: Works late; burnout risk flagged by
 * therapist. Goals: Leave the company by November" — on every surface:
 * GET /context/global, start_session, recall, inject, export (probe p92).
 *
 *   G1. A member never reads the founder's profile, on any surface; the
 *       founder still reads theirs.
 *   G2. A member's own profile is theirs alone, and writing it leaves the
 *       founder's untouched.
 *   G3. Solo is unchanged, including for a person-less internal actor; once
 *       the workspace has two people, a person-less actor stands for nobody
 *       (reads no profile, writes none).
 *   G4. A pre-person workspace row is the founder's, and nobody else's.
 *   G5. Erasing a person erases their profile in every workspace; emptying a
 *       workspace empties its profiles.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan32-b-fixes.test.js
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
const service = require('../../src/services/contextSyncService');
const erasure = require('../../src/services/dataErasureService');

const q = (sql, params) => db.query(sql, params, 'org-system');

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
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcp(key, ws, name, args) {
  let r = request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  r = await r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    try { body = JSON.parse(line ? line.slice(6) : r.text); } catch { body = { error: { message: `HTTP ${r.status} ${r.text.slice(0, 300)}` } }; }
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text };
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  if (!accepted.ok) throw new Error(accepted.reason);
}

// The founder's profile, written while solo. Every marker is distinctive, so a
// leak anywhere in a response body is a substring match.
const FOUNDER_PROFILE = {
  user_profile: 'Senior engineer quietly interviewing at Acme; do not mention this at work.',
  goals: ['Leave the company by November', 'Negotiate 240k at Acme'],
  working_style: 'Works late; burnout risk flagged by therapist.',
};
const FOUNDER_MARKERS = [/interviewing at Acme/, /burnout risk/, /Leave the company by November/, /240k/];

function assertNoFounder(label, value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const marker of FOUNDER_MARKERS) assert.doesNotMatch(text, marker, `${label} carried the founder's profile`);
}

async function projectIdByName(ownerKey, name) {
  const r = await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND project_name = $2', [ownerKey, name]);
  return r.rows[0]?.project_id;
}

// A solo founder with a profile and a project, then a member who joined.
async function foundedTeam(tag) {
  const O = await makePerson(`g-founder-${tag}`, { plan: 'developer_pro' });
  const okey = await mintKey(O, O.orgId);
  const patched = await as('patch', '/api/v1/context/global', O, O.orgId).send(FOUNDER_PROFILE);
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  await mcp(okey, null, 'manage_projects', { action: 'create', project_name: `Solo-${tag}` });
  const P = await projectIdByName(O.orgId, `Solo-${tag}`);
  assert.ok(P, 'founder project created');

  const M = await makePerson(`g-member-${tag}`);
  await join(O, M, 'member');
  const mkey = await mintKey(M, O.orgId);
  const created = await as('post', '/api/v1/context/projects', M, O.orgId).send({ project_name: `Mine-${tag}` });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  const MP = created.body.project.project_id;
  return { O, okey, P, M, mkey, MP };
}

test('G1 (p92): a member never reads the founder\'s profile, on any surface; the founder still reads theirs', async () => {
  const { O, okey, P, M, mkey, MP } = await foundedTeam('g1');

  const mGlobal = await as('get', '/api/v1/context/global', M, O.orgId);
  assert.equal(mGlobal.status, 200);
  assertNoFounder('member GET /context/global', mGlobal.body);

  const mStart = await mcp(mkey, O.orgId, 'start_session', { project_id: MP });
  assert.equal(mStart.err, false, mStart.text);
  assert.match(mStart.text, /Mine-g1/);
  assertNoFounder('member start_session', mStart.text);

  const mBare = await mcp(mkey, O.orgId, 'start_session', {});
  assertNoFounder('member start_session (no project)', mBare.text);

  const mRecall = await mcp(mkey, O.orgId, 'recall', { action: 'context', project_id: MP, sections: ['all'] });
  assert.equal(mRecall.err, false, mRecall.text);
  assertNoFounder('member recall context', mRecall.text);

  const mInject = await as('get', `/api/v1/context/projects/${MP}/inject?tool=claude_web`, M, O.orgId);
  assert.equal(mInject.status, 200, JSON.stringify(mInject.body).slice(0, 300));
  assertNoFounder('member inject', mInject.body);

  const mActive = await as('get', '/api/v1/context/active?tool=claude_web', M, O.orgId);
  assert.equal(mActive.status, 200, JSON.stringify(mActive.body).slice(0, 300));
  assertNoFounder('member /active', mActive.body);

  const mExport = await as('get', '/api/v1/context/export', M, O.orgId);
  assert.equal(mExport.status, 200, JSON.stringify(mExport.body).slice(0, 300));
  assertNoFounder('member export', mExport.body);

  // The founder is untouched: their own profile on their own surfaces.
  const oGlobal = await as('get', '/api/v1/context/global', O, O.orgId);
  assert.equal(oGlobal.body.global.working_style, FOUNDER_PROFILE.working_style);
  const oStart = await mcp(okey, O.orgId, 'start_session', { project_id: P });
  assert.match(oStart.text, /You: Works late; burnout risk flagged by therapist\./);
});

test('G2: a member\'s own profile is theirs alone, and writing it leaves the founder\'s untouched', async () => {
  const { O, okey, P, M, mkey, MP } = await foundedTeam('g2');

  const written = await as('patch', '/api/v1/context/global', M, O.orgId).send({
    working_style: 'Member prefers mornings and short PRs.',
    goals: ['Ship the billing rewrite'],
  });
  assert.equal(written.status, 200, JSON.stringify(written.body));
  // Built from THEIR profile (empty), never merged over the founder's.
  assertNoFounder('member PATCH response', written.body);

  const mGlobal = await as('get', '/api/v1/context/global', M, O.orgId);
  assert.equal(mGlobal.body.global.working_style, 'Member prefers mornings and short PRs.');
  assertNoFounder('member GET after own write', mGlobal.body);
  const mStart = await mcp(mkey, O.orgId, 'start_session', { project_id: MP });
  assert.match(mStart.text, /Member prefers mornings/);

  const oGlobal = await as('get', '/api/v1/context/global', O, O.orgId);
  assert.equal(oGlobal.body.global.working_style, FOUNDER_PROFILE.working_style);
  assert.deepEqual(oGlobal.body.global.goals, FOUNDER_PROFILE.goals);
  const oStart = await mcp(okey, O.orgId, 'start_session', { project_id: P });
  assert.match(oStart.text, /burnout risk/);
  assert.doesNotMatch(oStart.text, /Member prefers mornings/);
});

test('G3: solo is unchanged (a person-less internal actor included); after an invite a person-less actor stands for nobody', async () => {
  const S = await makePerson('g-solo', { plan: 'developer_pro' });
  const skey = await mintKey(S, S.orgId);
  await as('patch', '/api/v1/context/global', S).send(FOUNDER_PROFILE);
  await mcp(skey, null, 'manage_projects', { action: 'create', project_name: 'SoloOnly' });
  const SP = await projectIdByName(S.orgId, 'SoloOnly');

  assert.equal((await as('get', '/api/v1/context/global', S)).body.global.working_style, FOUNDER_PROFILE.working_style);
  assert.match((await mcp(skey, null, 'start_session', { project_id: SP })).text, /You: Works late/);

  // An internal job builds its actor as { id: ownerKey }. In a workspace that has
  // only ever held one person, that can only mean them.
  const internal = { id: S.orgId, org_id: S.orgId };
  assert.equal((await service.getGlobalContext(internal)).working_style, FOUNDER_PROFILE.working_style);

  const M = await makePerson('g-solo-joiner');
  await join(S, M, 'member');

  // Two people now: the same person-less actor could mean either, so it means neither.
  assertNoFounder('person-less read after invite', await service.getGlobalContext(internal));
  await assert.rejects(
    () => service.updateGlobalContext(internal, { working_style: 'written by a job' }),
    (err) => err.status === 403,
  );
  // ...and the founder's own profile was not rewritten by the attempt.
  assert.equal((await as('get', '/api/v1/context/global', S, S.orgId)).body.global.working_style, FOUNDER_PROFILE.working_style);
});

test('G4: a pre-person workspace row is the founder\'s, and nobody else\'s', async () => {
  const O = await makePerson('g-legacy-founder', { plan: 'developer_pro' });
  const M = await makePerson('g-legacy-member');
  await join(O, M, 'member');
  // Written the way every row was before profiles were per person: keyed by the
  // workspace alone, with no record of who wrote it.
  await q('DELETE FROM context_globals WHERE owner_key = $1', [O.orgId]);
  await q('INSERT INTO context_globals (owner_key, global) VALUES ($1, $2)', [O.orgId, JSON.stringify(FOUNDER_PROFILE)]);

  // The member reads first, so nothing the founder does could have hidden it.
  assertNoFounder('member GET over a legacy row', (await as('get', '/api/v1/context/global', M, O.orgId)).body);
  const mkey = await mintKey(M, O.orgId);
  assertNoFounder('member start_session over a legacy row', (await mcp(mkey, O.orgId, 'start_session', {})).text);

  const oGlobal = await as('get', '/api/v1/context/global', O, O.orgId);
  assert.equal(oGlobal.body.global.working_style, FOUNDER_PROFILE.working_style);
  // Still the founder's alone after they have read (and so claimed) it.
  assertNoFounder('member GET after the founder claimed it', (await as('get', '/api/v1/context/global', M, O.orgId)).body);
});

test('G5: erasing a person erases their profile everywhere; emptying a workspace empties its profiles', async () => {
  const { O, M } = await foundedTeam('g5');
  const MEMBER_MARK = `member-profile-${uuidv4().slice(0, 8)}`;
  const written = await as('patch', '/api/v1/context/global', M, O.orgId).send({ user_profile: MEMBER_MARK });
  assert.equal(written.status, 200);

  const rowsWith = async (needle) => Number((await q(
    'SELECT COUNT(*)::int AS n FROM context_globals WHERE global::text LIKE $1', [`%${needle}%`],
  )).rows[0].n);
  assert.equal(await rowsWith(MEMBER_MARK), 1);

  // The member's account goes; the team (and the founder's profile in it) stays.
  const report = await erasure.erasePersonData({ userIds: [M.userId] });
  assert.equal(await rowsWith(MEMBER_MARK), 0, `the erased member's profile survived: ${JSON.stringify(report)}`);
  assert.equal((await as('get', '/api/v1/context/global', O, O.orgId)).body.global.working_style, FOUNDER_PROFILE.working_style);

  // Emptying the workspace takes every profile in it.
  await erasure.purgeOwnerData(O.orgId, { workspaceOnly: true, keepMembers: [O.userId], strict: true });
  const left = await q('SELECT COUNT(*)::int AS n FROM context_globals WHERE owner_key = $1', [O.orgId]);
  assert.equal(left.rows[0].n, 0);
});
