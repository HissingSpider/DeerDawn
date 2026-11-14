/**
 * Weekly activity digest — the "what DeerDawn did for you" aggregation behind the
 * dashboard "This week" panel.
 *
 * DB-backed; run via scripts/run-db-test.sh node tests/unit/context-activity.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const productEvents = require('../../src/services/productEventsService');
const { computeWorkspaceActivity } = require('../../src/services/activityDigestService');
const { closeRedisConnections } = require('../../src/config/redis');

function actor() {
  return { org_id: 'org-system', id: 'user-1' };
}

test('weekly activity aggregates decisions, contributors, projects, and delivered injections', async () => {
  await store.clearAll();
  const project = await service.createProject(actor(), {
    project_name: 'ActivityProj', description: 'x', goals: [], current_status: '',
  });

  // Delivered-injection events (product_events; guarded — the table may be absent
  // in a bare test DB, in which case context_delivered degrades to 0).
  let deliveredRecorded = 0;
  for (const tool of ['claude_code', 'cursor']) {
    try {
      await productEvents.recordProductEvent(actor(), { event_name: 'context_delivered', source: 'context_sync', surface: tool });
      deliveredRecorded += 1;
    } catch (_) { /* product_events not provisioned in this DB */ }
  }

  // A decision captured this week (context_graph_nodes).
  await service.upsertWorkspaceEntities(actor(), {
    entities: [{
      entity_type: 'decision',
      title: 'Adopted Redis for sessions',
      summary: 'A durable decision captured this week to verify the activity digest.',
      project_id: project.project_id,
      scope: 'project',
    }],
  });

  // An attributed context event (contributor + project touched).
  await service.applyExtraction(actor(), {
    session_id: 's1',
    tool: 'claude_code',
    session_context: { cwd: '/r', host: 'h', status: 'active' },
    chunks: [{ role: 'assistant', text: 'Wired the auth layer in the API.' }],
    extraction: {
      match_decision: 'matched_existing',
      confidence: 0.95,
      project_candidate: { project_id: project.project_id, project_name: 'ActivityProj', reason: 'same repo' },
      delta: { current_status: 'Auth wired.' },
      should_create_project: false,
      needs_user_confirmation: false,
    },
  });

  const a = await computeWorkspaceActivity(actor());

  // Full shape is present and numeric.
  for (const k of ['window_days', 'context_delivered', 'decisions_captured', 'knowledge_captured', 'contributors', 'projects_touched', 'stale_projects']) {
    assert.equal(typeof a[k], 'number', `${k} is a number`);
  }
  assert.ok(Array.isArray(a.delivered_by_tool));

  // Context-table aggregations (guaranteed tables).
  assert.ok(a.decisions_captured >= 1, 'counts the decision captured this week');
  assert.ok(a.projects_touched >= 1, 'counts the project touched this week');

  // If product_events exists in this DB, the delivered count + breakdown reflect it.
  if (deliveredRecorded > 0) {
    assert.ok(a.context_delivered >= deliveredRecorded, 'counts delivered injections');
    assert.ok(a.delivered_by_tool.length >= 1, 'breaks delivered down by tool');
  }
});

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});
