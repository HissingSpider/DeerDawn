/**
 * A shared project shares its task board.
 *
 * `todo_items` was missing from SHAREABLE_SECTIONS entirely. That is not "the
 * board is private" — it is "the board has no sharing at all", in both
 * directions at once:
 *   - READ: filterContextBySectionPolicy copies only listed sections, so a
 *     teammate reading a shared project got no board, and the dashboard showed
 *     them "No tasks on the board yet" over somebody's real backlog;
 *   - WRITE: updateProjectContext refuses every field outside the list, so a
 *     member adding a card to a project they were invited into was answered
 *     share_write_forbidden with blocked_fields ['todo_items','completed_todos'].
 *
 * The fix adds no new switch. Sharing still has ONE (context_projects.visibility)
 * and the share row still only NARROWS sections; the board is now simply one of
 * the sections it can narrow. `completed_todos` — the Done column — answers to
 * the same `todo_items` key, because a Done column with its own switch could be
 * shared while the board it belongs to was not.
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

/** Alice's project with a board, shared. `sections === null` → default sections. */
async function sharedProjectWithBoard(sections = null) {
  const project = await service.createProject(alice(), {
    project_name: 'BoardProj',
    description: 'a shared project with a board',
    goals: [],
    current_status: '',
  });
  await service.updateProjectContext(alice(), project.project_id, {
    add_todos: [
      { title: 'Wire the share policy', phase: 'in_progress' },
      { title: 'Backfill project ownership', phase: 'backlog' },
    ],
  });
  await service.updateProjectContext(alice(), project.project_id, {
    complete_todos: ['Backfill project ownership'],
  });
  await db.query(
    'UPDATE context_projects SET visibility = $2 WHERE project_id = $1',
    [project.project_id, 'shared'],
    'org-system'
  );
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

test('a member reads the board of a shared project', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithBoard();

  const bobView = await service.getProject(bob(), project.project_id);
  const titles = (bobView.context.todo_items || []).map((c) => c.title);
  assert.ok(
    titles.includes('Wire the share policy'),
    'the board travels with the project it belongs to'
  );
});

test('the Done column follows the board, not a switch of its own', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithBoard();

  const bobView = await service.getProject(bob(), project.project_id);
  const done = [
    ...(bobView.context.completed_todos || []),
    ...(bobView.context.todo_items || []).filter((c) => String(c.phase) === 'done'),
  ].map((c) => c.title);
  assert.ok(
    done.includes('Backfill project ownership'),
    'a completed card is the same board — sharing one and not the other is incoherent'
  );
});

test('a member can add a card to a shared board', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithBoard();

  await service.updateProjectContext(bob(), project.project_id, {
    add_todos: [{ title: 'Card from Bob', phase: 'backlog' }],
  });

  const ownerTitles = (await service.getProject(alice(), project.project_id))
    .context.todo_items.map((c) => c.title);
  assert.ok(ownerTitles.includes('Card from Bob'), 'the member\'s card lands on the author\'s board');
  assert.ok(ownerTitles.includes('Wire the share policy'), 'and the existing cards survive it');
});

test('a member can add a card through the structured event path too', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithBoard();

  const result = await service.applyStructuredContextEvent(bob(), {
    project_id: project.project_id,
    event_type: 'todo_added',
    summary: 'Card from an agent',
    source_tool: 'claude_code',
    metadata: { todos: ['Card from an agent'] },
  });
  assert.equal(result.status, 'accepted');

  const ownerTitles = (await service.getProject(alice(), project.project_id))
    .context.todo_items.map((c) => c.title);
  assert.ok(ownerTitles.includes('Card from an agent'), 'the MCP board path shares the same gate');
});

test('an author can still narrow the share to exclude the board', async () => {
  await freshWorkspace();
  // The point of the section policy: the board is shareABLE, not force-shared.
  const project = await sharedProjectWithBoard(['current_task', 'current_status']);

  const bobView = await service.getProject(bob(), project.project_id);
  assert.equal(bobView.context.todo_items, undefined, 'a narrowed share still withholds the board');
  assert.equal(bobView.context.completed_todos, undefined, 'and withholds the Done column with it');
  assert.ok(
    (bobView.context.withheld_sections || []).includes('todo_items'),
    'and says so, rather than reading as an empty board'
  );

  await assert.rejects(
    () => service.updateProjectContext(bob(), project.project_id, {
      add_todos: [{ title: 'Card from Bob', phase: 'backlog' }],
    }),
    /share_write_forbidden/,
    'a withheld board is not writable either'
  );
});

// ── THE RULE FOR THE DEFAULTS, PINNED ────────────────────────────────────────
//
// Adding `todo_items` to DEFAULT_SHARED_SECTIONS changes what an ALREADY-shared
// project shares, but only where the author never configured one — so two
// projects shared on the same day now behave differently. That asymmetry is
// deliberate, and this is where it is stated:
//
//   - no rows  -> today's defaults, whatever they are. The board included: a
//     shared project's point is that the workspace can pick the work up, and the
//     work is the board.
//   - explicit rows -> exactly what the author chose, and a default added later
//     is never backfilled onto it. Backfilling would publish a section by
//     release note, over a decision somebody actually made.
//
// The author is not stuck with the old list — the board is in SHAREABLE_SECTIONS
// and the sharing UI offers it — but adding it stays their decision.
test('a saved sharing configuration is never backfilled with a new default', async () => {
  await freshWorkspace();
  // Exactly the defaults as they stood before the board joined them: a
  // configuration saved by an author who was never offered the choice.
  const project = await sharedProjectWithBoard(['current_task', 'current_status', 'recent_decisions']);

  const bobView = await service.getProject(bob(), project.project_id);
  assert.equal(bobView.context.todo_items, undefined, 'a configured share keeps what its author chose');

  const { sections } = await store.getProjectShare(project.project_id);
  assert.deepEqual(
    sections.map((row) => row.section_key).sort(),
    ['current_status', 'current_task', 'recent_decisions'],
    'and reading it wrote nothing: the stored rows are still the author\'s three'
  );
});

test('the board is a section an author can add to a configuration', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithBoard(['current_task', 'current_status', 'recent_decisions']);

  // What the sharing UI does when the board is ticked: rewrite the rows with it.
  await store.upsertProjectShare(project.project_id, {
    org_id: 'org-system',
    enabled: true,
    created_by: 'user-alice',
    updated_by: 'user-alice',
    sections: ['current_task', 'current_status', 'recent_decisions', 'todo_items']
      .map((section_key) => ({ section_key, can_view: true, can_edit: true })),
    members: [],
  });

  const bobView = await service.getProject(bob(), project.project_id);
  const titles = (bobView.context.todo_items || []).map((c) => c.title);
  assert.ok(titles.includes('Wire the share policy'), 'the board is offerable, not only a default');
});

test('a PERSONAL project keeps its board to itself', async () => {
  await freshWorkspace();
  const project = await sharedProjectWithBoard();
  await db.query(
    'UPDATE context_projects SET visibility = $2 WHERE project_id = $1',
    [project.project_id, 'personal'],
    'org-system'
  );

  assert.equal(
    await service.getProject(bob(), project.project_id),
    null,
    'making the board shareable must not make an unshared project readable'
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
