/**
 * SCAN 34. What round 33 opened, and three older doors on the same rules.
 *
 *   T1. The rebuild never lands on a row homed in another project — not even
 *       another of the writer's own with "the same readers" (round 33 S3c,
 *       reverted). That equality held only at write time; sharing one of the
 *       two projects, taking one private or moving one out then published the
 *       other's note and name (a/p1, a/p2a, a/p2b, a/p5, b/p103, b/p103c).
 *   T2. Erasing a person erases their private_to notes by the MARK, not
 *       through the roster the Clerk webhook deletes first (b/p104).
 *   T3. Moving a project into a workspace joins a destination node only when
 *       it is that project's or workspace-level and unmarked; otherwise the
 *       project gets its own `::in.<project>` copy (b/p107, b/p107c).
 *   T4. The "you" profile never enters a project's event log (a/F2, p3).
 *   T5. An edge recorded in a project the reader cannot open is not served,
 *       and a rebuild does not stamp its session on a node it does not own
 *       (a/F3, p4b).
 *   T6. A server-composed status change (auto-promotion) never flips a node
 *       homed elsewhere or workspace-level: resolving in a personal project
 *       leaves the team's decision open (a/F4).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan34-fixes.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);
process.env.CLERK_WEBHOOK_SECRET = process.env.CLERK_WEBHOOK_SECRET || 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { Webhook } = require('svix');
const { v4: uuidv4 } = require('uuid');
const stripe = require('../../src/services/stripeService');
const app = require('../../src/app');

// No live billing in a test: account closure cancels nothing.
stripe.cancelSubscriptionForDeletion = async () => ({ ok: true, cancelled: false });

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { createTeamWorkspaceFixture } = require('../helpers/teamWorkspaceFixture');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const erasure = require('../../src/services/dataErasureService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tag = () => uuidv4().slice(0, 6);

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
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.ok(accepted.ok, accepted.reason);
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
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}

async function newProject(person, name, ws = person.orgId) {
  const created = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: `${name} ${tag()}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.project.project_id;
}

async function share(person, ws, projectId, body) {
  const res = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send(body);
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const upsert = (key, ws, args) => mcpCall(key, ws, 'manage_memory', { action: 'upsert_entities', ...args });
const recall = (key, ws, query) => mcpCall(key, ws, 'recall', { action: 'entities', query });

// The non-explicit POST /extraction every end-of-session flush makes: the delta
// is applied and the project's graph is rebuilt from its whole stored context.
async function flush(person, ws, projectId, delta) {
  const res = await as('post', '/api/v1/context/extraction', person, ws).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunk: { role: 'user', text: 'status update' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false, delta },
  });
  assert.equal(res.status, 202, JSON.stringify(res.body).slice(0, 300));
  await wait(300);
  return res;
}

async function team(label) {
  const O = await makePerson(`${label}o`, { plan: 'developer_pro' });
  const M = await makePerson(`${label}m`);
  const M2 = await makePerson(`${label}n`);
  await join(O, M);
  await join(O, M2);
  const T = O.orgId;
  const keys = { O: await mintKey(O, T), M: await mintKey(M, T), M2: await mintKey(M2, T) };
  return { O, M, M2, T, keys };
}

const today = () => new Date().toISOString();

// A signed Clerk user.deleted, delivered to the real mount.
async function deliverUserDeleted(subject) {
  const payload = JSON.stringify({ id: `evt_${uuidv4()}`, type: 'user.deleted', data: { id: subject, deleted: true, object: 'user' }, object: 'event' });
  const msgId = `msg_${uuidv4()}`;
  const ts = new Date();
  const sig = new Webhook(process.env.CLERK_WEBHOOK_SECRET).sign(msgId, ts, payload);
  return request(httpServer).post('/api/v1/webhooks/clerk')
    .set('svix-id', msgId)
    .set('svix-timestamp', String(Math.floor(ts.getTime() / 1000)))
    .set('svix-signature', sig)
    .set('content-type', 'application/json')
    .send(payload);
}

// Two personal projects of one member; `first` carries a hand-written note on a
// decision, and `second`'s session names the same decision (and stack item).
async function twoPersonalProjects(t, { firstName, secondName, visibility = 'personal' }) {
  const mk = tag();
  const X = await newProject(t.M, `${firstName}${mk}`, t.T);
  await share(t.M, t.T, X, { visibility });
  const H = await newProject(t.M, secondName, t.T);
  await share(t.M, t.T, H, { visibility });
  const D = `Adopt Postgres${mk} for billing`;
  const saved = await upsert(t.keys.M, t.T, { project_id: X, entities: [
    { entity_type: 'decision', title: D, summary: `PRIVATE${mk}: leaving my employer, this is for my own startup` },
  ] });
  assert.equal(saved.err, false, saved.text);
  await flush(t.M, t.T, X, { tech_stack: [`Stripe${mk}`] });
  await flush(t.M, t.T, H, { tech_stack: [`Stripe${mk}`], recent_decisions: [{ summary: D, decided_at: today() }] });
  return { mk, X, H, D };
}

const evidenceCrossing = async (ownerKey, homeProject, inProject) => (await q(
  `SELECT n.canonical_key FROM context_graph_evidence e JOIN context_graph_nodes n ON n.node_id = e.node_id
    WHERE e.owner_key = $1 AND n.project_id = $2 AND e.project_id = $3`,
  [ownerKey, homeProject, inProject],
)).rows;

// ── T1. The rebuild lands only on its own project's row ─────────────────────

test('T1 (a/p1): a member shares the second of two personal projects: the first one\'s note stays theirs', async () => {
  const t = await team('s34p1');
  const { mk, X, H, D } = await twoPersonalProjects(t, { firstName: 'SecretX', secondName: 'Hpub' });
  assert.deepEqual(await evidenceCrossing(t.T, X, H), [], 'the rebuild of H put evidence on a node homed in X');

  await share(t.M, t.T, H, { visibility: 'shared' });
  const decision = (await recall(t.keys.M2, t.T, `Postgres${mk}`)).text;
  assert.match(decision, new RegExp(D), 'precondition: the teammate reads H\'s own decision');
  assert.doesNotMatch(decision, /PRIVATE/);
  const stack = (await recall(t.keys.M2, t.T, `Stripe${mk}`)).text;
  assert.doesNotMatch(stack, /SecretX/);
  const graph = await as('get', `/api/v1/context/graph/projects/${H}`, t.M2, t.T);
  assert.equal(graph.status, 200);
  assert.doesNotMatch(JSON.stringify(graph.body), /PRIVATE|SecretX/);
});

test('T1 (a/p2a): taking one of two private projects personal does not leave its note with the owner', async () => {
  const t = await team('s34p2a');
  const { mk, X } = await twoPersonalProjects(t, { firstName: 'SecretX', secondName: 'Hpriv', visibility: 'private' });
  assert.match((await recall(t.keys.O, t.T, `Postgres${mk}`)).text, /PRIVATE/, 'precondition: the owner reads private work');
  await share(t.M, t.T, X, { visibility: 'personal' });
  const seen = (await recall(t.keys.O, t.T, `Postgres${mk}`)).text;
  assert.doesNotMatch(seen, /PRIVATE/, seen);
});

test('T1 (a/p2b): sharing one of two personal projects with tech_stack does not name the other', async () => {
  const t = await team('s34p2b');
  const mk = tag();
  const X = await newProject(t.M, `SecretX${mk}`, t.T);
  await share(t.M, t.T, X, { visibility: 'personal' });
  const H = await newProject(t.M, 'Hpub', t.T);
  await share(t.M, t.T, H, { visibility: 'personal' });
  await flush(t.M, t.T, X, { tech_stack: [`Stripe${mk}`] });
  await flush(t.M, t.T, H, { tech_stack: [`Stripe${mk}`] });
  await share(t.M, t.T, H, { visibility: 'shared', sections: ['description', 'current_task', 'current_status', 'recent_decisions', 'tech_stack'].map((k) => ({ section_key: k, can_view: true })) });
  const seen = (await recall(t.keys.M2, t.T, `Stripe${mk}`)).text;
  assert.match(seen, new RegExp(`Stripe${mk}`), 'precondition: the teammate reads H\'s stack');
  assert.doesNotMatch(seen, /SecretX/, seen);
});

test('T1 (a/p5): moving the first project out leaves none of its note in the team', async () => {
  const t = await team('s34p5');
  const { mk, X, H } = await twoPersonalProjects(t, { firstName: 'SecretX', secondName: 'Hpub' });
  const moved = await as('post', `/api/v1/teams/projects/${X}/move`, t.M, t.T).send({ workspace: t.M.orgId });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  const left = (await q(
    'SELECT summary FROM context_graph_nodes WHERE owner_key = $1 AND title ILIKE $2',
    [t.T, `%${mk}%`],
  )).rows;
  assert.ok(left.every((row) => !/PRIVATE/.test(row.summary || '')), JSON.stringify(left));
  await share(t.M, t.T, H, { visibility: 'shared' });
  assert.doesNotMatch((await recall(t.keys.M2, t.T, `Postgres${mk}`)).text, /PRIVATE/);
});

test('T1 (b/p103): sharing the second personal project does not publish the first one\'s name through the stack', async () => {
  const t = await team('s34p103');
  const mk = tag();
  const A = await newProject(t.M, `SecretAcquisition${mk}`, t.T);
  await share(t.M, t.T, A, { visibility: 'personal' });
  const B = await newProject(t.M, 'Billing', t.T);
  await share(t.M, t.T, B, { visibility: 'personal' });
  const delta = (task) => ({ tech_stack: [`Kafka${mk}`, 'Postgres'], recent_decisions: [{ summary: `Decided to stream billing events through Kafka${mk}.`, decided_at: today() }], current_task: task });
  await flush(t.M, t.T, A, delta('Model the acquisition target data room'));
  await flush(t.M, t.T, B, delta('Wire invoices'));
  await share(t.M, t.T, B, { visibility: 'shared', sections: ['tech_stack', 'recent_decisions', 'current_task'].map((k) => ({ section_key: k, can_view: true, can_edit: false })) });
  const recalled = (await recall(t.keys.O, t.T, `Kafka${mk}`)).text;
  assert.match(recalled, new RegExp(`Kafka${mk}`), 'precondition: the owner reads B\'s stack');
  assert.doesNotMatch(recalled, /SecretAcquisition/, recalled);
  const exported = await as('get', '/api/v1/context/graph/export', t.O, t.T);
  assert.doesNotMatch(JSON.stringify(exported.body), /SecretAcquisition|acquisition target/);
});

test('T1 (b/p103c): the DEFAULT share of the second personal project does not carry the first one\'s decision note', async () => {
  const t = await team('s34p103c');
  const mk = tag();
  const A = await newProject(t.M, `JobHunt${mk}`, t.T);
  await share(t.M, t.T, A, { visibility: 'personal' });
  const B = await newProject(t.M, 'Billing', t.T);
  await share(t.M, t.T, B, { visibility: 'personal' });
  const D = `Decided to move billing to Paddle${mk}.`;
  const saved = await upsert(t.keys.M, t.T, { project_id: A, entities: [
    { title: D, entity_type: 'decision', summary: `PRIVNOTE${mk}: because I am interviewing at Paddle next week.` },
  ] });
  assert.equal(saved.err, false, saved.text);
  await flush(t.M, t.T, B, { recent_decisions: [{ summary: D, decided_at: today() }], current_task: 'Wire Paddle webhooks' });
  await share(t.M, t.T, B, { visibility: 'shared' });
  const recalled = (await recall(t.keys.M2, t.T, `Paddle${mk}`)).text;
  assert.match(recalled, /Decided to move billing/, 'precondition: the teammate reads B\'s decision');
  assert.doesNotMatch(recalled, /PRIVNOTE|interviewing/, recalled);
  for (const path of [`/api/v1/context/graph/projects/${B}`, '/api/v1/context/workspace/entities?limit=50', '/api/v1/context/graph/export']) {
    const res = await as('get', path, t.M2, t.T);
    assert.doesNotMatch(JSON.stringify(res.body), /PRIVNOTE|JobHunt/, path);
  }
});

// ── T2. Erasure finds a private note by its mark ─────────────────────────────

// A founder's pre-team note, marked private to them by the first invite, in a
// team whose other member is made an owner (so the team is retained).
async function founderWithPrivateNote(label, { clerk = false } = {}) {
  const F = await makePerson(label, { plan: 'developer_pro' });
  const subject = `user_clerk_${uuidv4().slice(0, 12)}`;
  if (clerk) await q('UPDATE users SET auth_provider = $2, auth_subject = $3 WHERE user_id = $1', [F.userId, 'clerk', subject]);
  const T = F.orgId;
  const mk = tag();
  const saved = await upsert(await mintKey(F, T), T, { entities: [
    { entity_type: 'person', title: `Dr. Lena Park ${mk}`, summary: `CARDIO${mk}: my cardiologist; follow-up in March.`, scope: 'workspace' },
  ] });
  assert.equal(saved.err, false, saved.text);
  const M = await makePerson(`${label}m`);
  await join(F, M);
  await q('UPDATE workspace_members SET role = \'owner\' WHERE owner_key = $1 AND user_id = $2', [T, M.userId]);
  const note = async () => (await q(
    'SELECT node_id, metadata->>\'private_to\' AS pt FROM context_graph_nodes WHERE owner_key = $1 AND summary ILIKE $2',
    [T, `%CARDIO${mk}%`],
  )).rows;
  const before = await note();
  assert.equal(before.length, 1);
  assert.equal(before[0].pt, F.userId, 'precondition: marked private to the founder');
  return { F, M, T, subject, note, nodeId: before[0].node_id };
}

test('T2 (b/p104): Clerk user.deleted erases the founder\'s private note in the team it retains', async () => {
  const { F, T, subject, note, nodeId } = await founderWithPrivateNote('s34p104', { clerk: true });
  const res = await deliverUserDeleted(subject);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((await q('SELECT 1 FROM users WHERE user_id = $1', [F.userId])).rows.length, 0, 'precondition: the account is gone');
  assert.equal((await q('SELECT 1 FROM organizations WHERE org_id = $1', [T])).rows.length, 1, 'precondition: the team is retained');
  assert.deepEqual(await note(), [], 'the founder\'s private note survived their Clerk deletion');
  const vectors = await q('SELECT COUNT(*)::int AS n FROM context_graph_embeddings WHERE target_id = $1', [nodeId]).catch(() => ({ rows: [{ n: 0 }] }));
  assert.equal(vectors.rows[0].n, 0, 'and its vector');
});

test('T2: erasePersonData finds the note after the person\'s roster rows are gone (the webhook\'s order)', async () => {
  const { F, note } = await founderWithPrivateNote('s34p104b');
  await workspace.forgetPerson(F.userId);
  const report = await erasure.erasePersonData({ userIds: [F.userId], identities: [F.userId] });
  assert.deepEqual(await note(), [], JSON.stringify(report));
  assert.equal(report.private_to_context_graph_nodes, 1);
});

test('T2 (keep): DELETE /orgs closing the founder\'s home account erases their note in the team they founded', async () => {
  const F = await makePerson('s34p104c', { plan: 'developer_pro' });
  const created = await createTeamWorkspaceFixture(F, `Side ${tag()}`);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const W = created.body.workspace;
  // A paid seat for the colleague, as a real team would have.
  await q('UPDATE organizations SET plan = $2, plan_tier = $2, subscription_status = $3, purchased_seats = 5 WHERE org_id = $1', [W, 'developer_pro', 'active']);
  const mk = tag();
  const saved = await upsert(await mintKey(F, W), W, { entities: [
    { entity_type: 'knowledge', title: `Diary ${mk}`, summary: `DIARY${mk}: private solo-era note.`, scope: 'workspace' },
  ] });
  assert.equal(saved.err, false, saved.text);
  const M = await makePerson('s34p104cm');
  const invite = await workspace.createInvite(W, M.email, { role: 'member', invitedBy: F.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: M.userId, email: M.email });
  assert.ok(accepted.ok, accepted.reason);
  await q('UPDATE workspace_members SET role = \'owner\' WHERE owner_key = $1 AND user_id = $2', [W, M.userId]);
  // A workspace created as a team has no pre-team era to backfill, so the mark
  // the first invite gives a founder's solo notes is set here directly.
  await q(
    'UPDATE context_graph_nodes SET metadata = metadata || jsonb_build_object(\'private_to\', $3::text) WHERE owner_key = $1 AND summary ILIKE $2',
    [W, `%DIARY${mk}%`, F.userId],
  );
  const count = async () => Number((await q('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND summary ILIKE $2', [W, `%DIARY${mk}%`])).rows[0].n);
  assert.equal(await count(), 1);
  const closed = await as('delete', '/api/v1/orgs', F).send({ password: 'password123', confirm_email: F.email });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(await count(), 0);
});

// ── T3. A project moved into a workspace lands under the same rule ───────────

test('T3 (b/p107, p107c): moving a solo project into the team never merges into a teammate\'s personal nodes', async () => {
  const O = await makePerson('s34p107o', { plan: 'developer_pro' });
  const M = await makePerson('s34p107m');
  await join(O, M);
  const T = O.orgId;
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  const mk = tag();
  const stripeName = `Stripe${mk}`;
  const acme = `Acme${mk}`;
  const D = `Decided to charge in EUR${mk} only.`;
  const OP = await newProject(O, `OwnerSecret${mk}`, T);
  await share(O, T, OP, { visibility: 'personal' });
  await flush(O, T, OP, { tech_stack: [stripeName], recent_decisions: [{ summary: D, decided_at: today() }], current_task: 'OWNERTASK plan the acquisition' });
  const note = await upsert(okey, T, { project_id: OP, entities: [
    { title: acme, entity_type: 'service', summary: `OWNERNOTE${mk}: negotiating a 1.2% rate before the acquisition closes.` },
  ] });
  assert.equal(note.err, false, note.text);
  const ownersBefore = (await q(
    'SELECT node_id, canonical_key, summary FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND node_type <> \'project\' ORDER BY canonical_key',
    [T, OP],
  )).rows;

  const MP = await newProject(M, `Mine${mk}`, M.orgId);
  await flush(M, M.orgId, MP, { tech_stack: [stripeName, acme], recent_decisions: [{ summary: D, decided_at: today() }] });
  const moved = await as('post', `/api/v1/teams/projects/${MP}/move`, M, M.orgId).send({ workspace: T });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  // The owner's personal nodes: untouched, and holding none of the moved project's evidence.
  const ownersAfter = (await q(
    'SELECT node_id, canonical_key, summary FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND node_type <> \'project\' ORDER BY canonical_key',
    [T, OP],
  )).rows;
  assert.deepEqual(ownersAfter, ownersBefore);
  assert.deepEqual(await evidenceCrossing(T, OP, MP), [], 'the moved project\'s evidence joined the owner\'s personal nodes');

  // The mover reads their own project's graph, and none of the owner's.
  const outs = [
    (await recall(mkey, T, stripeName)).text,
    (await recall(mkey, T, acme)).text,
    (await recall(mkey, T, `EUR${mk}`)).text,
    JSON.stringify((await as('get', `/api/v1/context/graph/projects/${MP}`, M, T)).body),
    JSON.stringify((await as('get', '/api/v1/context/workspace/entities?limit=50', M, T)).body),
    JSON.stringify((await as('get', '/api/v1/context/graph/export', M, T)).body),
  ];
  for (const out of outs) assert.doesNotMatch(out, /OWNERNOTE|OwnerSecret|OWNERTASK/, out.slice(0, 400));
  assert.match(outs[0], new RegExp(stripeName), 'the moved project keeps its stack');
  assert.match(outs[1], new RegExp(acme));
  assert.match(outs[2], /Decided to charge in EUR/);
  const mine = (await q(
    'SELECT canonical_key FROM context_graph_nodes WHERE owner_key = $1 AND project_id = $2 AND node_type <> \'project\'',
    [T, MP],
  )).rows.map((row) => row.canonical_key);
  for (const key of [`service:${stripeName.toLowerCase()}`, `service:${acme.toLowerCase()}`]) {
    assert.ok(mine.includes(`${key}::in.${MP}`), `${key}: ${JSON.stringify(mine)}`);
  }
});

// ── T4. The profile never enters a project's event log ───────────────────────

test('T4 (a/F2, p3): a member\'s you_profile learned in a teammate\'s project is not in that project\'s events', async () => {
  const t = await team('s34p3');
  const mk = tag();
  const S = await newProject(t.O, 'TeamS', t.T);
  await share(t.O, t.T, S, { visibility: 'shared', sections: ['current_status', 'current_task', 'recent_decisions'].map((k) => ({ section_key: k, can_view: true, can_edit: true })) });
  await flush(t.M, t.T, S, { current_status: `status ${mk}`, you_profile: { goals: [`SECRETGOAL${mk} find a new job`], working_style: `STYLE${mk}` } });
  await wait(500);
  const events = (await q('SELECT event_kind, delta::text AS d FROM context_events WHERE project_id = $1', [S])).rows;
  assert.ok(events.some((e) => e.event_kind === 'context_delta_applied' && e.d.includes(`status ${mk}`)), 'precondition: the delta was logged');
  assert.deepEqual(events.filter((e) => /SECRETGOAL|STYLE/.test(e.d)).map((e) => e.event_kind), []);
});

// ── T5. Edges from a project the reader cannot open ──────────────────────────

test('T5 (a/F3, p4b): a member\'s personal rebuild between two team nodes serves no edge or session to a teammate', async () => {
  const t = await team('s34p4b');
  const mk = tag();
  const dec = `Move README${mk}.md into docs`;
  const file = `README${mk}.md`;
  const task = `Ship onboarding${mk}`;
  const saved = await upsert(t.keys.O, t.T, { entities: [
    { entity_type: 'decision', title: dec, summary: dec, scope: 'workspace' },
    { entity_type: 'file', title: file, summary: `the readme file for the team ${mk}`, scope: 'workspace' },
    { entity_type: 'task', title: task, summary: task, scope: 'workspace' },
  ] });
  assert.equal(saved.err, false, saved.text);
  const P = await newProject(t.M, `SecretSide${mk}`, t.T);
  await share(t.M, t.T, P, { visibility: 'personal' });
  const sess = `sess-${uuidv4()}`;
  const res = await as('post', '/api/v1/context/extraction', t.M, t.T).send({
    session_id: sess, tool: 'claude_code', project_id: P, chunk: { role: 'user', text: 'x' },
    extraction: { match_decision: 'matched_existing', confidence: 0.9, should_create_project: false, needs_user_confirmation: false,
      delta: { recent_decisions: [{ summary: dec, decided_at: today() }], file_structure_summary: [file], current_task: task } },
  });
  assert.equal(res.status, 202);
  await wait(800);
  const node = (await q('SELECT node_id, source_session_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\' AND title ILIKE $2', [t.T, `%${mk}%`])).rows;
  assert.equal(node.length, 1, 'precondition: one team decision');
  assert.notEqual(node[0].source_session_id, sess, 'the team node was stamped with the member\'s personal session');
  const edgesInP = (await q('SELECT COUNT(*)::int AS n FROM context_graph_edges WHERE owner_key = $1 AND project_id = $2 AND summary ILIKE $3', [t.T, P, `%${mk}%`])).rows[0].n;
  assert.ok(edgesInP > 0, 'precondition: the rebuild drew edges between the team nodes');
  const graph = await as('get', `/api/v1/context/graph/nodes/${node[0].node_id}`, t.M2, t.T);
  assert.equal(graph.status, 200);
  const served = JSON.stringify(graph.body);
  assert.doesNotMatch(served, new RegExp(P), 'the personal project\'s id reached a teammate');
  assert.doesNotMatch(served, new RegExp(sess));
  assert.doesNotMatch(served, /Decision made during/);
  const overview = await as('get', '/api/v1/context/workspace/overview', t.M2, t.T);
  assert.doesNotMatch(JSON.stringify(overview.body), new RegExp(sess));
});

// ── T6. A server-composed status never flips somebody else's node ────────────

test('T6 (a/F4): a member resolving the team\'s decision in their personal project leaves it open for the team', async () => {
  const t = await team('s34p6');
  const mk = tag();
  const dec = `Ship the API${mk} behind a feature flag`;
  const saved = await upsert(t.keys.O, t.T, { entities: [{ entity_type: 'decision', title: dec, summary: dec, scope: 'workspace' }] });
  assert.equal(saved.err, false, saved.text);
  const P = await newProject(t.M, 'Mine', t.T);
  await share(t.M, t.T, P, { visibility: 'personal' });
  await flush(t.M, t.T, P, { recent_decisions: [{ summary: dec, decided_at: today(), resolved: true }] });
  await wait(500);
  const rows = (await q('SELECT project_id, metadata->>\'status\' AS status FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\' AND title ILIKE $2', [t.T, `%${mk}%`])).rows;
  assert.equal(rows.length, 1, JSON.stringify(rows));
  assert.equal(rows[0].project_id, null, 'still the team\'s');
  assert.notEqual(rows[0].status, 'resolved', 'the team\'s decision was resolved for everybody from a personal project');
  const resolved = (await mcpCall(t.keys.M2, t.T, 'recall', { action: 'entities', query: `API${mk}`, status: 'resolved' })).text;
  assert.doesNotMatch(resolved, new RegExp(`API${mk}`), resolved);
  assert.match((await recall(t.keys.M2, t.T, `API${mk}`)).text, new RegExp(`API${mk}`), 'the teammate still has it in normal loads');
});
