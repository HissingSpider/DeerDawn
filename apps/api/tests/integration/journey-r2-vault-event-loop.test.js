/**
 * JOURNEY ROUND 2 (R2-4) — THE NIGHTLY VAULT JOB SHARES THE API'S EVENT LOOP.
 *
 * The scheduler runs runVaultRemediation inside the API process, 10 seconds
 * after every boot (every deploy) and then every 24 hours. Phase 5 compared
 * every decision node of a project with every node it had kept before it, and
 * nothing in that loop awaited unless a merge happened. Measured with this
 * test: 2,000 decisions in one project held the event loop for 5 s, 5,000 for
 * 14 s, 20,000 for 13.5 minutes (the walker saw 2.1 s at 1,000 and 8.0 s at
 * 2,000). For all of it nobody could sign in, no MCP call was answered, and
 * /healthz did not answer Fly's 10-second health check. Every query was fast,
 * so the 8-second DB breaker never tripped; nothing said anything was wrong.
 * Every manage_memory update stores a decision node, so it is the busy projects
 * that get there.
 *
 * Held here: at 20,000 decisions in one project and 200,000 nodes across
 * owners, no phase goes longer than GAP_BOUND_MS without letting the event loop
 * turn (the job aims at ~20 ms; the bound leaves room for a loaded CI machine),
 * phase 5 and the whole run finish in bounded time, and a run that reaches its
 * time budget stops between units of work and the next one finishes the rest.
 *
 * DB-backed, and run with ENCRYPTION_MASTER_KEY set, as production is:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r2-vault-event-loop.test.js
 * VAULT_SCALE_DECISIONS / VAULT_SCALE_NODES shrink the seed (to reproduce the
 * old behaviour without waiting minutes for it).
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { v4: uuidv4 } = require('uuid');
const db = require('../../src/config/db');
// server.js loads it (through app.js and its routes) before it starts the
// scheduler; the job requires it lazily, and here that first require — ~60 ms
// of module loading — would otherwise land inside phase 5's measurement.
require('../../src/services/contextSyncService');
const vault = require('../../src/jobs/vaultRemediationJob');
const { seedVaultScale, decisionNode, insertNodes, createProject } = require('../helpers/vaultScaleSeed');

const DECISIONS = Number(process.env.VAULT_SCALE_DECISIONS || 20000);
const NODES = Number(process.env.VAULT_SCALE_NODES || 200000);
const GAP_BOUND_MS = 250;
// Measured locally at ~4 s for phase 5 and ~7 s for the run at full scale;
// the bounds are what a machine several times slower still meets, and far below
// what the pairwise loop took (phase 5 alone: 14 minutes).
const PHASE5_WALL_BOUND_MS = 30000;
const RUN_WALL_BOUND_MS = 120000;

const q = (sql, params) => db.query(sql, params, 'org-system');

test.after(() => db.pool.end());

// Runs `run` while a 5 ms timer notes how long the event loop went between
// turns. Each phase logs "[VAULT-REMEDIATION] Phase N: ..." when it ends, which
// closes that phase's window: a gap is charged to the phase it happened in.
async function measure(run) {
  const phases = [];
  const errors = [];
  let current = { maxGapMs: 0, startedAt: performance.now() };
  let last = performance.now();
  let maxGapMs = 0;
  const note = (now) => {
    const gap = now - last;
    current.maxGapMs = Math.max(current.maxGapMs, gap);
    maxGapMs = Math.max(maxGapMs, gap);
    last = now;
  };
  const timer = setInterval(() => note(performance.now()), 5);
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => {
    const line = args.join(' ');
    const phase = /^\[VAULT-REMEDIATION\] Phase (\d):/.exec(line);
    if (!phase) return;
    const now = performance.now();
    note(now);
    phases.push({ phase: Number(phase[1]), wallMs: now - current.startedAt, maxGapMs: current.maxGapMs, line });
    // Printed as it happens, so a run that never finishes still says how far it got.
    process.stderr.write(`  phase ${phase[1]}: wall ${Math.round(now - current.startedAt)} ms, longest event-loop gap ${Math.round(current.maxGapMs)} ms\n`);
    current = { maxGapMs: 0, startedAt: now };
  };
  console.error = (...args) => { errors.push(args.join(' ')); };
  const startedAt = performance.now();
  try {
    await run();
  } finally {
    clearInterval(timer);
    console.log = originalLog;
    console.error = originalError;
  }
  note(performance.now());
  return { phases, errors, maxGapMs, wallMs: performance.now() - startedAt };
}

test(`R2-4: at ${DECISIONS} decisions in one project and ${NODES} nodes, no phase holds the event loop past ${GAP_BOUND_MS} ms, and the run ends in bounded time`, async (t) => {
  const tag = uuidv4().slice(0, 8);
  const seededAt = performance.now();
  const seed = await seedVaultScale({ tag, decisions: DECISIONS, totalNodes: NODES });
  t.after(() => seed.cleanup());
  t.diagnostic(`seeded ${NODES} nodes (${DECISIONS} decisions in one project) in ${Math.round(performance.now() - seededAt)} ms`);

  const run = await measure(() => vault.runVaultRemediation());
  for (const p of run.phases) t.diagnostic(`phase ${p.phase}: wall ${Math.round(p.wallMs)} ms, longest event-loop gap ${Math.round(p.maxGapMs)} ms`);
  t.diagnostic(`whole run: wall ${Math.round(run.wallMs)} ms, longest event-loop gap ${Math.round(run.maxGapMs)} ms`);

  const failed = run.errors.find((line) => line.includes('[VAULT-REMEDIATION]') && line.includes('failed'));
  assert.equal(failed, undefined, `a phase failed: ${failed}`);
  assert.deepEqual(run.phases.map((p) => p.phase), [1, 3, 4, 5, 6, 8], 'every live phase ran, in order (2 and 7 are retired)');
  for (const p of run.phases) {
    assert.ok(p.maxGapMs < GAP_BOUND_MS, `phase ${p.phase} held the event loop for ${Math.round(p.maxGapMs)} ms (bound ${GAP_BOUND_MS} ms)`);
  }
  assert.ok(run.maxGapMs < GAP_BOUND_MS, `the run held the event loop for ${Math.round(run.maxGapMs)} ms`);
  const phase5 = run.phases.find((p) => p.phase === 5);
  assert.ok(phase5.wallMs < PHASE5_WALL_BOUND_MS, `phase 5 took ${Math.round(phase5.wallMs)} ms (bound ${PHASE5_WALL_BOUND_MS} ms)`);
  assert.ok(run.wallMs < RUN_WALL_BOUND_MS, `the run took ${Math.round(run.wallMs)} ms (bound ${RUN_WALL_BOUND_MS} ms)`);

  // And it still did its work: every seeded duplicate in the busy project went,
  // and nothing else did.
  const { rows: [{ n }] } = await q(
    'SELECT count(*)::int AS n FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\'',
    [seed.bigOwner],
  );
  assert.equal(n, DECISIONS - seed.bigDuplicates, `${seed.bigDuplicates} seeded duplicates collapsed, every other decision kept`);
});

test('R2-4: a run that reaches its time budget stops between merges, and the next run finishes what it left, with the same survivors', async (t) => {
  const tag = uuidv4().slice(0, 8);
  const owner = `vscale-${tag}-budget`;
  const project = `proj-vscale-${tag}-budget`;
  const PAIRS = 300;
  await createProject({ owner, project, name: `Budget ${tag}`, context: { recent_decisions: [] } });
  const rows = [];
  const base = Date.now() - 10 * 86400000;
  for (let i = 0; i < PAIRS; i += 1) {
    for (const [k, duplicateOf] of [[2 * i, null], [2 * i + 1, 2 * i]]) {
      rows.push(decisionNode({
        id: `node_vscale_${tag}_budget_${String(k).padStart(4, '0')}`,
        owner,
        project,
        label: 'the budget ledger',
        i: k,
        at: new Date(base + k * 1000).toISOString(),
        author: 'user-vscale-budget',
        duplicateOf,
      }));
    }
  }
  await insertNodes(rows);
  t.after(async () => {
    await q('DELETE FROM context_graph_nodes WHERE owner_key = $1', [owner]);
    await q('DELETE FROM context_projects WHERE owner_key = $1', [owner]);
    await q('DELETE FROM user_encryption_keys WHERE owner_key = $1', [owner]);
  });
  const originals = rows.filter((_, k) => k % 2 === 0).map((row) => row.node_id).sort();
  const remaining = async () => (await q(
    'SELECT node_id FROM context_graph_nodes WHERE owner_key = $1 AND node_type = \'decision\' ORDER BY node_id',
    [owner],
  )).rows.map((row) => row.node_id);

  // The 40th merge of these runs past the budget, so the run must stop at the
  // next boundary: after that merge, before the 41st.
  const STOP_AFTER = 40;
  const deadline = Date.now() + 5000;
  let merged = 0;
  const originalQuery = db.query;
  db.query = async (sql, params, ...rest) => {
    const result = await originalQuery.call(db, sql, params, ...rest);
    if (/^DELETE FROM context_graph_nodes WHERE node_id = \$1$/.test(String(sql).trim()) && String(params?.[0]).includes(`_${tag}_budget_`)) {
      merged += 1;
      if (merged === STOP_AFTER) await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now()) + 20));
    }
    return result;
  };
  let first;
  try {
    first = await vault.collapseDuplicateDecisions({ deadline });
  } finally {
    db.query = originalQuery;
  }
  const afterFirst = await remaining();
  t.diagnostic(`first run: ${JSON.stringify(first)}, ${afterFirst.length - PAIRS} duplicates left`);
  assert.equal(first.stopped, true, 'the run says it stopped at its budget');
  assert.equal(afterFirst.length, 2 * PAIRS - STOP_AFTER, 'it stopped at the first boundary past the budget, with the merge in flight finished');
  for (const id of originals) assert.ok(afterFirst.includes(id), `${id}: the survivor of every pair is the oldest, stopped or not`);

  // A run whose budget is already spent starts nothing, and says so.
  const lines = [];
  const originalLog = console.log;
  const originalError = console.error;
  const errors = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  console.error = (...args) => { errors.push(args.join(' ')); };
  try {
    await vault.runVaultRemediation({ budgetMs: 0 });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.deepEqual(errors, []);
  assert.ok(lines.some((line) => /budget/.test(line)), lines.join('\n'));
  assert.deepEqual(await remaining(), afterFirst, 'nothing was merged past the budget');

  const second = await vault.collapseDuplicateDecisions();
  assert.equal(second.stopped, false);
  assert.deepEqual(await remaining(), originals, 'the next run finished the rest: exactly the oldest of every pair is left');
});
