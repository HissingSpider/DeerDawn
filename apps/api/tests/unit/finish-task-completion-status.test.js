'use strict';

/**
 * "Cleanup complete. Task remains recorded as completed" OVER AN UNCHANGED BRIEF.
 *
 * finish_task composes `Completed: <the stored task>` and writes it through
 * updateProjectContext. That function deliberately exempts the TASK from the
 * connection-test chatter filter when a person set it — "Run the smoke test" is
 * a real five-word task — but it did not exempt the STATUS, so the server
 * composed a status out of words it had already accepted and then refused its
 * own composition. The refusal landed in `refused`, which the cleanup handler
 * never read, so the reply announced a completion the brief did not have and
 * the next start_session showed the task still in progress.
 *
 * Two ends, both pinned here: the write has to land, AND a caller that reports
 * success has to check `refused` before it does.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/finish-task-completion-status.test.js
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { dispatchTool } = require('../../src/routes/mcp');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-finish-status-${RUN}`;
const ACTOR = { org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] };
const actor = () => ({ ...ACTOR });

// The exact shape from the reviewer's reproduction: a real task whose words are
// the connection-probe vocabulary the whole-value filter was written for.
const CHATTER_SHAPED_TASK = 'Run the smoke test';

const textOf = (result) => result.content.map((c) => c.text).join('\n');

async function freshProject(name) {
  const project = await service.createProject(actor(), { project_name: `${name} ${RUN}` });
  await service.updateProjectContext(actor(), project.project_id, { current_task: CHATTER_SHAPED_TASK });
  return project;
}

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('the task the server accepted is a task the server may quote back', async () => {
  const project = await freshProject('Quote back');
  const stored = await service.getProject(actor(), project.project_id);
  assert.equal(stored.context.current_task, CHATTER_SHAPED_TASK, 'the explicit-task exemption stores it');

  const patched = await service.updateProjectContext(actor(), project.project_id, {
    current_status: `Completed: ${CHATTER_SHAPED_TASK}`,
    task_progress: 'completed',
  });
  const refusedStatus = (patched.refused || []).find((item) => item.field === 'current_status');
  assert.equal(refusedStatus, undefined, 'THE BUG: the server refused its own composition');
  assert.equal(patched.context.current_status, `Completed: ${CHATTER_SHAPED_TASK}`);
});

test('hosted finish_task leaves the brief saying what its reply says', async () => {
  const project = await freshProject('Hosted finish');

  // Journey r4: a confirmation follows its review on the same connection (the owner's decision).
  await dispatchTool('cleanup_context', { project_id: project.project_id }, actor(), 'claude_web');
  const result = await dispatchTool('cleanup_context', {
    project_id: project.project_id,
    complete_task: true,
    confirm_complete: true,
  }, actor(), 'claude_web');
  const text = textOf(result);

  const after = await service.getProject(actor(), project.project_id);
  assert.equal(
    after.context.current_status,
    `Completed: ${CHATTER_SHAPED_TASK}`,
    'THE BUG: the reply announced a completion the brief never recorded',
  );
  assert.equal(after.context.task_progress, 'completed');
  assert.match(text, /Cleanup complete/);
  assert.doesNotMatch(text, /NOT recorded/, 'nothing was refused, so nothing should be reported as refused');
});

test('a status the server could NOT write is reported, not announced as done', async () => {
  const project = await freshProject('Refused finish');
  // A status that quotes nothing the server accepted is still chatter, and a
  // cleanup that hits one has to say so rather than claim the completion.
  const patched = await service.updateProjectContext(actor(), project.project_id, {
    current_status: 'connection check ok',
  });
  const refused = (patched.refused || []).find((item) => item.field === 'current_status');
  assert.ok(refused, 'the filter still refuses a status that is only probe chatter');
  assert.equal(patched.context.current_status, '', 'and refusing leaves what was there alone');
});

test('an inferred task cannot smuggle a status past the filter', async () => {
  const project = await service.createProject(actor(), { project_name: `Inferred ${RUN}` });
  const patched = await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'auth check',
    current_task_source: 'extracted',
    current_status: 'Completed: auth check',
  });
  assert.ok(
    (patched.refused || []).some((item) => item.field === 'current_task'),
    'an inferred task is still filtered',
  );
  assert.ok(
    (patched.refused || []).some((item) => item.field === 'current_status'),
    'so a status quoting only that refused task is filtered with it',
  );
});
