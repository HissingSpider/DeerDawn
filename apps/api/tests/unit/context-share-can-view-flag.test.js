/**
 * can_view governs, or it is decoration.
 *
 * A share row narrows which sections of a shared project travel to the
 * workspace, and each row carries `can_view` and `can_edit`. The policy builder
 * mapped every configured row's `section_key` into the list that travels,
 * regardless of `can_view` — so an author who turned viewing OFF for one section
 * still sent its contents to every teammate. The flag enforced nothing, which is
 * the same shape as the project-level privacy toggle that enforced nothing
 * before it, and the reason the model is "visibility is the switch, the row only
 * narrows".
 *
 * Two properties, and the second is the one a naive fix breaks:
 *
 *   1. A row with can_view false withholds that section's CONTENT.
 *   2. A share whose rows hide everything travels NOTHING — it must not fall
 *      through to DEFAULT_SHARED_SECTIONS. The old code chose the defaults
 *      whenever the computed list came back empty, and once can_view is honoured
 *      "every row hidden" computes to empty too: hiding all four sections would
 *      have published all of them.
 *
 * Withholding the read withholds the write as well. policy.sections is the
 * precondition in canEditSectionForActor, so a section you may not read is a
 * section you may not merge into — writing into content you cannot see is how
 * the member-write wipe destroyed an owner's work, and a permission flag saying
 * "edit but do not look" would rebuild it deliberately.
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

const TASK = 'Ship the can_view flag';
const SECRET_GOAL = 'Raise the price before the pilot';

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

/** Alice's shared project, with `rows` as its literal share configuration. */
async function sharedProjectWithRows(rows) {
  const project = await service.createProject(alice(), {
    project_name: 'CanViewProj',
    description: 'A project with plenty written down.',
    goals: [],
    current_status: '',
  });
  await service.updateProjectContext(alice(), project.project_id, {
    current_task: TASK,
    goals: [SECRET_GOAL],
  });
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
    sections: rows,
    members: [],
  });
  return project;
}

test('a section with can_view false does not travel, even though its row exists', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithRows([
    { section_key: 'current_task', can_view: true, can_edit: true },
    // The whole point of the flag: the row exists, and says do not show it.
    { section_key: 'goals', can_view: false, can_edit: true },
  ]);

  const bobView = await service.getProject(bob(), project.project_id);
  assert.equal(bobView.context.current_task, TASK, 'the shared section still travels');
  assert.equal(bobView.context.goals, undefined, 'a can_view:false section must not travel');
  assert.ok(
    !JSON.stringify(bobView).includes(SECRET_GOAL),
    'the withheld content must not reach the reader by any other field either'
  );
  // Honest about the withholding, per the withheld-sections contract: names only.
  assert.ok(
    (bobView.context.withheld_sections || []).includes('goals'),
    'the reader is told the section exists and is withheld, never its contents'
  );

  // The author is unaffected: this is a reader policy, not a data change.
  const aliceView = await service.getProject(alice(), project.project_id);
  assert.deepEqual(aliceView.context.goals, [SECRET_GOAL], 'the author still reads her own goals');
});

test('a section you may not read is a section you may not write', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithRows([
    { section_key: 'current_task', can_view: true, can_edit: true },
    // can_edit true with can_view false: "edit what you cannot see" is a blind
    // merge into content the writer does not know is there.
    { section_key: 'goals', can_view: false, can_edit: true },
  ]);

  await assert.rejects(
    service.updateProjectContext(bob(), project.project_id, { goals: ['Bob rewrote the goals'] }),
    (err) => err.code === 'share_write_forbidden',
    'a withheld section refuses the write rather than merging blind'
  );

  const raw = await store.getProject('org-system', project.project_id);
  assert.deepEqual(raw.context.goals, [SECRET_GOAL], 'the author\'s goals survive the refused write');

  // The section that IS shared stays writable, so the refusal is the flag and
  // not a blanket loss of write access.
  await service.updateProjectContext(bob(), project.project_id, { current_task: 'Bob moved it on' });
  const after = await store.getProject('org-system', project.project_id);
  assert.equal(after.context.current_task, 'Bob moved it on', 'a shared section is still writable');
});

test('a share whose every row hides its section travels nothing, not the defaults', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithRows([
    { section_key: 'current_task', can_view: false, can_edit: false },
    { section_key: 'goals', can_view: false, can_edit: false },
  ]);

  const bobView = await service.getProject(bob(), project.project_id);
  // The trap: "no viewable sections" computes to an empty list, and the empty
  // list used to mean "use the defaults" — which would publish current_task,
  // current_status and recent_decisions from a share that hid everything.
  assert.equal(bobView.context.current_task, undefined, 'hiding every row must not fall back to defaults');
  assert.equal(bobView.context.goals, undefined, 'nor leak the second hidden section');
  assert.ok(!JSON.stringify(bobView).includes(TASK), 'no withheld content anywhere in the view');
});

test('a shared project with NO configured rows still gets the default sections', async () => {
  await freshWorkspace();
  // Absent rows mean "shared, default sections" — the deliberate behaviour that
  // stopped a project marked shared from being silently not shared. Honouring
  // can_view must not disturb it.
  const project = await sharedProjectWithRows([]);

  const bobView = await service.getProject(bob(), project.project_id);
  assert.equal(bobView.context.current_task, TASK, 'a default-shared project still shares current_task');
  assert.equal(bobView.context.goals, undefined, 'goals is not a default shared section');
});

test.after(async () => {
  // 'org-system' is a shared sentinel across suites: leaving membership rows
  // behind makes every later suite's solo workspace look like a team.
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1',
    ['org-system'],
    'org-system'
  ).catch(() => {});
  await closeRedisConnections();
});
