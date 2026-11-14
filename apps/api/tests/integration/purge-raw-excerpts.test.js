/**
 * scripts/purge-raw-excerpts.js — the owner's one-off removal of the raw
 * conversation excerpts the knowledge graph stored before 2026-09-28.
 *
 * It is permanent, it runs against production by hand, and nothing checks it
 * afterwards but the owner. So each promise the runbook makes is exercised here
 * against real rows, through the real script, as a child process:
 *
 *   - a dry run changes nothing and prints counts only;
 *   - an apply replaces the raw excerpts with the line new rows get, and writes
 *     nothing else: every other column of every row is compared before and after;
 *   - a second run changes nothing;
 *   - a run cut short (by --max-batches, and by SIGKILL mid-run) leaves every row
 *     whole, and the next run finishes the job;
 *   - it replaces a row only when its tool, and not its text alone, says the old
 *     capture path wrote it: entity notes and other rows a person or the product
 *     wrote are left byte for byte whatever their text (an entity titled
 *     "[WIP] ..." opens exactly like a transcript), and so is a transcript-shaped
 *     row from a tool the script does not know, counted under its own heading;
 *   - rows it cannot classify, and rows the new path wrote (even one whose text
 *     looks raw) are left alone;
 *   - every count it prints is what a direct query of the table says;
 *   - without --yes it asks for the database name, and a wrong answer changes
 *     nothing;
 *   - the vector of each row it replaces goes with it, in the same batch (so a
 *     kill never separates them), and so does the vector of a row an earlier
 *     run replaced when it is older than every new-path line; no other vector
 *     is deleted, and every vector count it prints is the table.
 *
 * Every run is scoped with --owner to rows this file wrote, so it cannot touch
 * another suite's data in a shared test database.
 *
 *   bash scripts/run-db-test.sh node --test tests/integration/purge-raw-excerpts.test.js
 */

process.env.NODE_ENV = 'test';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const store = require('../../src/store/contextSyncStore');
const { runAutoMigration } = require('../../src/config/autoMigrate');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'purge-raw-excerpts.js');
// The tools the old capture path stamped on its rows (the session's tool), from
// the table in docs/runbooks/purge-raw-excerpts.md. Written here, not imported
// from the script, so the test checks the script's list rather than repeating it.
const CAPTURE_TOOLS = ['claude_code', 'cursor', 'codex', 'claude_web', 'chatgpt_web', 'gemini', 'perplexity'];
// The old path's opening, in Postgres regex syntax.
const RAW_SHAPE = '^\\[[^]]{1,40}] ';
const q = (sql, params) => db.query(sql, params, 'org-system');
const token = () => [...crypto.randomBytes(12)].map((b) => String.fromCharCode(65 + (b % 26))).join('');

test.after(async () => {
  await db.pool.end().catch(() => {});
});

function run(args, { input = '' } = {}) {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, NODE_ENV: 'production' },
    input,
    encoding: 'utf8',
    timeout: 120000,
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

/**
 * One workspace with the rows every kind of classification sees, written the
 * way each writer wrote them: the OLD graph path (a raw `[user] ... [assistant]
 * ...` excerpt, no marker, the capturing session's tool), the old fallback (the
 * project's status, no marker), upsert_entities (entity notes, no marker; four
 * of them open with a bracketed tag exactly as a transcript does),
 * resolve_question (tool manual, and the old path's `[user] ` shape), a
 * hand-made row (tool dashboard), a transcript-shaped row from a tool nobody
 * listed, two shapes the old writer could not produce, and the NEW path (marked).
 */
async function seedWorkspace(label, { rawCount = 4 } = {}) {
  const ownerKey = `org-${uuidv4()}`;
  const projectId = `proj_${uuidv4()}`;
  const projectName = `${label} Ledger ${token().slice(0, 6)}`;
  await q(
    `INSERT INTO context_projects (project_id, owner_key, project_name, context, visibility)
     VALUES ($1, $2, $3, '{}'::jsonb, 'private')`,
    [projectId, ownerKey, projectName],
  );
  const now = new Date().toISOString();
  const node = async (nodeType, title) => store.upsertGraphNode({
    node_id: `graph_node_${uuidv4()}`,
    owner_key: ownerKey,
    project_id: projectId,
    node_type: nodeType,
    canonical_key: `${nodeType}:${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    title,
    summary: '',
    metadata: {},
    confidence: 0.8,
    source_session_id: 'sess-old',
    source_tool: 'claude_code',
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  });
  const nodes = {
    service: await node('service', 'Redis'),
    decision: await node('decision', 'Cap export retries at five attempts'),
    task: await node('task', 'Make the export worker drain its retry queue'),
    file: await node('file', 'src/export/worker.js'),
  };
  const kinds = ['service', 'decision', 'task', 'file'];
  const markers = [];
  const rows = [];
  // The old INSERT: no excerpt_kind, so NULL.
  const insert = async ({ nodeKey, excerpt, tool = 'claude_code', createdAt, project = projectId, kind = null }) => {
    const id = `graph_evidence_${uuidv4()}`;
    await q(
      `INSERT INTO context_graph_evidence
         (evidence_id, owner_key, project_id, session_id, node_id, edge_id, tool, excerpt, metadata, confidence, created_at, excerpt_kind)
       VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8::jsonb, $9, $10, $11)`,
      [id, ownerKey, project, 'sess-old', nodes[nodeKey].node_id, tool, excerpt,
        JSON.stringify({ conversation_ref: 'conv-old', cwd: '/tmp/ledger', host: 'claude_code' }), 0.8, createdAt, kind],
    );
    rows.push(id);
    return id;
  };
  const raw = [];
  const months = ['2026-07-15T10:00:00Z', '2026-08-15T10:00:00Z', '2026-09-15T10:00:00Z'];
  for (let i = 0; i < rawCount; i += 1) {
    const user = `QZUSER${token()}`;
    const assistant = `QZASST${token()}`;
    markers.push(user, assistant);
    const nodeKey = kinds[i % kinds.length];
    const tool = CAPTURE_TOOLS[i % CAPTURE_TOOLS.length];
    raw.push({
      id: await insert({
        nodeKey,
        excerpt: `[user] why does the export stall when ${user} arrives\n[assistant] the worker retries ${assistant} forever`,
        createdAt: months[i % months.length],
        tool,
      }),
      nodeKey,
      tool,
    });
  }
  // The project was deleted since: project_id went NULL (ON DELETE SET NULL).
  const orphanUser = `QZUSER${token()}`;
  markers.push(orphanUser);
  const orphan = await insert({ nodeKey: 'decision', excerpt: `[user] ${orphanUser} was the old plan`, createdAt: months[0], project: null });
  const note = (nodeKey, excerpt) => insert({ nodeKey, excerpt, tool: 'manual_workspace_entity', createdAt: months[2] });
  const untouched = {
    fallback: await insert({ nodeKey: 'task', excerpt: `Context updated for ${projectName}`, createdAt: months[1] }),
    entityNote: await note('service', 'Redis: the cache in front of the ledger'),
    // Words a person typed, filed by upsert_entities as "<title>: <summary>",
    // whose title opens the way a transcript does. Their tool says who wrote
    // them; their text proves nothing.
    entityNoteWip: await note('service', '[WIP] Payments Service: HANDTYPED handles card capture and refunds'),
    entityNoteUser: await note('file', '[user] Role Table: HANDTYPED the table that maps a user to a role'),
    entityNoteAssistant: await note('file', '[assistant] Prompt Template: HANDTYPED prompts/assistant.md is the template'),
    entityNoteX: await note('task', '[x] Ship the ledger export: HANDTYPED done on Friday'),
    // resolve_question: the old path, in the old `[user] ` shape, but tool
    // 'manual' — the question and the person's own answer.
    resolveAnswer: await insert({ nodeKey: 'decision', excerpt: '[user] should retries be capped per tenant?\nDecided: yes, HANDTYPED per tenant', tool: 'manual', createdAt: months[2] }),
    dashboardNote: await insert({ nodeKey: 'decision', excerpt: '[user] typed by hand in the dashboard HANDTYPED', tool: 'dashboard', createdAt: months[2] }),
    // Transcript-shaped, from a tool the script does not know: left, and named.
    unknownTool: await insert({ nodeKey: 'task', excerpt: '[user] shaped like a transcript from a tool nobody listed', tool: 'a2a', createdAt: months[2] }),
    // Shapes the old writer could not produce (it never led with whitespace, and
    // a role over 40 characters does not match): a person may have typed them.
    leadingSpace: await insert({ nodeKey: 'task', excerpt: '  [user] leading spaces before the role', createdAt: months[2] }),
    longRole: await insert({ nodeKey: 'task', excerpt: '[a very long role name that is longer than forty characters in total] text', createdAt: months[2] }),
    // The marker wins over the text: a row the new path wrote is never
    // re-judged, whatever it says.
    newPath: await insert({ nodeKey: 'file', excerpt: '[user] shaped like a transcript but written by the new path', createdAt: months[2], kind: 'derived' }),
  };
  return { ownerKey, projectId, projectName, nodes, raw, orphan, untouched, markers, rows };
}

// An evidence vector as the write path stores one (store.upsertGraphEmbedding):
// keyed by workspace, kind, target and model. `updatedAt` is when it was
// written; the script reads it for rows an earlier run replaced.
async function insertVector(ownerKey, targetId, { model = 'text-embedding-3-small', updatedAt = '2026-07-15T10:00:05Z', kind = 'evidence' } = {}) {
  await q(
    `INSERT INTO context_graph_embeddings (owner_key, target_kind, target_id, model, dimensions, vector, created_at, updated_at)
     VALUES ($1, $2, $3, $4, 3, $5::jsonb, $6, $6)`,
    [ownerKey, kind, targetId, model, JSON.stringify([0.1, 0.2, 0.3]), updatedAt],
  );
}

async function vectorSnapshot(ownerKey) {
  const res = await q(
    `SELECT owner_key, target_kind, target_id, model, dimensions, vector::text AS vector, created_at, updated_at
       FROM context_graph_embeddings WHERE owner_key = $1 ORDER BY target_kind, target_id, model`,
    [ownerKey],
  );
  return new Map(res.rows.map((row) => [`${row.target_kind}|${row.target_id}|${row.model}`, JSON.parse(JSON.stringify(row))]));
}

async function vectorIds(ownerKey) {
  return new Set((await q(
    'SELECT DISTINCT target_id FROM context_graph_embeddings WHERE owner_key = $1 AND target_kind = $2', [ownerKey, 'evidence'],
  )).rows.map((row) => row.target_id));
}

async function snapshot(ownerKey) {
  const res = await q('SELECT * FROM context_graph_evidence WHERE owner_key = $1 ORDER BY evidence_id', [ownerKey]);
  return new Map(res.rows.map((row) => [row.evidence_id, JSON.parse(JSON.stringify(row))]));
}

// What an old row records is the entity, the project it was written in, and
// that the capture path wrote it: not the brief section, which the node's type
// only suggests. So the line names no section.
function expectedLine(ws, nodeKey, { orphaned = false } = {}) {
  const project = orphaned ? 'a project' : ws.projectName;
  return {
    service: `Service "Redis" recorded in ${project} from a captured conversation.`,
    decision: `Decision "Cap export retries at five attempts" recorded in ${project} from a captured conversation.`,
    task: `Task "Make the export worker drain its retry queue" recorded in ${project} from a captured conversation.`,
    file: `File "src/export/worker.js" recorded in ${project} from a captured conversation.`,
  }[nodeKey];
}

// Every row whole: every column but excerpt and excerpt_kind as before; a raw
// row either untouched or replaced by exactly its line, with the marker.
function assertOnlyExcerptsReplaced(ws, before, after, { replacedIds }) {
  assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), 'no row was added or removed');
  const expectedFor = new Map([
    ...ws.raw.map(({ id, nodeKey }) => [id, expectedLine(ws, nodeKey)]),
    [ws.orphan, expectedLine(ws, 'decision', { orphaned: true })],
  ]);
  for (const [id, row] of after) {
    const was = before.get(id);
    const { excerpt: a, excerpt_kind: ak, ...restAfter } = row;
    const { excerpt: b, excerpt_kind: bk, ...restBefore } = was;
    assert.deepEqual(restAfter, restBefore, `no other column of ${id} changed`);
    if (replacedIds.has(id)) {
      assert.equal(a, expectedFor.get(id), `${id} carries the derived line`);
      assert.equal(ak, 'derived', `${id} is marked`);
    } else {
      assert.equal(a, b, `${id}'s excerpt is untouched`);
      assert.equal(ak, bk, `${id}'s marker is untouched`);
    }
  }
}

const rawIds = (ws) => new Set([...ws.raw.map(({ id }) => id), ws.orphan]);

test('the marker column is added by the boot migration as nullable text with no default, and a second boot adds nothing', async () => {
  await store.ensureSchema();
  const column = (await q(
    `SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'context_graph_evidence' AND column_name = 'excerpt_kind'`,
    [],
  )).rows[0];
  assert.deepEqual(column, { data_type: 'text', is_nullable: 'YES', column_default: null });

  // A row written without it keeps NULL: the column rewrote nothing.
  const ws = await seedWorkspace('Boot', { rawCount: 1 });
  const before = await snapshot(ws.ownerKey);
  const versions = async () => (await q('SELECT evidence_id, xmin::text AS v FROM context_graph_evidence WHERE owner_key = $1 ORDER BY 1', [ws.ownerKey])).rows;
  const versionsBefore = await versions();
  await runAutoMigration();
  await runAutoMigration();
  assert.deepEqual(await snapshot(ws.ownerKey), before, 'a boot changes no evidence row');
  assert.deepEqual(await versions(), versionsBefore, 'and does not even rewrite one (same row versions)');
  assert.equal(before.get(ws.raw[0].id).excerpt_kind, null, 'an old row stays unmarked until the owner runs the purge');
});

test('a dry run changes nothing, and prints counts only', async () => {
  const ws = await seedWorkspace('Dry');
  const before = await snapshot(ws.ownerKey);
  const { code, out } = run([`--owner=${ws.ownerKey}`]);
  assert.equal(code, 0, out);
  assert.deepEqual(await snapshot(ws.ownerKey), before, 'not one row changed');

  assert.match(out, /DRY RUN — nothing is changed\./);
  assert.match(out, /evidence rows\s+17\n/);
  assert.match(out, /raw conversation excerpts \(would be replaced\)\s+5\s+held by 1 workspace\(s\)\n\s+by tool: claude_code 2, claude_web 1, codex 1, cursor 1\n/);
  assert.match(out, /opening \[user\] or \[assistant\]: 5; opening another bracketed label: 0/);
  assert.match(out, /derived lines \(marked: written by the new path, or replaced\)\s+1\n/);
  assert.match(out, /entity notes from upsert_entities, whatever their text \(left alone\)\s+5\n\s+by tool: manual_workspace_entity 5\n/);
  assert.match(out, /other rows a person or the product wrote \(left alone\)\s+2\n\s+by tool: dashboard 1, manual 1\n/);
  assert.match(out, /looks like a conversation excerpt, written by a tool this script does not know: left alone\s+1\n\s+by tool: a2a 1\n/);
  assert.match(out, /unclassified \(left alone; can hold brief text\)\s+3\n\s+by tool: claude_code 3\n/);
  assert.match(out, /2026-07\s+3\n\s+2026-08\s+1\n\s+2026-09\s+1/, 'raw excerpts by month');
  assert.match(out, /1-9\s+rows: 1 workspace/);
  assert.match(out, /SELECT count\(\*\) AS raw_excerpts_left/, 'and says how to check');
  for (const marker of ws.markers) assert.ok(!out.includes(marker), 'no excerpt is printed');
  assert.ok(!out.includes(ws.ownerKey) && !out.includes(ws.projectName), 'no workspace or project is named');
});

test('apply replaces the raw excerpts and nothing else; a second run changes nothing', async () => {
  const ws = await seedWorkspace('Apply');
  const bystander = await seedWorkspace('Bystander');
  const before = await snapshot(ws.ownerKey);
  const bystanderBefore = await snapshot(bystander.ownerKey);

  const first = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--batch=3', '--sleep-ms=0']);
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /Done: replaced 5 raw excerpt\(s\)/);
  const after = await snapshot(ws.ownerKey);
  assertOnlyExcerptsReplaced(ws, before, after, { replacedIds: rawIds(ws) });
  assert.deepEqual(await snapshot(bystander.ownerKey), bystanderBefore, 'another workspace is untouched by a scoped run');
  for (const marker of ws.markers) assert.ok(!first.out.includes(marker), 'no excerpt is printed');

  // The verification query the script prints, run as printed.
  const verify = first.out.match(/SELECT count\(\*\) AS raw_excerpts_left[^\n]*/)[0];
  const left = await q(`${verify.replace(/;$/, '')} AND owner_key = $1`, [ws.ownerKey]);
  assert.equal(Number(left.rows[0].raw_excerpts_left), 0);

  const second = run([`--owner=${ws.ownerKey}`, '--apply', '--yes']);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /No raw excerpts to replace, and no old vectors to delete\. Nothing was changed\./);
  assert.deepEqual(await snapshot(ws.ownerKey), after, 'a second run changes nothing');
});

test('a run cut short leaves every row whole, and the next run finishes', async () => {
  const ws = await seedWorkspace('Resume', { rawCount: 6 });
  const before = await snapshot(ws.ownerKey);
  const raw = rawIds(ws);

  // The script walks the workspace's rows in primary-key order, and ids are
  // random, so which rows the first window holds is chance: with seven raw rows
  // among nineteen, a window of two held no raw row about two runs in five, and
  // this test asserted it replaced one (CI, journey round 4). Read the order the
  // way the script does and make the one batch end exactly on the first raw row:
  // it must replace that row and nothing else, and leave the rest to the rerun.
  const order = (await q('SELECT evidence_id FROM context_graph_evidence WHERE owner_key = $1 ORDER BY evidence_id', [ws.ownerKey])).rows.map((row) => row.evidence_id);
  const first = order.findIndex((id) => raw.has(id));
  assert.ok(first >= 0, 'premise: the workspace holds raw rows');
  const window = first + 1;

  const partial = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', `--batch=${window}`, '--max-batches=1', '--sleep-ms=0']);
  assert.equal(partial.code, 0, partial.out);
  assert.match(partial.out, /Stopped early/);
  assert.match(partial.out, new RegExp(`batch 1: examined ${window}, replaced 1 \\(total replaced 1\\)`));
  assert.match(partial.out, new RegExp(`${raw.size - 1} raw excerpt\\(s\\) still to replace`));
  const mid = await snapshot(ws.ownerKey);
  assertOnlyExcerptsReplaced(ws, before, mid, { replacedIds: new Set([order[first]]) });

  const rest = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(rest.code, 0, rest.out);
  assert.match(rest.out, new RegExp(`Done: replaced ${raw.size - 1} raw excerpt\\(s\\)`));
  assertOnlyExcerptsReplaced(ws, before, await snapshot(ws.ownerKey), { replacedIds: raw });
});

test('killed mid-run, no row is left half-written, and a rerun completes', async () => {
  const ws = await seedWorkspace('Killed', { rawCount: 8 });
  // A vector for every evidence row: a replaced row and its vector go together,
  // in one transaction, so at any moment a row is replaced exactly when its
  // vector is gone.
  for (const id of ws.rows) await insertVector(ws.ownerKey, id);
  const before = await snapshot(ws.ownerKey);
  const child = spawn(process.execPath, [SCRIPT, `--owner=${ws.ownerKey}`, '--apply', '--yes', '--batch=1', '--sleep-ms=300'], {
    env: { ...process.env, NODE_ENV: 'production' },
    stdio: 'ignore',
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Wait for the first committed batch, then kill without warning.
  const deadline = Date.now() + 30000;
  for (;;) {
    const done = await q('SELECT count(*)::int AS n FROM context_graph_evidence WHERE owner_key = $1 AND excerpt_kind = $2', [ws.ownerKey, 'derived']);
    if (done.rows[0].n > 1) break;
    assert.ok(Date.now() < deadline, 'the run never committed a batch');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  child.kill('SIGKILL');
  await exited;

  const mid = await snapshot(ws.ownerKey);
  const replacedSoFar = new Set([...mid.values()].filter((row) => row.excerpt_kind === 'derived' && before.get(row.evidence_id).excerpt_kind === null).map((row) => row.evidence_id));
  assert.ok(replacedSoFar.size < rawIds(ws).size, `premise: killed before the end (${replacedSoFar.size} of ${rawIds(ws).size})`);
  assertOnlyExcerptsReplaced(ws, before, mid, { replacedIds: replacedSoFar });
  const vectorsMid = await vectorIds(ws.ownerKey);
  for (const id of ws.rows) {
    assert.equal(vectorsMid.has(id), !replacedSoFar.has(id), `${id}: replaced exactly when its vector is gone`);
  }

  const rest = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(rest.code, 0, rest.out);
  assertOnlyExcerptsReplaced(ws, before, await snapshot(ws.ownerKey), { replacedIds: rawIds(ws) });
  const vectorsAfter = await vectorIds(ws.ownerKey);
  for (const id of ws.rows) assert.equal(vectorsAfter.has(id), !rawIds(ws).has(id), `${id}: after the rerun too`);
});

test('without --yes it asks for the database name, and a wrong answer changes nothing', async () => {
  const ws = await seedWorkspace('Confirm', { rawCount: 2 });
  const before = await snapshot(ws.ownerKey);
  const dbName = (await q('SELECT current_database() AS name', [])).rows[0].name;

  const wrong = run([`--owner=${ws.ownerKey}`, '--apply'], { input: 'deerdawn_prod\n' });
  assert.equal(wrong.code, 1, wrong.out);
  assert.match(wrong.out, new RegExp(`Type the database name \\(${dbName}\\)`));
  assert.match(wrong.out, /Not confirmed\. Nothing was changed\./);
  assert.deepEqual(await snapshot(ws.ownerKey), before);

  const none = run([`--owner=${ws.ownerKey}`, '--apply'], { input: '' });
  assert.equal(none.code, 1, 'no answer is not a yes');
  assert.deepEqual(await snapshot(ws.ownerKey), before);

  const right = run([`--owner=${ws.ownerKey}`, '--apply', '--sleep-ms=0'], { input: `${dbName}\n` });
  assert.equal(right.code, 0, right.out);
  assertOnlyExcerptsReplaced(ws, before, await snapshot(ws.ownerKey), { replacedIds: rawIds(ws) });
});

// ─── Journey scan round 4: the text alone is not evidence ────────────────────
//
// An entity a person titled "[WIP] Payments service", filed by upsert_entities
// from a second project, is stored as "[WIP] Payments Service: <summary>" — the
// opening of a raw transcript. The script judged by text alone, replaced it with
// a line claiming it was found in a tech stack, and reported that entity notes
// were left alone.

const versionsOf = async (ownerKey) => new Map((await q(
  'SELECT evidence_id, xmin::text AS v FROM context_graph_evidence WHERE owner_key = $1', [ownerKey],
)).rows.map((row) => [row.evidence_id, row.v]));

const ENTITY_NOTE_KEYS = ['entityNote', 'entityNoteWip', 'entityNoteUser', 'entityNoteAssistant', 'entityNoteX'];

test('entity notes whose text opens [WIP], [user], [assistant] or [x] are untouched by a dry run and an apply, byte for byte, and counted as entity notes', async () => {
  const ws = await seedWorkspace('Notes');
  const ids = ENTITY_NOTE_KEYS.map((key) => ws.untouched[key]);
  const before = await snapshot(ws.ownerKey);
  const versionsBefore = await versionsOf(ws.ownerKey);
  for (const id of ids.slice(1)) assert.match(before.get(id).excerpt, /^\[[^\]]{1,40}\] /, `premise: ${before.get(id).excerpt} has the transcript's opening`);

  const dry = run([`--owner=${ws.ownerKey}`]);
  assert.equal(dry.code, 0, dry.out);
  assert.deepEqual(await snapshot(ws.ownerKey), before, 'the dry run changed nothing');

  const apply = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(apply.code, 0, apply.out);
  const after = await snapshot(ws.ownerKey);
  const versionsAfter = await versionsOf(ws.ownerKey);
  for (const id of ids) {
    assert.deepEqual(after.get(id), before.get(id), `entity note ${before.get(id).excerpt} is byte for byte as it was`);
    assert.equal(versionsAfter.get(id), versionsBefore.get(id), 'and was not even rewritten');
  }
  assertOnlyExcerptsReplaced(ws, before, after, { replacedIds: rawIds(ws) });
  assert.match(dry.out, /entity notes from upsert_entities, whatever their text \(left alone\)\s+5\n/, 'the dry run counts all five as entity notes');
  assert.match(apply.out, /After:[\s\S]*entity notes from upsert_entities, whatever their text \(left alone\)\s+5\n/);
  assert.match(apply.out, /Not written by this run: 1 row\(s\) already marked when it began; and, counted now, 5 entity note\(s\), 2 other row\(s\) a person or the product wrote/);
});

test('a transcript-shaped row from a tool the script does not know is untouched, and counted under its own heading by tool', async () => {
  const ws = await seedWorkspace('Unknown');
  const id = ws.untouched.unknownTool;
  const before = await snapshot(ws.ownerKey);
  const versionsBefore = await versionsOf(ws.ownerKey);

  const dry = run([`--owner=${ws.ownerKey}`]);
  assert.equal(dry.code, 0, dry.out);

  const apply = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(apply.code, 0, apply.out);
  const after = await snapshot(ws.ownerKey);
  assert.deepEqual(after.get(id), before.get(id), 'the unknown tool\'s row is byte for byte as it was');
  assert.equal((await versionsOf(ws.ownerKey)).get(id), versionsBefore.get(id), 'and was not rewritten');
  // So are the other rows a person or the product wrote in the old shape.
  for (const key of ['resolveAnswer', 'dashboardNote', 'leadingSpace', 'longRole', 'fallback', 'newPath']) {
    assert.deepEqual(after.get(ws.untouched[key]), before.get(ws.untouched[key]), `${key} is untouched`);
  }
  assert.match(dry.out, /looks like a conversation excerpt, written by a tool this script does not know: left alone\s+1\n\s+by tool: a2a 1\n/);
  assert.match(apply.out, /After:[\s\S]*looks like a conversation excerpt, written by a tool this script does not know: left alone\s+1\n\s+by tool: a2a 1\n/);
});

test('a raw excerpt from each capture tool is replaced with the line an old row can truthfully carry', async () => {
  const ws = await seedWorkspace('Tools', { rawCount: CAPTURE_TOOLS.length });
  assert.deepEqual(ws.raw.map((row) => row.tool).sort(), [...CAPTURE_TOOLS].sort(), 'premise: one raw row per capture tool');
  const before = await snapshot(ws.ownerKey);
  const apply = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(apply.code, 0, apply.out);
  const after = await snapshot(ws.ownerKey);
  for (const { id, tool, nodeKey } of ws.raw) {
    assert.equal(after.get(id).excerpt_kind, 'derived', `the ${tool} row is marked`);
    assert.equal(after.get(id).excerpt, expectedLine(ws, nodeKey), `the ${tool} row carries the line`);
    assert.doesNotMatch(after.get(id).excerpt, /tech stack|file structure|recent decisions|current task/, 'and names no brief section it was never recorded in');
  }
  assertOnlyExcerptsReplaced(ws, before, after, { replacedIds: rawIds(ws) });
  assert.match(apply.out, new RegExp(`Done: replaced ${CAPTURE_TOOLS.length + 1} raw excerpt\\(s\\)`));
});

// What a direct query of the table says, class by class, for one workspace —
// written here from the runbook's table, not taken from the script.
async function directCounts(ownerKey) {
  const known = [...CAPTURE_TOOLS, 'manual_workspace_entity', 'manual', 'dashboard'];
  const rows = (await q(
    `SELECT tool,
            count(*)::int AS total,
            count(*) FILTER (WHERE excerpt_kind IS NOT NULL)::int AS derived,
            count(*) FILTER (WHERE excerpt_kind IS NULL AND excerpt ~ $2 AND tool = ANY($3::text[]))::int AS raw,
            count(*) FILTER (WHERE excerpt_kind IS NULL AND tool = 'manual_workspace_entity')::int AS entity_note,
            count(*) FILTER (WHERE excerpt_kind IS NULL AND tool IN ('manual', 'dashboard'))::int AS hand,
            count(*) FILTER (WHERE excerpt_kind IS NULL AND excerpt ~ $2 AND NOT (tool = ANY($4::text[])))::int AS raw_shape_unknown_tool,
            count(*) FILTER (WHERE excerpt_kind IS NULL AND NOT (excerpt ~ $2) AND tool = ANY($3::text[]))::int AS unclassified_known,
            count(*) FILTER (WHERE excerpt_kind IS NULL AND NOT (excerpt ~ $2) AND NOT (tool = ANY($4::text[])))::int AS unclassified_unknown
       FROM context_graph_evidence WHERE owner_key = $1 GROUP BY tool`,
    [ownerKey, RAW_SHAPE, CAPTURE_TOOLS, known],
  )).rows;
  const out = { total: 0 };
  const classes = ['derived', 'raw', 'entity_note', 'hand', 'raw_shape_unknown_tool', 'unclassified'];
  for (const cls of classes) out[cls] = { n: 0, byTool: {} };
  for (const row of rows) {
    out.total += row.total;
    const per = { ...row, unclassified: row.unclassified_known + row.unclassified_unknown };
    for (const cls of classes) {
      if (!per[cls]) continue;
      out[cls].n += per[cls];
      out[cls].byTool[row.tool] = per[cls];
    }
  }
  return out;
}

// The counts one census block of the script's output prints.
function printedCounts(out, label) {
  const start = out.indexOf(`\n${label}\n`);
  assert.ok(start >= 0, `the output has a "${label}" census`);
  const lines = [];
  for (const line of out.slice(start + label.length + 2).split('\n')) {
    if (!line.startsWith('  ') || /^\s+batch \d+:/.test(line)) break;
    lines.push(line);
  }
  const heading = {
    total: /^ {2}evidence rows\s+([\d,]+)$/,
    raw: /^ {2}raw conversation excerpts \([^)]+\)\s+([\d,]+)\s+held by ([\d,]+) workspace\(s\)$/,
    derived: /^ {2}derived lines \(marked: written by the new path, or replaced\)\s+([\d,]+)$/,
    entity_note: /^ {2}entity notes from upsert_entities, whatever their text \(left alone\)\s+([\d,]+)$/,
    hand: /^ {2}other rows a person or the product wrote \(left alone\)\s+([\d,]+)$/,
    raw_shape_unknown_tool: /^ {2}looks like a conversation excerpt, written by a tool this script does not know: left alone\s+([\d,]+)$/,
    unclassified: /^ {2}unclassified \(left alone; can hold brief text\)\s+([\d,]+)$/,
  };
  const num = (text) => Number(text.replace(/,/g, ''));
  const result = {};
  for (const [cls, re] of Object.entries(heading)) {
    const i = lines.findIndex((line) => re.test(line));
    assert.ok(i >= 0, `"${label}" prints the ${cls} line:\n${lines.join('\n')}`);
    const m = lines[i].match(re);
    if (cls === 'total') { result.total = num(m[1]); continue; }
    const byTool = {};
    const next = lines[i + 1] || '';
    if (next.startsWith('    by tool: ')) {
      for (const part of next.slice('    by tool: '.length).split(', ')) {
        const at = part.lastIndexOf(' ');
        byTool[part.slice(0, at)] = num(part.slice(at + 1));
      }
    }
    result[cls] = { n: num(m[1]), byTool };
    if (cls === 'raw') result.rawOwners = num(m[2]);
  }
  return result;
}

function assertPrintedIsTable(printed, direct, when) {
  assert.equal(printed.total, direct.total, `${when}: evidence rows`);
  for (const cls of ['derived', 'raw', 'entity_note', 'hand', 'raw_shape_unknown_tool', 'unclassified']) {
    assert.equal(printed[cls].n, direct[cls].n, `${when}: ${cls}`);
  }
  for (const cls of ['raw', 'entity_note', 'hand', 'raw_shape_unknown_tool', 'unclassified']) {
    assert.deepEqual(printed[cls].byTool, direct[cls].byTool, `${when}: ${cls} by tool`);
  }
  assert.equal(printed.rawOwners, direct.raw.n ? 1 : 0, `${when}: workspaces holding raw excerpts`);
}

test('every count the script prints is what a direct query of the table says, before and after, and the verification query then returns 0 beside the rows left alone', async () => {
  const ws = await seedWorkspace('Census', { rawCount: CAPTURE_TOOLS.length });
  const directBefore = await directCounts(ws.ownerKey);
  assert.ok(directBefore.raw.n > 0 && directBefore.entity_note.n > 0 && directBefore.raw_shape_unknown_tool.n > 0, 'premise: every class is present');

  const dry = run([`--owner=${ws.ownerKey}`]);
  assert.equal(dry.code, 0, dry.out);
  assertPrintedIsTable(printedCounts(dry.out, 'DRY RUN — nothing is changed.'), directBefore, 'dry run');

  const apply = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--batch=4', '--sleep-ms=0']);
  assert.equal(apply.code, 0, apply.out);
  assertPrintedIsTable(printedCounts(apply.out, 'Before:'), directBefore, 'before the apply');
  const directAfter = await directCounts(ws.ownerKey);
  assertPrintedIsTable(printedCounts(apply.out, 'After:'), directAfter, 'after the apply');
  assert.equal(directAfter.raw.n, 0, 'nothing raw is left');

  // The run's own report of what it did, against the table.
  const replacedNow = (await q(
    'SELECT count(*)::int AS n FROM context_graph_evidence WHERE owner_key = $1 AND excerpt_kind = $2', [ws.ownerKey, 'derived'],
  )).rows[0].n - directBefore.derived.n;
  assert.match(apply.out, new RegExp(`Done: replaced ${replacedNow} raw excerpt\\(s\\)`));
  assert.equal(replacedNow, directBefore.raw.n, 'it replaced exactly what it said it would');
  let batchTotal = 0;
  for (const m of apply.out.matchAll(/batch \d+: examined \d+, replaced (\d+)/g)) batchTotal += Number(m[1]);
  assert.equal(batchTotal, replacedNow, 'the batch lines add up to what was replaced');
  assert.match(apply.out, new RegExp(
    `Not written by this run: ${directBefore.derived.n} row\\(s\\) already marked when it began; and, counted now, `
    + `${directAfter.entity_note.n} entity note\\(s\\), ${directAfter.hand.n} other row\\(s\\) a person or the product wrote, `
    + `${directAfter.raw_shape_unknown_tool.n} conversation-shaped row\\(s\\) from a tool this script does not know, `
    + `${directAfter.unclassified.n} unclassified row\\(s\\)\\.`,
  ));

  // The verification query, as printed, run on a table that still holds
  // transcript-shaped rows the script rightly left.
  const verify = apply.out.match(/SELECT count\(\*\) AS raw_excerpts_left[^\n]*/)[0];
  const left = await q(`${verify.replace(/;$/, '')} AND owner_key = $1`, [ws.ownerKey]);
  assert.equal(Number(left.rows[0].raw_excerpts_left), 0);
  const shapedLeft = (await q(
    'SELECT count(*)::int AS n FROM context_graph_evidence WHERE owner_key = $1 AND excerpt_kind IS NULL AND excerpt ~ $2', [ws.ownerKey, RAW_SHAPE],
  )).rows[0].n;
  assert.equal(shapedLeft, 7, 'the four bracketed entity notes, the resolve answer, the dashboard row and the unknown tool\'s row are still there, in the shape');
});

// ─── Journey scan round 4: the old evidence vectors go with the old excerpts ──
//
// Each evidence row's vector (context_graph_embeddings, target_kind 'evidence',
// target_id = the row's id) was computed from its excerpt: for a raw row, from
// the raw conversation. The owner's decision: the script deletes the vector of
// each row it replaces, under the same safeguards, and never a vector whose row
// it did not replace, nor one the new write path computed from a derived line.

// The vector census block the script prints under a census label.
function printedVectors(out, label) {
  const start = out.indexOf(`\n${label}\n`);
  assert.ok(start >= 0, `the output has a "${label}" census`);
  const block = out.slice(start);
  const grab = (re) => {
    const m = block.match(re);
    assert.ok(m, `"${label}" prints ${re}:\n${block.slice(0, 3000)}`);
    return Number(m[1].replace(/,/g, ''));
  };
  return {
    total: grab(/\n {2}evidence vectors \(context_graph_embeddings, target_kind evidence\)\s+([\d,]+)\n/),
    raw: grab(/\n {4}of (?:the raw excerpts above|raw excerpts still to replace) \([^)]*\)\s+([\d,]+)\n/),
    replaced_earlier: grab(/\n {4}of rows an earlier run replaced, older than any new-path line \([^)]*\)\s+([\d,]+)\n/),
    replaced_unsure: grab(/\n {4}of rows an earlier run replaced, not older than every new-path line \(left: cannot tell\)\s+([\d,]+)\n/),
    derived: grab(/\n {4}of lines the new path wrote \(never deleted\)\s+([\d,]+)\n/),
    not_replaced: grab(/\n {4}of rows this script does not replace \(never deleted\)\s+([\d,]+)\n/),
    no_row: grab(/\n {4}with no evidence row \(left\)\s+([\d,]+)\n/),
  };
}

test('the vector of each raw row goes with its excerpt, in the same run; no other vector is touched, and every vector count is the table', async () => {
  const ws = await seedWorkspace('Vectors');
  const bystander = await seedWorkspace('VectorBystander');
  for (const id of ws.rows) await insertVector(ws.ownerKey, id);
  for (const id of bystander.rows) await insertVector(bystander.ownerKey, id);
  // A second model's vector of one raw row: computed from the same text.
  await insertVector(ws.ownerKey, ws.raw[0].id, { model: 'hash-embed-v1' });
  // A vector whose evidence row is gone, and a NODE vector that happens to
  // carry a raw row's id: neither is the vector of a row the script replaces.
  await insertVector(ws.ownerKey, `graph_evidence_${uuidv4()}`);
  await insertVector(ws.ownerKey, ws.raw[1].id, { kind: 'node' });

  const raw = rawIds(ws);
  const vectorsBefore = await vectorSnapshot(ws.ownerKey);
  const bystanderVectors = await vectorSnapshot(bystander.ownerKey);
  const evidenceBefore = await snapshot(ws.ownerKey);
  const rawVectorKeys = [...vectorsBefore.keys()].filter((key) => {
    const [kind, id] = key.split('|');
    return kind === 'evidence' && raw.has(id);
  });
  assert.equal(rawVectorKeys.length, raw.size + 1, 'premise: every raw row has a vector, one of them two');

  // The dry run counts them and deletes nothing.
  const dry = run([`--owner=${ws.ownerKey}`]);
  assert.equal(dry.code, 0, dry.out);
  assert.deepEqual(await vectorSnapshot(ws.ownerKey), vectorsBefore, 'the dry run deleted nothing');
  const direct = {
    total: ws.rows.length + 2,
    raw: raw.size + 1,
    replaced_earlier: 0,
    replaced_unsure: 0,
    derived: 1, // the new path's row
    not_replaced: ws.rows.length - raw.size - 1,
    no_row: 1,
  };
  assert.deepEqual(printedVectors(dry.out, 'DRY RUN — nothing is changed.'), direct);
  for (const marker of ws.markers) assert.ok(!dry.out.includes(marker), 'no excerpt is printed');

  const apply = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--batch=3', '--sleep-ms=0']);
  assert.equal(apply.code, 0, apply.out);
  assert.deepEqual(printedVectors(apply.out, 'Before:'), direct);
  assert.deepEqual(printedVectors(apply.out, 'After:'), { ...direct, total: direct.total - direct.raw, raw: 0 });
  assert.match(apply.out, new RegExp(`Deleted ${raw.size + 1} evidence vector\\(s\\): ${raw.size + 1} of the rows replaced in this run, 0 of rows an earlier run replaced\\.`));
  let perBatch = 0;
  for (const m of apply.out.matchAll(/deleted vectors: (\d+) of rows replaced, (\d+) of rows replaced earlier/g)) perBatch += Number(m[1]) + Number(m[2]);
  assert.equal(perBatch, raw.size + 1, 'the batch lines add up');

  const vectorsAfter = await vectorSnapshot(ws.ownerKey);
  for (const [key, row] of vectorsBefore) {
    if (rawVectorKeys.includes(key)) assert.ok(!vectorsAfter.has(key), `${key}: the raw row's vector is gone`);
    else assert.deepEqual(vectorsAfter.get(key), row, `${key}: untouched`);
  }
  assert.equal(vectorsAfter.size, vectorsBefore.size - rawVectorKeys.length, 'nothing else was deleted');
  assert.deepEqual(await vectorSnapshot(bystander.ownerKey), bystanderVectors, 'another workspace\'s vectors are untouched');
  assertOnlyExcerptsReplaced(ws, evidenceBefore, await snapshot(ws.ownerKey), { replacedIds: raw });

  const again = run([`--owner=${ws.ownerKey}`, '--apply', '--yes']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /Nothing was changed\./);
  assert.deepEqual(await vectorSnapshot(ws.ownerKey), vectorsAfter, 'a second run deletes nothing');
});

test('cut short, the rows replaced so far have lost their vectors and no other row has; the rerun finishes both', async () => {
  const ws = await seedWorkspace('VectorResume', { rawCount: 6 });
  for (const id of ws.rows) await insertVector(ws.ownerKey, id);
  const raw = rawIds(ws);
  // Deterministic window, as above: the one batch ends on the first raw row.
  const order = (await q('SELECT evidence_id FROM context_graph_evidence WHERE owner_key = $1 ORDER BY evidence_id', [ws.ownerKey])).rows.map((row) => row.evidence_id);
  const first = order.findIndex((id) => raw.has(id));
  assert.ok(first >= 0, 'premise: the workspace holds raw rows');

  const partial = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', `--batch=${first + 1}`, '--max-batches=1', '--sleep-ms=0']);
  assert.equal(partial.code, 0, partial.out);
  assert.match(partial.out, /batch 1: examined \d+, replaced 1 \(total replaced 1\); deleted vectors: 1 of rows replaced, 0 of rows replaced earlier/);
  assert.match(partial.out, new RegExp(`of raw excerpts still to replace \\(to delete with them\\)\\s+${raw.size - 1}\\n`));
  const mid = await vectorIds(ws.ownerKey);
  for (const id of ws.rows) assert.equal(mid.has(id), id !== order[first], `${id}: only the replaced row lost its vector`);

  const rest = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(rest.code, 0, rest.out);
  assert.match(rest.out, new RegExp(`Deleted ${raw.size - 1} evidence vector\\(s\\): ${raw.size - 1} of the rows replaced in this run, 0 of rows an earlier run replaced\\.`));
  const after = await vectorIds(ws.ownerKey);
  for (const id of ws.rows) assert.equal(after.has(id), !raw.has(id), `${id}: after the rerun`);
});

// Rows an earlier run replaced (the round 3 script left their vectors), as that
// run left them: marked, the line this script writes, the capture tool. Beside
// them, lines the NEW path wrote, one of whose project names makes its line end
// the way a replaced line does. The workspace's first new-path line is dated
// FIRST_NEW; each vector's age is set explicitly, so nothing here depends on
// the clock, on row ids, or on another workspace's rows.
const FIRST_NEW = '2026-09-20T12:00:00Z';

async function seedReplacedEarlier(label) {
  const ownerKey = `org-${uuidv4()}`;
  const projectId = `proj_${uuidv4()}`;
  const projectName = `${label} Harbor ${token().slice(0, 6)}`;
  await q(
    `INSERT INTO context_projects (project_id, owner_key, project_name, context, visibility)
     VALUES ($1, $2, $3, '{}'::jsonb, 'private')`,
    [projectId, ownerKey, projectName],
  );
  const insert = async ({ excerpt, tool = 'claude_code', createdAt, kind = 'derived' }) => {
    const id = `graph_evidence_${uuidv4()}`;
    await q(
      `INSERT INTO context_graph_evidence
         (evidence_id, owner_key, project_id, session_id, node_id, edge_id, tool, excerpt, metadata, confidence, created_at, excerpt_kind)
       VALUES ($1, $2, $3, 'sess', NULL, NULL, $4, $5, '{}'::jsonb, 0.8, $6, $7)`,
      [id, ownerKey, projectId, tool, excerpt, createdAt, kind],
    );
    return id;
  };
  const replacedLine = (title) => `Decision "${title}" recorded in ${projectName} from a captured conversation.`;
  const rows = {
    // Replaced by an earlier run; vector written when the row was (July): older
    // than any new-path line here, so it can only be the raw text's. DELETED.
    oldA: await insert({ excerpt: replacedLine('Cap retries'), createdAt: '2026-07-10T09:00:00Z' }),
    oldB: await insert({ excerpt: replacedLine('Drain the queue'), tool: 'cursor', createdAt: '2026-08-10T09:00:00Z' }),
    // Replaced by an earlier run, but its vector is NEWER than the first new-path
    // line: the script cannot tell what it was computed from. LEFT, counted.
    unsure: await insert({ excerpt: replacedLine('Late write'), createdAt: '2026-09-25T09:00:00Z' }),
    // The new path's first line here: FIRST_NEW. Its vector is its own. KEPT.
    firstNew: await insert({ excerpt: `Decision "Cap retries" recorded in ${projectName}'s recent decisions.`, createdAt: FIRST_NEW }),
    // A new-path line that ENDS like a replaced one (a project named so), with
    // its vector written with it, after FIRST_NEW. KEPT (counted as cannot tell).
    lookalike: await insert({ excerpt: 'Entity "Tides" recorded in Notes from a captured conversation.', createdAt: '2026-09-21T09:00:00Z' }),
    // A sighting (person's text, marked since round 3), tool not a capture tool,
    // ending the same way. KEPT.
    sighting: await insert({ excerpt: 'Tides: recorded in Notes from a captured conversation.', tool: 'manual_workspace_entity', createdAt: '2026-06-01T09:00:00Z' }),
  };
  await insertVector(ownerKey, rows.oldA, { updatedAt: '2026-07-10T09:00:03Z' });
  await insertVector(ownerKey, rows.oldB, { updatedAt: '2026-08-10T09:00:03Z' });
  await insertVector(ownerKey, rows.unsure, { updatedAt: '2026-09-25T09:00:03Z' });
  await insertVector(ownerKey, rows.firstNew, { updatedAt: '2026-09-20T12:00:03Z' });
  await insertVector(ownerKey, rows.lookalike, { updatedAt: '2026-09-21T09:00:03Z' });
  await insertVector(ownerKey, rows.sighting, { updatedAt: '2026-06-01T09:00:03Z' });
  return { ownerKey, rows };
}

test('rows an earlier run replaced: a vector older than every line the new path wrote goes; any other is left, and counted', async () => {
  const ws = await seedReplacedEarlier('Earlier');
  const evidenceBefore = await snapshot(ws.ownerKey);
  const vectorsBefore = await vectorSnapshot(ws.ownerKey);

  const dry = run([`--owner=${ws.ownerKey}`]);
  assert.equal(dry.code, 0, dry.out);
  const counted = { total: 6, raw: 0, replaced_earlier: 2, replaced_unsure: 2, derived: 2, not_replaced: 0, no_row: 0 };
  assert.deepEqual(printedVectors(dry.out, 'DRY RUN — nothing is changed.'), counted);
  assert.deepEqual(await vectorSnapshot(ws.ownerKey), vectorsBefore, 'the dry run deleted nothing');

  const apply = run([`--owner=${ws.ownerKey}`, '--apply', '--yes', '--sleep-ms=0']);
  assert.equal(apply.code, 0, apply.out);
  assert.match(apply.out, /Deleted 2 evidence vector\(s\): 0 of the rows replaced in this run, 2 of rows an earlier run replaced\./);
  assert.deepEqual(printedVectors(apply.out, 'After:'), { ...counted, total: 4, replaced_earlier: 0 });
  const left = await vectorIds(ws.ownerKey);
  assert.deepEqual(
    Object.fromEntries(Object.entries(ws.rows).map(([name, id]) => [name, left.has(id)])),
    { oldA: false, oldB: false, unsure: true, firstNew: true, lookalike: true, sighting: true },
  );
  const vectorsAfter = await vectorSnapshot(ws.ownerKey);
  for (const [key, row] of vectorsAfter) assert.deepEqual(row, vectorsBefore.get(key), `${key}: a vector left is untouched`);
  assert.deepEqual(await snapshot(ws.ownerKey), evidenceBefore, 'no evidence row was written: they were replaced before');

  const again = run([`--owner=${ws.ownerKey}`, '--apply', '--yes']);
  assert.equal(again.code, 0, again.out);
  assert.match(again.out, /No raw excerpts to replace, and no old vectors to delete\. Nothing was changed\./);
});
