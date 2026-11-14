'use strict';

// Import a .dawn Trail into a project.
//
// ─── The one rule ────────────────────────────────────────────────────────────
// An import must never destroy what the target project already knows. Someone
// pulling a community Trail into a project they have been building for months
// is asking to ADD a perspective, not to hand their memory over to a stranger.
// If import can clobber, nobody imports twice.
//
// Concretely:
//   • Scalar brief fields (current_task, current_status, description, …) are
//     fill-only. An existing non-empty value always wins; the incoming value is
//     reported as a conflict the caller can surface, never silently applied.
//   • List fields are unioned, computed HERE rather than delegated. This is not
//     redundant with mergeContextObject: that function replaces goals/tech_stack/
//     recurring_context/file_structure_summary wholesale when the delta carries
//     them (`delta.goals ? uniqueStrings(delta.goals) : current.goals`), which is
//     right for an extraction that just observed the whole project and wrong for
//     a foreign Trail. Passing a precomputed union makes the replace a no-op.
//   • Commands are added by label only when the label is new — a project's own
//     `make dev` outranks an imported one.
//   • Board cards are added only when no card with that title exists.
//   • Graph nodes go through the normal entity upsert, which dedupes on the
//     canonical key, so importing a Trail twice converges instead of doubling.
//
// ─── Packs take even less ────────────────────────────────────────────────────
// A Trail with manifest.kind === 'pack' is curated knowledge about a stack,
// written to be imported into projects it was never part of. Fill-only already
// makes that safe for an established project, but not for an EMPTY one: a fresh
// project importing a pack would take the pack author's current_task,
// next_action and goals as its own, and the next brief would confidently report
// somebody else's work as yours. So a pack donates only PACK_BRIEF_FIELDS and
// none of the board. What it does donate is the part worth having — decisions,
// hot paths, findings, commands and the graph.
//
// This module is pure and returns a PLAN. trailService.js applies it.

const { parseTrail, trailKind } = require('./trailFormat');

// Byte-for-byte mirror of normalizeKey/canonicalWorkspaceKey in
// contextSyncService. It has to be exact: upsertWorkspaceEntities resolves a
// relation's endpoints by canonical key and skips the edge when either misses
// (`if (!fromNode || !toNode) continue;`). Any drift here therefore produces an
// import that reports success while silently discarding the entire graph
// structure — no error, no warning, just a flat set of nodes.
//
// trail-import.test.js extracts both functions from the service source and
// asserts they agree; it has already caught one drift. Do not "simplify" this.
function normalizeKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/[^a-z0-9._:/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function canonicalKeyFor(entityType, title) {
  return `${entityType}:${normalizeKey(title)}`;
}

// Trail graph node_type -> workspace entity_type. The graph stores a wider set
// of node types than the entity upsert accepts; anything unrecognized lands on
// 'knowledge', which is lossy in label only — the title and body survive.
const ENTITY_TYPE_BY_NODE_TYPE = {
  service: 'service',
  tool: 'tool',
  environment: 'environment',
  database: 'database',
  repo: 'repo',
  capability: 'capability',
  workflow: 'workflow',
  feature: 'feature',
  decision: 'decision',
  question: 'question',
  preference: 'preference',
  concept: 'concept',
  pattern: 'pattern',
  knowledge: 'knowledge',
};

const FILL_ONLY_SCALARS = [
  'description',
  'current_status',
  'current_task',
  'next_action',
  'blocking_issue',
  'task_progress',
  'category',
];

const UNION_LISTS = [
  'goals',
  'tech_stack',
  'recurring_context',
  'file_structure_summary',
  'open_questions',
];

// The only brief fields a PACK is allowed to donate. An allow-list rather than a
// deny-list, for the same reason BRIEF_FIELDS in trailExport.js is one: a field
// added upstream should have to be opted IN to a stranger's brief. The failure
// mode of a deny-list here is a new field silently landing in someone's project.
//
//   tech_stack       — what the pack is about; unioned, so it only ever adds.
//   recurring_context — the standing facts that make the pack useful at all.
//   landmines        — the whole point of a pack; deduped on summary upstream.
//
// Everything else in the brief describes the pack author's project: what they
// are working on (current_task, next_action, blocking_issue, task_progress),
// what it is (description, category, project_name), where they are going
// (goals, open_questions), and what it is made of (file_structure_summary,
// entrypoints, surfaces, shipped).
const PACK_BRIEF_FIELDS = ['tech_stack', 'recurring_context', 'landmines'];

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return !value.trim();
  if (Array.isArray(value)) return value.length === 0;
  return false;
}

function unionStrings(existing, incoming) {
  const out = [];
  const seen = new Set();
  for (const entry of [...(existing || []), ...(incoming || [])]) {
    const value = String(entry || '').trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// Dedupe objects against what the project already holds, on a caller-chosen key.
function additionsOnly(existing, incoming, keyOf) {
  const seen = new Set((existing || []).map((entry) => keyOf(entry)).filter(Boolean));
  const additions = [];
  for (const entry of incoming || []) {
    const key = keyOf(entry);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    additions.push(entry);
  }
  return additions;
}

/**
 * Plan an import of a Trail into a project.
 *
 * @param {object|string} trailInput a parsed Trail or raw .dawn contents
 * @param {object|null} targetProject the project being merged into (null = new project)
 * @param {{verifyChecksum?: boolean, attribution?: boolean}} [options]
 * @returns {{
 *   trail: object,
 *   patch: object,
 *   entities: object[],
 *   relations: object[],
 *   conflicts: object[],
 *   summary: object,
 * }}
 */
function planImport(trailInput, targetProject, options = {}) {
  const trail = parseTrail(trailInput, { requireChecksum: options.verifyChecksum !== false });
  const content = trail.content || {};
  const brief = content.brief || {};
  const current = targetProject?.context || {};

  const patch = {};
  const conflicts = [];

  // A pack donates knowledge, not identity — see PACK_BRIEF_FIELDS. Skipped
  // fields are collected rather than dropped in silence, so the caller can say
  // "this pack also carried a current_task; it was not applied" instead of the
  // importer wondering where it went.
  const isPack = trailKind(trail) === 'pack';
  const skippedBriefFields = [];
  const skipsForPack = (field) => {
    if (!isPack || PACK_BRIEF_FIELDS.includes(field)) return false;
    if (!isEmptyValue(brief[field])) skippedBriefFields.push(field);
    return true;
  };

  // Fill-only scalars.
  for (const field of FILL_ONLY_SCALARS) {
    if (skipsForPack(field)) continue;
    const incoming = brief[field];
    if (isEmptyValue(incoming)) continue;
    if (isEmptyValue(current[field])) {
      patch[field] = incoming;
    } else if (String(current[field]).trim() !== String(incoming).trim()) {
      conflicts.push({
        field,
        kept: current[field],
        incoming,
        resolution: 'kept_existing',
      });
    }
  }

  // Unioned lists — computed here so mergeContextObject's replace semantics
  // become a no-op rather than a clobber.
  for (const field of UNION_LISTS) {
    if (skipsForPack(field)) continue;
    const incoming = brief[field];
    if (isEmptyValue(incoming)) continue;
    const merged = unionStrings(current[field], incoming);
    if (merged.length !== (current[field] || []).length) patch[field] = merged;
  }

  // Landmines and shipped entries are append-and-dedupe upstream; pass only the
  // genuinely new ones so the merge has nothing to reconcile.
  const newLandmines = skipsForPack('landmines') ? [] : additionsOnly(current.landmines, brief.landmines, (entry) => String(entry?.summary || '').trim().toLowerCase());
  if (newLandmines.length) patch.landmines = [...(current.landmines || []), ...newLandmines];
  const newShipped = skipsForPack('shipped') ? [] : additionsOnly(current.shipped, brief.shipped, (entry) => String(entry?.summary || entry?.text || '').trim().toLowerCase());
  if (newShipped.length) patch.shipped = [...(current.shipped || []), ...newShipped];

  const newEntrypoints = skipsForPack('entrypoints') ? [] : additionsOnly(current.entrypoints, brief.entrypoints, (entry) => String(entry?.path || entry?.label || '').trim().toLowerCase());
  if (newEntrypoints.length) patch.entrypoints = [...(current.entrypoints || []), ...newEntrypoints];
  const newSurfaces = skipsForPack('surfaces') ? [] : additionsOnly(current.surfaces, brief.surfaces, (entry) => String(entry?.name || entry?.label || '').trim().toLowerCase());
  if (newSurfaces.length) patch.surfaces = [...(current.surfaces || []), ...newSurfaces];

  // Decisions: add the ones we do not already carry. mergeContextObject unions
  // by summary anyway, but sending only additions keeps the conflict report and
  // the counts honest.
  const decisionKey = (entry) => String(entry?.summary || '').trim().toLowerCase();
  const newDecisions = additionsOnly(current.recent_decisions, content.decisions, decisionKey);
  if (newDecisions.length) patch.recent_decisions = [...(current.recent_decisions || []), ...newDecisions];

  // Hot paths: keyed on the path itself, so an imported label never overwrites
  // the local explanation of a file the project already tracks.
  const pathKey = (entry) => String(entry?.path || '').trim().toLowerCase().replace(/^\.\//, '').replace(/\/+$/, '');
  const newPaths = additionsOnly(current.hot_paths, content.paths, pathKey);
  if (newPaths.length) patch.hot_paths = [...(current.hot_paths || []), ...newPaths];

  const findingKey = (entry) => String(entry?.summary || '').trim().toLowerCase();
  const newFindings = additionsOnly(current.debugging_notes, content.findings, findingKey);
  if (newFindings.length) patch.debugging_notes = [...(current.debugging_notes || []), ...newFindings];

  // Commands: local wins on a label collision, and the collision is reported.
  const commandKey = (entry) => String(entry?.label || '').trim().toLowerCase();
  const existingCommandLabels = new Set((current.commands || []).map(commandKey).filter(Boolean));
  const newCommands = [];
  for (const command of content.commands || []) {
    const key = commandKey(command);
    if (!key) continue;
    if (existingCommandLabels.has(key)) {
      const kept = (current.commands || []).find((entry) => commandKey(entry) === key);
      if (String(kept?.command || '').trim() !== String(command?.command || '').trim()) {
        conflicts.push({ field: `commands.${command.label}`, kept: kept?.command, incoming: command.command, resolution: 'kept_existing' });
      }
      continue;
    }
    existingCommandLabels.add(key);
    newCommands.push(command);
  }
  if (newCommands.length) patch.commands = [...(current.commands || []), ...newCommands];

  // Board: only titles the project does not already have. Imported cards land in
  // their ORIGINAL column, Done included. A kind:project Trail is this project's
  // own history moved between machines; turning its Done column into Backlog
  // reopened every finished card on import, so the importer's board claimed a
  // hundred pieces of shipped work were still to do. (Knowledge meant for OTHER
  // people's projects is a pack, which donates no cards at all — below.)
  //
  // A pack donates no cards at all. Its board is a list of its author's work
  // ("Fix shader compilation"), which is noise in the importer's project no
  // matter which column it lands in — and a board is the one section where noise
  // is unmissable, because the importer looks at it every session.
  const cardKey = (card) => String(card?.title || '').trim().toLowerCase();
  const existingCards = [...(current.todo_items || []), ...(current.completed_todos || [])];
  const newCards = isPack ? [] : additionsOnly(existingCards, content.board?.cards, cardKey)
    // The body comes across with the title. Mapping title+phase only meant a Trail
    // round-trip silently dropped every card body — the detail the card exists to
    // hold — and the importer got a headline with no repro steps. add_todos is
    // normalized by normalizeTaskCardInputs, which clips an over-long body rather
    // than rejecting the card.
    .map((card) => {
      const phase = card.phase || (card.completed_at ? 'done' : 'backlog');
      // A finished card keeps WHEN it was finished. Without it the merge stamps
      // it "completed now", and the Done cap, which keeps the most recently
      // completed cards, then evicts the importer's own completions to make room
      // for imported history. With it, history ranks as history and is what
      // falls off first. A card that never recorded a completion falls back to
      // its last update, then its creation; the merge ignores anything that does
      // not parse or lies in the future.
      const completedAt = String(phase).trim().toLowerCase() === 'done'
        ? [card.completed_at, card.updated_at, card.created_at].find((stamp) => typeof stamp === 'string' && stamp)
        : undefined;
      return {
        title: card.title,
        ...(card.body ? { body: card.body } : {}),
        phase,
        ...(completedAt ? { completed_at: completedAt } : {}),
      };
    });
  if (newCards.length) patch.add_todos = newCards;

  // Graph: nodes become workspace entities, edges become relations addressed by
  // canonical key so they resolve to whatever ids the upsert assigns locally.
  const nodesById = new Map();
  const entities = [];
  for (const node of content.graph?.nodes || []) {
    const title = String(node?.title || '').trim();
    if (!title) continue;
    const entityType = ENTITY_TYPE_BY_NODE_TYPE[String(node?.node_type || '').toLowerCase()] || 'knowledge';
    const entity = {
      title,
      entity_type: entityType,
      summary: node.body || node.summary || '',
      status: node.status || undefined,
      surface: node.surface || undefined,
      metadata: {
        ...(node.metadata || {}),
        imported_from_trail: trail.manifest?.trail_id || null,
      },
    };
    entities.push(entity);
    if (node.node_id) nodesById.set(String(node.node_id), canonicalKeyFor(entityType, title));
  }

  const relations = [];
  for (const edge of content.graph?.edges || []) {
    const from = nodesById.get(String(edge?.from_node_id));
    const to = nodesById.get(String(edge?.to_node_id));
    // An edge whose endpoints did not survive export is dropped rather than
    // imported as a dangling reference.
    if (!from || !to || from === to) continue;
    relations.push({
      from_canonical_key: from,
      to_canonical_key: to,
      relation_type: edge.edge_type || 'relates_to',
      summary: edge.metadata?.summary || undefined,
    });
  }

  // Attribution: record where this context came from, so a project that absorbed
  // a Trail can still say so months later. Written as a decision because that is
  // the field briefs actually surface.
  //
  // Only when the Trail GAVE the brief something. Importing a Trail into the
  // project it was exported from (or any project that already carries all of
  // it) applies nothing — the plan reported decisions: 0 — and still wrote this
  // line, which then headed "Recent decisions" as the newest thing decided. A
  // provenance note for context nobody received is a claim with nothing behind
  // it. Into a new project the brief is always what the Trail brought.
  const briefReceived = Object.keys(patch).length > 0 || !targetProject;
  if (options.attribution !== false && trail.manifest?.trail_id && briefReceived) {
    const author = trail.manifest?.provenance?.author;
    const attribution = {
      summary: `Imported Trail "${trail.manifest.title}"${author ? ` by ${author}` : ''} (${trail.manifest.trail_id})`,
      reasoning: trail.manifest?.source?.pinned
        ? `Pinned to ${trail.manifest.source.repo_url} @ ${trail.manifest.source.commit_sha}.`
        : 'Source repository was not pinned, so treat its file-level claims as unverified.',
      importance: 'normal',
      decided_at: new Date().toISOString(),
    };
    if (!(current.recent_decisions || []).some((entry) => decisionKey(entry) === decisionKey(attribution))) {
      patch.recent_decisions = [...(patch.recent_decisions || current.recent_decisions || []), attribution];
    }
  }

  return {
    trail,
    patch,
    entities,
    relations,
    conflicts,
    summary: {
      trail_id: trail.manifest?.trail_id || null,
      title: trail.manifest?.title || null,
      kind: isPack ? 'pack' : 'project',
      target_project_id: targetProject?.project_id || null,
      into_new_project: !targetProject,
      applied: {
        brief_fields: Object.keys(patch).filter((key) => FILL_ONLY_SCALARS.includes(key)).length,
        list_fields: Object.keys(patch).filter((key) => UNION_LISTS.includes(key)).length,
        decisions: newDecisions.length,
        paths: newPaths.length,
        findings: newFindings.length,
        commands: newCommands.length,
        board_cards: newCards.length,
        entities: entities.length,
        relations: relations.length,
      },
      conflicts: conflicts.length,
      // Present in the pack, deliberately not applied. Empty for project Trails.
      skipped_brief_fields: skippedBriefFields,
      source: trail.manifest?.source || null,
    },
  };
}

module.exports = {
  planImport,
  canonicalKeyFor,
  normalizeKey,
  unionStrings,
  additionsOnly,
  FILL_ONLY_SCALARS,
  UNION_LISTS,
  PACK_BRIEF_FIELDS,
  ENTITY_TYPE_BY_NODE_TYPE,
};
