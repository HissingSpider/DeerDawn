/**
 * WHAT update_context AND EXTRACTION OWE THE CALLER, PROVEN BY READING IT BACK.
 *
 * Every test here writes a unique marker and then looks for it — in the stored
 * row, and through the hosted `recall` tool, which is how a real session would
 * find it again. None of them assert on source text or on the tool's own
 * success string: both have passed over each of these defects before.
 *
 * The defects (all live on origin/main c9bf3afe):
 *
 *   1. One new goal deleted the other goals. sanitizeExtraction strips items
 *      that are already stored, and the merge then REPLACED the list with what
 *      was left.
 *   2. Extraction overwrote a task somebody set on purpose. The model was never
 *      shown the stored context, so every chunk looked like the first word on a
 *      new project, and the merge is a spread.
 *   3. The caller's words were lost while the reply said `stored: true`. The
 *      verbatim floor only ran when last_updated had not moved, and a delta of
 *      {category:'coding'} moved it.
 *   4. The rate guard was keyed by project, so a DIFFERENT chunk inside 30s was
 *      answered with the previous chunk's delta, and a cached "trivial" verdict
 *      was inherited by the real update that followed it.
 *
 * Needs the DB harness:
 *   bash scripts/run-db-test.sh node --test tests/integration/explicit-update-contract.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');

const Module = require('module');
const realAxios = require('axios');
const originalLoad = Module._load;

const savedApiKey = process.env.OPENAI_API_KEY;
process.env.OPENAI_API_KEY = 'sk-test-explicit-update-stub';

// Set by each test. null => the provider errors.
let providerReply = null;
const providerRequests = [];

const EXTRACTION_PATHS = ['/v1/chat/completions', '/v1/messages'];
const isExtractionUrl = (url) => typeof url === 'string' && EXTRACTION_PATHS.some((p) => url.endsWith(p));

const axiosStub = {
  ...realAxios,
  post: async (url, body, config) => {
    if (isExtractionUrl(url)) {
      providerRequests.push(body);
      if (!providerReply) throw new Error('provider unavailable (test stub)');
      return providerReply(body);
    }
    return realAxios.post(url, body, config);
  },
};

Module._load = function (request, _parent, _isMain) {
  if (request === 'axios') return axiosStub;
  return originalLoad.apply(this, arguments);
};

const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');
const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const { hostedSessionId } = require('../../src/services/hostedSessionIdentity');
const { hashPassword, generateApiKey } = require('../../src/utils/security');

const httpServer = app.listen(0);
test.after(() => {
  Module._load = originalLoad;
  if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedApiKey;
  return new Promise((resolve) => httpServer.close(resolve));
});

const MCP_HEADERS = { Accept: 'application/json, text/event-stream' };
const rpc = (method, params = {}, id = 1) => ({ jsonrpc: '2.0', id, method, params });

function parseRpc(res) {
  if (res.body && Object.keys(res.body).length) return res.body;
  const dataLine = String(res.text || '').split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : res.text);
}

function llmReply(delta, overrides = {}) {
  return () => ({
    data: {
      choices: [{
        message: {
          content: JSON.stringify({
            match_decision: 'matched_existing',
            confidence: 0.92,
            delta,
            should_create_project: false,
            needs_user_confirmation: false,
            no_material_change: false,
            ...overrides,
          }),
        },
      }],
    },
  });
}

/** What the model was shown, as one string. */
function lastPrompt() {
  const body = providerRequests[providerRequests.length - 1];
  return JSON.stringify(body?.messages || body || '');
}

async function createOrgFixture(label) {
  const orgId = `org-${uuidv4()}`;
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.com`;
  const { key, prefix, hash } = generateApiKey();

  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [orgId, `Explicit ${label}`, 'active'],
    orgId
  );
  await db.query(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
    orgId
  );
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);
  await db.query(
    'INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
    [`key-${uuidv4()}`, prefix, hash, `Explicit key ${label}`, userId, orgId, 'production', expiresAt.toISOString(), ['context:read', 'context:write']],
    orgId
  );
  return { orgId, userId, apiKey: key };
}

async function cleanupOrgFixture({ orgId }) {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [orgId], orgId).catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [orgId], orgId).catch(() => {});
  for (const table of ['product_events', 'api_keys', 'users', 'organizations']) {
    await db.query(`DELETE FROM ${table} WHERE org_id = $1`, [orgId], orgId).catch(() => {});
  }
}

async function createProject(apiKey, name, extra = {}) {
  const res = await request(httpServer)
    .post('/api/v1/context/projects')
    .set('x-api-key', apiKey)
    .send({ project_name: name, description: 'A project that already exists', goals: ['Prove writes land'], ...extra });
  assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  return res.body.project.project_id;
}

async function bindSession(fixture, projectId, tool = 'claude_web') {
  const actor = { id: fixture.userId, org_id: fixture.orgId };
  const sessionId = hostedSessionId(actor, tool);
  const now = new Date().toISOString();
  await store.saveSession({
    session_id: sessionId,
    owner_key: fixture.orgId,
    user_id: fixture.userId,
    tool,
    surface_type: 'browser',
    project_id: projectId,
    conversation_ref: '',
    cwd: '',
    host: '',
    tab_id: '',
    status: 'active',
    routing_state: 'matched',
    match_confidence: 0.9,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
  return sessionId;
}

async function readBack(fixture, projectId) {
  const project = await store.getProject(fixture.orgId, projectId);
  assert.ok(project, 'project row vanished');
  return project.context || {};
}

function hostedCall(apiKey, name, args) {
  return request(httpServer)
    .post('/mcp')
    .set(MCP_HEADERS)
    .set('x-api-key', apiKey)
    .send(rpc('tools/call', { name, arguments: args }, 1));
}

async function hostedUpdate(apiKey, args) {
  const res = await hostedCall(apiKey, 'update_context', args);
  assert.strictEqual(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, `update_context errored: ${JSON.stringify(payload.error)}`);
  return payload.result;
}

/** The brief as a returning session would read it: through hosted recall. */
async function recallText(apiKey, projectId, sections) {
  const res = await hostedCall(apiKey, 'recall', { action: 'context', project_id: projectId, sections });
  assert.strictEqual(res.status, 200, res.text);
  const payload = parseRpc(res);
  assert.ok(!payload.error, `recall errored: ${JSON.stringify(payload.error)}`);
  return payload.result?.content?.[0]?.text || '';
}

function restExtraction(fx, sessionId, projectId, text, extra = {}) {
  return request(httpServer)
    .post('/api/v1/context/extraction')
    .set('x-api-key', fx.apiKey)
    .send({
      session_id: sessionId,
      tool: 'claude_code',
      project_id: projectId,
      chunks: [{ role: 'user', text }],
      session_context: { surface_type: 'cli', status: 'active' },
      ...extra,
    });
}

function restEvent(fx, body) {
  return request(httpServer)
    .post('/api/v1/context/events')
    .set('x-api-key', fx.apiKey)
    .send(body);
}

async function patchContext(fx, projectId, patch) {
  const res = await request(httpServer)
    .patch(`/api/v1/context/projects/${projectId}/context`)
    .set('x-api-key', fx.apiKey)
    .send(patch);
  assert.ok([200, 202].includes(res.status), res.text);
}

// ─── 1. Lists ────────────────────────────────────────────────────────────────

test('one new goal from extraction adds to the stored goals instead of replacing them', async (t) => {
  const fx = await createOrgFixture('list-union');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'List Union Project', {
    goals: ['Ship auth', 'Ship billing', 'Ship teams'],
    tech_stack: ['Node.js', 'Postgres'],
  });
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  providerReply = llmReply({
    // What a model returns: one thing it already saw, one new thing.
    goals: ['Ship auth', 'Ship the mobile app'],
    tech_stack: ['Postgres', 'Redis'],
  });
  const res = await restExtraction(fx, sessionId, projectId, `We also want to ship the mobile app and add Redis. ${uuidv4()}`);
  assert.ok([200, 202].includes(res.status), res.text);

  const after = await readBack(fx, projectId);
  assert.deepStrictEqual(
    after.goals,
    ['Ship auth', 'Ship billing', 'Ship teams', 'Ship the mobile app'],
    'THE BUG: adding one goal deleted the goals the conversation did not mention'
  );
  assert.deepStrictEqual(after.tech_stack, ['Node.js', 'Postgres', 'Redis']);
});

// ─── 2. The task ─────────────────────────────────────────────────────────────

test('update_context cannot replace an explicitly set task, whatever the model returns', async (t) => {
  const fx = await createOrgFixture('task-explicit');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Explicit Task Project');
  await bindSession(fx, projectId);

  const TASK = `Cut the 2.0.2 submission ${uuidv4().slice(0, 8)}`;
  await hostedUpdate(fx.apiKey, { project_id: projectId, task: TASK });
  assert.strictEqual((await readBack(fx, projectId)).current_task, TASK, 'precondition: the task is set');

  providerReply = llmReply({
    current_task: 'Investigate and resolve the deployment issues in the release pipeline',
    next_action: 'Look into the pipeline logs',
    current_status: 'Deploy v545 is live.',
  });
  await hostedUpdate(fx.apiKey, { project_id: projectId, summary: `Deployed v545 to Fly and verified the health check. ${uuidv4()}` });

  const after = await readBack(fx, projectId);
  assert.strictEqual(after.current_task, TASK, 'THE BUG: a status update replaced the task somebody set on purpose');
  assert.strictEqual(after.next_action || '', '', 'an inferred next_action rode in beside the protected task');
  assert.match(await recallText(fx.apiKey, projectId, ['task']), new RegExp(TASK));
});

test('passive extraction leaves an explicit task alone until that task is completed', async (t) => {
  const fx = await createOrgFixture('task-passive');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Passive Task Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const TASK = `Rewrite the portfolio query as one CTE ${uuidv4().slice(0, 8)}`;
  await patchContext(fx, projectId, { current_task: TASK });

  providerReply = llmReply({ current_task: 'Refactor the onboarding wizard copy for the second step' });
  await restExtraction(fx, sessionId, projectId, `Talked about the onboarding wizard copy for a while. ${uuidv4()}`);
  assert.strictEqual(
    (await readBack(fx, projectId)).current_task,
    TASK,
    'THE BUG: a passive capture replaced an explicit task'
  );

  // Completing the task releases it: the next inferred task may land.
  const done = await restEvent(fx, { event_type: 'task_completed', project_id: projectId, summary: TASK });
  assert.ok([200, 201, 202].includes(done.status), done.text);

  const NEXT = `Refactor the onboarding wizard copy ${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({ current_task: NEXT });
  await restExtraction(fx, sessionId, projectId, `Now starting on the onboarding wizard copy refactor. ${uuidv4()}`);
  assert.strictEqual(
    (await readBack(fx, projectId)).current_task,
    NEXT,
    'a completed task must not pin the brief: extraction could never move it on'
  );
});

test('the task set after a finished one is protected too', async (t) => {
  const fx = await createOrgFixture('task-after-finish');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Task After Finish Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  await patchContext(fx, projectId, { current_task: 'The first task' });
  const done = await restEvent(fx, { event_type: 'task_completed', project_id: projectId, summary: 'The first task' });
  assert.ok([200, 201, 202].includes(done.status), done.text);

  const SECOND = `The second task ${uuidv4().slice(0, 8)}`;
  await patchContext(fx, projectId, { current_task: SECOND });
  assert.notStrictEqual((await readBack(fx, projectId)).task_progress, 'completed', 'a brand-new task still reads as completed');

  providerReply = llmReply({ current_task: 'Something the model inferred from a long status conversation' });
  await restExtraction(fx, sessionId, projectId, `A long conversation about an unrelated status topic. ${uuidv4()}`);
  assert.strictEqual((await readBack(fx, projectId)).current_task, SECOND);
});

test('a project whose task was never set explicitly still takes an extracted one', async (t) => {
  // The row every existing account has: a current_task with no provenance.
  const fx = await createOrgFixture('task-legacy');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Legacy Task Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const NEXT = `Wire the Stripe webhook retries ${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({ current_task: NEXT });
  await restExtraction(fx, sessionId, projectId, `Starting on the Stripe webhook retries now. ${uuidv4()}`);
  assert.strictEqual((await readBack(fx, projectId)).current_task, NEXT);
});

test('the extractor is shown the stored context, not told the project is new', async (t) => {
  const fx = await createOrgFixture('context-digest');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Digest Project');
  await bindSession(fx, projectId);
  const TASK = `Digest marker task ${uuidv4().slice(0, 8)}`;
  await hostedUpdate(fx.apiKey, { project_id: projectId, task: TASK });

  providerRequests.length = 0;
  providerReply = llmReply({ current_status: 'Working.' });
  await hostedUpdate(fx.apiKey, { project_id: projectId, summary: `Made progress on the digest work today. ${uuidv4()}` });

  assert.ok(providerRequests.length > 0, 'the model was never called');
  const prompt = lastPrompt();
  assert.ok(prompt.includes(TASK), 'THE BUG: the model was not shown the stored task it then overwrote');
  assert.ok(!prompt.includes('no existing context'), 'the model was told an existing project had no context');
});

// ─── 3. The caller's words ───────────────────────────────────────────────────

test('a delta of only {category} does not count as the caller\'s words being stored', async (t) => {
  const fx = await createOrgFixture('category-only');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Category Only Project');
  await bindSession(fx, projectId);

  const MARKER = `CATEGORY-ONLY-${uuidv4().slice(0, 8)}`;
  const summary = `Moved the digest cron to 09:00 UTC. ${MARKER}`;
  providerReply = llmReply({ category: 'coding' });

  const result = await hostedUpdate(fx.apiKey, { project_id: projectId, summary });

  const recalled = await recallText(fx.apiKey, projectId, ['decisions']);
  assert.ok(
    recalled.includes(MARKER),
    `THE BUG: update_context answered ${JSON.stringify(result.content?.[0]?.text)} and the text cannot be recalled`
  );
  assert.strictEqual(result.structuredContent?.stored, true);
});

test('the caller\'s sentence is stored verbatim, once, with the model\'s wording as its headline', async (t) => {
  const fx = await createOrgFixture('verbatim');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Verbatim Project');
  await bindSession(fx, projectId);

  const MARKER = `VERBATIM-${uuidv4().slice(0, 8)}`;
  const summary = `PR #486 merged; Fly v546 deployed at 17:58 UTC; E-007 adjudicated as CONFIRMED. ${MARKER}`;
  providerReply = llmReply({
    recent_decisions: [
      { summary: 'A pull request was merged and deployed.', headline: 'PR merged and deployed', decided_at: new Date().toISOString(), importance: 'high' },
      { summary: 'An experiment was adjudicated.', decided_at: new Date().toISOString() },
    ],
  });

  const before = (await readBack(fx, projectId)).recent_decisions || [];
  await hostedUpdate(fx.apiKey, { project_id: projectId, summary });
  const after = (await readBack(fx, projectId)).recent_decisions || [];

  const added = after.filter((d) => !before.some((b) => b.summary === d.summary));
  assert.strictEqual(added.length, 1, `one update must add one decision, got: ${JSON.stringify(added.map((d) => d.summary))}`);
  assert.strictEqual(added[0].summary, summary, 'THE BUG: the model\'s paraphrase was stored instead of what the caller said');
  assert.strictEqual(added[0].headline, 'PR merged and deployed');
  assert.strictEqual(added[0].importance, 'high');
});

test('the same sentence sent twice is stored once and still reports stored', async (t) => {
  const fx = await createOrgFixture('idempotent');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Idempotent Project');
  await bindSession(fx, projectId);

  const summary = `Pinned tsup to 8.3 across the workspace. IDEM-${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({});
  await hostedUpdate(fx.apiKey, { project_id: projectId, summary });
  const second = await hostedUpdate(fx.apiKey, { project_id: projectId, summary: `${summary} ` });

  const decisions = (await readBack(fx, projectId)).recent_decisions || [];
  assert.strictEqual(decisions.filter((d) => d.summary.trim() === summary).length, 1);
  assert.strictEqual(second.structuredContent?.stored, true, 'the text IS retrievable, so stored must be true');
});

test('a short explicit update is stored even though it looks trivial', async (t) => {
  const fx = await createOrgFixture('short-explicit');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Short Explicit Project');
  await bindSession(fx, projectId);

  providerReply = llmReply({});
  const result = await hostedUpdate(fx.apiKey, { project_id: projectId, summary: 'Use pnpm' });
  assert.strictEqual(result.structuredContent?.stored, true);
  assert.match(await recallText(fx.apiKey, projectId, ['decisions']), /Use pnpm/);
});

test('what the model judges chatter is kept at low importance, not floored at high', async (t) => {
  const fx = await createOrgFixture('ignored-verdict');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Ignored Verdict Project');
  await bindSession(fx, projectId);

  const MARKER = `CHATTER-${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({}, { match_decision: 'ignored', confidence: 0.9, no_material_change: true });
  await hostedUpdate(fx.apiKey, { project_id: projectId, summary: `Sounds good, carrying on as discussed. ${MARKER}` });

  const entry = ((await readBack(fx, projectId)).recent_decisions || []).find((d) => d.summary.includes(MARKER));
  assert.ok(entry, 'an explicit save was dropped on the model\'s say-so');
  assert.strictEqual(entry.importance, 'low', 'THE BUG: chatter was floored at high and led the brief');
});

test('"Open question:" lines are filed as questions without needing the model', async (t) => {
  const fx = await createOrgFixture('open-question');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Open Question Project');
  await bindSession(fx, projectId);

  const Q = `Should viewers be able to write projects they authored ${uuidv4().slice(0, 8)}?`;
  providerReply = null; // provider down
  const result = await hostedUpdate(fx.apiKey, { project_id: projectId, summary: `Open question: ${Q}` });

  const after = await readBack(fx, projectId);
  assert.ok((after.open_questions || []).includes(Q), `question not filed: ${JSON.stringify(after.open_questions)}`);
  assert.ok(
    !(after.recent_decisions || []).some((d) => d.summary.includes(Q)),
    'a question is not a decision; it was filed as both'
  );
  assert.strictEqual(result.structuredContent?.stored, true);
  assert.ok((await recallText(fx.apiKey, projectId, ['questions'])).includes(Q));
});

test('update_context merges commands by label and keeps the ones it was not sent', async (t) => {
  const fx = await createOrgFixture('commands-merge');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Commands Merge Project');
  await bindSession(fx, projectId);

  providerReply = llmReply({ current_status: 'Wiring commands.' });
  await hostedUpdate(fx.apiKey, {
    project_id: projectId,
    summary: `Recorded the test command. ${uuidv4()}`,
    commands: [{ label: 'test', run: 'npm test' }, { label: 'lint', run: 'npm run lint' }],
  });
  await hostedUpdate(fx.apiKey, {
    project_id: projectId,
    summary: `Switched the test command to the DB harness. ${uuidv4()}`,
    commands: [{ label: 'test', run: 'bash scripts/run-db-test.sh npm test' }],
  });

  const commands = (await readBack(fx, projectId)).commands || [];
  assert.deepStrictEqual(
    commands.map((c) => [c.label, c.run]).sort(),
    [['lint', 'npm run lint'], ['test', 'bash scripts/run-db-test.sh npm test']],
  );
});

// ─── 4. The rate guard ───────────────────────────────────────────────────────

test('a different chunk inside the rate-guard window gets its own extraction', async (t) => {
  const fx = await createOrgFixture('guard-content');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Guard Content Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const A = `GUARD-A-${uuidv4().slice(0, 8)}`;
  const B = `GUARD-B-${uuidv4().slice(0, 8)}`;
  providerReply = (body) => {
    const text = JSON.stringify(body);
    const marker = text.includes(B) ? B : A;
    return llmReply({ recent_decisions: [{ summary: `Decided to keep the retry budget at three. ${marker}`, decided_at: new Date().toISOString() }] })();
  };

  await restExtraction(fx, sessionId, projectId, `We decided to keep the retry budget at three. ${A}`);
  await restExtraction(fx, sessionId, projectId, `We decided to keep the retry budget at three. ${B}`);

  const stored = JSON.stringify(await readBack(fx, projectId));
  assert.ok(stored.includes(A), 'first chunk missing');
  assert.ok(stored.includes(B), 'THE BUG: the second chunk was answered with the first chunk\'s cached delta');
});

test('a trivial chunk does not poison the real update that follows it', async (t) => {
  const fx = await createOrgFixture('guard-trivial');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Guard Trivial Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const MARKER = `AFTER-TRIVIAL-${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({ recent_decisions: [{ summary: `Chose Postgres advisory locks for the scheduler. ${MARKER}`, decided_at: new Date().toISOString() }] });

  await restExtraction(fx, sessionId, projectId, 'ok');
  await restExtraction(fx, sessionId, projectId, `We chose Postgres advisory locks for the scheduler. ${MARKER}`);

  assert.ok(
    JSON.stringify(await readBack(fx, projectId)).includes(MARKER),
    'THE BUG: the real update inherited the cached "trivial" verdict'
  );
});

// ─── Extraction mediums ──────────────────────────────────────────────────────

test('a date-only decided_at from the model is kept as that date, not restamped and demoted', async (t) => {
  const fx = await createOrgFixture('date-only');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Date Only Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const MARKER = `DATED-${uuidv4().slice(0, 8)}`;
  providerReply = llmReply({ recent_decisions: [{ summary: `Adopted the three-state visibility model. ${MARKER}`, decided_at: '2026-09-01' }] });
  await restExtraction(fx, sessionId, projectId, `On September 1st we adopted the three-state visibility model. ${MARKER}`);

  const entry = ((await readBack(fx, projectId)).recent_decisions || []).find((d) => d.summary.includes(MARKER));
  assert.ok(entry, 'decision not stored');
  assert.ok(entry.decided_at.startsWith('2026-09-01'), `THE BUG: a real date was discarded: ${entry.decided_at}`);
  assert.ok(!entry.date_inferred, 'a dated decision was flagged date_inferred and ranked below undated ones');
});

test('the model cannot move or delete board cards', async (t) => {
  const fx = await createOrgFixture('board-directives');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Board Directive Project');
  const sessionId = await bindSession(fx, projectId, 'claude_code');

  const CARD = `Keep this card ${uuidv4().slice(0, 8)}`;
  const added = await restEvent(fx, { event_type: 'todo_added', project_id: projectId, summary: CARD });
  assert.ok([200, 201, 202].includes(added.status), added.text);

  providerReply = llmReply({ remove_todos: [CARD], current_status: 'Tidied the board.' });
  await restExtraction(fx, sessionId, projectId, `We talked about tidying the board and that card. ${uuidv4()}`);

  const titles = ((await readBack(fx, projectId)).todo_items || []).map((c) => c.title);
  assert.ok(titles.includes(CARD), 'THE BUG: an extraction hard-deleted a board card');
});

test('the 16th open question evicts the oldest instead of throwing', async (t) => {
  const fx = await createOrgFixture('question-cap');
  t.after(() => cleanupOrgFixture(fx));
  const projectId = await createProject(fx.apiKey, 'Question Cap Project');

  for (let i = 1; i <= 16; i += 1) {
    const res = await restEvent(fx, { event_type: 'question_asked', project_id: projectId, summary: `Numbered question ${i} about the scheduler?` });
    assert.ok([200, 201, 202].includes(res.status), `question ${i} was refused: ${res.status} ${res.text}`);
  }
  const questions = (await readBack(fx, projectId)).open_questions || [];
  assert.strictEqual(questions.length, 15);
  assert.ok(questions.some((q) => q.includes('question 16')), 'the newest question must be kept');
});
