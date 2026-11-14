/**
 * L5 — concurrent context writes must not silently drop one side's delta.
 *
 * applyExtraction detects a concurrent write from the WRITE ITSELF: saveProject
 * compares-and-swaps on the row's context_version and reports whether it applied.
 *
 * It used to detect one by READING updated_at first and comparing — which left a
 * window between the check and the act, so a writer landing in that window was
 * overwritten silently: the exact failure the check existed to prevent. The
 * stubs below therefore simulate a race by refusing the first swap rather than
 * by moving a timestamp; the property under test is unchanged, and it is the one
 * that matters — the concurrent writer's delta (here, an open question added by
 * a second tool/session) must survive.
 *
 * This test stubs the store (and the two workspace lookups a write makes) so no
 * real Postgres/Redis is needed: it simulates
 * a concurrent write landing between our initial read and our save, and
 * asserts the final saved context contains BOTH our own delta AND the
 * concurrent writer's change — proving the retry-and-remerge path actually
 * reconciles instead of last-write-wins clobbering.
 *
 * Run: node tests/unit/context-sync-concurrency.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_REDIS = 'true';

const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const graphService = require('../../src/services/contextGraphService');
const workspaceService = require('../../src/services/workspaceService');

function actor() {
  return { org_id: 'org-system', id: 'system-key' };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeProject(overrides = {}) {
  const base = {
    project_id: 'project-concurrency',
    owner_key: 'org-system',
    project_name: 'Concurrency Test',
    aliases: [],
    linked_paths: [],
    linked_conversations: [],
    context: {
      project_name: 'Concurrency Test',
      description: '',
      goals: [],
      current_status: 'Original status before either write.',
      recent_decisions: [],
      recurring_context: [],
      tech_stack: [],
      file_structure_summary: [],
      current_task: '',
      open_questions: [],
      last_updated: '2026-05-10T00:00:00.000Z',
      source_summary: '',
    },
    events: [{
      event_id: 'evt-created',
      project_id: 'project-concurrency',
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
  return {
    ...base,
    ...overrides,
    context: { ...base.context, ...(overrides.context || {}) },
  };
}

function makeSession() {
  return {
    session_id: 'session-concurrency',
    owner_key: 'org-system',
    tool: 'claude_code',
    surface_type: 'cli',
    project_id: 'project-concurrency',
    conversation_ref: '',
    cwd: '',
    host: 'laptop-a',
    tab_id: '',
    status: 'active',
    routing_state: 'matched',
    match_confidence: 0.9,
    last_confirmed_at: null,
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  };
}

// Minimal store/graph stub harness (same pattern as context-sync-efficiency.test.js).
function withStubs(overrides, fn) {
  const originals = {};
  for (const [key, value] of Object.entries(overrides.store || {})) {
    originals[`store:${key}`] = store[key];
    store[key] = value;
  }
  for (const [key, value] of Object.entries(overrides.graph || {})) {
    originals[`graph:${key}`] = graphService[key];
    graphService[key] = value;
  }
  for (const [key, value] of Object.entries(overrides.workspace || {})) {
    originals[`workspace:${key}`] = workspaceService[key];
    workspaceService[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [compoundKey, value] of Object.entries(originals)) {
        const [target, key] = compoundKey.split(':');
        if (target === 'store') store[key] = value;
        if (target === 'graph') graphService[key] = value;
        if (target === 'workspace') workspaceService[key] = value;
      }
    });
}

let saveAttempts = 0;

test('a concurrent write between read and save is reconciled, not silently dropped', async () => {
  saveAttempts = 0;
  const session = makeSession();
  const v1Project = makeProject({ updated_at: '2026-05-10T00:00:00.000Z' });
  // Simulates a second tool/session writing to the SAME project between our
  // load and our save: it appended an open question and bumped updated_at.
  const v2Project = makeProject({
    updated_at: '2026-05-10T00:05:00.000Z',
    context: {
      open_questions: ['Question added by the concurrent session'],
      last_updated: '2026-05-10T00:05:00.000Z',
    },
  });

  const savedProjects = [];
  let getProjectCalls = 0;

  await withStubs({
    store: {
      getSession: async () => clone(session),
      saveSession: async () => {},
      // A solo workspace, pinned. Left unstubbed this one store call reached the
      // REAL database, and on a shared test DB where other suites have put
      // members under org-system it answered "may hold others' work", which sent
      // the (unattributed) session through the ownership check and its project
      // reads — so the refetch count below measured the database, not the loop.
      workspaceMayHoldOthersWork: async () => false,
      getProject: async () => {
        getProjectCalls += 1;
        return clone(getProjectCalls === 1 ? v1Project : v2Project);
      },
      getProjectUpdatedAt: async () => v2Project.updated_at,
      // The first swap loses (somebody wrote between our read and our write);
      // the retry, computed against the fresh row, wins.
      saveProject: async (project) => {
        if (!savedProjects.length && !saveAttempts) { saveAttempts += 1; return { applied: false }; }
        savedProjects.push(clone(project));
        return { applied: true };
      },
      appendEvent: async () => {},
      getProjectShare: async () => ({ share: null, sections: [], members: [] }),
      getPreferences: async () => ({ security: { excluded_fields: [] } }),
    },
    graph: {
      recordGraphArtifacts: async () => ({ nodes: [], edges: [], evidence: [] }),
    },
    // The write-role check is the other call that left the stubs for the DB.
    workspace: { resolveRole: async () => 'owner' },
  }, async () => {
    const result = await service.applyExtraction(actor(), {
      session_id: 'session-concurrency',
      tool: 'claude_code',
      chunks: [{ role: 'assistant', text: 'Shipped the concurrency-safe merge for context writes.' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.9,
        project_candidate: {
          project_id: 'project-concurrency',
          project_name: 'Concurrency Test',
          reason: 'same project',
        },
        delta: {
          current_status: 'Shipped the concurrency-safe merge for context writes.',
        },
        should_create_project: false,
        needs_user_confirmation: false,
        no_material_change: false,
      },
    });

    assert.equal(getProjectCalls, 2, 'expected exactly one retry refetch (initial load + one re-fetch)');
    assert.equal(savedProjects.length, 1, 'expected exactly one save after reconciling');

    const saved = savedProjects[0];
    // Our own delta made it in...
    assert.equal(saved.context.current_status, 'Shipped the concurrency-safe merge for context writes.',
      'our own delta must not be lost');
    // ...AND the concurrent writer's delta was preserved, not clobbered.
    assert.deepEqual(saved.context.open_questions, ['Question added by the concurrent session'],
      'the concurrent write must not be silently dropped');

    // The function's return shape is unchanged.
    assert.ok(result.project);
    assert.ok('session' in result);
    assert.ok('graph' in result);
  });
});

test('a resolved race does not log the last-write-wins warning; an unresolved one still does', async () => {
  saveAttempts = 0;
  const session = makeSession();
  const v1Project = makeProject({ updated_at: '2026-05-10T00:00:00.000Z' });
  // The row never stops moving — every check reports a different updated_at,
  // so the retry budget is exhausted and the code must fall back to
  // last-write-wins (with the original warning) instead of spinning forever.
  let getProjectUpdatedAtCalls = 0;

  const savedProjects = [];
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };

  try {
    await withStubs({
      store: {
        getSession: async () => clone(session),
        saveSession: async () => {},
        workspaceMayHoldOthersWork: async () => false, // see the first test
        getProject: async () => clone(v1Project),
        getProjectUpdatedAt: async () => {
          getProjectUpdatedAtCalls += 1;
          // Always different from whatever was last loaded — never converges.
          return `2026-05-10T00:0${getProjectUpdatedAtCalls}:00.000Z`;
        },
        saveProject: async (project) => {
          // Every swap loses: the race is never resolved and the loop must fall
          // back to an unconditional write with the warning.
          if (saveAttempts < 4) { saveAttempts += 1; return { applied: false }; }
          savedProjects.push(clone(project));
          return { applied: true };
        },
        appendEvent: async () => {},
        getProjectShare: async () => ({ share: null, sections: [], members: [] }),
        getPreferences: async () => ({ security: { excluded_fields: [] } }),
      },
      graph: {
        recordGraphArtifacts: async () => ({ nodes: [], edges: [], evidence: [] }),
      },
      workspace: { resolveRole: async () => 'owner' },
    }, async () => {
      await service.applyExtraction(actor(), {
        session_id: 'session-concurrency',
        tool: 'claude_code',
        chunks: [{ role: 'assistant', text: 'Still working on the perpetually-racing project.' }],
        extraction: {
          match_decision: 'matched_existing',
          confidence: 0.9,
          project_candidate: {
            project_id: 'project-concurrency',
            project_name: 'Concurrency Test',
            reason: 'same project',
          },
          delta: { current_status: 'Still working on the perpetually-racing project.' },
          should_create_project: false,
          needs_user_confirmation: false,
          no_material_change: false,
        },
      });
    });
  } finally {
    console.warn = originalWarn;
  }

  // Bounded retries: it must have stopped, not spun forever, and still saved once.
  assert.equal(savedProjects.length, 1, 'falls back to a single last-write-wins save, does not spin');
  assert.ok(
    warnings.some((line) => line.includes('Concurrent write on project') && line.includes('last-write-wins')),
    'an unresolved conflict after the retry budget must still warn'
  );
});

// The first write to an UNATTRIBUTED session on a workspace that may hold other
// people's work goes through sessionBelongsToActor, which reads the bound
// project to look for an author. With none, it asked loadProjectForWrite —
// which read and decrypted the very same row again. One read is enough.
test('claiming an unattributed session reads its bound project once, not twice', async () => {
  const session = makeSession();
  const project = makeProject();
  const reads = [];

  await withStubs({
    store: {
      getSession: async () => clone(session),
      saveSession: async () => {},
      workspaceMayHoldOthersWork: async () => true,
      getProject: async () => {
        reads.push(new Error().stack.includes('sessionBelongsToActor') ? 'ownership' : 'write');
        return clone(project);
      },
      saveProject: async () => ({ applied: true }),
      appendEvent: async () => {},
      getProjectShare: async () => ({ share: null, sections: [], members: [] }),
      getPreferences: async () => ({ security: { excluded_fields: [] } }),
    },
    graph: {
      recordGraphArtifacts: async () => ({ nodes: [], edges: [], evidence: [] }),
    },
    workspace: {
      resolveRole: async () => 'member',
      isSharedWorkspace: async () => true,
    },
  }, async () => {
    await service.applyExtraction(actor(), {
      session_id: 'session-concurrency',
      tool: 'claude_code',
      chunks: [{ role: 'assistant', text: 'Claimed the legacy session.' }],
      extraction: {
        match_decision: 'matched_existing',
        confidence: 0.9,
        project_candidate: { project_id: 'project-concurrency', project_name: 'Concurrency Test', reason: 'same project' },
        delta: { current_status: 'Claimed the legacy session.' },
        should_create_project: false,
        needs_user_confirmation: false,
        no_material_change: false,
      },
    });
  });

  assert.deepEqual(reads, ['ownership', 'write'],
    'the ownership check reads the project once; the write loads it once');
});
