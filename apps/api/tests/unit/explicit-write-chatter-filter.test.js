'use strict';

/**
 * A FILTER FOR EXTRACTED CHATTER WAS DELETING THE TASK A PERSON TYPED.
 *
 * isSuspiciousContextText exists to keep connection-test noise ("auth check OK",
 * "connection check only") out of briefs produced by EXTRACTION — a model
 * summarising a session in which somebody was only testing the connector. On the
 * extraction path it deletes the delta key, which is right: the stored brief is
 * left alone.
 *
 * On the EXPLICIT path it did two other things, both wrong:
 *
 *   1. updateProjectContext replaced a matching value with '' — so setting the
 *      task to "Add a smoke test for the billing webhook" over a stored task of
 *      "Ship the teams invite flow" left the project with NO task at all, while
 *      the reply said "Current task NOT changed". A refused value must never
 *      overwrite a good one.
 *
 *   2. The match is a SUBSTRING match against real engineering vocabulary.
 *      "smoke test", "auth check" and "authentication system" are things people
 *      genuinely work on. A person's own words are not chatter, so the explicit
 *      path uses a whole-value check instead: the value is refused only when
 *      there is nothing in it but the test phrase.
 *
 * source_summary keeps the broad filter. It is the extraction's own one-line
 * description of what it saw — machine-written, never a person's sentence — and
 * it is where "The mention of auth probe suggests a focus on authentication"
 * came from.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/explicit-write-chatter-filter.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const workspace = require('../../src/services/workspaceService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const ORG = `org-${crypto.randomUUID()}`;
const USER = `user-chatter-${RUN}`;
const actor = () => ({ org_id: ORG, id: USER, scopes: ['context:read', 'context:write'] });

let project;
const contextOf = async () => (await service.getProject(actor(), project.project_id)).context;

test.before(async () => {
  await workspace.addMember(ORG, USER, { role: 'owner' });
  project = await service.createProject(actor(), { project_name: `Chatter ${RUN}` });
});

test.beforeEach(async () => {
  await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'Ship the teams invite flow',
    current_status: 'Invites send, acceptance is half wired',
    goals: [],
  });
});

test.after(async () => {
  await db.query('DELETE FROM context_sessions WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM context_projects WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', [ORG], 'org-system').catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('a real task that merely contains "smoke test" is stored', async () => {
  const result = await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'Add a smoke test for the billing webhook',
  });
  assert.equal(
    result.context.current_task,
    'Add a smoke test for the billing webhook',
    'THE BUG: a substring match on engineering vocabulary refused a real task',
  );
  assert.deepEqual(result.refused || [], [], 'nothing was refused, so nothing is reported');
});

test('a real task that merely contains "authentication system" is stored', async () => {
  const result = await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'Rework the authentication system for SSO',
  });
  assert.equal(result.context.current_task, 'Rework the authentication system for SSO');
});

// WAVE 3: A TASK A PERSON TYPED IS NOT FILTERED AT ALL.
//
// The whole-value check was still the wrong instrument for THIS field. Wave 2
// stopped it eating "Add a smoke test for the billing webhook"; it went on
// refusing "Run the smoke test" and "Auth check", which are the five-word
// versions of the same real work. A person who types a task and is told the
// server will not take it has been told the product does not store what they
// said, and there is no wording they can retry that fixes it.
//
// So on the EXPLICIT path a task is refused only when there is nothing in it.
// An inferred task keeps the filter — a model summarising a probe session is
// where connection-test wording actually comes from, which is the case the
// filter was written for and the one below.
//
// This test read `current_task: 'auth check OK'` and asserted a refusal. The
// invariants it was really pinning — a refused value never blanks a stored one,
// and a refusal is always reported — are pinned on current_status, which still
// has the filter, and on the inferred-task case.
const TYPED_TASKS = ['Run the smoke test', 'Auth check', 'Smoke test the invite flow', 'auth check OK'];
for (const task of TYPED_TASKS) {
  test(`a task a person typed is stored, whatever wording it uses: "${task}"`, async () => {
    const result = await service.updateProjectContext(actor(), project.project_id, { current_task: task });
    assert.equal(
      result.context.current_task,
      task,
      'THE BUG: the server refused the words a person typed as their task',
    );
    assert.deepEqual(result.refused || [], []);
    assert.equal(result.context.current_task_source, 'explicit');
  });
}

test('an empty task still clears the task rather than being refused', async () => {
  const result = await service.updateProjectContext(actor(), project.project_id, { current_task: '   ' });
  assert.equal(String(result.context.current_task || '').trim(), '');
  assert.deepEqual(result.refused || [], []);
});

test('a task the CALLER marks as inferred is still filtered, and leaves the task alone', async () => {
  const result = await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'auth check OK',
    current_task_source: 'extracted',
  });
  assert.equal(
    result.context.current_task,
    'Ship the teams invite flow',
    'a refused value never blanks the task the project already had',
  );
  const refused = result.refused || [];
  assert.ok(
    refused.some((item) => item.field === 'current_task'),
    'a refusal that is not reported is indistinguishable from a write that landed',
  );
  assert.match(refused[0].reason, /connection/i, 'the reply has to say WHY');
});

// A REFUSED VALUE MUST NOT REACH THE GRAPH EITHER.
//
// Auto-promotion read the RAW patch, so a task the server had just declined was
// promoted as a task entity anyway and came back later under Know in subagent
// briefs — the refusal held in the brief and nowhere else.
test('a refused task is not promoted into the knowledge graph, and one that lands is', async () => {
  // Its own project: promotion is owner-wide and the tasks above are deliberately
  // chatter-shaped, so sharing a board here would prove nothing either way.
  const graphProject = await service.createProject(actor(), { project_name: `Promotion ${RUN}` });
  const titles = async () => (await service.getWorkspaceEntities(actor(), {
    project_id: graphProject.project_id,
    query: 'check',
    limit: 50,
    include_inferred: true,
    track_selection: false,
  })).map((entity) => String(entity.title || '').toLowerCase());

  const refusedResult = await service.updateProjectContext(actor(), graphProject.project_id, {
    current_task: 'connection check only',
    current_task_source: 'extracted',
  });
  assert.ok((refusedResult.refused || []).some((item) => item.field === 'current_task'), 'the value really was refused');
  assert.ok(
    !(await titles()).some((title) => title.includes('connection check')),
    'THE BUG: the refusal held in the brief and the graph promoted the value anyway',
  );

  const kept = `Check the invoice PDF export ${RUN}`;
  await service.updateProjectContext(actor(), graphProject.project_id, { current_task: kept });
  assert.ok(
    (await titles()).some((title) => title.includes(kept.toLowerCase())),
    'a task that IS written is still promoted',
  );
});

test('a refused status leaves the stored status intact', async () => {
  const result = await service.updateProjectContext(actor(), project.project_id, {
    current_status: 'connection check only',
  });
  assert.equal(result.context.current_status, 'Invites send, acceptance is half wired');
  assert.ok((result.refused || []).some((item) => item.field === 'current_status'));
});

test('a refused list entry is named rather than dropped in silence', async () => {
  const result = await service.updateProjectContext(actor(), project.project_id, {
    goals: ['Ship self-serve teams', 'auth probe'],
  });
  assert.deepEqual(result.context.goals, ['Ship self-serve teams'], 'the real goal still lands');
  assert.ok((result.refused || []).some((item) => item.field === 'goals'));
});

test('a stored task is not erased by an unrelated later write', async () => {
  // repairProjectIntegrity re-normalizes the WHOLE stored context on every read
  // and write, so the blanket filter did not only refuse incoming text — it ate
  // text that was already saved, on the next write that touched anything.
  await service.updateProjectContext(actor(), project.project_id, {
    current_task: 'Add a smoke test for the billing webhook',
  });
  await service.updateProjectContext(actor(), project.project_id, {
    current_status: 'Webhook replay is covered',
  });
  const context = await contextOf();
  assert.equal(context.current_task, 'Add a smoke test for the billing webhook');
});

test('extraction chatter is still kept out of the brief', async () => {
  // The filter's actual job, unchanged: a session in which somebody only poked
  // the connector must not rewrite the headline.
  await service.applyExtraction(actor(), {
    session_id: `chatter-${RUN}`,
    tool: 'claude_web',
    chunks: [{ role: 'assistant', text: 'connection check only' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.98,
      project_candidate: { project_id: project.project_id, project_name: project.project_name, reason: 'probe' },
      delta: {
        current_task: 'auth probe',
        source_summary: 'connection check',
        goals: ['Develop authentication system'],
      },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });
  const context = await contextOf();
  assert.equal(context.current_task, 'Ship the teams invite flow', 'extraction may not overwrite a real task with a probe');
  assert.ok(!context.goals.includes('Develop authentication system'));
});

test('a machine-written source_summary about a probe is still scrubbed', async () => {
  const raw = await store.getProject(ORG, project.project_id);
  raw.context.source_summary = 'The mention of auth probe suggests a focus on authentication.';
  await store.saveProject(raw);
  const context = await contextOf();
  assert.equal(context.source_summary, '', 'source_summary is the extraction talking about itself, not a person');
});
