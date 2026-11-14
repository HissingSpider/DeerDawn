/**
 * SCAN 17 — THE PROJECT-ROOT RE-KEY AT PRODUCTION SCALE.
 *
 * migrateNameKeyedProjectRoots ran inside runAutoMigration's boot transaction,
 * under the boot advisory lock, and asked — per root — for every evidence row on
 * every entity the root touched, filtering edge_id in JS. One owner with 300
 * projects on 40 shared entities took ~20s; a 100-project owner with 50
 * same-name pairs ~13s. Past the 25s statement timeout a second machine's boot
 * fails on the lock (restart loop), old machines' extraction upserts block on
 * the root rows until COMMIT, and a killed boot rolls the repair back unmarked.
 *
 * Pinned here:
 *   - the per-owner repair is fast at that scale (reads the owner's evidence once,
 *     edge filter in SQL, set-based writes);
 *   - runAutoMigration no longer runs it — a legacy root survives a boot;
 *   - runProjectRootMigration does it after boot, one owner per transaction,
 *     resumes after an interruption, and writes its marker once complete;
 *   - correctness: a shared-name split, a rename leftover, and an edge BETWEEN
 *     two legacy roots keep every edge and every evidence row.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan17-root-migration.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const db = require('../../src/config/db');
const graph = require('../../src/services/contextGraphService');
const { runAutoMigration, runProjectRootMigration, PROJECT_ROOTS_MIGRATION } = require('../../src/config/autoMigrate');

const q = (text, params) => db.pool.query(text, params);
const id = (prefix) => `${prefix}_${crypto.randomUUID()}`;
const quiet = { log() {}, error() {} };

async function project(owner, name) {
  const pid = id('project');
  await q('INSERT INTO context_projects (project_id, owner_key, project_name) VALUES ($1, $2, $3)', [pid, owner, name]);
  return pid;
}
async function node(owner, pid, type, key, meta = {}, summary = '') {
  const nid = id('graph_node');
  await q(
    `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, source_tool)
     VALUES ($1, $2, $3, $4, $5, $5, $6, $7, 'test')`,
    [nid, owner, pid, type, key, summary, meta],
  );
  return nid;
}
async function edge(owner, pid, from, to, type = 'uses') {
  const eid = id('graph_edge');
  await q(
    `INSERT INTO context_graph_edges (edge_id, owner_key, project_id, edge_type, from_node_id, to_node_id, source_tool)
     VALUES ($1, $2, $3, $4, $5, $6, 'test')`,
    [eid, owner, pid, type, from, to],
  );
  return eid;
}
async function evidence(owner, pid, nodeId, edgeId) {
  await q(
    `INSERT INTO context_graph_evidence (evidence_id, owner_key, project_id, session_id, node_id, edge_id, tool, excerpt)
     VALUES ($1, $2, $3, 's1', $4, $5, 'test', 'x')`,
    [id('graph_evidence'), owner, pid, nodeId, edgeId],
  );
}
const count = async (owner, table) => Number((await q(`SELECT count(*) FROM ${table} WHERE owner_key = $1`, [owner])).rows[0].count);
const legacyLeft = async (owner) => Number((await q(
  `SELECT count(*) FROM context_graph_nodes WHERE owner_key = $1 AND node_type = 'project'
      AND metadata ? 'project_id' AND metadata ? 'tech_stack' AND canonical_key <> 'project:' || project_id`,
  [owner],
)).rows[0].count);

async function migrateOwner(owner) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const started = Date.now();
    const stats = await graph.migrateProjectRootsForOwner((text, params) => client.query(text, params), owner);
    await client.query('COMMIT');
    return { stats, ms: Date.now() - started };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// One owner, P projects, E shared entities; every project's root has an edge to
// every entity and 5 evidence rows per edge — so each entity carries evidence
// from EVERY project, which is what made the per-root read quadratic.
async function bigWorkspace({ projects: P, entities: E, sharedNames }) {
  const owner = `org-${crypto.randomUUID()}`;
  const ents = [];
  for (let i = 0; i < E; i += 1) ents.push(await node(owner, null, 'service', `service:s${i}`));
  for (let p = 0; p < P; p += 1) {
    const label = sharedNames ? p % Math.floor(P / 2) : p;
    const pid = await project(owner, `proj ${label}`);
    const key = `project:proj_${label}`;
    const existing = (await q('SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND canonical_key = $2', [owner, key])).rows[0];
    const root = existing ? existing.node_id : await node(owner, pid, 'project', key, { project_id: pid, tech_stack: [] }, 'x'.repeat(50));
    const values = [];
    const params = [];
    ents.forEach((to) => {
      const b = params.length;
      params.push(id('graph_edge'), owner, pid, root, to);
      values.push(`($${b + 1}, $${b + 2}, $${b + 3}, 'uses', $${b + 4}, $${b + 5}, 't')`);
    });
    await q(
      `INSERT INTO context_graph_edges (edge_id, owner_key, project_id, edge_type, from_node_id, to_node_id, source_tool)
       VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      params,
    );
    await q(
      `INSERT INTO context_graph_evidence (evidence_id, owner_key, project_id, session_id, node_id, edge_id, tool, excerpt)
       SELECT 'graph_evidence_' || gen_random_uuid(), owner_key, $2, 's', to_node_id, edge_id, 't', 'x'
         FROM context_graph_edges, generate_series(1, 5)
        WHERE owner_key = $1 AND from_node_id = $3`,
      [owner, pid, root],
    );
  }
  return owner;
}

test.before(async () => {
  await runAutoMigration();
});
test.after(() => db.pool.end());

test('perf: 300 projects x 40 shared entities (60k evidence) re-key in well under the breaker', { timeout: 180000 }, async () => {
  const owner = await bigWorkspace({ projects: 300, entities: 40, sharedNames: false });
  const before = await count(owner, 'context_graph_evidence');
  const { stats, ms } = await migrateOwner(owner);
  console.log(`# 300 unique roots: ${ms}ms ${JSON.stringify(stats)}`);
  assert.equal(stats.rekeyed, 300);
  assert.equal(await count(owner, 'context_graph_evidence'), before, 'no evidence lost');
  assert.equal(await legacyLeft(owner), 0);
  assert.ok(ms < 3000, `one owner's repair took ${ms}ms (was ~20s)`);
});

test('perf: 100 projects, 50 same-name pairs split in well under the breaker', { timeout: 180000 }, async () => {
  const owner = await bigWorkspace({ projects: 100, entities: 40, sharedNames: true });
  const before = await count(owner, 'context_graph_evidence');
  const { stats, ms } = await migrateOwner(owner);
  console.log(`# 50 split roots: ${ms}ms ${JSON.stringify(stats)}`);
  assert.equal(stats.split, 50);
  assert.equal(stats.rootsCreated, 50);
  assert.equal(await count(owner, 'context_graph_evidence'), before, 'no evidence lost');
  // Every evidence row rides an edge from its OWN project's root.
  const mis = (await q(
    `SELECT count(*)::int AS n FROM context_graph_evidence ev
       JOIN context_graph_edges e ON e.edge_id = ev.edge_id
       JOIN context_graph_nodes r ON r.node_id = e.from_node_id
      WHERE ev.owner_key = $1 AND r.project_id IS DISTINCT FROM ev.project_id`,
    [owner],
  )).rows[0].n;
  assert.equal(mis, 0);
  // 1.4-1.7s on a developer machine; a shared GitHub runner is several times
  // slower and went past the old 3s budget. What this guards is the ~13s
  // per-owner regression, and staying under the 10s DB circuit breaker CI
  // runs with, so the budget sits between the two.
  assert.ok(ms < 8000, `one owner's split took ${ms}ms (was ~13s)`);
});

test('boot: runAutoMigration no longer runs the re-key (a legacy root survives a boot)', async () => {
  const owner = `org-${crypto.randomUUID()}`;
  const pid = await project(owner, 'Boot');
  await node(owner, pid, 'project', 'project:boot', { project_id: pid, tech_stack: [] }, 'kept by boot');
  await q('DELETE FROM context_migrations WHERE name = $1', [PROJECT_ROOTS_MIGRATION]);
  await runAutoMigration();
  assert.equal(await legacyLeft(owner), 1, 'the boot transaction must not do this repair');

  const autoMigrate = fs.readFileSync(path.join(__dirname, '../../src/config/autoMigrate.js'), 'utf8');
  const bootBody = autoMigrate.slice(autoMigrate.indexOf('async function runAutoMigration'), autoMigrate.indexOf('async function runProjectRootMigration'));
  assert.doesNotMatch(bootBody, /migrate(NameKeyedProjectRoots|ProjectRootsForOwner)\(/);
  const server = fs.readFileSync(path.join(__dirname, '../../src/server.js'), 'utf8');
  const ready = server.indexOf('setBootstrapReady();');
  const kick = server.indexOf('runProjectRootMigration()');
  assert.ok(ready > -1 && kick > ready, 'the repair starts only after readiness');
  assert.doesNotMatch(server, /await\s+runProjectRootMigration/, 'and boot does not wait for it');

  const totals = await runProjectRootMigration({ log: quiet });
  assert.equal(totals.failed, 0);
  assert.equal(await legacyLeft(owner), 0, 'the deferred runner does it');
  assert.equal((await q('SELECT summary FROM context_graph_nodes WHERE owner_key = $1', [owner])).rows[0].summary, 'kept by boot');
  assert.equal((await q('SELECT count(*)::int AS n FROM context_migrations WHERE name = $1', [PROJECT_ROOTS_MIGRATION])).rows[0].n, 1, 'marked once complete');
  assert.deepEqual(await runProjectRootMigration({ log: quiet }), { skipped: true });
});

test('resume: an owner already done is not redone; the rest are picked up', async () => {
  const a = `org-${crypto.randomUUID()}`;
  const b = `org-${crypto.randomUUID()}`;
  for (const owner of [a, b]) {
    const pid = await project(owner, 'Same');
    await node(owner, pid, 'project', 'project:same', { project_id: pid, tech_stack: [] }, 'text');
  }
  await q('DELETE FROM context_migrations WHERE name = $1', [PROJECT_ROOTS_MIGRATION]);
  await migrateOwner(a); // an earlier pass got as far as owner a, then the machine died
  const owners = await graph.listOwnersWithLegacyProjectRoots(q);
  assert.ok(!owners.includes(a) && owners.includes(b), 'progress is durable per owner');
  await runProjectRootMigration({ log: quiet });
  assert.equal(await legacyLeft(b), 0);
});

test('correctness: shared-name split, rename leftover and a root-to-root edge keep every edge and evidence row', async () => {
  const owner = `org-${crypto.randomUUID()}`;
  const p1 = await project(owner, 'Atlas');
  const p2 = await project(owner, 'Atlas');
  const p3 = await project(owner, 'Hermes'); // was "Hermes Old" before a rename
  const r1 = await node(owner, p1, 'project', 'project:atlas', { project_id: p2, tech_stack: ['node'] }, 'P2 status text that is long enough to stick');
  const r3a = await node(owner, p3, 'project', 'project:hermes_old', { project_id: p3, tech_stack: [] }, 'hermes old summary long enough to stick here');
  const r3b = await node(owner, p3, 'project', 'project:hermes', { project_id: p3, tech_stack: [] }, 'hermes new summary long enough to stick here');
  const pg = await node(owner, p1, 'service', 'service:postgres');
  const redis = await node(owner, p2, 'service', 'service:redis');
  const e1 = await edge(owner, p1, r1, pg); await evidence(owner, p1, pg, e1); await evidence(owner, p2, pg, e1);
  const e2 = await edge(owner, p2, r1, redis); await evidence(owner, p2, redis, e2);
  const e3 = await edge(owner, p3, r3a, pg); await evidence(owner, p3, pg, e3);
  const e4 = await edge(owner, p3, r3b, pg); await evidence(owner, p3, pg, e4);
  const e5 = await edge(owner, p3, r3b, redis); await evidence(owner, p3, redis, e5);
  // An edge BETWEEN two legacy roots: the first root processed rewrites it, so
  // the second must re-read its edges rather than trust the first read.
  const e6 = await edge(owner, p2, r1, r3b, 'depends_on'); await evidence(owner, p2, r3b, e6);
  const before = await count(owner, 'context_graph_evidence');

  const { stats } = await migrateOwner(owner);
  const roots = (await q('SELECT node_id, project_id, canonical_key, summary FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'project\'', [owner])).rows;
  assert.deepEqual(roots.map((r) => r.canonical_key).sort(), [`project:${p1}`, `project:${p2}`, `project:${p3}`].sort(), JSON.stringify({ stats, roots }));
  const rootOf = Object.fromEntries(roots.map((r) => [r.project_id, r.node_id]));
  const edgesOf = async (pid) => (await q('SELECT to_node_id FROM context_graph_edges WHERE owner_key = $1 AND from_node_id = $2', [owner, rootOf[pid]])).rows.map((r) => r.to_node_id).sort();
  assert.deepEqual(await edgesOf(p1), [pg]);
  // The root-to-root edge is p2's (its project and its evidence), and a root
  // edge counts as a sighting on BOTH ends — the rule the first version had —
  // so it lands on p2's root at both ends. Pinned so a change is deliberate.
  assert.deepEqual(await edgesOf(p2), [pg, redis, rootOf[p2]].sort());
  assert.deepEqual(await edgesOf(p3), [pg, redis].sort());
  assert.equal(await count(owner, 'context_graph_evidence'), before, 'no evidence lost');
  const mis = (await q(
    `SELECT ev.project_id, e.from_node_id FROM context_graph_evidence ev JOIN context_graph_edges e ON e.edge_id = ev.edge_id
      WHERE ev.owner_key = $1`,
    [owner],
  )).rows.filter((r) => rootOf[r.project_id] !== r.from_node_id);
  assert.deepEqual(mis, [], 'evidence re-pointed to its own project root');
  assert.ok(roots.filter((r) => r.project_id !== p3).every((r) => r.summary === ''), 'ambiguous text cleared');
  assert.equal((await migrateOwner(owner)).stats.roots, 0, 'idempotent');
});
