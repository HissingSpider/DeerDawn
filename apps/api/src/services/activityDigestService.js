'use strict';

// Per-workspace weekly activity digest — the "what DeerDawn did for you" view.
// Powers the dashboard's "This week" panel (and, later, a weekly email) so the
// product's value is legible and users have a recurring reason to return — the
// single biggest pure-code retention lever for a passive background tool.

const db = require('../config/db');
const workspace = require('./workspaceService');

const STALE_DAYS = Number(process.env.DEERDAWN_STALE_CONTEXT_DAYS) || 7;

function ownerKeyFor(actor) {
  return workspace.defaultOwnerKey(actor) || 'org-system';
}

// Decisions and knowledge captured in the window, as THIS reader may see them.
// The counts used to be workspace-wide, so a teammate's `personal` project put
// a decision in everybody's "this week" strip and weekly digest: a count is
// not a name, and it is still a fact about work the reader may not read. Where
// nothing can be somebody else's (visibleIds null) it stays the one COUNT
// query it always was; otherwise the nodes are read and judged by the same
// rule the graph endpoints use (the project they were seen in, and the share
// policy's section for their type).
async function knowledgeCounts(actor, ownerKey, days, visibleIds) {
  if (visibleIds === null) {
    return db.query(
      `SELECT node_type, COUNT(*)::int AS count
         FROM context_graph_nodes
        WHERE owner_key = $1 AND node_type IN ('decision', 'knowledge')
          AND created_at > NOW() - ($2 || ' days')::interval
        GROUP BY node_type`,
      [ownerKey, days],
      'org-system',
    );
  }
  const nodes = await db.query(
    `SELECT node_id, node_type, project_id, metadata
       FROM context_graph_nodes
      WHERE owner_key = $1 AND node_type IN ('decision', 'knowledge')
        AND created_at > NOW() - ($2 || ' days')::interval
      ORDER BY created_at DESC
      LIMIT 5000`,
    [ownerKey, days],
    'org-system',
  );
  const seen = await require('./contextSyncService').visibleGraphNodesForActor(actor, ownerKey, nodes.rows || []);
  const counts = new Map();
  for (const node of seen) counts.set(node.node_type, (counts.get(node.node_type) || 0) + 1);
  return { rows: [...counts.entries()].map(([node_type, count]) => ({ node_type, count })) };
}

async function computeWorkspaceActivity(actor, sinceDays = 7) {
  const ownerKey = ownerKeyFor(actor);
  // context_delivered is filed under the WORKSPACE (productEventsService
  // buildActorFields), so it is read back by the workspace too. Reading the
  // person's own org here gave a teammate a different "briefs delivered" count
  // from the owner looking at the same panel. An actor with no org at all (a bare
  // system/dev actor) still reads nothing, exactly as before.
  const eventsKey = (actor?.org_id || actor?.workspace_key) ? ownerKey : null;
  const days = String(Math.max(1, Math.min(90, Number(sinceDays) || 7)));

  // product_events is RLS-scoped (org tenant); context tables use owner_key + org-system.
  // Each query degrades to empty so one failing source can't break the whole panel,
  // but the failure is logged — silence here would make a broken query look like
  // "no activity", masking a real regression in the feature whose job is to show value.
  const guard = (label, fallback) => (err) => {
    console.warn(`[ACTIVITY] ${label} query failed: ${err.message}`);
    return fallback;
  };

  const deliveredQuery = eventsKey
    ? db.query(
      `SELECT COUNT(*)::int AS total, COALESCE(surface, 'unknown') AS tool
         FROM product_events
        WHERE org_id = $1 AND event_name = 'context_delivered'
          AND created_at > NOW() - ($2 || ' days')::interval
        GROUP BY surface`,
      [eventsKey, days],
      eventsKey,
    ).catch(guard('delivered', { rows: [] }))
    : Promise.resolve({ rows: [] });

  // WHICH PROJECTS THIS READER MAY SEE. The stale-project names below came from
  // every row under the workspace key, so a workspace owner's "This week" strip —
  // and their weekly digest email — named a colleague's `personal` project, the
  // one state that means "its author, and nobody else, not even a workspace
  // owner". Null means nothing to filter (a solo account, a system actor). A
  // lookup that fails hides the names rather than printing all of them.
  // Lazy require: contextSyncService is a heavy module and this one is loaded
  // by the email job on its own.
  const visible = await require('./contextSyncService').visibleProjectIdsForActor(actor, ownerKey)
    .catch((err) => { console.warn(`[ACTIVITY] visibility lookup failed: ${err.message}`); return new Set(); });
  const visibleIds = visible ? [...visible] : null;

  const [deliveredRes, knowledgeRes, peopleRes, staleRes] = await Promise.all([
    deliveredQuery,
    knowledgeCounts(actor, ownerKey, days, visibleIds).catch(guard('knowledge', { rows: [] })),
    db.query(
      // "contributors" is the honest teammates stat — it must exclude the
      // requesting actor (a solo owner's own logins/keys never count as a
      // teammate). "projects_touched" is a different question — how many of
      // the workspace's projects saw activity this week — so it counts ALL
      // events, including the actor's own. Scope the actor-exclusion to the
      // contributors aggregate via FILTER so it can't also zero out projects.
      `SELECT COUNT(DISTINCT e.contributing_user_id)
                FILTER (WHERE e.contributing_user_id IS NOT NULL
                          AND ($3::text IS NULL OR e.contributing_user_id <> $3))::int AS contributors,
              COUNT(DISTINCT e.project_id)::int AS projects_touched
         FROM context_events e
         JOIN context_projects p ON p.project_id = e.project_id
        WHERE p.owner_key = $1 AND e.created_at > NOW() - ($2 || ' days')::interval
          AND ($4::text[] IS NULL OR e.project_id = ANY($4::text[]))`,
      [ownerKey, days, actor?.id || null, visibleIds],
      'org-system',
    ).catch(guard('people', { rows: [{}] })),
    db.query(
      // Return the full stale count plus the names of the most-recently-touched
      // stale projects, so the dashboard "This week" strip can name them on hover
      // instead of only showing a number. Cap the name list (the count is still
      // authoritative) so a workspace with hundreds of stale projects can't bloat
      // the payload; the UI renders "+N more" from (count - names.length).
      `SELECT
          (SELECT COUNT(*)::int
             FROM context_projects
            WHERE owner_key = $1 AND updated_at < NOW() - ($2 || ' days')::interval
              AND ($3::text[] IS NULL OR project_id = ANY($3::text[]))) AS stale,
          (SELECT COALESCE(ARRAY_AGG(project_name ORDER BY updated_at DESC), '{}')
             FROM (
               SELECT project_name, updated_at
                 FROM context_projects
                WHERE owner_key = $1 AND updated_at < NOW() - ($2 || ' days')::interval
                  AND ($3::text[] IS NULL OR project_id = ANY($3::text[]))
                ORDER BY updated_at DESC
                LIMIT 12
             ) s) AS stale_names`,
      [ownerKey, String(STALE_DAYS), visibleIds],
      'org-system',
    ).catch(guard('stale', { rows: [{}] })),
  ]);

  const byTool = (deliveredRes.rows || []).map((r) => ({ tool: r.tool, count: Number(r.total) }));
  const knowledgeByType = {};
  for (const row of knowledgeRes.rows || []) knowledgeByType[row.node_type] = Number(row.count);
  const people = peopleRes.rows?.[0] || {};

  return {
    window_days: Number(days),
    context_delivered: byTool.reduce((sum, t) => sum + t.count, 0),
    delivered_by_tool: byTool.sort((a, b) => b.count - a.count),
    decisions_captured: knowledgeByType.decision || 0,
    knowledge_captured: knowledgeByType.knowledge || 0,
    contributors: Number(people.contributors || 0),
    projects_touched: Number(people.projects_touched || 0),
    stale_projects: Number(staleRes.rows?.[0]?.stale || 0),
    stale_project_names: Array.isArray(staleRes.rows?.[0]?.stale_names) ? staleRes.rows[0].stale_names : [],
    generated_at: new Date().toISOString(),
  };
}

/**
 * Cumulative memory totals — the "Remembering N decisions" row on the session-start
 * card. Deliberately NOT windowed: computeWorkspaceActivity answers "what happened
 * this week" and can go down, which is right for a digest and wrong here. This row
 * represents the accumulated asset, so it must only ever grow — a counter that
 * shrinks reads as data loss, and on the free tier it eventually IS data loss, which
 * is exactly the moment we want to be legible rather than silent.
 *
 * Two indexed COUNTs on owner_key. Callers gate this to real session starts and
 * treat failure as "omit the row", never as zero — rendering "Remembering 0
 * decisions" to someone with hundreds is worse than rendering nothing.
 */
async function computeMemoryTotals(actor) {
  const ownerKey = ownerKeyFor(actor);

  const [decisionsRes, projectsRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total
         FROM context_graph_nodes
        WHERE owner_key = $1 AND node_type = 'decision'`,
      [ownerKey],
      'org-system',
    ),
    db.query(
      `SELECT COUNT(*)::int AS total
         FROM context_projects
        WHERE owner_key = $1 AND archived_at IS NULL`,
      [ownerKey],
      'org-system',
    ),
  ]);

  return {
    decisions: Number(decisionsRes.rows?.[0]?.total || 0),
    projects: Number(projectsRes.rows?.[0]?.total || 0),
  };
}

module.exports = { computeWorkspaceActivity, computeMemoryTotals };
