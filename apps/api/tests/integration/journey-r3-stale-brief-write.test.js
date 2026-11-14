/**
 * JOURNEY R3 / S3-1 — A CLICK IN AN OPEN BRIEF TAB ERASED WHAT THE PERSON'S OWN
 * AI SAVED SINCE THE TAB LOADED.
 *
 * The dashboard's /projects page loads the brief once. The person's connected
 * tool then records a decision (the server holds 4). The person clicks Pin on
 * an older decision in the tab they already had open, and the dashboard sent
 * PATCH /projects/:id/context {"recent_decisions": [<the 3 the tab loaded>]}.
 * It was answered 200, the toast said "Brief updated.", and the tool's decision
 * was gone: from the brief, from the decision history, and from the tool's own
 * recall. PATCH replaced the array with no way to say "only if nothing changed
 * since I read it".
 *
 * Now the caller may send the version it read (`expected_context_version`, the
 * context_version counter the store's compare-and-swap already guards on, and
 * which the dashboard's read now carries). A stale one is refused with 409
 * stale_context_version and nothing is saved. A request that sends NO version
 * behaves exactly as before: other clients depend on it.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r3-stale-brief-write.test.js
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
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'tool', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { label, orgId, userId, email, jwt, apiKey: key };
}

// The dashboard: the person's own session.
const asPerson = (method, path, person) => request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
// The person's connected tool: a workspace key.
const asTool = (method, path, person) => request(httpServer)[method](path).set('X-Api-Key', person.apiKey);

const THREE = [
  'Use Stripe Checkout (hosted) rather than Elements because it ships faster',
  'Store prices in plans.js as the single source of truth',
  'Invoices are generated nightly, not on demand',
];
const TOOLS_DECISION = 'Verify Stripe webhook signatures with the raw request body, because the parsed body breaks the signature check';

async function projectWithThreeDecisions(person) {
  const created = await asPerson('post', '/api/v1/context/projects', person).send({ project_name: `Acme storefront ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.project.project_id;
  const seeded = await asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({
    recent_decisions: THREE,
    open_questions: ['Do we need idempotency keys on the webhook handler?'],
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  return id;
}

// What the dashboard's brief reads.
async function dashboardRead(person, id) {
  const r = await asPerson('get', `/api/v1/context/projects/${id}/inject?format=json`, person);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.context;
}

const summaries = (ctx) => (ctx.recent_decisions || []).map((d) => (typeof d === 'string' ? d : d.summary));

// The person's tool appends a decision from its OWN fresh read.
async function toolRecordsDecision(person, id) {
  const fresh = await asTool('get', `/api/v1/context/projects/${id}/inject?format=json`, person);
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  const r = await asTool('patch', `/api/v1/context/projects/${id}/context`, person).send({
    recent_decisions: [...(fresh.body.context.recent_decisions || []), { summary: TOOLS_DECISION, importance: 'normal' }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

// The dashboard's Pin, built the way the open tab builds it: from the context it
// loaded, with the clicked line's importance raised.
function pinFirst(loaded) {
  return (loaded.recent_decisions || []).map((d, i) => (i === 0 ? { ...d, importance: 'high' } : d));
}

test('the dashboard read carries the version the store compares and swaps on', async () => {
  const person = await makePerson('s31-version');
  const id = await projectWithThreeDecisions(person);
  const loaded = await dashboardRead(person, id);
  assert.equal(
    typeof loaded.context_version, 'number',
    'THE BUG: the brief read carried no version, so no edit could say which state it was made against',
  );
  const row = await q('SELECT context_version FROM context_projects WHERE project_id = $1', [id]);
  assert.equal(loaded.context_version, Number(row.rows[0].context_version), 'the counter the store guards on, not a second notion of version');
});

test('a Pin from a tab loaded before the tool wrote is refused with 409, and the tool\'s decision survives', async () => {
  const person = await makePerson('s31-stale');
  const id = await projectWithThreeDecisions(person);
  const loaded = await dashboardRead(person, id);
  assert.equal(summaries(loaded).length, 3);

  await toolRecordsDecision(person, id);
  assert.equal(summaries(await dashboardRead(person, id)).length, 4, 'the server now holds the tool\'s decision');

  const stalePin = await asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({
    recent_decisions: pinFirst(loaded),
    expected_context_version: loaded.context_version,
  });
  assert.equal(stalePin.status, 409, `THE BUG: a write made against a stale read was accepted: ${stalePin.status} ${JSON.stringify(stalePin.body).slice(0, 300)}`);
  assert.equal(stalePin.body.error, 'stale_context_version');
  assert.equal(stalePin.body.code, 'stale_context_version');
  assert.match(stalePin.body.message, /changed/i, 'the refusal says what happened');
  assert.match(stalePin.body.message, /nothing was saved/i);

  const after = await dashboardRead(person, id);
  assert.deepEqual(
    summaries(after), [...THREE, TOOLS_DECISION],
    'nothing was saved: the tool\'s decision is still there and the pin did not land on the stale copy',
  );
  assert.ok(!after.recent_decisions.some((d) => d.importance === 'high'), 'the refused pin changed nothing');
});

test('a write made against the current version lands, and the reply carries the version it created', async () => {
  const person = await makePerson('s31-current');
  const id = await projectWithThreeDecisions(person);
  await toolRecordsDecision(person, id);
  const fresh = await dashboardRead(person, id);

  const pin = await asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({
    recent_decisions: pinFirst(fresh),
    expected_context_version: fresh.context_version,
  });
  assert.equal(pin.status, 200, JSON.stringify(pin.body).slice(0, 300));
  const after = await dashboardRead(person, id);
  assert.deepEqual(summaries(after), [...THREE, TOOLS_DECISION], 'the pin kept every line, the tool\'s included');
  assert.equal(after.recent_decisions[0].importance, 'high', 'and the pin landed');
  assert.equal(after.context_version, fresh.context_version + 1);
  assert.equal(pin.body.project.context_version, after.context_version, 'the PATCH reply names the version the write produced, not the one it read');
});

test('the older alias PATCH /:id/context honours the version too', async () => {
  const person = await makePerson('s31-alias');
  const id = await projectWithThreeDecisions(person);
  const loaded = await dashboardRead(person, id);
  await toolRecordsDecision(person, id);
  const stale = await asPerson('patch', `/api/v1/context/${id}/context`, person).send({
    recent_decisions: pinFirst(loaded),
    expected_context_version: loaded.context_version,
  });
  assert.equal(stale.status, 409, JSON.stringify(stale.body).slice(0, 300));
  assert.equal(summaries(await dashboardRead(person, id)).length, 4);
});

test('a write that sends NO version behaves exactly as before: a whole-array replace', async () => {
  const person = await makePerson('s31-unversioned');
  const id = await projectWithThreeDecisions(person);
  const loaded = await dashboardRead(person, id);
  await toolRecordsDecision(person, id);

  // Deliberately the old request, byte for byte: other clients (the local MCP
  // server's patches, scripts) send this and depend on it.
  const legacy = await asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({
    recent_decisions: pinFirst(loaded),
  });
  assert.equal(legacy.status, 200, JSON.stringify(legacy.body).slice(0, 300));
  const after = await dashboardRead(person, id);
  assert.deepEqual(summaries(after), THREE, 'an unversioned PATCH is still a replace, as it always was');

  const viaKey = await asTool('patch', `/api/v1/context/projects/${id}/context`, person).send({ open_questions: [] });
  assert.equal(viaKey.status, 200, 'and an unversioned tool write is untouched');
});

test('a version that is not a whole number is refused before anything is written', async () => {
  const person = await makePerson('s31-invalid');
  const id = await projectWithThreeDecisions(person);
  const before = await dashboardRead(person, id);
  for (const bad of ['abc', -1, 1.5, true, {}]) {
    const r = await asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({
      recent_decisions: [],
      expected_context_version: bad,
    });
    assert.equal(r.status, 400, `expected_context_version=${JSON.stringify(bad)} -> ${r.status}`);
    assert.equal(r.body.error, 'invalid_expected_context_version');
  }
  const after = await dashboardRead(person, id);
  assert.deepEqual(summaries(after), summaries(before), 'none of them emptied the list');
  assert.equal(after.context_version, before.context_version);
});

test('the check that holds is inside the write, against the row it swaps on, not only in the route', async () => {
  // The route refuses a stale version early, which a sequential test cannot
  // tell apart from the check that matters. This goes straight to the service,
  // past the route, with a version one behind the row.
  const service = require('../../src/services/contextSyncService');
  const person = await makePerson('s31-service');
  const id = await projectWithThreeDecisions(person);
  const loaded = await dashboardRead(person, id);
  await toolRecordsDecision(person, id);
  const actor = { type: 'user', id: person.userId, org_id: person.orgId, role: 'admin', scopes: ['context:read', 'context:write'] };
  await assert.rejects(
    () => service.updateProjectContext(actor, id, { recent_decisions: pinFirst(loaded) }, { expectedContextVersion: loaded.context_version }),
    (err) => err.code === 'stale_context_version' && err.status === 409 && /Nothing was saved/.test(err.publicMessage),
  );
  assert.equal(summaries(await dashboardRead(person, id)).length, 4);
  // And without the option the service is exactly as it was.
  await service.updateProjectContext(actor, id, { recent_decisions: pinFirst(loaded) });
  assert.equal(summaries(await dashboardRead(person, id)).length, 3);
});

test('two writes racing on the same version: exactly one lands, the other is refused, and nothing is merged away', async () => {
  const person = await makePerson('s31-race');
  const id = await projectWithThreeDecisions(person);
  const loaded = await dashboardRead(person, id);
  const decisions = loaded.recent_decisions;
  // Tab A pins line 0; tab B pins line 2 — both built from the same read.
  const tabA = decisions.map((d, i) => (i === 0 ? { ...d, importance: 'high' } : d));
  const tabB = decisions.map((d, i) => (i === 2 ? { ...d, importance: 'high' } : d));
  const [a, b] = await Promise.all([
    asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({ recent_decisions: tabA, expected_context_version: loaded.context_version }),
    asPerson('patch', `/api/v1/context/projects/${id}/context`, person).send({ recent_decisions: tabB, expected_context_version: loaded.context_version }),
  ]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], `the guard is inside the write, so exactly one wins: ${a.status} ${b.status}`);
  const after = await dashboardRead(person, id);
  assert.equal(after.context_version, loaded.context_version + 1, 'one write, one version');
  const pinned = after.recent_decisions.map((d, i) => (d.importance === 'high' ? i : -1)).filter((i) => i >= 0);
  assert.equal(pinned.length, 1, 'exactly the winner\'s pin is stored; the loser must re-read and re-apply');
});
