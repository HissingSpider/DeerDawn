process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

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
const { ensureDatabaseAvailable } = require('../helpers/dbAvailability');
const { ensureHttpBindingAvailable } = require('../helpers/runtimeAvailability');
const { ensureRuntimeSchema } = require('../helpers/runtimeSchema');

const systemKey = process.env.DEERDAWN_API_KEY || 'dev-key';

function auth(req) {
  return req.set('X-Api-Key', systemKey);
}

test('Context sync API', async (t) => {
  if (!await ensureHttpBindingAvailable(t, 'Context sync API integration')) return;
  if (!await ensureDatabaseAvailable(t, db, 'Context sync API integration')) return;
  await ensureRuntimeSchema();

  let projectId;
  let sessionId;

  await store.clearAll();

  await t.test('creates a project with canonical context object fields', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'Atlas',
      description: 'Cross-tool AI workspace for a long-running software project.',
      goals: ['Keep Claude and ChatGPT aligned', 'Inject code context into Cursor'],
      current_status: 'Founder validating the MVP sync loop.',
      tech_stack: ['TypeScript', 'Next.js', 'Node.js'],
      recurring_context: ['Prefer concise prompts', 'Do not duplicate project setup'],
    });

    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.project?.project_id, 'project_id missing');
    assert.strictEqual(res.body.project.context.project_name, 'Atlas');
    assert.strictEqual(res.body.project.context.current_task, '');
    projectId = res.body.project.project_id;
  });

  await t.test('rejects a duplicate project name as 409, not a 500', async () => {
    // Regression: these throws fell through to the generic error handler, so the
    // caller got an opaque 500 and the MCP client's 5xx retry re-sent it — one
    // mistyped name became a burst of PostHog exceptions. They're client errors.
    const dupeRes = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'Atlas',
      description: 'Same name as the project created above.',
    });

    assert.strictEqual(dupeRes.status, 409, JSON.stringify(dupeRes.body));
    assert.strictEqual(dupeRes.body.error, 'duplicate_project_name');
    // The existing id lets the caller reuse that project without a second lookup.
    assert.strictEqual(dupeRes.body.existing_project_id, projectId);
    assert.match(dupeRes.body.message, /already exists/);
  });

  await t.test('rejects invalid and unplaceable project names as 4xx, not 500s', async () => {
    const shortRes = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'A',
    });
    assert.strictEqual(shortRes.status, 400, JSON.stringify(shortRes.body));
    assert.strictEqual(shortRes.body.error, 'project_name_too_short');

    const placeholderRes = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'Untitled',
    });
    assert.strictEqual(placeholderRes.status, 400, JSON.stringify(placeholderRes.body));
    assert.strictEqual(placeholderRes.body.error, 'invalid_project_name');

    const orphanRes = await auth(request(httpServer).post('/api/v1/context/projects')).send({
      project_name: 'Orphaned subproject',
      parent_project_id: 'project_does_not_exist',
    });
    assert.strictEqual(orphanRes.status, 404, JSON.stringify(orphanRes.body));
    assert.strictEqual(orphanRes.body.error, 'parent_project_not_found');
  });

  await t.test('rename surfaces name rejections as 4xx with the fix in the message', async () => {
    const renameRes = await auth(request(httpServer).post(`/api/v1/context/projects/${projectId}/rename`)).send({
      project_name: 'A',
    });
    assert.strictEqual(renameRes.status, 400, JSON.stringify(renameRes.body));
    assert.strictEqual(renameRes.body.error, 'project_name_too_short');
    assert.match(renameRes.body.message, /at least/);
  });

  await t.test('service validation errors are 4xx even when the route does not catch them', async () => {
    // POST /workspace/entities only catches low_value_workspace_entity, so before
    // central classification these came back as 500s and were captured in PostHog
    // as server defects — with clients retrying the 5xx. entity_type is a free
    // string at the zod layer, so an unknown value reaches the service by design.
    const badTypeRes = await auth(request(httpServer).post('/api/v1/context/workspace/entities')).send({
      entities: [{ entity_type: 'not_a_real_type', title: 'Some entity' }],
    });
    assert.strictEqual(badTypeRes.status, 400, JSON.stringify(badTypeRes.body));
    assert.strictEqual(badTypeRes.body.error, 'workspace_entity_type_invalid');
    assert.match(badTypeRes.body.message, /must be one of/);

    const shortTitleRes = await auth(request(httpServer).post('/api/v1/context/workspace/entities')).send({
      entities: [{ entity_type: 'service', title: 'ab' }],
    });
    assert.strictEqual(shortTitleRes.status, 400, JSON.stringify(shortTitleRes.body));
    assert.strictEqual(shortTitleRes.body.error, 'workspace_entity_title_required');
  });

  await t.test('creates and lists an unbound browser session', async () => {
    const createRes = await auth(request(httpServer).patch('/api/v1/context/sessions/browser-tab-1')).send({
      tool: 'claude_web',
      surface_type: 'browser',
      conversation_ref: 'https://claude.ai/chat/session-a',
      host: 'claude.ai',
      tab_id: 'tab-1',
      status: 'active',
    });

    assert.strictEqual(createRes.status, 200, JSON.stringify(createRes.body));
    assert.strictEqual(createRes.body.session.session_id, 'browser-tab-1');
    assert.strictEqual(createRes.body.session.project_id, null);
    sessionId = createRes.body.session.session_id;

    const listRes = await auth(request(httpServer).get('/api/v1/context/sessions'));
    assert.strictEqual(listRes.status, 200, JSON.stringify(listRes.body));
    assert.ok(Array.isArray(listRes.body.sessions), 'sessions missing');
    assert.ok(listRes.body.sessions.find((s) => s.session_id === sessionId), 'created session missing from list');
  });

  await t.test('accepts session-scoped extraction intake and binds the session to the project', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/extraction')).send({
      session_id: sessionId,
      tool: 'claude_web',
      session_context: {
        conversation_ref: 'https://claude.ai/chat/session-a',
        host: 'claude.ai',
        tab_id: 'tab-1',
      },
      chunks: [{
        role: 'assistant',
        text: 'We decided to keep raw conversation text flowing through the desktop app to cloud extraction with minimal retention.',
      }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.94,
        project_candidate: {
          project_id: projectId,
          project_name: 'Atlas',
          reason: 'conversation references the same goals and stack',
        },
        delta: {
          current_status: 'Privacy posture locked for V1 extraction.',
          recent_decisions: [
            {
              summary: 'Raw browser chunks may reach the cloud extraction layer with explicit consent.',
              decided_at: '2026-05-05T12:00:00.000Z',
            },
          ],
        },
        should_create_project: false,
        needs_user_confirmation: false,
      },
    });

    assert.strictEqual(res.status, 202, JSON.stringify(res.body));
    assert.strictEqual(res.body.project.context.current_status, 'Privacy posture locked for V1 extraction.');
    // serializeProjectFull drops the raw event log from extraction responses;
    // events must stay off the wire but still be persisted in the store.
    assert.ok(!('events' in res.body.project), 'events should be omitted from the extraction response');
    assert.strictEqual(res.body.session.session_id, sessionId);
    assert.strictEqual(res.body.session.project_id, projectId);

    const stored = await store.getProject('org-system', projectId);
    assert.ok(stored, 'project missing from store after extraction');
    assert.ok(Array.isArray(stored.events), 'persisted events missing');
    assert.strictEqual(stored.events.length, 2);
  });

  await t.test('returns the bound session by id', async () => {
    const res = await auth(request(httpServer).get('/api/v1/context/sessions'));
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const session = res.body.sessions.find((s) => s.session_id === sessionId);
    assert.ok(session, 'session missing after extraction');
    assert.strictEqual(session.project_id, projectId);
    assert.strictEqual(session.status, 'active');
  });

  await t.test('returns compact conversational injection payloads', async () => {
    const res = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({
        tool: 'chatgpt_web',
        verbosity: 'standard',
      })
    );

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.payload.format, 'conversational');
    assert.match(res.body.payload.body, /Project: Atlas/);
    assert.ok(res.body.payload.body.split('\n').length <= 8, 'payload should stay compact');
  });

  await t.test('accepts legacy /projects/:id/context patch alias and normalizes command payloads', async () => {
    const res = await auth(
      request(httpServer)
        .patch(`/api/v1/context/projects/${projectId}/context`)
        .send({ commands: 'npm test' })
    );

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok(Array.isArray(res.body.project.context.commands), 'commands should be normalized to array');
    assert.strictEqual(res.body.project.context.commands[0].run, 'npm test');
    assert.ok(res.body.project.context.commands[0].label.startsWith('cmd_'));
  });

  await t.test('returns code-oriented Cursor injection payloads', async () => {
    const res = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({
        tool: 'cursor',
        verbosity: 'detailed',
      })
    );

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.payload.format, 'code');
    assert.match(res.body.payload.body, /Tech stack:/);
    assert.match(res.body.payload.body, /Recent decisions:/);
    assert.ok(Array.isArray(res.body.payload.provenance), 'provenance missing');
  });

  await t.test('exposes read-only project and session graph views', async () => {
    const projectGraphRes = await auth(request(httpServer).get(`/api/v1/context/graph/projects/${projectId}`));
    assert.strictEqual(projectGraphRes.status, 200, JSON.stringify(projectGraphRes.body));
    assert.ok(projectGraphRes.body.graph.nodes.length >= 2, 'project graph nodes missing');
    assert.ok(projectGraphRes.body.graph.edges.length >= 1, 'project graph edges missing');

    const sessionGraphRes = await auth(request(httpServer).get(`/api/v1/context/graph/sessions/${sessionId}`));
    assert.strictEqual(sessionGraphRes.status, 200, JSON.stringify(sessionGraphRes.body));
    assert.strictEqual(sessionGraphRes.body.graph.session_id, sessionId);
    assert.ok(Array.isArray(sessionGraphRes.body.graph.summary_lines), 'graph summary missing');
  });

  await t.test('supports graph query inspection by project id', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/graph/query')).send({
      project_id: projectId,
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.graph.project_id, projectId);
    assert.ok(Array.isArray(res.body.graph.nodes), 'graph query nodes missing');
  });

  await t.test('marks low-confidence matches for confirmation instead of forcing injection', async () => {
    const res = await auth(request(httpServer).post('/api/v1/context/match')).send({
      tool: 'chatgpt_web',
      project_hint: 'Atlas',
      candidates: [
        { project_id: projectId, project_name: 'Atlas', score: 0.52 },
        { project_id: 'project-other', project_name: 'Beacon', score: 0.48 },
      ],
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.match.needs_user_confirmation, true);
    assert.strictEqual(res.body.match.match_decision, 'ambiguous');
  });

  await t.test('stores per-tool injection preferences and pause state', async () => {
    const res = await auth(request(httpServer).patch('/api/v1/context/preferences')).send({
      paused: true,
      tools: {
        claude_web: { enabled: true, verbosity: 'standard' },
        chatgpt_web: { enabled: false, verbosity: 'light' },
        cursor: { enabled: true, verbosity: 'detailed' },
      },
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.preferences.paused, true);
    assert.strictEqual(res.body.preferences.tools.chatgpt_web.enabled, false);
  });

  await t.test('suppresses injection when paused or tool-disabled', async () => {
    const browserRes = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({
        tool: 'chatgpt_web',
        verbosity: 'standard',
      })
    );
    assert.strictEqual(browserRes.status, 204, JSON.stringify(browserRes.body));

    const codeRes = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({
        tool: 'cursor',
        verbosity: 'detailed',
      })
    );
    assert.strictEqual(codeRes.status, 204, JSON.stringify(codeRes.body));
  });

  await t.test('stores global context updates', async () => {
    const res = await auth(request(httpServer).patch('/api/v1/context/global')).send({
      user_profile: 'Solo technical founder building a context sync platform.',
      preferences: ['be concise'],
      recurring_instructions: ['prefer TypeScript'],
      global_stack: ['TypeScript', 'Node.js', 'PostgreSQL'],
    });

    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.global.user_profile, 'Solo technical founder building a context sync platform.');
    assert.deepStrictEqual(res.body.global.preferences, ['be concise']);
  });

  await t.test('returns 404 project_not_found for hot-paths/debug-findings/verify on a missing project', async () => {
    const missingId = 'project_does-not-exist';

    const hotPathsRes = await auth(request(httpServer).post(`/api/v1/context/projects/${missingId}/hot-paths`)).send({
      items: [{ path: 'src/index.js', label: 'entry', purpose: 'entrypoint' }],
    });
    assert.strictEqual(hotPathsRes.status, 404, JSON.stringify(hotPathsRes.body));
    assert.strictEqual(hotPathsRes.body.error, 'project_not_found');

    const debugFindingsRes = await auth(request(httpServer).post(`/api/v1/context/projects/${missingId}/debug-findings`)).send({
      summary: 'some debugging note',
    });
    assert.strictEqual(debugFindingsRes.status, 404, JSON.stringify(debugFindingsRes.body));
    assert.strictEqual(debugFindingsRes.body.error, 'project_not_found');

    const verifyRes = await auth(request(httpServer).post(`/api/v1/context/projects/${missingId}/verify`)).send({
      claim: 'status',
    });
    assert.strictEqual(verifyRes.status, 404, JSON.stringify(verifyRes.body));
    assert.strictEqual(verifyRes.body.error, 'project_not_found');

    const eventsRes = await auth(request(httpServer).post('/api/v1/context/events')).send({
      event_type: 'task_started',
      project_id: missingId,
      summary: 'some task',
    });
    assert.strictEqual(eventsRes.status, 404, JSON.stringify(eventsRes.body));
    assert.strictEqual(eventsRes.body.error, 'project_not_found');
  });

  await t.test('/active?format=json returns the raw context, matching inject\'s shape', async () => {
    // The MCP client has always sent format=json to /active (client.getContextJson
    // with no projectId), but the route never implemented it — the request fell
    // through to the brief payload, which has no `context` object at all. Anything
    // reading structured fields off it saw nothing: manage_todos reported an empty
    // board forever and could never match a card to move.
    const activeJson = await auth(
      request(httpServer).get('/api/v1/context/active').query({ format: 'json', cwd: '/tmp/atlas-cwd' }),
    );
    assert.strictEqual(activeJson.status, 200, JSON.stringify(activeJson.body));

    // The envelope is TOTAL: format=json always answers with a `context` key,
    // null when nothing resolved. Without this the no-project case fell through
    // to the brief payload and the client had to guess the shape again.
    assert.ok('context' in activeJson.body, 'format=json must always return a context key');
    assert.strictEqual(activeJson.body.brief, undefined, 'must not fall through to the brief payload');

    // When a project did resolve, the shape must match inject's exactly.
    if (activeJson.body.context) {
      const ctx = activeJson.body.context;
      assert.ok(ctx.project_id, 'context must carry project_id');
      assert.ok(ctx.project_name, 'context must carry project_name');

      const injectJson = await auth(
        request(httpServer).get(`/api/v1/context/projects/${ctx.project_id}/inject`).query({ format: 'json' }),
      );
      assert.strictEqual(injectJson.status, 200);
      assert.deepStrictEqual(
        Object.keys(activeJson.body).sort(),
        Object.keys(injectJson.body).sort(),
        'both endpoints must return the same envelope keys',
      );
    }
  });

  await t.test('a card body survives both write paths and never rides along in a brief', async () => {
    // Two independent ways a card reaches the board, and a body has to work on
    // both: POST /events (what the MCP dispatchers call) and PATCH .../context
    // (what the dashboard calls). A body accepted by one and dropped by the
    // other is the same half-ship as a feature landing on one dispatcher.
    const eventRes = await auth(request(httpServer).post('/api/v1/context/events')).send({
      event_type: 'todo_added',
      project_id: projectId,
      summary: 'Added 2 cards',
      metadata: {
        todos: [
          'A bare title',
          { title: 'A specced card', body: 'SPEC-DETAIL: touch apps/api/src/routes/mcp.js first.', phase: 'in_progress' },
        ],
      },
    });
    assert.strictEqual(eventRes.status, 202, JSON.stringify(eventRes.body));

    const patchRes = await auth(request(httpServer).patch(`/api/v1/context/projects/${projectId}/context`)).send({
      add_todos: [{ title: 'A patched card', body: 'PATCH-DETAIL: dashboard writes land here.' }],
    });
    assert.strictEqual(patchRes.status, 200, JSON.stringify(patchRes.body));

    const json = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({ format: 'json' }),
    );
    assert.strictEqual(json.status, 200);
    const cards = json.body.context.todo_items || [];
    const bare = cards.find((c) => c.title === 'A bare title');
    const specced = cards.find((c) => c.title === 'A specced card');
    const patched = cards.find((c) => c.title === 'A patched card');
    assert.ok(bare, 'the bare-title form must still create a card');
    assert.strictEqual(bare.body, undefined, 'a bare title must not invent a body');
    assert.match(specced.body, /SPEC-DETAIL/);
    assert.strictEqual(specced.phase, 'in_progress', 'a per-card phase must survive the event path');
    assert.match(patched.body, /PATCH-DETAIL/);

    // A body written after the card exists — the normal case, since a card is
    // filed before it is specced.
    const second = await auth(request(httpServer).patch(`/api/v1/context/projects/${projectId}/context`)).send({
      add_todos: [{ title: 'A bare title', body: 'LATE-DETAIL: added after the fact.' }],
    });
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    const after = (await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({ format: 'json' }),
    )).body.context.todo_items;
    const relisted = after.filter((c) => c.title === 'A bare title');
    assert.strictEqual(relisted.length, 1, 'a re-add must update the card, not duplicate it');
    assert.match(relisted[0].body, /LATE-DETAIL/);

    // The brief is the token-sensitive surface this feature exists to protect.
    // It may say a card HAS detail; it must never carry the detail itself.
    // NOTE: this route's own section allow-list has no 'board'/'todos' entry
    // (unlike /active's), so the board is only reachable here through 'all'.
    const brief = await auth(
      request(httpServer).get(`/api/v1/context/projects/${projectId}/inject`).query({ sections: 'all' }),
    );
    assert.strictEqual(brief.status, 200);
    const briefText = JSON.stringify(brief.body);
    assert.ok(!briefText.includes('SPEC-DETAIL'), 'the brief inlined a card body');
    assert.ok(!briefText.includes('PATCH-DETAIL'), 'the brief inlined a card body');
    assert.ok(briefText.includes('+body'), 'the brief does not mark which cards carry detail');
  });

  await t.test('/active?format=json returns {context:null} when no project resolves', async () => {
    const res = await auth(
      request(httpServer).get('/api/v1/context/active').query({ format: 'json', cwd: '/nonexistent/unmatched/path-xyz' }),
    );
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.ok('context' in res.body, 'context key must be present even with no match');
    assert.strictEqual(res.body.brief, undefined);
  });

  await closeRedisConnections();
  await db.pool.end();
});
