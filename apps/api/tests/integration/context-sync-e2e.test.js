/**
 * E2E tests for the DeerDawn context sharing system.
 *
 * Covers: auth rejection, input validation, /active endpoint, auto project
 * creation, injection deduplication, token budget compliance, no_material_change,
 * /seed endpoint, preferences, global context, and match endpoint.
 *
 * One top-level test block with a single pool/redis teardown at the end
 * to avoid circuit-breaker trips between suites.
 */

const test = require('node:test');
const assert = require('node:assert');
const request = require('supertest');
const app = require('../../src/app');

// One server for the whole file. Passing the bare `app` makes supertest
// listen() and close() a fresh ephemeral server per request; under that churn a
// connection occasionally fails, surfacing as ETIMEDOUT or as a 200 with an
// unparsed body. See tests/oauth-mcp-contracts.test.js for the full diagnosis.
const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const API_KEY = process.env.DEERDAWN_API_KEY || 'dev-key';

function auth(req) {
  return req.set('X-Api-Key', API_KEY);
}

test('Context sync E2E', async (t) => {
  await store.clearAll();

  // ─── Auth & input validation ─────────────────────────────────────────────

  await t.test('auth and validation', async (t) => {
    await t.test('rejects unauthenticated GET /projects', async () => {
      const res = await request(httpServer).get('/api/v1/context/projects');
      assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    });

    await t.test('rejects unauthenticated POST /extraction', async () => {
      const res = await request(httpServer).post('/api/v1/context/extraction')
        .send({ session_id: 'x', tool: 'claude_web', chunk: { role: 'user', text: 'hi' } });
      assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    });

    await t.test('rejects unauthenticated GET /active', async () => {
      const res = await request(httpServer).get('/api/v1/context/active');
      assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    });

    await t.test('rejects unauthenticated POST /seed', async () => {
      const res = await request(httpServer).post('/api/v1/context/seed')
        .send({ source: 'paste', projects: [] });
      assert.ok(res.status === 401 || res.status === 403, `got ${res.status}`);
    });

    await t.test('rejects extraction missing session_id', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/extraction'))
        .send({ tool: 'claude_web', chunk: { role: 'user', text: 'hi' } });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.error, 'invalid_payload');
    });

    await t.test('rejects extraction with unknown tool', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/extraction'))
        .send({ session_id: 'x', tool: 'unknown_tool', chunk: { role: 'user', text: 'hi' } });
      assert.strictEqual(res.status, 400);
    });

    await t.test('rejects project creation missing project_name', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ description: 'no name' });
      assert.strictEqual(res.status, 400);
    });

    await t.test('rejects seed with invalid source enum', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/seed'))
        .send({ source: 'bad', projects: [{ name: 'x', conversations: [{ messages: [{ role: 'user', text: 'hello world test message long enough' }] }] }] });
      assert.strictEqual(res.status, 400);
    });

    await t.test('rejects seed with empty projects array', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/seed'))
        .send({ source: 'paste', projects: [] });
      assert.strictEqual(res.status, 400);
    });

    await t.test('POST /events with unknown project_id returns 404, not 500', async () => {
      const res = await auth(request(app).post('/api/v1/context/events'))
        .send({ event_type: 'file_changed', project_id: 'nonexistent-project-id', summary: 'test event' });
      assert.strictEqual(res.status, 404);
      assert.strictEqual(res.body.error, 'project_not_found');
    });
  });

  // ─── /active endpoint ────────────────────────────────────────────────────

  await t.test('/active endpoint', async (t) => {
    await store.clearAll();

    await t.test('returns null when no projects exist', async () => {
      const res = await auth(request(httpServer).get('/api/v1/context/active'));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.project_id, null);
    });

    await t.test('returns brief for a single project after extraction', async () => {
      const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'ActiveTest', current_status: 'In progress', tech_stack: ['Node.js'] });
      assert.strictEqual(createRes.status, 201);
      const projectId = createRes.body.project.project_id;

      await auth(request(httpServer).post('/api/v1/context/extraction')).send({
        session_id: 'sess-active-1',
        tool: 'claude_code',
        chunks: [{ role: 'user', text: 'Working on the active endpoint for context sync.' }],
        extraction: {
          match_decision: 'matched_existing',
          confidence: 0.92,
          project_candidate: { project_id: projectId, project_name: 'ActiveTest', score: 0.92 },
          delta: { current_task: 'Build /active endpoint' },
          should_create_project: false,
          needs_user_confirmation: false,
        },
      });

      const res = await auth(request(httpServer).get('/api/v1/context/active').query({ tool: 'claude_code' }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.brief, 'expected non-null brief');
      assert.strictEqual(res.body.project_id, projectId);
      assert.strictEqual(res.body.project_name, 'ActiveTest');
    });

    await t.test('returns most recently updated project when multiple exist', async () => {
      await store.clearAll();

      const p1 = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'Older', description: 'First' });
      const p2 = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'Newer', description: 'Second' });
      const p1Id = p1.body.project.project_id;
      const p2Id = p2.body.project.project_id;

      const extraction = (projectId, projectName, sessionId) => ({
        session_id: sessionId,
        tool: 'claude_web',
        chunks: [{ role: 'user', text: `Working on ${projectName} with React and TypeScript on a complex feature.` }],
        extraction: {
          match_decision: 'matched_existing', confidence: 0.9,
          project_candidate: { project_id: projectId, project_name: projectName, score: 0.9 },
          delta: { current_task: `Build ${projectName} feature` },
          should_create_project: false, needs_user_confirmation: false,
        },
      });

      await auth(request(httpServer).post('/api/v1/context/extraction')).send(extraction(p1Id, 'Older', 'sess-older'));
      await new Promise((r) => setTimeout(r, 60));
      await auth(request(httpServer).post('/api/v1/context/extraction')).send(extraction(p2Id, 'Newer', 'sess-newer'));

      const res = await auth(request(httpServer).get('/api/v1/context/active'));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.project_id, p2Id, 'active should be most recently updated');
    });
  });

  // ─── Auto project creation ───────────────────────────────────────────────

  await t.test('auto project creation via extraction', async (t) => {
    await store.clearAll();
    let createdProjectId;

    await t.test('creates project when should_create_project is true', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/extraction')).send({
        session_id: 'sess-auto-create',
        tool: 'claude_web',
        chunks: [{ role: 'user', text: 'Starting a Python data pipeline with Airflow and BigQuery.' }],
        extraction: {
          match_decision: 'new_project', confidence: 0.91,
          project_candidate: { project_name: 'DataPipeline', reason: 'new', score: 0.91 },
          delta: { description: 'Python data pipeline', tech_stack: ['Python', 'Airflow', 'BigQuery'], current_task: 'Setup DAGs' },
          should_create_project: true, needs_user_confirmation: false,
        },
      });
      assert.strictEqual(res.status, 202, JSON.stringify(res.body));
      assert.ok(res.body.project?.project_id, 'project should be created');
      assert.strictEqual(res.body.project.project_name, 'DataPipeline');
      createdProjectId = res.body.project.project_id;
    });

    await t.test('auto-created project appears in list', async () => {
      const res = await auth(request(httpServer).get('/api/v1/context/projects'));
      assert.strictEqual(res.status, 200);
      assert.ok(res.body.projects.find((p) => p.project_id === createdProjectId));
    });

    await t.test('auto-created project returns inject payload', async () => {
      const res = await auth(request(httpServer).get(`/api/v1/context/projects/${createdProjectId}/inject`)
        .query({ tool: 'claude_web', verbosity: 'standard' }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(res.body.payload?.body);
    });
  });

  // ─── Token budget compliance ─────────────────────────────────────────────

  await t.test('token budget compliance', async (t) => {
    await store.clearAll();

    const createRes = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'TokenProject',
      description: 'A SaaS platform with auth, billing, and API — built with Next.js and Node.js',
      goals: ['Ship V1', 'Reach 100 users', 'Get first paying customer'],
      current_status: 'Sprint 4, auth done, payments integrated, API stable',
      current_task: 'Building context sync across Claude and ChatGPT',
      tech_stack: ['TypeScript', 'Next.js', 'Node.js', 'PostgreSQL', 'Redis', 'Stripe'],
      recurring_context: ['No premature optimization', 'Ship over perfect', 'Prefer minimal abstractions'],
    });
    assert.strictEqual(createRes.status, 201);
    const projectId = createRes.body.project.project_id;

    await t.test('light conversational brief ≤90 tokens', async () => {
      const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'claude_web', verbosity: 'light' }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const tokens = Math.ceil(res.body.payload.body.length / 4);
      assert.ok(tokens <= 90, `light brief: ~${tokens} tokens (limit 90)`);
    });

    await t.test('standard conversational brief ≤130 tokens', async () => {
      const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'chatgpt_web', verbosity: 'standard' }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const tokens = Math.ceil(res.body.payload.body.length / 4);
      assert.ok(tokens <= 130, `standard brief: ~${tokens} tokens (limit 130)`);
    });

    await t.test('detailed code brief ≤220 tokens', async () => {
      const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'cursor', verbosity: 'detailed' }));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      const tokens = Math.ceil(res.body.payload.body.length / 4);
      assert.ok(tokens <= 220, `detailed code brief: ~${tokens} tokens (limit 220)`);
    });

    await t.test('conversational format reported for browser tools', async () => {
      const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'claude_web', verbosity: 'standard' }));
      assert.strictEqual(res.body.payload.format, 'conversational');
    });

    await t.test('code format reported for code tools', async () => {
      const res = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'cursor', verbosity: 'standard' }));
      assert.strictEqual(res.body.payload.format, 'code');
    });
  });

  // ─── no_material_change ──────────────────────────────────────────────────

  await t.test('no_material_change skips project update', async (t) => {
    await store.clearAll();

    await t.test('status unchanged after no_material_change extraction', async () => {
      const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'StableProject', current_status: 'Unchanged' });
      assert.strictEqual(createRes.status, 201);
      const projectId = createRes.body.project.project_id;

      await auth(request(httpServer).post('/api/v1/context/extraction')).send({
        session_id: 'sess-stable',
        tool: 'claude_web',
        chunks: [{ role: 'user', text: 'ok' }],
        extraction: {
          match_decision: 'matched_existing', confidence: 0.5,
          project_candidate: { project_id: projectId, project_name: 'StableProject', score: 0.5 },
          delta: {}, should_create_project: false, needs_user_confirmation: false, no_material_change: true,
        },
      });

      const listRes = await auth(request(httpServer).get('/api/v1/context/projects'));
      const project = listRes.body.projects.find((p) => p.project_id === projectId);
      assert.ok(project, 'project should still exist');
      assert.strictEqual(project.context?.current_status ?? '', 'Unchanged');
    });
  });

  // ─── /seed endpoint ──────────────────────────────────────────────────────

  await t.test('/seed endpoint', async (t) => {
    await store.clearAll();

    await t.test('rejects >30 projects', async () => {
      const projects = Array.from({ length: 31 }, (_, i) => ({
        name: `P${i}`,
        conversations: [{ messages: [{ role: 'user', text: 'Long enough message for the seed filter to accept it without skipping.' }] }],
      }));
      const res = await auth(request(httpServer).post('/api/v1/context/seed'))
        .send({ source: 'paste', projects });
      assert.strictEqual(res.status, 400);
    });

    await t.test('processes paste project and returns ok', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/seed')).send({
        source: 'paste',
        projects: [{
          name: 'SeedProject',
          conversations: [{
            title: 'Auth system',
            messages: [
              { role: 'user', text: 'Building a SaaS app with Next.js and Supabase. The main feature is team-based access control with role-based permissions. Working on JWT middleware for API routes and handling token refresh.' },
              { role: 'user', text: 'Tech stack: Next.js 16, TypeScript, Supabase, Stripe, Vercel deployment. Goal is 100 paying customers by Q4 this year.' },
            ],
          }],
        }],
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'ok');
      assert.ok(typeof res.body.projects_created === 'number');
      assert.deepStrictEqual(res.body.errors, []);
    });

    await t.test('skips projects with only trivial short messages', async () => {
      await store.clearAll();
      const res = await auth(request(httpServer).post('/api/v1/context/seed')).send({
        source: 'paste',
        projects: [{ name: 'TrivialProject', conversations: [{ messages: [
          { role: 'user', text: 'ok' },
          { role: 'assistant', text: 'Sure.' },
        ] }] }],
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.errors.length, 0);
      // Thin content is skipped honestly, never created as an empty project.
      assert.strictEqual(res.body.projects_created, 0, JSON.stringify(res.body));
      assert.strictEqual(res.body.projects_skipped, 1, JSON.stringify(res.body));
      const list = await auth(request(httpServer).get('/api/v1/context/projects'));
      assert.ok(!list.body.projects.some((p) => /TrivialProject/i.test(p.project_name)), 'trivial import must not create a project');
    });

    await t.test('handles multiple projects in one request', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/seed')).send({
        source: 'chatgpt_export',
        projects: [
          { name: 'AlphaProject', conversations: [{ messages: [
            { role: 'user', text: 'Building a React Native mobile app for iOS. Using Expo, TypeScript, and React Query. Main challenge is React Navigation v6 and deep link handling for the onboarding flow.' },
          ] }] },
          { name: 'BetaProject', conversations: [{ messages: [
            { role: 'user', text: 'Working on a Python ML pipeline using scikit-learn and pandas. Training a classification model on customer churn data. Currently at feature engineering with 40 features and 200k rows.' },
          ] }] },
        ],
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.status, 'ok');
      assert.strictEqual(res.body.errors.length, 0);
    });

    // Regression: a reported projects_created count must reflect a genuinely
    // persisted project, so the Context Graph is never empty after a "successful"
    // import. Previously a flaky/absent LLM call returned a non-creating fallback
    // that was still counted as created, leaving the graph empty until re-import.
    //
    // Journey scan round 4: with no model (as here) the import is NOT processed.
    // Nothing from the conversation is saved, so it is not counted as created;
    // it is listed as not processed, and the project it keeps under the name
    // given is real and queryable.
    await t.test('reports created counts that are actually queryable', async () => {
      await store.clearAll();
      const res = await auth(request(httpServer).post('/api/v1/context/seed')).send({
        source: 'paste',
        projects: [{
          name: 'PersistedSeedProject',
          conversations: [{ messages: [
            { role: 'user', text: 'Shipping a billing service in Go with Postgres and Stripe webhooks. Currently wiring idempotency keys into the charge handler so retried webhooks do not double-charge.' },
          ] }],
        }],
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.projects_created, 0, JSON.stringify(res.body));
      assert.strictEqual(res.body.projects_not_processed, 1, JSON.stringify(res.body));
      assert.strictEqual(res.body.not_processed[0].project, 'PersistedSeedProject');
      assert.strictEqual(res.body.errors.length, 0);

      const list = await auth(request(httpServer).get('/api/v1/context/projects'));
      assert.strictEqual(list.status, 200);
      const names = list.body.projects.map((p) => p.project_name);
      assert.ok(
        names.some((n) => /PersistedSeedProject/i.test(n)),
        `seeded project not queryable after import: ${JSON.stringify(names)}`,
      );
    });
  });

  // ─── Preferences & global context ───────────────────────────────────────

  await t.test('preferences and global context', async (t) => {
    await store.clearAll();

    await t.test('global context round-trips correctly', async () => {
      await auth(request(httpServer).patch('/api/v1/context/global')).send({
        user_profile: 'E2E test user',
        preferences: ['be concise', 'no boilerplate'],
        recurring_instructions: ['always use TypeScript'],
        global_stack: ['TypeScript', 'Node.js'],
      });

      const res = await auth(request(httpServer).get('/api/v1/context/global'));
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.global.user_profile, 'E2E test user');
      assert.deepStrictEqual(res.body.global.preferences, ['be concise', 'no boilerplate']);
      assert.deepStrictEqual(res.body.global.global_stack, ['TypeScript', 'Node.js']);
    });

    await t.test('pausing globally suppresses injection', async () => {
      const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'PauseTest', current_status: 'Active' });
      const projectId = createRes.body.project.project_id;

      await auth(request(httpServer).patch('/api/v1/context/preferences')).send({ paused: true });

      const injectRes = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'claude_web' }));
      assert.strictEqual(injectRes.status, 204, 'should be suppressed when paused');

      await auth(request(httpServer).patch('/api/v1/context/preferences')).send({ paused: false });
    });

    await t.test('per-tool disable suppresses that tool only', async () => {
      const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'ToolDisableTest', current_status: 'Active' });
      const projectId = createRes.body.project.project_id;

      await auth(request(httpServer).patch('/api/v1/context/preferences')).send({
        paused: false,
        tools: { chatgpt_web: { enabled: false, verbosity: 'light' }, claude_web: { enabled: true, verbosity: 'standard' } },
      });

      const disabled = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'chatgpt_web' }));
      assert.strictEqual(disabled.status, 204, 'chatgpt_web should be disabled');

      const enabled = await auth(request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`)
        .query({ tool: 'claude_web' }));
      assert.strictEqual(enabled.status, 200, 'claude_web should be enabled');

      await auth(request(httpServer).patch('/api/v1/context/preferences')).send({ paused: false, tools: {} });
    });
  });

  // ─── Match endpoint ──────────────────────────────────────────────────────

  await t.test('match endpoint', async (t) => {
    await store.clearAll();

    await t.test('low-confidence candidates return ambiguous', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/match')).send({
        tool: 'chatgpt_web',
        candidates: [
          { project_id: 'proj-a', project_name: 'ProjectA', score: 0.4 },
          { project_id: 'proj-b', project_name: 'ProjectB', score: 0.38 },
        ],
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.strictEqual(res.body.match.needs_user_confirmation, true);
      assert.strictEqual(res.body.match.match_decision, 'ambiguous');
    });

    await t.test('empty candidates return ignored or ambiguous', async () => {
      const res = await auth(request(httpServer).post('/api/v1/context/match'))
        .send({ tool: 'claude_web', candidates: [] });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(['ignored', 'ambiguous', 'new_project'].includes(res.body.match.match_decision));
    });

    await t.test('high-confidence candidate returns matched or ambiguous', async () => {
      const createRes = await auth(request(httpServer).post('/api/v1/context/projects'))
        .send({ project_name: 'MatchTarget', description: 'Project for match test' });
      const projectId = createRes.body.project.project_id;

      const res = await auth(request(httpServer).post('/api/v1/context/match')).send({
        tool: 'claude_web',
        project_hint: 'MatchTarget',
        candidates: [{ project_id: projectId, project_name: 'MatchTarget', score: 0.93 }],
      });
      assert.strictEqual(res.status, 200, JSON.stringify(res.body));
      assert.ok(['matched_existing', 'ambiguous'].includes(res.body.match.match_decision));
      assert.ok(res.body.match.confidence >= 0 && res.body.match.confidence <= 1);
    });
  });

  // Teardown at end of body (not t.after) so pool closure doesn't cause timeout
  await closeRedisConnections();
  await Promise.race([db.pool.end(), new Promise((r) => setTimeout(r, 3000))]);
});
