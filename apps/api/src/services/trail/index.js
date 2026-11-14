'use strict';

// Trail service facade. The modules beside this one are pure; this is the only
// place that touches the database, so everything below it stays unit-testable
// without a DB.
//
// Layering, deliberately:
//   trailFormat   — bytes, checksum, parse            (pure)
//   trailExport   — project -> Trail                  (pure)
//   trailScan     — find what must not be published   (pure)
//   trailPublish  — the gate                          (pure)
//   trailImport   — Trail -> merge plan               (pure)
//   index.js      — fetch, apply, persist             (impure, this file)

const trailFormat = require('./trailFormat');
const trailExport = require('./trailExport');
const trailPublish = require('./trailPublish');
const trailImport = require('./trailImport');
const trailFetch = require('./trailFetch');
const { flattenToMarkdown } = require('./trailFlatten');
const { runProbes } = require('./trailProbe');

// Required lazily: contextSyncService is a large module that opens the database
// on load, and requiring it at module scope would drag the DB into any process
// that merely wants the format helpers.
function service() {
  return require('../contextSyncService');
}

/**
 * Names to treat as personal when scanning, at HIGH confidence.
 *
 * Only the account holder's own identity qualifies. An earlier version also
 * harvested every capitalized token from the owner's project titles, on the
 * theory that a title like "Tanya Finances" names a real person. It does — but
 * so does every ordinary project name, and the cost was severe: a project
 * called "Sync Loop" seeded "Sync" and "Loop" as personal names, which then
 * matched that same project's title in the manifest and made the project
 * permanently unpublishable. Its own name was the blocker, and the field is a
 * title, so there was no exclusion that could clear it either.
 *
 * Personal names in project titles are still surfaced — by the heuristic
 * capitalized-bigram detector in trailScan, at low severity, which is the right
 * weight for a guess. The rule: high severity is reserved for things we can
 * actually be confident about.
 */
async function collectSeededNames(actor) {
  const names = new Set();
  const email = String(actor?.email || '').trim();
  if (email) {
    const local = email.split('@')[0];
    for (const part of local.split(/[._-]+/)) if (part.length >= 3) names.add(part);
  }
  for (const field of ['name', 'full_name', 'first_name', 'last_name']) {
    const value = String(actor?.[field] || '').trim();
    if (value.length >= 3) names.add(value);
  }
  return [...names];
}

/**
 * Export a project as a Trail.
 *
 * @param {object} actor
 * @param {string} projectId
 * @param {{source?: object, provenance?: object, exporter?: object, kind?: 'project'|'pack', format?: 'json'|'markdown'}} [options]
 */
async function exportTrail(actor, projectId, options = {}) {
  const svc = service();
  const project = await svc.getProject(actor, projectId);
  if (!project) {
    const error = new Error('project_not_found');
    error.publicMessage = `project_not_found: no project ${projectId} you can read.`;
    throw error;
  }
  // getProjectGraph now answers null for a project the actor cannot see. getProject
  // above has already refused that case, so this is belt-and-braces — but an
  // unguarded null here would throw inside buildTrail instead of refusing.
  const graph = (await svc.getProjectGraph(actor, projectId).catch(() => null)) || { nodes: [], edges: [] };

  const trail = trailExport.buildTrail({
    project,
    graph,
    source: options.source,
    provenance: options.provenance,
    exporter: options.exporter,
    kind: options.kind,
  });

  return {
    trail,
    // A Trail is exported unscanned and therefore PRIVATE. Publishing is a
    // separate, gated call — see previewPublish/publishTrail. Nothing here
    // should be handed to a public surface.
    private: true,
    filename: `${String(project.project_name || 'trail').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'trail'}.dawn`,
    serialized: trailFormat.serializeTrail(trail),
  };
}

/**
 * Build the publish preview for a project: export, then scan.
 */
async function previewPublish(actor, projectId, options = {}) {
  const { trail } = await exportTrail(actor, projectId, options);
  const seededNames = await collectSeededNames(actor);
  return { trail, preview: trailPublish.buildPreview(trail, { seededNames }) };
}

/**
 * Publish a project as a Trail. Every finding must already be resolved; this
 * re-scans server-side regardless of what the client claims to have reviewed.
 *
 * @param {object} actor
 * @param {string} projectId
 * @param {object} decisions { [findingId]: { action, justification?, digest? } }
 */
async function publishTrail(actor, projectId, decisions, options = {}) {
  const { trail } = await exportTrail(actor, projectId, options);
  const seededNames = await collectSeededNames(actor);
  const result = trailPublish.finalizePublish(trail, decisions, {
    seededNames,
    author: options.author || null,
  });
  if (!result.ok) {
    const error = new Error('trail_publish_blocked');
    error.status = 422;
    error.publicMessage = 'trail_publish_blocked: unresolved findings remain. Every finding is resolved individually — there is no publish-all.';
    error.details = result.errors;
    throw error;
  }
  return result;
}

/**
 * Import a Trail into a project, or into a new one.
 *
 * @param {object} actor
 * @param {string|object} trailInput raw .dawn contents, a parsed Trail, or a URL
 *   on an allowed origin (see trailFetch.js — the host is not caller-supplied)
 * @param {{projectId?: string, newProjectName?: string, dryRun?: boolean}} [options]
 */
async function importTrail(actor, trailInput, options = {}) {
  const svc = service();

  // A pack arrives as a link. Resolved here rather than at each route so the
  // origin allow-list has exactly one enforcement site.
  const input = trailFetch.isTrailUrl(trailInput) ? await trailFetch.fetchTrailByUrl(trailInput) : trailInput;

  let target = null;
  if (options.projectId) {
    target = await svc.getProject(actor, options.projectId);
    if (!target) {
      const error = new Error('project_not_found');
      error.publicMessage = `project_not_found: no project ${options.projectId} you can write to.`;
      throw error;
    }
  }

  const plan = trailImport.planImport(input, target, { verifyChecksum: options.verifyChecksum !== false });

  if (options.dryRun) {
    // A dry run answers what the import WOULD do, refusals included. The board
    // refuses a write that would take it past its open-card limit (and writes
    // nothing), so a dry run over a full board must say so rather than report
    // "N cards" as a success the real import then contradicts. Same error, same
    // code (409 board_open_limit_reached; board_full over MCP), said to be a
    // prediction.
    //
    // And the SHARE refusal, for the same reason. This judged only the board,
    // against the caller's FILTERED copy of the target — so a member importing
    // into a teammate's shared project was told "2 cards" while the real import
    // answered 403 share_write_forbidden, and where the share withholds the board
    // the copy is empty, so even the board check judged a board that is not the
    // one stored. previewProjectContextWrite runs the write's own gates against
    // the stored row, and the refusal comes back marked as a prediction.
    const markDryRun = (refusal) => {
      refusal.publicMessage = `${refusal.publicMessage || refusal.message} (Dry run: this is the answer the import would give. Nothing was written.)`;
      if (refusal.safeMessage) refusal.safeMessage = refusal.publicMessage;
      refusal.dry_run = true;
      return refusal;
    };
    // And the CREATION refusal: with no target the real import creates the
    // project first, and that refuses a duplicate name (409), a junk name or a
    // plan at its project cap. Judged by the same function createProject uses.
    if (!target) {
      const name = options.newProjectName || plan.trail.manifest?.title || 'Imported Trail';
      try {
        await svc.assertProjectCreatable(actor, { project_name: name });
      } catch (err) {
        if (err?.publicMessage) throw markDryRun(err);
        throw err;
      }
    }
    let refusal = null;
    if (target && Object.keys(plan.patch).length) {
      try {
        refusal = await svc.previewProjectContextWrite(actor, target.project_id, plan.patch);
      } catch (err) {
        if (err?.code === 'share_write_forbidden' || err?.code === 'project_archived') throw markDryRun(err);
        throw err;
      }
    } else {
      refusal = svc.previewBoardOpenLimit(target?.context || {}, plan.patch);
    }
    if (refusal) throw markDryRun(refusal);
    return { applied: false, plan: plan.summary, conflicts: plan.conflicts, patch_keys: Object.keys(plan.patch) };
  }

  // Create the destination only after the Trail has parsed and its checksum has
  // verified, so a bad file cannot leave an empty project behind.
  if (!target) {
    const name = options.newProjectName || plan.trail.manifest?.title || 'Imported Trail';
    target = await svc.createProject(actor, { project_name: name });
  }

  // The brief is the import; the graph is enrichment. Upserting entities dedups
  // each one against the owner's whole graph, one embedding call apiece, so on a
  // real account it ran past the dashboard's request budget: the import landed,
  // the client reported failure, and a retry imported the Trail twice. Answer
  // once the brief is saved and let the graph catch up.
  // `refused` travels with the write and names the fields the server would not
  // take. An import that reports `applied: true` over a silently dropped field
  // is the same failure the refusal list was added to end, one caller along.
  //
  // `evicted_cards` is the same rule for the board: the Done column is capped,
  // and a card the cap pushed off to make room is gone. The import ranks its
  // cards by their real completion time, so imported history is what falls off
  // first — but whatever falls off is named, never dropped under `applied: true`.
  let refused = [];
  let evictedCards = [];
  if (Object.keys(plan.patch).length) {
    const patched = await svc.updateProjectContext(actor, target.project_id, plan.patch, { deferAutoPromotion: options.awaitGraph !== true });
    refused = Array.isArray(patched?.refused) ? patched.refused : [];
    evictedCards = Array.isArray(patched?.evicted_cards) ? patched.evicted_cards : [];
  }

  // THE GRAPH LANDS WHERE THE BRIEF DOES. The entities carried no project, and
  // upsertWorkspaceEntities never read the top-level project_id this passed, so
  // every imported node was workspace-level: a Trail of a member's PERSONAL
  // project imported into another personal project published its whole graph
  // to every colleague (scan 31). Each entity now names the target, which the
  // importer has already been judged able to write; neverAdopt keeps an
  // existing node elsewhere (the team's "Stripe") where it is.
  let entityResult = null;
  if (plan.entities.length || plan.relations.length) {
    const graphWrite = svc.upsertWorkspaceEntities(actor, {
      entities: plan.entities.map((entity) => ({ ...entity, project_id: target.project_id, scope: 'project' })),
      relations: plan.relations,
    }, { neverAdopt: true }).catch((err) => {
      console.warn('[TRAIL] entity upsert after import failed:', err.message);
      return { error: err.message };
    });
    if (options.awaitGraph === true) entityResult = await graphWrite;
  }

  return {
    applied: true,
    project_id: target.project_id,
    project_name: target.project_name,
    plan: plan.summary,
    conflicts: plan.conflicts,
    ...(refused.length ? { refused } : {}),
    ...(evictedCards.length ? { evicted_cards: evictedCards } : {}),
    entities: entityResult?.entities?.length ?? plan.entities.length,
    relations: entityResult?.relations?.length ?? plan.relations.length,
  };
}

/**
 * Render a Trail as markdown. Exposed because withholding it would be exactly
 * the artificial crippling the format is supposed to avoid — if the graph form
 * is worth more, it should be worth more with the markdown sitting right there.
 */
function renderMarkdown(trail) {
  return flattenToMarkdown(trail);
}

/**
 * Run the graph-vs-prose probe suite against a real Trail. Used by the
 * verification test and available for re-running the comparison as the format
 * evolves.
 */
function measureGraphAdvantage(trail) {
  return runProbes(trail);
}

module.exports = {
  exportTrail,
  previewPublish,
  publishTrail,
  importTrail,
  unpublishTrail: trailPublish.unpublish,
  renderMarkdown,
  measureGraphAdvantage,
  collectSeededNames,
  // re-exported so callers have one import site
  format: trailFormat,
  fetch: trailFetch,
  scan: require('./trailScan'),
};
