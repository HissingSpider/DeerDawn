-- OWNER-RUN, BY HAND. NOTHING RUNS THIS AUTOMATICALLY.
-- See docs/runbooks/owner-run-db-checks.md before you run it.
--
-- Four indexes on the graph tables, built with CREATE INDEX CONCURRENTLY: each
-- build takes only a SHARE UPDATE EXCLUSIVE lock, so reads and writes on the
-- table carry on while it builds. That is why every statement below stands
-- alone: CONCURRENTLY cannot run inside a transaction block, so do NOT wrap
-- this file in BEGIN/COMMIT and do NOT run it with `psql --single-transaction`
-- (-1). Run it as `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <this file>`.
--
-- Safe to run twice: IF NOT EXISTS skips an index that is already there. One
-- trap: a CONCURRENTLY build that fails or is cancelled leaves an INVALID index
-- behind, and IF NOT EXISTS then skips it by name. The runbook has the query
-- that lists invalid indexes and the DROP INDEX CONCURRENTLY that clears one.
--
-- Why these four. Every foreign key below is ON DELETE CASCADE. When a graph
-- node or edge is deleted, Postgres looks the deleted id up in each child
-- table. The child columns lead no index (each existing index on these tables
-- starts with owner_key), so every lookup reads the whole child table, every
-- owner's rows included. Measured locally on 40 owners, 40,000 nodes, 24,000
-- edges, 320,000 evidence rows: deleting ONE node cost 38 ms in cascade checks
-- (evidence.edge_id alone 32 ms), and the vault job's phase 4, which deletes
-- every stale candidate node across all owners in one statement, did not finish
-- in over two minutes. Each statement's comment names what it serves.
-- The partial ones (WHERE ... IS NOT NULL) skip the rows that hold no value in
-- that column; the foreign-key lookup is an equality, so it still uses them.

-- Serves: the cascade check when a context_graph_nodes row is deleted, against
-- evidence rows of that node (context_graph_evidence_node_id_fkey). Callers:
-- the vault job's phase 4 (bulk delete of stale candidates) and phase 5 (one
-- DELETE per merged duplicate, vaultRemediationJob.js), DELETE /graph/nodes/:id,
-- and account deletion.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_context_graph_evidence_node_id
  ON context_graph_evidence (node_id)
  WHERE node_id IS NOT NULL;

-- Serves: the cascade check when a context_graph_edges row is deleted, against
-- evidence rows that ride that edge (context_graph_evidence_edge_id_fkey). It
-- runs for every edge a node delete cascades to (the worst single cost in the
-- measurement above), and for the edge merges in contextGraphService and
-- workspaceService that delete the losing edge.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_context_graph_evidence_edge_id
  ON context_graph_evidence (edge_id)
  WHERE edge_id IS NOT NULL;

-- Serves: the cascade check when a context_graph_nodes row is deleted, against
-- edges that start at that node (context_graph_edges_from_node_id_fkey). Same
-- callers as the node_id index on evidence above.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_context_graph_edges_from_node_id
  ON context_graph_edges (from_node_id);

-- Serves: the same cascade check for edges that end at the deleted node
-- (context_graph_edges_to_node_id_fkey).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_context_graph_edges_to_node_id
  ON context_graph_edges (to_node_id);
