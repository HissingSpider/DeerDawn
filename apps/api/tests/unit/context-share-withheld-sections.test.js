/**
 * A withheld section is not an empty section.
 *
 * `filterContextBySectionPolicy` builds a teammate's read view by dropping every
 * key outside the share policy. Dropping a key makes it ABSENT, and absence is
 * exactly what "nobody has written this yet" looks like to every renderer
 * downstream — the dashboard's "This project doesn't have brief content yet",
 * the brief's "No brief captured yet", the board's "No tasks on the board yet".
 *
 * So a member reading a narrowly-shared project was told a busy project was
 * blank. The obvious reaction to a blank brief is to write it down again, which
 * turns a privacy control into a machine for manufacturing duplicate, diverging
 * history — the failure mode is worse than the one sharing was meant to solve.
 *
 * The filtered view now carries `withheld_sections`: the NAMES of the withheld
 * sections that actually hold content. Names only — saying "there are decisions
 * here you may not read" leaks nothing, and is the only honest answer.
 *
 * Multi-user, DB-backed; run via scripts/run-db-test.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

const alice = () => ({ org_id: 'org-system', id: 'user-alice' });
const bob = () => ({ org_id: 'org-system', id: 'user-bob' });

async function freshWorkspace() {
  await store.clearAll();
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1',
    ['org-system'],
    'org-system'
  ).catch(() => {});
  await workspace.addMember('org-system', 'user-alice', { role: 'owner' });
  await workspace.addMember('org-system', 'user-bob', { role: 'member' });
}

/** Alice's project, shared with the workspace, narrowed to `sections`. */
async function sharedProject(sections, patch) {
  const project = await service.createProject(alice(), {
    project_name: 'WithheldProj',
    description: 'A project with plenty written down.',
    goals: [],
    current_status: '',
  });
  await service.updateProjectContext(alice(), project.project_id, patch);
  await db.query(
    'UPDATE context_projects SET visibility = $2 WHERE project_id = $1',
    [project.project_id, 'shared'],
    'org-system'
  );
  await store.upsertProjectShare(project.project_id, {
    org_id: 'org-system',
    enabled: true,
    created_by: 'user-alice',
    updated_by: 'user-alice',
    sections: sections.map((section_key) => ({ section_key, can_view: true, can_edit: true })),
    members: [],
  });
  return project;
}

test('a narrowly-shared project names what it withheld, and never its contents', async () => {
  await freshWorkspace();
  const project = await sharedProject(['current_task'], {
    current_task: 'Ship the share policy',
    goals: ['Ship teams'],
    hot_paths: [{ label: 'service', path: 'src/services/contextSyncService.js', purpose: 'sharing' }],
    recent_decisions: [
      { summary: 'Visibility is the only switch', decided_at: new Date().toISOString(), importance: 'high' },
    ],
  });

  const bobView = await service.getProject(bob(), project.project_id);
  assert.ok(bobView, 'a member can read a shared project');

  // The policy is still enforced: the CONTENTS never travel.
  assert.equal(bobView.context.recent_decisions, undefined, 'withheld section stays absent');
  assert.equal(bobView.context.goals, undefined, 'withheld section stays absent');
  assert.equal(bobView.context.hot_paths, undefined, 'withheld section stays absent');
  assert.equal(bobView.context.current_task, 'Ship the share policy', 'shared section still travels');

  const withheld = bobView.context.withheld_sections;
  assert.ok(Array.isArray(withheld), 'a filtered view carries withheld_sections');
  for (const section of ['recent_decisions', 'goals', 'hot_paths', 'description']) {
    assert.ok(withheld.includes(section), `withheld_sections names ${section}`);
  }
  assert.ok(!withheld.includes('current_task'), 'a SHARED section is not reported as withheld');

  // Names only. Nothing in the payload may carry a withheld value.
  const serialized = JSON.stringify(bobView.context);
  assert.ok(!serialized.includes('Visibility is the only switch'), 'no withheld decision text');
  assert.ok(!serialized.includes('Ship teams'), 'no withheld goal text');
  assert.ok(!serialized.includes('contextSyncService.js'), 'no withheld hot path');
});

test('a section nobody wrote is not reported as withheld', async () => {
  await freshWorkspace();
  // Only current_task is written; landmines/shipped/open_questions are untouched.
  const project = await sharedProject(['current_task'], {
    current_task: 'Ship the share policy',
  });

  const withheld = (await service.getProject(bob(), project.project_id)).context.withheld_sections;
  for (const section of ['landmines', 'shipped', 'open_questions', 'debugging_notes']) {
    assert.ok(
      !withheld.includes(section),
      `${section} is genuinely empty and must not be announced as a secret`
    );
  }
  // description was set at creation, so it IS withheld and IS worth naming.
  assert.ok(withheld.includes('description'), 'a withheld section with content is still named');
});

test('the author sees no withheld_sections at all — the key marks a FILTERED view', async () => {
  await freshWorkspace();
  const project = await sharedProject(['current_task'], {
    current_task: 'Ship the share policy',
    goals: ['Ship teams'],
  });

  const ownerView = await service.getProject(alice(), project.project_id);
  assert.equal(
    ownerView.context.withheld_sections,
    undefined,
    'the raw row carries no marker — its presence is how a consumer knows the view was filtered'
  );
  assert.deepEqual(ownerView.context.goals, ['Ship teams'], 'the author reads everything');
});

test('listProjects reports withheld sections too, not only the single-project read', async () => {
  await freshWorkspace();
  await sharedProject(['current_task'], {
    current_task: 'Ship the share policy',
    goals: ['Ship teams'],
  });

  const listed = (await service.listProjects(bob())).find((p) => p.project_name === 'WithheldProj');
  assert.ok(listed, 'a member lists the shared project');
  assert.ok(
    (listed.context.withheld_sections || []).includes('goals'),
    'the list view is section-filtered too, so it needs the same honesty'
  );
});

test.after(async () => {
  // 'org-system' is a SHARED sentinel across suites: leaving these rows behind
  // makes every later suite's solo workspace look like a two-person team, and
  // the workspace write check then refuses writes those suites depend on. The
  // before-hook's delete is not enough — it only protects THIS file.
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1',
    ['org-system'],
    'org-system'
  ).catch(() => {});
  await closeRedisConnections();
});
