/**
 * Unit tests for extractionService.js
 * Tests rate guarding, fallback behaviour, and response validation
 * without making real OpenAI calls (axios is intercepted via module override).
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// ---------------------------------------------------------------------------
// Stub axios before requiring the service so the service never hits the network
// ---------------------------------------------------------------------------
const Module = require('module');
const originalLoad = Module._load;
let axiosStub = null;

Module._load = function (request, _parent, _isMain) {
  if (request === 'axios' && axiosStub) return axiosStub;
  return originalLoad.apply(this, arguments);
};

// Fresh require after stubbing
function freshService() {
  // Clear module cache so rateGuard Map resets between tests
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('extractionService')) delete require.cache[k];
  });
  return require('../../src/services/extractionService');
}

function freshStore() {
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('contextSyncStore')) delete require.cache[k];
  });
  return require('../../src/store/contextSyncStore');
}

const VALID_RESPONSE = {
  match_decision: 'matched_existing',
  confidence: 0.9,
  delta: { current_task: 'write unit tests' },
  should_create_project: false,
  needs_user_confirmation: false,
  no_material_change: false,
};

const VALID_OPENAI_REPLY = {
  data: { choices: [{ message: { content: JSON.stringify(VALID_RESPONSE) } }] },
};

// The workspace the routing heuristic sees: one project, and a session already
// bound to it. That binding alone scores 1.4 against the 1.25 match threshold,
// which is the state every returning user is in.
const BOUND_SESSION_PROJECT = {
  project_id: 'project-atlas',
  project_name: 'Atlas',
  aliases: [],
  linked_paths: ['/Users/dev/Desktop/deerdawn-api/apps/api'],
  linked_conversations: [],
  context: {
    project_name: 'Atlas',
    description: 'Cross-tool AI workspace.',
    goals: [],
    current_status: 'Founder validating the MVP sync loop.',
    recent_decisions: [],
    recurring_context: [],
    tech_stack: ['Node.js', 'TypeScript'],
    file_structure_summary: ['apps/api/src/services/contextSyncService.js'],
    current_task: 'Improve matching',
    open_questions: [],
    last_updated: '2026-05-10T00:00:00.000Z',
    source_summary: 'Created by tests',
  },
};

function stubHeuristicStore() {
  const store = freshStore();
  const originalGetSession = store.getSession;
  const originalListProjects = store.listProjects;
  store.getSession = async () => ({
    session_id: 'sess-heuristic',
    owner_key: 'org-system',
    tool: 'codex',
    surface_type: 'cli',
    project_id: 'project-atlas',
    conversation_ref: '',
    cwd: '/Users/dev/Desktop/deerdawn-api/apps/api',
    host: '',
    tab_id: '',
    status: 'active',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  });
  store.listProjects = async () => ([BOUND_SESSION_PROJECT]);
  return {
    store,
    restore: (s) => {
      s.getSession = originalGetSession;
      s.listProjects = originalListProjects;
    },
  };
}

function makeInput(overrides = {}) {
  return {
    project_id: 'proj-test-1',
    tool: 'claude_web',
    chunks: [{ role: 'user', text: 'lets write some tests' }],
    context: { project_name: 'Test Project' },
    ...overrides,
  };
}

// Restore original Module._load after all tests
test.after(() => {
  Module._load = originalLoad;
  axiosStub = null;
});

test('returns safe fallback when OPENAI_API_KEY is not set', async () => {
  const saved = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  axiosStub = { post: async () => VALID_OPENAI_REPLY };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());

  assert.equal(result.match_decision, 'ambiguous');
  assert.equal(result.confidence, 0);
  assert.equal(result.needs_user_confirmation, true);

  process.env.OPENAI_API_KEY = saved || 'test-key';
});

test('returns safe fallback when OpenAI call throws', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = { post: async () => { throw new Error('network error'); } };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());

  assert.equal(result.match_decision, 'ambiguous');
  assert.equal(result.confidence, 0);
});

test('returns safe fallback when response is not valid JSON', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = {
    post: async () => ({
      data: { choices: [{ message: { content: 'not json at all' } }] },
    }),
  };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());
  assert.equal(result.match_decision, 'ambiguous');
});

test('returns safe fallback when response fails schema validation', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = {
    post: async () => ({
      data: { choices: [{ message: { content: JSON.stringify({ wrong: 'shape' }) } }] },
    }),
  };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());
  assert.equal(result.match_decision, 'ambiguous');
});

test('returns safe fallback when response is empty', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = {
    post: async () => ({ data: { choices: [{ message: { content: '' } }] } }),
  };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());
  assert.equal(result.match_decision, 'ambiguous');
});

test('returns validated response on success', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = { post: async () => VALID_OPENAI_REPLY };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());

  assert.equal(result.match_decision, 'matched_existing');
  assert.equal(result.confidence, 0.9);
  assert.equal(result.delta.current_task, 'write unit tests');
  assert.equal(result.should_create_project, false);
});

test('rate guard returns cached response within 30s window', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = {
    post: async () => {
      callCount++;
      return VALID_OPENAI_REPLY;
    },
  };
  const { runExtraction } = freshService();

  const input = makeInput({ project_id: 'proj-rate-guard' });
  await runExtraction({}, input);
  await runExtraction({}, input);
  await runExtraction({}, input);

  assert.equal(callCount, 1, 'OpenAI should only be called once within the rate guard window');
});

test('rate guard uses session_id when project_id is absent', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = { post: async () => { callCount++; return VALID_OPENAI_REPLY; } };
  const { runExtraction } = freshService();

  const input = makeInput({ project_id: undefined, session_id: 'sess-abc' });
  await runExtraction({}, input);
  await runExtraction({}, input);

  assert.equal(callCount, 1);
});

test('handles chunk array and single chunk input formats', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let capturedBody = null;
  axiosStub = {
    post: async (_url, body) => { capturedBody = body; return VALID_OPENAI_REPLY; },
  };
  const { runExtraction } = freshService();

  // Array format
  await runExtraction({}, makeInput({ chunks: [{ role: 'user', text: 'please refactor the context sync matcher' }] }));
  assert.ok(capturedBody.messages[1].content.includes('[user] please refactor the context sync matcher'));

  // Single chunk format (legacy)
  capturedBody = null;
  Object.keys(require.cache).forEach((k) => {
    if (k.includes('extractionService')) delete require.cache[k];
  });
  const { runExtraction: runExtraction2 } = require('../../src/services/extractionService');
  await runExtraction2({}, makeInput({ chunks: undefined, chunk: { role: 'assistant', text: 'the matcher should reuse prior session context' } }));
  assert.ok(capturedBody.messages[1].content.includes('[assistant] the matcher should reuse prior session context'));
});

test('uses a compact context digest instead of the full serialized context blob', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let capturedBody = null;
  axiosStub = {
    post: async (_url, body) => {
      capturedBody = body;
      return VALID_OPENAI_REPLY;
    },
  };
  const { runExtraction } = freshService();

  await runExtraction({}, makeInput({
    context: {
      project_name: 'Atlas',
      description: 'A very long description that should not be forwarded verbatim in full on every extraction call.',
      current_task: 'Ship context sync efficiency work',
      current_status: 'Founder validating performance',
      recent_decisions: [
        { summary: 'Use compact prompts', decided_at: '2026-05-09T00:00:00.000Z' },
      ],
      recurring_context: ['Prefer TypeScript'],
      tech_stack: ['TypeScript', 'Node.js'],
      file_structure_summary: ['apps/api/src/services/extractionService.js'],
      open_questions: ['How much can prompt size shrink?'],
      source_summary: 'Created by tests',
    },
  }));

  const prompt = capturedBody.messages[1].content;
  assert.match(prompt, /Existing project context digest:/);
  assert.match(prompt, /Project: Atlas/);
  assert.match(prompt, /Current task: Ship context sync efficiency work/);
  assert.doesNotMatch(prompt, /file_structure_summary/);
  assert.doesNotMatch(prompt, /\{\n\s+"project_name"/);
});

test('extraction prompt explicitly captures open questions and pending decisions', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let capturedBody = null;
  axiosStub = {
    post: async (_url, body) => {
      capturedBody = body;
      return VALID_OPENAI_REPLY;
    },
  };
  const { runExtraction } = freshService();

  await runExtraction({}, makeInput({
    chunks: [
      { role: 'user', text: 'We still need to decide whether question tracking belongs in extraction or structured events.' },
    ],
  }));

  const prompt = capturedBody.messages[0].content;
  assert.match(prompt, /open_questions/i);
  assert.match(prompt, /pending decision/i);
  assert.match(prompt, /next decision/i);
  assert.match(prompt, /resolved_questions/i);
});

test('accepts extracted open questions for pending decisions', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = {
    post: async () => ({
      data: {
        choices: [{
          message: {
            content: JSON.stringify({
              match_decision: 'matched_existing',
              confidence: 0.91,
              delta: {
                open_questions: [
                  'Decide whether question tracking belongs in extraction or structured events',
                ],
              },
              should_create_project: false,
              needs_user_confirmation: false,
              no_material_change: false,
            }),
          },
        }],
      },
    }),
  };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());

  assert.deepEqual(result.delta.open_questions, [
    'Decide whether question tracking belongs in extraction or structured events',
  ]);
});

test('accepts a no material change extraction outcome', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = {
    post: async () => ({
      data: {
        choices: [{
          message: {
            content: JSON.stringify({
              match_decision: 'matched_existing',
              confidence: 0.93,
              delta: {},
              should_create_project: false,
              needs_user_confirmation: false,
              no_material_change: true,
            }),
          },
        }],
      },
    }),
  };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput());

  assert.equal(result.no_material_change, true);
  assert.deepEqual(result.delta, { completed_goals: [], resolved_decisions: [], resolved_landmines: [], resolved_questions: [] });
});

test('returns no material change without calling OpenAI for trivial conversational noise', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = {
    post: async () => {
      callCount += 1;
      return VALID_OPENAI_REPLY;
    },
  };
  const { runExtraction } = freshService();

  const result = await runExtraction({}, makeInput({
    chunks: [{ role: 'user', text: 'ok thanks' }],
  }));

  assert.equal(callCount, 0);
  assert.equal(result.no_material_change, true);
  assert.equal(result.match_decision, 'ignored');
});

/**
 * THE PREMISE OF THIS TEST WAS THE BUG.
 *
 * It was written as "…matches an existing project WITHOUT CALLING OPENAI" and
 * asserted `callCount === 0` on a substantive chunk. That reads as a saved model
 * call and is actually the write path being skipped. resolveHeuristicMatch
 * answers only WHERE a chunk belongs; a run that stops there returns
 * `delta: {}` by construction, applyExtraction's mergeChanged is false, and the
 * tool still answers "Context updated". scoreProjectMatch gives +1.4 for a
 * session already bound to a project — over the 1.25 threshold on its own — so
 * this fired for every session that had ever written once, which is every
 * returning user. The call it was saving was the product's memory.
 *
 * What is genuinely invariant is the ROUTING, and that is what is pinned now:
 * the heuristic picks the project and the model does not get to overrule a
 * strong session binding with a guess made from one project's digest — but the
 * model IS asked what changed.
 */
test('uses session and workspace heuristics to route to an existing project, and still extracts', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = {
    post: async () => {
      callCount += 1;
      return VALID_OPENAI_REPLY;
    },
  };
  const store = freshStore();
  const originalGetSession = store.getSession;
  const originalListProjects = store.listProjects;
  store.getSession = async () => ({
    session_id: 'sess-heuristic',
    owner_key: 'org-system',
    tool: 'codex',
    surface_type: 'cli',
    project_id: 'project-atlas',
    conversation_ref: '',
    cwd: '/Users/dev/Desktop/deerdawn-api/apps/api',
    host: '',
    tab_id: '',
    status: 'active',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  });
  store.listProjects = async () => ([
    {
      project_id: 'project-atlas',
      project_name: 'Atlas',
      aliases: [],
      linked_paths: ['/Users/dev/Desktop/deerdawn-api/apps/api'],
      linked_conversations: [],
      context: {
        project_name: 'Atlas',
        description: 'Cross-tool AI workspace.',
        goals: [],
        current_status: 'Founder validating the MVP sync loop.',
        recent_decisions: [],
        recurring_context: [],
        tech_stack: ['Node.js', 'TypeScript'],
        file_structure_summary: ['apps/api/src/services/contextSyncService.js'],
        current_task: 'Improve matching',
        open_questions: [],
        last_updated: '2026-05-10T00:00:00.000Z',
        source_summary: 'Created by tests',
      },
    },
  ]);

  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({
      org_id: 'org-system',
      id: 'system-key',
    }, makeInput({
      session_id: 'sess-heuristic',
      project_id: undefined,
      tool: 'codex',
      session_context: {
        cwd: '/Users/dev/Desktop/deerdawn-api/apps/api',
        status: 'active',
      },
      chunks: [{ role: 'assistant', text: 'Updating the API service to improve matching and context sync quality.' }],
    }));

    assert.equal(
      callCount,
      1,
      'a routed chunk must still be extracted — a heuristic that knows WHERE a chunk goes knows nothing about WHETHER there is anything in it worth storing'
    );
    // Routing: the heuristic's, not the model's.
    assert.equal(result.match_decision, 'matched_existing');
    assert.equal(result.project_candidate.project_id, 'project-atlas');
    assert.equal(result.needs_user_confirmation, false);
    assert.equal(result.routing_state, 'matched');
    assert.equal(result.should_create_project, false);
    // Content: the model's. This is the assertion the old premise made
    // impossible — an empty delta here is the whole defect.
    assert.equal(result.delta.current_task, 'write unit tests');
    assert.equal(result.no_material_change, false);
    // The write gate reads `confidence`, so it has to describe the CONTENT. The
    // routing confidence rides on project_candidate.score instead.
    assert.equal(result.confidence, 0.9);
  } finally {
    store.getSession = originalGetSession;
    store.listProjects = originalListProjects;
  }
});

/**
 * Split the two questions apart in the other direction: the model may not
 * relocate a chunk the heuristic already placed. It is shown ONE project's
 * digest, so its own match_decision is a guess made without the workspace in
 * front of it; letting it win produces a duplicate project (or a write into the
 * wrong one) out of a session binding that was never in doubt.
 */
test('the model may say what changed, but never where it goes', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = {
    post: async () => ({
      data: {
        choices: [{
          message: {
            content: JSON.stringify({
              match_decision: 'new_project',
              confidence: 0.88,
              project_candidate: { project_name: 'A Brand New Thing', reason: 'model guess', score: 0.9 },
              delta: { current_status: 'Refactoring the matcher' },
              should_create_project: true,
              needs_user_confirmation: true,
              no_material_change: false,
            }),
          },
        }],
      },
    }),
  };
  const { store, restore } = stubHeuristicStore();

  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({ org_id: 'org-system', id: 'system-key' }, makeInput({
      session_id: 'sess-heuristic',
      project_id: undefined,
      tool: 'codex',
      session_context: { cwd: '/Users/dev/Desktop/deerdawn-api/apps/api', status: 'active' },
      chunks: [{ role: 'assistant', text: 'Updating the API service to improve matching and context sync quality.' }],
    }));

    assert.equal(result.match_decision, 'matched_existing', 'the heuristic owns routing');
    assert.equal(result.project_candidate.project_id, 'project-atlas');
    assert.equal(result.should_create_project, false, 'a bound session must never spawn a duplicate project');
    assert.equal(result.needs_user_confirmation, false);
    // …and the content it was actually asked for survives intact.
    assert.equal(result.delta.current_status, 'Refactoring the matcher');
  } finally {
    restore(store);
  }
});

/**
 * A provider blip degrades to "matched, nothing extracted", not to "ambiguous".
 * Both store nothing; only one of them also throws away a project binding we
 * were sure of and asks the user to re-confirm it.
 */
test('a provider failure keeps the routing it had rather than falling back to ambiguous', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  axiosStub = { post: async () => { throw new Error('network error'); } };
  const { store, restore } = stubHeuristicStore();

  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({ org_id: 'org-system', id: 'system-key' }, makeInput({
      session_id: 'sess-heuristic',
      project_id: undefined,
      tool: 'codex',
      session_context: { cwd: '/Users/dev/Desktop/deerdawn-api/apps/api', status: 'active' },
      chunks: [{ role: 'assistant', text: 'Updating the API service to improve matching and context sync quality.' }],
    }));

    assert.equal(result.match_decision, 'matched_existing');
    assert.equal(result.project_candidate.project_id, 'project-atlas');
    assert.equal(result.needs_user_confirmation, false);
    // Honest about the content: nothing was extracted, and it says so.
    assert.deepEqual(result.delta, {});
    assert.equal(result.no_material_change, true);
  } finally {
    restore(store);
  }
});

test('treats a stale bound session as ambiguous without calling OpenAI', async () => {
  process.env.OPENAI_API_KEY = 'sk-test';
  let callCount = 0;
  axiosStub = {
    post: async () => {
      callCount += 1;
      return VALID_OPENAI_REPLY;
    },
  };
  const store = freshStore();
  const originalGetSession = store.getSession;
  const originalListProjects = store.listProjects;
  store.getSession = async () => ({
    session_id: 'sess-stale',
    owner_key: 'org-system',
    tool: 'codex',
    surface_type: 'cli',
    project_id: 'project-atlas',
    conversation_ref: '',
    cwd: '/Users/dev/Desktop/atlas',
    host: '',
    tab_id: '',
    status: 'active',
    created_at: '2026-05-10T00:00:00.000Z',
    updated_at: '2026-05-10T00:00:00.000Z',
    last_seen_at: '2026-05-10T00:00:00.000Z',
  });
  store.listProjects = async () => ([
    {
      project_id: 'project-atlas',
      project_name: 'Atlas',
      aliases: [],
      linked_paths: ['/Users/dev/Desktop/atlas'],
      linked_conversations: [],
      context: {
        project_name: 'Atlas',
        description: 'Atlas workspace.',
        goals: [],
        current_status: 'Maintaining Atlas.',
        recent_decisions: [],
        recurring_context: [],
        tech_stack: ['Node.js'],
        file_structure_summary: ['atlas/src/index.js'],
        current_task: 'Improve Atlas matching',
        open_questions: [],
        last_updated: '2026-05-10T00:00:00.000Z',
        source_summary: 'Created by tests',
      },
    },
    {
      project_id: 'project-beacon',
      project_name: 'Beacon',
      aliases: [],
      linked_paths: ['/Users/dev/Desktop/beacon'],
      linked_conversations: [],
      context: {
        project_name: 'Beacon',
        description: 'Beacon workspace.',
        goals: [],
        current_status: 'Working in Beacon.',
        recent_decisions: [],
        recurring_context: [],
        tech_stack: ['TypeScript'],
        file_structure_summary: ['beacon/src/matcher.ts'],
        current_task: 'Ship Beacon ranking',
        open_questions: [],
        last_updated: '2026-05-10T00:00:00.000Z',
        source_summary: 'Created by tests',
      },
    },
  ]);

  try {
    const { runExtraction } = freshService();
    const result = await runExtraction({
      org_id: 'org-system',
      id: 'system-key',
    }, makeInput({
      session_id: 'sess-stale',
      project_id: undefined,
      tool: 'codex',
      session_context: {
        cwd: '/Users/dev/Desktop/beacon',
        status: 'active',
      },
      chunks: [{ role: 'assistant', text: 'Updating Beacon retrieval scoring and workspace ranking.' }],
    }));

    assert.equal(callCount, 0);
    assert.equal(result.match_decision, 'ambiguous');
    assert.equal(result.needs_user_confirmation, true);
    assert.equal(result.routing_state, 'stale_match');
    assert.equal(result.no_material_change, true);
  } finally {
    store.getSession = originalGetSession;
    store.listProjects = originalListProjects;
  }
});
