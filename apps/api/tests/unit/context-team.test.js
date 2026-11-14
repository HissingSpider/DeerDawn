/**
 * Team / shared workspace (moat 4) — per-user contribution attribution.
 *
 * Context contributed by different teammates is attributed per user (even though
 * everyone in an org collapses to one owner_key/workspace), and surfaced as a team
 * so the shared context is visibly collectively built — the social switching cost.
 *
 * Multi-user, DB-backed; run via scripts/run-db-test.sh node tests/unit/context-team.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

// Same org (same workspace), different users.
const alice = () => ({ org_id: 'org-system', id: 'user-alice' });
const bob = () => ({ org_id: 'org-system', id: 'user-bob' });

// "Two people in one org" is now an explicit fact rather than an implicit one.
//
// It used to be enough to hand two different actor ids to the same org_id,
// because owner_key collapsed everyone in an org into one workspace and nothing
// asked who else was in it. Now that a project can be private to the person who
// made it, the system has to KNOW the workspace is shared — a project created in
// a solo workspace stays private, which is the whole point of the change and is
// what stopped Bob writing to Alice's project here.
async function joinWorkspace() {
  await workspace.addMember('org-system', 'user-alice', { role: 'owner' });
  await workspace.addMember('org-system', 'user-bob', { role: 'member' });
}

async function leaveWorkspace() {
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1 AND user_id = ANY($2)',
    ['org-system', ['user-alice', 'user-bob']],
    'org-system'
  ).catch(() => {});
}

function matched(projectId, delta) {
  return {
    match_decision: 'matched_existing',
    confidence: 0.95,
    project_candidate: { project_id: projectId, project_name: 'TeamProj', reason: 'same repo' },
    delta,
    should_create_project: false,
    needs_user_confirmation: false,
  };
}

test('contributions are attributed per user and surfaced as a team', async () => {
  await store.clearAll();
  await leaveWorkspace();
  await joinWorkspace();
  const project = await service.createProject(alice(), {
    project_name: 'TeamProj', description: 'a shared team project', goals: [], current_status: '',
  });

  await service.applyExtraction(alice(), {
    session_id: 's-alice',
    tool: 'claude_code',
    session_context: { cwd: '/repo', host: 'alice-laptop', status: 'active' },
    chunks: [{ role: 'assistant', text: 'Alice wired the auth layer in the API.' }],
    extraction: matched(project.project_id, { current_status: 'Auth layer wired by Alice.' }),
  });
  await service.applyExtraction(bob(), {
    session_id: 's-bob',
    tool: 'cursor',
    session_context: { cwd: '/repo', host: 'bob-laptop', status: 'active' },
    chunks: [{ role: 'assistant', text: 'Bob moved the session store to Redis.' }],
    extraction: matched(project.project_id, { current_status: 'Session store moved to Redis by Bob.' }),
  });

  const contributors = await service.getProjectContributors(alice(), project.project_id);
  const ids = contributors.map((c) => c.user_id).sort();
  assert.deepEqual(ids, ['user-alice', 'user-bob'], 'both teammates attributed as contributors');
  for (const c of contributors) {
    assert.ok(c.contributions >= 1, 'contribution count recorded');
    assert.ok(c.last_at, 'last contribution timestamp recorded');
  }

  const overview = await service.getWorkspaceOverview(alice(), {});
  const overviewIds = (overview.contributors || []).map((c) => c.user_id).sort();
  assert.deepEqual(overviewIds, ['user-alice', 'user-bob'], 'workspace overview surfaces the team');

  // A shared project surfaces the team dependency in the brief; a private one does not.
  const loaded = await store.getProject('org-system', project.project_id);
  await store.saveProject({ ...loaded, visibility: 'shared' }, alice());
  const sharedInj = await service.renderInjection(alice(), project.project_id, 'claude_code', 'standard');
  assert.match(sharedInj.body, /Shared workspace — 2 teammates have contributed/, 'shared project shows the team line');

  await store.saveProject({ ...loaded, visibility: 'private' }, alice());
  const privateInj = await service.renderInjection(alice(), project.project_id, 'codex', 'standard');
  assert.doesNotMatch(privateInj.body, /Shared workspace/, 'private project shows no team line');
});

// A teammate's write must never erase what they cannot see.
//
// getProject hands a non-owner a context filtered to the shared sections. The
// write paths used to load through it and then save the full row, so every
// section outside the share policy was persisted as empty: one current_status
// update from Bob wiped Alice's description, goals and hot paths, and returned
// success. These assertions read the RAW row, because the filtered view cannot
// show a loss it hides by construction.
test('a member write to a shared project preserves the owner\'s unshared sections', async () => {
  await store.clearAll();
  await leaveWorkspace();
  await joinWorkspace();
  const project = await service.createProject(alice(), {
    project_name: 'TeamWipe',
    description: 'owner description',
    goals: ['ship v1'],
    current_status: '',
    hot_paths: [{ label: 'api entry', path: 'apps/api/src/app.js', purpose: 'express app' }],
  });
  await service.recordDebugFinding(alice(), project.project_id, { summary: 'owner finding about the cache layer' });

  const raw = () => store.getProject('org-system', project.project_id);
  const assertOwnerSectionsSurvive = async (label) => {
    const row = await raw();
    assert.equal(row.context.description, 'owner description', `${label}: description survives`);
    assert.deepEqual(row.context.goals, ['ship v1'], `${label}: goals survive`);
    assert.ok(
      (row.context.hot_paths || []).some((h) => h.path === 'apps/api/src/app.js'),
      `${label}: owner hot path survives`
    );
    assert.ok(
      (row.context.debugging_notes || []).some((d) => /cache layer/.test(d.summary)),
      `${label}: owner debugging note survives`
    );
    return row;
  };

  const before = await raw();
  assert.equal(before.visibility, 'shared', 'a project created in a team workspace is shared');
  await assertOwnerSectionsSurvive('baseline');

  const result = await service.applyExtraction(bob(), {
    session_id: 's-bob-wipe',
    tool: 'cursor',
    session_context: { cwd: '/repo', host: 'bob-laptop', status: 'active' },
    chunks: [{ role: 'assistant', text: 'Bob moved the session store to Redis.' }],
    extraction: matched(project.project_id, { current_status: 'Session store moved to Redis by Bob.' }),
  });
  const afterExtraction = await assertOwnerSectionsSurvive('after member extraction');
  assert.equal(afterExtraction.context.current_status, 'Session store moved to Redis by Bob.', 'member write landed');
  assert.equal(result.project.context.description, undefined, 'the member is handed the filtered view, not the raw row');

  // Default policy: hot paths and debugging notes are NOT in the share, and a
  // member may still ADD to them — blind, strictly additive: nothing the owner
  // recorded changes, and the reply carries none of it (scan 21).
  const hp = await service.recordHotPaths(bob(), project.project_id, [
    { label: 'bob path', path: 'apps/api/src/bob.js' },
    { label: 'bob relabel', path: 'apps/api/src/app.js', purpose: 'bob overwrote' },
  ]);
  assert.equal(hp.hot_paths, undefined, 'no stored list for a section the member cannot read');
  assert.equal(hp.stored, 1);
  assert.equal(hp.already_recorded, 1, 'the owner\'s path was left alone');
  const finding = await service.recordDebugFinding(bob(), project.project_id, { summary: 'bob finding about retries' });
  assert.equal(finding.debugging_notes, undefined, 'no stored log for a section the member cannot read');
  const afterAppends = await assertOwnerSectionsSurvive('after member appends');
  assert.ok(afterAppends.context.hot_paths.some((h) => h.path === 'apps/api/src/bob.js'), 'member hot path persisted');
  assert.ok(!afterAppends.context.hot_paths.some((h) => h.label === 'bob relabel'), 'the owner\'s path was not relabelled');
  assert.ok(afterAppends.context.debugging_notes.some((d) => /retries/.test(d.summary)), 'member finding persisted');
  // Still not a READ: the member's view of the project withholds both sections.
  const view = await service.getProject(bob(), project.project_id);
  assert.equal(view.context.hot_paths, undefined);
  assert.equal(view.context.debugging_notes, undefined);

  // Superseding deletes earlier notes — a rewrite, which the default policy refuses.
  await assert.rejects(
    service.recordDebugFinding(bob(), project.project_id, { summary: 'bob correction', supersedes: 'cache layer' }),
    (err) => err.code === 'share_write_forbidden'
  );
  await assertOwnerSectionsSurvive('after a refused member supersede');

  // A viewer may not append at all.
  await db.query(
    'UPDATE workspace_members SET role = $1 WHERE owner_key = $2 AND user_id = $3',
    ['viewer', 'org-system', 'user-bob'],
    'org-system'
  );
  await assert.rejects(
    service.recordHotPaths(bob(), project.project_id, [{ label: 'viewer path', path: 'apps/api/src/viewer.js' }]),
    (err) => err.code === 'share_write_forbidden'
  );
  await assert.rejects(
    service.recordDebugFinding(bob(), project.project_id, { summary: 'viewer finding' }),
    (err) => err.code === 'share_write_forbidden'
  );
  await db.query(
    'UPDATE workspace_members SET role = $1 WHERE owner_key = $2 AND user_id = $3',
    ['member', 'org-system', 'user-bob'],
    'org-system'
  );

  // An explicit policy that grants edit: superseding is allowed, and nothing else is lost.
  await store.upsertProjectShare(project.project_id, {
    org_id: 'org-system',
    enabled: true,
    sections: ['current_status', 'hot_paths', 'debugging_notes'].map((section_key) => ({
      section_key, can_view: true, can_edit: true,
    })),
  });
  await service.recordDebugFinding(bob(), project.project_id, { summary: 'bob retries correction', supersedes: 'bob finding about retries' });
  const finalRow = await assertOwnerSectionsSurvive('after granted member writes');
  assert.ok(finalRow.context.debugging_notes.some((d) => /retries correction/.test(d.summary)), 'granted supersede landed');
});

// The defensive half: a section-filtered context must be unpersistable, so the
// next write path that loads through getProject fails loudly instead of wiping.
test('a section-filtered project can never be persisted', async () => {
  await store.clearAll();
  await leaveWorkspace();
  await joinWorkspace();
  const project = await service.createProject(alice(), {
    project_name: 'TeamGuard', description: 'owner description', goals: ['ship v1'], current_status: '',
  });
  const filtered = await service.getProject(bob(), project.project_id);
  assert.equal(filtered.context.description, undefined, 'bob sees the filtered view');
  await assert.rejects(store.saveProject(filtered, bob()), /section-filtered/);
  await assert.rejects(service.repairProjectIntegrity(filtered), /section-filtered/);
  const row = await store.getProject('org-system', project.project_id);
  assert.equal(row.context.description, 'owner description');
});

test.after(async () => {
  // 'org-system' is a shared sentinel across suites — leaving membership rows
  // behind would make every other suite's workspace look like a team.
  try { await leaveWorkspace(); } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
