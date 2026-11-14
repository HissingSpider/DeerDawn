/**
 * The brief led with stale run-logs, and this is where they got their rank.
 *
 * Every structured event that lands in the decision log goes through a floor:
 * `decision_made`, `question_answered`, `feature_shipped`. Each one defaulted its
 * entry to `high`. The decision ranker put every `high` above every `normal`
 * with no decay, so the floor's output — which includes whatever a scheduled
 * agent files every hour — permanently outranked anything a person wrote by
 * hand without remembering to mark it. `high` meant "arrived through the API".
 *
 * Pinned here, as behaviour:
 *   1. the floors default to `normal`, and still honour an importance the
 *      caller actually sent;
 *   2. a floor entry with a long summary is stored with a `headline` (<= 200),
 *      a short one is not written twice;
 *   3. read back through the decisions section, this morning's unmarked
 *      decision leads a month-old `high` one, and a 4,000-character summary
 *      does not print in full;
 *   4. the auto-promoted decision ENTITY mirrors its decision's importance
 *      instead of claiming `high`;
 *   5. rankWorkspaceNodes orders on the unclamped score.
 *
 * DB-backed (1-3); run via scripts/run-db-test.sh.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const { formatSectionInjection } = require('../../../../packages/shared-context/src/index.js');

const solo = () => ({ org_id: 'org-system', id: 'user-solo' });

async function freshProject(context = {}) {
  await store.clearAll();
  await db.query('DELETE FROM workspace_members WHERE owner_key = $1', ['org-system'], 'org-system').catch(() => {});
  const project = await service.createProject(solo(), {
    project_name: 'FloorProj',
    description: 'structured-event floors',
    goals: [],
    current_status: '',
  });
  if (Object.keys(context).length) {
    await service.updateProjectContext(solo(), project.project_id, context);
  }
  return project;
}

async function fire(project, eventType, summary, metadata = {}) {
  return service.applyStructuredContextEvent(solo(), {
    project_id: project.project_id,
    event_type: eventType,
    summary,
    source_tool: 'claude_code',
    metadata,
  }, { deferAutoPromotion: true });
}

async function decisionBySummary(project, summary) {
  const read = await service.getProject(solo(), project.project_id);
  return (read.context.recent_decisions || []).find((d) => d.summary === summary);
}

for (const [eventType, metadata] of [
  ['decision_made', {}],
  ['feature_shipped', {}],
  ['question_answered', { question: 'Which queue do we use?' }],
]) {
  test(`${eventType}: the floor files an unmarked entry as normal, not high`, async () => {
    const project = await freshProject();
    const summary = `Floor entry filed by ${eventType} with no importance`;
    await fire(project, eventType, summary, metadata);
    const stored = await decisionBySummary(project, summary);
    assert.ok(stored, 'the entry was stored');
    assert.equal(stored.importance, 'normal');
  });

  test(`${eventType}: an importance the caller sent is still honoured`, async () => {
    const project = await freshProject();
    const summary = `Floor entry filed by ${eventType} marked critical`;
    await fire(project, eventType, summary, { ...metadata, importance: 'critical' });
    assert.equal((await decisionBySummary(project, summary)).importance, 'critical');
  });
}

test('a floor entry with a long summary is stored with a headline; a short one is not doubled', async () => {
  const project = await freshProject();
  const long = `Hourly growth run finished with nothing to report. ${'Checked the funnel and the ads. '.repeat(120)}`.trim();
  await fire(project, 'feature_shipped', long);
  await fire(project, 'decision_made', 'Keep Postgres as the queue');

  const longStored = await decisionBySummary(project, long);
  assert.ok(longStored.headline, 'a long floor entry carries a headline');
  assert.ok(longStored.headline.length <= 200, `headline was ${longStored.headline.length} chars`);
  assert.match(longStored.headline, /^Hourly growth run finished/);

  const shortStored = await decisionBySummary(project, 'Keep Postgres as the queue');
  assert.equal(shortStored.headline, undefined, 'a one-line decision is its own headline');
});

test('read back: this morning\'s unmarked decision leads a month-old high run-log, clipped', async () => {
  const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  // Rows exactly as the old floor wrote them: `high`, no headline, enormous.
  const project = await freshProject({
    recent_decisions: [1, 2, 3].map((n) => ({
      summary: `Run-log ${n}: nothing changed. ${'Same as the last run. '.repeat(190)}RUNLOG-TAIL-${n}`,
      decided_at: monthAgo,
      importance: 'high',
    })),
  });
  await fire(project, 'decision_made', 'Move the digest cron to 07:00 UTC');

  const read = await service.getProject(solo(), project.project_id);
  const out = formatSectionInjection(read.context, ['decisions'], null);
  const lines = out.split('\n').filter((l) => l.startsWith('  - '));
  assert.match(lines[0], /Move the digest cron/, `the fresh decision leads; got: ${lines[0].slice(0, 80)}`);
  assert.doesNotMatch(out, /RUNLOG-TAIL/, 'a 4,000-char summary is not printed whole');
  for (const line of lines) assert.ok(line.length <= 250, `line was ${line.length} chars`);
});

test('the auto-promoted decision entity mirrors its decision instead of claiming high', () => {
  const entities = service.buildAutoPromotedMemoryEntities(
    { project_id: 'p1' },
    { confidence: 0.9, delta: { recent_decisions: [
      { summary: 'unmarked decision' },
      { summary: 'marked decision', importance: 'critical' },
    ] } },
    new Date().toISOString(),
  ).filter((e) => e.entity_type === 'decision');
  assert.equal(entities.find((e) => e.title === 'unmarked decision').metadata.importance, 'normal');
  assert.equal(entities.find((e) => e.title === 'marked decision').metadata.importance, 'critical');
});

test('rankWorkspaceNodes orders active-project nodes on the unclamped score', () => {
  // Both belong to the active project, so both sum well past 1. Clamped before
  // the sort they tie at exactly 1.0 and come back in INPUT order — with the
  // pinned, critical, query-matching node last.
  const base = { node_type: 'knowledge', summary: '', confidence: 0.9, project_id: 'P1' };
  const plain = { ...base, node_id: 'plain', canonical_key: 'knowledge:plain', title: 'Unrelated note', metadata: { memory_tier: 'durable' } };
  const strong = {
    ...base,
    node_id: 'strong',
    canonical_key: 'knowledge:strong',
    title: 'Stripe webhook retries',
    metadata: { memory_tier: 'durable', importance: 'critical', pinned: true },
  };
  const ranked = service.rankWorkspaceNodes([plain, strong], { projectId: 'P1', query: 'stripe webhook' });
  assert.equal(ranked[0].node_id, 'strong');
  // Clamped for output: readers compare this against fixed floors.
  for (const n of ranked) assert.ok(n._ranking_score >= 0 && n._ranking_score <= 1, `score ${n._ranking_score}`);
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
