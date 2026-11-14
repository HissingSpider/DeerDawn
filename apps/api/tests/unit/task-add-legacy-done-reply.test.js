'use strict';

/**
 * "already exists ...; nothing was added" OVER A CARD IT HAD JUST ADDED.
 *
 * The add reply is built from a before/after index of the board, which is
 * right — only the board can say what happened. But the index folded in the
 * legacy `completed_todos` column, while the merge in shared-context dedupes
 * `add_todos` against `todo_items` alone. So a project carrying a legacy Done
 * entry got a card genuinely created in Backlog and a reply telling the caller
 * nothing had happened and to move the card instead.
 *
 * The two have to be built from the same list, or the reply is describing a
 * different board than the one that was written.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/task-add-legacy-done-reply.test.js
 */

process.env.NODE_ENV = 'test';
process.env.DISABLE_REDIS = 'true';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const workspace = require('../../src/services/workspaceService');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { dispatchTool } = require('../../src/routes/mcp');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-legacy-board-${RUN}`;
const ACTOR = { org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] };
const actor = () => ({ ...ACTOR });

const LEGACY_TITLE = 'Rotate the signing keys';
let project;

const textOf = (result) => result.content.map((c) => c.text).join('\n');

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Legacy board ${RUN}` });

  // completed_todos is read-only legacy: no write path produces it any more, so
  // it is planted the only way a real project has one, by already having it.
  const raw = await store.getProject(ORG, project.project_id);
  raw.context.completed_todos = [{
    id: `todo-legacy-${RUN}`,
    title: LEGACY_TITLE,
    created_at: new Date(Date.now() - 50 * 86400000).toISOString(),
    completed_at: new Date(Date.now() - 40 * 86400000).toISOString(),
  }];
  await store.saveProject(raw);
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('a card the merge really adds is reported as added, legacy Done entry or not', async () => {
  const result = await dispatchTool(
    'manage_todos',
    { action: 'add', project_id: project.project_id, todos: [LEGACY_TITLE] },
    actor(),
    'claude_web',
  );
  const text = textOf(result);

  const after = await service.getProject(actor(), project.project_id);
  const added = (after.context.todo_items || []).filter((card) => card.title === LEGACY_TITLE);
  assert.equal(added.length, 1, 'the merge added the card, which is what the reply has to describe');

  assert.match(text, /Added to/, 'THE BUG: the reply said nothing was added over a card it had just added');
  assert.doesNotMatch(text, /nothing was added/);
  assert.deepEqual(result.structuredContent.affected, [LEGACY_TITLE]);
  assert.deepEqual(result.structuredContent.already_present, []);
});

test('a card that really is on the board is still reported as already there', async () => {
  const title = `Wire the invite acceptance ${RUN}`;
  await dispatchTool('manage_todos', { action: 'add', project_id: project.project_id, todos: [title] }, actor(), 'claude_web');
  const again = await dispatchTool('manage_todos', { action: 'add', project_id: project.project_id, todos: [title] }, actor(), 'claude_web');

  assert.match(textOf(again), /already exists/);
  assert.deepEqual(again.structuredContent.affected, []);
});

test('a card already in Done is still reported as already there', async () => {
  const title = `Ship the export redaction ${RUN}`;
  await dispatchTool('manage_todos', { action: 'add', project_id: project.project_id, todos: [title] }, actor(), 'claude_web');
  await dispatchTool('manage_todos', { action: 'complete', project_id: project.project_id, todos: [title] }, actor(), 'claude_web');
  const again = await dispatchTool('manage_todos', { action: 'add', project_id: project.project_id, todos: [title] }, actor(), 'claude_web');

  assert.match(textOf(again), /already exists in done/);
  assert.deepEqual(again.structuredContent.affected, []);
});
