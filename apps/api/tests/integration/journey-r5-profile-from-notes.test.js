/**
 * JOURNEY ROUND 5. The profile is the person's word about themselves, never a
 * note lifted out of a project.
 *
 * Extraction used to read a `you_profile` out of a conversation and merge it
 * into the person's account-wide profile. That profile prints as "Goals" (and
 * Expertise, Values, "You:") in EVERY brief the person opens, so a goal noted
 * in one private project appeared in an unrelated project's brief.
 *
 * Now the profile is written only by an explicit update (PATCH /context/global,
 * which is also what the dashboard "You" page sends).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r5-profile-from-notes.test.js
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

const q = (sql, params) => db.query(sql, params, 'org-system');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => uuidv4().slice(0, 6);

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, 'free', 'free', 'active', null],
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

async function mcpCall(key, ws, name, args) {
  let r = request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  r = await r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text };
}

async function newProject(person, name) {
  const created = await as('post', '/api/v1/context/projects', person, person.orgId).send({ project_name: `${name} ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function flush(person, projectId, delta) {
  const res = await as('post', '/api/v1/context/extraction', person, person.orgId).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunk: { role: 'user', text: 'status update' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  await wait(600);
  return res;
}

const profileRow = async (person) => (await q(
  'SELECT global FROM context_globals WHERE owner_key = $1 AND person_id = $2',
  [person.orgId, person.userId],
)).rows[0]?.global || {};

test('a goal noted in one project stays in it and is not in another project\'s brief', async () => {
  const P = await makePerson('r5prof');
  const key = await mintKey(P, P.orgId);
  const mk = tag();
  const secret = `leave the company by November ${mk}`;
  const A = await newProject(P, 'Private notes');
  const B = await newProject(P, 'Unrelated app');
  await mcpCall(key, P.orgId, 'start_session', { project_id: A });
  await flush(P, A, {
    goals: [secret],
    current_status: `status ${mk}`,
    you_profile: { goals: [secret], working_style: `STYLE${mk} terse`, expertise_areas: [`EXPERT${mk}`], values: [`VALUE${mk}`], communication_preferences: `COMM${mk}` },
  });

  const mine = JSON.stringify(await profileRow(P));
  assert.doesNotMatch(mine, new RegExp(mk), `extraction wrote to the person's profile: ${mine}`);
  const global = await as('get', '/api/v1/context/global', P, P.orgId);
  assert.doesNotMatch(JSON.stringify(global.body), new RegExp(mk));

  // The project keeps its own goal.
  const inA = await as('get', `/api/v1/context/projects/${A}/inject?format=json`, P, P.orgId);
  assert.match(JSON.stringify(inA.body), new RegExp(`November ${mk}`), JSON.stringify(inA.body).slice(0, 600));
  // Nothing about it in an unrelated project's brief, nor in the no-project brief.
  const inB = await mcpCall(key, P.orgId, 'start_session', { project_id: B });
  assert.doesNotMatch(inB.text, new RegExp(mk), inB.text);
  assert.doesNotMatch(inB.text, /Goals:/);
  const injectB = await as('get', `/api/v1/context/projects/${B}/inject?format=json`, P, P.orgId);
  assert.doesNotMatch(JSON.stringify(injectB.body), new RegExp(mk));
});

test('an explicit profile edit still lands and prints in every brief', async () => {
  const P = await makePerson('r5profx');
  const key = await mintKey(P, P.orgId);
  const mk = tag();
  const B = await newProject(P, 'Any project');
  const saved = await as('patch', '/api/v1/context/global', P, P.orgId).send({
    user_profile: `ABOUT${mk} solo founder`,
    goals: [`GOAL${mk} ship v2`],
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const row = JSON.stringify(await profileRow(P));
  assert.match(row, new RegExp(`GOAL${mk}`));
  const brief = await mcpCall(key, P.orgId, 'start_session', { project_id: B });
  assert.match(brief.text, new RegExp(`ABOUT${mk}`), brief.text);

  // A later extraction leaves the explicit profile exactly as the person wrote it.
  await flush(P, B, { current_status: `s ${mk}`, you_profile: { goals: [`OTHER${mk}`], working_style: `WS${mk}` } });
  const after = JSON.stringify(await profileRow(P));
  assert.doesNotMatch(after, new RegExp(`OTHER${mk}|WS${mk}`), after);
  assert.match(after, new RegExp(`GOAL${mk}`));
});
