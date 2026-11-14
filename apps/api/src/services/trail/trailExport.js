'use strict';

// Build a .dawn Trail from a project.
//
// Pure: everything this needs is passed in, so the shape of an export is
// testable without a database. trailService.js does the fetching.
//
// What a Trail is: the accumulated, queryable memory of one project — the brief
// spine, the decisions and why they were made, the knowledge graph, the hot
// paths, the debugging findings, the commands, and the board. What a Trail is
// NOT: anything identifying its owner. owner_key, owner_user_id, linked
// filesystem paths, linked conversations, tool_presence and per-session
// telemetry are all dropped here rather than filtered downstream, because the
// safe default for a format designed to be published is to never carry the
// field in the first place.

const { DAWN_FORMAT, DAWN_FORMAT_VERSION, sealTrail, emptyContent, normalizeKind } = require('./trailFormat');

const TRAIL_SPEC_VERSION = 1;

// Brief fields that travel. Enumerated rather than spread so a new context field
// added upstream is opt-in to publication, never opt-out — the failure mode of a
// spread here is a future field silently shipping to a public gallery.
const BRIEF_FIELDS = [
  'project_name',
  'category',
  'description',
  'goals',
  'current_status',
  'current_task',
  'next_action',
  'blocking_issue',
  'task_progress',
  'tech_stack',
  'recurring_context',
  'file_structure_summary',
  'open_questions',
  'entrypoints',
  'surfaces',
  'landmines',
  'shipped',
];

// Two BRIEF_FIELDS are arrays of objects that ride out whole rather than being
// picked field by field, and those objects now carry who wrote them.
//
// An author id is workspace bookkeeping of exactly the kind the header above
// drops on principle: owner_user_id never travels, and neither does the
// `contributed_by` on a decision or a finding — both of those lists are picked
// field by field and simply never name it. Landmines and shipped entries are
// copied as-is, so the same rule has to be applied to them by hand or the one
// format designed to be PUBLISHED walks out with a member id on every entry.
//
// The entries themselves still travel. This strips the author, not the warning.
const UNSHAREABLE_ENTRY_FIELDS = ['contributed_by', 'confirmed_by'];

function stripEntryAuthors(entries) {
  if (!Array.isArray(entries)) return entries;
  return entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    const out = { ...entry };
    for (const field of UNSHAREABLE_ENTRY_FIELDS) delete out[field];
    return out;
  });
}

function pickDefined(source, fields) {
  const out = {};
  for (const field of fields) {
    const value = source?.[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && !value.trim()) continue;
    out[field] = value;
  }
  return out;
}

// Graph nodes carry storage bookkeeping (owner_key, embeddings, internal
// counters) that has no meaning outside the account it came from. Keep the
// semantic surface, drop the rest.
const NODE_FIELDS = ['node_id', 'node_type', 'title', 'body', 'status', 'surface', 'metadata', 'created_at', 'updated_at'];
const EDGE_FIELDS = ['edge_type', 'from_node_id', 'to_node_id', 'metadata', 'created_at'];

// A stored node's text is its `summary`; the Trail calls it `body` (the field
// trailImport reads back). Picked by the Trail's name only, the summary never
// made the file, and a round trip came back with every node's description
// gone (scan 31). Same redaction basis as every other string in `content`.
function buildGraph(graph) {
  const nodes = (graph?.nodes || []).map((node) => pickDefined({ ...node, body: node?.body ?? node?.summary }, NODE_FIELDS));
  const nodeIds = new Set(nodes.map((node) => node.node_id).filter(Boolean));
  // Drop dangling edges: an edge pointing at a node that did not make the export
  // would make the imported graph unresolvable, which is exactly the failure the
  // import-verification card is about.
  const edges = (graph?.edges || [])
    .map((edge) => pickDefined(edge, EDGE_FIELDS))
    .filter((edge) => nodeIds.has(edge.from_node_id) && nodeIds.has(edge.to_node_id));
  return { nodes, edges };
}

function buildBoard(context) {
  const cards = [];
  const seen = new Set();
  for (const card of [...(context?.todo_items || []), ...(context?.completed_todos || [])]) {
    if (!card || !card.title) continue;
    const id = card.id || `card-${cards.length}`;
    if (seen.has(id)) continue;
    seen.add(id);
    // `body` travels. It is the card detail — the repro steps, the file path, the
    // spec — and a board exported without it is a list of headlines, which is the
    // shape the body was added to fix. Enumerated deliberately, per the
    // BRIEF_FIELDS rule above: this is an opt-in, not a spread.
    //
    // It is free text the author wrote and may contain anything, so it rides out
    // only because the redaction gate covers it structurally: trailScan.walkStrings
    // walks every string in `content` by shape, not by allowlist, so a body is
    // reported as `content.board.cards[i].body` with entity board_card:<id>, and
    // trailPublish refuses to publish an unresolved finding. Graph node `body`
    // already ships on the same basis (NODE_FIELDS above).
    cards.push(pickDefined({ ...card, id }, ['id', 'title', 'body', 'phase', 'created_at', 'updated_at', 'completed_at']));
  }
  return { cards };
}

/**
 * Build the content block of a Trail from a project's stored context + graph.
 * @param {object} project
 * @param {object} graph
 * @returns {object}
 */
function buildContent(project, graph) {
  const context = project?.context || {};
  const content = emptyContent();
  content.brief = pickDefined({
    ...context,
    project_name: project?.project_name || context.project_name,
    landmines: stripEntryAuthors(context.landmines),
    shipped: stripEntryAuthors(context.shipped),
  }, BRIEF_FIELDS);
  content.decisions = (context.recent_decisions || []).map((entry) =>
    pickDefined(entry, ['summary', 'reasoning', 'importance', 'decided_at', 'resolved', 'resolved_at']));
  content.graph = buildGraph(graph);
  content.paths = (context.hot_paths || []).map((entry) => pickDefined(entry, ['path', 'label', 'why', 'recorded_at']));
  content.findings = (context.debugging_notes || []).map((entry) =>
    pickDefined(entry, ['summary', 'paths', 'fix_commit', 'recorded_at', 'resolved']));
  content.commands = (context.commands || []).map((entry) => pickDefined(entry, ['label', 'command', 'why']));
  content.board = buildBoard(context);
  return content;
}

function countContent(content) {
  return {
    brief_fields: Object.keys(content.brief || {}).length,
    decisions: (content.decisions || []).length,
    graph_nodes: (content.graph?.nodes || []).length,
    graph_edges: (content.graph?.edges || []).length,
    paths: (content.paths || []).length,
    findings: (content.findings || []).length,
    commands: (content.commands || []).length,
    board_cards: (content.board?.cards || []).length,
  };
}

/**
 * Normalize the source pin. A Trail claims to describe a codebase at a point in
 * time; without a commit SHA that claim is unfalsifiable and the freshness work
 * (behind-by-N) has nothing to compare against. We do not invent one — if the
 * caller cannot supply it, the manifest says so out loud so the gallery can
 * label the Trail "unpinned" rather than implying currency it does not have.
 */
function normalizeSource(source) {
  const repoUrl = String(source?.repo_url || '').trim();
  const commitSha = String(source?.commit_sha || '').trim();
  const pinned = Boolean(repoUrl && /^[0-9a-f]{7,40}$/i.test(commitSha));
  return {
    repo_url: repoUrl || null,
    commit_sha: commitSha || null,
    branch: String(source?.branch || '').trim() || null,
    pinned,
    // Why it isn't pinned, so the author sees a reason instead of a silent flag.
    unpinned_reason: pinned
      ? null
      : (!repoUrl ? 'no_repo_url' : (!commitSha ? 'no_commit_sha' : 'invalid_commit_sha')),
  };
}

/**
 * Provenance. A fresh export is its own origin; a fork carries its ancestry
 * forward so attribution survives re-export (the lineage work in P1 reads this).
 */
function normalizeProvenance(provenance, trailId, exportedAt) {
  const parent = provenance?.forked_from || null;
  const inheritedLineage = Array.isArray(provenance?.lineage) ? provenance.lineage : [];
  return {
    trail_id: trailId,
    author: provenance?.author || null,
    forked_from: parent,
    // Oldest first. A fork appends its parent's entry, so the head of the list
    // is always the original author of the idea.
    lineage: parent
      ? [...inheritedLineage, { trail_id: parent.trail_id || null, author: parent.author || null, at: parent.at || exportedAt }]
      : inheritedLineage,
    generation: parent ? inheritedLineage.length + 1 : 0,
  };
}

/**
 * Build a complete, sealed Trail.
 *
 * @param {object} input
 * @param {object} input.project stored project row (context + project_name)
 * @param {object} [input.graph] { nodes, edges }
 * @param {object} [input.source] { repo_url, commit_sha, branch }
 * @param {object} [input.provenance] { author, forked_from, lineage }
 * @param {object} [input.exporter] { tool, version }
 * @param {'project'|'pack'} [input.kind] 'pack' when the Trail is curated knowledge
 *   meant for other people's projects rather than a record of this one
 * @param {string} [input.trailId]
 * @param {string} [input.exportedAt]
 * @returns {object} sealed Trail (checksum attached)
 */
function buildTrail(input) {
  const project = input?.project;
  if (!project) {
    const error = new Error('trail_export_no_project');
    error.publicMessage = 'trail_export_no_project: nothing to export.';
    throw error;
  }
  const exportedAt = input.exportedAt || new Date().toISOString();
  const trailId = input.trailId || `trail_${require('crypto').randomUUID()}`;
  const content = buildContent(project, input.graph);

  const trail = {
    format: DAWN_FORMAT,
    format_version: DAWN_FORMAT_VERSION,
    manifest: {
      spec_version: TRAIL_SPEC_VERSION,
      trail_id: trailId,
      // What this Trail is FOR. A pack is imported into other people's projects,
      // so the importer drops the brief fields that describe this one — see
      // PACK_BRIEF_FIELDS in trailImport.js. The content block is built the same
      // way either way: kind changes what a reader takes, not what we write.
      kind: normalizeKind(input.kind),
      title: project.project_name || content.brief.project_name || 'Untitled Trail',
      description: content.brief.description || '',
      exported_at: exportedAt,
      exporter: {
        tool: input.exporter?.tool || 'deerdawn',
        version: input.exporter?.version || null,
      },
      source: normalizeSource(input.source),
      provenance: normalizeProvenance(input.provenance, trailId, exportedAt),
      counts: countContent(content),
      // Filled in by the publish gate. An unpublished export carries the empty
      // shape so the field is never mistaken for "scan passed".
      redaction: input.redaction || { scanned: false, scanner_version: null, scanned_at: null, excluded_paths: [] },
    },
    content,
  };

  return sealTrail(trail);
}

module.exports = {
  TRAIL_SPEC_VERSION,
  BRIEF_FIELDS,
  buildTrail,
  buildContent,
  buildGraph,
  buildBoard,
  countContent,
  normalizeSource,
  normalizeProvenance,
};
