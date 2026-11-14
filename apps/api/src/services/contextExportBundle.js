'use strict';

// Helpers for contextSyncService.exportContext. Kept out of that file so the
// export's read plan reads top to bottom there; nothing here reads the database
// or decides who may see what — every read and every visibility judgement stays
// in exportContext, through the same functions every other surface uses.

// HOW MANY PROJECTS THE EXPORT READS AT ONCE.
//
// It used to read every project in one Promise.all. Each project is a graph read
// of several queries (and a skills read), so a 200-project account queued
// thousands of queries against a pool of ten, behind breakers that time a query
// from the moment it is FIRED, waiting included: 5s for the best-effort graph
// reads, 8s for everything else. Past that, the graph reads time out one after
// another and the best-effort breaker opens (and the export used to swallow that
// into empty graphs), and the main breaker can open and 503 the whole API for
// everybody. Four at a time keeps each query's wait short and the pool shared.
const EXPORT_READ_CONCURRENCY = 4;

// fn over items, at most `limit` running at once, results in input order. A
// rejection rejects the whole map: the export is all or nothing (see
// exportContext for why a partial one is worse than none). And once one item
// has failed no other starts — Promise.all rejects at the first failure but
// does not stop the other workers, which would otherwise go on reading every
// remaining project for an export nobody will receive.
async function mapBounded(items, limit, fn) {
  const list = Array.isArray(items) ? items : [];
  const results = new Array(list.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < list.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(list[index], index);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), list.length) }, worker));
  return results;
}

// The rows of an owner's graph that belong to no project: workspace-scoped
// entities, and the relationships filed at workspace level. Every per-project
// graph is read by project id, so these were in none of them. Evidence is left
// out, as it is from the project graphs: it is notes on where each entity came
// from, not entities (and the email says so).
function workspaceLevelGraph(ownerGraph) {
  return {
    nodes: (ownerGraph?.nodes || []).filter((node) => !node.project_id),
    edges: (ownerGraph?.edges || []).filter((edge) => !edge.project_id),
    evidence: [],
  };
}

module.exports = {
  EXPORT_READ_CONCURRENCY,
  mapBounded,
  workspaceLevelGraph,
};
