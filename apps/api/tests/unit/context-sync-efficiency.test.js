const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_REDIS = 'true';

const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const graphService = require('../../src/services/contextGraphService');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return {
    org_id: 'org-system',
    id: 'system-key',
  };
}

function makeProject() {
  return {
    project_id: 'project-atlas',
    owner_key: 'org-system',
    project_name: 'Atlas',
    aliases: [],
    linked_paths: [],
    linked_conversations: [],
    context: {
      project_name: 'Atlas',
      description: 'Cross-tool AI workspace.',
      goals: [],
      current_status: 'Founder validating the MVP sync loop.',
      recent_decisions: [],
      recurring_context: [],
      tech_stack: [],
      file_structure_summary: [],
      current_task: '',
      open_questions: [],
      last_updated: '2026-05-10T00:00:00.000Z',
      source_summary: 'Created by tests',
    },
    events: [{
      event_id: 'evt-created',
      project_id: 'project-atlas',
      source_type: 'system',
      source_id: 'context-api',
      event_kind: 'project_created',
      delta: {},
      confidence: 1,
      created_at: '2026-05-10T00:00:00.000Z',
    }],
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
  };
}

// applyExtraction stamps context.last_active_tool/last_active_host so a later session in
// a different tool can render a "resuming from …" handoff line — and a mismatch counts as
// a material change, forcing a write. Extraction tests that assert "nothing was written"
// must therefore start from a project already stamped with the tool they replay, or the
// stamp alone trips the assertion. Injection tests deliberately do NOT use this: they
// render a different tool on purpose, and seeding a match would hide the handoff line.
function seedActiveTool(project, tool, host) {
  project.context.last_active_tool = tool;
  project.context.last_active_host = host;
  project.context.tool_presence = { [tool]: { last_seen_at: '2026-05-10T00:00:00.000Z', host } };
  return project;
}

function makeSession() {
  return {
    session_id: 'session-atlas',
    owner_key: 'org-system',
    tool: 'claude_web',
    surface_type: 'browser',
    project_id: null,
    conversation_ref: 'conv-1',
    cwd: '',
    host: 'claude.ai',
    tab_id: 'tab-1',
    status: 'active',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  };
}

function withStubs(overrides, fn) {
  const originals = {};
  const storeStubs = { ...(overrides.store || {}) };

  // The injection path reads the project through store.getProjectContextOnly (via
  // getProjectForInjection), not store.getProject. These tests only ever stubbed
  // getProject, so getProjectContextOnly fell through to the real database, found no
  // 'project-atlas' row, and renderInjection returned null — every assertion then died
  // on `Cannot read properties of null`. Mirror the stub unless a test sets it
  // explicitly, so both read paths see the same fixture.
  if (storeStubs.getProject && !storeStubs.getProjectContextOnly) {
    storeStubs.getProjectContextOnly = (...args) => storeStubs.getProject(...args);
  }

  for (const [key, value] of Object.entries(storeStubs)) {
    originals[`store:${key}`] = store[key];
    store[key] = value;
  }
  for (const [key, value] of Object.entries(overrides.graph || {})) {
    originals[`graph:${key}`] = graphService[key];
    graphService[key] = value;
  }

  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [compoundKey, value] of Object.entries(originals)) {
        const [target, key] = compoundKey.split(':');
        if (target === 'store') store[key] = value;
        if (target === 'graph') graphService[key] = value;
      }
    });
}

test('no material change extraction skips context event and graph churn', async () => {
  const project = makeProject();
  seedActiveTool(project, 'claude_web', 'claude.ai');
  const session = makeSession();
  let saveProjectCalls = 0;
  let appendEventCalls = 0;

  await withStubs({
    store: {
      getSession: async () => session,
      saveSession: async (next) => ({ ...session, ...next }),
      getProject: async () => project,
      saveProject: async () => { saveProjectCalls += 1; },
      appendEvent: async () => { appendEventCalls += 1; },
    },
    graph: {
      recordGraphArtifacts: async () => {
        throw new Error('graph should not be written');
      },
    },
  }, async () => {
    const result = await service.applyExtraction(actor(), {
      session_id: 'session-atlas',
      tool: 'claude_web',
      chunks: [{ role: 'assistant', text: 'Repeating the same status update again.' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.95,
        project_candidate: {
          project_id: project.project_id,
          project_name: 'Atlas',
          reason: 'same project',
        },
        delta: {},
        should_create_project: false,
        needs_user_confirmation: false,
        no_material_change: true,
      },
    });

    assert.equal(saveProjectCalls, 0);
    assert.equal(appendEventCalls, 0);
    assert.deepEqual(result.graph, { nodes: [], edges: [], evidence: [] });
    assert.equal(result.project.events.length, 1);
  });
});

test('default browser injection is light and token-budgeted', async () => {
  const project = makeProject();
  project.context.description = 'Cross-tool AI workspace for a long-running software project.';
  project.context.current_task = 'Reduce token usage';
  project.context.recurring_context = ['Prefer concise prompts', 'Keep the architecture simple', 'Avoid duplicate setup'];
  project.context.recent_decisions = [
    { summary: 'Use compact context digests', decided_at: '2026-05-09T00:00:00.000Z' },
    { summary: 'Skip graph writes on no-op updates', decided_at: '2026-05-09T01:00:00.000Z' },
    { summary: 'Keep gpt-4o-mini for now', decided_at: '2026-05-09T02:00:00.000Z' },
  ];

  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => null,
      getProject: async () => project,
    },
    graph: {
      getProjectGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => [],
    },
  }, async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'chatgpt_web');

    assert.equal(payload.verbosity, 'light');
    assert.ok(payload.body.split('\n').length <= 7, 'browser injection should stay compact');
  });
});

test('browser injection keeps task and status before description and excessive global context', async () => {
  const project = makeProject();
  project.context.description = 'This is a long explanation of the project and its nuances that should lose priority once token pressure increases.';
  project.context.current_task = 'Reduce token usage without making the product feel dumber';
  project.context.current_status = 'Testing stricter browser-side prompt budgets';
  project.context.recurring_context = ['Prefer concise prompts', 'Do not repeat setup', 'Keep outputs actionable'];
  project.context.recent_decisions = [
    { summary: 'Trim secondary context first', decided_at: '2026-05-09T00:00:00.000Z' },
    { summary: 'Preserve task and status', decided_at: '2026-05-09T01:00:00.000Z' },
  ];

  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => ({
        user_profile: 'Solo founder building several AI products with a lot of repeated preferences and long global context.',
        preferences: ['be concise', 'prefer TypeScript', 'avoid overengineering'],
        recurring_instructions: ['always keep answers high signal', 'optimize for token cost'],
        global_stack: [],
      }),
      getProject: async () => project,
    },
    graph: {
      getProjectGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => [],
    },
  }, async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'chatgpt_web');

    assert.match(payload.body, /Current task:/);
    assert.match(payload.body, /Current status:/);
    assert.doesNotMatch(payload.body, /What it is:/);
    assert.ok(!payload.body.includes('My preferences: be concise | prefer TypeScript | avoid overengineering'), 'long global context should not crowd out project-critical lines');
  });
});

test('default code injection is light and keeps current task visible', async () => {
  const project = makeProject();
  project.context.current_task = 'Reduce token usage';
  project.context.tech_stack = ['TypeScript', 'Node.js', 'PostgreSQL', 'Electron', 'Redis'];
  project.context.file_structure_summary = [
    'apps/api/src/services/extractionService.js',
    'apps/api/src/services/contextSyncService.js',
    'apps/desktop/src/bridge.ts',
    'packages/shared-context/src/index.js',
  ];
  project.context.recent_decisions = [
    { summary: 'Use compact context digests', decided_at: '2026-05-09T00:00:00.000Z' },
    { summary: 'Skip graph writes on no-op updates', decided_at: '2026-05-09T01:00:00.000Z' },
  ];

  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => null,
      getProject: async () => project,
    },
    graph: {
      getProjectGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => [],
    },
  }, async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'codex');

    assert.equal(payload.verbosity, 'light');
    assert.match(payload.body, /Current task: Reduce token usage/);
    assert.ok(payload.body.split('\n').length <= 9, 'code injection should stay compact by default');
  });
});

test('workspace overview prefers higher-importance and project-relevant entities', async () => {
  const project = makeProject();
  project.context.current_task = 'Ship smarter startup context';
  project.context.current_status = 'Ranking workspace entities by relevance.';

  await withStubs({
    store: {
      listProjects: async () => [project],
      listGraphNodes: async () => ([
        {
          node_id: 'node-important',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'knowledge',
          canonical_key: 'knowledge:startup-ranking',
          title: 'Startup ranking',
          summary: 'Rank context by active task and importance.',
          metadata: { entity_type: 'knowledge', importance: 'high', scope: 'project' },
          confidence: 0.91,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
        {
          node_id: 'node-low',
          owner_key: 'org-system',
          project_id: null,
          node_type: 'knowledge',
          canonical_key: 'knowledge:old-note',
          title: 'Old note',
          summary: 'Generic archival memory.',
          metadata: { entity_type: 'knowledge', importance: 'low', scope: 'workspace' },
          confidence: 0.55,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-04-01T00:00:00.000Z',
          updated_at: '2026-04-01T00:00:00.000Z',
          last_seen_at: '2026-04-01T00:00:00.000Z',
        },
      ]),
    },
  }, async () => {
    const overview = await service.getWorkspaceOverview(actor(), {
      verbosity: 'standard',
      include: ['projects', 'knowledge'],
      project_id: project.project_id,
    });

    assert.equal(overview.knowledge[0].canonical_key, 'knowledge:startup-ranking');
    assert.match(overview.text, /Startup ranking/);
    assert.equal(overview.layers.direct_context.id, 'direct_context');
    assert.equal(overview.layers.passive_enrichment.id, 'passive_enrichment');
    assert.equal(overview.layers.intelligence.id, 'intelligence');
    assert.match(overview.layers.intelligence.summary, /Ranking|packaging|deduplication/i);
    assert.equal(overview.current_understanding.current_task, 'Ship smarter startup context');
    assert.ok(Array.isArray(overview.passive_enrichments));
    assert.ok(Array.isArray(overview.selection_explanations));
  });
});

test('workspace overview ranks durable memory above candidate memory by default', async () => {
  const project = makeProject();
  project.context.current_task = 'Make automatic memory feel seamless';

  await withStubs({
    store: {
      listProjects: async () => [project],
      listGraphNodes: async () => ([
        {
          node_id: 'node-durable',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'knowledge',
          canonical_key: 'knowledge:durable-memory',
          title: 'Durable memory',
          summary: 'Stable decision carried forward automatically.',
          metadata: { entity_type: 'knowledge', importance: 'normal', scope: 'project', memory_tier: 'durable' },
          confidence: 0.82,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
        {
          node_id: 'node-candidate',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'knowledge',
          canonical_key: 'knowledge:candidate-memory',
          title: 'Candidate memory',
          summary: 'Ambient note kept around for future recall.',
          metadata: { entity_type: 'knowledge', importance: 'high', scope: 'project', memory_tier: 'candidate' },
          confidence: 0.92,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
      ]),
    },
  }, async () => {
    const result = await service.getWorkspaceEntities(actor(), {
      project_id: project.project_id,
      limit: 5,
    });

    assert.equal(result[0].canonical_key, 'knowledge:durable-memory');
    assert.equal(result[1].canonical_key, 'knowledge:candidate-memory');
  });
});

test('workspace retrieval increments selection signals and promotes candidate memory after repeated wins', async () => {
  const project = makeProject();
  project.context.current_task = 'Keep automatic memory without extra user work';
  const writes = [];
  const candidateNode = {
    node_id: 'node-candidate',
    owner_key: 'org-system',
    project_id: project.project_id,
    node_type: 'knowledge',
    canonical_key: 'knowledge:ambient-library-memory',
    title: 'Ambient library memory',
    summary: 'Imported context that keeps surfacing for the active workspace.',
    metadata: {
      entity_type: 'knowledge',
      importance: 'high',
      scope: 'project',
      memory_tier: 'candidate',
      retrieval_hits: 1,
      source_kind: 'imported',
    },
    confidence: 0.93,
    source_session_id: 'sess',
    source_tool: 'codex',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  };

  await withStubs({
    store: {
      listProjects: async () => [project],
      listGraphNodes: async () => [candidateNode],
      getGraphNodeByCanonicalKey: async () => candidateNode,
      // Selection reads the STORED row by id and writes only its own fields
      // (scan 20): never through upsertGraphNode, which would carry a reader's
      // redacted copy of the node back over the stored one.
      listGraphNodesByIds: async (_ownerKey, ids) => (ids.includes(candidateNode.node_id) ? [candidateNode] : []),
      recordGraphNodeSelections: async (_ownerKey, selections) => {
        writes.push(...selections);
        return selections;
      },
      upsertGraphNode: async () => {
        throw new Error('selection tracking must not upsert the node');
      },
    },
  }, async () => {
    const result = await service.getWorkspaceEntities(actor(), {
      project_id: project.project_id,
      limit: 5,
    });

    assert.equal(result[0].canonical_key, 'knowledge:ambient-library-memory');
    assert.ok(writes.length >= 1);
    assert.equal(writes[0].node_id, 'node-candidate');
    assert.deepEqual(Object.keys(writes[0]).sort(), ['confidence', 'metadata', 'node_id'], 'no title, summary or content travels with a selection');
    assert.equal(writes[0].metadata.retrieval_hits, 2);
    assert.equal(writes[0].metadata.memory_tier, 'durable');
    assert.equal(writes[0].metadata.curation_state, 'promoted');
    assert.ok(writes[0].metadata.last_selected_at);
  });
});

test('workspace overview builds passive enrichments and current understanding from imported and global context', async () => {
  const project = makeProject();
  project.context.current_task = 'Make passive enrichments feel seamless';
  project.context.current_status = 'Merging direct context with ambient signals.';
  project.context.source_summary = 'Working on enrichment ranking in the workspace overview.';
  project.context.recent_decisions = [{ summary: 'Direct context should outrank ambient context.', decided_at: '2026-05-10T00:00:00.000Z' }];
  project.context.hot_paths = [{ label: 'runtime', path: 'apps/api/src/services/contextSyncService.js', purpose: 'ranking and packaging' }];

  await withStubs({
    store: {
      listProjects: async () => [project],
      listGraphNodes: async () => ([
        {
          node_id: 'node-imported',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'knowledge',
          canonical_key: 'knowledge:notion-roadmap',
          title: 'Notion roadmap',
          summary: 'Imported planning notes for the active workspace.',
          metadata: { entity_type: 'knowledge', importance: 'high', scope: 'project', source_kind: 'imported', source: 'notion' },
          confidence: 0.92,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
      ]),
      getGlobal: async () => ({
        user_profile: 'Solo founder building DeerDawn',
        preferences: ['be concise', 'prefer TypeScript'],
      }),
    },
  }, async () => {
    const overview = await service.getWorkspaceOverview(actor(), {
      verbosity: 'standard',
      include: ['projects', 'knowledge', 'capabilities'],
      project_id: project.project_id,
    });

    assert.ok(overview.passive_enrichments.some((item) => item.title === 'Notion roadmap'));
    assert.ok(overview.passive_enrichments.some((item) => item.source === 'global context'));
    assert.equal(overview.current_understanding.current_task, 'Make passive enrichments feel seamless');
    assert.ok(overview.current_understanding.relevant_enrichments.length >= 1);
    assert.match(overview.current_understanding.confidence_summary, /direct task is set/i);
    assert.ok(overview.selection_explanations.some((item) => item.kind === 'enrichment'));
  });
});

test('applyExtraction auto-promotes durable and candidate workspace memory', async () => {
  const project = makeProject();
  const savedNodes = [];
  let session = {
    session_id: 'session-auto-memory',
    owner_key: 'org-system',
    tool: 'claude_web',
    surface_type: 'browser',
    project_id: project.project_id,
    conversation_ref: 'conv-1',
    cwd: '/Users/dev/Desktop/deerdawn',
    host: 'claude.ai',
    tab_id: 'tab-1',
    status: 'active',
    routing_state: 'matched',
    match_confidence: 0.95,
    last_confirmed_at: '2026-05-10T00:00:00.000Z',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  };

  await withStubs({
    store: {
      getSession: async () => session,
      saveSession: async (next) => { session = { ...session, ...next }; return session; },
      getProject: async () => project,
      saveProject: async (next) => Object.assign(project, next),
      appendEvent: async (event) => {
        project.events = [...(project.events || []), event];
      },
      upsertGraphNode: async (node) => {
        savedNodes.push(node);
        return node;
      },
      upsertGraphEmbedding: async () => null,
      getGraphNodeByCanonicalKey: async () => null,
      getGlobal: async () => null,
    },
    graph: {
      recordGraphArtifacts: async () => ({ nodes: [], edges: [], evidence: [] }),
    },
  }, async () => {
    await service.applyExtraction(actor(), {
      session_id: 'session-auto-memory',
      tool: 'claude_web',
      chunks: [{ role: 'assistant', text: 'We should keep this decision and startup note automatically.' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.91,
        project_candidate: {
          project_id: project.project_id,
          project_name: project.project_name,
          reason: 'Active project match',
        },
        delta: {
          current_task: 'Make memory promotion automatic',
          source_summary: 'User wants the system to remember startup context automatically without repeated prompting.',
          recent_decisions: [{
            summary: 'Use hybrid durable and candidate memory tiers.',
            decided_at: '2026-05-25T00:00:00.000Z',
            importance: 'high',
          }],
        },
        should_create_project: false,
        needs_user_confirmation: false,
      },
    });

    assert.ok(savedNodes.some((node) => node.metadata?.memory_tier === 'durable' && /hybrid durable and candidate memory tiers/i.test(node.title)));
    assert.ok(savedNodes.some((node) => node.metadata?.memory_tier === 'durable' && /make memory promotion automatic/i.test(node.title)));
    assert.ok(savedNodes.some((node) => node.metadata?.memory_tier === 'candidate'));
  });
});

test('next best context suggests ranked entities and follow-up queries', async () => {
  const project = makeProject();
  project.context.current_task = 'Ship smarter startup context';
  project.updated_at = '2026-05-10T00:00:00.000Z';
  const session = {
    session_id: 'codex-session',
    owner_key: 'org-system',
    tool: 'codex',
    surface_type: 'cli',
    project_id: project.project_id,
    conversation_ref: 'conv-atlas',
    cwd: '/Users/dev/Desktop/deerdawn',
    host: '',
    tab_id: '',
    status: 'active',
    routing_state: 'matched',
    match_confidence: 0.98,
    last_confirmed_at: '2026-05-10T00:00:00.000Z',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  };

  await withStubs({
    store: {
      listProjects: async () => [project],
      listSessions: async () => [session],
      listGraphNodes: async () => ([
        {
          node_id: 'node-capability',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'capability',
          canonical_key: 'capability:workspace-overview',
          title: 'Workspace overview retrieval',
          summary: 'Returns projects, knowledge, tools, and capabilities together.',
          metadata: { entity_type: 'capability', importance: 'high', scope: 'project' },
          confidence: 0.94,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
      ]),
    },
  }, async () => {
    const result = await service.getNextBestContext(actor(), {
      tool: 'codex',
      cwd: '/Users/dev/Desktop/deerdawn',
      limit: 3,
    });

    assert.equal(result.suggestions[0].kind, 'entity');
    assert.equal(result.suggestions[0].canonical_key, 'capability:workspace-overview');
    assert.ok(result.suggestions.some((item) => item.kind === 'query'));
    assert.match(result.summary, /confidence/i);
  });
});

test('workspace entity search boosts capabilities for "what can ... do" queries and infers capability candidates from project files', async () => {
  const project = makeProject();
  project.project_name = 'DeerDawn';
  project.context.project_name = 'DeerDawn';
  project.context.current_task = 'Make workspace retrieval smarter';

  await withStubs({
    store: {
      listProjects: async () => [project],
      listSessions: async () => [],
      listGraphNodes: async () => ([
        {
          node_id: 'node-knowledge',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'knowledge',
          canonical_key: 'knowledge:workspace-layer',
          title: 'Workspace layer notes',
          summary: 'General memory about the workspace layer.',
          metadata: { entity_type: 'knowledge', importance: 'high', scope: 'project' },
          confidence: 0.88,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
        {
          node_id: 'node-mcp-route',
          owner_key: 'org-system',
          project_id: project.project_id,
          node_type: 'file',
          canonical_key: 'file:packages/mcp-server/src/tools/context-sync.ts',
          title: 'packages/mcp-server/src/tools/context-sync.ts',
          summary: 'MCP tool definitions for context sync.',
          metadata: { path: 'packages/mcp-server/src/tools/context-sync.ts' },
          confidence: 0.91,
          source_session_id: 'sess',
          source_tool: 'codex',
          created_at: '2026-05-10T00:00:00.000Z',
          updated_at: '2026-05-10T00:00:00.000Z',
          last_seen_at: '2026-05-10T00:00:00.000Z',
        },
      ]),
      getGraphEmbeddings: async () => [],
    },
  }, async () => {
    const result = await service.getWorkspaceEntities(actor(), {
      project_id: project.project_id,
      query: 'what can deerdawn mcp do',
      limit: 5,
    });

    assert.equal(result[0].node_type, 'capability');
    assert.match(result[0].title, /mcp/i);
    assert.equal(result[0].metadata.discovery_source, 'inferred');
    assert.equal(result[0].metadata.surface, 'mcp_tool');
    assert.ok(result.some((node) => node.node_type === 'knowledge'));
  });
});

test('code injection prefers cwd-relevant files and drops stack before task and files', async () => {
  const project = makeProject();
  project.context.current_task = 'Reduce token usage';
  project.context.current_status = 'Working in the API service layer';
  project.context.tech_stack = ['TypeScript', 'Node.js', 'PostgreSQL', 'Electron', 'Redis', 'OpenAI'];
  project.context.file_structure_summary = [
    'apps/marketing/src/pages/index.tsx',
    'apps/api/src/services/contextSyncService.js',
    'apps/api/src/services/extractionService.js',
    'apps/desktop/src/bridge.ts',
  ];
  project.context.recent_decisions = [
    { summary: 'Prioritize relevant files', decided_at: '2026-05-09T00:00:00.000Z' },
  ];

  const session = {
    ...makeSession(),
    session_id: 'session-api-cwd',
    tool: 'codex',
    surface_type: 'cli',
    cwd: '/Users/dev/Desktop/deerdawn-api/apps/api',
    project_id: project.project_id,
  };

  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => null,
      getProject: async () => project,
      getSession: async (_ownerKey, sessionId) => sessionId === 'session-api-cwd' ? session : null,
    },
    graph: {
      getSessionGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => [],
    },
  }, async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'codex', undefined, 'session-api-cwd');

    assert.match(payload.body, /Relevant files:/);
    assert.match(payload.body, /apps\/api\/src\/services\/contextSyncService\.js/);
    assert.match(payload.body, /apps\/api\/src\/services\/extractionService\.js/);
    assert.doesNotMatch(payload.body, /apps\/marketing\/src\/pages\/index\.tsx/);
    assert.doesNotMatch(payload.body, /Tech stack:/);
  });
});

test('renderInjection suppresses identical payloads for the same session', async () => {
  const project = makeProject();
  project.context.current_task = 'Reduce token usage';

  const session = {
    ...makeSession(),
    session_id: 'session-suppress',
    project_id: project.project_id,
  };

  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => null,
      getProject: async () => project,
      getSession: async (_ownerKey, sessionId) => sessionId === 'session-suppress' ? session : null,
    },
    graph: {
      getSessionGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => [],
    },
  }, async () => {
    const first = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', undefined, 'session-suppress');
    const second = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', undefined, 'session-suppress');

    assert.ok(first);
    assert.equal(second, null);
  });
});

test('renderInjection suppresses structurally equivalent payloads when graph line order changes', async () => {
  const project = makeProject();
  project.context.current_task = 'Reduce token usage';

  const session = {
    ...makeSession(),
    session_id: 'session-reordered',
    project_id: project.project_id,
  };

  let graphCall = 0;
  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => null,
      getProject: async () => project,
      getSession: async (_ownerKey, sessionId) => sessionId === 'session-reordered' ? session : null,
    },
    graph: {
      getSessionGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => {
        graphCall += 1;
        return graphCall === 1
          ? ['Knowledge web: task: Reduce token usage | decision: Prefer ranking']
          : ['Knowledge web: decision: Prefer ranking | task: Reduce token usage'];
      },
    },
  }, async () => {
    const first = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', undefined, 'session-reordered');
    const second = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', undefined, 'session-reordered');

    assert.ok(first);
    assert.equal(second, null);
  });
});

test('graph lines prefer fresh high-confidence facts and suppress stale low-confidence ones', () => {
  const lines = graphService.buildGraphLines({
    nodes: [
      {
        node_id: 'node-stale',
        node_type: 'project',
        title: 'Atlas',
        project_id: 'project-atlas',
        confidence: 0.42,
        summary: 'Generic project shell',
        canonical_key: 'project:atlas',
        metadata: {},
        source_session_id: '',
        source_tool: 'claude_web',
        owner_key: 'org-system',
        created_at: '2026-04-01T00:00:00.000Z',
        updated_at: '2026-04-01T00:00:00.000Z',
        last_seen_at: '2026-04-01T00:00:00.000Z',
      },
      {
        node_id: 'node-task',
        node_type: 'task',
        title: 'Reduce token usage without lowering recall',
        project_id: 'project-atlas',
        confidence: 0.94,
        summary: 'Active optimization task',
        canonical_key: 'task:reduce-token-usage',
        metadata: {},
        source_session_id: '',
        source_tool: 'codex',
        owner_key: 'org-system',
        created_at: '2026-05-10T00:00:00.000Z',
        updated_at: '2026-05-10T00:00:00.000Z',
        last_seen_at: '2026-05-10T00:00:00.000Z',
      },
      {
        node_id: 'node-decision',
        node_type: 'decision',
        title: 'Prefer retrieval ranking over larger prompts',
        project_id: 'project-atlas',
        confidence: 0.91,
        summary: 'Recent decision',
        canonical_key: 'decision:retrieval-ranking',
        metadata: {},
        source_session_id: '',
        source_tool: 'codex',
        owner_key: 'org-system',
        created_at: '2026-05-10T00:00:00.000Z',
        updated_at: '2026-05-10T00:00:00.000Z',
        last_seen_at: '2026-05-10T00:00:00.000Z',
      },
    ],
    edges: [],
    evidence: [],
    provenance: [],
    related_project_ids: [],
    summary_lines: [],
  }, 'chatgpt_web', 'light');

  // The fresh, high-confidence decision surfaces...
  assert.ok(lines.some((line) => line.includes('Prefer retrieval ranking over larger prompts')));
  // ...the stale, low-confidence project node is suppressed (the point of this test)...
  assert.ok(lines.every((line) => !line.includes('project: Atlas')));
  // ...and the task node is deliberately absent. buildGraphLines drops task-type nodes
  // ("current task is already in the main brief", contextGraphService.js), so asserting
  // the task appears here contradicts that de-duplication. This assertion originally
  // expected the task line and had been unreachable — every test in this file was dying
  // earlier on a null payload — so the contradiction was never surfaced.
  assert.ok(
    lines.every((line) => !line.includes('Reduce token usage without lowering recall')),
    'task nodes are rendered in the brief, not duplicated into the knowledge web',
  );
});

test('ambiguous session injection falls back to global-only context instead of project details', async () => {
  const project = makeProject();
  project.context.current_task = 'Reduce token usage';
  project.context.current_status = 'Working on project-specific retrieval';

  const session = {
    ...makeSession(),
    session_id: 'session-ambiguous',
    project_id: project.project_id,
    status: 'ambiguous',
  };

  await withStubs({
    store: {
      getPreferences: async () => null,
      savePreferences: async () => {},
      getGlobal: async () => ({
        user_profile: 'Solo founder building invisible context infrastructure.',
        preferences: ['be concise'],
        recurring_instructions: ['prefer TypeScript'],
        global_stack: ['TypeScript', 'Node.js'],
      }),
      getProject: async () => project,
      getSession: async (_ownerKey, sessionId) => sessionId === 'session-ambiguous' ? session : null,
    },
    graph: {
      getSessionGraph: async () => ({ nodes: [], edges: [], evidence: [], provenance: [], related_project_ids: [], summary_lines: [] }),
      buildGraphLines: () => [],
    },
  }, async () => {
    const payload = await service.renderInjection(actor(), project.project_id, 'chatgpt_web', 'light', 'session-ambiguous');

    assert.match(payload.body, /About me:/);
    // Copy moved from "Context sync is temporarily uncertain" to "Session memory is
    // temporarily uncertain about the active project" when the product renamed context
    // sync to session memory. Match the stable part so a future copy tweak doesn't
    // break a test that is really about the degraded-fallback behaviour.
    assert.match(payload.body, /temporarily uncertain/);
    assert.equal(payload.degraded_state, 'degraded');
    assert.equal(payload.degraded_reason, 'ambiguous_session');
    assert.doesNotMatch(payload.body, /Project: Atlas/);
    assert.doesNotMatch(payload.body, /Current task:/);
  });
});

test('low-specificity low-confidence deltas do not overwrite stronger project context', async () => {
  const project = makeProject();
  seedActiveTool(project, 'claude_web', 'claude.ai');
  const session = makeSession();
  let saveProjectCalls = 0;
  let appendEventCalls = 0;

  await withStubs({
    store: {
      getSession: async () => session,
      saveSession: async (next) => ({ ...session, ...next }),
      getProject: async () => project,
      saveProject: async () => { saveProjectCalls += 1; },
      appendEvent: async () => { appendEventCalls += 1; },
    },
    graph: {
      recordGraphArtifacts: async () => {
        throw new Error('graph should not be written');
      },
    },
  }, async () => {
    const result = await service.applyExtraction(actor(), {
      session_id: 'session-atlas',
      tool: 'claude_web',
      chunks: [{ role: 'assistant', text: 'ok we are working on it' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.61,
        project_candidate: {
          project_id: project.project_id,
          project_name: 'Atlas',
          reason: 'same project',
        },
        delta: {
          current_status: 'Working on it',
          current_task: 'Continue',
        },
        should_create_project: false,
        needs_user_confirmation: false,
        no_material_change: false,
      },
    });

    assert.equal(saveProjectCalls, 0);
    assert.equal(appendEventCalls, 0);
    assert.equal(result.project.context.current_status, 'Founder validating the MVP sync loop.');
    assert.equal(result.project.context.current_task, '');
  });
});

test.after(async () => {
  await closeRedisConnections();
});
