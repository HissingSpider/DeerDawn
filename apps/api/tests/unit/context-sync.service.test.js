const test = require('node:test');
const assert = require('node:assert');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return {
    org_id: 'org-system',
    id: 'system-key',
  };
}

test('context sync service creates projects, applies deltas, renders injections, resolves matches, and updates preferences', async (t) => {
  await store.clearAll();

  let session;
  const project = await service.createProject(actor(), {
    project_name: 'Atlas',
    description: 'Cross-tool AI workspace for a long-running software project.',
    goals: ['Keep Claude and ChatGPT aligned', 'Inject code context into Cursor'],
    current_status: 'Founder validating the MVP sync loop.',
    tech_stack: ['TypeScript', 'Next.js', 'Node.js'],
    recurring_context: ['Prefer concise prompts', 'Do not duplicate project setup'],
  });

  await t.test('project bootstraps canonical context fields', () => {
    assert.ok(project.project_id);
    assert.strictEqual(project.context.project_name, 'Atlas');
    assert.strictEqual(project.context.current_task, '');
    assert.strictEqual(project.events.length, 1);
  });

  await t.test('service can create and bind sessions separately from active project UI state', async () => {
    session = await service.upsertSession(actor(), 'browser-tab-1', {
      tool: 'claude_web',
      surface_type: 'browser',
      conversation_ref: 'https://claude.ai/chat/session-a',
      host: 'claude.ai',
      tab_id: 'tab-1',
      status: 'active',
    });

    assert.strictEqual(session.session_id, 'browser-tab-1');
    assert.strictEqual(session.project_id, null);
  });

  const updated = await service.applyExtraction(actor(), {
    session_id: 'browser-tab-1',
    tool: 'claude_web',
    chunks: [{
      role: 'assistant',
      text: 'We decided to keep raw conversation text flowing through the desktop app to cloud extraction with minimal retention.',
    }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.94,
      project_candidate: {
        project_id: project.project_id,
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

  await t.test('extraction appends a structured event and merges the delta', () => {
    assert.strictEqual(updated.project.context.current_status, 'Privacy posture locked for V1 extraction.');
    assert.strictEqual(updated.project.events.length, 2);
  });

  await t.test('session becomes bound to the extracted project', async () => {
    const bound = await service.getSession(actor(), 'browser-tab-1');
    assert.ok(bound);
    assert.strictEqual(bound.project_id, project.project_id);
    assert.strictEqual(bound.status, 'active');
  });

  await t.test('browser injection stays conversational and compact', async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', 'standard');
    assert.strictEqual(payload.format, 'conversational');
    assert.match(payload.body, /Project: Atlas/);
    assert.ok(payload.body.split('\n').length <= 8);
  });

  await t.test('Cursor injection stays code-oriented', async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'cursor', 'detailed');
    assert.strictEqual(payload.format, 'code');
    assert.match(payload.body, /Tech stack:/);
    assert.match(payload.body, /Recent decisions:/);
    assert.ok(Array.isArray(payload.provenance));
  });

  await t.test('graph retrieval exposes project-linked nodes and related evidence', async () => {
    const graph = await service.getProjectGraph(actor(), project.project_id);
    assert.ok(graph.nodes.length >= 2, 'expected project node plus derived graph nodes');
    assert.ok(graph.edges.length >= 1, 'expected project graph edges');
    assert.ok(graph.evidence.length >= 1, 'expected evidence rows');
  });

  await t.test('session graph pulls related project context from the broader owner graph', async () => {
    const relatedProject = await service.createProject(actor(), {
      project_name: 'Beacon',
      description: 'Adjacent product that shares the same repo.',
      tech_stack: ['TypeScript', 'Node.js'],
      file_structure_summary: ['apps/api/src/services/contextGraphService.js'],
      current_task: 'Unify graph retrieval across products.',
    });

    await service.upsertSession(actor(), 'codex-workspace-2', {
      tool: 'codex',
      surface_type: 'cli',
      cwd: '/Users/dev/Desktop/deerdawn-api',
      status: 'active',
    });

    await service.applyExtraction(actor(), {
      session_id: 'codex-workspace-2',
      tool: 'codex',
      session_context: {
        cwd: '/Users/dev/Desktop/deerdawn-api',
        status: 'active',
      },
      chunks: [{
        role: 'assistant',
        text: 'The Beacon project also depends on the shared deerdawn-api monorepo and the context graph service.',
      }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.96,
        project_candidate: {
          project_id: relatedProject.project_id,
          project_name: 'Beacon',
          reason: 'same repo and graph service references',
        },
        delta: {
          current_status: 'Graph retrieval now spans shared repo memory.',
          file_structure_summary: ['apps/api/src/services/contextGraphService.js'],
        },
        should_create_project: false,
        needs_user_confirmation: false,
      },
    });

    const sessionGraph = await service.getSessionGraph(actor(), 'browser-tab-1');
    assert.ok(sessionGraph.related_project_ids.includes(relatedProject.project_id), 'expected related project from shared graph memory');
  });

  await t.test('low-confidence matching requires confirmation', () => {
    const match = service.resolveMatch({
      tool: 'chatgpt_web',
      project_hint: 'Atlas',
      candidates: [
        { project_id: project.project_id, project_name: 'Atlas', score: 0.52 },
        { project_id: 'project-other', project_name: 'Beacon', score: 0.48 },
      ],
    });

    assert.strictEqual(match.needs_user_confirmation, true);
    assert.strictEqual(match.match_decision, 'ambiguous');
  });

  await t.test('preferences preserve pause state and per-tool overrides', async () => {
    const preferences = await service.updatePreferences(actor(), {
      paused: true,
      tools: {
        claude_web: { enabled: true, verbosity: 'standard' },
        chatgpt_web: { enabled: false, verbosity: 'light' },
        cursor: { enabled: true, verbosity: 'detailed' },
      },
    });

    assert.strictEqual(preferences.paused, true);
    assert.strictEqual(preferences.tools.chatgpt_web.enabled, false);
    assert.strictEqual(preferences.tools.cursor.verbosity, 'detailed');
  });

  await t.test('paused or disabled tools suppress rendered injection', async () => {
    const browserPayload = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', 'standard');
    const cursorPayload = await service.renderInjection(actor(), project.project_id, 'cursor', 'detailed');
    assert.strictEqual(browserPayload, null);
    assert.strictEqual(cursorPayload, null);
  });

  await t.test('global context persists independently of projects', async () => {
    const global = await service.updateGlobalContext(actor(), {
      user_profile: 'Solo technical founder building a context sync platform.',
      preferences: ['be concise'],
      recurring_instructions: ['prefer TypeScript'],
      global_stack: ['TypeScript', 'Node.js', 'PostgreSQL'],
    });

    assert.strictEqual(global.user_profile, 'Solo technical founder building a context sync platform.');
    assert.deepStrictEqual(global.preferences, ['be concise']);
  });

  await t.test('workspace entities can be upserted and retrieved as a layered overview', async () => {
    const upserted = await service.upsertWorkspaceEntities(actor(), {
      entities: [
        {
          entity_type: 'knowledge',
          title: 'Layered startup summaries',
          summary: 'Give agents a compact brief first, then more detailed sections.',
        },
        {
          entity_type: 'tool',
          title: 'Codex',
          summary: 'Primary coding agent surface.',
          metadata: { category: 'agent' },
        },
        {
          entity_type: 'capability',
          title: 'Workspace overview retrieval',
          summary: 'Returns projects, knowledge, tools, and capabilities together.',
          project_id: project.project_id,
        },
      ],
      relations: [
        {
          from_canonical_key: 'knowledge:layered-startup-summaries',
          to_canonical_key: 'capability:workspace-overview-retrieval',
          relation_type: 'supports',
          summary: 'The retrieval format follows this knowledge.',
        },
      ],
    });

    assert.strictEqual(upserted.entities.length, 3);

    const overview = await service.getWorkspaceOverview(actor(), {
      verbosity: 'standard',
      include: ['projects', 'knowledge', 'tools', 'capabilities'],
    });

    assert.ok(overview.projects.length >= 1);
    assert.ok(overview.knowledge.some((node) => node.title === 'Layered startup summaries'));
    assert.ok(overview.tools.some((node) => node.title === 'Codex'));
    assert.ok(overview.capabilities.some((node) => node.title === 'Workspace overview retrieval'));
    assert.ok(overview.summary.now.length >= 1);
    assert.strictEqual(overview.layers.direct_context.id, 'direct_context');
    assert.strictEqual(overview.layers.passive_enrichment.id, 'passive_enrichment');
    assert.strictEqual(overview.layers.intelligence.id, 'intelligence');
    assert.ok(overview.layers.direct_context.highlights.length >= 1);
  });

  await t.test('structured question answers fuzzy-resolve open questions into decisions', async () => {
    await service.updateProjectContext(actor(), project.project_id, {
      open_questions: [
        'Decide whether question tracking belongs in extraction or structured events',
      ],
      recent_decisions: [],
    });

    await service.applyStructuredContextEvent(actor(), {
      event_type: 'question_answered',
      project_id: project.project_id,
      summary: 'Use both: structured events for explicit agent updates, extraction for conversational discovery.',
      metadata: {
        question: 'question tracking belongs in extraction or structured events',
        surface: 'codex',
      },
    });

    const refreshed = await service.getProject(actor(), project.project_id);
    assert.deepStrictEqual(refreshed.context.open_questions, []);
    assert.ok(refreshed.context.recent_decisions.some((decision) => (
      /Use both: structured events/.test(decision.summary)
      && /question tracking belongs/.test(decision.reasoning)
    )));
  });

  await t.test('next-best context prioritizes open questions as pending decisions', async () => {
    await service.updateProjectContext(actor(), project.project_id, {
      current_task: 'Improve context MCP planning memory',
      open_questions: [
        'Decide whether open questions should be durable graph nodes immediately',
        'Decide how agents should ask for pending decisions',
      ],
    });

    const result = await service.getNextBestContext(actor(), {
      project_id: project.project_id,
      query: 'what decisions do I need to make',
      limit: 5,
    });

    assert.ok(result.suggestions.some((item) => item.kind === 'open_question'));
    assert.match(result.summary, /open question|decision/i);
  });

  await t.test('startup overview exposes open questions in current understanding', async () => {
    await service.updateProjectContext(actor(), project.project_id, {
      open_questions: [
        'Decide whether open questions should be durable graph nodes immediately',
      ],
    });

    const overview = await service.getWorkspaceOverview(actor(), {
      mode: 'startup',
      verbosity: 'standard',
      project_id: project.project_id,
    });

    assert.match(overview.current_understanding.confidence_summary, /open question/i);
    assert.deepStrictEqual(overview.current_understanding.open_questions.slice(0, 1), [
      'Decide whether open questions should be durable graph nodes immediately',
    ]);
  });

  await t.test('suspicious auth probe deltas are ignored before they can pollute a project', async () => {
    await service.updateProjectContext(actor(), project.project_id, {
      current_task: '',
      open_questions: [],
    });

    const suspicious = await service.applyExtraction(actor(), {
      session_id: 'browser-tab-1',
      tool: 'claude_web',
      chunks: [{ role: 'assistant', text: 'connection check only' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.98,
        project_candidate: {
          project_id: project.project_id,
          project_name: 'Atlas',
          reason: 'debug probe against the same workspace',
        },
        delta: {
          current_task: 'auth probe',
          source_summary: 'connection check',
          goals: ['Develop authentication system'],
        },
        should_create_project: false,
        needs_user_confirmation: false,
      },
    });

    assert.strictEqual(suspicious.project.context.current_task, '');
    assert.ok(!suspicious.project.context.goals.includes('Develop authentication system'));
    assert.notStrictEqual(suspicious.project.context.current_status, 'connection check');
  });

  await t.test('project reads auto-repair previously polluted probe/debug context', async () => {
    const polluted = await service.createProject(actor(), {
      project_name: 'DeerDawn',
      description: 'Context sync product.',
      current_task: 'auth probe',
      goals: ['Develop authentication system', 'Open self-serve public launch'],
      current_status: 'shipping rapidly, in early access',
    });
    polluted.linked_paths = ['/Users/dev/Desktop/deerdawn'];
    polluted.context.source_summary = 'The mention of auth probe suggests a focus on authentication.';
    await store.saveProject(polluted);

    const repaired = await service.getProject(actor(), polluted.project_id);
    assert.strictEqual(repaired.context.current_task, '');
    assert.strictEqual(repaired.context.source_summary, '');
    assert.deepStrictEqual(repaired.context.goals, ['Open self-serve public launch']);
    assert.strictEqual(repaired.context.project_name, 'DeerDawn');
  });

  await t.test('project reads auto-repair legacy context shapes into schema-safe structures', async () => {
    const legacy = await service.createProject(actor(), {
      project_name: 'Legacy Atlas',
      description: 'Legacy schema migration check.',
      current_status: 'Bootstrapping',
    });
    legacy.linked_paths = ['/Users/dev/Desktop/deerdawn'];
    legacy.context.last_updated = 'not-a-date';
    legacy.context.recent_decisions = ['Switched to Postgres'];
    legacy.context.commands = ['npm test'];
    legacy.context.debugging_notes = ['Retry auth flow if token expires'];
    await store.saveProject(legacy);

    const repaired = await service.getProject(actor(), legacy.project_id);
    assert.match(repaired.context.last_updated, /^\d{4}-\d{2}-\d{2}T/);
    assert.strictEqual(repaired.context.recent_decisions[0].summary, 'Switched to Postgres');
    assert.strictEqual(repaired.context.commands[0].run, 'npm test');
    assert.ok(repaired.context.commands[0].label.startsWith('cmd_'));
    assert.strictEqual(repaired.context.debugging_notes[0].summary, 'Retry auth flow if token expires');
  });

  await closeRedisConnections();
  await db.pool.end();
});

test('rankWorkspaceNodes rewards retrieval usage and decays never-used stale nodes', () => {
  const recentIso = new Date().toISOString();
  const oldIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  // Weak base nodes (low confidence, workspace-scoped) so the total score stays
  // below the Math.min(1,...) cap and the usage/decay terms are actually decisive.
  const baseNode = (overrides) => ({
    node_id: `n_${Math.random().toString(36).slice(2)}`,
    project_id: null,
    node_type: 'knowledge',
    title: 'Same title',
    summary: 'Same summary',
    confidence: 0.3,
    last_seen_at: recentIso,
    metadata: { memory_tier: 'durable' },
    ...overrides,
  });

  // (a) Two identical nodes differing only in retrieval_hits — the used one ranks higher.
  const used = baseNode({ node_id: 'used', metadata: { memory_tier: 'durable', retrieval_hits: 8 } });
  const unused = baseNode({ node_id: 'unused', metadata: { memory_tier: 'durable', retrieval_hits: 0 } });
  const ranked = service.rankWorkspaceNodes([unused, used], {});
  assert.strictEqual(ranked[0].node_id, 'used', 'frequently-retrieved node should rank first');

  // (b) A never-used, 60-day-old node is penalized below a fresh never-used node.
  const fresh = baseNode({ node_id: 'fresh', last_seen_at: recentIso, metadata: { memory_tier: 'durable', retrieval_hits: 0 } });
  const stale = baseNode({ node_id: 'stale', last_seen_at: oldIso, metadata: { memory_tier: 'durable', retrieval_hits: 0 } });
  const ranked2 = service.rankWorkspaceNodes([stale, fresh], {});
  assert.strictEqual(ranked2[0].node_id, 'fresh', 'fresh node should outrank a stale never-used node');

  // (c) Pinned/curated stale node is exempt from decay (stays above the fresh one via pin boost).
  const pinnedStale = baseNode({ node_id: 'pinned', last_seen_at: oldIso, metadata: { memory_tier: 'durable', retrieval_hits: 0, pinned: true } });
  const r3 = service.rankWorkspaceNodes([pinnedStale, fresh], {});
  assert.strictEqual(r3[0].node_id, 'pinned', 'pinned node should not be decayed below a fresh node');
});

test('scoreProjectForCwd prefers the deepest matching linked path (monorepo)', () => {
  const updated_at = new Date().toISOString();
  const root = { project_name: 'root', linked_paths: ['/repo'], updated_at };
  const frontend = { project_name: 'frontend', linked_paths: ['/repo/apps/frontend'], updated_at };
  const backend = { project_name: 'backend', linked_paths: ['/repo/apps/backend'], updated_at };

  const cwd = '/repo/apps/frontend';
  const scores = [root, frontend, backend]
    .map((p) => ({ name: p.project_name, score: service.scoreProjectForCwd(p, cwd) }))
    .sort((a, b) => b.score - a.score);
  assert.strictEqual(scores[0].name, 'frontend', 'deepest matching sub-package should win over the root project');
  assert.ok(scores.find((s) => s.name === 'backend').score < scores.find((s) => s.name === 'root').score,
    'a non-matching sibling package should not outrank the root');

  // Boundary-safe: /repo/app must not match a project linked to /repo/apple
  const apple = { project_name: 'apple', linked_paths: ['/repo/apple'], updated_at };
  const appScore = service.scoreProjectForCwd(apple, '/repo/app');
  assert.ok(appScore < 1.1, 'prefix match must respect path boundaries');
});
