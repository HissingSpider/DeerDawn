/**
 * JOURNEY R3 — RAW CONVERSATION TEXT IS PROCESSED, NEVER KEPT.
 *
 * Three public pages say so: /pricing ("Raw conversation text is processed to
 * build the brief and then discarded, never retained"), /security ("Raw message
 * content is discarded after extraction") and the homepage ("No raw
 * transcripts"). The graph write path did not agree: every capture stored the
 * first 400 characters of the raw `[user] ... [assistant] ...` text, once per
 * entity, in plaintext, in context_graph_evidence.excerpt (journey scan round 1,
 * BLOCKED 1).
 *
 * The owner's decision: stop storing it, and keep what the evidence row is FOR
 * — why an entity exists and where it came from — as a line the product writes
 * from structured facts (the entity's type and title, the project it was
 * recorded in, the brief section it came from). The row's own tool and
 * created_at still say which tool and when.
 *
 * The captures go through the real API path a person's tools use:
 *   - the end-of-session flush exactly as the Stop hook posts it, with the
 *     extraction fallback the local stack runs (there is no model key here);
 *   - the same flush with the delta a live model returns handed in for
 *     runExtraction (the production path; no model is called);
 *   - an import through /seed, the dashboard's "Add from Claude".
 * Production's model-backed extraction itself cannot be driven from here.
 *
 * The check is not "the excerpt column looks different". Every row of every
 * table in the database is cast to text and searched for marker strings that
 * sat inside the person's and the assistant's words. Extraction may reuse a
 * word of the conversation in a title — that is what a brief is — so the
 * markers are long random tokens inside ordinary sentences, which neither the
 * fallback nor the handed-in model answer copies.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r3-raw-conversation-text.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');
const extractionService = require('../../src/services/extractionService');
const { renderContextExportMarkdown } = require('../../src/services/contextExportMarkdown');
const { redactSecrets } = require('../../src/utils/secretRedaction');

const q = (sql, params) => db.query(sql, params, 'org-system');

// Capital letters only: no secret pattern matches them (checked below), and
// nothing re-cases or splits them.
const token = () => [...crypto.randomBytes(14)].map((b) => String.fromCharCode(65 + (b % 26))).join('');
const MARK = {
  hookUser: `QZUSER${token()}`,
  hookAssistant: `QZASST${token()}`,
  modelUser: `QZUSER${token()}`,
  modelAssistant: `QZASST${token()}`,
  seedUser: `QZUSER${token()}`,
  seedAssistant: `QZASST${token()}`,
};

async function makePerson(label) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status) VALUES ($1, $2, $3, $4, $5)',
    [orgId, `${label} workspace`, 'free', 'free', 'active'],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', userId, orgId, 'production',
      new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  const actor = { type: 'user', id: userId, org_id: orgId, workspace_key: orgId, role: 'admin' };
  return { orgId, userId, email, key, actor };
}

const asKey = (method, path, key) => request(httpServer)[method](path).set('X-Api-Key', key);

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
async function mcp(key, name, args) {
  const res = await request(httpServer).post('/mcp').set(MCP_HEADERS).set('X-Api-Key', key)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  assert.equal(res.status, 200, res.text);
  let body = res.body && Object.keys(res.body).length ? res.body : null;
  if (!body) {
    const line = String(res.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : res.text);
  }
  return { text: body.result?.content?.[0]?.text || JSON.stringify(body.error || body), isError: body.result?.isError === true || Boolean(body.error) };
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

// EVERY row of EVERY table, as text. `r::text` renders the whole row — text,
// json, arrays, every column — so nothing is missed by guessing which columns
// could hold conversation text. Each row is rendered once and searched for
// every marker, so a database a whole suite has filled stays quick to read.
// Returns { markerName: ['schema.table (rows)', ...] } for markers found.
async function tablesHolding(markers) {
  const tables = (await q(
    `SELECT table_schema, table_name FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
    [],
  )).rows;
  assert.ok(tables.length > 20, `premise: the dump reads the whole schema, found ${tables.length} tables`);
  const names = Object.keys(markers);
  const found = {};
  for (const { table_schema: schema, table_name: table } of tables) {
    const hits = await q(
      `SELECT m.marker, count(*)::int AS n
         FROM (SELECT r::text AS x FROM "${schema.replace(/"/g, '""')}"."${table.replace(/"/g, '""')}" r) s
         CROSS JOIN unnest($1::text[]) AS m(marker)
        WHERE strpos(s.x, m.marker) > 0
        GROUP BY m.marker`,
      [names.map((name) => markers[name])],
    );
    for (const hit of hits.rows) {
      const name = names.find((key) => markers[key] === hit.marker);
      (found[name] = found[name] || []).push(`${schema}.${table} (${hit.n})`);
    }
  }
  return found;
}

const TAG = uuidv4().slice(0, 8);
const PROJECT_NAME = `Harbor Ledger ${TAG}`;
const MODEL_DELTA = {
  current_task: 'Make the export worker drain its retry queue',
  tech_stack: ['Redis'],
  file_structure_summary: ['src/export/worker.js'],
  recent_decisions: [{ summary: 'Cap export retries at five attempts', decided_at: new Date().toISOString() }],
};

// The derived line, as a reader must see it: written from the entity's type,
// its title, the project and the brief section — nothing anybody said.
function expectedLine(node) {
  const where = {
    service: `in ${PROJECT_NAME}'s tech stack`,
    file: `in ${PROJECT_NAME}'s file structure`,
    component: `in ${PROJECT_NAME}'s file structure`,
    task: `as ${PROJECT_NAME}'s current task`,
    decision: `in ${PROJECT_NAME}'s recent decisions`,
  }[node.node_type];
  const label = node.node_type.charAt(0).toUpperCase() + node.node_type.slice(1);
  return `${label} "${node.title}" recorded ${where}.`;
}

let P;
let projectId;
const hookSession = `sess-hook-${uuidv4()}`;
const modelSession = `sess-model-${uuidv4()}`;
let seededProjectId = null;

test.before(async () => {
  P = await makePerson('rawtext');
  const created = await asKey('post', '/api/v1/context/projects', P.key)
    .send({ project_name: PROJECT_NAME, description: 'A ledger service for harbor fees' });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  projectId = created.body.project.project_id;

  // 1. The Stop hook's flush, as it posts it, through the local fallback.
  const flushBody = (sessionId, user, assistant) => ({
    session_id: sessionId,
    tool: 'claude_code',
    chunks: [
      { role: 'user', text: `Can you check why the export stalls when ${user} shows up in the queue again today?` },
      { role: 'assistant', text: `The worker retries forever once ${assistant} is in the payload, so the queue never drains.` },
    ],
    session_context: { cwd: '/tmp/harbor-ledger', conversation_ref: `conv-${TAG}`, host: 'claude_code', surface_type: 'code' },
  });
  // With no model the fallback routes nothing, and an unrouted flush answers
  // project_not_found having stored nothing: that is the local stack's answer.
  const hook = await asKey('post', '/api/v1/context/extraction', P.key).send(flushBody(hookSession, MARK.hookUser, MARK.hookAssistant));
  assert.ok([200, 202, 404].includes(hook.status), `the hook flush is answered: ${hook.status} ${JSON.stringify(hook.body)}`);

  // 2. The same flush in production: the model's answer is handed in.
  const model = await withModelAnswer({
    match_decision: 'matched_existing',
    confidence: 0.92,
    project_candidate: { project_id: projectId, project_name: PROJECT_NAME, reason: 'same repository', score: 0.92 },
    delta: MODEL_DELTA,
    should_create_project: false,
    needs_user_confirmation: false,
    no_material_change: false,
  }, () => asKey('post', '/api/v1/context/extraction', P.key).send(flushBody(modelSession, MARK.modelUser, MARK.modelAssistant)));
  assert.equal(model.status, 202, JSON.stringify(model.body));
  assert.equal(model.body.project?.project_id, projectId, 'the capture landed in the project');

  // 3. An import through /seed, with no model. Round 3 left the fallback that
  // copied the LONGEST user message into the description, so its markers sat
  // elsewhere; round 4 removed that fallback, and the tests at the end of this
  // file put markers in the longest message too.
  const seeded = await asKey('post', '/api/v1/context/seed', P.key).send({
    source: 'claude_export',
    projects: [{
      name: `Tide Tables ${TAG}`,
      conversations: [{
        title: 'tide tables',
        messages: [
          { role: 'user', text: 'I want a small service that reads the harbor tide tables every morning, stores the next week of high and low water, and warns the berth planners when a vessel draft will not clear at low tide.' },
          { role: 'assistant', text: `We can start with a nightly job; the parser should skip the ${MARK.seedAssistant} header rows.` },
          { role: 'user', text: `Good, and note the feed sometimes sends ${MARK.seedUser} instead of a date.` },
        ],
      }],
    }],
  });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  seededProjectId = (await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND project_name = $2', [P.orgId, `Tide Tables ${TAG}`])).rows[0]?.project_id || null;
});

test('premise: the markers survive secret redaction, so finding none is not redaction at work', () => {
  for (const marker of Object.values(MARK)) {
    assert.ok(redactSecrets(`the value ${marker} here`).includes(marker), `${marker} would have been redacted; pick another`);
  }
});

test('after a capture, no table in the database holds any of the person\'s or the assistant\'s words', async () => {
  const evidence = (await q('SELECT count(*)::int AS n FROM context_graph_evidence WHERE owner_key = $1 AND project_id = $2', [P.orgId, projectId])).rows[0].n;
  assert.ok(evidence >= 4, `premise: the model-backed capture wrote evidence (one row per entity), found ${evidence}`);
  const found = await tablesHolding(MARK);
  assert.deepEqual(found, {}, `raw conversation text is stored: ${JSON.stringify(found)}`);

  // And not in the brief either, which is encrypted at rest and so invisible to
  // the dump above: read it back decrypted.
  for (const id of [projectId, seededProjectId].filter(Boolean)) {
    const brief = JSON.stringify((await store.getProject(P.orgId, id))?.context || {});
    for (const marker of Object.values(MARK)) assert.ok(!brief.includes(marker), `the brief of ${id} carries ${marker}`);
  }
});

test('every entity the capture recorded still has its evidence row, carrying the derived line', async () => {
  const graph = await asKey('get', `/api/v1/context/graph/projects/${projectId}`, P.key);
  assert.equal(graph.status, 200, JSON.stringify(graph.body));
  const entities = graph.body.graph.nodes.filter((node) => ['service', 'file', 'task', 'decision'].includes(node.node_type));
  assert.deepEqual(entities.map((node) => node.node_type).sort(), ['decision', 'file', 'service', 'task'], 'premise: the four derived entities exist');

  for (const node of entities) {
    const rows = (await q(
      'SELECT excerpt, excerpt_kind, tool, session_id FROM context_graph_evidence WHERE owner_key = $1 AND node_id = $2 AND project_id = $3',
      [P.orgId, node.node_id, projectId],
    )).rows;
    const fromModel = rows.filter((row) => row.session_id === modelSession);
    assert.equal(fromModel.length, 1, `one evidence row for ${node.node_type} from the capture: ${JSON.stringify(rows)}`);
    assert.equal(fromModel[0].excerpt, expectedLine(node), `${node.node_type}'s evidence says why it exists, in the product's words`);
    assert.equal(fromModel[0].excerpt_kind, 'derived', 'and is marked as written by the new path');
    assert.equal(fromModel[0].tool, 'claude_code', 'where it came from stays on the row');
  }
});

test('the capture\'s own reply carries the derived lines, not the conversation', async () => {
  const reply = await withModelAnswer({
    match_decision: 'matched_existing',
    confidence: 0.92,
    project_candidate: { project_id: projectId, project_name: PROJECT_NAME, reason: 'same repository', score: 0.92 },
    delta: { ...MODEL_DELTA, tech_stack: ['Redis', 'Postgres'] },
    should_create_project: false,
    needs_user_confirmation: false,
    no_material_change: false,
  }, () => asKey('post', '/api/v1/context/extraction', P.key).send({
    session_id: modelSession,
    tool: 'claude_code',
    chunks: [
      { role: 'user', text: `Also add the ${MARK.modelUser} store next to the queue please.` },
      { role: 'assistant', text: `Added; ${MARK.modelAssistant} now sits beside Redis.` },
    ],
  }));
  assert.equal(reply.status, 202, JSON.stringify(reply.body));
  const text = JSON.stringify(reply.body);
  for (const marker of Object.values(MARK)) assert.ok(!text.includes(marker), `the reply relays ${marker}`);
  const excerpts = (reply.body.graph?.evidence || []).map((item) => item.excerpt);
  assert.ok(excerpts.length > 0, 'premise: the reply carries evidence');
  for (const excerpt of excerpts) assert.match(excerpt, /^(Service|File|Task|Decision) ".*" recorded (in|as) .*\.$/, excerpt);
});

test('every reader of the evidence returns without error and shows the derived line', async () => {
  const lines = new Set((await q(
    'SELECT excerpt FROM context_graph_evidence WHERE owner_key = $1 AND project_id = $2 AND session_id = $3',
    [P.orgId, projectId, modelSession],
  )).rows.map((row) => row.excerpt));
  assert.ok(lines.size >= 4, 'premise: derived lines to look for');
  const noMarkers = (label, text) => {
    for (const marker of Object.values(MARK)) assert.ok(!text.includes(marker), `${label} shows ${marker}`);
  };

  // The dashboard's Memory page and inspect_context_graph read these three.
  const projectGraph = await asKey('get', `/api/v1/context/graph/projects/${projectId}`, P.key);
  assert.equal(projectGraph.status, 200);
  const shown = projectGraph.body.graph.evidence.map((item) => item.excerpt);
  assert.ok(shown.length > 0 && shown.every((excerpt) => lines.has(excerpt)), `project graph: ${JSON.stringify(shown)}`);
  noMarkers('the project graph', JSON.stringify(projectGraph.body));

  const decision = projectGraph.body.graph.nodes.find((node) => node.node_type === 'decision');
  const nodeGraph = await asKey('get', `/api/v1/context/graph/nodes/${decision.node_id}`, P.key);
  assert.equal(nodeGraph.status, 200);
  assert.ok(nodeGraph.body.graph.evidence.some((item) => item.excerpt === expectedLine(decision)), JSON.stringify(nodeGraph.body.graph.evidence));
  noMarkers('the node graph', JSON.stringify(nodeGraph.body));

  const sessionGraph = await asKey('get', `/api/v1/context/graph/sessions/${modelSession}`, P.key);
  assert.equal(sessionGraph.status, 200, JSON.stringify(sessionGraph.body));
  assert.ok(sessionGraph.body.graph.evidence.every((item) => lines.has(item.excerpt) || !String(item.excerpt).startsWith('[')), JSON.stringify(sessionGraph.body.graph.evidence));
  noMarkers('the session graph', JSON.stringify(sessionGraph.body));

  // The vault export: a list line per source, not a quotation.
  const vault = await asKey('get', '/api/v1/context/graph/export', P.key);
  assert.equal(vault.status, 200);
  const decisionFile = vault.body.files.find((file) => file.content.includes(`# ${decision.title}`));
  assert.ok(decisionFile, 'the decision has a vault file');
  const date = new Date().toISOString().slice(0, 10);
  assert.ok(decisionFile.content.includes(`## Evidence\n- ${expectedLine(decision)} (claude_code, ${date})`), decisionFile.content);
  assert.ok(!/^> "/m.test(decisionFile.content), 'nothing is presented as a quotation');
  noMarkers('the vault export', JSON.stringify(vault.body));

  // The export (JSON and Markdown), which the account-deletion email attaches.
  const bundle = await service.exportContext(P.actor);
  noMarkers('the JSON export', JSON.stringify(bundle));
  noMarkers('the Markdown export', renderContextExportMarkdown(bundle));

  // Trails: the archive and its redaction preview.
  const trail = await asKey('get', `/api/v1/context/projects/${projectId}/trail`, P.key);
  assert.equal(trail.status, 200, JSON.stringify(trail.body));
  noMarkers('the Trail', JSON.stringify(trail.body));
  const preview = await asKey('get', `/api/v1/context/projects/${projectId}/trail/preview`, P.key);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  noMarkers('the Trail preview', JSON.stringify(preview.body));

  // Hosted recall, every kind of memory it serves.
  for (const action of ['context', 'entities', 'overview', 'next', 'portfolio', 'map', 'paths', 'projects']) {
    const reply = await mcp(P.key, 'recall', { action, project_id: projectId, ...(action === 'paths' ? { query: 'export worker' } : {}) });
    assert.equal(reply.isError, false, `recall ${action}: ${reply.text}`);
    noMarkers(`recall ${action}`, reply.text);
  }
  const search = await mcp(P.key, 'recall', { action: 'search', query: 'export retries' });
  assert.equal(search.isError, false, search.text);
  noMarkers('recall search', search.text);
});

// ─── JOURNEY R4: THE IMPORT FALLBACK STORES NOTHING FROM THE CONVERSATION ────
//
// On /seed, when no model was configured or the model call failed, the import
// copied the person's LONGEST message, up to 280 characters, into the brief's
// description and from there into a plaintext graph node (round 3, BLOCKED 25).
// The owner's decision: if no model answers, nothing from the conversation is
// saved, and the person is told it could not be processed and to try again.
// What carries no conversation text is kept: the project, under the name the
// person gave.
//
// Each import below puts its marker in the longest user message, the one the
// old fallback copied, and the whole database is searched for it.

const R4 = {
  noModel: `QZLONG${token()}`,
  failedCall: `QZLONG${token()}`,
  emptyAnswer: `QZLONG${token()}`,
};

function importBody(name, marker) {
  return {
    source: 'chatgpt_export',
    projects: [{
      name,
      conversations: [{
        title: 'berth planning',
        messages: [
          { role: 'user', text: `I want the berth planner to flag any vessel whose draft will not clear the ${marker} channel at low water, and to send the harbour master a summary every morning before the first pilot boards.` },
          { role: 'assistant', text: 'We can read the tide tables nightly and compare each booked draft against the forecast low water.' },
          { role: 'user', text: 'Yes, and keep the summary short enough to read on a phone at the quay.' },
        ],
      }],
    }],
  };
}

async function withoutModelKeys(run) {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// A model is "configured" (a key is set) and every call to it is answered here,
// by the axios the extraction service calls: no request leaves the machine.
async function withModelCall(answer, run) {
  const axios = require('axios');
  const original = axios.post;
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.OPENAI_API_KEY = 'test-not-a-key';
  process.env.ANTHROPIC_API_KEY = 'test-not-a-key';
  let calls = 0;
  axios.post = async () => {
    calls += 1;
    return answer();
  };
  try {
    return { result: await run(), calls: () => calls };
  } finally {
    axios.post = original;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function projectNamed(name) {
  return (await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND project_name = $2', [P.orgId, name])).rows[0]?.project_id || null;
}

async function assertNothingKept(marker, projectId) {
  const found = await tablesHolding({ marker });
  assert.deepEqual(found, {}, `the import kept conversation text: ${JSON.stringify(found)}`);
  if (projectId) {
    const brief = JSON.stringify((await store.getProject(P.orgId, projectId))?.context || {});
    assert.ok(!brief.includes(marker), `the decrypted brief carries ${marker}: ${brief}`);
  }
}

test('R4: an import with no model configured saves nothing from the conversation and says it was not processed', async () => {
  const name = `Quay Draughts ${TAG}`;
  const res = await withoutModelKeys(() => asKey('post', '/api/v1/context/seed', P.key).send(importBody(name, R4.noModel)));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const projectId = await projectNamed(name);

  // Nothing of the conversation, in any column of any table, or in the brief.
  await assertNothingKept(R4.noModel, projectId);

  // The reply: not imported, not processed, by the name it was sent under.
  assert.equal(res.body.projects_created, 0, `a refused import must not count as created: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.projects_not_processed, 1, JSON.stringify(res.body));
  assert.deepEqual(res.body.not_processed, [{ project: name, project_id: projectId }]);
  assert.ok(!JSON.stringify(res.body).includes(R4.noModel), 'the reply relays the conversation');

  // What is kept carries no conversation text: the project, under its name,
  // with an empty description.
  assert.ok(projectId, 'the project is kept under the name the person gave');
  const project = await store.getProject(P.orgId, projectId);
  assert.equal(String(project.context?.description || ''), '', 'nothing from the conversation became the description');
});

test('R4: an import whose model call fails saves nothing from the conversation and says it was not processed', async () => {
  const name = `Pilot Boarding ${TAG}`;
  const { result: res, calls } = await withModelCall(
    () => { throw new Error('socket hang up'); },
    () => asKey('post', '/api/v1/context/seed', P.key).send(importBody(name, R4.failedCall)),
  );
  assert.ok(calls() >= 1, 'premise: the model was called, and failed');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  await assertNothingKept(R4.failedCall, await projectNamed(name));
  assert.equal(res.body.projects_created, 0, JSON.stringify(res.body));
  assert.equal(res.body.projects_not_processed, 1, JSON.stringify(res.body));
  assert.equal(res.body.not_processed[0].project, name);
});

// The decision reaches only "no model answers". A model that answers with an
// empty delta is created as it was before this change (the schema defaults the
// delta's resolution lists, so the old fallback never ran for it): this pins
// that it, too, keeps nothing of the conversation.
test('R4: an import the model answers with nothing keeps nothing of the conversation', async () => {
  const name = `Low Water ${TAG}`;
  const empty = {
    match_decision: 'new_project', confidence: 0.4, delta: {},
    should_create_project: true, needs_user_confirmation: false, no_material_change: true,
  };
  const { result: res, calls } = await withModelCall(
    () => ({ data: { choices: [{ message: { content: JSON.stringify(empty) } }], content: [{ text: JSON.stringify(empty) }] } }),
    () => asKey('post', '/api/v1/context/seed', P.key).send(importBody(name, R4.emptyAnswer)),
  );
  assert.equal(calls(), 1, 'premise: the model answered once');
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.projects_not_processed, 0, 'the model answered, so the import was processed');
  await assertNothingKept(R4.emptyAnswer, await projectNamed(name));
});

test('R4: an import the model does process still lands, from the model\'s words', async () => {
  const name = `Harbour Summary ${TAG}`;
  const marker = `QZLONG${token()}`;
  const answer = {
    match_decision: 'new_project', confidence: 0.9,
    delta: { description: 'A morning summary of vessels that will not clear the channel at low water', current_task: 'Compare booked drafts against the forecast low water' },
    should_create_project: true, needs_user_confirmation: false, no_material_change: false,
  };
  const { result: res } = await withModelCall(
    () => ({ data: { choices: [{ message: { content: JSON.stringify(answer) } }], content: [{ text: JSON.stringify(answer) }] } }),
    () => asKey('post', '/api/v1/context/seed', P.key).send(importBody(name, marker)),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.projects_created, 1, JSON.stringify(res.body));
  assert.equal(res.body.projects_not_processed, 0, JSON.stringify(res.body));
  const projectId = await projectNamed(name);
  assert.ok(projectId, 'the processed import created its project');
  const project = await store.getProject(P.orgId, projectId);
  assert.equal(project.context?.description, answer.delta.description, 'the brief holds what the model wrote');
  await assertNothingKept(marker, projectId);
});

test('R4: a retry after a refused import fills the same project, not a second one', async () => {
  const name = `Quay Draughts ${TAG}`;
  const kept = await projectNamed(name);
  assert.ok(kept, 'premise: the refused import above kept the project');
  const answer = {
    match_decision: 'new_project', confidence: 0.9,
    delta: { description: 'Flags vessels whose draft will not clear the channel at low water' },
    should_create_project: true, needs_user_confirmation: false, no_material_change: false,
  };
  const { result: res } = await withModelCall(
    () => ({ data: { choices: [{ message: { content: JSON.stringify(answer) } }], content: [{ text: JSON.stringify(answer) }] } }),
    () => asKey('post', '/api/v1/context/seed', P.key).send(importBody(name, `QZLONG${token()}`)),
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.projects_created, 1, JSON.stringify(res.body));
  const rows = (await q('SELECT project_id FROM context_projects WHERE owner_key = $1 AND project_name = $2', [P.orgId, name])).rows;
  assert.deepEqual(rows.map((row) => row.project_id), [kept], 'one project under that name');
  assert.equal((await store.getProject(P.orgId, kept)).context?.description, answer.delta.description);
});
