const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DISABLE_REDIS = 'true';

const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const embeddings = require('../../src/services/contextGraphEmbeddingService');
const { closeRedisConnections } = require('../../src/config/redis');

const actor = { org_id: 'org-system', id: 'system-key', role: 'admin' };

function projectFixture() {
  return {
    project_id: 'project_deerdawn',
    owner_key: 'org-system',
    project_name: 'DeerDawn',
    aliases: [],
    linked_paths: ['/workspace/deerdawn'],
    linked_conversations: [],
    context: {
      project_name: 'DeerDawn',
      current_task: 'Ship task-scoped briefs for delegated code agents.',
      current_status: 'The core MCP contract is being implemented.',
      recent_decisions: [{
        summary: 'Keep local and remote MCP tool contracts in parity.',
        reasoning: 'Every supported host should get the same brief builder.',
        importance: 'high',
        decided_at: '2026-08-07T12:00:00.000Z',
      }, {
        summary: 'Unrelated marketing decision.',
        importance: 'normal',
        decided_at: '2026-08-06T12:00:00.000Z',
      }],
      recurring_context: ['New remote tools must be added to the fail-closed MCP scope map.'],
      hot_paths: [{
        label: 'Remote MCP registry',
        path: 'apps/api/src/routes/mcp.js',
        purpose: 'Tool schemas, scopes, and dispatch',
      }, {
        label: 'Marketing homepage',
        path: 'apps/marketing/src/pages/index.tsx',
        purpose: 'Public homepage',
      }],
      entrypoints: [],
      surfaces: [],
      debugging_notes: [],
      landmines: [{
        summary: 'A tool missing from TOOL_SCOPES fails closed at runtime.',
        paths: ['apps/api/src/routes/mcp.js'],
        importance: 'critical',
      }],
      commands: [{ label: 'api contracts', run: 'node tests/mcp-remote-tools-contracts.test.js' }],
      open_questions: [],
      goals: [],
      tech_stack: ['Node.js'],
      file_structure_summary: [],
      source_summary: 'Test fixture',
      last_updated: '2026-08-07T12:00:00.000Z',
    },
    created_at: '2026-08-07T12:00:00.000Z',
    updated_at: '2026-08-07T12:00:00.000Z',
  };
}

async function withStubs(fn) {
  const project = projectFixture();
  const originals = {
    getProject: store.getProject,
    getProjectShare: store.getProjectShare,
    listProjects: store.listProjects,
    listSessions: store.listSessions,
    listGraphNodes: store.listGraphNodes,
    getGlobal: store.getGlobal,
    getGraphEmbeddings: store.getGraphEmbeddings,
    embedText: embeddings.embedText,
  };
  store.getProject = async () => project;
  store.getProjectShare = async () => ({ share: null, sections: [], members: [] });
  store.listProjects = async () => [project];
  store.listSessions = async () => [];
  store.listGraphNodes = async () => [];
  store.getGlobal = async () => null;
  store.getGraphEmbeddings = async () => [];
  embeddings.embedText = async () => new Array(256).fill(0);
  try {
    return await fn(project);
  } finally {
    Object.assign(store, {
      getProject: originals.getProject,
      getProjectShare: originals.getProjectShare,
      listProjects: originals.listProjects,
      listSessions: originals.listSessions,
      listGraphNodes: originals.listGraphNodes,
      getGlobal: originals.getGlobal,
      getGraphEmbeddings: originals.getGraphEmbeddings,
    });
    embeddings.embedText = originals.embedText;
  }
}

test('buildSubagentBrief selects task-relevant project context without unrelated paths', async () => {
  await withStubs(async () => {
    const result = await service.buildSubagentBrief(actor, {
      project_id: 'project_deerdawn',
      task: 'Review remote MCP tool scopes and dispatch parity',
      role: 'reviewer',
      deliverable: 'Report contract gaps',
      acceptance_criteria: ['Do not edit files'],
      max_tokens: 260,
    });

    assert.match(result.text, /^\[DeerDawn Subagent Brief v1\]/);
    assert.match(result.text, /apps\/api\/src\/routes\/mcp\.js/);
    assert.match(result.text, /fail-closed MCP scope map/i);
    assert.doesNotMatch(result.text, /apps\/marketing\/src\/pages\/index\.tsx/);
    assert.ok(result.estimated_tokens <= 260);
    assert.ok(result.sources.some((source) => source.kind === 'path'));
  });
});

test('buildSubagentBrief rejects an inaccessible project', async () => {
  const original = store.getProject;
  store.getProject = async () => null;
  try {
    await assert.rejects(
      service.buildSubagentBrief(actor, { project_id: 'missing', task: 'Review the API' }),
      /project_not_found/,
    );
  } finally {
    store.getProject = original;
  }
});

// ── relevance has to mean relevance ──────────────────────────────────────────
//
// Reproduces the reviewer's c_brief scenario. Scoring was a SUBSTRING test over
// every 3+ character term of task + role + deliverable, with no stopword list,
// normalised by min(termCount, 5): "the", "for" and "and" counted as hits, any
// five hits scored 1.0, and a long write-up saturated every candidate. On top of
// that a `critical` decision was handed +0.5 and a `high` +0.3 with ZERO
// relevance, both clear of the 0.62 threshold — so one old critical decision led
// the Know section of five consecutive briefs about five unrelated tasks.

function relevanceFixture() {
  const project = projectFixture();
  const longOldCritical = 'Decided that the ChatGPT app resubmission is frozen and the catalog must not change. '
    + 'The reviewer console caches the scan and the description for the tool, and the team agreed that any change '
    + 'to the schema for the hosted server is out of scope until the app has been approved, and that this applies '
    + 'to all of the files in the repo and the tests for them. '.repeat(3);
  project.context.recent_decisions = [
    { summary: longOldCritical, importance: 'critical', decided_at: '2026-09-02T10:00:00.000Z' },
    {
      summary: 'Stripe webhook must keep the legacy price id mapped or the paying subscriber is downgraded.',
      importance: 'normal',
      decided_at: '2026-09-19T10:00:00.000Z',
    },
    {
      summary: 'Marketing navbar CTA takes the terminal slot on desktop.',
      importance: 'normal',
      decided_at: '2026-09-19T11:00:00.000Z',
    },
  ];
  project.context.landmines = [];
  project.context.recurring_context = [];
  return project;
}

async function withFixture(project, fn) {
  const originals = {
    getProject: store.getProject,
    getProjectShare: store.getProjectShare,
    listProjects: store.listProjects,
    listSessions: store.listSessions,
    listGraphNodes: store.listGraphNodes,
    getGlobal: store.getGlobal,
    getGraphEmbeddings: store.getGraphEmbeddings,
    embedText: embeddings.embedText,
  };
  store.getProject = async () => project;
  store.getProjectShare = async () => ({ share: null, sections: [], members: [] });
  store.listProjects = async () => [project];
  store.listSessions = async () => [];
  store.listGraphNodes = async () => [];
  store.getGlobal = async () => null;
  store.getGraphEmbeddings = async () => [];
  embeddings.embedText = async () => new Array(256).fill(0);
  try {
    return await fn();
  } finally {
    Object.assign(store, originals);
    embeddings.embedText = originals.embedText;
  }
}

const knowOf = (text) => (text.split('\n\nKnow:\n')[1] || '').split('\n\n')[0];

test('the decision that matches the task outranks an unrelated old critical', async () => {
  await withFixture(relevanceFixture(), async () => {
    const result = await service.buildSubagentBrief(actor, {
      project_id: 'project_deerdawn',
      task: 'Review the Stripe webhook price mapping for the billing downgrade bug',
      role: 'reviewer',
      deliverable: 'Ranked list of defects with file and line, plus one line on what was verified clean and nothing else at all.',
    });
    const know = knowOf(result.text);
    assert.match(know, /Stripe webhook/, 'THE BUG: the decision about the task did not make the section');
    const stripeAt = know.indexOf('Stripe webhook');
    const criticalAt = know.indexOf('ChatGPT app resubmission');
    assert.ok(criticalAt === -1 || stripeAt < criticalAt, 'the matching decision leads, not the old critical');
  });
});

test('an unrelated critical does not lead a brief it has nothing to do with', async () => {
  await withFixture(relevanceFixture(), async () => {
    const result = await service.buildSubagentBrief(actor, {
      project_id: 'project_deerdawn',
      task: 'Look for N+1 queries in the graph export endpoint',
      role: 'reviewer',
      deliverable: 'Ranked list of defects with file and line, plus one line on what was verified clean and nothing else at all.',
    });
    const know = knowOf(result.text);
    const firstLine = know.split('\n')[0] || '';
    assert.doesNotMatch(firstLine, /ChatGPT app resubmission/, 'THE BUG: one old critical led five unrelated briefs');
  });
});

test('a decision matching nothing but stopwords is not relevant', async () => {
  const project = relevanceFixture();
  project.context.recent_decisions = [{
    summary: 'The team agreed that the and for with this are the words that should not count.',
    importance: 'normal',
    decided_at: '2026-09-19T10:00:00.000Z',
  }];
  await withFixture(project, async () => {
    const result = await service.buildSubagentBrief(actor, {
      project_id: 'project_deerdawn',
      task: 'Audit the marketing navbar CTA placement on desktop',
      role: 'reviewer',
    });
    assert.doesNotMatch(knowOf(result.text), /should not count/);
  });
});

test('no single Know item may eat a small packaging budget', async () => {
  const project = relevanceFixture();
  project.context.recent_decisions = [{
    summary: `Stripe webhook price mapping must keep the legacy id ${'and so on '.repeat(60)}`,
    importance: 'high',
    decided_at: '2026-09-19T10:00:00.000Z',
  }];
  await withFixture(project, async () => {
    const result = await service.buildSubagentBrief(actor, {
      project_id: 'project_deerdawn',
      task: 'Review the Stripe webhook price mapping',
      max_tokens: 140,
    });
    const know = knowOf(result.text);
    const longest = Math.max(0, ...know.split('\n').map((line) => line.length));
    assert.ok(
      longest <= Math.floor(140 * 4 * 0.2),
      `one Know line took ${longest} of ${140 * 4} characters — nothing else can fit beside it`,
    );
  });
});

test.after(async () => {
  await closeRedisConnections();
});
