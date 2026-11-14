const store = require('../store/contextSyncStore');
// Required as a module rather than destructured so the entitlement lookup stays
// a live reference — tests stub it, and a destructured binding would not see it.
const entitlementService = require('./entitlementService');
const workspace = require('./workspaceService');
// The graph-visibility filter lives beside the rest of the sharing rules; shared
// rather than reimplemented, so the portfolio cannot drift from the brief.
const contextSync = require('./contextSyncService');

function getActorKey(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

// Free hits this endpoint too, and gets its own real numbers back. Only the
// CONTENTS are withheld. That is the whole upgrade mechanic — "9 things show up
// in more than one of your projects" is only persuasive because it is theirs —
// and it is why the counts are computed before the gate rather than after it.
async function isPortfolioUnlocked(actor) {
  // Entitlements follow the workspace, not the person — see getOwnerEntitlements.
  const ownerKey = getActorKey(actor);
  if (ownerKey === 'org-system') return true;
  const entitlements = await entitlementService.getEntitlementsForExistingOrg(ownerKey).catch(() => null);
  // No org row = a system/dev actor, never a billed customer: don't gate them as
  // if they were free. Same fail-open posture as getOwnerEntitlements.
  if (!entitlements) return true;
  return Boolean(entitlements.features?.portfolio);
}

function matchesQuery(haystack, query) {
  if (!query) return true;
  return String(haystack || '').toLowerCase().includes(query.toLowerCase());
}

// Decisions live inside context_projects.context, which is ENCRYPTED AT REST, so
// the merged timeline cannot be a SQL query over the JSONB — the rows have to be
// decrypted first. listProjects already does that, and a portfolio is tens of
// projects, not thousands, so reading them and merging in JS is the honest shape
// rather than a limitation to work around.
function mergeDecisions(projects, { limit, query }) {
  const merged = [];
  for (const project of projects) {
    const decisions = project.context?.recent_decisions;
    if (!Array.isArray(decisions)) continue;
    for (const decision of decisions) {
      if (!decision?.summary) continue;
      if (decision.resolved) continue;
      if (!matchesQuery(`${decision.summary} ${decision.reasoning || ''}`, query)) continue;
      merged.push({
        project_id: project.project_id,
        project_name: project.project_name,
        summary: decision.summary,
        reasoning: decision.reasoning || null,
        decided_at: decision.decided_at || null,
        importance: decision.importance || 'normal',
        // Surfaced so the timeline can avoid presenting a stamped-in date as if
        // it were a real one — same contract the brief honours.
        date_inferred: Boolean(decision.date_inferred),
      });
    }
  }
  merged.sort((a, b) => {
    const at = Date.parse(a.decided_at || '') || 0;
    const bt = Date.parse(b.decided_at || '') || 0;
    return bt - at;
  });
  return { total: merged.length, entries: merged.slice(0, limit) };
}

// ONE ENTITY, SEVERAL NODES (scan 34). A project's writes land on its own
// `<key>::in.<project>` copy wherever the plain key is somebody else's row, and
// the rebuild never lands on a row homed in another project — so one person's
// "Postgres" in two of their own projects is two nodes, each seen in one
// project. Grouped here by type and plain key (store entity_key), among the
// nodes this reader may read (the caller filters first), into one row carrying
// the union of their projects; it is cross-project when that union spans more
// than one. The row shown is the plain-key node when the reader has it, else
// the newest copy.
function groupEntityCopies(nodes) {
  const groups = new Map();
  for (const node of nodes) {
    const entityKey = node.entity_key || workspace.boundedKeyBase(String(node.canonical_key || '').split('::in.')[0]) || node.node_id;
    const id = `${node.node_type}\u0000${entityKey}`;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(node);
  }
  const rows = [];
  for (const copies of groups.values()) {
    const projectIds = [...new Set(copies.flatMap((node) => node.project_ids || []))];
    if (projectIds.length < 2) continue;
    const plain = copies.find((node) => !String(node.canonical_key || '').includes('::in.'));
    const shown = plain || [...copies].sort((a, b) => (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0))[0];
    const newest = copies.reduce((at, node) => Math.max(at, Date.parse(node.updated_at || '') || 0), 0);
    rows.push({
      ...shown,
      project_ids: projectIds,
      project_count: projectIds.length,
      updated_at: newest ? new Date(newest).toISOString() : shown.updated_at,
      // Every node the row stands for, so a workspace-scoped listing of any of
      // them is the same row (mergeEntities).
      node_ids: copies.map((node) => node.node_id),
    });
  }
  return rows;
}

// One entity can be BOTH workspace-scoped and observed across projects. The two
// store queries overlap by design, so node_id is the dedup key and the
// cross-project row wins — it carries the project list, which is the more
// specific fact.
function mergeEntities(crossProject, workspaceScoped, { limit, query, projectNames }) {
  const byNodeId = new Map();
  const covered = new Set();
  for (const entity of groupEntityCopies(crossProject)) {
    byNodeId.set(entity.node_id, entity);
    for (const nodeId of entity.node_ids) covered.add(nodeId);
  }
  for (const entity of workspaceScoped) {
    if (byNodeId.has(entity.node_id) || covered.has(entity.node_id)) continue;
    byNodeId.set(entity.node_id, entity);
  }
  const all = [...byNodeId.values()]
    .filter((entity) => matchesQuery(`${entity.title} ${entity.summary || ''}`, query))
    .sort((a, b) => (b.project_count - a.project_count)
      || (Date.parse(b.updated_at || '') || 0) - (Date.parse(a.updated_at || '') || 0));

  return {
    total: all.length,
    entries: all.slice(0, limit).map((entity) => ({
      node_id: entity.node_id,
      title: entity.title,
      summary: entity.summary || '',
      entity_type: entity.metadata?.entity_type || entity.node_type,
      node_type: entity.node_type,
      shared_reason: entity.shared_reason,
      project_count: entity.project_count,
      projects: (entity.project_ids || [])
        .map((id) => ({ project_id: id, project_name: projectNames.get(id) || null }))
        // A project deleted after the evidence was written leaves an id with no
        // name; drop it rather than render a blank chip.
        .filter((p) => p.project_name),
      updated_at: entity.updated_at,
    })),
  };
}

/**
 * The single portfolio read. Returns the same shape at every tier: `counts` is
 * always populated with the owner's real numbers, and `locked` says whether the
 * contents came back with it.
 */
async function getPortfolio(actor, { entityLimit = 50, decisionLimit = 50, query = '' } = {}) {
  const ownerKey = getActorKey(actor);
  const [listedProjects, crossProject, workspaceScoped, unlocked] = await Promise.all([
    store.listProjects(ownerKey, {
      // Portfolio surfaces both project NAMES and their decisions, so this is
      // the widest of the four leaks it used to have.
      actorIdentities: workspace.actorIdentities(actor),
      isWorkspaceOwner: (await workspace.resolveRole(actor, ownerKey).catch(() => null)) === 'owner',
    }),
    store.listCrossProjectEntities(ownerKey, { limit: 500 }),
    store.listWorkspaceScopedEntities(ownerKey, { limit: 500 }),
    isPortfolioUnlocked(actor),
  ]);

  // store.listProjects decides which projects exist for this person; it does not
  // narrow what is IN them. mergeDecisions reads context.recent_decisions, so on
  // the raw rows a teammate's portfolio listed every decision of a shared project
  // whose author had withheld decisions from them. The section-filtered view is
  // the one the brief uses; the portfolio reads the same one.
  const projects = await contextSync.viewProjectsForActor(actor, listedProjects);
  const projectNames = new Map(projects.map((p) => [p.project_id, p.project_name]));
  // The project list above is visibility-filtered; the entity lists are not.
  // Entities are promoted out of project content, so a cross-project entity whose
  // every sighting is in projects this person cannot open is not theirs to read —
  // and the portfolio names the projects it appears in.
  const [visibleCrossProject, visibleWorkspaceScoped] = await Promise.all([
    contextSync.visibleGraphNodesForActor(actor, ownerKey, crossProject),
    contextSync.visibleGraphNodesForActor(actor, ownerKey, workspaceScoped),
  ]);
  const entities = mergeEntities(visibleCrossProject, visibleWorkspaceScoped, {
    limit: entityLimit,
    query,
    projectNames,
  });
  const decisions = mergeDecisions(projects, { limit: decisionLimit, query });

  const counts = {
    projects: projects.length,
    decisions: decisions.total,
    shared_entities: entities.total,
  };

  if (!unlocked) {
    // Counts in the clear, contents withheld. The row counts stay too: seeing a
    // "4" beside a redacted row is what makes the number concrete rather than a
    // slogan. Nothing here is a placeholder — every number is the real one.
    return {
      locked: true,
      counts,
      entities: {
        total: entities.total,
        entries: entities.entries.map((entity) => ({
          project_count: entity.project_count,
          shared_reason: entity.shared_reason,
        })),
      },
      decisions: {
        total: decisions.total,
        entries: decisions.entries.map(() => ({})),
      },
    };
  }

  return { locked: false, counts, entities, decisions };
}

module.exports = { getPortfolio, isPortfolioUnlocked };
