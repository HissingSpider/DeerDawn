/**
 * Write authority in a shared workspace.
 *
 * Every write here used to either skip the role check (a VIEWER could create and
 * rename projects and resolve questions) or skip the visibility check (writes
 * loaded the raw row by id and only guarded a SHARED project, so a teammate could
 * write a colleague's personal project and a workspace owner could rewrite a
 * private one they may only read). Assertions read the RAW stored row, because a
 * refused write that still persisted is exactly the failure being pinned.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/context-write-authority.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

// A workspace of its own, so this suite never touches the shared 'org-system'
// sentinel or needs clearAll() on a database other suites are using.
const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-authz-alice-${RUN}`; // workspace owner
const BOB = `user-authz-bob-${RUN}`;     // member
const CAROL = `user-authz-carol-${RUN}`; // viewer

const actor = (id) => ({ org_id: ORG, id });
const alice = () => actor(ALICE);
const bob = () => actor(BOB);
const carol = () => actor(CAROL);
const raw = (projectId) => store.getProject(ORG, projectId);
const forbidden = (err) => err.code === 'share_write_forbidden' && err.status === 403;
const notFound = (err) => err.message === 'project_not_found';

async function setVisibility(projectId, visibility) {
  const row = await raw(projectId);
  await store.saveProject({ ...row, visibility }, null);
}

test.before(async () => {
  await workspace.addMember(ORG, ALICE, { role: 'owner' });
  await workspace.addMember(ORG, BOB, { role: 'member' });
  await workspace.addMember(ORG, CAROL, { role: 'viewer' });
});

test.after(async () => {
  try {
    await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system');
    await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system');
  } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

test('a viewer cannot create a project in the workspace', async () => {
  const name = `ViewerCreate ${RUN}`;
  await assert.rejects(service.createProject(carol(), { project_name: name }), forbidden);
  // system:true — this is a raw-row assertion about the whole workspace, not a
  // user-facing listing. listProjectIdentifiers is visibility-filtered now and
  // fails closed on an unattributed read, which is the point: a scoped listing
  // here could not prove "nothing was created".
  const listed = await store.listProjectIdentifiers(ORG, { system: true });
  assert.ok(!listed.some((p) => p.project_name === name), 'nothing was created');
});

test('a viewer cannot rename a shared project', async () => {
  const project = await service.createProject(alice(), { project_name: `SharedRename ${RUN}` });
  assert.equal((await raw(project.project_id)).visibility, 'shared');
  // The viewer can read it...
  assert.ok(await service.getProject(carol(), project.project_id));
  // ...and cannot rename it.
  await assert.rejects(service.renameProject(carol(), project.project_id, 'Viewer Renamed'), forbidden);
  assert.equal((await raw(project.project_id)).project_name, `SharedRename ${RUN}`);
  // Journey r6 (owner's decision): a member with edit rights is not the author and
  // not an owner, so may not rename it either. The author, and an owner, may.
  await assert.rejects(service.renameProject(bob(), project.project_id, `SharedRename by Bob ${RUN}`), forbidden);
  assert.equal((await raw(project.project_id)).project_name, `SharedRename ${RUN}`);
  await service.renameProject(alice(), project.project_id, `SharedRename by Alice ${RUN}`);
  assert.equal((await raw(project.project_id)).project_name, `SharedRename by Alice ${RUN}`);
});

test('a viewer cannot resolve a question or write the context', async () => {
  const project = await service.createProject(alice(), {
    project_name: `ViewerQuestion ${RUN}`,
    open_questions: ['Which queue do we use?'],
  });
  await assert.rejects(
    service.resolveQuestion(carol(), project.project_id, 'Which queue do we use?', 'SQS'),
    forbidden
  );
  await assert.rejects(
    service.updateProjectContext(carol(), project.project_id, { current_status: 'viewer wrote this' }),
    forbidden
  );
  const row = await raw(project.project_id);
  assert.deepEqual(row.context.open_questions, ['Which queue do we use?'], 'question still open');
  assert.notEqual(row.context.current_status, 'viewer wrote this');
});

test('a viewer cannot write an unattributed project by counting as its owner', async () => {
  // isProjectOwner treats owner_user_id NULL as "yours", which waved a viewer
  // through every per-section check.
  const project = await service.createProject(alice(), { project_name: `Unattributed ${RUN}` });
  const row = await raw(project.project_id);
  await store.saveProject({ ...row, owner_user_id: null }, null);
  await assert.rejects(
    service.updateProjectContext(carol(), project.project_id, { current_status: 'viewer wrote this' }),
    forbidden
  );
  await assert.rejects(
    service.recordHotPaths(carol(), project.project_id, [{ label: 'x', path: 'viewer.js' }]),
    forbidden
  );
  assert.notEqual((await raw(project.project_id)).context.current_status, 'viewer wrote this');
});

test('a member cannot write another person\'s personal project', async () => {
  const project = await service.createProject(alice(), {
    project_name: `AlicePersonal ${RUN}`,
    current_status: 'alice status',
    open_questions: ['Alice only question?'],
  });
  await setVisibility(project.project_id, 'personal');

  await assert.rejects(
    service.updateProjectContext(bob(), project.project_id, { current_status: 'bob wrote this' }),
    notFound
  );
  await assert.rejects(
    service.resolveQuestion(bob(), project.project_id, 'Alice only question?', 'bob answer'),
    notFound
  );
  await assert.rejects(service.renameProject(bob(), project.project_id, 'Bob renamed'), notFound);

  const row = await raw(project.project_id);
  assert.equal(row.context.current_status, 'alice status');
  assert.deepEqual(row.context.open_questions, ['Alice only question?']);
  assert.equal(row.project_name, `AlicePersonal ${RUN}`);
});

test('a workspace owner can read a private project but not write it', async () => {
  const project = await service.createProject(bob(), {
    project_name: `BobPrivate ${RUN}`,
    current_status: 'bob status',
    open_questions: ['Bob question?'],
  });
  await setVisibility(project.project_id, 'private');

  const seen = await service.getProject(alice(), project.project_id);
  assert.ok(seen, 'the owner reads org-owned private work');

  await assert.rejects(
    service.updateProjectContext(alice(), project.project_id, { current_status: 'alice overwrote this' }),
    forbidden
  );
  await assert.rejects(
    service.resolveQuestion(alice(), project.project_id, 'Bob question?', 'alice answer'),
    forbidden
  );
  await assert.rejects(service.renameProject(alice(), project.project_id, 'Alice renamed'), forbidden);

  const row = await raw(project.project_id);
  assert.equal(row.context.current_status, 'bob status');
  assert.deepEqual(row.context.open_questions, ['Bob question?']);
  assert.equal(row.project_name, `BobPrivate ${RUN}`);

  // Its author is unaffected.
  await service.updateProjectContext(bob(), project.project_id, { current_status: 'bob updated' });
  assert.equal((await raw(project.project_id)).context.current_status, 'bob updated');
});

test('getProjectMap on a project the caller cannot see is not_found and writes nothing', async () => {
  const project = await service.createProject(alice(), { project_name: `MapPersonal ${RUN}` });
  await setVisibility(project.project_id, 'personal');
  // Leave the row needing an integrity repair, which the map used to persist.
  const before = await raw(project.project_id);
  const { goals: _goals, ...withoutGoals } = before.context;
  await store.saveProject({ ...before, context: withoutGoals }, null);
  const damaged = await raw(project.project_id);
  assert.equal(damaged.context.goals, undefined, 'precondition: the row needs a repair');

  const map = await service.getProjectMap(bob(), project.project_id);
  assert.equal(map, null, 'invisible looks exactly like absent');

  const after = await raw(project.project_id);
  assert.equal(after.context.goals, undefined, 'no repair was persisted');
  assert.equal(after.updated_at, damaged.updated_at, 'the row was not written');

  // Its author still gets the map.
  assert.ok(await service.getProjectMap(alice(), project.project_id));
});

// A per-project grant is the whole point of context_project_members: an owner
// hands one viewer write on one shared project. The workspace-role gate ran
// first and refused them before any per-project check was consulted, so the
// override column governed nothing a viewer could reach.
test('a per-project role_override grants a viewer write on THAT project only', async () => {
  const granted = await service.createProject(alice(), { project_name: `OverrideGranted ${RUN}` });
  const other = await service.createProject(alice(), { project_name: `OverrideAbsent ${RUN}` });
  await store.upsertProjectShare(granted.project_id, {
    org_id: ORG,
    enabled: true,
    updated_by: ALICE,
    created_by: ALICE,
    sections: [],
    members: [{ user_id: CAROL, role_override: 'member' }],
  });

  await service.updateProjectContext(carol(), granted.project_id, { current_status: 'carol wrote this' });
  assert.equal((await raw(granted.project_id)).context.current_status, 'carol wrote this');
  // The grant is a grant of WRITE (the content above). Renaming is the author's or
  // an owner's alone (journey r6), so it does not carry.
  await assert.rejects(service.renameProject(carol(), granted.project_id, `OverrideGranted by Carol ${RUN}`), forbidden);
  assert.equal((await raw(granted.project_id)).project_name, `OverrideGranted ${RUN}`);

  // The grant does not travel to the rest of the workspace.
  await assert.rejects(
    service.updateProjectContext(carol(), other.project_id, { current_status: 'carol wrote this too' }),
    forbidden
  );
  await assert.rejects(service.createProject(carol(), { project_name: `CarolCreate ${RUN}` }), forbidden);
});

// Nearly all MCP traffic is key-authed, where actor.id is the KEY id and the
// person is actor.owner_id. Matching the override row on actor.id alone meant
// the grant worked from the dashboard and not from the tool it was granted for.
test('a per-project override is matched by PERSON, not by credential', async () => {
  const project = await service.createProject(alice(), { project_name: `OverrideByKey ${RUN}` });
  await store.upsertProjectShare(project.project_id, {
    org_id: ORG,
    enabled: true,
    updated_by: ALICE,
    created_by: ALICE,
    sections: [],
    members: [{ user_id: CAROL, role_override: 'member' }],
  });
  const carolsKey = { type: 'key', id: `key-carol-${RUN}`, owner_id: CAROL, org_id: ORG };

  await service.updateProjectContext(carolsKey, project.project_id, { current_status: 'carol via MCP' });
  assert.equal((await raw(project.project_id)).context.current_status, 'carol via MCP');
});

// An override is a grant, not a demotion of the workspace gate: a viewer
// override on a shared project still leaves a member able to append what the
// per-section policy allows, and never widens a project nobody may write.
test('a viewer override does not grant write on a personal project', async () => {
  const project = await service.createProject(alice(), { project_name: `OverridePersonal ${RUN}` });
  await store.upsertProjectShare(project.project_id, {
    org_id: ORG,
    enabled: true,
    updated_by: ALICE,
    created_by: ALICE,
    sections: [],
    members: [{ user_id: CAROL, role_override: 'owner' }],
  });
  await setVisibility(project.project_id, 'personal');
  await assert.rejects(
    service.updateProjectContext(carol(), project.project_id, { current_status: 'carol wrote this' }),
    notFound
  );
});

// EXTRACTION IS A WRITE PATH TOO, and it was the only one that could not see a
// per-project grant. It asserted the bare WORKSPACE role before the project was
// loaded — so the override, which lives on the project, had not been read yet —
// and refused a viewer outright. The same person could save through the
// dashboard and silently lose everything their session extracted.
const extractionInput = (projectId, delta, { sessionId = `sess-${RUN}` } = {}) => ({
  session_id: sessionId,
  tool: 'claude_code',
  session_context: { cwd: '/repo', host: 'host', status: 'active' },
  chunks: [{ role: 'assistant', text: 'Working in the shared project.' }],
  extraction: {
    match_decision: 'matched_existing',
    confidence: 0.95,
    project_candidate: { project_id: projectId, project_name: 'override', reason: 'same repo' },
    delta,
    should_create_project: false,
    needs_user_confirmation: false,
  },
});

test('extraction honours a per-project role_override, like every other write path', async () => {
  const project = await service.createProject(alice(), { project_name: `OverrideExtraction ${RUN}` });
  await store.upsertProjectShare(project.project_id, {
    org_id: ORG,
    enabled: true,
    updated_by: ALICE,
    created_by: ALICE,
    sections: [],
    members: [{ user_id: CAROL, role_override: 'member' }],
  });

  // The direct write already worked; extraction from the same session did not.
  await service.updateProjectContext(carol(), project.project_id, { current_status: 'carol direct' });
  assert.equal((await raw(project.project_id)).context.current_status, 'carol direct');

  await service.applyExtraction(
    carol(),
    extractionInput(project.project_id, { current_status: 'carol via extraction' })
  );
  assert.equal(
    (await raw(project.project_id)).context.current_status,
    'carol via extraction',
    'the grant that lets her save also lets her session save'
  );
});

test('extraction still refuses a viewer with no override', async () => {
  const project = await service.createProject(alice(), { project_name: `NoOverrideExtraction ${RUN}` });
  await assert.rejects(
    service.applyExtraction(
      carol(),
      extractionInput(project.project_id, { current_status: 'carol should not write this' }, { sessionId: `sess-no-${RUN}` })
    ),
    forbidden
  );
  assert.notEqual(
    (await raw(project.project_id)).context.current_status,
    'carol should not write this',
    'nothing was persisted by the refused extraction'
  );
});

test('extraction honours a key-authed override, matched by PERSON', async () => {
  const project = await service.createProject(alice(), { project_name: `OverrideExtractionKey ${RUN}` });
  await store.upsertProjectShare(project.project_id, {
    org_id: ORG,
    enabled: true,
    updated_by: ALICE,
    created_by: ALICE,
    sections: [],
    members: [{ user_id: CAROL, role_override: 'member' }],
  });
  const carolsKey = { type: 'key', id: `key-carol-extract-${RUN}`, owner_id: CAROL, org_id: ORG };
  await service.applyExtraction(
    carolsKey,
    extractionInput(project.project_id, { current_status: 'carol via MCP extraction' }, { sessionId: `sess-key-${RUN}` })
  );
  assert.equal(
    (await raw(project.project_id)).context.current_status,
    'carol via MCP extraction',
    'nearly all extraction traffic is key-authed — the grant has to reach it'
  );
});
