'use strict';

/**
 * `bodies_set: 0` OVER TWO CARDS WHOSE BODIES IT HAD JUST STORED.
 *
 * The add reply is built from a before/after index of the board, which is the
 * only thing that can say what happened. But the body arithmetic was written
 * against the ONE case the index can compare — a title that already existed —
 * so a card created in this same call fell into `created` and its body was
 * counted nowhere. Eight new cards with eight bodies answered `bodies_set: 0`,
 * which reads exactly like the bodies having been dropped.
 *
 * They are not dropped: the merge stores them. This pins both halves, because
 * only the pair distinguishes "the count is wrong" from silent data loss, and
 * the reply is the only thing a caller can see.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/task-add-new-card-body.test.js
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
const USER = `user-card-body-${RUN}`;
const ACTOR = { org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] };
const actor = () => ({ ...ACTOR });

const FIRST = `Repoint the Stripe price ${RUN}`;
const SECOND = `Audit the recovery route set ${RUN}`;

let project;

const textOf = (result) => result.content.map((c) => c.text).join('\n');
const dataOf = (result) => result.structuredContent || {};
const bodyOf = (context, title) => String(
  (context.todo_items || []).find((card) => card.title === title)?.body || '',
);

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Card bodies ${RUN}` });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('two NEW cards with bodies: the bodies are stored AND counted', async () => {
  const result = await dispatchTool('manage_todos', {
    action: 'add',
    project_id: project.project_id,
    cards: [
      { title: FIRST, phase: 'backlog', body: 'Keep the old id in _LEGACY or the one paying subscriber silently downgrades.' },
      { title: SECOND, phase: 'backlog', body: 'Table-driven, past_due and cancelled, owner: every recovery route must reach its handler.' },
    ],
  }, actor(), 'claude_web');

  const after = await service.getProject(actor(), project.project_id);
  // Half one: the bodies really are on the board. If this fails the reply was
  // not merely miscounting and the whole call is losing data.
  assert.match(bodyOf(after.context, FIRST), /_LEGACY/, 'a new card\'s body has to be stored');
  assert.match(bodyOf(after.context, SECOND), /past_due/, 'a new card\'s body has to be stored');

  // Half two: the reply says so. This is what a caller sees.
  const data = dataOf(result);
  assert.deepEqual([...data.affected].sort(), [FIRST, SECOND].sort());
  assert.equal(data.bodies_set, 2, 'THE BUG: two bodies were stored and the reply counted none');
  assert.deepEqual(data.body_updated, [], 'neither title existed before, so neither was an update');
  assert.match(textOf(result), /Added to/);
});

test('re-adding an existing title with a NEW body is an update, not a creation', async () => {
  const result = await dispatchTool('manage_todos', {
    action: 'add',
    project_id: project.project_id,
    cards: [{ title: FIRST, body: 'Rewritten: repoint the env var and keep the legacy id mapped.' }],
  }, actor(), 'claude_web');

  const after = await service.getProject(actor(), project.project_id);
  assert.match(bodyOf(after.context, FIRST), /Rewritten/);

  const data = dataOf(result);
  assert.deepEqual(data.body_updated, [FIRST]);
  assert.deepEqual(data.affected, [], 'the card already existed; nothing was created');
  assert.equal(data.bodies_set, 1);
});

test('re-adding with the SAME body counts in neither', async () => {
  const result = await dispatchTool('manage_todos', {
    action: 'add',
    project_id: project.project_id,
    cards: [{ title: FIRST, body: 'Rewritten: repoint the env var and keep the legacy id mapped.' }],
  }, actor(), 'claude_web');

  const data = dataOf(result);
  assert.deepEqual(data.affected, []);
  assert.deepEqual(data.body_updated, []);
  assert.equal(data.bodies_set, 0);
  assert.deepEqual(
    (data.already_present || []).map((entry) => entry.title),
    [FIRST],
    'an unchanged re-add is reported as already present',
  );
});

test('a new card with NO body does not inflate bodies_set', async () => {
  const bare = `Write the PR body ${RUN}`;
  const result = await dispatchTool('manage_todos', {
    action: 'add',
    project_id: project.project_id,
    todos: [bare],
  }, actor(), 'claude_web');

  const data = dataOf(result);
  assert.deepEqual(data.affected, [bare]);
  assert.equal(data.bodies_set, 0);
});

test('a listing that opens a card returns its body where a client can read it', async () => {
  const result = await dispatchTool('read_tasks', {
    project_id: project.project_id,
    todos: [FIRST],
  }, actor(), 'claude_web');
  assert.match(textOf(result), /Rewritten/, 'opening a card has to return the body somewhere readable');
});
