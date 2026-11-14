'use strict';

// Synthetic project fixtures for the Trails tests. Deliberately shaped like a
// real DeerDawn project — a graph with genuine multi-hop structure, decisions
// that carry reasoning, findings anchored to files — because a fixture with a
// star-shaped graph and no second hop would make the graph-vs-prose probe
// meaningless.

// The fixed structural spine. Every probe's ground truth has to exist at EVERY
// scale, so the spine is constant and `scale` only multiplies filler — otherwise
// a probe would silently skip at small scales and the suite would score a
// partial probe set while reporting a full one.
const SERVICES = ['Context API', 'Extraction Worker', 'Sync Store', 'Brief Renderer', 'Graph Indexer'];
const STORES = ['Primary Postgres', 'Redis Cache', 'Embedding Index'];

function makeGraph(scale) {
  const nodes = [];
  const edges = [];

  SERVICES.forEach((title, index) => {
    nodes.push({
      node_id: `node_service_${index}`,
      node_type: 'service',
      title,
      body: `${title} handles a stage of the context sync loop.`,
      status: index % 3 === 0 ? 'degraded' : 'healthy',
      surface: 'api',
    });
  });
  STORES.forEach((title, index) => {
    nodes.push({
      node_id: `node_store_${index}`,
      node_type: 'database',
      title,
      body: `${title} persists state for the sync loop.`,
      status: 'healthy',
    });
  });

  // An orphan: no edges in or out. Real graphs accumulate these, and "what is
  // disconnected?" is a question a reader cannot answer without enumerating
  // every node and every edge and subtracting.
  nodes.push({
    node_id: 'node_service_orphan',
    node_type: 'service',
    title: 'Legacy Webhook Relay',
    body: 'Still deployed, nothing points at it any more.',
    status: 'degraded',
    surface: 'api',
  });

  // Decoys: notes whose BODIES mention service names. This is not stacking the
  // deck — project memory is full of prose that references services by name, and
  // any honest measurement of grep-based retrieval has to include the noise grep
  // actually encounters. Without these the prose strategy is being tested on an
  // unrealistically clean corpus.
  SERVICES.forEach((title, index) => {
    nodes.push({
      node_id: `node_decoy_${index}`,
      node_type: 'knowledge',
      title: `Incident review ${index}`,
      body: `During the incident, ${title} was suspected before the real cause was found upstream.`,
    });
  });

  for (let i = 0; i < scale * 4; i += 1) {
    nodes.push({
      node_id: `node_knowledge_${i}`,
      node_type: 'knowledge',
      title: `Retry semantics note ${i}`,
      body: `Background note ${i} about backoff behaviour observed during sync.`,
    });
  }

  // Chain the services so there are real two- and three-hop paths, then hang the
  // stores off the tail so traversal has somewhere to land.
  const serviceNodes = nodes.filter((node) => node.node_type === 'service' && node.node_id !== 'node_service_orphan');
  const storeNodes = nodes.filter((node) => node.node_type === 'database');
  for (let i = 0; i < serviceNodes.length - 1; i += 1) {
    edges.push({ edge_type: 'calls', from_node_id: serviceNodes[i].node_id, to_node_id: serviceNodes[i + 1].node_id });
  }
  // Converging inbound edges on one store, so "what points AT this?" has a real
  // answer that differs from "what does this point at?".
  edges.push({ edge_type: 'reads_from', from_node_id: 'node_service_0', to_node_id: 'node_store_0' });
  edges.push({ edge_type: 'reads_from', from_node_id: 'node_service_2', to_node_id: 'node_store_0' });
  for (let i = 0; i < storeNodes.length; i += 1) {
    const source = serviceNodes[Math.min(i + 1, serviceNodes.length - 1)];
    edges.push({ edge_type: 'reads_from', from_node_id: source.node_id, to_node_id: storeNodes[i].node_id });
  }
  return { nodes, edges };
}

/**
 * @param {{scale?: number, withSecrets?: boolean}} [options] scale 1 = small, 3 = large
 */
function makeProject(options = {}) {
  const scale = options.scale || 1;
  const withSecrets = Boolean(options.withSecrets);

  // A mix of live and resolved decisions. "Which decisions are still live?" is a
  // question every returning reader asks, and it is a question about the ABSENCE
  // of a marker — the shape prose handles worst.
  const decisions = [
    { summary: 'Store context as JSONB rather than normalized tables', reasoning: 'The shape changes every few weeks and migrations were the bottleneck.', importance: 'high', decided_at: '2026-05-02T10:00:00.000Z' },
    { summary: 'Dedupe hot paths on normalized path', reasoning: 'Agents submitted the same file with ./ prefixes and trailing slashes.', importance: 'normal', decided_at: '2026-05-14T10:00:00.000Z' },
    { summary: 'Retry extraction three times before parking the session', reasoning: 'Two retries still dropped payloads under load.', importance: 'high', decided_at: '2026-05-20T10:00:00.000Z', resolved: true, resolved_at: '2026-07-01T10:00:00.000Z' },
    { summary: 'Cap the brief at the response budget rather than truncating mid-field', reasoning: 'A half-written landmine reads as a complete one.', importance: 'high', decided_at: '2026-05-28T10:00:00.000Z' },
  ];
  for (let i = 0; i < scale * 3; i += 1) {
    decisions.push({
      summary: `Adopt convention ${i} for sync payloads`,
      reasoning: `Convention ${i} keeps the payload under the response budget.`,
      importance: 'low',
      decided_at: '2026-06-01T10:00:00.000Z',
      ...(i % 2 === 0 ? { resolved: true, resolved_at: '2026-07-15T10:00:00.000Z' } : {}),
    });
  }

  const findings = [
    { summary: 'Two zod instances across workspace packages threw on schema objects crossing the boundary', paths: ['packages/shared-context/package.json', 'package-lock.json'], fix_commit: 'abc1234' },
    { summary: 'project_not_found surfaced as a 500 instead of a 404', paths: ['apps/api/src/routes/context/context-sync.js'], fix_commit: 'def5678' },
  ];

  const context = {
    project_name: 'Sync Loop',
    category: 'coding',
    description: 'The context sync loop and the services around it.',
    goals: ['Keep briefs under the response budget', 'Never lose a decision'],
    tech_stack: ['Node.js', 'PostgreSQL', 'Redis'],
    current_task: 'Harden the extraction retry path',
    current_status: 'Extraction retries land, but the backoff is untuned.',
    next_action: 'Instrument retry latency before changing the backoff curve.',
    open_questions: ['Should retries share a budget across projects?'],
    recurring_context: ['CommonJS only in apps/api'],
    file_structure_summary: ['apps/api holds the sync routes'],
    recent_decisions: decisions,
    hot_paths: [
      { path: 'apps/api/src/services/contextSyncService.js', label: 'Sync service', why: 'Every context write lands here.' },
      { path: 'packages/shared-context/src/index.js', label: 'Schemas', why: 'The merge semantics live here.' },
    ],
    debugging_notes: findings,
    commands: [
      { label: 'Run API tests', command: 'cd apps/api && npm test', why: 'Full suite, needs a database.' },
      { label: 'Migrate', command: 'make migrate' },
    ],
    landmines: [{ summary: 'npm ci fails on npm 11 because the lockfile pins helmet 7.2.0', importance: 'high' }],
    shipped: [{ summary: 'Board phases', shipped_at: '2026-07-06T00:00:00.000Z' }],
    todo_items: [
      { id: 'card-1', title: 'Instrument retry latency', phase: 'in_progress', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'card-2', title: 'Tune the backoff curve', phase: 'backlog', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'card-3', title: 'Document the retry budget', phase: 'backlog', created_at: '2026-07-01T00:00:00.000Z' },
    ],
    completed_todos: [
      { id: 'card-0', title: 'Split the sync store', phase: 'done', created_at: '2026-06-01T00:00:00.000Z', completed_at: '2026-06-10T00:00:00.000Z' },
    ],
    last_updated: '2026-08-01T00:00:00.000Z',
  };

  if (withSecrets) {
    context.description += ' Deploy key OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234 is in the makefile.';
    context.current_status += ' Ping tanya.reyes@apexfund.example.com if the worker stalls.';
    context.hot_paths.push({ path: '/Users/dev/Desktop/DeerDawn/apps/api/.env', label: 'Local env', why: 'Holds the local database URL.' });
    context.recent_decisions.push({ summary: 'Budget the migration at $45,000 USD', reasoning: 'Tanya Reyes signed off on the number.', importance: 'high', decided_at: '2026-06-15T10:00:00.000Z' });
    context.todo_items.push({ id: 'card-secret', title: 'Reconcile account 4111 1111 1111 1111', phase: 'backlog', created_at: '2026-07-01T00:00:00.000Z' });
  }

  return {
    project_id: options.projectId || 'project_fixture',
    project_name: 'Sync Loop',
    context,
    graph: makeGraph(scale),
  };
}

module.exports = { makeProject, makeGraph };
