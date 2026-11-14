/**
 * The task's provenance must not cost a teammate the task.
 *
 * current_task_source / current_task_set_at are stamped BY THE SERVER whenever a
 * task is set on purpose. The write gate refuses any patch key that is not a
 * shareable section, so an unmapped stamp would have made every teammate's task
 * write fail with share_write_forbidden — for a field they never sent. Both are
 * mapped onto the `current_task` section; this pins that a member can still set
 * and complete a task on a shared project, that the stamp travels with the
 * section on read, and that a project sharing everything EXCEPT the task does
 * not leak the stamp.
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
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', ['org-system'], 'org-system').catch(() => {});
  await workspace.addMember('org-system', 'user-alice', { role: 'owner' });
  await workspace.addMember('org-system', 'user-bob', { role: 'member' });
}

async function sharedProject(sections = null) {
  const project = await service.createProject(alice(), {
    project_name: 'TaskProvenanceProj',
    description: 'a shared project',
    goals: [],
    current_status: '',
  });
  await db.query('UPDATE context_projects SET visibility = $2 WHERE project_id = $1', [project.project_id, 'shared'], 'org-system');
  if (sections) {
    await store.upsertProjectShare(project.project_id, {
      org_id: 'org-system',
      enabled: true,
      created_by: 'user-alice',
      updated_by: 'user-alice',
      sections: sections.map((section_key) => ({ section_key, can_view: true, can_edit: true })),
      members: [],
    });
  }
  return project;
}

test('a member can set the task on a shared project, and it is stamped explicit', async () => {
  await freshWorkspace();
  const project = await sharedProject();
  await service.updateProjectContext(bob(), project.project_id, { current_task: 'Bob sets the task' });

  const raw = await store.getProject('org-system', project.project_id);
  assert.strictEqual(raw.context.current_task, 'Bob sets the task');
  assert.strictEqual(raw.context.current_task_source, 'explicit');
  assert.ok(raw.context.current_task_set_at);

  const asAlice = await service.getProject(alice(), project.project_id);
  assert.strictEqual(asAlice.context.current_task_source, 'explicit');
});

test('a member task_started event lands on a project that shares the task sections', async () => {
  await freshWorkspace();
  // task_started also writes task_progress, which is NOT in the default share —
  // so on a default-shared project a member's task_started is refused today, on
  // main as well as here (recorded as a finding; whether the task lifecycle
  // fields should travel with current_task is a sharing-policy decision). This
  // test is about the provenance stamp, so it shares what the event writes.
  const project = await sharedProject(['current_task', 'current_status', 'task_progress']);
  await service.applyStructuredContextEvent(bob(), {
    event_type: 'task_started',
    project_id: project.project_id,
    summary: 'Bob starts a task',
    metadata: { surface: 'claude_code' },
  });
  const raw = await store.getProject('org-system', project.project_id);
  assert.strictEqual(raw.context.current_task, 'Bob starts a task');
  assert.strictEqual(raw.context.current_task_source, 'explicit');
});

test('the stamp is withheld along with the task when the task section is not shared', async () => {
  await freshWorkspace();
  const project = await sharedProject(['current_status', 'recent_decisions']);
  await service.updateProjectContext(alice(), project.project_id, { current_task: 'Alice private task' });

  const asBob = await service.getProject(bob(), project.project_id);
  assert.ok(!asBob.context.current_task, 'the withheld task leaked');
  assert.ok(!asBob.context.current_task_source, 'the provenance of a withheld task leaked');
  assert.ok(!asBob.context.current_task_set_at, 'the set-at of a withheld task leaked');
});

test('re-saving an unchanged inferred task does not promote it to explicit', async () => {
  await freshWorkspace();
  const project = await sharedProject();
  const raw = await store.getProject('org-system', project.project_id);
  await store.saveProject({
    ...raw,
    context: { ...raw.context, current_task: 'A task the model inferred', current_task_source: 'extracted' },
  }, alice());

  // The dashboard PATCHes the whole brief back, task included, unchanged.
  await service.updateProjectContext(alice(), project.project_id, {
    current_task: 'A task the model inferred',
    current_status: 'Edited the status only',
  });
  const after = await store.getProject('org-system', project.project_id);
  assert.strictEqual(after.context.current_task_source, 'extracted');
});

test.after(async () => {
  // 'org-system' is a SHARED sentinel across suites: leaving these rows behind
  // makes every later suite's solo workspace look like a two-person team.
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', ['org-system'], 'org-system').catch(() => {});
  await closeRedisConnections();
});
