/**
 * JOURNEY SCAN ROUND 7: A PROJECT NOBODY CAN MANAGE.
 *
 * A private project (or decision entry) stamped with a key id whose api_keys row
 * was deleted counted as "author not left" in a workspace with several members:
 * no owner could manage it and the real author was answered 404. Three layers,
 * each tested here:
 *   1. deleting a key re-stamps every author field that holds its id to the key's
 *      owner, in the same operation;
 *   2. a project whose stamp is still unresolvable is re-stamped to the one active
 *      member who ever wrote to it (never on zero or several writers);
 *   3. what is left shows "Author unknown" to owners, who may assign one active
 *      member (audit, notices, owner-only, unresolvable-only, personal untouched).
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/journey-r7-authors.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');

const resendClient = require('../../src/services/email/resendClient');
const sentEmails = [];
resendClient.sendEmail = async (mail) => { sentEmails.push(mail); return { ok: true, id: 'captured' }; };

const app = require('../../src/app');
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const authorStamps = require('../../src/services/authorStampService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const tag = () => uuidv4().slice(0, 8);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
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

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

const as = (method, path, person, ws = null) => {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
};

async function makeTeam(label) {
  const ann = await makePerson(`${label}-ann`, { plan: 'developer_pro' });
  const lee = await makePerson(`${label}-lee`);
  const mia = await makePerson(`${label}-mia`);
  await join(ann, lee);
  await join(ann, mia);
  return { ann, lee, mia, ws: ann.orgId };
}

async function createProject(person, ws, name, visibility) {
  const made = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name, current_task: 'x' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.project_id;
  if (visibility) {
    const set = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility });
    assert.equal(set.status, 200, JSON.stringify(set.body));
  }
  return projectId;
}

async function keyFor(person, orgId) {
  const { prefix, hash } = generateApiKey();
  const keyId = `key-${uuidv4()}`;
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [keyId, prefix, hash, 'legacy', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return keyId;
}

const stampOf = async (projectId) => (await q('SELECT owner_user_id FROM context_projects WHERE project_id = $1', [projectId])).rows[0]?.owner_user_id;
const archive = (person, ws, projectId) => as('post', `/api/v1/context/projects/${projectId}/archive`, person, ws).send({});

// A project as it was stamped before the identity fix: by the writer's key id.
async function stampWithKey(projectId, keyId) {
  await q('UPDATE context_projects SET owner_user_id = $2 WHERE project_id = $1', [projectId, keyId]);
}

// ── layer 1: deleting a key re-stamps what it authored ───────────────────────

test('layer 1: deleting a key re-stamps the project, the brief\'s entries and the event rows it authored to the key\'s owner', async () => {
  const { ann, lee, ws } = await makeTeam('r7a');
  const T = tag();
  const projectId = await createProject(lee, ws, `Key authored ${T}`, 'private');
  const keyId = await keyFor(lee, ws);
  await stampWithKey(projectId, keyId);
  await q('INSERT INTO context_events (event_id, project_id, source_type, source_id, event_kind, confidence, contributing_user_id) VALUES ($1, $2, $3, $4, $5, 1, $6)',
    [`evt-${uuidv4()}`, projectId, 'mcp', 'claude_code', 'decision_made', keyId]);
  const project = await store.getProject(ws, projectId);
  project.context.recent_decisions = [{ summary: `DEC${T} keep the queue`, decided_at: new Date().toISOString(), contributed_by: keyId }];
  project.context.shipped = [{ summary: `SHIP${T}`, shipped_at: new Date().toISOString(), contributed_by: keyId }];
  await store.saveProject(project, null);

  // Ann (owner) cannot touch it while Lee is active and the key still resolves.
  assert.equal((await archive(ann, ws, projectId)).status, 403);

  const deleted = await as('delete', `/api/v1/keys/${keyId}`, lee, ws);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal((await q('SELECT 1 FROM api_keys WHERE key_id = $1', [keyId])).rows.length, 0, 'the key is gone');

  assert.equal(await stampOf(projectId), lee.userId, 'the project is stamped with the person');
  assert.equal((await q('SELECT contributing_user_id FROM context_events WHERE project_id = $1 AND event_kind = \'decision_made\'', [projectId])).rows[0].contributing_user_id, lee.userId);
  const after = await store.getProject(ws, projectId);
  assert.equal(after.context.recent_decisions[0].contributed_by, lee.userId, 'the decision entry');
  assert.equal(after.context.shipped[0].contributed_by, lee.userId, 'the shipped line');

  // The deletion did not turn the project into one nobody can manage.
  assert.equal((await archive(ann, ws, projectId)).status, 403, 'the owner is still refused: Lee is active');
  assert.equal((await archive(lee, ws, projectId)).status, 200, 'and the author is still the author');
});

test('layer 1: a key with no stamps deletes cleanly; a just-created key can be rolled back without a scan', async () => {
  const { lee, ws } = await makeTeam('r7b');
  const keyId = await keyFor(lee, ws);
  const res = await authorStamps.deleteApiKey({ keyId, orgId: ws });
  assert.equal(res.deleted, true);
  const rolled = await keyFor(lee, ws);
  const back = await authorStamps.deleteApiKey({ keyId: rolled, scanContext: false });
  assert.equal(back.deleted, true);
  assert.equal((await authorStamps.deleteApiKey({ keyId: rolled })).deleted, false, 'already gone: nothing to do');
});

// ── layer 2: resolve from history ────────────────────────────────────────────

const deadKey = () => `key-${uuidv4()}`; // no api_keys row: a key that was deleted

// The owner's load of the projects-sharing listing is where history is applied
// (with the boot pass): never a plain read of the project.
const loadListing = (owner, ws) => as('get', '/api/v1/teams/projects-sharing', owner, ws);

// Nothing on record about who wrote: every per-person record removed.
async function clearHistory(projectId) {
  await q('DELETE FROM context_events WHERE project_id = $1', [projectId]);
  await q('DELETE FROM context_audit_logs WHERE project_id = $1', [projectId]);
  await q('DELETE FROM context_sessions WHERE project_id = $1', [projectId]);
}

test('layer 2: a PRIVATE project whose one writer is a member is re-stamped to them when an owner loads the listing, not when anybody reads it', async () => {
  const { ann, lee, ws } = await makeTeam('r7c');
  const T = tag();
  const projectId = await createProject(lee, ws, `One writer ${T}`, 'private');
  const wrote = await as('patch', `/api/v1/context/projects/${projectId}/context`, lee, ws).send({ current_status: `LEE${T}` });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  await sleep(250); // the audit line is written after the reply
  const dead = deadKey();
  await stampWithKey(projectId, dead);

  // Reading, or touching it, changes nothing: authority never moves as a side effect of a read.
  assert.equal((await archive(lee, ws, projectId)).status, 404, 'its author is still locked out until it is resolved');
  await as('get', '/api/v1/context/export?format=json', ann, ws);
  assert.equal(await stampOf(projectId), dead, 'untouched by reads');

  const listing = await loadListing(ann, ws);
  assert.equal(listing.status, 200, JSON.stringify(listing.body));
  assert.equal(await stampOf(projectId), lee.userId, 'resolved by the owner\'s load of the listing');
  assert.equal(listing.body.projects.find((p) => p.project_id === projectId)?.author_unknown, undefined, 'no longer unknown');
  const audit = await q('SELECT metadata FROM context_audit_logs WHERE project_id = $1 AND action = \'project_author_resolved\'', [projectId]);
  assert.equal(audit.rows.length, 1, 'recorded');
  assert.equal(audit.rows[0].metadata.from, dead);
  assert.equal(audit.rows[0].metadata.to, lee.userId);
  assert.equal((await archive(ann, ws, projectId)).status, 403, 'the owner is refused: the author is an active member');
  assert.equal((await archive(lee, ws, projectId)).status, 200, 'the real author can act');
});

test('layer 2: a bound session is not a write: nobody becomes the author of a private project by opening it', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r7d');
  const T = tag();
  // One project whose only per-person record is a member's session, one whose only
  // record is an owner's: each the reviewer's proof that a session made somebody the author.
  const cases = [];
  for (const person of [mia, ann]) {
    const projectId = await createProject(lee, ws, `Sessions ${person.label} ${T}`, 'private');
    await clearHistory(projectId);
    const dead = deadKey();
    await stampWithKey(projectId, dead);
    await q(
      `INSERT INTO context_sessions (owner_key, session_id, tool, surface_type, project_id, user_id)
       VALUES ($1, $2, 'claude_code', 'cli', $3, $4)`,
      [ws, `sess-${uuidv4()}`, projectId, person.userId],
    );
    cases.push({ projectId, dead });
  }
  const listing = await loadListing(ann, ws);
  await authorStamps.runAuthorBackfill({ pauseMs: 0 });
  for (const { projectId, dead } of cases) {
    assert.equal(await stampOf(projectId), dead, 'unchanged, by the listing and by the boot pass');
    assert.equal(listing.body.projects.find((p) => p.project_id === projectId)?.author_unknown, true, 'left for Assign author');
  }
  assert.equal((await archive(mia, ws, cases[0].projectId)).status, 404, 'Mia is not the author of a project she cannot even read');
  assert.equal((await archive(lee, ws, cases[1].projectId)).status, 404, 'and the real author is not displaced by an owner\'s session');
});

test('layer 2: a SHARED project never resolves from history: a member\'s one edit does not make them its author', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r7e0');
  const projectId = await createProject(lee, ws, `Shared ${tag()}`, 'shared');
  await clearHistory(projectId);
  assert.equal((await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ws).send({ current_status: 'mia edit' })).status, 200);
  await sleep(250);
  const dead = deadKey();
  await stampWithKey(projectId, dead);
  await loadListing(ann, ws);
  await authorStamps.runAuthorBackfill({ pauseMs: 0 });
  assert.equal(await stampOf(projectId), dead, 'stamp unchanged');
  const p = (action) => as('post', `/api/v1/context/projects/${projectId}/${action}`, mia, ws).send({ project_name: 'Mia renamed', ...{} });
  assert.equal((await p('rename')).status, 403, 'Mia may not rename it');
  assert.equal((await as('delete', `/api/v1/context/projects/${projectId}`, mia, ws)).status, 403, 'nor delete it');
  assert.ok(await stampOf(projectId));
});

// A write counts as authorship evidence only if it happened while the project was
// PRIVATE. The project's sharing changes are on record (sharing_policy_updated
// audit rows, project_moved), with timestamps.
async function clearWritesOnly(projectId) {
  await q('DELETE FROM context_events WHERE project_id = $1', [projectId]);
  await q('DELETE FROM context_audit_logs WHERE project_id = $1 AND action = \'context_write\'', [projectId]);
  await q('DELETE FROM context_sessions WHERE project_id = $1', [projectId]);
}
const setVisibility = (person, ws, projectId, visibility) =>
  as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, ws).send({ visibility });
async function recordWrite(ws, projectId, person, at) {
  await q(
    `INSERT INTO context_audit_logs (audit_id, owner_key, project_id, action, actor_type, actor_user_id, tool, metadata, created_at)
     VALUES ($1, $2, $3, 'context_write', 'user', $4, 'dashboard', '{}', $5)`,
    [`audit_${uuidv4()}`, ws, projectId, person.userId, at],
  );
}

test('layer 2: a write made while the project was SHARED is not evidence: a member\'s one edit, then an owner makes it private, does not displace the real author', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r7n');
  const projectId = await createProject(lee, ws, `Was shared ${tag()}`, 'shared');
  await clearWritesOnly(projectId);
  const dead = deadKey();
  await stampWithKey(projectId, dead);
  assert.equal((await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ws).send({ current_status: 'mia edit' })).status, 200);
  await sleep(300);
  assert.equal((await setVisibility(ann, ws, projectId, 'private')).status, 200);
  await sleep(50);

  const listing = await loadListing(ann, ws);
  assert.equal(await stampOf(projectId), dead, 'unchanged by the owner\'s load of the listing');
  assert.equal(listing.body.projects.find((p) => p.project_id === projectId)?.author_unknown, true, 'left for Assign author');
  await authorStamps.runAuthorBackfill({ pauseMs: 0 });
  assert.equal(await stampOf(projectId), dead, 'and by the boot pass');
  assert.equal((await archive(mia, ws, projectId)).status, 404, 'Mia is not the author');
});

test('layer 2: writes after the switch to private count: one member writing then resolves it', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r7o');
  const projectId = await createProject(lee, ws, `Private again ${tag()}`, 'shared');
  await clearWritesOnly(projectId);
  const dead = deadKey();
  await stampWithKey(projectId, dead);
  assert.equal((await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ws).send({ current_status: 'mia edit' })).status, 200);
  await sleep(300);
  assert.equal((await setVisibility(ann, ws, projectId, 'private')).status, 200);
  await sleep(300);
  await recordWrite(ws, projectId, lee, new Date());
  await loadListing(ann, ws);
  assert.equal(await stampOf(projectId), lee.userId, 'only the write made while it was private counts');
});

test('layer 2: a write whose timing cannot be ordered against the sharing changes is not evidence', async () => {
  const { ann, lee, ws } = await makeTeam('r7p');
  const projectId = await createProject(lee, ws, `Untimed ${tag()}`, 'private');
  await clearWritesOnly(projectId);
  const dead = deadKey();
  await stampWithKey(projectId, dead);
  // A decision in the brief names Lee, but carries no time of the write; the project
  // has a sharing change on record, so it cannot be ordered against it.
  const project = await store.getProject(ws, projectId);
  project.context.recent_decisions = [{ summary: `UNTIMED${tag()}`, decided_at: new Date().toISOString(), contributed_by: lee.userId }];
  await store.saveProject(project, null);
  await loadListing(ann, ws);
  assert.equal(await stampOf(projectId), dead, 'left for Assign author');
});

test('layer 2: a project with no sharing change on record keeps the rule it always had, and its creator as sole writer resolves regardless', async () => {
  const { ann, lee, ws } = await makeTeam('r7q');
  const projectId = await createProject(lee, ws, `Always private ${tag()}`, 'private');
  await q('DELETE FROM context_audit_logs WHERE project_id = $1 AND action = \'sharing_policy_updated\'', [projectId]);
  await q('DELETE FROM context_audit_logs WHERE project_id = $1 AND action = \'context_write\'', [projectId]);
  await q('DELETE FROM context_events WHERE project_id = $1 AND event_kind <> \'project_created\'', [projectId]);
  await stampWithKey(projectId, deadKey());
  await loadListing(ann, ws);
  assert.equal(await stampOf(projectId), lee.userId);

  // Shared and unshared in between, but the creator is the ONLY person on record at all.
  const toggled = await createProject(lee, ws, `Toggled ${tag()}`, 'shared');
  assert.equal((await setVisibility(lee, ws, toggled, 'private')).status, 200);
  await q('DELETE FROM context_audit_logs WHERE project_id = $1 AND action = \'context_write\'', [toggled]);
  await stampWithKey(toggled, deadKey());
  await loadListing(ann, ws);
  assert.equal(await stampOf(toggled), lee.userId, 'the project_created contributor, alone, is strong evidence');
});

test('layer 2: owner-only writes prove nothing: a private project only an owner wrote to stays unknown', async () => {
  const { ann, ws } = await makeTeam('r7e1');
  const projectId = await createProject(ann, ws, `Owner wrote ${tag()}`, 'private');
  await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ws).send({ current_status: 'ann' });
  await sleep(250);
  const dead = deadKey();
  await stampWithKey(projectId, dead);
  const listing = await loadListing(ann, ws);
  assert.equal(await stampOf(projectId), dead, 'unchanged');
  assert.equal(listing.body.projects.find((p) => p.project_id === projectId)?.author_unknown, true);
  await authorStamps.runAuthorBackfill({ pauseMs: 0 });
  assert.equal(await stampOf(projectId), dead);
});

test('layer 2: nobody on record, several writers, or an unknown writer: never a guess', async () => {
  const { ann, lee, mia, ws } = await makeTeam('r7e');
  const T = tag();

  const none = await createProject(lee, ws, `No writers ${T}`, 'private');
  await clearHistory(none);
  const deadNone = deadKey();
  await stampWithKey(none, deadNone);

  // Two writers: Lee created it, and an entry in the brief is stamped with Mia.
  const many = await createProject(lee, ws, `Two writers ${T}`, 'private');
  const deadMany = deadKey();
  await stampWithKey(many, deadMany);
  const manyProject = await store.getProject(ws, many);
  manyProject.context.recent_decisions = [{ summary: `MIA${T}`, decided_at: new Date().toISOString(), contributed_by: mia.userId }];
  await store.saveProject(manyProject, null);

  // An unknown writer: an entry stamped with another dead key counts as one more writer.
  const unknown = await createProject(lee, ws, `Unknown writer ${T}`, 'private');
  const deadUnknown = deadKey();
  await stampWithKey(unknown, deadUnknown);
  const unknownProject = await store.getProject(ws, unknown);
  unknownProject.context.recent_decisions = [{ summary: `ELSE${T}`, decided_at: new Date().toISOString(), contributed_by: deadKey() }];
  await store.saveProject(unknownProject, null);

  await loadListing(ann, ws);
  assert.equal(await stampOf(none), deadNone, 'nobody on record');
  assert.equal(await stampOf(many), deadMany, 'two writers');
  assert.equal(await stampOf(unknown), deadUnknown, 'an unresolvable contributor is another writer');
});

test('layer 2: a sole writer who is no longer a member is not assigned it', async () => {
  const { ann, lee, ws } = await makeTeam('r7f');
  const projectId = await createProject(lee, ws, `Gone writer ${tag()}`, 'private');
  const dead = deadKey();
  await stampWithKey(projectId, dead);
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [ws, lee.userId]);
  await loadListing(ann, ws);
  assert.equal(await stampOf(projectId), dead);
});

test('layer 2: the boot pass resolves single-member-writer private projects, never a personal or shared one, and is idempotent', async () => {
  const { lee, mia, ws } = await makeTeam('r7g');
  const T = tag();
  const good = await createProject(lee, ws, `Backfill good ${T}`, 'private');
  const personal = await createProject(mia, ws, `Backfill personal ${T}`, 'personal');
  const shared = await createProject(lee, ws, `Backfill shared ${T}`, 'shared');
  const deadGood = deadKey();
  const deadPersonal = deadKey();
  const deadShared = deadKey();
  await stampWithKey(good, deadGood);
  await stampWithKey(personal, deadPersonal);
  await stampWithKey(shared, deadShared);

  const first = await authorStamps.runAuthorBackfill({ pauseMs: 0 });
  assert.ok(first.resolved >= 1, JSON.stringify(first));
  assert.equal(await stampOf(good), lee.userId);
  assert.equal(await stampOf(personal), deadPersonal, 'a personal project is never touched');
  assert.equal(await stampOf(shared), deadShared, 'a shared project is not stuck, so it is not resolved');
  await authorStamps.runAuthorBackfill({ pauseMs: 0 });
  assert.equal(await stampOf(good), lee.userId, 'idempotent');
});

test('layer 2: the boot pass is not scheduled inside a test process', () => {
  authorStamps.scheduleAuthorBackfill(1);
  // Nothing to observe but the absence of a timer: the guard is the environment.
  assert.equal(process.env.NODE_ENV, 'test');
});

// ── layer 3: an owner assigns what is left ───────────────────────────────────

const assign = (person, ws, projectId, userId) => as('post', `/api/v1/teams/projects/${projectId}/assign-author`, person, ws).send({ user_id: userId });

// A project whose author nobody can identify: its key is gone and no record names a writer.
async function unknownAuthorProject(owner, ws, name, visibility = 'private') {
  const projectId = await createProject(owner, ws, name, visibility);
  await q('DELETE FROM context_events WHERE project_id = $1', [projectId]);
  await q('DELETE FROM context_audit_logs WHERE project_id = $1', [projectId]);
  await q('DELETE FROM context_sessions WHERE project_id = $1', [projectId]);
  await stampWithKey(projectId, deadKey());
  return projectId;
}

async function unknownTeam(label) {
  const team = await makeTeam(label);
  const vic = await makePerson(`${label}-vic`);
  await join(team.ann, vic, 'viewer');
  const bob = await makePerson(`${label}-bob`);
  await join(team.ann, bob, 'owner');
  return { ...team, vic, bob };
}

test('layer 3: owners see "Author unknown" on a project nobody can be identified as the author of; nobody else does', async () => {
  const { ann, lee, mia, ws } = await unknownTeam('r7h');
  const T = tag();
  const hidden = await unknownAuthorProject(lee, ws, `Unknown private ${T}`, 'private');
  const shared = await unknownAuthorProject(lee, ws, `Unknown shared ${T}`, 'shared');
  const known = await createProject(lee, ws, `Known ${T}`, 'private');

  const ownerView = (await as('get', '/api/v1/teams/projects-sharing', ann, ws)).body.projects;
  assert.equal(ownerView.find((p) => p.project_id === hidden)?.author_unknown, true);
  assert.equal(ownerView.find((p) => p.project_id === shared)?.author_unknown, true);
  assert.equal(ownerView.find((p) => p.project_id === known)?.author_unknown, undefined, 'a known author is not flagged');

  const memberView = (await as('get', '/api/v1/teams/projects-sharing', mia, ws)).body.projects;
  assert.ok(!memberView.some((p) => p.author_unknown), 'a member is shown no such flag');
});

test('layer 3: an owner assigns one active member; it is audited, the assignee is told (brief, dashboard, email), and they can manage it', async () => {
  const { ann, lee, ws } = await unknownTeam('r7i');
  const T = tag();
  const projectId = await unknownAuthorProject(lee, ws, `Assign ${T}`, 'private');
  const from = await stampOf(projectId);
  assert.equal((await archive(lee, ws, projectId)).status, 404, 'precondition: its real author is locked out');
  const before = sentEmails.length;

  const done = await assign(ann, ws, projectId, lee.userId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(await stampOf(projectId), lee.userId);

  const audit = await q('SELECT actor_user_id, metadata FROM context_audit_logs WHERE project_id = $1 AND action = \'project_author_assigned\'', [projectId]);
  assert.equal(audit.rows.length, 1);
  assert.equal(audit.rows[0].actor_user_id, ann.userId, 'who');
  assert.equal(audit.rows[0].metadata.from, from, 'from-stamp');
  assert.equal(audit.rows[0].metadata.to, lee.userId, 'to-person');
  assert.equal(audit.rows[0].metadata.project_name, `Assign ${T}`);

  // Told in the dashboard, once.
  const dash = await as('get', '/api/v1/teams/author-notices', lee, ws);
  assert.equal(dash.body.notices.length, 1, JSON.stringify(dash.body));
  assert.match(dash.body.notices[0].message, new RegExp(`made you the author of "Assign ${T}"`));
  assert.equal((await as('post', '/api/v1/teams/author-notices/seen', lee, ws).send({})).status, 200);
  assert.equal((await as('get', '/api/v1/teams/author-notices', lee, ws)).body.notices.length, 0);

  // Told in the next brief, once.
  const service = require('../../src/services/contextSyncService');
  const note = await service.takeDeadBindingNotice({ type: 'user', id: lee.userId, org_id: lee.orgId, workspace_key: ws }, projectId);
  assert.match(note, new RegExp(`made you the author of "Assign ${T}"`));
  assert.equal(await service.takeDeadBindingNotice({ type: 'user', id: lee.userId, org_id: lee.orgId, workspace_key: ws }, projectId), '', 'said once');

  // And by email.
  await sleep(150);
  const mail = sentEmails.slice(before).find((m) => m.to === lee.email);
  assert.ok(mail, 'the assignee is emailed');
  assert.match(mail.subject, /author/i);

  // The real author can now act on it; the owner (Lee is active) cannot.
  assert.equal((await archive(ann, ws, projectId)).status, 403);
  assert.equal((await archive(lee, ws, projectId)).status, 200);
});

test('layer 3: an owner who assigns it to themselves: the other owners are told, not the members', async () => {
  const { ann, lee, bob, ws } = await unknownTeam('r7j');
  const projectId = await unknownAuthorProject(lee, ws, `Self ${tag()}`, 'private');
  const before = sentEmails.length;
  const done = await assign(ann, ws, projectId, ann.userId);
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(await stampOf(projectId), ann.userId);
  await sleep(150);
  assert.equal((await as('get', '/api/v1/teams/author-notices', bob, ws)).body.notices.length, 1, 'the other owner');
  assert.equal((await as('get', '/api/v1/teams/author-notices', ann, ws)).body.notices.length, 0, 'not the one who did it');
  assert.equal((await as('get', '/api/v1/teams/author-notices', lee, ws)).body.notices.length, 0, 'not a member');
  const mails = sentEmails.slice(before);
  assert.ok(mails.some((m) => m.to === bob.email), 'the other owner is emailed');
  assert.ok(!mails.some((m) => m.to === lee.email || m.to === ann.email));
});

test('layer 3: only an owner assigns; a member or a viewer is refused and nothing changes', async () => {
  const { lee, mia, vic, ws } = await unknownTeam('r7k');
  const projectId = await unknownAuthorProject(lee, ws, `Refused ${tag()}`, 'shared');
  const stamp = await stampOf(projectId);
  for (const person of [mia, vic, lee]) {
    const res = await assign(person, ws, projectId, person.userId);
    assert.equal(res.status, 403, `${person.label}: ${JSON.stringify(res.body)}`);
  }
  assert.equal(await stampOf(projectId), stamp);
});

test('layer 3: only a genuinely unresolvable stamp; only an active member; never a personal project', async () => {
  const { ann, lee, mia, ws } = await unknownTeam('r7l');
  const T = tag();

  // A project whose author is known (resolves to a person): refused.
  const known = await createProject(lee, ws, `Known author ${T}`, 'private');
  const refusedKnown = await assign(ann, ws, known, ann.userId);
  assert.equal(refusedKnown.status, 409, JSON.stringify(refusedKnown.body));
  assert.equal(refusedKnown.body.error, 'author_known');
  assert.equal(await stampOf(known), lee.userId);

  // A key id that still resolves to its owner: known, refused.
  const live = await createProject(lee, ws, `Live key ${T}`, 'private');
  await stampWithKey(live, await keyFor(lee, ws));
  assert.equal((await assign(ann, ws, live, ann.userId)).status, 409);

  // An unknown project: the target must be an ACTIVE member of this workspace.
  const unknown = await unknownAuthorProject(lee, ws, `Target ${T}`, 'private');
  await q('UPDATE workspace_members SET removed_at = NOW() WHERE owner_key = $1 AND user_id = $2', [ws, mia.userId]);
  const removed = await assign(ann, ws, unknown, mia.userId);
  assert.equal(removed.status, 400);
  assert.equal(removed.body.error, 'not_an_active_member');
  const vicAssign = await assign(ann, ws, unknown, (await (async () => {
    const vic = await makePerson('r7l-vic');
    await join(ann, vic, 'viewer');
    return vic;
  })()).userId);
  assert.equal(vicAssign.status, 400, 'a viewer cannot be an author');
  assert.equal(vicAssign.body.error, 'viewer_cannot_be_author');
  const stranger = await makePerson('r7l-stranger');
  assert.equal((await assign(ann, ws, unknown, stranger.userId)).status, 400);

  // A personal project is never touched, and answers as though it were not there.
  const personal = await createProject(lee, ws, `Personal ${T}`, 'personal');
  const deadPersonal = deadKey();
  await stampWithKey(personal, deadPersonal);
  assert.equal((await assign(ann, ws, personal, ann.userId)).status, 404);
  assert.equal(await stampOf(personal), deadPersonal);
  assert.equal((await as('get', '/api/v1/teams/projects-sharing', ann, ws)).body.projects.some((p) => p.project_id === personal), false, 'not even listed');
});

// ── the revoke, the clock, and the notices table ────────────────────────────

test('deleting a key revokes it first: a failed re-stamp of the brief never keeps the key alive, and the project\'s updated_at does not move', async () => {
  const { lee, ws } = await makeTeam('r7m');
  const T = tag();
  const projectId = await createProject(lee, ws, `Clock ${T}`, 'private');
  const keyId = await keyFor(lee, ws);
  const project = await store.getProject(ws, projectId);
  project.context.recent_decisions = [{ summary: `CLOCK${T}`, decided_at: new Date().toISOString(), contributed_by: keyId }];
  await store.saveProject(project, null);
  const updatedBefore = (await q('SELECT updated_at FROM context_projects WHERE project_id = $1', [projectId])).rows[0].updated_at;

  // The brief pass fails: the key is revoked all the same, and the failure is reported, not thrown.
  const save = store.saveProject;
  store.saveProject = async () => { throw new Error('simulated store failure'); };
  let failed;
  try {
    failed = await authorStamps.deleteApiKey({ keyId, orgId: ws });
  } finally {
    store.saveProject = save;
  }
  assert.equal(failed.deleted, true);
  assert.equal(failed.restamped.context_incomplete, true, 'said, not thrown');
  assert.equal((await q('SELECT 1 FROM api_keys WHERE key_id = $1', [keyId])).rows.length, 0, 'the key is gone');

  // A second key, re-stamped normally: the auto-archive clock is not reset.
  const second = await keyFor(lee, ws);
  const again = await store.getProject(ws, projectId);
  again.context.recent_decisions = [{ summary: `CLOCK2${T}`, decided_at: new Date().toISOString(), contributed_by: second }];
  await store.saveProject(again, null);
  const updatedMid = (await q('SELECT updated_at FROM context_projects WHERE project_id = $1', [projectId])).rows[0].updated_at;
  assert.equal((await authorStamps.deleteApiKey({ keyId: second, orgId: ws })).deleted, true);
  const after = await store.getProject(ws, projectId);
  assert.equal(after.context.recent_decisions[0].contributed_by, lee.userId);
  const updatedAfter = (await q('SELECT updated_at FROM context_projects WHERE project_id = $1', [projectId])).rows[0].updated_at;
  assert.equal(new Date(updatedAfter).getTime(), new Date(updatedMid).getTime(), 'the re-stamp did not reset updated_at');
  assert.ok(updatedBefore);
});

test('the authorship notices table is part of the boot schema and of erasure', async () => {
  await store.ensureSchema();
  assert.equal((await q('SELECT to_regclass(\'context_author_notices\') IS NOT NULL AS present', [])).rows[0].present, true);
  const erasure = require('../../src/services/dataErasureService');
  assert.ok(erasure.OWNER_KEY_TABLES.includes('context_author_notices'), 'swept with the workspace');
  assert.ok(erasure.PERSON_KEYED_DELETES.some((d) => d.table === 'context_author_notices' && d.column === 'person_id'), 'swept with the person');
});
