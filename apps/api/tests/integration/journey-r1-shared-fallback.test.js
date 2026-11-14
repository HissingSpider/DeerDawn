/**
 * JOURNEY R1 / T2 — THE SHARED FALLBACK IS FOR SOMEBODY WHO HAS NOTHING.
 *
 * resolveActiveProject's last tier hands a caller with no project, no binding
 * and no location the workspace's most recent SHARED project, as a write
 * target. Its own comment names who that is for: the person who has authored
 * nothing and been bound to nothing, the invited teammate on their first
 * hosted session.
 *
 * But it only looked in the CURRENT workspace. Q has a personal project and has
 * been saving to it; Q accepts an invite, the hosted connection now acts in the
 * team, and Q's next "save this" (no project_id) matched nothing of Q's in the
 * team and fell to that tier: the decision was filed into a colleague's shared
 * project, a card landed on its board, and the reply said "Context updated".
 *
 * The rule now holds across every workspace the person belongs to. Somebody
 * with work of their own elsewhere gets no guessed WRITE target here, so an
 * id-less write is refused, says why, and nothing is saved. They still READ the
 * team's shared brief (write_target false, with a note saying why they are
 * seeing it), because that brief is what an invitee's first session is for.
 * The real newcomer is unchanged.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r1-shared-fallback.test.js
 */

process.env.NODE_ENV = 'test';
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
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');

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
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { label, orgId, userId, email, jwt, key };
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function asKey(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('X-Api-Key', person.key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
async function mcp(person, ws, name, args) {
  let r = request(httpServer).post('/mcp').set(MCP_HEADERS).set('X-Api-Key', person.key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  const res = await r.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return { text: body.result?.content?.[0]?.text || JSON.stringify(body.error || body), isError: body.result?.isError === true || Boolean(body.error) };
}

async function storedText(ownerKey, projectId) {
  const project = await store.getProject(ownerKey, projectId);
  return JSON.stringify(project?.context || {});
}

/**
 * O's team with one SHARED project whose decisions and board every member may
 * edit, so a write that reaches it lands (the walker's second run). Returns the
 * team; people are added by the tests.
 */
async function teamWithSharedProject() {
  const tag = uuidv4().slice(0, 8);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const made = await asKey('post', '/api/v1/context/projects', O)
    .send({ project_name: `cnyname-shared ${tag}`, description: 'the team project' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const sharedId = made.body.project.project_id;
  return { tag, O, sharedId };
}

async function shareEditable(fx) {
  const res = await request(httpServer).patch(`/api/v1/teams/projects/${fx.sharedId}/sharing`)
    .set('Authorization', `Bearer ${fx.O.jwt}`).set('x-deerdawn-workspace', fx.O.orgId)
    .send({
      visibility: 'shared',
      sections: [
        { section_key: 'current_status', can_view: true, can_edit: true },
        { section_key: 'recent_decisions', can_view: true, can_edit: true },
        { section_key: 'todo_items', can_view: true, can_edit: true },
        { section_key: 'open_questions', can_view: true, can_edit: true },
        { section_key: 'current_task', can_view: true, can_edit: true },
      ],
    });
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
}

test('T2: after joining a team, an id-less save from somebody with their own projects is refused, not filed into a colleague\'s shared project', async () => {
  const fx = await teamWithSharedProject();
  const Q = await makePerson('q');

  // Q's own world, before the invite: a personal project, saved to over the
  // hosted connection, which binds that connection there.
  const own = await asKey('post', '/api/v1/context/projects', Q).send({ project_name: `q-side-project ${fx.tag}` });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  const ownId = own.body.project.project_id;
  const before = await mcp(Q, null, 'manage_memory', { action: 'update', project_id: ownId, summary: `QWRITE-1-${fx.tag} decided to use bun` });
  assert.equal(before.isError, false, before.text);

  await join(fx.O, Q);
  await shareEditable(fx);
  const teamProjectsBefore = (await q('SELECT project_id FROM context_projects WHERE owner_key = $1', [fx.O.orgId])).rows.map((r) => r.project_id).sort();

  // Same connection, now acting in the team, "save this" with no project_id.
  const save = await mcp(Q, fx.O.orgId, 'manage_memory', { action: 'update', summary: `QWRITE-2-${fx.tag} decided to drop webpack` });
  const card = await mcp(Q, fx.O.orgId, 'manage_tasks', { action: 'add', todos: [`QCARD-${fx.tag}`] });

  const shared = await storedText(fx.O.orgId, fx.sharedId);
  assert.ok(!shared.includes(`QWRITE-2-${fx.tag}`), `THE BUG: Q's decision was filed into the colleague's shared project. Reply: ${save.text}`);
  assert.ok(!shared.includes(`QCARD-${fx.tag}`), `THE BUG: Q's card landed on the colleague's board. Reply: ${card.text}`);
  assert.ok(!/Context updated/.test(save.text), `the reply must not claim a save: ${save.text}`);
  assert.equal(save.isError, true, `a refused save is an error: ${save.text}`);
  assert.equal(card.isError, true, `a refused card is an error: ${card.text}`);
  assert.match(save.text, /project_id/, `the reply says what to do: ${save.text}`);

  const teamProjectsAfter = (await q('SELECT project_id FROM context_projects WHERE owner_key = $1', [fx.O.orgId])).rows.map((r) => r.project_id).sort();
  assert.deepEqual(teamProjectsAfter, teamProjectsBefore, 'nothing was created in the team either');
  const bound = await q('SELECT session_id FROM context_sessions WHERE owner_key = $1 AND user_id = $2 AND project_id = $3', [fx.O.orgId, Q.userId, fx.sharedId]);
  assert.equal(bound.rows.length, 0, 'the connection is not bound to the colleague\'s project');

  // Naming a project still works: the shared project, on purpose.
  const named = await mcp(Q, fx.O.orgId, 'manage_memory', { action: 'update', project_id: fx.sharedId, summary: `QWRITE-3-${fx.tag} on purpose` });
  assert.equal(named.isError, false, named.text);
  assert.ok((await storedText(fx.O.orgId, fx.sharedId)).includes(`QWRITE-3-${fx.tag}`));
});

test('T2: the resolver never offers that person the shared project as a write target', async () => {
  const fx = await teamWithSharedProject();
  const Q = await makePerson('q');
  const own = await asKey('post', '/api/v1/context/projects', Q).send({ project_name: `q-own ${fx.tag}` });
  assert.equal(own.status, 201);
  await join(fx.O, Q);
  await shareEditable(fx);

  // /active is what the local dispatcher asks; purpose=write is a write.
  const forWrite = await asKey('get', '/api/v1/context/active?purpose=write', Q, fx.O.orgId);
  assert.equal(forWrite.status, 200, JSON.stringify(forWrite.body));
  assert.ok(!forWrite.body.project_id || forWrite.body.write_target === false,
    `THE BUG: a write resolved to the colleague's shared project: ${JSON.stringify({ id: forWrite.body.project_id, kind: forWrite.body.match_kind, write_target: forWrite.body.write_target })}`);
  const read = await asKey('get', '/api/v1/context/active', Q, fx.O.orgId);
  assert.equal(read.status, 200);
  assert.ok(!read.body.project_id || read.body.write_target === false,
    `a read may show it, never as a write target: ${JSON.stringify({ id: read.body.project_id, kind: read.body.match_kind, write_target: read.body.write_target })}`);
});

test('T2: a binding elsewhere counts as much as a project elsewhere', async () => {
  const fx = await teamWithSharedProject();
  const other = await teamWithSharedProject();
  const Q = await makePerson('q');
  // Q owns nothing anywhere, but has worked (been bound) in another team.
  await join(other.O, Q);
  await request(httpServer).patch(`/api/v1/teams/projects/${other.sharedId}/sharing`)
    .set('Authorization', `Bearer ${other.O.jwt}`).set('x-deerdawn-workspace', other.O.orgId)
    .send({ visibility: 'shared', sections: [{ section_key: 'recent_decisions', can_view: true, can_edit: true }] });
  const worked = await mcp(Q, other.O.orgId, 'manage_memory', { action: 'update', project_id: other.sharedId, summary: `ELSEWHERE-${fx.tag}` });
  assert.equal(worked.isError, false, worked.text);

  await join(fx.O, Q);
  await shareEditable(fx);
  const save = await mcp(Q, fx.O.orgId, 'manage_memory', { action: 'update', summary: `LEAK-${fx.tag}` });
  assert.ok(!(await storedText(fx.O.orgId, fx.sharedId)).includes(`LEAK-${fx.tag}`), `filed into this team's shared project: ${save.text}`);
  assert.equal(save.isError, true, save.text);
});

test('T2: the genuine newcomer, with nothing anywhere, still reads and writes the team\'s shared project', async () => {
  const fx = await teamWithSharedProject();
  const N = await makePerson('newcomer');
  await join(fx.O, N);
  await shareEditable(fx);

  const active = await asKey('get', '/api/v1/context/active?purpose=write', N, fx.O.orgId);
  assert.equal(active.body.project_id, fx.sharedId, JSON.stringify(active.body).slice(0, 300));
  assert.equal(active.body.match_kind, 'shared_fallback');
  assert.equal(active.body.write_target, true);

  const save = await mcp(N, fx.O.orgId, 'manage_memory', { action: 'update', summary: `NEWCOMER-${fx.tag} first note` });
  assert.equal(save.isError, false, save.text);
  assert.match(save.text, /Context updated/, save.text);
  assert.ok((await storedText(fx.O.orgId, fx.sharedId)).includes(`NEWCOMER-${fx.tag}`));
});

// ─── The read is restored; every write stays refused ─────────────────────────
//
// Withholding the shared project from such a person altogether took away the
// invited teammate's first brief — most invitees have written something of
// their own before they join — and with it the one call team_context_received
// fires from. So they READ it (write_target false, match_confidence low, a note
// that is true for them), and every hosted handler that writes to a project it
// resolved itself resolves for a write.

const WHY = /your own projects are in another workspace you belong to/i;

/** The shared project's writable state, as stored, for a before/after diff. */
async function sharedState(ownerKey, projectId) {
  const project = await store.getProject(ownerKey, projectId);
  const c = project?.context || {};
  return JSON.stringify({
    todos: (c.todo_items || []).map((t) => [t.title, t.phase || t.status || null]),
    questions: c.open_questions || [],
    decisions: (c.recent_decisions || []).map((d) => d.summary),
    status: c.current_status || '',
    progress: c.task_progress || '',
    commands: c.commands || [],
  });
}

/**
 * Q has a personal project (and has saved to it); O's team has a shared project
 * with a task, an open question and three cards. Q joins.
 */
async function invitedWithOwnWork() {
  const fx = await teamWithSharedProject();
  const Q = await makePerson('q');
  const own = await asKey('post', '/api/v1/context/projects', Q).send({ project_name: `q-own-private ${fx.tag}` });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  fx.ownId = own.body.project.project_id;
  fx.ownName = `q-own-private ${fx.tag}`;
  const saved = await mcp(Q, null, 'manage_memory', { action: 'update', project_id: fx.ownId, summary: `QOWN-${fx.tag} decided to use bun` });
  assert.equal(saved.isError, false, saved.text);

  await join(fx.O, Q);
  await shareEditable(fx);
  const seeded = await request(httpServer).patch(`/api/v1/context/projects/${fx.sharedId}/context`)
    .set('Authorization', `Bearer ${fx.O.jwt}`).set('x-deerdawn-workspace', fx.O.orgId)
    .send({ current_task: `TEAMTASK-${fx.tag} ship idempotency keys`, open_questions: [`TEAMQ-${fx.tag} which queue?`] });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  const cards = await mcp(fx.O, fx.O.orgId, 'manage_tasks', { action: 'add', project_id: fx.sharedId, todos: [`CARD-A-${fx.tag}`, `CARD-B-${fx.tag}`, `CARD-C-${fx.tag}`] });
  assert.equal(cards.isError, false, cards.text);
  const decided = await mcp(fx.O, fx.O.orgId, 'manage_memory', { action: 'update', project_id: fx.sharedId, summary: `TEAMDEC-${fx.tag} retries are capped at three` });
  assert.equal(decided.isError, false, decided.text);
  fx.Q = Q;
  return fx;
}

test('T2b (a): a person with their own work elsewhere READS the team\'s shared project, read-only and told why', async () => {
  const fx = await invitedWithOwnWork();

  const read = await asKey('get', '/api/v1/context/active', fx.Q, fx.O.orgId);
  assert.equal(read.status, 200, JSON.stringify(read.body));
  assert.equal(read.body.project_id, fx.sharedId, `THE BUG: the read offer is withheld: ${JSON.stringify({ id: read.body.project_id, kind: read.body.match_kind })}`);
  assert.equal(read.body.match_kind, 'shared_fallback');
  assert.equal(read.body.write_target, false, 'shown, never a write target');
  assert.equal(read.body.match_confidence, 'low');
  const forWrite = await asKey('get', '/api/v1/context/active?purpose=write', fx.Q, fx.O.orgId);
  assert.equal(forWrite.body.project_id, null, `a write never resolves to it: ${forWrite.body.project_name}`);

  const opened = await mcp(fx.Q, fx.O.orgId, 'start_session', {});
  assert.equal(opened.isError, false, opened.text);
  assert.ok(opened.text.includes(`TEAMTASK-${fx.tag}`), `the shared brief is opened: ${opened.text.slice(0, 300)}`);
  assert.match(opened.text, WHY, `the brief says why this person is seeing it: ${opened.text.slice(0, 500)}`);
  assert.match(opened.text, /project_id/, 'and that saving here needs a project_id');
  assert.ok(!/no project of your own yet/.test(opened.text), 'the newcomer line is false for this person');
  assert.ok(!opened.text.includes(fx.ownName) && !opened.text.includes(fx.ownId), 'nothing from their other workspace is listed here');
  const bound = await q('SELECT session_id FROM context_sessions WHERE owner_key = $1 AND user_id = $2 AND project_id = $3', [fx.O.orgId, fx.Q.userId, fx.sharedId]);
  assert.equal(bound.rows.length, 0, 'reading it binds nothing');
});

test('T2b (b): every id-less hosted write from that person is refused, says why, and saves and binds nothing', async () => {
  const fx = await invitedWithOwnWork();
  const before = await sharedState(fx.O.orgId, fx.sharedId);

  const calls = [
    ['manage_memory', { action: 'update', summary: `LEAK-UPDATE-${fx.tag}` }],
    ['manage_tasks', { action: 'add', todos: [`LEAK-CARD-${fx.tag}`] }],
    ['manage_tasks', { action: 'move', todos: [`CARD-A-${fx.tag}`], phase: 'in_progress' }],
    ['manage_tasks', { action: 'complete', todos: [`CARD-B-${fx.tag}`] }],
    ['manage_tasks', { action: 'remove', todos: [`CARD-C-${fx.tag}`] }],
    ['manage_memory', { action: 'resolve_question', question: `TEAMQ-${fx.tag} which queue?`, answer: 'LEAK-ANSWER' }],
    ['manage_memory', { action: 'finish_task', complete_task: true, confirm_complete: true }],
  ];
  for (const [name, args] of calls) {
    const reply = await mcp(fx.Q, fx.O.orgId, name, args);
    assert.equal(reply.isError, true, `${name}/${args.action}: THE BUG: not refused: ${reply.text}`);
    assert.match(reply.text, WHY, `${name}/${args.action}: the refusal says why: ${reply.text}`);
    assert.match(reply.text, /project_id/, `${name}/${args.action}: and what to do: ${reply.text}`);
  }

  assert.equal(await sharedState(fx.O.orgId, fx.sharedId), before, 'nothing reached the colleague\'s shared project');
  const bound = await q('SELECT session_id FROM context_sessions WHERE owner_key = $1 AND user_id = $2 AND project_id IS NOT NULL', [fx.O.orgId, fx.Q.userId]);
  assert.equal(bound.rows.length, 0, 'and no session of theirs in the team is bound to anything');

  // A finish WITHOUT completing is a read (the checklist), and still answers.
  const checklist = await mcp(fx.Q, fx.O.orgId, 'manage_memory', { action: 'finish_task' });
  assert.equal(checklist.isError, false, checklist.text);
});

test('T2b (c): the genuine newcomer still reads, and writes id-less saves and cards to the shared project', async () => {
  const fx = await teamWithSharedProject();
  const N = await makePerson('newcomer');
  await join(fx.O, N);
  await shareEditable(fx);

  const opened = await mcp(N, fx.O.orgId, 'start_session', {});
  assert.equal(opened.isError, false, opened.text);
  assert.match(opened.text, /no project of your own yet/, opened.text.slice(0, 400));
  assert.ok(!WHY.test(opened.text), 'the other-workspace note is not for them');

  const card = await mcp(N, fx.O.orgId, 'manage_tasks', { action: 'add', todos: [`NEWCARD-${fx.tag}`] });
  assert.equal(card.isError, false, card.text);
  const save = await mcp(N, fx.O.orgId, 'manage_memory', { action: 'update', summary: `NEWSAVE-${fx.tag}` });
  assert.equal(save.isError, false, save.text);
  const shared = await storedText(fx.O.orgId, fx.sharedId);
  assert.ok(shared.includes(`NEWCARD-${fx.tag}`) && shared.includes(`NEWSAVE-${fx.tag}`));
});

test('T2b (d): the same person NAMING the shared project writes to it normally', async () => {
  const fx = await invitedWithOwnWork();
  const save = await mcp(fx.Q, fx.O.orgId, 'manage_memory', { action: 'update', project_id: fx.sharedId, summary: `NAMED-SAVE-${fx.tag}` });
  assert.equal(save.isError, false, save.text);
  assert.match(save.text, /Context updated/);
  const card = await mcp(fx.Q, fx.O.orgId, 'manage_tasks', { action: 'add', project_id: fx.sharedId, todos: [`NAMED-CARD-${fx.tag}`] });
  assert.equal(card.isError, false, card.text);
  const resolved = await mcp(fx.Q, fx.O.orgId, 'manage_memory', {
    action: 'resolve_question', project_id: fx.sharedId, question: `TEAMQ-${fx.tag} which queue?`, answer: `NAMED-ANSWER-${fx.tag} use SQS`,
  });
  assert.equal(resolved.isError, false, resolved.text);
  const shared = await storedText(fx.O.orgId, fx.sharedId);
  for (const mark of [`NAMED-SAVE-${fx.tag}`, `NAMED-CARD-${fx.tag}`, `NAMED-ANSWER-${fx.tag}`]) {
    assert.ok(shared.includes(mark), `${mark} landed`);
  }
});

test('T2b parity: a caller that sends a location (every local write) never reaches the shared fallback', async () => {
  const fx = await invitedWithOwnWork();
  // The actor the auth middleware builds for Q's key pointed at the team.
  const keyRow = await q('SELECT key_id FROM api_keys WHERE owner_id = $1', [fx.Q.userId]);
  const actor = {
    type: 'key', id: keyRow.rows[0].key_id, owner_id: fx.Q.userId, org_id: fx.Q.orgId,
    workspace_key: fx.O.orgId, scopes: ['context:read', 'context:write'],
  };
  const cwd = `/Users/q/code/unlinked-${fx.tag}`;
  const workspaceKey = `github.com/q/unlinked-${fx.tag}`;
  assert.equal(await service.resolveActiveProject(actor, cwd, workspaceKey, { forWrite: true }), null, 'a located write resolves nothing');
  assert.equal(await service.resolveActiveProject(actor, cwd, workspaceKey), null, 'a located read resolves nothing either');
  // The same actor with no location is the hosted case: read-only, and not for a write.
  const hosted = await service.resolveActiveProject(actor, null, null);
  assert.equal(hosted?.project_id, fx.sharedId);
  assert.equal(hosted?.write_target, false);
  assert.equal(await service.resolveActiveProject(actor, null, null, { forWrite: true }), null);
});

// ─── The same rule on the A2A binding ───────────────────────────────────────
//
// A2A's record-memory-update resolved an omitted projectId in READ mode
// (routes/a2a.js resolveProjectId) and then wrote there, so once the shared
// project was offered for reading it was written to. The write skill now
// resolves for a write; load-project-brief still reads.

async function a2a(person, ws, data, text) {
  const parts = [{ data }];
  if (text) parts.push({ text });
  let r = request(httpServer).post('/a2a/v1').set('x-api-key', person.key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  const res = await r.send({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: uuidv4(), role: 'ROLE_USER', parts } } });
  assert.equal(res.status, 200, res.text);
  return res.body;
}

test('T2b (b, A2A): an id-less A2A memory update from that person is refused, says why, and saves and binds nothing', async () => {
  const fx = await invitedWithOwnWork();
  const before = await sharedState(fx.O.orgId, fx.sharedId);
  const body = await a2a(fx.Q, fx.O.orgId, { skill: 'record-memory-update' }, `A2ALEAK-${fx.tag}`);

  assert.ok(!JSON.stringify(body).includes('Context updated'), `THE BUG: the A2A write was accepted: ${JSON.stringify(body).slice(0, 200)}`);
  assert.equal(await sharedState(fx.O.orgId, fx.sharedId), before, 'the A2A write reached the colleague\'s shared project');
  // The error shape this binding already uses for a missing project.
  assert.equal(body.error?.code, -32602, JSON.stringify(body));
  const violation = body.error?.data?.[0]?.fieldViolations?.[0];
  assert.equal(body.error?.data?.[0]?.['@type'], 'type.googleapis.com/google.rpc.BadRequest');
  assert.equal(violation?.field, 'message.parts[].data.projectId');
  // The whole refusal is the service's text for this person (journey round 2:
  // the generic next step steered an assistant into creating a shared project).
  assert.match(String(violation?.description), /^Nothing was saved\. /);
  assert.ok(!/create one|create or select/.test(String(violation?.description)), 'no "create one" as the way forward');
  assert.match(String(violation?.description), WHY, `the refusal says why: ${violation?.description}`);
  const bound = await q('SELECT session_id FROM context_sessions WHERE owner_key = $1 AND user_id = $2 AND project_id IS NOT NULL', [fx.O.orgId, fx.Q.userId]);
  assert.equal(bound.rows.length, 0, 'nothing is bound');
});

test('T2b (A2A): reading stays a read, and naming the project writes normally', async () => {
  const fx = await invitedWithOwnWork();
  // sections given: load-project-brief without them sends `sections: undefined`,
  // which the tool validator refuses (a separate, pre-existing issue).
  const brief = await a2a(fx.Q, fx.O.orgId, { skill: 'load-project-brief', sections: ['task'] });
  assert.ok(!brief.error, JSON.stringify(brief.error));
  assert.ok(JSON.stringify(brief).includes(`TEAMTASK-${fx.tag}`), 'an id-less A2A read still opens the shared brief');

  const named = await a2a(fx.Q, fx.O.orgId, { skill: 'record-memory-update', projectId: fx.sharedId }, `A2ANAMED-${fx.tag} on purpose`);
  assert.ok(!named.error, JSON.stringify(named.error));
  assert.ok((await storedText(fx.O.orgId, fx.sharedId)).includes(`A2ANAMED-${fx.tag}`), 'the named A2A write landed');
});

test('T2b (A2A): the genuine newcomer\'s id-less A2A write still lands in the shared project', async () => {
  const fx = await teamWithSharedProject();
  const N = await makePerson('newcomer');
  await join(fx.O, N);
  await shareEditable(fx);
  const body = await a2a(N, fx.O.orgId, { skill: 'record-memory-update' }, `A2ANEW-${fx.tag} first note`);
  assert.ok(!body.error, JSON.stringify(body.error));
  assert.ok((await storedText(fx.O.orgId, fx.sharedId)).includes(`A2ANEW-${fx.tag}`), 'the newcomer\'s A2A write landed');
});
