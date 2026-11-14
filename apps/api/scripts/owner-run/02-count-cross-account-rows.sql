-- OWNER-RUN, BY HAND. READ-ONLY. See docs/runbooks/owner-run-db-checks.md.
--
-- Counts graph rows that belong to one workspace but point at another
-- workspace's project or node. In this schema owner_key is the workspace, and a
-- row and the project (or node, or edge) it points at should carry the same
-- owner_key. A row that does not is a cross-account row.
--
-- It changes nothing: the whole file runs in a READ ONLY transaction (Postgres
-- refuses any write in it), which is rolled back at the end. It takes only the
-- ACCESS SHARE locks a SELECT takes, so it blocks no reader and no writer.
--
-- Run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f 02-count-cross-account-rows.sql
--
-- Read the result as: 0 in every row is clean. A number above 0 is a row to look
-- at, not proof of a leak: it says the ownership does not agree, not why. What
-- to do with each is in the runbook.

BEGIN READ ONLY;
SET LOCAL statement_timeout = '10min';

-- 1. One row per check: how many rows disagree.
SELECT check_name, rows_found FROM (
  -- A node filed under a project another workspace owns.
  SELECT 1 AS ord, 'nodes filed under another owner''s project' AS check_name, count(*) AS rows_found
    FROM context_graph_nodes n JOIN context_projects p ON p.project_id = n.project_id
   WHERE p.owner_key <> n.owner_key
  UNION ALL
  -- An edge filed under a project another workspace owns.
  SELECT 2, 'edges filed under another owner''s project', count(*)
    FROM context_graph_edges e JOIN context_projects p ON p.project_id = e.project_id
   WHERE p.owner_key <> e.owner_key
  UNION ALL
  -- An evidence row filed under a project another workspace owns.
  SELECT 3, 'evidence filed under another owner''s project', count(*)
    FROM context_graph_evidence v JOIN context_projects p ON p.project_id = v.project_id
   WHERE p.owner_key <> v.owner_key
  UNION ALL
  -- An edge whose start node belongs to another workspace.
  SELECT 4, 'edges whose from-node is another owner''s', count(*)
    FROM context_graph_edges e JOIN context_graph_nodes n ON n.node_id = e.from_node_id
   WHERE n.owner_key <> e.owner_key
  UNION ALL
  -- An edge whose end node belongs to another workspace.
  SELECT 5, 'edges whose to-node is another owner''s', count(*)
    FROM context_graph_edges e JOIN context_graph_nodes n ON n.node_id = e.to_node_id
   WHERE n.owner_key <> e.owner_key
  UNION ALL
  -- An evidence row attached to a node of another workspace.
  SELECT 6, 'evidence attached to another owner''s node', count(*)
    FROM context_graph_evidence v JOIN context_graph_nodes n ON n.node_id = v.node_id
   WHERE n.owner_key <> v.owner_key
  UNION ALL
  -- An evidence row attached to an edge of another workspace.
  SELECT 7, 'evidence attached to another owner''s edge', count(*)
    FROM context_graph_evidence v JOIN context_graph_edges e ON e.edge_id = v.edge_id
   WHERE e.owner_key <> v.owner_key
  UNION ALL
  -- What the vault job's phase 6 could have written across accounts. Before this
  -- release, phase 6 took every resolved decision node filed under a project
  -- another workspace owns and marked a matching decision in THAT project's
  -- brief as resolved. Each row here is a node that could have done it. Whether
  -- one did depends on its text matching a decision in the other brief, and the
  -- briefs are encrypted, so SQL cannot say; section 3 lists the projects.
  SELECT 8, 'resolved decision nodes filed under another owner''s project (what phase 6 could have applied)', count(*)
    FROM context_graph_nodes n JOIN context_projects p ON p.project_id = n.project_id
   WHERE n.node_type = 'decision' AND n.metadata->>'status' = 'resolved' AND p.owner_key <> n.owner_key
) checks
ORDER BY ord;

-- 2. Where the node disagreements are: the owner pairs, biggest first. Owner keys
--    only; no titles or text are read.
SELECT n.owner_key AS node_owner, p.owner_key AS project_owner, count(*) AS nodes
  FROM context_graph_nodes n JOIN context_projects p ON p.project_id = n.project_id
 WHERE p.owner_key <> n.owner_key
 GROUP BY 1, 2
 ORDER BY nodes DESC, node_owner, project_owner
 LIMIT 50;

-- 3. The projects whose brief phase 6 could have written into (check 8): ids
--    only, at most 100. Open each one and look at its recent decisions.
SELECT p.project_id, p.owner_key AS project_owner, n.owner_key AS node_owner,
       count(*) AS resolved_nodes, max(n.metadata->>'resolved_at') AS latest_resolved_at
  FROM context_graph_nodes n JOIN context_projects p ON p.project_id = n.project_id
 WHERE n.node_type = 'decision' AND n.metadata->>'status' = 'resolved' AND p.owner_key <> n.owner_key
 GROUP BY 1, 2, 3
 ORDER BY resolved_nodes DESC, p.project_id
 LIMIT 100;

ROLLBACK;
