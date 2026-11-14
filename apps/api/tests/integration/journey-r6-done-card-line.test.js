/**
 * JOURNEY SCAN ROUND 6: A DONE CARD WRITES "SHIPPED", NEVER "VERIFIED", AND THE
 * LINE FOLLOWS THE CARD.
 *
 * The rule itself is pinned in packages/shared-context/tests/done-card-shipped-line.test.js.
 * This drives it through the API's own write path (updateProjectContext lowers the
 * merge onto the stored row and used to keep only the NEW shipped lines), by the
 * routes the dashboard and the MCP tools use.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/integration/journey-r6-done-card-line.test.js
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

const as = (method, path, person, ws = null) => {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
};

async function newProject(person, ws, name) {
  const made = await as('post', '/api/v1/context/projects', person, ws).send({ project_name: name, current_task: 'x' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  return made.body.project.project_id;
}

const patch = (person, ws, projectId, body) => as('patch', `/api/v1/context/projects/${projectId}/context`, person, ws).send(body);

async function shippedOf(person, ws, projectId) {
  const res = await as('get', '/api/v1/context/export?format=json', person, ws);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const project = (res.body.projects || []).find((p) => p.project_id === projectId);
  assert.ok(project, 'the reader can open the project');
  return project.context?.shipped || [];
}
const summaries = (shipped) => shipped.map((entry) => entry.summary);

test('a card completed through the API writes a shipped line that names the card, and the line follows it out of Done, and away on delete', async () => {
  const ann = await makePerson('r6dc-ann');
  const projectId = await newProject(ann, null, `Line ${uuidv4().slice(0, 6)}`);

  assert.equal((await patch(ann, null, projectId, { add_todos: [{ title: 'Ship the queue', phase: 'testing' }] })).status, 200);
  assert.equal((await patch(ann, null, projectId, { complete_todos: ['Ship the queue'] })).status, 200);
  let shipped = await shippedOf(ann, null, projectId);
  assert.deepEqual(summaries(shipped), ['Ship the queue'], 'a Done card is a shipped line');
  assert.ok(shipped[0].card_id, 'and it names the card it came from');

  // The spine the dashboard and the tools read says it came from a card.
  const spine = await as('get', `/api/v1/context/projects/${projectId}/inject?tool=claude_code&verbosity=detailed`, ann);
  assert.equal(spine.status, 200, JSON.stringify(spine.body));
  const briefSpine = spine.body.payload?.brief_spine;
  const line = (briefSpine?.shipped || []).find((item) => item.text === 'Ship the queue');
  assert.ok(line, `the brief carries the line: ${JSON.stringify(spine.body).slice(0, 600)}`);
  assert.equal(line.from_card, true);

  // Back out of Done: the line goes.
  assert.equal((await patch(ann, null, projectId, { move_todos: [{ match: 'Ship the queue', phase: 'testing' }] })).status, 200);
  assert.deepEqual(summaries(await shippedOf(ann, null, projectId)), [], 'a card that is not Done has not shipped');

  // Done again, then deleted: the line goes with the card.
  assert.equal((await patch(ann, null, projectId, { complete_todos: ['Ship the queue'] })).status, 200);
  assert.deepEqual(summaries(await shippedOf(ann, null, projectId)), ['Ship the queue']);
  assert.equal((await patch(ann, null, projectId, { remove_todos: ['Ship the queue'] })).status, 200);
  assert.deepEqual(summaries(await shippedOf(ann, null, projectId)), [], 'a deleted card takes its line with it');
});

test('the same holds for the tool path (todo_completed and todo_moved events)', async () => {
  const ann = await makePerson('r6dc-ann2');
  const projectId = await newProject(ann, null, `Events ${uuidv4().slice(0, 6)}`);
  const send = (event_type, extra) => as('post', '/api/v1/context/events', ann).send({ event_type, project_id: projectId, ...extra });

  assert.equal((await send('todo_added', { summary: 'Wire the webhook', metadata: { todos: [{ title: 'Wire the webhook', phase: 'testing' }] } })).status, 202);
  assert.equal((await send('todo_completed', { summary: 'Wire the webhook', metadata: { todo: 'Wire the webhook' } })).status, 202);
  const shipped = await shippedOf(ann, null, projectId);
  assert.deepEqual(summaries(shipped), ['Wire the webhook']);
  assert.ok(shipped[0].card_id);

  assert.equal((await send('todo_moved', { summary: 'Wire the webhook', metadata: { todo: 'Wire the webhook', phase: 'in_progress' } })).status, 202);
  assert.deepEqual(summaries(await shippedOf(ann, null, projectId)), []);
});

test('a teammate who may edit the board but not the shipped section still takes the line back with the card', async () => {
  const ann = await makePerson('r6dc-ann3', { plan: 'developer_pro' });
  const lee = await makePerson('r6dc-lee3');
  const invite = await workspace.createInvite(ann.orgId, lee.email, { role: 'member', invitedBy: ann.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: lee.userId, email: lee.email });
  assert.equal(accepted.ok, true);

  const projectId = await newProject(ann, ann.orgId, `Team line ${uuidv4().slice(0, 6)}`);
  const shared = await as('patch', `/api/v1/teams/projects/${projectId}/sharing`, ann, ann.orgId).send({ visibility: 'shared' });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));

  assert.equal((await patch(ann, ann.orgId, projectId, { add_todos: [{ title: 'Cut the release', phase: 'testing' }] })).status, 200);
  assert.equal((await patch(ann, ann.orgId, projectId, { complete_todos: ['Cut the release'] })).status, 200);
  assert.deepEqual(summaries(await shippedOf(ann, ann.orgId, projectId)), ['Cut the release']);

  // The default share lets Lee edit the board, not the shipped list.
  const moved = await patch(lee, ann.orgId, projectId, { move_todos: [{ match: 'Cut the release', phase: 'in_progress' }] });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.deepEqual(summaries(await shippedOf(ann, ann.orgId, projectId)), [], 'the line is not left claiming a card that is no longer Done');
});
