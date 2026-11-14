/**
 * A command somebody RAN is not a decision the team AGREED.
 *
 * The Claude Code PostToolUse hook captures every Bash command and posts it as
 * `command_confirmed`. That event appended the command to `recent_decisions` —
 * the same list `decision_made` writes to, the list the brief renders under
 * "Recent decisions", the list a teammate reads on a shared project to learn
 * what was settled and why.
 *
 * So `npm test`, `git status` and `rm -rf node_modules` arrived in a colleague's
 * brief as things the team had decided, indistinguishable from an actual
 * decision, with no author having asserted anything. On a busy day the hook
 * fires dozens of times, so the real decisions were also pushed out of a list
 * that keeps a bounded number of entries: the noise did not merely sit beside
 * the signal, it evicted it.
 *
 * The brief already HAS the right home for this — `context.commands`, a list of
 * runnable commands for the project, which the same branch was already writing
 * to. Nothing is lost by keeping only that half; what is removed is the claim
 * that running something was deciding something.
 *
 * DB-backed; run via scripts/run-db-test.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { closeRedisConnections } = require('../../src/config/redis');

// A dedicated workspace on an eligible plan. Command capture is gated at
// developer_basic and above, so on the free default the branch under test never
// runs at all and every assertion here would pass for the wrong reason.
const ORG = 'org-c0ffee00-1111-4222-8333-444444444444';
const alice = () => ({ org_id: ORG, id: 'user-alice' });

const REAL_DECISIONS = [
  { summary: 'Sharing has exactly one switch', decided_at: '2026-09-01T10:00:00.000Z', importance: 'high' },
  { summary: 'owner_key comes from workspaceService', decided_at: '2026-09-02T10:00:00.000Z', importance: 'high' },
];

async function freshWorkspace() {
  // store.clearAll() only resets org-system, and this suite deliberately runs in
  // its own workspace (see ORG), so clear this one by hand.
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await store.clearAll();
  await db.query(
    `INSERT INTO organizations (org_id, name, plan_tier, subscription_status)
     VALUES ($1, $2, 'developer_basic', 'active')
     ON CONFLICT (org_id) DO UPDATE SET plan_tier = 'developer_basic', subscription_status = 'active'`,
    [ORG, 'Command capture'],
    ORG
  );
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1',
    [ORG],
    ORG
  ).catch(() => {});
  await workspace.addMember(ORG, 'user-alice', { role: 'owner' });
}

async function projectWithDecisions() {
  const project = await service.createProject(alice(), {
    project_name: 'CommandProj',
    description: 'a project with a real decision history',
    goals: [],
    current_status: '',
  });
  await service.updateProjectContext(alice(), project.project_id, {
    recent_decisions: REAL_DECISIONS,
  });
  return project;
}

async function readContext(projectId) {
  const project = await service.getProject(alice(), projectId);
  return project.context || {};
}

async function runCommand(projectId, { label, run, note }) {
  return service.applyStructuredContextEvent(alice(), {
    project_id: projectId,
    event_type: 'command_confirmed',
    summary: `Executed command: ${run}`,
    source_tool: 'claude_code',
    metadata: { label, run, note, auto: true, silent: true },
  });
}

test('a captured command never lands in the decision log', async () => {
  await freshWorkspace();
  const project = await projectWithDecisions();

  await runCommand(project.project_id, { label: 'npm', run: 'npm test', note: 'exit_code=0' });
  await runCommand(project.project_id, { label: 'git', run: 'git status --short' });

  const context = await readContext(project.project_id);
  const summaries = (context.recent_decisions || []).map((d) => d.summary);

  assert.deepEqual(
    summaries,
    REAL_DECISIONS.map((d) => d.summary),
    'running a command is not deciding anything — the decision log is untouched'
  );
  assert.ok(
    !summaries.some((s) => /npm test|git status/.test(s)),
    'no captured command may appear in recent_decisions'
  );
});

test('the command still lands where commands belong', async () => {
  await freshWorkspace();
  const project = await projectWithDecisions();

  await runCommand(project.project_id, { label: 'npm', run: 'npm test', note: 'exit_code=0' });

  const context = await readContext(project.project_id);
  const commands = context.commands || [];
  assert.ok(
    commands.some((c) => c.run === 'npm test'),
    'dropping the decision append must not drop the capture — context.commands is its home'
  );
  assert.equal(commands.find((c) => c.run === 'npm test').label, 'npm');
});

test('dozens of captured commands cannot evict a real decision', async () => {
  await freshWorkspace();
  const project = await projectWithDecisions();

  for (let i = 0; i < 40; i += 1) {
    await runCommand(project.project_id, { label: 'git', run: `git log --oneline -${i}` });
  }

  const summaries = ((await readContext(project.project_id)).recent_decisions || []).map((d) => d.summary);
  assert.ok(
    REAL_DECISIONS.every((d) => summaries.includes(d.summary)),
    'the noise was not merely beside the signal — it pushed the signal out of a bounded list'
  );
});

test('a real decision still appends normally', async () => {
  await freshWorkspace();
  const project = await projectWithDecisions();

  await service.applyStructuredContextEvent(alice(), {
    project_id: project.project_id,
    event_type: 'decision_made',
    summary: 'Captured commands are not decisions',
    source_tool: 'claude_code',
    metadata: {},
  });

  const summaries = ((await readContext(project.project_id)).recent_decisions || []).map((d) => d.summary);
  assert.deepEqual(summaries, [...REAL_DECISIONS.map((d) => d.summary), 'Captured commands are not decisions']);
});

test.after(async () => {
  await closeRedisConnections().catch(() => {});
  await db.pool?.end?.().catch(() => {});
});
