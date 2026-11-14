/**
 * JOURNEY SCAN ROUND 5: WHAT A PERSON WROTE INTO A TEAM'S SHARED PROJECT STAYS
 * WITH THE TEAM, AND AN OWNER CAN STILL DELETE IT AFTER THEY ARE GONE.
 *
 * A decision, an open question, a board card, a line of context or an entity
 * that somebody filed in a shared project belongs to the team once it is there:
 * leaving or being removed sets removed_at and nothing else, and only the
 * person's personal projects and profile go home. The leave screen and the
 * owner's remove confirmation now say so before it happens (the dashboard
 * tests pin the words). The other half of the promise is that the team is not
 * stuck with a note nobody can take back, so these tests drive the owner's
 * deletion through the normal API after the author has left, in a project the
 * departed person created and in one the owner created, and check that a
 * member still may not delete a colleague's note through anything they could
 * not already use.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r5-leaving-notes.test.js
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
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');

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

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const tag = () => uuidv4().slice(0, 8).toUpperCase();

// Every section the five notes live in, viewable and editable by the team: a
// question and a line of context are not in the default share, so a member can
// only write them into a shared project once its author has granted them.
const EDITABLE = ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'open_questions', 'recurring_context']
  .map((section_key) => ({ section_key, can_view: true, can_edit: true }));

async function createShared(person, team, name) {
  const made = await as('post', '/api/v1/context/projects', person, team).send({ project_name: name, current_task: 'x' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const projectId = made.body.project.project_id;
  const shared = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, person, team).send({ visibility: 'shared', sections: EDITABLE });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  return projectId;
}

// The project as `person` reads it in `team`, through their own export.
async function contextOf(person, team, projectId) {
  const res = await as('get', '/api/v1/context/export?format=json', person, team);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const project = (res.body.projects || []).find((p) => p.project_id === projectId);
  assert.ok(project, 'the reader can open the project');
  return project.context || {};
}

// The five kinds of note the owner decision names, written by `writer` into
// `projectId`. Returns what to look for afterwards.
async function writeNotes(writer, team, projectId, T) {
  const notes = {
    decision: `DECISION${T} keep the queue`,
    question: `QUESTION${T} who owns the cron?`,
    card: `CARD${T} migrate the table`,
    line: `LINE${T} never deploy on Friday`,
    entity: `ENTITY${T} Billing worker`,
  };
  // The decision goes in the way a tool records one (decision_made), which
  // stamps its author; a decision written by a plain PATCH carries no author.
  const decided = await as('post', '/api/v1/context/events', writer, team).send({ event_type: 'decision_made', project_id: projectId, summary: notes.decision });
  assert.equal(decided.status, 202, `decision write: ${JSON.stringify(decided.body)}`);
  const patched = await as('patch', `/api/v1/context/projects/${projectId}/context`, writer, team).send({
    open_questions: [notes.question],
    add_todos: [{ title: notes.card, phase: 'backlog' }],
    recurring_context: [notes.line],
  });
  assert.equal(patched.status, 200, `context write: ${JSON.stringify(patched.body)}`);
  const entity = await as('post', '/api/v1/context/workspace/entities', writer, team).send({
    project_id: projectId,
    entities: [{ title: notes.entity, entity_type: 'knowledge', summary: 'Runs the invoice job for the team', project_id: projectId, scope: 'project' }],
  });
  assert.equal(entity.status, 200, `entity write: ${JSON.stringify(entity.body)}`);
  return notes;
}

async function entityNodeId(person, team, projectId, title) {
  const graph = await as('get', `/api/v1/context/graph/projects/${projectId}`, person, team);
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  const node = (graph.body.graph?.nodes || graph.body.nodes || []).find((n) => n.title === title || String(n.title).toUpperCase() === title.toUpperCase());
  return node?.node_id || null;
}

// The owner takes every kind of note back out through the normal API, and the
// project no longer holds any of them.
async function ownerDeletesEverything(owner, team, projectId, notes, note) {
  const nodeId = await entityNodeId(owner, team, projectId, notes.entity);
  assert.ok(nodeId, `${note}: precondition: the owner can see the entity`);
  const before = JSON.stringify(await contextOf(owner, team, projectId));
  for (const text of [notes.decision, notes.question, notes.card, notes.line]) {
    assert.ok(before.includes(text), `${note}: precondition: the owner can read "${text}"`);
  }

  const cleared = await as('patch', `/api/v1/context/projects/${projectId}/context`, owner, team).send({
    recent_decisions: [],
    open_questions: [],
    remove_todos: [notes.card],
    recurring_context: [],
  });
  assert.equal(cleared.status, 200, `${note}: the owner clears the project's notes: ${JSON.stringify(cleared.body)}`);
  const deleted = await as('delete', `/api/v1/context/graph/nodes/${nodeId}`, owner, team);
  assert.equal(deleted.status, 200, `${note}: the owner deletes the entity: ${JSON.stringify(deleted.body)}`);

  const after = JSON.stringify(await contextOf(owner, team, projectId));
  const leftBehind = [notes.decision, notes.question, notes.card, notes.line].filter((text) => after.includes(text));
  assert.deepEqual(leftBehind, [], `${note}: every note the owner removed is gone`);
  assert.equal(await entityNodeId(owner, team, projectId, notes.entity), null, `${note}: the entity is gone`);
}

test('an owner deletes every kind of note a member left in a project the owner made, after the member left', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee');
  await join(ann, lee);
  const projectId = await createShared(ann, ann.orgId, `Ann shared ${T}`);
  const notes = await writeNotes(lee, ann.orgId, projectId, T);

  const left = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.contributions_retained, true);

  // They stay: the owner reads them after Lee is gone.
  const stays = JSON.stringify(await contextOf(ann, ann.orgId, projectId));
  for (const text of [notes.decision, notes.question, notes.card, notes.line]) assert.ok(stays.includes(text), `"${text}" stays with the team`);

  await ownerDeletesEverything(ann, ann.orgId, projectId, notes, 'owner-made project');
});

test('an owner deletes every kind of note in a shared project the departed member created', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann2', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee2');
  await join(ann, lee);
  const projectId = await createShared(lee, ann.orgId, `Lee shared ${T}`);
  const notes = await writeNotes(lee, ann.orgId, projectId, T);

  const removed = await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ann.orgId);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  await ownerDeletesEverything(ann, ann.orgId, projectId, notes, 'departed member\'s project');
});

test('an owner may not shorten the decision log of a colleague who is still in the team, and a member may not shorten it at all', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann3', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee3');
  const mia = await makePerson('r5n-mia3');
  await join(ann, lee);
  await join(ann, mia);
  const projectId = await createShared(lee, ann.orgId, `Lee active ${T}`);
  const notes = await writeNotes(lee, ann.orgId, projectId, T);

  // Lee is still here: the owner's write can add to the log, not take Lee's entry out.
  const byOwner = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ann.orgId).send({ recent_decisions: [] });
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  assert.ok(JSON.stringify(await contextOf(ann, ann.orgId, projectId)).includes(notes.decision), 'the owner does not remove an active colleague\'s decision');

  // Lee goes. A member (not an owner) still cannot take his entry out.
  const removed = await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ann.orgId);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const byMember = await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ann.orgId).send({ recent_decisions: [] });
  assert.equal(byMember.status, 200, JSON.stringify(byMember.body));
  assert.ok(JSON.stringify(await contextOf(ann, ann.orgId, projectId)).includes(notes.decision), 'a member does not remove a departed colleague\'s decision');
});

test('a member still cannot delete a colleague\'s note in a view-only section', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann4', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee4');
  const mia = await makePerson('r5n-mia4');
  await join(ann, lee);
  await join(ann, mia);
  const projectId = await createShared(lee, ann.orgId, `Lee guarded ${T}`);
  const notes = await writeNotes(lee, ann.orgId, projectId, T);
  const shared = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, lee, ann.orgId).send({
    visibility: 'shared',
    sections: [
      { section_key: 'current_task', can_view: true, can_edit: true },
      { section_key: 'recent_decisions', can_view: true, can_edit: false },
    ],
  });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));

  const refused = await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ann.orgId).send({ recent_decisions: [] });
  assert.equal(refused.status, 403, `a member may not clear a view-only decision log: ${JSON.stringify(refused.body)}`);
  assert.ok(JSON.stringify(await contextOf(lee, ann.orgId, projectId)).includes(notes.decision), 'and the decision is still there');
});

// ── the rest of the owner's answers (journey r5, second pass) ───────────────
//
// 1. Once a shared project's AUTHOR has left the workspace, workspace owners
//    hold the author's edit rights on it, sections the author made view-only
//    included. While the author is still a member nothing changes.
// 2. A decision written from the dashboard or REST (PATCH) records its author,
//    like a tool write does. Old decisions with no author are credited to
//    nobody, and an owner may remove them from a shared project.
// After both, "a workspace owner can delete it" (the leave screen's sentence)
// is true in every case below.

const store = require('../../src/store/contextSyncStore');

const VIEW_ONLY = ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'open_questions', 'recurring_context']
  .map((section_key) => ({ section_key, can_view: true, can_edit: false }));

async function decisionsOf(person, team, projectId) {
  return (await contextOf(person, team, projectId)).recent_decisions || [];
}

// An entry as an old version stored it: no author on it.
async function stripAuthor(ownerKey, projectId, summaryPart) {
  const row = await store.getProject(ownerKey, projectId);
  const decisions = (row.context.recent_decisions || []).map((d) => {
    if (!String(d.summary).includes(summaryPart)) return d;
    const { contributed_by: _gone, ...rest } = d;
    return rest;
  });
  await store.saveProject({ ...row, context: { ...row.context, recent_decisions: decisions } }, null);
}

test('a decision written by PATCH records its author', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann5', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee5');
  await join(ann, lee);
  const projectId = await createShared(lee, ann.orgId, `Lee patch ${T}`);
  const wrote = await as('patch', `/api/v1/context/projects/${projectId}/context`, lee, ann.orgId).send({
    recent_decisions: [{ summary: `PATCHED${T} use the queue`, decided_at: '2026-09-20T00:00:00.000Z' }],
  });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  const stored = (await decisionsOf(lee, ann.orgId, projectId)).find((d) => String(d.summary).includes(`PATCHED${T}`));
  assert.ok(stored, 'the decision is stored');
  assert.equal(stored.contributed_by, lee.userId, 'and credited to the person who wrote it');

  // An author's replace keeps the entries it does not touch attributed as before,
  // and a caller cannot claim somebody else's name.
  const forged = await as('patch', `/api/v1/context/projects/${projectId}/context`, lee, ann.orgId).send({
    recent_decisions: [
      stored,
      { summary: `FORGED${T} claim`, decided_at: '2026-09-21T00:00:00.000Z', contributed_by: ann.userId },
    ],
  });
  assert.equal(forged.status, 200, JSON.stringify(forged.body));
  const after = await decisionsOf(lee, ann.orgId, projectId);
  assert.equal(after.find((d) => String(d.summary).includes(`PATCHED${T}`)).contributed_by, lee.userId);
  assert.equal(after.find((d) => String(d.summary).includes(`FORGED${T}`)).contributed_by, lee.userId, 'the writer\'s own name, whatever the body says');
});

test('an old decision with no author can be removed by an owner and not by a member', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann6', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee6');
  const mia = await makePerson('r5n-mia6');
  await join(ann, lee);
  await join(ann, mia);
  const projectId = await createShared(lee, ann.orgId, `Lee legacy ${T}`);
  const wrote = await as('patch', `/api/v1/context/projects/${projectId}/context`, lee, ann.orgId).send({
    recent_decisions: [
      { summary: `LEGACY${T} old choice`, decided_at: '2026-01-01T00:00:00.000Z' },
      { summary: `CURRENT${T} live choice`, decided_at: '2026-09-01T00:00:00.000Z' },
    ],
  });
  assert.equal(wrote.status, 200, JSON.stringify(wrote.body));
  await stripAuthor(ann.orgId, projectId, `LEGACY${T}`);

  const byMember = await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ann.orgId).send({ recent_decisions: [] });
  assert.equal(byMember.status, 200, JSON.stringify(byMember.body));
  assert.equal((await decisionsOf(ann, ann.orgId, projectId)).length, 2, 'a member removes nothing');

  const byOwner = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ann.orgId).send({ recent_decisions: [] });
  assert.equal(byOwner.status, 200, JSON.stringify(byOwner.body));
  const left = (await decisionsOf(ann, ann.orgId, projectId)).map((d) => d.summary);
  assert.equal(left.some((s) => s.includes(`LEGACY${T}`)), false, 'the owner removes the decision nobody is credited with');
  assert.equal(left.some((s) => s.includes(`CURRENT${T}`)), true, 'and not a decision by somebody still in the team');
});

test('view-only sections: while the author is a member nothing changes, once the author has left an owner may delete every kind of note', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann7', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee7');
  await join(ann, lee);
  const projectId = await createShared(lee, ann.orgId, `Lee locked ${T}`);
  const notes = await writeNotes(lee, ann.orgId, projectId, T);
  // A decision written from the dashboard (attributed now) and an old one with no author.
  await as('patch', `/api/v1/context/projects/${projectId}/context`, lee, ann.orgId).send({
    recent_decisions: [
      ...(await decisionsOf(lee, ann.orgId, projectId)),
      { summary: `DASHBOARD${T} decision`, decided_at: '2026-09-20T00:00:00.000Z' },
      { summary: `OLD${T} decision`, decided_at: '2026-01-01T00:00:00.000Z' },
    ],
  });
  await stripAuthor(ann.orgId, projectId, `OLD${T}`);
  const locked = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, lee, ann.orgId).send({ visibility: 'shared', sections: VIEW_ONLY });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));

  // Lee is still here: the owner is refused, as before.
  const refused = await as('patch', `/api/v1/context/projects/${projectId}/context`, ann, ann.orgId).send({ open_questions: [] });
  assert.equal(refused.status, 403, `the owner may not edit what its author made view-only: ${JSON.stringify(refused.body)}`);
  const nodeId = await entityNodeId(ann, ann.orgId, projectId, notes.entity);
  assert.ok(nodeId, 'precondition: the owner reads the entity');
  const refusedNode = await as('delete', `/api/v1/context/graph/nodes/${nodeId}`, ann, ann.orgId);
  assert.equal(refusedNode.status, 403, JSON.stringify(refusedNode.body));

  const removed = await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ann.orgId);
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  await ownerDeletesEverything(ann, ann.orgId, projectId, notes, 'view-only project of a departed author');
  const rest = JSON.stringify(await decisionsOf(ann, ann.orgId, projectId));
  assert.ok(!rest.includes(`DASHBOARD${T}`) && !rest.includes(`OLD${T}`), 'the dashboard-written and the unattributed decisions are gone too');
});

test('a member gets no author rights when the author leaves', async () => {
  const T = tag();
  const ann = await makePerson('r5n-ann8', { plan: 'developer_pro' });
  const lee = await makePerson('r5n-lee8');
  const mia = await makePerson('r5n-mia8');
  await join(ann, lee);
  await join(ann, mia);
  const projectId = await createShared(lee, ann.orgId, `Lee members ${T}`);
  await writeNotes(lee, ann.orgId, projectId, T);
  await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, lee, ann.orgId).send({ visibility: 'shared', sections: VIEW_ONLY });
  await as('delete', `/api/v1/teams/members/${lee.userId}`, ann, ann.orgId);
  const byMember = await as('patch', `/api/v1/context/projects/${projectId}/context`, mia, ann.orgId).send({ open_questions: [] });
  assert.equal(byMember.status, 403, JSON.stringify(byMember.body));
});
