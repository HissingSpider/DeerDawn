/**
 * JOURNEY R2 — ROUND 1'S OWN REFUSAL STEERED AN ASSISTANT INTO A LEAK.
 *
 * P3 has personal projects, joins a team, and in the same Claude.ai connection
 * says "save this note". Round 1 refused the id-less save, and the refusal was
 * the generic one plus a sentence: "Pass project_id (recall(action:"projects")
 * lists them), or, if there is no project yet, create one with
 * manage_projects(action:"create", …). Your own projects are in another
 * workspace …". recall listed only the team's project, so an assistant doing
 * exactly what it was told created "Lighthouse Blog" — in the TEAM, shared with
 * every member by default — and saved the private note into it. The create
 * reply said only `Created project "Lighthouse Blog" (project_…)`. The owner
 * read the note, and after P3 left the team it stayed there out of their reach.
 *
 * Now, for a person whose own work is in another workspace, every refusal and
 * the brief say: nothing was saved; which workspace this connection is working
 * in; that their own projects are elsewhere; switch workspace to save there, or
 * name a project here; and that a project created here belongs to this
 * workspace and is shared with its members by default. A create in a
 * multi-member workspace says where the project is and who reads it, read back
 * from the row. Everyone else's texts are unchanged, byte for byte.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r2-own-work-elsewhere-text.test.js
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

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label, { plan = 'free', orgName = null } = {}) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, orgName || `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
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
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return { label, orgId, userId, email, jwt, key };
}

async function join(owner, joiner) {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role: 'member', invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
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
  return {
    text: body.result?.content?.[0]?.text || JSON.stringify(body.error || body),
    isError: body.result?.isError === true || Boolean(body.error),
    data: body.result?.structuredContent,
  };
}

async function a2a(person, ws, data, text) {
  const parts = [{ data }];
  if (text) parts.push({ text });
  let r = request(httpServer).post('/a2a/v1').set('x-api-key', person.key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  const res = await r.send({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: uuidv4(), role: 'ROLE_USER', parts } } });
  assert.equal(res.status, 200, res.text);
  return res.body;
}

async function storedText(ownerKey, projectId) {
  const project = await store.getProject(ownerKey, projectId);
  return JSON.stringify(project?.context || {});
}

// ─── The exact texts ────────────────────────────────────────────────────────

// For the person whose own work is in another workspace. `label` is the
// workspace's display name in quotes.
const elsewhereRefusal = (label, { param = 'project_id', listing = true } = {}) => 'Nothing was saved. '
  + `This connection is working in ${label}, and your own projects are in another workspace you belong to. `
  + 'To save there, switch workspace in the dashboard\'s workspace switcher and continue. '
  + `To save here, pass ${param} for one of this workspace's projects${listing ? ' (recall(action:"projects") lists them)' : ''}. `
  + 'A project created here belongs to this workspace and, in a workspace with more than one member, is shared with its members by default.';

// Everybody else's, exactly as they were before this change.
const NO_PROJECT_NEXT_STEP = 'Pass project_id (recall(action:"projects") lists them), or, if there is no project yet, create one with manage_projects(action:"create", project_name:"<name>").';
const GENERIC = {
  update: `Error [invalid_arguments]: No active project to update — project_id is required when there is none. ${NO_PROJECT_NEXT_STEP}`,
  board: 'Error [invalid_arguments]: No active project — pass project_id, or create or select a project first (manage_projects).',
  question: `Error [invalid_arguments]: project_id is required — no active project was found. ${NO_PROJECT_NEXT_STEP}`,
  a2a: 'No active project — pass projectId.',
};

/**
 * P3's world: a personal "Lighthouse Blog" with a private note, then an invite
 * into the owner's team, whose "Fleet Tracker" is shared with every member.
 */
async function p3JoinsTeam() {
  const tag = uuidv4().slice(0, 8);
  const O = await makePerson('owner', { plan: 'developer_pro', orgName: `Acme Walk Team ${tag}` });
  const P3 = await makePerson('p3');
  const blog = await mcp(P3, null, 'manage_projects', { action: 'create', project_name: `Lighthouse Blog ${tag}` });
  assert.equal(blog.isError, false, blog.text);
  const blogId = blog.data?.project_id;
  const note = await mcp(P3, null, 'manage_memory', { action: 'update', project_id: blogId, summary: `PRIVATE-${tag}: planning to resign in March` });
  assert.equal(note.isError, false, note.text);

  await join(O, P3);
  const fleet = await mcp(O, O.orgId, 'manage_projects', { action: 'create', project_name: `Fleet Tracker ${tag}` });
  assert.equal(fleet.isError, false, fleet.text);
  const fleetId = fleet.data?.project_id;
  const shared = await request(httpServer).patch(`/api/v1/teams/projects/${fleetId}/sharing`)
    .set('Authorization', `Bearer ${O.jwt}`).set('x-deerdawn-workspace', O.orgId)
    .send({ visibility: 'shared', sections: [{ section_key: 'recent_decisions', can_view: true, can_edit: true }, { section_key: 'todo_items', can_view: true, can_edit: true }] });
  assert.equal(shared.status, 200, JSON.stringify(shared.body));
  return { tag, O, P3, blogId, fleetId, team: `"Acme Walk Team ${tag}"` };
}

test('R2: the walker\'s story — the refusal no longer steers the assistant into a shared team project', async () => {
  const fx = await p3JoinsTeam();

  // 1. The brief: read-only, names the workspace, the way to save elsewhere,
  //    and does not suggest creating a project here.
  const opened = await mcp(fx.P3, fx.O.orgId, 'start_session', {});
  assert.equal(opened.isError, false, opened.text);
  assert.ok(opened.text.includes(
    `this is the most recently active shared project in ${fx.team}, the workspace this connection is working in; `
    + 'your own projects are in another workspace you belong to, so it is here to read: to save to your own, '
    + 'switch workspace in the dashboard\'s workspace switcher, and to save here, pass project_id',
  ), `the brief's note: ${opened.text.slice(0, 900)}`);
  assert.ok(!/create/i.test(opened.text.split('\n').find((line) => line.startsWith('⚠')) || ''), 'the note does not steer towards creating');

  // 2. "Save this note", no project_id: refused with the exact sentences.
  const save = await mcp(fx.P3, fx.O.orgId, 'manage_memory', { action: 'update', summary: `PRIVATE-${fx.tag}: finished the Eddystone draft` });
  assert.equal(save.isError, true);
  assert.equal(save.text, `Error [invalid_arguments]: ${elsewhereRefusal(fx.team)}`);
  assert.ok(!save.text.includes('create one with manage_projects'), 'THE BUG: the refusal tells them to create a project here');

  // Every other id-less write says the same thing.
  for (const [name, args] of [
    ['manage_tasks', { action: 'add', todos: [`CARD-${fx.tag}`] }],
    ['manage_memory', { action: 'resolve_question', question: 'which queue?', answer: 'SQS' }],
    ['manage_memory', { action: 'finish_task', complete_task: true, confirm_complete: true }],
    ['manage_memory', { action: 'record_finding', summary: `FINDING-${fx.tag}` }],
  ]) {
    const reply = await mcp(fx.P3, fx.O.orgId, name, args);
    assert.equal(reply.text, `Error [invalid_arguments]: ${elsewhereRefusal(fx.team)}`, `${name}/${args.action}`);
  }
  const viaA2a = await a2a(fx.P3, fx.O.orgId, { skill: 'record-memory-update' }, `A2A-${fx.tag}`);
  assert.equal(viaA2a.error?.data?.[0]?.fieldViolations?.[0]?.description, elsewhereRefusal(fx.team, { param: 'projectId', listing: false }));

  // 3. What the refusal points at: this workspace's projects are listed, and
  //    naming the personal one is not found here.
  const listed = await mcp(fx.P3, fx.O.orgId, 'recall', { action: 'projects' });
  assert.ok(listed.text.includes(`Fleet Tracker ${fx.tag}`) && !listed.text.includes('Lighthouse Blog'));

  // Nothing private went anywhere on the way.
  assert.ok(!(await storedText(fx.O.orgId, fx.fleetId)).includes(`PRIVATE-${fx.tag}`));
});

test('R2: an assistant that creates a project here anyway is told, in the reply, who reads it', async () => {
  const fx = await p3JoinsTeam();
  const refused = await mcp(fx.P3, fx.O.orgId, 'manage_memory', { action: 'update', summary: `PRIVATE-${fx.tag}: finished the Eddystone draft` });
  assert.equal(refused.text, `Error [invalid_arguments]: ${elsewhereRefusal(fx.team)}`);
  // Before anything is saved into it, the create reply says where it is and who reads it.
  const created = await mcp(fx.P3, fx.O.orgId, 'manage_projects', { action: 'create', project_name: `Lighthouse Blog ${fx.tag}` });
  assert.equal(created.isError, false, created.text);
  assert.equal(
    created.text,
    // Round 3 (H3-1): create also says it moved this connection, in select's words.
    // Round 4: a project a tool creates in a team starts personal (the owner's
    // decision), and the reply says so and how to share it.
    `Created project "Lighthouse Blog ${fx.tag}" (${created.data.project_id}). This connection now works in "Lighthouse Blog ${fx.tag}". Other connections are unchanged. It belongs to the workspace ${fx.team} and is personal, readable only by you. To share it with the team, open the dashboard's team settings and set it to "Shared with the team" under "What this team can see".`,
    'THE BUG: the create reply did not say where the new project is and who reads it',
  );
});

test('R2: a create in a team workspace says where the project is and who reads it, from the stored row', async () => {
  const fx = await p3JoinsTeam();
  const created = await mcp(fx.O, fx.O.orgId, 'manage_projects', { action: 'create', project_name: `Billing ${fx.tag}` });
  const row = await q('SELECT owner_key, visibility FROM context_projects WHERE project_id = $1', [created.data.project_id]);
  assert.equal(row.rows[0].owner_key, fx.O.orgId);
  // Round 4: created by a tool in a workspace with more than one member, it
  // starts personal (the owner's decision; the dashboard keeps "shared").
  assert.equal(row.rows[0].visibility, 'personal', 'a project a tool creates in a team starts personal');
  assert.equal(created.text, `Created project "Billing ${fx.tag}" (${created.data.project_id}). This connection now works in "Billing ${fx.tag}". Other connections are unchanged. It belongs to the workspace ${fx.team} and is personal, readable only by you. To share it with the team, open the dashboard's team settings and set it to "Shared with the team" under "What this team can see".`);
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [created.data.project_id, 'shared']);
  const shared = await mcp(fx.O, fx.O.orgId, 'manage_projects', { action: 'select', project_id: created.data.project_id });
  assert.equal(shared.text, `This connection now works in "Billing ${fx.tag}". Other connections are unchanged. It belongs to the workspace ${fx.team} and is shared with the members of ${fx.team}.`);

  // Selecting says the same about the project the connection will now save to,
  // in words for its real, stored visibility.
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [created.data.project_id, 'personal']);
  const personal = await mcp(fx.O, fx.O.orgId, 'manage_projects', { action: 'select', project_id: created.data.project_id });
  assert.equal(personal.text, `This connection now works in "Billing ${fx.tag}". Other connections are unchanged. It belongs to the workspace ${fx.team} and is personal, readable only by you.`);
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [created.data.project_id, 'private']);
  const priv = await mcp(fx.O, fx.O.orgId, 'manage_projects', { action: 'select', project_id: created.data.project_id });
  assert.equal(priv.text, `This connection now works in "Billing ${fx.tag}". Other connections are unchanged. It belongs to the workspace ${fx.team} and is private to you and the workspace's owners.`);
  // A teammate selecting the owner's shared project is told who reads it too.
  const bySomebodyElse = await mcp(fx.P3, fx.O.orgId, 'manage_projects', { action: 'select', project_id: fx.fleetId });
  assert.equal(bySomebodyElse.text, `This connection now works in "Fleet Tracker ${fx.tag}". Other connections are unchanged. It belongs to the workspace ${fx.team} and is shared with the members of ${fx.team}.`);
});

test('R2: a solo person\'s create, select and refusals are byte-identical to before', async () => {
  const S = await makePerson('solo');
  for (const [name, args, want] of [
    ['manage_memory', { action: 'update', summary: 'a note' }, GENERIC.update],
    ['manage_tasks', { action: 'add', todos: ['a card'] }, GENERIC.board],
    ['manage_memory', { action: 'resolve_question', question: 'q?', answer: 'a' }, GENERIC.question],
    ['manage_memory', { action: 'finish_task', complete_task: true, confirm_complete: true }, GENERIC.board],
  ]) {
    const reply = await mcp(S, null, name, args);
    assert.equal(reply.text, want, `${name}/${args.action}`);
  }
  const viaA2a = await a2a(S, null, { skill: 'record-memory-update' }, 'a note');
  assert.equal(viaA2a.error?.data?.[0]?.fieldViolations?.[0]?.description, GENERIC.a2a);

  const created = await mcp(S, null, 'manage_projects', { action: 'create', project_name: 'Solo Thing' });
  // The one text that changed since round 2, on purpose (round 3, H3-1): create
  // moves this connection, and now says so in select's own sentence.
  assert.equal(created.text, `Created project "Solo Thing" (${created.data.project_id}). This connection now works in "Solo Thing". Other connections are unchanged.`);
  const selected = await mcp(S, null, 'manage_projects', { action: 'select', project_id: created.data.project_id });
  assert.equal(selected.text, 'This connection now works in "Solo Thing". Other connections are unchanged.');
});

test('R2: the genuine newcomer\'s refusals and brief note are byte-identical to before', async () => {
  const tag = uuidv4().slice(0, 8);
  const O = await makePerson('owner', { plan: 'developer_pro', orgName: `Newcomer Team ${tag}` });
  const N = await makePerson('newcomer');
  await join(O, N);
  // No shared project yet: nothing to fall back to, so the id-less writes refuse.
  for (const [name, args, want] of [
    ['manage_memory', { action: 'update', summary: 'a note' }, GENERIC.update],
    ['manage_tasks', { action: 'add', todos: ['a card'] }, GENERIC.board],
    ['manage_memory', { action: 'resolve_question', question: 'q?', answer: 'a' }, GENERIC.question],
  ]) {
    const reply = await mcp(N, O.orgId, name, args);
    assert.equal(reply.text, want, `${name}/${args.action}`);
  }
  const viaA2a = await a2a(N, O.orgId, { skill: 'record-memory-update' }, 'a note');
  assert.equal(viaA2a.error?.data?.[0]?.fieldViolations?.[0]?.description, GENERIC.a2a);

  // With a shared project, the newcomer's note is the one it always was.
  const made = await mcp(O, O.orgId, 'manage_projects', { action: 'create', project_name: `Team Thing ${tag}` });
  await q('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [made.data.project_id, 'shared']);
  const opened = await mcp(N, O.orgId, 'start_session', {});
  assert.ok(opened.text.includes('you have no project of your own yet — this is the workspace\'s most recently active shared project; pass project_id to open a different one'), opened.text.slice(0, 600));
});
