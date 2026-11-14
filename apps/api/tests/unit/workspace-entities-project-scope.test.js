/**
 * getWorkspaceEntities — `scope: 'project'` must actually scope to the project.
 *
 * The bug this guards, measured against live data 2026-08-28: asking for one
 * project's entities returned another project's. `project_id` was consumed only
 * as a RANKING hint, `related_project_id` was the sole filter and is not
 * reachable through the `recall` tool, and the scope test below it keeps any node
 * carrying any project_id — from any project. So `scope: 'project'` filtered
 * nothing, and two completely unrelated projects came back with an identical
 * list belonging to whichever project had the most nodes.
 *
 * The two halves both matter and pull in opposite directions:
 *   - project_id ALONE must stay a hint. getNextBestContext and the subagent
 *     brief pass it while deliberately wanting owner-wide candidates biased
 *     toward the current project; making it filter silently narrows both.
 *   - project_id WITH scope:'project' can only mean one thing, and must filter.
 *
 * Store is stubbed — this is about which projectId reaches the query.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const store = require('../../src/store/contextSyncStore');
const service = require('../../src/services/contextSyncService');

const ACTOR = { org_id: 'org-77777777-8888-4999-8aaa-bbbbbbbbbbbb', id: 'user-scope' };

// Records what listGraphNodes was asked to filter on, and answers with nodes
// that belong to that filter so the downstream scope test behaves realistically.
function captureProjectFilter(run) {
  const original = store.listGraphNodes;
  const calls = [];
  store.listGraphNodes = async (ownerKey, options = {}) => {
    calls.push(options.projectId ?? null);
    return [
      {
        node_id: 'n1',
        node_type: 'decision',
        canonical_key: 'k1',
        title: 'Node in ' + (options.projectId || 'any project'),
        summary: '',
        project_id: options.projectId || 'p_unrelated',
        metadata: {},
        confidence: 0.9,
        updated_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
      },
    ];
  };
  return run(calls).finally(() => { store.listGraphNodes = original; });
}

test('scope:"project" with a project_id filters to that project', async () => {
  await captureProjectFilter(async (calls) => {
    await service.getWorkspaceEntities(ACTOR, {
      scope: 'project',
      project_id: 'p_redqueen',
      limit: 5,
    }).catch(() => null);
    assert.equal(calls[0], 'p_redqueen', 'scope:"project" did not reach the query as a filter');
  });
});

test('project_id alone stays a ranking hint, not a filter', async () => {
  await captureProjectFilter(async (calls) => {
    await service.getWorkspaceEntities(ACTOR, {
      project_id: 'p_redqueen',
      limit: 5,
    }).catch(() => null);
    assert.equal(
      calls[0],
      null,
      'project_id became a filter — this silently narrows getNextBestContext and the subagent brief'
    );
  });
});

test('an explicit related_project_id still wins over the scoped project', async () => {
  await captureProjectFilter(async (calls) => {
    await service.getWorkspaceEntities(ACTOR, {
      scope: 'project',
      project_id: 'p_redqueen',
      related_project_id: 'p_explicit',
      limit: 5,
    }).catch(() => null);
    assert.equal(calls[0], 'p_explicit', 'related_project_id has always meant "filter" and must keep winning');
  });
});
