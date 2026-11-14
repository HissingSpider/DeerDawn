/**
 * Portfolio service — the cross-project view and its locked twin.
 *
 * The properties worth pinning, all of which are easy to break by accident:
 *   1. Free and Pro call the SAME endpoint. Free gets its own REAL counts and
 *      loses only the contents. If counts ever came back zeroed or faked for
 *      free accounts, the entire upgrade mechanic would be a lie.
 *   2. Locked rows keep their project_count in the clear. Seeing "4" beside a
 *      redacted row is what makes the number concrete.
 *   3. Locked rows leak no titles, summaries or project names.
 *   4. An entity that is both workspace-scoped AND observed across projects
 *      appears once, as the cross-project row (which carries the project list).
 *   5. The decision timeline merges every project, drops resolved decisions, and
 *      sorts newest-first.
 *
 * Store and entitlements are stubbed — this is about the merge and the gate, not
 * about Postgres.
 */
const test = require('node:test');
const assert = require('node:assert');

const store = require('../../src/store/contextSyncStore');
const entitlementService = require('../../src/services/entitlementService');
const portfolioService = require('../../src/services/portfolioService');

const ACTOR = { org_id: 'org-cccccccc-3333-4333-8333-cccccccccc33', id: 'user-portfolio' };

const PROJECTS = [
  {
    project_id: 'project_alpha',
    project_name: 'Alpha',
    context: {
      recent_decisions: [
        { summary: 'Picked Postgres', decided_at: '2026-08-01T00:00:00.000Z' },
        { summary: 'Dropped the queue', decided_at: '2026-08-20T00:00:00.000Z' },
        { summary: 'Old and settled', decided_at: '2026-07-01T00:00:00.000Z', resolved: true },
      ],
    },
  },
  {
    project_id: 'project_beta',
    project_name: 'Beta',
    context: {
      recent_decisions: [
        { summary: 'Moved auth to Clerk', decided_at: '2026-08-10T00:00:00.000Z' },
      ],
    },
  },
];

const CROSS_PROJECT = [{
  node_id: 'node_shared',
  node_type: 'service',
  canonical_key: 'service:postgres',
  title: 'Postgres',
  summary: 'Primary datastore',
  metadata: { entity_type: 'service', scope: 'workspace' },
  updated_at: '2026-08-20T00:00:00.000Z',
  project_ids: ['project_alpha', 'project_beta'],
  project_count: 2,
  shared_reason: 'cross_project',
}];

const WORKSPACE_SCOPED = [
  // Same node as above — the two store queries overlap by design.
  {
    node_id: 'node_shared',
    node_type: 'service',
    canonical_key: 'service:postgres',
    title: 'Postgres',
    summary: 'Primary datastore',
    metadata: { entity_type: 'service', scope: 'workspace' },
    updated_at: '2026-08-20T00:00:00.000Z',
    project_ids: [],
    project_count: 0,
    shared_reason: 'workspace_scope',
  },
  {
    node_id: 'node_ws_only',
    node_type: 'decision',
    canonical_key: 'decision:no-gradients',
    title: 'No gradients anywhere',
    summary: 'Flat colour only',
    metadata: { entity_type: 'decision', scope: 'workspace' },
    updated_at: '2026-08-19T00:00:00.000Z',
    project_ids: [],
    project_count: 0,
    shared_reason: 'workspace_scope',
  },
];

function stub(portfolioEnabled) {
  store.listProjects = async () => PROJECTS;
  store.listCrossProjectEntities = async () => CROSS_PROJECT;
  store.listWorkspaceScopedEntities = async () => WORKSPACE_SCOPED;
  entitlementService.getEntitlementsForExistingOrg = async () => ({
    tier: portfolioEnabled ? 'developer_basic' : 'free',
    features: { portfolio: portfolioEnabled },
    limits: {},
  });
}

test('Portfolio service', async (t) => {
  await t.test('unlocked: merges entities, dedupes by node_id, keeps project names', async () => {
    stub(true);
    {
      const result = await portfolioService.getPortfolio(ACTOR);
      assert.strictEqual(result.locked, false);
      assert.strictEqual(result.entities.total, 2, 'node_shared must not be counted twice');

      const shared = result.entities.entries.find((e) => e.node_id === 'node_shared');
      assert.ok(shared, 'the shared entity is present');
      assert.strictEqual(shared.shared_reason, 'cross_project',
        'the cross-project row wins the dedup — it is the one carrying the project list');
      assert.deepStrictEqual(shared.projects.map((p) => p.project_name), ['Alpha', 'Beta']);
    }
  });

  await t.test('unlocked: decision timeline merges projects, drops resolved, newest first', async () => {
    stub(true);
    {
      const { decisions } = await portfolioService.getPortfolio(ACTOR);
      assert.strictEqual(decisions.total, 3, 'the resolved decision is excluded');
      assert.deepStrictEqual(
        decisions.entries.map((d) => d.summary),
        ['Dropped the queue', 'Moved auth to Clerk', 'Picked Postgres'],
      );
      assert.strictEqual(decisions.entries[0].project_name, 'Alpha');
    }
  });

  await t.test('locked: counts are the REAL numbers, not zeroes or placeholders', async () => {
    stub(true);
    const unlocked = await portfolioService.getPortfolio(ACTOR);
    stub(false);
    {
      const locked = await portfolioService.getPortfolio(ACTOR);
      assert.strictEqual(locked.locked, true);
      assert.deepStrictEqual(locked.counts, unlocked.counts,
        'the locked state must show exactly the numbers the unlocked state would');
      assert.strictEqual(locked.counts.projects, 2);
      assert.strictEqual(locked.counts.decisions, 3);
      assert.strictEqual(locked.counts.shared_entities, 2);
    }
  });

  await t.test('locked: row counts stay in the clear, everything else is withheld', async () => {
    stub(false);
    {
      const { entities, decisions } = await portfolioService.getPortfolio(ACTOR);
      const row = entities.entries.find((e) => e.project_count === 2);
      assert.ok(row, 'a redacted row still reports how many projects it spans');
      for (const entry of entities.entries) {
        assert.strictEqual(entry.title, undefined, 'no titles leak through the lock');
        assert.strictEqual(entry.summary, undefined);
        assert.strictEqual(entry.projects, undefined, 'no project names leak through the lock');
      }
      for (const entry of decisions.entries) {
        assert.strictEqual(entry.summary, undefined, 'no decision text leaks through the lock');
        assert.strictEqual(entry.project_name, undefined);
      }
      assert.strictEqual(decisions.entries.length, 3, 'the volume withheld is still visible');
    }
  });

  await t.test('search filters entities and decisions together', async () => {
    stub(true);
    {
      const result = await portfolioService.getPortfolio(ACTOR, { query: 'postgres' });
      assert.deepStrictEqual(result.entities.entries.map((e) => e.title), ['Postgres']);
      assert.deepStrictEqual(result.decisions.entries.map((d) => d.summary), ['Picked Postgres']);
    }
  });
});
