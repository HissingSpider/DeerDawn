'use strict';

/**
 * A vault at the size the nightly job meets in production (journey r2), for the
 * tests that hold the job to the API's event loop.
 *
 * One project holds `decisions` decision nodes, as a busy project does: every
 * manage_memory update stores one. Enough other owners, each with one project,
 * make up `totalNodes`, with the rows each phase looks for mixed in: legacy
 * template summaries (1), 2023 decision dates (2), pre-cap blobs (3), stale
 * candidates (4), true duplicate decisions (5), resolved decision nodes (6),
 * blockers and the decisions that clear them (7), never-retrieved stale nodes
 * (8). Rows go in 5,000 to a statement through jsonb_to_recordset; projects go
 * through the store, so their context is encrypted as in production.
 */

const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const { normalizeKey, clip } = require('../../src/services/contextGraphService');

const q = (sql, params) => db.query(sql, params, 'org-system');
const DAY = 86400000;
const VERBS = ['Adopt', 'Retire', 'Migrate', 'Shard', 'Cache', 'Replace', 'Pin'];
const NOUNS = ['ledger', 'search index', 'billing worker', 'auth gateway', 'queue', 'payout service', 'audit log', 'CDN', 'feature flags', 'session store', 'webhook relay'];
const LEGACY = { task: 'Active task for ', decision: 'Decision captured automatically for ', question: 'Open question for ' };
const LEGACY_AT = '2026-05-20T10:00:00.000Z';

// One in eight runs past the extractor's 240-character cut, so the clipped
// reading (canonical keys) is exercised as well as the plain one.
function decisionText(label, i) {
  const base = `${VERBS[i % 7]} the ${NOUNS[i % 11]} for tenant cohort ${i} of ${label}`;
  if (i % 8) return `${base}.`;
  return `${base}, because ${'the measured p99 under the cohort load test stayed flat across three runs and '.repeat(4)}it is cheaper.`;
}

function decisionNode({ id, owner, project, label, i, at, author, resolvedAt = null, duplicateOf = null }) {
  // A true duplicate: the same decision stored again, upper-cased and without
  // its stop, as a second writer or a re-extraction stores it.
  const text = duplicateOf === null ? decisionText(label, i) : decisionText(label, duplicateOf).toUpperCase().replace(/\.$/, '');
  return {
    node_id: id,
    owner_key: owner,
    project_id: project,
    node_type: 'decision',
    canonical_key: `decision:${normalizeKey(text)}`,
    title: clip(text, 80),
    summary: clip(text, 240),
    metadata: {
      source_kind: 'inferred',
      memory_tier: 'durable',
      curation_state: 'promoted',
      retrieval_hits: i % 3,
      contributed_by: author,
      ...(resolvedAt ? { status: 'resolved', resolved_at: resolvedAt } : {}),
    },
    created_at: at,
    updated_at: at,
    last_seen_at: at,
  };
}

async function insertNodes(rows) {
  for (let k = 0; k < rows.length; k += 5000) {
    await q(
      `INSERT INTO context_graph_nodes
         (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, updated_at, last_seen_at)
       SELECT node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, 0.8, '', 'codex', created_at, updated_at, last_seen_at
         FROM jsonb_to_recordset($1::jsonb) AS t(node_id text, owner_key text, project_id text, node_type text, canonical_key text,
              title text, summary text, metadata jsonb, created_at timestamptz, updated_at timestamptz, last_seen_at timestamptz)`,
      [JSON.stringify(rows.slice(k, k + 5000))],
    );
  }
}

async function createProject({ owner, project, name, context }) {
  const now = new Date().toISOString();
  await store.saveProject({
    project_id: project,
    owner_key: owner,
    project_name: name,
    visibility: 'private',
    context,
    created_at: now,
    updated_at: now,
  }, { type: 'user', id: `seed-${owner}` });
}

// The brief of a project: 20 decisions (the log's cap), ten of which are the
// text of a resolved node in the graph, a blocker and, for every other owner, a
// newer decision that clears it, and a decision dated 2023.
function briefFor({ label, resolvedIndexes, withBlocker }) {
  const now = Date.now();
  const decisions = [];
  for (const i of resolvedIndexes.slice(0, 10)) {
    decisions.push({ summary: decisionText(label, i), decided_at: new Date(now - 30 * DAY).toISOString() });
  }
  while (decisions.length < 19) {
    decisions.push({ summary: `Keep the ${NOUNS[decisions.length % 11]} runbook for ${label} in the repo (${decisions.length})`, decided_at: new Date(now - 20 * DAY).toISOString() });
  }
  decisions.push({ summary: `Adopted the ${label} naming scheme`, decided_at: '2023-03-14T09:00:00.000Z' });
  const context = { current_task: `Scale ${label}`, recent_decisions: decisions, open_questions: [] };
  if (withBlocker) {
    context.blocking_issue = `Search index rebuild times out for ${label}`;
    context.blocking_issue_set_at = new Date(now - 10 * DAY).toISOString();
    decisions[18] = { summary: `Resolved: search index rebuild times out for ${label}, fixed and deployed`, decided_at: new Date(now - DAY).toISOString() };
  }
  return context;
}

// Deleting a graph node has Postgres look, row by row, for the edges and
// evidence that point at it, and neither table has an index that leads with the
// node (theirs lead with owner_key): 200,000 nodes outlasted the test DB
// breaker's 10 s against a few hundred edges, and it grows with every row other
// test files leave. Nothing points at these nodes — the seed writes no edge or
// evidence and the job only moves what exists — which is checked, cheaply, by
// owner; then the delete runs with the FK triggers off for its own transaction
// (session_replication_role: a superuser setting, which the test role is,
// locally and in CI). Otherwise it falls back to batches that each stay well
// under the breaker.
async function deleteNodesOf(ownerKeys) {
  const { rows: [{ n }] } = await q(
    `SELECT (SELECT count(*) FROM context_graph_edges WHERE owner_key = ANY($1::text[]))
          + (SELECT count(*) FROM context_graph_evidence WHERE owner_key = ANY($1::text[])) AS n`,
    [ownerKeys],
  );
  if (Number(n) === 0) {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('DELETE FROM context_graph_nodes WHERE owner_key = ANY($1::text[])', [ownerKeys]);
      await client.query('COMMIT');
      return;
    } catch {
      await client.query('ROLLBACK').catch(() => {});
    } finally {
      client.release();
    }
  }
  for (;;) {
    const { rowCount } = await q(
      'DELETE FROM context_graph_nodes WHERE node_id IN (SELECT node_id FROM context_graph_nodes WHERE owner_key = ANY($1::text[]) LIMIT 500)',
      [ownerKeys],
    );
    if (!rowCount) break;
  }
}

/**
 * Seeds the vault and returns the owners it wrote, the big project, and
 * `cleanup()`, which deletes every row it wrote.
 */
async function seedVaultScale({ tag, decisions = 20000, totalNodes = 200000, owners = 180 }) {
  const now = Date.now();
  const bigOwner = `vscale-${tag}-big`;
  const bigProject = `proj-vscale-${tag}-big`;
  const ownerKeys = [bigOwner];

  // The busy project: `decisions` decision nodes, oldest first; every 10th is
  // resolved. One in 50 is a duplicate, and they are the NEWEST: a merge is an
  // await, and a duplicate every few nodes would hand the event loop back often
  // enough to hide a loop that holds it for as long as it runs between them.
  const big = [];
  const bigResolved = [];
  const bigDuplicates = Math.floor(decisions / 50);
  for (let i = 0; i < decisions; i += 1) {
    const duplicateOf = i >= decisions - bigDuplicates ? (i - (decisions - bigDuplicates)) * 40 : null;
    const origin = duplicateOf === null ? i : duplicateOf;
    const resolved = origin % 10 === 3;
    if (resolved && duplicateOf === null) bigResolved.push(i);
    big.push(decisionNode({
      id: `node_vscale_${tag}_big_${i}`,
      owner: bigOwner,
      project: bigProject,
      label: 'the busy ledger',
      i,
      at: new Date(now - 200 * DAY + i * 1000).toISOString(),
      author: origin % 4 === 0 ? 'user-vscale-a' : 'user-vscale-b',
      resolvedAt: resolved ? new Date(now - DAY).toISOString() : null,
      duplicateOf,
    }));
  }
  await createProject({ owner: bigOwner, project: bigProject, name: `Busy ledger ${tag}`, context: briefFor({ label: 'the busy ledger', resolvedIndexes: bigResolved, withBlocker: false }) });
  await insertNodes(big);

  // Everybody else.
  const perOwner = Math.max(0, Math.floor((totalNodes - decisions) / owners));
  const types = ['decision', 'decision', 'decision', 'decision', 'decision', 'task', 'task', 'task', 'task', 'task', 'question', 'question', 'question', 'question', 'knowledge', 'knowledge', 'knowledge', 'knowledge', 'knowledge', 'knowledge'];
  let batch = [];
  for (let o = 0; o < owners && perOwner > 0; o += 1) {
    const owner = `vscale-${tag}-o${o}`;
    const project = `proj-vscale-${tag}-o${o}`;
    const label = `tenant ${o}`;
    const name = `Tenant ${o} ${tag}`;
    ownerKeys.push(owner);
    const resolvedIndexes = [];
    for (let j = 0; j < perOwner; j += 1) {
      const type = types[j % 20];
      const id = `node_vscale_${tag}_o${o}_${j}`;
      const at = new Date(now - (j % 40) * DAY - j * 1000).toISOString();
      if (type === 'decision') {
        const duplicateOf = j % 100 === 1 ? j - 1 : null;
        const resolved = j % 5 === 2;
        if (resolved) resolvedIndexes.push(j);
        batch.push(decisionNode({ id, owner, project, label, i: j, at, author: `user-vscale-${o}`, resolvedAt: resolved ? new Date(now - DAY).toISOString() : null, duplicateOf }));
        continue;
      }
      const row = {
        node_id: id,
        owner_key: owner,
        project_id: project,
        node_type: type,
        canonical_key: `${type}:vscale-${o}-${j}`,
        title: `${type} ${j}: ${VERBS[j % 7]} the ${NOUNS[j % 11]} for ${label}`,
        summary: `${VERBS[j % 7]} the ${NOUNS[j % 11]} for ${label}, item ${j}.`,
        metadata: { source_kind: 'inferred', memory_tier: 'durable', curation_state: 'promoted', retrieval_hits: j % 4 },
        created_at: at,
        updated_at: at,
        last_seen_at: at,
      };
      if (j % 37 === 5 && LEGACY[type]) {
        // The generator's own sentence, from its own era: phase 1 repairs it.
        Object.assign(row, { summary: `${LEGACY[type]}${name}.`, created_at: LEGACY_AT, updated_at: LEGACY_AT, last_seen_at: LEGACY_AT });
      } else if (j % 41 === 6) {
        // A blob from before the store capped summaries: phase 3 cuts it.
        Object.assign(row, { summary: `${row.summary} ${'Long session write-up with measurements and caveats. '.repeat(10)}`, created_at: LEGACY_AT, updated_at: LEGACY_AT, last_seen_at: LEGACY_AT });
      } else if (j % 397 === 7) {
        // Few: phase 4 deletes them in one statement, and every node deleted has
        // Postgres scan the edges and evidence for it (see deleteNodesOf).
        row.metadata = { ...row.metadata, memory_tier: 'candidate' };
        row.last_seen_at = new Date(now - 30 * DAY).toISOString();
      } else if (j % 29 === 8) {
        row.metadata = { ...row.metadata, retrieval_hits: 0 };
        row.last_seen_at = new Date(now - 60 * DAY).toISOString();
      }
      batch.push(row);
    }
    await createProject({ owner, project, name, context: briefFor({ label, resolvedIndexes, withBlocker: true }) });
    if (batch.length >= 5000) {
      await insertNodes(batch);
      batch = [];
    }
  }
  await insertNodes(batch);

  async function cleanup() {
    await deleteNodesOf(ownerKeys);
    // One owner to a statement: every project deleted has Postgres look for the
    // graph rows filed under it, and no index there leads with project_id.
    for (const owner of ownerKeys) {
      await q('DELETE FROM context_projects WHERE owner_key = $1', [owner]);
      await q('DELETE FROM user_encryption_keys WHERE owner_key = $1', [owner]);
    }
  }

  return { ownerKeys, bigOwner, bigProject, bigDuplicates, cleanup };
}

module.exports = { seedVaultScale, decisionText, decisionNode, insertNodes, createProject };
