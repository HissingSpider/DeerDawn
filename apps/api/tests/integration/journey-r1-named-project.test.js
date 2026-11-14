/**
 * JOURNEY R1 / H1 — A WRITE THAT NAMES A PROJECT IS WRITTEN THERE OR NOWHERE.
 *
 * A person has a personal project, joins a team, and their connection now acts
 * in the team workspace. Their AI tool still holds the personal project's id and
 * saves a private note to it. applyExtraction could not load that id in the
 * team workspace, so it fell through to the extraction's own guess: the model
 * had proposed a project (should_create_project + project_candidate), and one
 * was CREATED in the team, shared by default, holding the private note, while
 * the reply said "Context updated". The same thing ran the other way for a team
 * project id used from the personal workspace.
 *
 * The session row was also written before anything had checked the id, so a
 * stale or unknown id surfaced as internal_error (a foreign-key violation)
 * rather than as not found, and a foreign id that did exist was bound onto this
 * workspace's session.
 *
 * No model is called: the extraction a live model returns in that story is
 * handed in, either in the request body or by standing in for runExtraction.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r1-named-project.test.js
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
const extractionService = require('../../src/services/extractionService');

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

// A plain API key minted in the person's own workspace. The x-deerdawn-workspace
// header is what points it at the team, exactly as a teammate's install does.
async function mintKey(person) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, person.orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function asKey(method, path, key, ws = null) {
  let r = request(httpServer)[method](path).set('X-Api-Key', key);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
async function mcp(key, ws, name, args) {
  let r = request(httpServer).post('/mcp').set(MCP_HEADERS).set('X-Api-Key', key);
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

// What a live model answered in the walker's story: it read the private note as
// a brand-new project and proposed one named after it.
function modelProposesNewProject(name, note) {
  return {
    match_decision: 'new_project',
    confidence: 0.82,
    project_candidate: { project_name: name, reason: 'New topic in the conversation', score: 0.82 },
    delta: { current_status: note },
    should_create_project: true,
    needs_user_confirmation: false,
    no_material_change: false,
  };
}

async function withModelAnswer(answer, run) {
  const original = extractionService.runExtraction;
  extractionService.runExtraction = async () => answer;
  try {
    return await run();
  } finally {
    extractionService.runExtraction = original;
  }
}

async function projectsIn(ownerKey) {
  const res = await q('SELECT project_id, project_name, visibility FROM context_projects WHERE owner_key = $1', [ownerKey]);
  return res.rows;
}

async function storedText(ownerKey, projectId) {
  const project = await store.getProject(ownerKey, projectId);
  return JSON.stringify(project?.context || {});
}

async function sessionsPointingAt(projectId) {
  const res = await q('SELECT owner_key, session_id FROM context_sessions WHERE project_id = $1', [projectId]);
  return res.rows;
}

/**
 * O owns a team. M has a personal project with something in it, then joins
 * O's team. M's key, pointed at the team, is the connection in the story.
 */
async function joinedTeam() {
  const tag = uuidv4().slice(0, 8);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  const mKey = await mintKey(M);

  const personal = await asKey('post', '/api/v1/context/projects', mKey)
    .send({ project_name: `Wedding Planning ${tag}`, description: 'my own' });
  assert.equal(personal.status, 201, JSON.stringify(personal.body));
  const personalId = personal.body.project.project_id;

  const oKey = await mintKey(O);
  const team = await asKey('post', '/api/v1/context/projects', oKey)
    .send({ project_name: `Team Billing ${tag}`, description: 'the team billing service' });
  assert.equal(team.status, 201, JSON.stringify(team.body));
  const teamProjectId = team.body.project.project_id;

  await join(O, M);
  return { tag, O, M, mKey, oKey, personalId, teamProjectId };
}

test('H1 hosted: manage_memory update naming a personal project from the team creates nothing and says nothing was saved', async () => {
  const fx = await joinedTeam();
  const NOTE = `PRIVNOTE-${fx.tag} venue deposit is 4000 and I have not told work`;
  const candidate = `Wedding Planning ${fx.tag}`;
  const before = await projectsIn(fx.O.orgId);

  const reply = await withModelAnswer(modelProposesNewProject(candidate, NOTE), () => mcp(fx.mKey, fx.O.orgId, 'manage_memory', {
    action: 'update', project_id: fx.personalId, summary: NOTE,
  }));

  const after = await projectsIn(fx.O.orgId);
  assert.deepEqual(
    after.map((p) => p.project_id).sort(),
    before.map((p) => p.project_id).sort(),
    `THE BUG: a project was created in the TEAM workspace for a write that named the personal project: ${JSON.stringify(after)}`,
  );
  assert.ok(!/Context updated/.test(reply.text), `the reply must not claim a save: ${reply.text}`);
  assert.equal(reply.isError, true, `a refused write is an error reply: ${reply.text}`);
  assert.match(reply.text, /nothing was saved/i, `the reply must say nothing was saved: ${reply.text}`);
  assert.match(reply.text, /not_found/, `it is a not-found answer: ${reply.text}`);
  assert.ok(!(await storedText(fx.M.orgId, fx.personalId)).includes(`PRIVNOTE-${fx.tag}`), 'the personal project is untouched too');
  assert.deepEqual(await sessionsPointingAt(fx.personalId), [], 'no session anywhere is bound to a project this connection could not load');
});

test('H1 hosted, reverse: a team project id used from the personal workspace is refused the same way', async () => {
  const fx = await joinedTeam();
  const NOTE = `TEAMNOTE-${fx.tag} invoices go out on the first`;
  const before = await projectsIn(fx.M.orgId);

  // No workspace header: M's own key acts in M's personal workspace.
  const reply = await withModelAnswer(modelProposesNewProject(`Team Billing ${fx.tag}`, NOTE), () => mcp(fx.mKey, null, 'manage_memory', {
    action: 'update', project_id: fx.teamProjectId, summary: NOTE,
  }));

  const after = await projectsIn(fx.M.orgId);
  assert.deepEqual(after.map((p) => p.project_id).sort(), before.map((p) => p.project_id).sort(),
    `a team write named by id must not create a project in the personal workspace: ${JSON.stringify(after)}`);
  assert.equal(reply.isError, true, reply.text);
  assert.match(reply.text, /nothing was saved/i, reply.text);
});

test('H1 local: POST /extraction, explicit and passive, answers 404 not found and writes nothing', async () => {
  const fx = await joinedTeam();
  const NOTE = `LOCALNOTE-${fx.tag} private`;
  const before = await projectsIn(fx.O.orgId);

  // The local dispatcher's update_context: explicit, with the id it holds.
  const explicit = await withModelAnswer(modelProposesNewProject(`Wedding Planning ${fx.tag}`, NOTE), () => asKey('post', '/api/v1/context/extraction', fx.mKey, fx.O.orgId).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: fx.personalId,
    explicit: true,
    chunks: [{ role: 'assistant', text: NOTE }],
  }));
  assert.equal(explicit.status, 404, `explicit: ${explicit.status} ${JSON.stringify(explicit.body)}`);
  assert.equal(explicit.body.error, 'project_not_found');
  assert.match(String(explicit.body.message), /nothing was saved/i);

  // A passive capture carrying the model's answer in the body.
  const passive = await asKey('post', '/api/v1/context/extraction', fx.mKey, fx.O.orgId).send({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: fx.personalId,
    chunks: [{ role: 'assistant', text: NOTE }],
    extraction: modelProposesNewProject(`Wedding Planning ${fx.tag}`, NOTE),
  });
  assert.equal(passive.status, 404, `passive: ${passive.status} ${JSON.stringify(passive.body)}`);
  assert.equal(passive.body.error, 'project_not_found');

  const after = await projectsIn(fx.O.orgId);
  assert.deepEqual(after.map((p) => p.project_id).sort(), before.map((p) => p.project_id).sort(),
    `nothing may be created in the team: ${JSON.stringify(after)}`);
  assert.deepEqual(await sessionsPointingAt(fx.personalId), [], 'no session is bound to the foreign id');
});

test('H1: an id that exists elsewhere and an id that exists nowhere get the same answer', async () => {
  const fx = await joinedTeam();
  const body = (projectId) => ({
    session_id: `sess-${uuidv4()}`,
    tool: 'claude_code',
    project_id: projectId,
    chunks: [{ role: 'assistant', text: 'note' }],
    extraction: modelProposesNewProject(`Anything ${fx.tag}`, 'note'),
  });
  const foreign = await asKey('post', '/api/v1/context/extraction', fx.mKey, fx.O.orgId).send(body(fx.personalId));
  // Before the fix this one was internal_error: the session upsert hit the
  // context_sessions -> context_projects foreign key before anything had
  // checked the id.
  const unknown = await asKey('post', '/api/v1/context/extraction', fx.mKey, fx.O.orgId).send(body(`project_${uuidv4()}`));
  assert.equal(unknown.status, 404, `unknown id: ${unknown.status} ${JSON.stringify(unknown.body)}`);
  assert.equal(foreign.status, unknown.status);
  assert.equal(foreign.body.error, unknown.body.error);
  assert.equal(foreign.body.message, unknown.body.message, 'the text must not tell a foreign id from a missing one');

  const hostedUnknown = await withModelAnswer(modelProposesNewProject(`Anything ${fx.tag}`, 'note'), () => mcp(fx.mKey, fx.O.orgId, 'manage_memory', {
    action: 'update', project_id: `project_${uuidv4()}`, summary: 'note',
  }));
  const hostedForeign = await withModelAnswer(modelProposesNewProject(`Anything ${fx.tag}`, 'note'), () => mcp(fx.mKey, fx.O.orgId, 'manage_memory', {
    action: 'update', project_id: fx.personalId, summary: 'note',
  }));
  assert.equal(hostedUnknown.isError, true, hostedUnknown.text);
  assert.ok(!/internal_error/.test(hostedUnknown.text), `an unknown id is not a server fault: ${hostedUnknown.text}`);
  assert.equal(hostedForeign.text, hostedUnknown.text, 'hosted: the same words for a foreign id and a missing one');
});

test('H1: the direct-write helpers refuse a named project they cannot load and write nowhere else', async () => {
  const fx = await joinedTeam();
  const before = await projectsIn(fx.O.orgId);
  const nodesBefore = (await q('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1', [fx.O.orgId])).rows[0].n;
  const calls = [
    ['manage_memory', { action: 'record_paths', project_id: fx.personalId, items: [{ label: 'venue', path: 'notes/venue.md', purpose: 'private' }] }],
    ['manage_memory', { action: 'record_finding', project_id: fx.personalId, summary: `FINDING-${fx.tag} private`, paths: ['notes/venue.md'] }],
    ['manage_memory', { action: 'upsert_entities', project_id: fx.personalId, entities: [{ entity_type: 'decision', title: `ENT-${fx.tag} private decision` }] }],
    ['manage_memory', { action: 'upsert_entities', entities: [{ entity_type: 'decision', title: `ENT2-${fx.tag} private decision`, project_id: fx.personalId }] }],
    ['manage_tasks', { action: 'add', project_id: fx.personalId, todos: [`CARD-${fx.tag} private`] }],
  ];
  for (const [name, args] of calls) {
    const reply = await mcp(fx.mKey, fx.O.orgId, name, args);
    assert.equal(reply.isError, true, `${args.action}: must be refused, got ${reply.text}`);
    assert.match(reply.text, /not found|No project|not_found/i, `${args.action}: a not-found answer, got ${reply.text}`);
  }
  // The local dispatcher's REST equivalents.
  const rest = [
    ['post', `/api/v1/context/projects/${fx.personalId}/hot-paths`, { items: [{ label: 'venue', path: 'notes/venue.md', purpose: 'private' }] }],
    ['post', `/api/v1/context/projects/${fx.personalId}/debug-findings`, { summary: `RFINDING-${fx.tag} private`, paths: [] }],
    ['post', '/api/v1/context/events', { event_type: 'todo_added', project_id: fx.personalId, summary: `RCARD-${fx.tag}`, metadata: { todos: [`RCARD-${fx.tag}`] } }],
    ['post', '/api/v1/context/workspace/entities', { entities: [{ entity_type: 'decision', title: `RENT-${fx.tag} private`, project_id: fx.personalId }] }],
  ];
  for (const [method, path, payload] of rest) {
    const res = await asKey(method, path, fx.mKey, fx.O.orgId).send(payload);
    assert.equal(res.status, 404, `${path}: ${res.status} ${JSON.stringify(res.body)}`);
  }
  const after = await projectsIn(fx.O.orgId);
  assert.deepEqual(after.map((p) => p.project_id).sort(), before.map((p) => p.project_id).sort());
  const nodesAfter = (await q('SELECT COUNT(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1', [fx.O.orgId])).rows[0].n;
  assert.equal(nodesAfter, nodesBefore, 'no graph node was written into the team either');
  const personalText = await storedText(fx.M.orgId, fx.personalId);
  assert.ok(!new RegExp(`(FINDING|ENT2?|CARD)-${fx.tag}`).test(personalText) && !personalText.includes('notes/venue.md'),
    'and nothing reached the personal project');
});

test('H1: a named project the caller CAN load is still written, and binds the session', async () => {
  const fx = await joinedTeam();
  const NOTE = `OWNNOTE-${fx.tag} fine to save`;
  // M's own personal project, from M's personal workspace: the ordinary case.
  const reply = await withModelAnswer({
    match_decision: 'matched_existing',
    confidence: 0.9,
    project_candidate: { project_id: fx.personalId, project_name: `Wedding Planning ${fx.tag}` },
    delta: {},
    should_create_project: false,
    needs_user_confirmation: false,
    no_material_change: true,
  }, () => mcp(fx.mKey, null, 'manage_memory', { action: 'update', project_id: fx.personalId, summary: NOTE }));
  assert.equal(reply.isError, false, reply.text);
  assert.match(reply.text, /Context updated/, reply.text);
  assert.ok((await storedText(fx.M.orgId, fx.personalId)).includes(`OWNNOTE-${fx.tag}`));
  const bound = await sessionsPointingAt(fx.personalId);
  assert.ok(bound.length >= 1 && bound.every((row) => row.owner_key === fx.M.orgId), JSON.stringify(bound));
});
