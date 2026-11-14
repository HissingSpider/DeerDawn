/**
 * THE TEAM LOOP, END TO END, THROUGH THE HOSTED /mcp ROUTE.
 *
 * The team product is one sentence: a colleague writes something down, and the
 * next person's session opens with it. Every existing test of that loop posts a
 * hand-built delta to POST /extraction, which is the one write path that already
 * stamped an author. Everything a real hosted user touches —
 * manage_memory/update_context — built its decision entries with no
 * contributed_by at all, and:
 *
 *   - buildTeamDelta skips an entry with no author,
 *   - contradictionDetector filters one out,
 *   - so team_context_received, the event that measures team activation, could
 *     never fire for work recorded through a tool.
 *
 * Separately, hosted start_session with a project_id handed buildSessionCatchup
 * a stub carrying no `context`, so every delta on that path was empty even once
 * the writes were attributed.
 *
 * Two real members, their own credentials, the real app and a real database.
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 \
 *     tests/integration/hosted-team-context-loop.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  const { key, prefix, hash } = generateApiKey();
  const expiresAt = new Date(Date.now() + 86400000).toISOString();
  await db.query(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, plan, plan, 'active'],
    orgId,
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId,
  );
  await db.query(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, `${label} key`, userId, orgId, 'production', expiresAt, ['context:read', 'context:write']],
    orgId,
  );
  return { label, orgId, userId, email, apiKey: key };
}

async function cleanup(people) {
  for (const person of people) {
    for (const table of ['context_graph_edges', 'context_graph_nodes', 'context_graph_evidence', 'context_graph_embeddings']) {
      await db.query(`DELETE FROM ${table} WHERE owner_key = $1`, [person.orgId], 'org-system').catch(() => {});
    }
    await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_project_share_sections WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM workspace_invites WHERE owner_key = $1', [person.orgId], 'org-system').catch(() => {});
    await db.query('DELETE FROM product_events WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM api_keys WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM users WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
    await db.query('DELETE FROM organizations WHERE org_id = $1', [person.orgId], person.orgId).catch(() => {});
  }
}

function as(req, person, workspaceKey) {
  const r = req.set('X-Api-Key', person.apiKey);
  return workspaceKey ? r.set('x-deerdawn-workspace', workspaceKey) : r;
}

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (name, args = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(line ? line.slice(6) : res.text);
}

async function hosted(person, workspaceKey, name, args) {
  const res = await as(request(httpServer).post('/mcp').set(MCP_HEADERS), person, workspaceKey).send(rpc(name, args));
  assert.equal(res.status, 200, res.text);
  return parseRpc(res);
}

const textOf = (payload) => payload.result?.content?.[0]?.text || '';

// Read the stored context through the store, which decrypts it. A raw
// `SELECT context` returns ciphertext whenever ENCRYPTION_MASTER_KEY is set
// (as it is in production and in infra/docker-compose.yml), and every
// "not stored at all" failure below was that, not a missing write.
async function readStoredContext(projectId) {
  const owner = await db.query(
    'SELECT owner_key FROM context_projects WHERE project_id = $1',
    [projectId],
    'org-system',
  );
  const ownerKey = owner.rows[0]?.owner_key;
  if (!ownerKey) return {};
  const project = await store.getProject(ownerKey, projectId);
  const context = project?.context;
  return (typeof context === 'string' ? JSON.parse(context) : context) || {};
}

async function storedDecisions(projectId) {
  return (await readStoredContext(projectId)).recent_decisions || [];
}

/** Two people in one workspace, one shared project, nothing written yet. */
async function sharedWorkspace() {
  const sarah = await makePerson('sarah', { plan: 'developer_pro' });
  const marcus = await makePerson('marcus');
  const team = sarah.orgId;
  await workspace.addMember(team, sarah.userId, { role: 'owner' });

  const created = await as(request(httpServer).post('/api/v1/context/projects'), sarah)
    .send({ project_name: `Payments API ${uuidv4().slice(0, 6)}`, description: 'team work', goals: [] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const sharedId = created.body.project?.project_id || created.body.project_id;

  const invite = await workspace.createInvite(team, marcus.email, { role: 'member', invitedBy: sarah.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: marcus.userId, email: marcus.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
  await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [sharedId, 'shared'], 'org-system');

  return { sarah, marcus, team, sharedId };
}

// team_context_received is emitted from emitSessionEvents, which runs in a
// setImmediate so instrumentation never sits on the request path. So the reply
// can arrive before the row does, and asserting straight off the response is a
// race. Poll instead of sleeping a guessed interval.
async function waitForTeamEvents(team, userId, want) {
  for (let i = 0; i < 40; i += 1) {
    if (await teamEventCount(team, userId) >= want) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return teamEventCount(team, userId);
}

async function teamEventCount(team, userId) {
  const res = await db.query(
    `SELECT COUNT(*)::int AS n FROM product_events
      WHERE org_id = $1 AND user_id = $2 AND event_name = 'team_context_received'`,
    [team, userId],
    team,
  );
  return res.rows[0]?.n || 0;
}

test('a decision written through manage_memory carries its author', async () => {
  const fx = await sharedWorkspace();
  try {
    const NOTE = `We use Redis for the session cache. DEC-${uuidv4().slice(0, 8)}`;
    const write = await hosted(fx.sarah, null, 'manage_memory', {
      action: 'update', project_id: fx.sharedId, summary: NOTE,
    });
    assert.ok(!write.error, JSON.stringify(write.error));
    assert.equal(write.result?.structuredContent?.stored, true, textOf(write));

    const decisions = await storedDecisions(fx.sharedId);
    const mine = decisions.find((d) => String(d.summary || '').includes(NOTE.slice(-12)));
    assert.ok(mine, `the decision was not stored at all: ${JSON.stringify(decisions)}`);
    assert.equal(
      mine.contributed_by,
      fx.sarah.userId,
      'THE BUG: a tool-written decision is stored with no author, so no teammate can ever be told who decided it',
    );
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('a teammate\'s next hosted start_session opens with what the other person recorded', async () => {
  const fx = await sharedWorkspace();
  try {
    const NOTE = `Retries are capped at three attempts. DEC-${uuidv4().slice(0, 8)}`;
    await hosted(fx.sarah, null, 'manage_memory', { action: 'update', project_id: fx.sharedId, summary: NOTE });

    const opened = await hosted(fx.marcus, fx.team, 'start_session', {});
    assert.ok(!opened.error, JSON.stringify(opened.error));
    const text = textOf(opened);
    assert.ok(
      text.includes(NOTE.slice(-12)),
      `THE BUG: the teammate's brief carries no team block. Got: ${text.slice(0, 600)}`,
    );
    assert.ok(
      text.includes(fx.sarah.email),
      `the team block must NAME the colleague from the roster. Got: ${text.slice(0, 600)}`,
    );

    // The activation event, once per person per workspace and no more. A second
    // start_session still builds the catch-up; the event must not fire twice.
    assert.equal(await waitForTeamEvents(fx.team, fx.marcus.userId, 1), 1, 'team_context_received did not fire');
    await hosted(fx.marcus, fx.team, 'start_session', {});
    assert.equal(await waitForTeamEvents(fx.team, fx.marcus.userId, 2), 1, 'team_context_received fired more than once');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

// The same activation for an invitee who already has a personal project: the
// shared project is a READ for them (their id-less saves are refused), and a
// read is exactly what the team block and team_context_received ride on.
test('an invitee with a personal project gets the team block and team_context_received too', async () => {
  const fx = await sharedWorkspace();
  try {
    const own = await as(request(httpServer).post('/api/v1/context/projects'), fx.marcus)
      .send({ project_name: `Marcus Side ${uuidv4().slice(0, 6)}`, description: 'mine', goals: [] });
    assert.equal(own.status, 201, JSON.stringify(own.body));

    const NOTE = `Webhooks are retried with backoff. DEC-${uuidv4().slice(0, 8)}`;
    await hosted(fx.sarah, null, 'manage_memory', { action: 'update', project_id: fx.sharedId, summary: NOTE });

    const opened = await hosted(fx.marcus, fx.team, 'start_session', {});
    assert.ok(!opened.error, JSON.stringify(opened.error));
    const text = textOf(opened);
    assert.match(text, /(^|\n)Resuming /, `the invitee with a personal project got no shared brief. Got: ${text.slice(0, 600)}`);
    assert.ok(text.includes(NOTE.slice(-12)), `and no team block. Got: ${text.slice(0, 600)}`);
    assert.equal(await waitForTeamEvents(fx.team, fx.marcus.userId, 1), 1, 'team_context_received did not fire for them');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('hosted start_session with a project_id still builds the catch-up', async () => {
  const fx = await sharedWorkspace();
  try {
    const NOTE = `The queue drains oldest first. DEC-${uuidv4().slice(0, 8)}`;
    await hosted(fx.sarah, null, 'manage_memory', { action: 'update', project_id: fx.sharedId, summary: NOTE });

    const opened = await hosted(fx.marcus, fx.team, 'start_session', { project_id: fx.sharedId });
    assert.ok(!opened.error, JSON.stringify(opened.error));
    const text = textOf(opened);
    // Asserted on the CATCH-UP block, not on the note: the brief body renders
    // recent decisions too, so a text search for the note alone passes even when
    // the catch-up is entirely empty.
    assert.match(
      text,
      /a teammate recorded:/,
      `THE BUG: naming the project dropped the catch-up, because the stub passed to buildSessionCatchup carried no context. Got: ${text.slice(0, 600)}`,
    );
    assert.ok(text.includes(`${fx.sarah.email} — decided: `), `the catch-up must name the author. Got: ${text.slice(0, 600)}`);
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('two members taking opposite positions surface as a candidate disagreement', async () => {
  const fx = await sharedWorkspace();
  try {
    await hosted(fx.sarah, null, 'manage_memory', {
      action: 'update', project_id: fx.sharedId, summary: 'We use Redis for the session cache.',
    });
    await hosted(fx.marcus, fx.team, 'manage_memory', {
      action: 'update', project_id: fx.sharedId, summary: 'We do not use Redis for the session cache.',
    });

    const decisions = await storedDecisions(fx.sharedId);
    const authors = new Set(decisions.map((d) => d.contributed_by).filter(Boolean));
    assert.equal(authors.size, 2, `both members' decisions must be attributed: ${JSON.stringify(decisions)}`);

    const opened = await hosted(fx.sarah, null, 'start_session', { project_id: fx.sharedId });
    const text = textOf(opened);
    assert.ok(
      text.includes('Possible disagreement'),
      `THE BUG: unattributed decisions are filtered out before the detector ever compares them. Got: ${text.slice(0, 600)}`,
    );
    assert.ok(text.includes(fx.marcus.email), 'the disagreement block must name the other author');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('the REST explicit path the local server uses attributes its decision too', async () => {
  // packages/mcp-server's update_context posts to POST /extraction with
  // explicit:true, which lands in the same recordExplicitUpdate. Asserted rather
  // than assumed, because "fixed on one dispatcher only" is this repo's most
  // repeated defect and the two are hand-maintained duplicates.
  const fx = await sharedWorkspace();
  try {
    const NOTE = `Local server wrote this. DEC-${uuidv4().slice(0, 8)}`;
    const res = await as(request(httpServer).post('/api/v1/context/extraction'), fx.sarah).send({
      session_id: `mcp-local-${uuidv4()}`,
      tool: 'claude_code',
      project_id: fx.sharedId,
      explicit: true,
      chunks: [{ role: 'assistant', text: NOTE }],
    });
    assert.equal(res.status, 202, res.text);

    const decisions = await storedDecisions(fx.sharedId);
    const mine = decisions.find((d) => String(d.summary || '').includes(NOTE.slice(-12)));
    assert.ok(mine, `not stored at all: ${JSON.stringify(decisions)}`);
    assert.equal(mine.contributed_by, fx.sarah.userId, 'the local dispatcher\'s writes must carry an author too');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

async function storedContext(projectId) {
  return readStoredContext(projectId);
}

/**
 * The other half of the same loop: SHIPPED and LANDMINES.
 *
 * A decision is one of three things a teammate records, and it was the only one
 * that could reach anybody. Shipped entries, landmines and debugging notes had
 * no contributed_by in their shared-context schemas, so a stamp on them was
 * parsed away before it ever reached the row — and buildTeamDelta, which reads
 * shipped and landmines beside decisions, had nothing to name.
 */

const SHIPPED_WORK = 'Wire the per-seat counter';

/** Sarah finishes a task and records a landmine, both through tools. */
async function sarahShipsAndWarns(fx, landmine) {
  // finish_task on the local server posts task_completed here, and that is the
  // deterministic SHIPPED append (appendShipped) — never an LLM inference.
  const done = await as(request(httpServer).post('/api/v1/context/events'), fx.sarah).send({
    event_type: 'task_completed',
    project_id: fx.sharedId,
    summary: SHIPPED_WORK,
    metadata: { surface: 'claude_code' },
  });
  assert.equal(done.status, 202, done.text);

  // The landmine arrives on the explicit extraction path — the one the local
  // server writes through — rather than through a hosted tool, because nothing
  // in tools/list writes a landmine directly. Both dispatchers land in
  // applyExtraction, so this covers the write either of them makes.
  const res = await as(request(httpServer).post('/api/v1/context/extraction'), fx.sarah).send({
    session_id: `mcp-local-${uuidv4()}`,
    tool: 'claude_code',
    project_id: fx.sharedId,
    chunks: [{ role: 'assistant', text: landmine }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: fx.sharedId, project_name: 'Payments API', reason: 'same repo' },
      delta: { landmines: [{ summary: landmine, added_at: new Date().toISOString() }] },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  assert.ok(res.status === 200 || res.status === 202, res.text);
}

test('a shipped item and a landmine written through tools carry their author', async () => {
  const fx = await sharedWorkspace();
  try {
    const LANDMINE = `Rotating the master key orphans every DEK. LM-${uuidv4().slice(0, 8)}`;
    await sarahShipsAndWarns(fx, LANDMINE);

    const context = await storedContext(fx.sharedId);
    const shipped = (context.shipped || []).find((s) => String(s.summary || '').includes(SHIPPED_WORK));
    assert.ok(shipped, `the completed card was never recorded as shipped: ${JSON.stringify(context.shipped)}`);
    assert.equal(
      shipped.contributed_by,
      fx.sarah.userId,
      'THE BUG: a tool-written shipped entry is stored with no author, so no teammate is ever told who shipped it',
    );

    const landmine = (context.landmines || []).find((l) => String(l.summary || '').includes(LANDMINE.slice(-11)));
    assert.ok(landmine, `the landmine was not stored at all: ${JSON.stringify(context.landmines)}`);
    assert.equal(landmine.contributed_by, fx.sarah.userId, 'a landmine must name whoever hit it');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('a debugging finding recorded through a tool carries its author', async () => {
  // record_finding is the one of these three with its own route
  // (POST /projects/:id/debug-findings), shared by both dispatchers. Notes are
  // deliberately NOT a catch-up section — whether a teammate's findings belong
  // in somebody else's brief is a product question. The data is attributed
  // either way, because an unattributed note cannot be chased.
  const fx = await sharedWorkspace();
  try {
    const NOTE = `The consent redirect drops the code query parameter. FIND-${uuidv4().slice(0, 8)}`;
    const wrote = await hosted(fx.sarah, null, 'manage_memory', {
      action: 'record_finding', project_id: fx.sharedId, summary: NOTE,
    });
    assert.ok(!wrote.error, JSON.stringify(wrote.error));

    const context = await storedContext(fx.sharedId);
    const note = (context.debugging_notes || []).find((n) => String(n.summary || '').includes(NOTE.slice(-13)));
    assert.ok(note, `not stored at all: ${JSON.stringify(context.debugging_notes)}`);
    assert.equal(note.contributed_by, fx.sarah.userId, 'a finding must name whoever found it');
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('the teammate\'s catch-up names who shipped it and who hit the landmine', async () => {
  const fx = await sharedWorkspace();
  try {
    const LANDMINE = `Rotating the master key orphans every DEK. LM-${uuidv4().slice(0, 8)}`;
    await sarahShipsAndWarns(fx, LANDMINE);

    // The catch-up reads the SHARED view, and landmines/shipped are not in
    // DEFAULT_SHARED_SECTIONS — so the policy has to grant them before a
    // teammate can be shown either. Widening that default is a product decision
    // and not this fix: what is asserted here is that once the section travels,
    // the entry in it names its author instead of arriving anonymous.
    for (const section of ['current_task', 'current_status', 'recent_decisions', 'todo_items', 'landmines', 'shipped']) {
      await db.query(
        `INSERT INTO context_project_share_sections (project_id, section_key, can_view, can_edit)
         VALUES ($1, $2, true, true) ON CONFLICT (project_id, section_key) DO NOTHING`,
        [fx.sharedId, section],
        'org-system',
      );
    }

    const opened = await hosted(fx.marcus, fx.team, 'start_session', { project_id: fx.sharedId });
    assert.ok(!opened.error, JSON.stringify(opened.error));
    const text = textOf(opened);
    assert.ok(
      text.includes(`${fx.sarah.email} — shipped: ${SHIPPED_WORK}`),
      `THE BUG: the catch-up cannot name who shipped it. Got: ${text.slice(0, 900)}`,
    );
    assert.ok(
      text.includes(`${fx.sarah.email} — landmine: `) && text.includes(LANDMINE.slice(-11)),
      `the catch-up must name who recorded the landmine. Got: ${text.slice(0, 900)}`,
    );
  } finally {
    await cleanup([fx.sarah, fx.marcus]);
  }
});

test('a solo workspace still says nothing about itself', async () => {
  // Every entry is the reader's own, so naming them would be noise — and a solo
  // account must not start paying for the roster query either.
  const solo = await makePerson('solo');
  try {
    const created = await as(request(httpServer).post('/api/v1/context/projects'), solo)
      .send({ project_name: `Solo API ${uuidv4().slice(0, 6)}`, description: 'my work', goals: [] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const projectId = created.body.project?.project_id || created.body.project_id;

    const done = await as(request(httpServer).post('/api/v1/context/events'), solo).send({
      event_type: 'task_completed',
      project_id: projectId,
      summary: SHIPPED_WORK,
      metadata: { surface: 'claude_code' },
    });
    assert.equal(done.status, 202, done.text);

    const opened = await hosted(solo, null, 'start_session', { project_id: projectId });
    const text = textOf(opened);
    assert.ok(!/teammate/.test(text), `a solo brief must not mention teammates. Got: ${text.slice(0, 600)}`);
    assert.ok(!text.includes(solo.email), `a solo brief must not name its only reader. Got: ${text.slice(0, 600)}`);
  } finally {
    await cleanup([solo]);
  }
});
