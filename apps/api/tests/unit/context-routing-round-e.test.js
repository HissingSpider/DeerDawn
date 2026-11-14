/**
 * ROUTING, ROUND E: which project a read or a write lands in.
 *
 * Every test here reproduces a defect against the real service and a real
 * database, and failed before its fix. None of them read source text.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test --test-concurrency=1 tests/unit/context-routing-round-e.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORGS = new Set();

function newOrg() {
  const org = `org-${crypto.randomUUID()}`;
  ORGS.add(org);
  return org;
}

function person(org, label) {
  return { org_id: org, id: `user-routing-e-${label}-${RUN}-${crypto.randomBytes(2).toString('hex')}` };
}

test.after(async () => {
  for (const org of ORGS) {
    try {
      await db.query('DELETE FROM context_workspace_pointers WHERE owner_key = $1', [org], 'org-system');
      await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [org], 'org-system');
      await db.query('DELETE FROM context_events WHERE project_id IN (SELECT project_id FROM context_projects WHERE owner_key = $1)', [org], 'org-system');
      await db.query('DELETE FROM context_projects WHERE owner_key = $1', [org], 'org-system');
      await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [org], 'org-system');
    } catch (_) { /* best effort */ }
  }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

// ─── d. upsertSession: undefined leaves the binding, null removes it ─────────

test('d: a session write that does not mention project_id leaves the binding alone', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const project = await service.createProject(ana, { project_name: `Bound Work ${RUN}` });
  const sessionId = `sess-${crypto.randomUUID()}`;

  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: project.project_id });

  // The shape applyExtraction sends on every call that carries no project_id:
  // the KEY is present and its value is undefined.
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: undefined, cwd: '/work/here' });
  const kept = await store.getSession(org, sessionId);
  assert.equal(kept.project_id, project.project_id, 'an undefined project_id unbound the session');
  assert.equal(kept.cwd, '/work/here', 'and the rest of the write still applied');

  // The binding is what tier 4 of active-project resolution reads, so losing it
  // is not cosmetic: it is how this person's next hosted write finds its project.
  const binding = await store.getLatestSessionBinding(org, workspace.actorIdentities(ana));
  assert.equal(binding?.project_id, project.project_id);
});

test('d: an explicit null still unbinds', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const project = await service.createProject(ana, { project_name: `Unbind Me ${RUN}` });
  const sessionId = `sess-${crypto.randomUUID()}`;

  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: project.project_id });
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: null });
  const session = await store.getSession(org, sessionId);
  assert.equal(session.project_id, null, 'null is the caller saying "unbind", and it must still work');
});

function routedTo(project, delta) {
  return {
    match_decision: 'matched_existing',
    confidence: 0.95,
    project_candidate: { project_id: project.project_id, project_name: project.project_name, reason: 'overlap' },
    delta,
    should_create_project: false,
    needs_user_confirmation: false,
  };
}

test('d: an extraction from a bound session lands in the bound project, not in the guess', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const bound = await service.createProject(ana, { project_name: `Checkout Flow ${RUN}` });
  const guessed = await service.createProject(ana, { project_name: `Ledger Export ${RUN}` });
  const sessionId = `sess-${crypto.randomUUID()}`;
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: bound.project_id });

  const result = await service.applyExtraction(ana, {
    session_id: sessionId,
    tool: 'claude_code',
    chunks: [{ role: 'assistant', text: 'Moved the retry budget into the payment client.' }],
    extraction: routedTo(guessed, { current_status: 'Retry budget moved into the payment client.' }),
  });

  assert.equal(result.project.project_id, bound.project_id, 'the session binding was wiped, so the heuristic guess took the write');
  const other = await store.getProject(org, guessed.project_id);
  assert.notEqual(other.context.current_status, 'Retry budget moved into the payment client.');
});

test('d: a stale_match still moves the session to where the person now is, and writes nothing', async () => {
  // The one routed answer that outranks a binding. Before the binding survived,
  // this happened by accident; a tab that has moved to another topic's
  // conversation must not answer 'ambiguous' for the rest of its life.
  const org = newOrg();
  const ana = person(org, 'ana');
  const before = await service.createProject(ana, { project_name: `Trip Planning ${RUN}` });
  const now = await service.createProject(ana, { project_name: `Tax Return ${RUN}`, current_status: 'untouched' });
  const sessionId = `sess-${crypto.randomUUID()}`;
  await service.upsertSession(ana, sessionId, { tool: 'claude_web', project_id: before.project_id });

  await service.applyExtraction(ana, {
    session_id: sessionId,
    tool: 'claude_web',
    chunks: [{ role: 'user', text: 'Which receipts do I need for the home office deduction?' }],
    extraction: {
      match_decision: 'ambiguous', confidence: 0.5, delta: {}, should_create_project: false,
      needs_user_confirmation: true, no_material_change: true, routing_state: 'stale_match',
      project_candidate: { project_id: now.project_id, project_name: now.project_name, reason: 'stale_binding', score: 0.5 },
    },
  });
  assert.equal((await store.getSession(org, sessionId)).project_id, now.project_id);
  assert.equal((await store.getProject(org, now.project_id)).context.current_status, 'untouched');
});

test('d: a binding this person can no longer see does not strand the write', async () => {
  // A deleted project cannot be the case: the session FK nulls the binding. A
  // project that went PERSONAL under a colleague's session is the live one.
  const org = newOrg();
  const ana = person(org, 'ana');
  const ben = person(org, 'ben');
  await workspace.addMember(org, ana.id, { role: 'owner' });
  await workspace.addMember(org, ben.id, { role: 'member' });
  const hers = await service.createProject(ana, { project_name: `Was Shared ${RUN}` });
  const his = await service.createProject(ben, { project_name: `Bens Own ${RUN}` });
  const sessionId = `sess-${crypto.randomUUID()}`;
  await service.upsertSession(ben, sessionId, { tool: 'claude_code', project_id: hers.project_id });
  await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [hers.project_id, 'personal'], 'org-system');

  const result = await service.applyExtraction(ben, {
    session_id: sessionId,
    tool: 'claude_code',
    chunks: [{ role: 'assistant', text: 'Queue consumer now acks after the write.' }],
    extraction: routedTo(his, { current_status: 'Queue consumer acks after the write.' }),
  });
  assert.equal(result?.project?.project_id, his.project_id, 'a stale binding must fall through to the routed project');
});

// ─── c. normalizeName: `#` and `+` are significant, and so is every alphabet ─

test('c: C#, C++ and a plain name are three different projects', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const sharp = await service.createProject(ana, { project_name: 'Parser C#' });
  // Both of these were refused as duplicate_project_name: all three normalised
  // to "parserc".
  const plus = await service.createProject(ana, { project_name: 'Parser C++' });
  const plain = await service.createProject(ana, { project_name: 'Parser C' });
  assert.equal(new Set([sharp.project_id, plus.project_id, plain.project_id]).size, 3);

  for (const [ref, expected] of [['parser c#', sharp], ['PARSER-C++', plus], ['Parser C', plain]]) {
    const found = await service.findProjectCandidatesByName(ana, ref);
    assert.deepEqual(found.map((row) => row.project_id), [expected.project_id], `"${ref}" must resolve to exactly its own project`);
  }
  // Still a duplicate when it IS one.
  await assert.rejects(() => service.createProject(ana, { project_name: 'parser  c++' }), /duplicate_project_name/);
});

test('c: a name in a non-Latin script is a name', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const cjk = await service.createProject(ana, { project_name: '支付网关' });
  const cyrillic = await service.createProject(ana, { project_name: 'Платёжный шлюз' });

  // Both normalised to '', so neither could be found by name at all ...
  assert.deepEqual((await service.findProjectCandidatesByName(ana, '支付网关')).map((r) => r.project_id), [cjk.project_id]);
  assert.deepEqual((await service.findProjectCandidatesByName(ana, 'платёжный  ШЛЮЗ')).map((r) => r.project_id), [cyrillic.project_id]);
  assert.equal((await service.findProjectByName(ana, '支付网关'))?.project_id, cjk.project_id);
  // ... and the duplicate gate never fired for them.
  await assert.rejects(() => service.createProject(ana, { project_name: '支付网关' }), /duplicate_project_name/);
  // A different name in the same script is not the same project.
  assert.deepEqual(await service.findProjectCandidatesByName(ana, '订单服务'), []);
});

test('c: a reference that only the OLD rule matched still reaches its project', async () => {
  // Rows and habits predate the new rule. Under the old one "issue 42 board"
  // and "Roadmap C" found these; nobody's project may become unreachable because
  // the rule got stricter. The old rule is a FALLBACK tier: it answers only when
  // the new one finds nothing, so it can never outvote an exact match.
  const org = newOrg();
  const ana = person(org, 'ana');
  const sharp = await service.createProject(ana, { project_name: 'Roadmap C#' });
  const mixed = await service.createProject(ana, { project_name: 'Alpha 项目' });

  assert.deepEqual((await service.findProjectCandidatesByName(ana, 'roadmap c')).map((r) => r.project_id), [sharp.project_id]);
  assert.deepEqual((await service.findProjectCandidatesByName(ana, 'alpha')).map((r) => r.project_id), [mixed.project_id]);

  // Once a project really is called that, it wins outright, and the old rule is not consulted.
  const plain = await service.createProject(ana, { project_name: 'Roadmap C' });
  assert.deepEqual((await service.findProjectCandidatesByName(ana, 'roadmap c')).map((r) => r.project_id), [plain.project_id]);

  // The fallback is for spellings the old rule read IN FULL. Given a reference it
  // would have cut down to a fragment, it must not resolve the fragment.
  await service.createProject(ana, { project_name: 'Gateway' });
  assert.deepEqual(await service.findProjectCandidatesByName(ana, '支付 Gateway'), []);

  // Two old-rule matches and no exact one is ambiguous, which the caller refuses.
  await service.createProject(ana, { project_name: 'Notes C#' });
  await service.createProject(ana, { project_name: 'Notes C++' });
  assert.equal((await service.findProjectCandidatesByName(ana, 'notes c')).length, 2);
});

// ─── e. the subproject pin belongs to the person who set it ──────────────────

async function stampWorkspaceKey(projectId, key) {
  await db.query('UPDATE context_projects SET workspace_key = $2 WHERE project_id = $1', [projectId, key], 'org-system');
}

async function repoWithTwoStreams() {
  const org = newOrg();
  const ana = person(org, 'ana');
  const ben = person(org, 'ben');
  await workspace.addMember(org, ana.id, { role: 'owner' });
  await workspace.addMember(org, ben.id, { role: 'member' });
  const repo = `git:acme/app-${crypto.randomBytes(3).toString('hex')}`;
  const umbrella = await service.createProject(ana, { project_name: `Acme App ${RUN}${crypto.randomBytes(2).toString('hex')}` });
  const api = await service.createProject(ana, { project_name: `Acme API ${crypto.randomBytes(3).toString('hex')}`, parent_project_id: umbrella.project_id });
  const web = await service.createProject(ben, { project_name: `Acme Web ${crypto.randomBytes(3).toString('hex')}`, parent_project_id: umbrella.project_id });
  for (const p of [umbrella, api, web]) await stampWorkspaceKey(p.project_id, repo);
  return { org, ana, ben, repo, umbrella, api, web };
}

test('e: one teammate switching subproject does not move the other', async () => {
  const { ana, ben, repo, api, web } = await repoWithTwoStreams();
  await service.switchSubproject(ana, api.project_id, repo);
  await service.switchSubproject(ben, web.project_id, repo);

  const hers = await service.resolveActiveProject(ana, null, repo);
  assert.equal(hers?.project_id, api.project_id, 'Ben switching streams moved Ana onto his');
  assert.equal(hers.match_kind, 'pinned');
  const his = await service.resolveActiveProject(ben, null, repo);
  assert.equal(his?.project_id, web.project_id);
});

test('e: a member can pin a colleague\'s shared subproject for themselves, and nothing they cannot read', async () => {
  const { org, ana, ben, repo, api } = await repoWithTwoStreams();
  // api is Ana's. Ben is a member, neither its owner nor a workspace admin: the
  // old guard answered project_not_found.
  await service.switchSubproject(ben, api.project_id, repo);
  assert.equal((await service.resolveActiveProject(ben, null, repo))?.project_id, api.project_id);

  const secret = await service.createProject(ana, { project_name: `Ana Personal ${crypto.randomBytes(3).toString('hex')}` });
  const row = await store.getProject(org, secret.project_id);
  await store.saveProject({ ...row, visibility: 'personal', workspace_key: repo }, null);
  await assert.rejects(() => service.switchSubproject(ben, secret.project_id, repo), /project_not_found/);
});

test('e: a pin written before pins were per-person is still the workspace default', async () => {
  const { org, ana, ben, repo, api, web } = await repoWithTwoStreams();
  // Exactly the row the old code wrote: no user_id.
  await db.query(
    'INSERT INTO context_workspace_pointers (owner_key, workspace_key, active_project_id) VALUES ($1, $2, $3)',
    [org, repo, api.project_id],
    'org-system'
  );
  assert.equal((await service.resolveActiveProject(ana, null, repo))?.project_id, api.project_id);
  assert.equal((await service.resolveActiveProject(ben, null, repo))?.project_id, api.project_id, 'the existing pin stopped applying to a teammate');

  // Ben pinning for himself overrides the default for Ben only.
  await service.switchSubproject(ben, web.project_id, repo);
  assert.equal((await service.resolveActiveProject(ben, null, repo))?.project_id, web.project_id);
  assert.equal((await service.resolveActiveProject(ana, null, repo))?.project_id, api.project_id);
});

test('e: an actor with no person behind it still sets the workspace default', async () => {
  const { org, ana, repo, api } = await repoWithTwoStreams();
  await service.switchSubproject({ id: org, type: 'system' }, api.project_id, repo);
  const rows = await db.query('SELECT user_id FROM context_workspace_pointers WHERE owner_key = $1 AND workspace_key = $2', [org, repo], 'org-system');
  assert.deepEqual(rows.rows.map((r) => r.user_id), ['']);
  assert.equal((await service.resolveActiveProject(ana, null, repo))?.project_id, api.project_id);
});

// ─── f. a project is born knowing which repo it belongs to ───────────────────

test('f: a pin on a subproject created a moment ago is honoured', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const repo = `git:acme/fresh-${crypto.randomBytes(3).toString('hex')}`;
  const umbrella = await service.createProject(ana, { project_name: `Fresh Umbrella ${RUN}`, workspace_key: repo });
  assert.equal((await store.getProject(org, umbrella.project_id)).workspace_key, repo, 'the caller supplied a workspace_key and it was dropped');

  // No key passed: a subproject is a work-stream of its parent's codebase.
  const stream = await service.createProject(ana, { project_name: `Fresh Stream ${RUN}`, parent_project_id: umbrella.project_id });
  assert.equal((await store.getProject(org, stream.project_id)).workspace_key, repo, 'a subproject did not inherit its parent\'s workspace');

  // The pin only counts for a candidate in the SAME workspace, so with no key on
  // the new row the switch "succeeded" and the next session opened elsewhere.
  await service.switchSubproject(ana, stream.project_id, repo);
  const active = await service.resolveActiveProject(ana, null, repo);
  assert.equal(active?.project_id, stream.project_id);
  assert.equal(active.match_kind, 'pinned');
});

test('f: a caller-supplied key beats the parent\'s, and no key at all stays none', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const umbrella = await service.createProject(ana, { project_name: `Company ${RUN}`, workspace_key: 'git:acme/monorepo' });
  // An umbrella can group repos: the stream lives where its caller says it does.
  const elsewhere = await service.createProject(ana, {
    project_name: `Docs Site ${RUN}`, parent_project_id: umbrella.project_id, workspace_key: 'git:acme/docs',
  });
  assert.equal((await store.getProject(org, elsewhere.project_id)).workspace_key, 'git:acme/docs');
  // Hosted callers have no repo. Nothing is invented for them.
  const hosted = await service.createProject(ana, { project_name: `Trip Planning ${RUN}` });
  assert.equal((await store.getProject(org, hosted.project_id)).workspace_key || null, null);
});

// ─── g. archived projects (the wire half is in tests/integration) ────────────

test('g: a passive capture from a session bound to a since-archived project goes to the routed project, not into the archive', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const dormant = await service.createProject(ana, { project_name: `Dormant Stream ${RUN}` });
  const live = await service.createProject(ana, { project_name: `Live Stream ${RUN}` });
  const sessionId = `sess-${crypto.randomUUID()}`;
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: dormant.project_id });
  await service.archiveProject(ana, dormant.project_id);

  const result = await service.applyExtraction(ana, {
    session_id: sessionId,
    tool: 'claude_code',
    chunks: [{ role: 'assistant', text: 'Cache invalidation now keys on the tenant id.' }],
    extraction: routedTo(live, { current_status: 'Cache invalidation keys on the tenant id.' }),
  });
  assert.equal(result?.project?.project_id, live.project_id);
  const archivedRow = await store.getProject(org, dormant.project_id);
  assert.notEqual(archivedRow.context.current_status, 'Cache invalidation keys on the tenant id.', 'the write landed in the archive');

  // Naming the archived project is different: that is the caller's target, and
  // the answer is the refusal, never a write somewhere else.
  await assert.rejects(
    () => service.applyExtraction(ana, {
      session_id: `sess-${crypto.randomUUID()}`,
      tool: 'claude_code',
      project_id: dormant.project_id,
      chunks: [{ role: 'assistant', text: 'Rate limiter moved to the edge.' }],
      extraction: routedTo(dormant, { current_status: 'Rate limiter moved to the edge.' }),
    }),
    (err) => err.message === 'project_archived' && /restore/.test(err.publicMessage),
  );
});

// ─── h. the candidate LIMIT must not starve a person of their own projects ───

test('h: 200 newer colleague projects do not push a person\'s own out of resolution', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const ben = person(org, 'ben');
  await workspace.addMember(org, ana.id, { role: 'owner' });
  await workspace.addMember(org, ben.id, { role: 'member' });

  const hers = await service.createProject(ana, { project_name: `Anas Long Runner ${RUN}`, linked_paths: ['/work/ana/long-runner'], workspace_key: 'remote:github.com/ana/long-runner' });
  await db.query('UPDATE context_projects SET updated_at = NOW() - INTERVAL \'90 days\' WHERE project_id = $1', [hers.project_id], 'org-system');
  // A busy team: 205 shared projects, every one of them touched more recently.
  await db.query(
    `INSERT INTO context_projects (project_id, owner_key, owner_user_id, visibility, project_name, context, created_at, updated_at)
     SELECT 'project_bulk_' || $3 || '_' || n, $1, $2, 'shared', 'Bulk Team Stream ' || $3 || ' ' || n, '{}'::jsonb,
            NOW() - INTERVAL '30 days', NOW() - (n || ' minutes')::interval
       FROM generate_series(1, 205) AS n`,
    [org, ben.id, crypto.randomBytes(3).toString('hex')],
    'org-system'
  );

  // The visibility clause was inside the SQL, which is necessary and not
  // sufficient: 200 rows Ana MAY see are still 200 rows that are not hers.
  const candidates = await store.listProjectCandidates(org, {
    actorIdentities: workspace.actorIdentities(ana), isWorkspaceOwner: true,
  });
  assert.ok(candidates.some((c) => c.project_id === hers.project_id), 'her own project fell outside the LIMIT');
  for (let i = 1; i < candidates.length; i += 1) {
    assert.ok(candidates[i - 1].updated_at >= candidates[i].updated_at, 'callers rely on updated_at DESC');
  }
  assert.equal(new Set(candidates.map((c) => c.project_id)).size, candidates.length, 'no project is listed twice');

  // Hosted, no cwd: her own most recent project, not a colleague's shared one.
  const hostedActive = await service.resolveActiveProject(ana, null);
  assert.equal(hostedActive?.project_id, hers.project_id, 'she was routed into a colleague\'s project because hers was older than 200 of theirs');
  // Local, inside her linked path.
  const local = await service.resolveActiveProject(ana, '/work/ana/long-runner/src', 'remote:github.com/ana/long-runner');
  assert.equal(local?.project_id, hers.project_id);
  assert.equal(local.match_kind, 'path');

  // A colleague standing in that same shared project's directory: it is not
  // his, and it is older than 200 rows that are, but WHERE he is outranks both.
  const colleague = await service.resolveActiveProject(ben, '/work/ana/long-runner');
  assert.equal(colleague?.project_id, hers.project_id, 'a location match was hidden behind the recency window');
  assert.equal(colleague.match_kind, 'path');
  // And the prefilter is only a prefilter: a sibling directory is not a match.
  assert.equal(await service.resolveActiveProject(ben, '/work/ana/long-runner-v2'), null);
});

test('h: the full listing has no LIMIT to starve, and an unattributed solo user still resolves', async () => {
  const org = newOrg();
  const solo = person(org, 'solo');
  const only = await service.createProject(solo, { project_name: `Pre Attribution ${RUN}` });
  // A row from before per-user attribution existed.
  await db.query('UPDATE context_projects SET owner_user_id = NULL WHERE project_id = $1', [only.project_id], 'org-system');
  assert.equal((await service.resolveActiveProject(solo, null))?.project_id, only.project_id);
  const listed = await service.listProjects(solo);
  assert.ok(listed.some((p) => p.project_id === only.project_id));
});

// ─── a. a directory is linked to the project it belongs to, once ─────────────

async function explicitWrite(actor, project, cwd, text, extra = {}) {
  return service.applyExtraction(actor, {
    session_id: `sess-${crypto.randomUUID()}`,
    tool: 'claude_code',
    project_id: project.project_id,
    session_context: { cwd, ...extra },
    chunks: [{ role: 'assistant', text }],
    extraction: routedTo(project, { current_status: text }),
  });
}

test('a: naming project X from inside project Y\'s repo does not hand Y\'s directory to X', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const beta = await service.createProject(ana, { project_name: `Beta Service ${RUN}`, linked_paths: ['/work/beta'] });
  const alpha = await service.createProject(ana, { project_name: `Alpha Notes ${RUN}` });

  // She is in Beta's repo and jots something down for Alpha, by id.
  const written = await explicitWrite(ana, alpha, '/work/beta', 'Alpha will reuse the retry helper from Beta.');
  assert.equal(written.project.project_id, alpha.project_id, 'the explicit write itself still lands where it was sent');
  await explicitWrite(ana, alpha, '/work/beta/src/lib', 'Alpha needs the same backoff constants.');

  const alphaRow = await store.getProject(org, alpha.project_id);
  assert.deepEqual(alphaRow.linked_paths, [], `one explicit write linked another project's directory: ${JSON.stringify(alphaRow.linked_paths)}`);
  assert.equal(alphaRow.context.current_status, 'Alpha needs the same backoff constants.');

  // Which is what decides where the NEXT session in that directory opens. Alpha
  // was written to last, so a tie would have gone to it on recency.
  // (Neither side is a git repository, so the sub-directory belongs to Beta: the
  // folder rule. Standing in it opens Beta, and not Alpha.)
  const atRoot = await service.resolveActiveProject(ana, '/work/beta');
  assert.equal(atRoot?.project_id, beta.project_id, '/work/beta now opens the wrong project');
  assert.equal(atRoot.match_kind, 'path');
  const below = await service.resolveActiveProject(ana, '/work/beta/src/lib');
  assert.equal(below?.project_id, beta.project_id, '/work/beta/src/lib now opens the wrong project');
  assert.equal(below.match_kind, 'path');
});

test('a: a directory nobody claims is still linked by the first write from it', async () => {
  // The first-run flow: a project made in the dashboard, then the first save
  // from its repo. Refusing this link would leave it matching on name forever.
  const org = newOrg();
  const ana = person(org, 'ana');
  const fresh = await service.createProject(ana, { project_name: `Fresh Repo ${RUN}` });
  const freshKey = 'remote:github.com/ana/fresh-repo';
  await explicitWrite(ana, fresh, '/work/fresh-repo', 'Scaffolded the service.', { workspace_key: freshKey });
  assert.deepEqual((await store.getProject(org, fresh.project_id)).linked_paths, ['/work/fresh-repo']);
  // The first write also stamped the repository identity, which is what lets a
  // sub-directory of the linked one belong to it (the folder rule).
  const active = await service.resolveActiveProject(ana, '/work/fresh-repo/src', freshKey);
  assert.equal(active?.project_id, fresh.project_id);
  assert.equal(active.match_kind, 'path');

  // An ARCHIVED project's old claim does not hold a directory hostage.
  const retired = await service.createProject(ana, { project_name: `Retired ${RUN}`, linked_paths: ['/work/reused'] });
  await service.archiveProject(ana, retired.project_id);
  const successor = await service.createProject(ana, { project_name: `Successor ${RUN}` });
  await explicitWrite(ana, successor, '/work/reused', 'Started over in the same directory.');
  assert.deepEqual((await store.getProject(org, successor.project_id)).linked_paths, ['/work/reused']);
});

test('a: in a monorepo a work-stream claims its own package, never the umbrella\'s root', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const repo = `git:acme/mono-${crypto.randomBytes(3).toString('hex')}`;
  const umbrella = await service.createProject(ana, { project_name: `Mono Umbrella ${RUN}`, workspace_key: repo, linked_paths: ['/work/mono'] });
  const web = await service.createProject(ana, { project_name: `Mono Web ${RUN}`, parent_project_id: umbrella.project_id });
  // A second, unrelated project that happens to live in the same git root.
  const tools = await service.createProject(ana, { project_name: `Mono Tools ${RUN}`, workspace_key: repo });

  await explicitWrite(ana, web, '/work/mono/apps/web', 'Web stream: moved to the app router.');
  await explicitWrite(ana, tools, '/work/mono/tools', 'Tools: added the codegen script.');
  // The root is the umbrella's, exactly. A pinned stream written to from there
  // must not take it.
  await explicitWrite(ana, web, '/work/mono', 'Web stream: note taken from the repo root.');

  assert.deepEqual((await store.getProject(org, web.project_id)).linked_paths, ['/work/mono/apps/web']);
  assert.deepEqual((await store.getProject(org, tools.project_id)).linked_paths, ['/work/mono/tools']);
  assert.equal((await service.resolveActiveProject(ana, '/work/mono/apps/web/src'))?.project_id, web.project_id);
  assert.equal((await service.resolveActiveProject(ana, '/work/mono/tools'))?.project_id, tools.project_id);
  assert.equal((await service.resolveActiveProject(ana, '/work/mono'))?.project_id, umbrella.project_id);
});

test('a: a project resolved by WHERE the session is keeps learning its own sub-directories', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const project = await service.createProject(ana, { project_name: `Located ${RUN}`, linked_paths: ['/work/located'] });
  const sessionId = `sess-${crypto.randomUUID()}`;
  await service.upsertSession(ana, sessionId, { tool: 'claude_code', project_id: project.project_id, cwd: '/work/located/packages/core' });
  await service.applyExtraction(ana, {
    session_id: sessionId,
    tool: 'claude_code',
    session_context: { cwd: '/work/located/packages/core' },
    chunks: [{ role: 'assistant', text: 'Core package now exports the parser.' }],
    extraction: routedTo(project, { current_status: 'Core package exports the parser.' }),
  });
  assert.deepEqual(
    (await store.getProject(org, project.project_id)).linked_paths.sort(),
    ['/work/located', '/work/located/packages/core'],
  );
});

// ─── b. a name match answers reads, never writes ─────────────────────────────

test('b: a project that merely CONTAINS the directory name is shown as a guess and is not a write target', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  // Nothing links this project to any directory. Its name contains "api".
  const lookalike = await service.createProject(ana, { project_name: `Therapist notes ${RUN}` });

  const read = await service.resolveActiveProject(ana, '/Users/ana/code/api');
  assert.equal(read?.project_id, lookalike.project_id, 'a read may still be shown the guess');
  assert.equal(read.match_kind, 'name');
  assert.equal(read.match_confidence, 'low');
  assert.equal(read.write_target, false, 'a name match was offered as somewhere to write');

  const write = await service.resolveActiveProject(ana, '/Users/ana/code/api', null, { forWrite: true });
  assert.equal(write, null, 'a write target was resolved from a substring of a directory name');
});

test('b: a write skips the name match and still finds a real signal behind it', async () => {
  const org = newOrg();
  const ana = person(org, 'ana');
  const repo = `git:acme/api-${crypto.randomBytes(3).toString('hex')}`;
  // Scores lower than the lookalike on the name bonus alone would suggest
  // nothing; it carries the repo's workspace_key, which is a real signal.
  const real = await service.createProject(ana, { project_name: `Billing Backend ${RUN}`, workspace_key: repo });
  await service.createProject(ana, { project_name: `Rapid prototype ${RUN}` });

  const write = await service.resolveActiveProject(ana, '/Users/ana/code/api', repo, { forWrite: true });
  assert.equal(write?.project_id, real.project_id);
  assert.equal(write.match_kind, 'workspace');
  assert.equal(write.write_target, true);
  assert.equal(write.match_confidence, 'high');
});

test('b: with no location at all, a person\'s own project is still where their write goes', async () => {
  // Every hosted surface. There is no directory to have matched by name, and
  // "my own most recent project" is the only signal such a caller can have.
  const org = newOrg();
  const ana = person(org, 'ana');
  const only = await service.createProject(ana, { project_name: `Hosted Only ${RUN}` });
  const write = await service.resolveActiveProject(ana, null, null, { forWrite: true });
  assert.equal(write?.project_id, only.project_id);
  assert.equal(write.write_target, true);
  assert.equal(write.match_confidence, 'low', 'it is still a guess, and says so');

  // An internal actor with no person behind it resolves as it always did.
  const internal = await service.resolveActiveProject({ id: org, type: 'system' }, null, null, { forWrite: true });
  assert.equal(internal?.project_id, only.project_id);
});

test('b: passive capture is not routed into a project on a name and a few shared words', async () => {
  const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const extractionService = require('../../src/services/extractionService');
    const org = newOrg();
    const ana = person(org, 'ana');
    const lookalike = await service.createProject(ana, {
      project_name: 'Acme API', current_task: 'ship retry budget',
    });
    const input = {
      session_id: `sess-${crypto.randomUUID()}`,
      tool: 'claude_code',
      // A different repo that happens to be called `api`, on a machine called acme.
      session_context: { cwd: '/code/api', host: 'acme' },
      chunks: [{ role: 'assistant', text: 'ship retry budget' }],
    };
    const routed = await extractionService.runExtraction(ana, input);
    assert.notEqual(
      routed.project_candidate?.project_id,
      lookalike.project_id,
      'the capture was routed into a project it matched only by name, host and vocabulary',
    );

    // The same text from a session that is actually BOUND there still routes.
    await service.upsertSession(ana, input.session_id, { tool: 'claude_code', project_id: lookalike.project_id });
    const bound = await extractionService.runExtraction(ana, { ...input, chunks: [{ role: 'assistant', text: 'ship retry budget today' }] });
    assert.equal(bound.project_candidate?.project_id, lookalike.project_id);

    // And so does one standing inside a directory linked to it — but only INSIDE.
    const ledKey = 'remote:github.com/ana/led';
    const linked = await service.createProject(ana, { project_name: 'Ledger', current_task: 'close the books', linked_paths: ['/work/led'], workspace_key: ledKey });
    const inside = await extractionService.runExtraction(ana, {
      session_id: `sess-${crypto.randomUUID()}`, tool: 'claude_code',
      session_context: { cwd: '/work/led/src', workspace_key: ledKey },
      chunks: [{ role: 'assistant', text: 'close the books' }],
    });
    assert.equal(inside.project_candidate?.project_id, linked.project_id);
    const sibling = await extractionService.runExtraction(ana, {
      session_id: `sess-${crypto.randomUUID()}`, tool: 'claude_code',
      session_context: { cwd: '/work/ledger-v2', workspace_key: 'remote:github.com/ana/ledger-v2' },
      chunks: [{ role: 'assistant', text: 'close the books now' }],
    });
    assert.notEqual(sibling.project_candidate?.project_id, linked.project_id, '/work/ledger-v2 is not inside /work/led');

    // Topic convergence (no directory involved, so untouched by this) stays
    // pinned where it always was: tests/unit/topic-convergence.test.js.
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value !== undefined) process.env[key] = value;
  }
});

test('g: an entity first learned in a since-archived project is still updated by saves from live ones', async () => {
  // A graph node is unique per owner and keeps the FIRST project it was seen in.
  // The archive refusal must not reach it through that home project, or an
  // ordinary save into live work is dropped because of where "Redis" was learned.
  const org = newOrg();
  const ana = person(org, 'ana');
  const retired = await service.createProject(ana, { project_name: `Retired Home ${RUN}` });
  const live = await service.createProject(ana, { project_name: `Live Home ${RUN}` });
  const title = `Redis session store ${RUN}`;
  const entity = (projectId, summary) => ({
    entities: [{ title, entity_type: 'knowledge', summary, project_id: projectId }],
    relations: [],
  });
  await service.upsertWorkspaceEntities(ana, entity(retired.project_id, 'Sessions live in Redis with a thirty minute TTL.'));
  await service.archiveProject(ana, retired.project_id);

  const again = await service.upsertWorkspaceEntities(ana, entity(live.project_id, 'Sessions live in Redis; the TTL moved to sixty minutes.'));
  assert.equal((again.skipped || []).length, 0, JSON.stringify(again.skipped));
  assert.equal(again.entities.length, 1);

  // Filing something NEW under the archived project is the refused case.
  await assert.rejects(
    () => service.upsertWorkspaceEntities(ana, {
      entities: [{ title: `Brand new fact ${RUN}`, entity_type: 'knowledge', summary: 'Filed straight into an archived project.', project_id: retired.project_id }],
      relations: [],
    }),
    /project_archived/,
  );
});
