const crypto = require('crypto');
const path = require('path');
const store = require('../store/contextSyncStore');
const embeddings = require('./contextGraphEmbeddingService');
const { deriveEvidenceLine, EXCERPT_KIND_DERIVED } = require('./graphEvidenceLine');
const {
  GraphRetrievalResultSchema,
  GraphNodeSchema,
  GraphEdgeSchema,
  GraphEvidenceSchema,
  clipText,
  proseBudget,
} = require('../../../../packages/shared-context/src/index.js');

// ONE BAD ROW MUST NOT TAKE THE WHOLE READ DOWN.
//
// Every graph read below ends in GraphRetrievalResultSchema.parse, and so does
// the workspace overview that start_session carries. A single stored node the
// schema rejects — the dashboard's "add node" stamped source_tool 'dashboard',
// which the enum did not list — failed the parse for EVERYTHING: start_session
// answered invalid_arguments, recall context internal_error, the project and
// node graph routes 400, and they stayed broken until somebody found and
// deleted the node. That enum is fixed; this is for the next value nobody
// thought of. A row that does not parse is skipped and logged, and the rest of
// the brief is served.
function keepParseable(items, schema, kind) {
  if (!Array.isArray(items)) return items;
  const kept = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      kept.push(item);
      continue;
    }
    const id = item?.node_id || item?.edge_id || item?.evidence_id || 'unknown';
    const issue = result.error.issues?.[0];
    console.warn(`[CONTEXT GRAPH] skipped unreadable ${kind} ${id}: ${issue ? `${(issue.path || []).join('.')}: ${issue.message}` : 'invalid'}`);
  }
  return kept;
}

function keepParseableNodes(nodes) {
  return keepParseable(nodes, GraphNodeSchema, 'node');
}

function parseGraphRetrieval(payload) {
  return GraphRetrievalResultSchema.parse({
    ...payload,
    nodes: keepParseable(payload.nodes, GraphNodeSchema, 'node'),
    edges: keepParseable(payload.edges, GraphEdgeSchema, 'edge'),
    evidence: keepParseable(payload.evidence, GraphEvidenceSchema, 'evidence'),
  });
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function isoNow() {
  return new Date().toISOString();
}

function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function clip(text, limit = 240) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}...`;
}

function lexicalScore(node, queryTerms) {
  const haystack = normalizeKey([
    node.title,
    node.summary,
    node.canonical_key,
    node.metadata?.path,
    node.metadata?.host,
    node.metadata?.stack,
  ].filter(Boolean).join(' '));
  if (!haystack) return 0;
  let score = 0;
  for (const term of queryTerms) {
    if (haystack.includes(term)) score += 1;
  }
  return queryTerms.length ? score / queryTerms.length : 0;
}

function recencyScore(isoString) {
  const ageMs = Math.max(0, Date.now() - new Date(isoString).getTime());
  const days = ageMs / (24 * 60 * 60 * 1000);
  return Math.max(0, 1 - days / 14);
}

function graphNodePriority(node) {
  if (node.node_type === 'task') return 1.25;
  if (node.node_type === 'decision') return 1.05;
  if (node.node_type === 'file' || node.node_type === 'component') return 0.95;
  if (node.node_type === 'repo' || node.node_type === 'service') return 0.8;
  if (node.node_type === 'project') return 0.35;
  return 0.6;
}

function isStaleLowSignalNode(node) {
  return recencyScore(node.last_seen_at) < 0.15 && Number(node.confidence || 0) < 0.6;
}

// A node somebody CLOSED. The one list every "what is current" read uses — the
// entity search's hard exclude and the workspace overview (contextSyncService)
// — so a resolve that says "will no longer appear in normal context loads" is
// true of the brief as well as of recall. Explicit graph and entity reads (the
// graph routes, recall entities with status "resolved") still return these
// nodes: history is not hidden, it is just not briefed as current.
const INACTIVE_NODE_STATUSES = new Set(['resolved', 'archived']);
function isInactiveGraphNode(node) {
  return INACTIVE_NODE_STATUSES.has(String(node?.metadata?.status || '').toLowerCase());
}

function sessionQueryText(session) {
  return [
    session.project_id,
    session.cwd,
    session.host,
    session.conversation_ref,
    session.tab_id,
  ].filter(Boolean).join(' ');
}

async function persistNodeEmbedding(ownerKey, node) {
  await store.upsertGraphEmbedding({
    owner_key: ownerKey,
    target_kind: 'node',
    target_id: node.node_id,
    model: embeddings.MODEL,
    dimensions: embeddings.DIMENSIONS,
    vector: await embeddings.embedText(embeddings.buildNodeEmbeddingText(node)),
  });
}

async function persistEvidenceEmbedding(ownerKey, evidence) {
  await store.upsertGraphEmbedding({
    owner_key: ownerKey,
    target_kind: 'evidence',
    target_id: evidence.evidence_id,
    model: embeddings.MODEL,
    dimensions: embeddings.DIMENSIONS,
    vector: await embeddings.embedText(embeddings.buildEvidenceEmbeddingText(evidence)),
  });
}

// A PROJECT'S ROOT NODE IS KEYED BY THE PROJECT, NOT BY ITS NAME.
//
// It was `project:<normalized name>`, and nodes are unique per (owner_key,
// node_type, canonical_key) — so two projects with the same name in one
// workspace were ONE root node. Teammates name things alike ("Atlas", "api"),
// and a personal pre-team project routinely shares its name with the team's
// project: the root row kept whichever project wrote it first as its home, took
// the other's description/status/task as its summary (the upsert replaces a
// short summary), and every reader that could see EITHER project read both —
// graph/projects, workspace/entities, graph/export, both exports, both searches
// and recall. The title is still the name; the identity is the id.
// migrateNameKeyedProjectRoots (run once by autoMigrate) splits the old rows.
function projectRootKey(projectId) {
  return `project:${projectId}`;
}

function projectNode(ownerKey, project, session) {
  const now = isoNow();
  return {
    node_id: makeId('graph_node'),
    owner_key: ownerKey,
    project_id: project.project_id,
    node_type: 'project',
    canonical_key: projectRootKey(project.project_id),
    title: project.project_name,
    summary: clip(project.context.description || project.context.current_status || project.context.current_task),
    metadata: {
      project_id: project.project_id,
      tech_stack: project.context.tech_stack || [],
    },
    confidence: 1,
    source_session_id: session.session_id,
    source_tool: session.tool,
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
}

function deriveEntities(project, session, _input) {
  const entities = [];
  const now = isoNow();

  // NO ENTITIES FROM SESSION METADATA. The session's cwd and host describe the
  // CALLER'S MACHINE — the local server sent os.hostname() ("Mac.richmond.edu")
  // and an absolute home path — not the project. Minted as durable graph nodes
  // ("Browser host associated with …", "Workspace rooted at /Users/…") they
  // surfaced in recall entities and shipped inside every exported Trail. The
  // session row still carries both for routing; they are simply not knowledge.
  for (const stackItem of project.context.tech_stack || []) {
    entities.push({
      node_type: 'service',
      canonical_key: `service:${normalizeKey(stackItem)}`,
      title: stackItem,
      summary: clip(`Technology or service used by ${project.project_name}`),
      metadata: { stack: stackItem },
      confidence: 0.72,
      edge_type: 'depends_on',
      edge_summary: `${project.project_name} depends on ${stackItem}`,
    });
  }

  for (const fileEntry of project.context.file_structure_summary || []) {
    const isFile = /[./]/.test(fileEntry) || fileEntry.includes(path.sep);
    entities.push({
      node_type: isFile ? 'file' : 'component',
      canonical_key: `${isFile ? 'file' : 'component'}:${normalizeKey(fileEntry)}`,
      title: fileEntry,
      summary: clip(`Relevant ${isFile ? 'file' : 'component'} for ${project.project_name}`),
      metadata: { path: fileEntry },
      confidence: 0.7,
      edge_type: 'contains',
      edge_summary: `${project.project_name} tracks ${fileEntry}`,
    });
  }

  if (project.context.current_task) {
    entities.push({
      node_type: 'task',
      canonical_key: `task:${normalizeKey(project.context.current_task)}`,
      title: clip(project.context.current_task, 80),
      summary: clip(project.context.current_task),
      metadata: { source: 'current_task' },
      confidence: 0.88,
      edge_type: 'tracks',
      edge_summary: `${project.project_name} is tracking an active task`,
    });
  }

  for (const decision of project.context.recent_decisions || []) {
    entities.push({
      node_type: 'decision',
      canonical_key: `decision:${normalizeKey(decision.summary)}`,
      title: clip(decision.summary, 80),
      summary: clip(decision.summary),
      metadata: { decided_at: decision.decided_at },
      confidence: 0.86,
      edge_type: 'decided_by',
      edge_summary: `${project.project_name} captured a recent decision`,
    });
  }

  return uniqueBy(
    entities.map((entity) => ({
      ...entity,
      owner_key: project.owner_key,
      project_id: project.project_id,
      source_session_id: session.session_id,
      source_tool: session.tool,
      created_at: now,
      updated_at: now,
      last_seen_at: now,
    })),
    (entity) => `${entity.node_type}:${entity.canonical_key}`
  );
}

// `land(entity)` answers where each derived entity is written — { key } — under
// the one landing rule every graph write uses (contextSyncService
// landGraphWrite). The rebuild derives nodes from the project's WHOLE stored
// context and records evidence for each in this project, and evidence is a read
// grant: landing by plain key merged a team project's "Redis" into a member's
// PERSONAL node of that name and published it to the team (scan 32). Omitted,
// or null (a workspace nobody else can have work in), the plain key is the node.
async function recordGraphArtifacts({ ownerKey, project, session, input, land = null }) {
  // Embedding calls (persistNodeEmbedding/persistEvidenceEmbedding) are live
  // OpenAI round-trips with no ordering dependency on each other or on the
  // cross-node edge derivation below — the previous code awaited each one
  // in turn inside the loop (~15 sequential round-trips per extraction).
  // Queue them here and let them run concurrently via Promise.all, each
  // wrapped in its own .catch() so ONE failed embedding can never fail the
  // others, the node/edge/evidence writes, or the extraction as a whole
  // (matching — and strengthening — the previous behavior, where a thrown
  // embedding error was only ever caught by applyExtraction's outer
  // try/catch around the whole recordGraphArtifacts call).
  const embeddingTasks = [];
  const queueNodeEmbedding = (node) => {
    embeddingTasks.push(
      persistNodeEmbedding(ownerKey, node).catch((err) => {
        console.warn('[GRAPH] Node embedding failed (non-fatal):', err.message);
      })
    );
  };
  const queueEvidenceEmbedding = (evidenceItem) => {
    embeddingTasks.push(
      persistEvidenceEmbedding(ownerKey, evidenceItem).catch((err) => {
        console.warn('[GRAPH] Evidence embedding failed (non-fatal):', err.message);
      })
    );
  };

  const rootNode = await store.upsertGraphNode(projectNode(ownerKey, project, session));
  queueNodeEmbedding(rootNode);
  const entities = deriveEntities(project, session, input);
  const nodes = [rootNode];
  const edges = [];
  const evidence = [];
  // NOTHING ANYBODY SAID IS STORED HERE. This used to be the first 400
  // characters of the conversation itself — `[user] ...\n[assistant] ...` —
  // written in plaintext on every entity's evidence row, while three public
  // pages said raw conversation text is never kept. `input` (the chunks) is
  // processed by extraction upstream and is not read here at all; each row
  // carries the line graphEvidenceLine writes from the entity's own type and
  // title and this project's name (see deriveEvidenceLine).

  // Node/edge/evidence upserts stay sequential and ordered (edges reference
  // from/to node_ids, evidence references node_id/edge_id) — only the
  // embedding persistence is deferred and batched.
  for (const entity of entities) {
    const landed = land ? await land(entity) : null;
    // A row homed anywhere but this project — the workspace's, or the writer's
    // own private note (the landing rule allows no other) — takes this
    // project's evidence and nothing else. Its title, description and metadata
    // are what its own readers wrote: the store replaces a short summary, so
    // "Technology or service used by <a member's personal project>" became the
    // team's "Postgres" line, naming a project nobody else may know exists
    // (scan 33). And so is its PROVENANCE: the store stamps the writing
    // session on the row, so the team's node carried the id of a member's
    // session in their personal project, served to every teammate (scan 34
    // a/F3). The session is on this project's evidence, where it is filtered.
    const foreign = landed?.node && landed.node.project_id !== project.project_id
      ? {
        title: landed.node.title,
        summary: landed.node.summary || '',
        metadata: {},
        source_session_id: landed.node.source_session_id || '',
        source_tool: landed.node.source_tool || entity.source_tool,
      }
      : {};
    const savedNode = await store.upsertGraphNode({
      ...entity,
      ...foreign,
      canonical_key: landed?.key || entity.canonical_key,
      node_id: makeId('graph_node'),
    });
    nodes.push(savedNode);
    queueNodeEmbedding(savedNode);

    const savedEdge = await store.upsertGraphEdge({
      edge_id: makeId('graph_edge'),
      owner_key: ownerKey,
      project_id: project.project_id,
      edge_type: entity.edge_type,
      from_node_id: rootNode.node_id,
      to_node_id: savedNode.node_id,
      summary: entity.edge_summary || `${project.project_name} relates to ${savedNode.title}`,
      metadata: entity.metadata || {},
      confidence: entity.confidence,
      source_session_id: session.session_id,
      source_tool: session.tool,
      created_at: entity.created_at,
      updated_at: entity.updated_at,
      last_seen_at: entity.last_seen_at,
    });
    edges.push(savedEdge);

    const savedEvidence = await store.addGraphEvidence({
      evidence_id: makeId('graph_evidence'),
      owner_key: ownerKey,
      project_id: project.project_id,
      session_id: session.session_id,
      node_id: savedNode.node_id,
      edge_id: savedEdge.edge_id,
      tool: session.tool,
      excerpt: deriveEvidenceLine({ nodeType: savedNode.node_type, title: savedNode.title, projectName: project.project_name }),
      excerpt_kind: EXCERPT_KIND_DERIVED,
      metadata: {
        conversation_ref: session.conversation_ref,
        cwd: session.cwd,
        host: session.host,
      },
      confidence: entity.confidence,
      created_at: isoNow(),
    });
    evidence.push(savedEvidence);
    queueEvidenceEmbedding(savedEvidence);
  }

  // Cross-node edges — best-effort, non-blocking
  try {
    const decisionNodes = nodes.filter((n) => n.node_type === 'decision');
    const fileNodes     = nodes.filter((n) => n.node_type === 'file' || n.node_type === 'component');
    const serviceNodes  = nodes.filter((n) => n.node_type === 'service');
    const taskNodes     = nodes.filter((n) => n.node_type === 'task');

    for (const dec of decisionNodes) {
      const decLower = (dec.title || '').toLowerCase();
      // decision → file when file name appears in decision summary
      for (const file of fileNodes) {
        const fileLower = (file.title || '').toLowerCase();
        if (fileLower.length >= 3 && decLower.includes(fileLower)) {
          await store.upsertGraphEdge({
            edge_id: makeId('graph_edge'), owner_key: ownerKey, project_id: project.project_id,
            edge_type: 'related_to', from_node_id: dec.node_id, to_node_id: file.node_id,
            summary: `Decision references ${file.title}`, metadata: { derived: 'text_match' },
            confidence: 0.72, source_session_id: session.session_id, source_tool: session.tool,
            created_at: isoNow(), updated_at: isoNow(), last_seen_at: isoNow(),
          });
        }
      }
      // decision → task (temporal co-occurrence)
      for (const task of taskNodes) {
        await store.upsertGraphEdge({
          edge_id: makeId('graph_edge'), owner_key: ownerKey, project_id: project.project_id,
          edge_type: 'related_to', from_node_id: dec.node_id, to_node_id: task.node_id,
          summary: `Decision made during: ${task.title}`, metadata: { derived: 'temporal' },
          confidence: 0.65, source_session_id: session.session_id, source_tool: session.tool,
          created_at: isoNow(), updated_at: isoNow(), last_seen_at: isoNow(),
        });
      }
    }

    // task → service when service name appears in task title
    for (const task of taskNodes) {
      const taskLower = (task.title || '').toLowerCase();
      for (const svc of serviceNodes) {
        const svcLower = (svc.title || '').toLowerCase();
        if (svcLower.length >= 3 && taskLower.includes(svcLower)) {
          await store.upsertGraphEdge({
            edge_id: makeId('graph_edge'), owner_key: ownerKey, project_id: project.project_id,
            edge_type: 'related_to', from_node_id: task.node_id, to_node_id: svc.node_id,
            summary: `Task involves ${svc.title}`, metadata: { derived: 'text_match' },
            confidence: 0.70, source_session_id: session.session_id, source_tool: session.tool,
            created_at: isoNow(), updated_at: isoNow(), last_seen_at: isoNow(),
          });
        }
      }
    }
  } catch (err) {
    console.warn('[GRAPH] Cross-node edges failed (non-fatal):', err.message);
  }

  // Fire all queued embedding persists concurrently instead of one at a time.
  // Each task already swallows its own error (see queueNodeEmbedding /
  // queueEvidenceEmbedding above), so Promise.all here can never reject.
  await Promise.all(embeddingTasks);

  return { nodes, edges, evidence };
}

async function getProjectGraph(ownerKey, projectId) {
  const [nodes, edges, evidence] = await Promise.all([
    store.listGraphNodesForProject(ownerKey, projectId),
    store.listGraphEdgesForProject(ownerKey, projectId),
    store.listGraphEvidenceForProject(ownerKey, projectId),
  ]);
  const recent = await store.listRecentGraphFacts(ownerKey, 120);
  const relatedProjectIds = Array.from(new Set(
    recent.edges
      .filter((edge) => edge.project_id && edge.project_id !== projectId)
      .filter((edge) => nodes.some((node) => node.node_id === edge.from_node_id || node.node_id === edge.to_node_id))
      .map((edge) => edge.project_id)
  ));
  const summaryLines = nodes.slice(0, 6).map((node) => `${node.node_type}: ${node.title}`);
  return parseGraphRetrieval({
    project_id: projectId,
    nodes,
    edges,
    evidence,
    related_project_ids: relatedProjectIds,
    summary_lines: summaryLines,
    provenance: [
      { kind: 'active_project', label: 'Project graph', project_id: projectId, confidence: 1 },
      ...relatedProjectIds.map((relatedProjectId) => ({
        kind: 'related_project',
        label: 'Shared graph node',
        project_id: relatedProjectId,
        confidence: 0.7,
      })),
    ],
  });
}

async function getSessionGraph(ownerKey, session) {
  if (!session?.project_id) {
    return parseGraphRetrieval({
      project_id: null,
      session_id: session?.session_id || null,
      nodes: [],
      edges: [],
      evidence: [],
      related_project_ids: [],
      summary_lines: [],
      provenance: [],
    });
  }

  const graph = await getProjectGraph(ownerKey, session.project_id);
  const recent = await store.listRecentGraphFacts(ownerKey, 160);
  const queryTerms = uniqueBy([
    normalizeKey(session.cwd && path.basename(session.cwd)),
    normalizeKey(session.host),
    normalizeKey(session.conversation_ref),
    normalizeKey(session.project_id),
  ].filter(Boolean), (value) => value);
  const candidateNodes = uniqueBy(
    [...graph.nodes, ...recent.nodes],
    (node) => node.node_id
  );
  const queryVector = await embeddings.embedText(sessionQueryText(session));
  const nodeEmbeddings = await store.getGraphEmbeddings(
    ownerKey,
    'node',
    candidateNodes.map((node) => node.node_id),
    embeddings.MODEL
  );
  const embeddingMap = new Map(nodeEmbeddings.map((item) => [item.target_id, item.vector]));

  const scoredNodes = candidateNodes
    .map((node) => {
      const vector = embeddingMap.get(node.node_id) || [];
      const embeddingScore = embeddings.cosineSimilarity(queryVector, vector);
      const score =
        (node.project_id === session.project_id ? 1 : 0) +
        lexicalScore(node, queryTerms) * 0.9 +
        embeddingScore * 0.8 +
        node.confidence * 0.25 +
        recencyScore(node.last_seen_at) * 0.15;
      return { node, score, embeddingScore };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.node);

  const nodeIds = new Set(scoredNodes.map((node) => node.node_id));
  const edges = uniqueBy(
    [...graph.edges, ...recent.edges].filter((edge) => nodeIds.has(edge.from_node_id) || nodeIds.has(edge.to_node_id)),
    (edge) => edge.edge_id
  ).slice(0, 12);
  const evidence = uniqueBy(
    [...graph.evidence, ...recent.evidence].filter((item) => !item.node_id || nodeIds.has(item.node_id)),
    (item) => item.evidence_id
  ).slice(0, 12);
  const relatedProjectIds = Array.from(new Set(
    [...scoredNodes.map((node) => node.project_id), ...edges.map((edge) => edge.project_id), ...evidence.map((item) => item.project_id)]
      .filter((id) => id && id !== session.project_id)
  ));

  if (scoredNodes[0]?.project_id && scoredNodes[0].project_id !== session.project_id) {
    console.info('[CONTEXT GRAPH] Related project evidence outranked active project', {
      session_id: session.session_id,
      active_project_id: session.project_id,
      related_project_id: scoredNodes[0].project_id,
      node_id: scoredNodes[0].node_id,
    });
  }

  return parseGraphRetrieval({
    project_id: session.project_id,
    session_id: session.session_id,
    nodes: scoredNodes,
    edges,
    evidence,
    related_project_ids: relatedProjectIds,
    summary_lines: scoredNodes.slice(0, 5).map((node) => `${node.node_type}: ${node.title}`),
    provenance: [
      { kind: 'session', label: `Session ${session.session_id}`, confidence: 1 },
      { kind: 'active_project', label: 'Active project graph', project_id: session.project_id, confidence: 1 },
      ...relatedProjectIds.map((projectId) => ({
        kind: 'related_project',
        label: 'Related project evidence',
        project_id: projectId,
        confidence: 0.7,
      })),
    ],
  });
}

async function getNodeGraph(ownerKey, nodeId) {
  const node = await store.getGraphNode(ownerKey, nodeId);
  if (!node) return null;
  const [edges, evidence] = await Promise.all([
    store.listGraphEdgesForNode(ownerKey, nodeId),
    store.listGraphEvidenceForNode(ownerKey, nodeId),
  ]);
  const relatedProjectIds = Array.from(new Set([node.project_id, ...evidence.map((item) => item.project_id)].filter(Boolean)));
  return parseGraphRetrieval({
    project_id: node.project_id || null,
    nodes: [node],
    edges,
    evidence,
    related_project_ids: relatedProjectIds,
    summary_lines: [`${node.node_type}: ${node.title}`],
    provenance: [{ kind: 'active_project', label: 'Node graph', project_id: node.project_id || undefined, node_id: node.node_id, confidence: node.confidence }],
  });
}

function buildGraphLines(graph, tool, verbosity) {
  const limit = verbosity === 'light' ? 2 : verbosity === 'detailed' ? 5 : 3;
  const evidenceCounts = new Map();
  for (const item of graph.evidence || []) {
    if (!item.node_id) continue;
    evidenceCounts.set(item.node_id, (evidenceCounts.get(item.node_id) || 0) + 1);
  }
  // A resolved decision stayed in every brief's Knowledge web line after
  // mark_resolved answered "will no longer appear in normal context loads" —
  // the graph reads that feed this line return closed nodes, as an explicit
  // graph read should, and nothing here looked at the status (scan 28).
  const rankedNodes = (graph.nodes || [])
    .filter((node) => !isInactiveGraphNode(node))
    .filter((node) => !isStaleLowSignalNode(node))
    .map((node) => ({
      node,
      score:
        graphNodePriority(node)
        + Number(node.confidence || 0)
        + recencyScore(node.last_seen_at)
        + Math.min(0.25, (evidenceCounts.get(node.node_id) || 0) * 0.08),
    }))
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => item.node);
  // Filter out task-type nodes — current task is already in the main brief
  const nonTaskNodes = rankedNodes.filter((node) => node.node_type !== 'task');
  // Cut the way the "Recent decisions" line two lines up cuts a decision
  // (shared-context clipText at the same budget): a 523-character decision was
  // shortened there and printed whole here, and the two copies of one decision
  // did not even read alike (scan 28). clipText also defangs an injected
  // heading, which a node title reaching the brief had skipped.
  const titleBudget = proseBudget(verbosity, 80);
  const nodeLines = nonTaskNodes.map((node) => `${node.node_type}: ${clipText(node.title, titleBudget)}`);
  const related = graph.related_project_ids.slice(0, 3);
  const lines = [
    nodeLines.length ? `Knowledge web: ${nodeLines.join(' | ')}` : '',
    related.length ? `Related projects: ${related.join(' | ')}` : '',
  ].filter(Boolean);
  // Cross-project evidence UUIDs and evidence lines removed — they duplicate
  // brief content and add ~40 tokens of noise with no AI-actionable value.
  return lines;
}

// ─── One-time repair: split the NAME-keyed project roots ─────────────────────
//
// Before projectRootKey, a root node was `project:<normalized name>`, so every
// project in a workspace with the same name shared one row (see projectRootKey).
// This re-keys each such row by project id, and where the row served MORE than
// one project it splits it: one root per project, each project's edges and
// evidence re-pointed onto its own root.
//
// Which text survives. A row that only ever served one project keeps its node
// id, summary, metadata and vector, and is simply re-keyed. A row that served
// several — or whose name another project in the same workspace also carries,
// since a project with no entities writes its summary onto the root and leaves
// no edge to say so — is AMBIGUOUS: nothing records whose words its summary and
// tech_stack are. Those are cleared on every resulting root (and the vector,
// which was computed from them, dropped), never assigned to a guess. The next
// extraction for each project refills its own root: the upsert replaces a
// summary shorter than 40 characters, and '' is.
//
// A legacy root is recognised by what projectNode wrote: node_type 'project'
// with metadata carrying BOTH project_id and tech_stack (merged with ||, so
// metadata.project_id is the LAST project that wrote it — itself a sighting). A
// 'project' entity somebody filed through upsert_entities carries neither and is
// not touched. A root with no project left at all (its project deleted) has no
// one to be split between and is left as it is.
//
// ONE OWNER AT A TIME, and the owner's evidence is read ONCE. The first version
// asked, per root, for every evidence row on every entity the root touched and
// filtered edge_id in JS — each shared entity carries evidence from EVERY
// project, so an owner with 300 projects on 40 entities read 60k rows 300 times
// (21.9s measured) inside the boot transaction. Now each owner's legacy roots,
// their edges and the evidence riding those edges (edge_id filtered in SQL) are
// loaded in three owner-scoped queries, and the per-root work reads that set,
// kept current as rows are re-pointed. Every query still leads with owner_key:
// edges on (owner_key, from_node_id) / (owner_key, to_node_id), evidence on
// (owner_key, node_id, project_id), per the graph index rule — never an
// unindexed edge_id scan.
//
// `exec(text, params)` is a query function. The deferred runner in autoMigrate
// (runProjectRootMigration) calls migrateProjectRootsForOwner once per owner,
// each in its own short transaction; migrateNameKeyedProjectRoots runs every
// owner through the one `exec` it is given.
const LEGACY_PROJECT_ROOT = `node_type = 'project'
        AND metadata ? 'project_id' AND metadata ? 'tech_stack'
        AND (project_id IS NULL OR canonical_key <> 'project:' || project_id)`;

function emptyRootMigrationStats() {
  return { roots: 0, rekeyed: 0, split: 0, rootsCreated: 0, edgesRepointed: 0, orphansSkipped: 0 };
}

// The owners that still hold a legacy root. This is the one query that no
// owner-leading index serves (it looks for the rows by shape across every
// owner), so it is run once per pass, outside any transaction that holds locks.
async function listOwnersWithLegacyProjectRoots(exec) {
  return (await exec(
    `SELECT DISTINCT owner_key FROM context_graph_nodes WHERE ${LEGACY_PROJECT_ROOT} ORDER BY owner_key`,
    []
  )).rows.map((row) => row.owner_key);
}

async function migrateNameKeyedProjectRoots(exec, options = {}) {
  const stats = emptyRootMigrationStats();
  const owners = options.ownerKey ? [options.ownerKey] : await listOwnersWithLegacyProjectRoots(exec);
  for (const ownerKey of owners) {
    const ownerStats = await migrateProjectRootsForOwner(exec, ownerKey);
    for (const key of Object.keys(stats)) stats[key] += ownerStats[key];
  }
  return stats;
}

// The evidence this owner's repair can touch, indexed two ways and kept current
// as rows move, so no root has to go back to the database for it.
function evidenceIndex() {
  const byId = new Map();
  const byEdge = new Map();
  const byNode = new Map();
  const add = (map, key, row) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(row);
  };
  const drop = (map, key, row) => {
    const set = key && map.get(key);
    if (set) set.delete(row);
  };
  return {
    put(row) {
      const known = byId.get(row.evidence_id);
      if (known) return;
      const copy = { evidence_id: row.evidence_id, edge_id: row.edge_id || null, node_id: row.node_id || null, project_id: row.project_id || null };
      byId.set(copy.evidence_id, copy);
      add(byEdge, copy.edge_id, copy);
      add(byNode, copy.node_id, copy);
    },
    move(evidenceId, change) {
      const row = byId.get(evidenceId);
      if (!row) return;
      if ('edge_id' in change) { drop(byEdge, row.edge_id, row); row.edge_id = change.edge_id; add(byEdge, row.edge_id, row); }
      if ('node_id' in change) { drop(byNode, row.node_id, row); row.node_id = change.node_id; add(byNode, row.node_id, row); }
    },
    onEdge(edgeId) { return [...(byEdge.get(edgeId) || [])]; },
    onNode(nodeId) { return [...(byNode.get(nodeId) || [])]; },
  };
}

async function migrateProjectRootsForOwner(exec, ownerKey) {
  const stats = emptyRootMigrationStats();
  // FOR UPDATE: an edge or evidence row that references a root takes a key-share
  // lock on it, so holding the legacy roots keeps an old machine (mid rolling
  // deploy) from hanging a new edge on one while it is being split. Held only
  // for this owner's transaction.
  const roots = (await exec(
    `SELECT node_id, owner_key, project_id, canonical_key, title, summary, metadata, confidence,
            source_session_id, source_tool, created_at, updated_at, last_seen_at
       FROM context_graph_nodes
      WHERE owner_key = $1 AND ${LEGACY_PROJECT_ROOT}
      ORDER BY created_at
      FOR UPDATE`,
    [ownerKey]
  )).rows;
  stats.roots = roots.length;
  if (!roots.length) return stats;

  const rootIds = roots.map((root) => root.node_id);
  const edgesOf = async (nodeIds) => (await exec(
    `SELECT * FROM context_graph_edges WHERE owner_key = $1 AND from_node_id = ANY($2::text[])
     UNION
     SELECT * FROM context_graph_edges WHERE owner_key = $1 AND to_node_id = ANY($2::text[])`,
    [ownerKey, nodeIds]
  )).rows;
  const farEndsOf = (edges, nodeIds) => {
    const own = new Set(nodeIds);
    const ends = new Set();
    edges.forEach((edge) => {
      if (own.has(edge.from_node_id)) ends.add(edge.to_node_id);
      if (own.has(edge.to_node_id)) ends.add(edge.from_node_id);
    });
    return [...ends];
  };

  // The evidence riding these edges is filed on the edge's far END (the entity)
  // — so it is reached through (owner_key, node_id), with the edge filter in SQL
  // so only the rows that ride one of these edges come back.
  const evidence = evidenceIndex();
  const loadedEdges = new Set();
  const loadEdgeEvidence = async (edges, nodeIds) => {
    const fresh = edges.filter((edge) => !loadedEdges.has(edge.edge_id));
    if (!fresh.length) return;
    const farEnds = farEndsOf(fresh, nodeIds);
    if (farEnds.length) {
      (await exec(
        `SELECT evidence_id, edge_id, node_id, project_id FROM context_graph_evidence
          WHERE owner_key = $1 AND node_id = ANY($2::text[]) AND edge_id = ANY($3::text[])`,
        [ownerKey, farEnds, fresh.map((edge) => edge.edge_id)]
      )).rows.forEach((row) => evidence.put(row));
    }
    fresh.forEach((edge) => loadedEdges.add(edge.edge_id));
  };
  // Every legacy root's edges, read once. A root whose edges an earlier root
  // in this loop rewrote (an edge between two roots) is re-read — `touched`.
  const initialEdges = await edgesOf(rootIds);
  await loadEdgeEvidence(initialEdges, rootIds);
  const edgesByNode = new Map();
  initialEdges.forEach((edge) => {
    [...new Set([edge.from_node_id, edge.to_node_id])].forEach((nodeId) => {
      if (!edgesByNode.has(nodeId)) edgesByNode.set(nodeId, []);
      edgesByNode.get(nodeId).push(edge);
    });
  });
  const touched = new Set();
  (await exec(
    `SELECT evidence_id, edge_id, node_id, project_id FROM context_graph_evidence
      WHERE owner_key = $1 AND node_id = ANY($2::text[])`,
    [ownerKey, rootIds]
  )).rows.forEach((row) => evidence.put(row));

  const ownerProjects = (await exec(
    'SELECT project_id, project_name FROM context_projects WHERE owner_key = $1',
    [ownerKey]
  )).rows;
  const nameOf = new Map(ownerProjects.map((row) => [row.project_id, row.project_name]));
  const projectExists = new Map(ownerProjects.map((row) => [row.project_id, true]));
  // This owner's project roots by key, kept current as rows are re-keyed,
  // created and removed below.
  const rootByKey = new Map((await exec(
    'SELECT canonical_key, node_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2',
    [ownerKey, 'project']
  )).rows.map((row) => [row.canonical_key, row.node_id]));
  async function projectName(projectId, fallback) {
    if (nameOf.get(projectId)) return nameOf.get(projectId);
    const row = (await exec('SELECT project_name FROM context_projects WHERE project_id = $1', [projectId])).rows[0];
    return (row && row.project_name) || fallback;
  }

  for (const root of roots) {
    const edges = touched.has(root.node_id) ? await edgesOf([root.node_id]) : (edgesByNode.get(root.node_id) || []);
    await loadEdgeEvidence(edges, [root.node_id]);
    const farEnds = new Set(farEndsOf(edges, [root.node_id]));
    const edgeEvidence = edges.flatMap((edge) => evidence.onEdge(edge.edge_id).filter((row) => farEnds.has(row.node_id)));
    const nodeEvidence = evidence.onNode(root.node_id);

    const lastWriter = root.metadata && typeof root.metadata.project_id === 'string' ? root.metadata.project_id : null;
    const sighted = new Set([root.project_id, lastWriter].filter(Boolean));
    edges.forEach((edge) => { if (edge.project_id) sighted.add(edge.project_id); });
    edgeEvidence.forEach((row) => { if (row.project_id) sighted.add(row.project_id); });
    nodeEvidence.forEach((row) => { if (row.project_id) sighted.add(row.project_id); });
    // A sighting is only a project if the project still exists (FKs SET NULL on
    // delete, but metadata.project_id is not a foreign key).
    const unknown = [...sighted].filter((projectId) => !projectExists.has(projectId));
    if (unknown.length) {
      const found = new Set((await exec('SELECT project_id FROM context_projects WHERE project_id = ANY($1::text[])', [unknown])).rows.map((row) => row.project_id));
      unknown.forEach((projectId) => projectExists.set(projectId, found.has(projectId)));
    }
    const existing = new Set([...sighted].filter((projectId) => projectExists.get(projectId)));
    const projects = [...sighted].filter((projectId) => existing.has(projectId));
    if (!projects.length) {
      stats.orphansSkipped += 1;
      continue;
    }
    const home = root.project_id && existing.has(root.project_id) ? root.project_id : projects[0];
    const sameName = ownerProjects
      .filter((row) => `project:${normalizeKey(row.project_name || row.project_id)}` === root.canonical_key).length;
    const ambiguous = projects.length > 1 || sameName > 1;

    // The home project's root: this row, re-keyed in place — unless a root with
    // the new key already exists (written after the new code shipped), in which
    // case that one is home and this row is merged into it and removed.
    const rootFor = new Map();
    const homeKey = projectRootKey(home);
    const already = rootByKey.has(homeKey) ? { node_id: rootByKey.get(homeKey) } : null;
    const keepRow = !already;
    if (keepRow) {
      await exec(
        `UPDATE context_graph_nodes
            SET canonical_key = $3, project_id = $4, title = $5,
                summary = CASE WHEN $6 THEN '' ELSE summary END,
                metadata = CASE WHEN $6 THEN jsonb_build_object('project_id', $4::text, 'tech_stack', '[]'::jsonb)
                                ELSE metadata || jsonb_build_object('project_id', $4::text) END
          WHERE owner_key = $1 AND node_id = $2`,
        [ownerKey, root.node_id, homeKey, home, await projectName(home, root.title), ambiguous]
      );
      rootFor.set(home, root.node_id);
      if (rootByKey.get(root.canonical_key) === root.node_id) rootByKey.delete(root.canonical_key);
      rootByKey.set(homeKey, root.node_id);
      stats.rekeyed += 1;
    } else {
      rootFor.set(home, already.node_id);
    }
    if (ambiguous) stats.split += 1;

    for (const projectId of projects) {
      if (rootFor.has(projectId)) continue;
      const key = projectRootKey(projectId);
      if (rootByKey.has(key)) {
        rootFor.set(projectId, rootByKey.get(key));
        continue;
      }
      const created = (await exec(
        `INSERT INTO context_graph_nodes
           (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence,
            source_session_id, source_tool, created_at, updated_at, last_seen_at)
         VALUES ($1, $2, $3, 'project', $4, $5, '', jsonb_build_object('project_id', $3::text, 'tech_stack', '[]'::jsonb),
                 $6, $7, $8, $9, $10, $11)
         ON CONFLICT (owner_key, node_type, canonical_key) DO NOTHING
         RETURNING node_id`,
        [makeId('graph_node'), ownerKey, projectId, key, await projectName(projectId, root.title), root.confidence,
          root.source_session_id || '', root.source_tool, root.created_at, root.updated_at, root.last_seen_at]
      )).rows[0];
      if (created) {
        rootFor.set(projectId, created.node_id);
        stats.rootsCreated += 1;
      } else {
        rootFor.set(projectId, (await exec(
          'SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = $2 AND canonical_key = $3',
          [ownerKey, 'project', key]
        )).rows[0].node_id);
      }
      rootByKey.set(key, rootFor.get(projectId));
    }

    // Writes are collected and sent per root in a handful of set-based
    // statements, not one round trip per edge and per evidence row (a split of
    // one 40-edge root was ~120 statements, and a 50-pair owner ~6,000).
    const swap = (nodeId, target) => (nodeId === root.node_id ? target : nodeId);
    const copies = new Map(); // (edge_type, from, to) -> the new edge row and the evidence to carry onto it
    const rehome = [];
    const doomed = [];
    let edgesMoved = 0;
    for (const edge of edges) {
      const edgeRows = edgeEvidence.filter((row) => row.edge_id === edge.edge_id);
      const primary = edge.project_id && rootFor.has(edge.project_id) ? edge.project_id : home;
      const targets = [...new Set([primary, ...edgeRows.map((row) => row.project_id).filter((id) => id && rootFor.has(id))])];
      // This edge row itself can stay only as the HOME root's edge, and only
      // when this row is the home root.
      const keepEdge = keepRow && targets.includes(home);
      // An edge that cannot stay where it is is MOVED, not copied and deleted,
      // whenever nothing already occupies its new endpoints: deleting an edge
      // fires the evidence FK's ON DELETE CASCADE, and evidence.edge_id leads no
      // index, so every delete is a scan of the whole (all-owner) evidence
      // table. The moved row keeps its id, so the evidence already on it stays.
      let movedInPlace = false;
      for (const projectId of targets) {
        const target = rootFor.get(projectId);
        const from = swap(edge.from_node_id, target);
        const to = swap(edge.to_node_id, target);
        if (!keepEdge && !movedInPlace && projectId === primary) {
          const clash = (await exec(
            `SELECT 1 FROM context_graph_edges
              WHERE owner_key = $1 AND edge_type = $2 AND from_node_id = $3 AND to_node_id = $4 AND edge_id <> $5`,
            [ownerKey, edge.edge_type, from, to, edge.edge_id]
          )).rows[0];
          if (!clash) {
            await exec(
              `UPDATE context_graph_edges SET project_id = $3, from_node_id = $4, to_node_id = $5
                WHERE owner_key = $1 AND edge_id = $2`,
              [ownerKey, edge.edge_id, projectId, from, to]
            );
            movedInPlace = true;
            edgesMoved += 1;
            stats.edgesRepointed += 1;
            continue;
          }
        }
        if (!(keepEdge && projectId === home)) {
          const ids = edgeRows
            .filter((row) => row.project_id === projectId || (!row.project_id && projectId === primary))
            .map((row) => row.evidence_id);
          const key = JSON.stringify([edge.edge_type, from, to]);
          if (copies.has(key)) {
            copies.get(key).ids.push(...ids);
          } else {
            copies.set(key, {
              ids,
              row: [makeId('graph_edge'), ownerKey, projectId, edge.edge_type, from, to,
                edge.summary || '', edge.metadata || {}, edge.confidence, edge.source_session_id || '', edge.source_tool,
                edge.created_at, edge.updated_at, edge.last_seen_at],
            });
          }
        } else if (edge.project_id !== home) {
          rehome.push(edge.edge_id);
        }
      }
      if (!keepEdge && !movedInPlace) doomed.push(edge.edge_id);
    }

    if (rehome.length) {
      await exec(
        'UPDATE context_graph_edges SET project_id = $3 WHERE owner_key = $1 AND edge_id = ANY($2::text[])',
        [ownerKey, rehome, home]
      );
    }
    const pending = [...copies.values()];
    const evidenceMoves = [];
    for (let start = 0; start < pending.length; start += 500) {
      const chunk = pending.slice(start, start + 500);
      const params = [];
      const values = chunk.map(({ row }) => {
        const base = params.length;
        params.push(...row);
        return `(${row.map((_, i) => `$${base + i + 1}`).join(', ')})`;
      });
      const written = (await exec(
        `INSERT INTO context_graph_edges
           (edge_id, owner_key, project_id, edge_type, from_node_id, to_node_id, summary, metadata, confidence,
            source_session_id, source_tool, created_at, updated_at, last_seen_at)
         VALUES ${values.join(', ')}
         ON CONFLICT (owner_key, edge_type, from_node_id, to_node_id) DO UPDATE SET
           last_seen_at = GREATEST(context_graph_edges.last_seen_at, EXCLUDED.last_seen_at)
         RETURNING edge_id, edge_type, from_node_id, to_node_id, (xmax = 0) AS inserted`,
        params
      )).rows;
      const byKey = new Map(written.map((row) => [JSON.stringify([row.edge_type, row.from_node_id, row.to_node_id]), row]));
      for (const copy of chunk) {
        const [, , , edgeType, from, to] = copy.row;
        const landed = byKey.get(JSON.stringify([edgeType, from, to]));
        // A brand-new edge carries exactly the evidence moved onto it below,
        // so nothing about it needs reading back. One that already existed
        // may carry evidence this pass never loaded — leave it unloaded, and a
        // later root that reaches it reads it then.
        if (landed.inserted) loadedEdges.add(landed.edge_id);
        stats.edgesRepointed += 1;
        copy.ids.forEach((id) => evidenceMoves.push([id, landed.edge_id]));
      }
    }
    // Evidence moves BEFORE the edges it rode are deleted: the FK cascades.
    if (evidenceMoves.length) {
      await exec(
        `UPDATE context_graph_evidence ev SET edge_id = m.edge_id
           FROM unnest($2::text[], $3::text[]) AS m(evidence_id, edge_id)
          WHERE ev.owner_key = $1 AND ev.evidence_id = m.evidence_id`,
        [ownerKey, evidenceMoves.map(([id]) => id), evidenceMoves.map(([, edgeId]) => edgeId)]
      );
      evidenceMoves.forEach(([id, edgeId]) => evidence.move(id, { edge_id: edgeId }));
    }
    if (doomed.length) {
      await exec('DELETE FROM context_graph_edges WHERE owner_key = $1 AND edge_id = ANY($2::text[])', [ownerKey, doomed]);
    }
    // Whatever sits at the far end of an edge rewritten here has a changed edge
    // list; if it is a legacy root still to come, it re-reads its edges.
    if (edgesMoved || copies.size || rehome.length || doomed.length) farEnds.forEach((nodeId) => touched.add(nodeId));

    const nodeMoves = nodeEvidence
      .map((row) => [row.evidence_id, rootFor.get(row.project_id && rootFor.has(row.project_id) ? row.project_id : home)])
      .filter(([, target]) => target !== root.node_id);
    if (nodeMoves.length) {
      await exec(
        `UPDATE context_graph_evidence ev SET node_id = m.node_id
           FROM unnest($2::text[], $3::text[]) AS m(evidence_id, node_id)
          WHERE ev.owner_key = $1 AND ev.evidence_id = m.evidence_id`,
        [ownerKey, nodeMoves.map(([id]) => id), nodeMoves.map(([, target]) => target)]
      );
      nodeMoves.forEach(([id, target]) => evidence.move(id, { node_id: target }));
    }

    if (ambiguous || !keepRow) {
      await exec(
        `DELETE FROM context_graph_embeddings
          WHERE owner_key = $1 AND target_kind = 'node' AND target_id = $2`,
        [ownerKey, root.node_id]
      );
    }
    if (!keepRow) {
      await exec('DELETE FROM context_graph_nodes WHERE owner_key = $1 AND node_id = $2', [ownerKey, root.node_id]);
      if (rootByKey.get(root.canonical_key) === root.node_id) rootByKey.delete(root.canonical_key);
    }
  }
  return stats;
}

module.exports = {
  recordGraphArtifacts,
  migrateNameKeyedProjectRoots,
  migrateProjectRootsForOwner,
  listOwnersWithLegacyProjectRoots,
  projectRootKey,
  getProjectGraph,
  getSessionGraph,
  getNodeGraph,
  buildGraphLines,
  keepParseableNodes,
  INACTIVE_NODE_STATUSES,
  isInactiveGraphNode,
  // Phase 5 of the vault job reads a decision's full text back out of the key
  // and the clip; it must use the same functions the extractor wrote them with.
  normalizeKey,
  clip,
};
