/**
 * A Trail import answers once the brief is saved, not once the graph is.
 *
 * Regression: the entity upsert dedups each node against the owner's whole
 * graph with one embedding call apiece. On a real account that ran past the
 * dashboard's 8s budget — the import landed, the page said it failed, and a
 * retry imported the Trail a second time.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const servicePath = path.resolve(__dirname, '../../src/services/contextSyncService.js');
const calls = { update: null, upsertStarted: false };
let releaseUpsert;
require.cache[servicePath] = {
  id: servicePath,
  filename: servicePath,
  loaded: true,
  exports: {
    getProject: async () => null,
    createProject: async (_actor, { project_name }) => ({ project_id: 'project_new', project_name }),
    updateProjectContext: async (_actor, _id, _patch, options) => { calls.update = options; },
    upsertWorkspaceEntities: () => {
      calls.upsertStarted = true;
      return new Promise((resolve) => { releaseUpsert = () => resolve({ entities: [], relations: [] }); });
    },
  },
};

const trailService = require('../../src/services/trail');
const { buildTrail } = require('../../src/services/trail/trailExport');
const { makeProject } = require('../helpers/trailFixture');

test('import resolves while the graph upsert is still running', async () => {
  const project = makeProject();
  const trail = buildTrail({ project, graph: project.graph, trailId: 'trail_latency', exportedAt: '2026-09-16T00:00:00.000Z' });

  const result = await Promise.race([
    trailService.importTrail({ id: 'user_1' }, trail, { newProjectName: 'Imported' }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('import waited on the graph upsert')), 500)),
  ]);

  assert.strictEqual(result.applied, true);
  assert.strictEqual(result.project_id, 'project_new');
  assert.ok(calls.upsertStarted, 'the graph write must still be started');
  assert.deepStrictEqual(calls.update, { deferAutoPromotion: true });
  assert.ok(result.entities > 0, 'entity count falls back to the plan');
  releaseUpsert();
});
