/**
 * SCAN 24 (a).
 *
 *   1. HIGH (round-23 regression): task bookkeeping was gated on its own
 *      unshared sections, so a teammate who may set and finish the task could
 *      never move task_progress or clear next_action. A new task after a finish
 *      stayed 'completed' (unprotected; missing from the return catch-up) and a
 *      teammate's own finish_task left the marker where it was. The
 *      server-derived task_progress / next_action now follow the task write.
 *   2. HIGH: nightly phase 5 hard-deleted any decision node sharing half its
 *      words with another in the project, across authors. Only a true
 *      duplicate (same decision, same author, same state, not pinned/curated)
 *      collapses now, and its evidence moves onto the survivor.
 *   3. MEDIUM: debug_log_full_pinned fired for any note the merge dropped — an
 *      unparseable added_at into an empty log, a backfilled note into a full
 *      log of unpinned notes. The note is validated first (400 naming the
 *      field), a date alone is midnight UTC, and a ranked-out note is its own
 *      409 (debug_log_ranked_out).
 *   4. LOW: POST /graph/nodes judged readability on caller metadata
 *      ({source:'structured_context_event', event_type}) the store then
 *      replaced with source:'manual'.
 *   5. LOW: a Trail imported into its own source project applied nothing and
 *      still wrote an "Imported Trail ..." decision that headed the brief.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan24-a-fixes.test.js
 */


process.env.NODE_ENV = 'test';
// This file makes well over 120 API calls a minute (the per-minute apiLimiter),
// and a 429 is not what any of it is testing.
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken, generateApiKey } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrg(label, plan) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = await makeOrg(label, plan);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

async function mintKey(person, orgId) {
  const { key, prefix, hash } = generateApiKey();
  await q(
    `INSERT INTO api_keys (key_id, prefix, key_hash, name, owner_id, org_id, environment, expires_at, scopes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [`key-${uuidv4()}`, prefix, hash, 'k', person.userId, orgId, 'production', new Date(Date.now() + 86400000).toISOString(), ['context:read', 'context:write']],
  );
  return key;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.equal(accepted.ok, true, `invite must be redeemable: ${accepted.reason}`);
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function mcpCall(key, ws, name, args) {
  const r = await request(httpServer).post('/mcp').set({ Accept: 'application/json, text/event-stream' })
    .set('Authorization', `Bearer ${key}`).set('x-deerdawn-workspace', ws)
    .send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  let body = r.body && Object.keys(r.body).length ? r.body : null;
  if (!body) {
    const line = String(r.text || '').split('\n').find((l) => l.startsWith('data: '));
    body = JSON.parse(line ? line.slice(6) : r.text);
  }
  const text = (body.result?.content || []).map((c) => c.text).join('\n') || body.error?.message || '';
  return { err: Boolean(body.result?.isError || body.error), text, raw: JSON.stringify(body) };
}

// Distinct words with no digits: debuggingNoteKey folds numbers, so "finding 1"
// and "finding 2" would be one note.
const word = (i) => {
  const a = 'abcdefghijklmnopqrstuvwxyz';
  return `${a[i % 26]}${a[Math.floor(i / 26) % 26]}q${a[(i * 7) % 26]}`;
};

// A team, a shared project, and the owner's lists pre-filled to the cap.
async function team({ sections = null, notes = 0, paths = 0, pinFirstPath = false, seed = null } = {}) {
  const tag = uuidv4().slice(0, 6);
  const O = await makePerson('owner', { plan: 'developer_pro' });
  const M = await makePerson('member');
  await join(O, M);
  const T = O.orgId;
  const created = await as('post', '/api/v1/context/projects', O, T).send({ project_name: `Ledger ${tag}` });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const P = created.body.project.project_id;
  const res = await as('patch', `/api/v1/teams/projects/${P}/sharing`, O, T)
    .send(sections ? { visibility: 'shared', sections } : { visibility: 'shared' });
  assert.equal(res.status, 200, `sharing: ${res.status} ${JSON.stringify(res.body)}`);
  const raw = await store.getProject(T, P);
  const Oactor = { id: O.userId, org_id: T, workspace_key: T, type: 'user', role: 'admin' };
  const base = Date.now() - 86400000;
  const context = {
    ...(raw.context || {}),
    project_name: raw.project_name,
    recent_decisions: [{ summary: 'Decided: ZQDEC we will lay off the payments team', decided_at: new Date().toISOString() }],
    debugging_notes: Array.from({ length: notes }, (_, i) => ({
      summary: `ZQOWNNOTE module ${word(i)} stalls when the ${word(i + 40)} queue drains`,
      paths: [],
      added_at: new Date(base + i * 60000).toISOString(),
      contributed_by: O.userId,
    })),
    hot_paths: Array.from({ length: paths }, (_, i) => ({
      label: `ZQOWNPATH ${word(i)}`,
      path: `src/owner/${word(i)}.js`,
      purpose: 'ZQOWNPURPOSE',
      ...(pinFirstPath && i === 0 ? { pinned: true } : {}),
    })),
  };
  if (seed) seed(context, { O, M });
  await store.saveProject({ ...raw, context, updated_at: new Date().toISOString() }, Oactor);
  const Mactor = { id: M.userId, org_id: M.orgId, workspace_key: T, type: 'user', role: 'admin' };
  return { O, M, T, P, Oactor, Mactor, stored: async () => (await store.getProject(T, P)).context };
}

const sessionCatchup = require('../../src/services/sessionCatchupService');

// ── 1: task bookkeeping goes with the task ──────────────────────────────────

const seedTaskState = (context) => {
  context.current_task = 'Harden the payout retry worker';
  context.current_task_source = 'explicit';
  context.current_task_set_at = new Date().toISOString();
  context.task_progress = 'in_progress';
  context.commands = [{ label: 'ZQCMD test', run: 'npm test -- payouts' }];
  context.open_questions = ['ZQQ Do retries need an idempotency key?'];
  context.blocking_issue = 'ZQBLK Waiting on the gateway sandbox credentials';
};

test('1a: a member setting a new task after the owner finished one resets the marker, so the task is protected and resumable', async () => {
  const { O, M, T, P, stored } = await team();
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  assert.equal((await mcpCall(okey, T, 'manage_memory', { action: 'update', project_id: P, task: 'Ship the invoice exporter' })).err, false);
  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcpCall(okey, T, 'manage_memory', { action: 'finish_task', project_id: P });
  const fin = await mcpCall(okey, T, 'manage_memory', { action: 'finish_task', project_id: P, complete_task: true, confirm_complete: true });
  assert.equal(fin.err, false, fin.text);
  assert.equal((await stored()).task_progress, 'completed');

  const set = await mcpCall(mkey, T, 'manage_memory', { action: 'update', project_id: P, task: 'Build the refunds webhook' });
  assert.equal(set.err, false, set.text);
  const c = await stored();
  assert.equal(c.current_task, 'Build the refunds webhook');
  assert.equal(c.task_progress, '', 'a new task is not a completed one, whoever set it');
  assert.equal(service.isExplicitTaskProtected(c), true, 'the member\'s explicit task is protected from extraction');
  const extraction = service.sanitizeExtraction({ context: c }, { confidence: 0.92, delta: { current_task: 'Polish the dashboard charts rendering' } });
  assert.equal(extraction.delta.current_task, undefined, 'an inferred task does not overwrite it');
  assert.ok(sessionCatchup.buildResumeHint(c), 'the return catch-up has something to resume');
});

test('1b: a member finishing their own task on a DEFAULT share marks it completed; the reply names only what was really left', async () => {
  const { M, T, P, stored } = await team({ seed: seedTaskState });
  const memberKey = await mintKey(M, T);
  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await mcpCall(memberKey, T, 'manage_memory', { action: 'finish_task', project_id: P });
  const out = await mcpCall(memberKey, T, 'manage_memory', { action: 'finish_task', project_id: P, complete_task: true, confirm_complete: true });
  assert.equal(out.err, false, out.text);
  assert.match(out.text, /Task remains recorded as completed: "Harden the payout retry worker"/);
  assert.match(out.text, /Left as they were \(not shared for editing with you\): [^\n]*command log/);
  assert.doesNotMatch(out.text, /task progress/, `the marker was written, so it is not "left": ${out.text}`);
  const c = await stored();
  assert.equal(c.current_status, 'Completed: Harden the payout retry worker');
  assert.equal(c.task_progress, 'completed');
  assert.equal(service.isExplicitTaskProtected(c), false, 'a finished task is released');
  // What the default share withholds is still the owner's, untouched.
  assert.equal(c.commands.length, 1);
  assert.deepEqual(c.open_questions, ['ZQQ Do retries need an idempotency key?']);
  assert.match(c.blocking_issue, /ZQBLK/);
});

test('1c: a member\'s new task clears the stale next_action; a next_action or progress the member WRITES stays refused', async () => {
  const { M, T, P, stored } = await team({ seed: (context) => { seedTaskState(context); context.task_progress = 'completed'; context.next_action = 'ZQNEXT wire the retry backoff'; } });
  const res = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ current_task: 'Draft the Q4 capacity plan' });
  assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 300));
  assert.equal(res.body.skipped_sections, undefined, 'nothing about the task was skipped');
  const c = await stored();
  assert.equal(c.current_task, 'Draft the Q4 capacity plan');
  assert.equal(c.task_progress, '');
  assert.equal(c.next_action, '', 'the previous task\'s next step does not outlive it');

  const writesNext = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ current_task: 'Another task', next_action: 'ZQMINE' });
  assert.equal(writesNext.status, 403, JSON.stringify(writesNext.body).slice(0, 300));
  const writesProgress = await as('patch', `/api/v1/context/projects/${P}/context`, M, T).send({ current_status: 'Completed', task_progress: 'completed' });
  assert.equal(writesProgress.status, 403, 'a caller-written marker is gated as before');
  // Under the completion opt-in, only the server's own two marker values ride
  // along with the task; any other value is the caller's and is skipped.
  const odd = await as('patch', `/api/v1/context/projects/${P}/context`, M, T)
    .send({ current_status: 'Halfway there', task_progress: 'half done', skip_unwritable_derived: true });
  assert.equal(odd.status, 200, JSON.stringify(odd.body).slice(0, 300));
  assert.deepEqual(odd.body.skipped_sections, ['task_progress']);
  assert.equal((await stored()).task_progress, '');
});

test('1d: a member\'s task_started and task_completed events move the marker with the task', async () => {
  const { M, T, P, stored } = await team({ seed: (context) => { seedTaskState(context); context.task_progress = 'completed'; } });
  const started = await as('post', '/api/v1/context/events', M, T).send({ event_type: 'task_started', project_id: P, summary: 'Wire the ledger reconciliation alerts' });
  assert.equal(started.status, 202, JSON.stringify(started.body).slice(0, 300));
  assert.equal(started.body.skipped_sections, undefined);
  let c = await stored();
  assert.equal(c.current_task, 'Wire the ledger reconciliation alerts');
  assert.equal(c.task_progress, 'in_progress');

  const done = await as('post', '/api/v1/context/events', M, T).send({ event_type: 'task_completed', project_id: P, summary: 'Wire the ledger reconciliation alerts' });
  assert.equal(done.status, 202, JSON.stringify(done.body).slice(0, 300));
  assert.deepEqual([...done.body.skipped_sections].sort(), ['commands', 'shipped']);
  c = await stored();
  assert.equal(c.task_progress, 'completed');
  assert.equal(c.commands.length, 1, 'the owner\'s command log is not the member\'s to clear');
});

// ── 2: nightly phase 5 collapses only a true duplicate ──────────────────────

const vault = require('../../src/jobs/vaultRemediationJob');
const decisionNodes = async (P) => (await q(
  `SELECT node_id, title, metadata->>'status' AS status FROM context_graph_nodes
   WHERE project_id = $1 AND node_type = 'decision' ORDER BY title`,
  [P],
)).rows;

test('2a: sibling decisions by two people survive the nightly run, and each stays resolvable by its own title', async () => {
  const { O, M, T, P } = await team();
  const okey = await mintKey(O, T);
  const mkey = await mintKey(M, T);
  for (const [key, summary] of [
    [okey, 'Decided to use Postgres 16 for the ledger storage layer.'],
    [mkey, 'Decided to use Postgres 16 for the audit log storage layer.'],
    [okey, 'Decided to deploy the API on Fly.io in the iad region.'],
    [mkey, 'Decided to deploy the worker on Fly.io in the iad region.'],
  ]) {
    const out = await mcpCall(key, T, 'manage_memory', { action: 'update', project_id: P, summary });
    assert.equal(out.err, false, out.text);
  }
  // Graph promotion can land after the reply; wait for all four nodes.
  const wanted = ['ledger storage', 'audit log storage', 'deploy the API', 'deploy the worker'];
  let before = [];
  for (let i = 0; i < 50; i += 1) {
    before = (await decisionNodes(P)).map((n) => n.title);
    if (wanted.every((w) => before.some((t) => t.includes(w)))) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(wanted.every((w) => before.some((t) => t.includes(w))), JSON.stringify(before));
  await vault.runVaultRemediation();
  const after = (await decisionNodes(P)).map((n) => n.title);
  assert.deepEqual(after, before, 'no sibling decision is deleted as a "duplicate"');
  const resolved = await mcpCall(okey, T, 'manage_memory', { action: 'resolve', project_id: P, title: 'Decided to use Postgres 16 for the ledger storage layer.' });
  assert.equal(resolved.err, false, resolved.text);
  assert.match(resolved.text, /Marked resolved/);
});

test('2b: a genuine duplicate collapses onto the earliest node and keeps its evidence; a re-opened, pinned or other-author copy stays', async () => {
  const S = await makePerson('dup', { plan: 'developer_pro' });
  const created = await as('post', '/api/v1/context/projects', S, S.orgId).send({ project_name: `Dup ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201);
  const P = created.body.project.project_id;
  const tag = uuidv4().slice(0, 6);
  const insert = async (suffix, title, metadata, ageMinutes) => {
    const id = `graph_node_zq${tag}_${suffix}`;
    await q(
      `INSERT INTO context_graph_nodes (node_id, owner_key, project_id, node_type, canonical_key, title, summary, metadata, confidence, source_session_id, source_tool, created_at, last_seen_at)
       VALUES ($1, $2, $3, 'decision', $4, $5, $5, $6::jsonb, 0.9, 'manual', 'codex', NOW() - ($7 || ' minutes')::interval, NOW() - ($7 || ' minutes')::interval)`,
      [id, S.orgId, P, `decision:zq-${tag}-${suffix}`, title, JSON.stringify({ status: 'active', ...metadata }), String(ageMinutes)],
    );
    return id;
  };
  const title = `Adopt Redis ${tag} as the session cache layer.`;
  const original = await insert('a', title, {}, 60);
  const copy = await insert('b', `adopt   redis ${tag} as the session cache layer`, { seen_count: 5 }, 30);
  const reopened = await insert('c', title, { status: 'resolved' }, 45);
  const pinned = await insert('d', `ADOPT REDIS ${tag} AS THE SESSION CACHE LAYER`, { pinned: true }, 20);
  const otherAuthor = await insert('e', title, { contributed_by: 'user-someone-else' }, 10);
  const sibling = await insert('f', `Adopt Redis ${tag} as the rate limiter store.`, {}, 5);
  await q(
    `INSERT INTO context_graph_evidence (evidence_id, owner_key, project_id, session_id, node_id, tool, excerpt)
     VALUES ($1, $2, $3, 'sess-zq', $4, 'codex', 'seen in the copy')`,
    [`ev-zq-${tag}`, S.orgId, P, copy],
  );

  await vault.runVaultRemediation();
  const ids = new Set((await decisionNodes(P)).map((n) => n.node_id));
  assert.ok(ids.has(original), 'the earliest node is the survivor');
  assert.ok(!ids.has(copy), 'the same decision by the same author, differing only in case and spacing, collapses');
  for (const [id, why] of [[reopened, 'a resolved twin of an active decision is a re-opened decision'], [pinned, 'a pinned node is never collapsed'], [otherAuthor, 'another author\'s decision is theirs'], [sibling, 'a sibling decision is not a duplicate']]) {
    assert.ok(ids.has(id), why);
  }
  const evidence = (await q('SELECT node_id FROM context_graph_evidence WHERE evidence_id = $1', [`ev-zq-${tag}`])).rows[0];
  assert.equal(evidence?.node_id, original, 'the collapsed node\'s evidence moves onto the survivor');
});

// ── 3: a finding the log cannot take says why ───────────────────────────────

async function soloProject(label) {
  const S = await makePerson(label, { plan: 'developer_pro' });
  const created = await as('post', '/api/v1/context/projects', S, S.orgId).send({ project_name: `${label} ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201);
  const P = created.body.project.project_id;
  return { S, P, stored: async () => (await store.getProject(S.orgId, P)).context };
}

test('3a: a date-only added_at is midnight UTC on every door; an unreadable one is a 400 naming added_at, not a "full log"', async () => {
  const { S, P, stored } = await soloProject('find');
  const key = await mintKey(S, S.orgId);
  const hosted = await mcpCall(key, S.orgId, 'manage_memory', { action: 'record_finding', project_id: P, summary: 'Ledger rounding drifts when the FX cache is cold', added_at: '2026-09-23' });
  assert.equal(hosted.err, false, hosted.text);
  assert.match(hosted.text, /Recorded debugging finding/);
  const note = (await stored()).debugging_notes.find((d) => /FX cache/.test(d.summary));
  assert.equal(note?.added_at, '2026-09-23T00:00:00.000Z');

  const rest = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId).send({ summary: 'Payout batch skips the last page of results', added_at: '2026-09-20' });
  assert.equal(rest.status, 200, JSON.stringify(rest.body).slice(0, 300));

  const ev = await as('post', '/api/v1/context/events', S, S.orgId).send({ event_type: 'debug_finding', project_id: P, summary: 'Worker heartbeat stops after the queue drains', metadata: { added_at: 'yesterday' } });
  assert.equal(ev.status, 400, JSON.stringify(ev.body).slice(0, 300));
  assert.equal(ev.body.error, 'invalid_debug_finding');
  assert.match(ev.body.message, /added_at/);
  const bad = await as('post', `/api/v1/context/projects/${P}/debug-findings`, S, S.orgId).send({ summary: 'Another finding about the queue', added_at: 'yesterday' });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'invalid_debug_finding');
  const badHosted = await mcpCall(key, S.orgId, 'manage_memory', { action: 'record_finding', project_id: P, summary: 'Cron double-fires on DST change', added_at: 'last tuesday' });
  assert.equal(badHosted.err, true);
  assert.match(badHosted.text, /added_at/);
  assert.doesNotMatch(badHosted.text, /pinned|full/);
  assert.equal((await stored()).debugging_notes.length, 2, 'nothing unreadable was stored');
});

test('3b: a note ranked out of a full log of UNPINNED notes is debug_log_ranked_out; a log of pins is still debug_log_full_pinned', async () => {
  const { O, T, P } = await team({ notes: 30 });
  const fresh = await as('post', `/api/v1/context/projects/${P}/debug-findings`, O, T).send({ summary: 'owner real finding about ledger rounding drift' });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body).slice(0, 300));
  const backfilled = await as('post', `/api/v1/context/projects/${P}/debug-findings`, O, T).send({ summary: 'backfilled finding from last spring about the ledger', added_at: '2025-03-01T00:00:00.000Z' });
  assert.equal(backfilled.status, 409, JSON.stringify(backfilled.body).slice(0, 300));
  assert.equal(backfilled.body.error, 'debug_log_ranked_out');
  assert.doesNotMatch(backfilled.body.message, /pinned\)/);
  const low = await as('post', `/api/v1/context/projects/${P}/debug-findings`, O, T).send({ summary: 'minor cosmetic warning in the ledger export', importance: 'low' });
  assert.equal(low.status, 409, JSON.stringify(low.body).slice(0, 300));
  assert.equal(low.body.error, 'debug_log_ranked_out');

  const pins = await team({ notes: 30, seed: (context) => { for (const note of context.debugging_notes) note.pinned = true; } });
  const intoPins = await as('post', `/api/v1/context/projects/${pins.P}/debug-findings`, pins.O, pins.T).send({ summary: 'owner finding into a log of pins' });
  assert.equal(intoPins.status, 409, JSON.stringify(intoPins.body).slice(0, 300));
  assert.equal(intoPins.body.error, 'debug_log_full_pinned');
});

// ── 4: a node's event provenance is the server's ────────────────────────────

test('4: a caller cannot file a node under an event\'s section by claiming the event, on POST /graph/nodes or /workspace/entities', async () => {
  const g = await team({ sections: [
    ...['current_task', 'current_status', 'recent_decisions', 'todo_items'].map((s) => ({ section_key: s, can_view: true, can_edit: true })),
    { section_key: 'file_structure_summary', can_view: true, can_edit: true },
  ] });
  const claim = { source: 'structured_context_event', event_type: 'file_changed' };
  const plain = await as('post', '/api/v1/context/graph/nodes', g.M, g.T).send({ project_id: g.P, node_type: 'service', title: `ZQSVC plain ${uuidv4().slice(0, 4)}` });
  assert.equal(plain.status, 403, JSON.stringify(plain.body).slice(0, 200));
  const laundered = await as('post', '/api/v1/context/graph/nodes', g.M, g.T).send({ project_id: g.P, node_type: 'service', title: `ZQSVC laundered ${uuidv4().slice(0, 4)}`, metadata: claim });
  assert.equal(laundered.status, 403, `judged as what is stored, a plain service: ${JSON.stringify(laundered.body).slice(0, 200)}`);

  const viaEntities = await as('post', '/api/v1/context/workspace/entities', g.M, g.T).send({
    entities: [{ entity_type: 'service', title: `ZQSVC entity ${uuidv4().slice(0, 4)}`, summary: 'Ledger reconciliation worker service', scope: 'project', project_id: g.P, metadata: claim }],
  });
  assert.equal(viaEntities.status, 403, JSON.stringify(viaEntities.body).slice(0, 200));
  const stored = await q('SELECT metadata FROM context_graph_nodes WHERE project_id = $1 AND metadata->>\'event_type\' = \'file_changed\'', [g.P]);
  assert.equal(stored.rows.length, 0, 'no caller-claimed event node was stored');

  // The owner may still write a service node; the claimed provenance is dropped.
  const own = await as('post', '/api/v1/context/graph/nodes', g.O, g.T).send({ project_id: g.P, node_type: 'service', title: `ZQSVC owner ${uuidv4().slice(0, 4)}`, metadata: { ...claim, note: 'kept' } });
  assert.equal(own.status, 201, JSON.stringify(own.body).slice(0, 200));
  const row = (await q('SELECT metadata FROM context_graph_nodes WHERE node_id = $1', [own.body.node.node_id])).rows[0];
  assert.equal(row.metadata.source, 'manual');
  assert.equal(row.metadata.event_type, undefined);
  assert.equal(row.metadata.note, 'kept');
});

// ── 5: no provenance line for a Trail that brought nothing ──────────────────

test('5: a Trail imported into its own source project writes no "Imported Trail" decision; into a new project it still does', async () => {
  const S = await makePerson('trail', { plan: 'developer_pro' });
  const key = await mintKey(S, S.orgId);
  const created = await as('post', '/api/v1/context/projects', S, S.orgId).send({ project_name: `Trail Src ${uuidv4().slice(0, 6)}` });
  assert.equal(created.status, 201);
  const P = created.body.project.project_id;
  assert.equal((await mcpCall(key, S.orgId, 'manage_memory', { action: 'update', project_id: P, summary: 'Decided to use Postgres for the ledger storage.', task: 'Ship ledger' })).err, false);
  assert.equal((await mcpCall(key, S.orgId, 'manage_memory', { action: 'record_finding', project_id: P, summary: 'Ledger rounding drifts on currency conversion' })).err, false);
  const trail = await as('get', `/api/v1/context/projects/${P}/trail`, S, S.orgId);
  assert.equal(trail.status, 200, JSON.stringify(trail.body).slice(0, 200));

  const self = await as('post', '/api/v1/context/trail/import', S, S.orgId).send({ trail: trail.body, project_id: P });
  assert.equal(self.status, 200, JSON.stringify(self.body).slice(0, 300));
  assert.equal(self.body.plan.applied.decisions, 0);
  const decisions = (await store.getProject(S.orgId, P)).context.recent_decisions || [];
  assert.ok(!decisions.some((d) => /^Imported Trail/.test(d.summary)), `nothing was applied, so nothing is attributed: ${JSON.stringify(decisions.map((d) => d.summary))}`);
  const brief = await mcpCall(key, S.orgId, 'start_session', { project_id: P });
  assert.doesNotMatch(brief.text, /Imported Trail/);

  const copy = await as('post', '/api/v1/context/trail/import', S, S.orgId).send({ trail: trail.body, new_project_name: `Trail Copy ${uuidv4().slice(0, 6)}` });
  assert.equal(copy.status, 200, JSON.stringify(copy.body).slice(0, 300));
  const copied = (await store.getProject(S.orgId, copy.body.project_id)).context.recent_decisions || [];
  assert.ok(copied.some((d) => /^Imported Trail/.test(d.summary)), 'a project that received the Trail says where it came from');
});
