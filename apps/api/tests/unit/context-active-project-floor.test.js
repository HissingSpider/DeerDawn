/**
 * Engine Wave 3: active-project selection must not pick a project on recency alone.
 *
 * resolveActiveProject ranks candidates with scoreProjectForCwd (path > name >
 * recency tiebreak) and now SKIPS recency_fallback candidates — so a directory
 * with no linked-path and no name match falls back to the global-only brief
 * instead of confidently surfacing the most-recently-touched (wrong) project.
 * These pure tests guard the scorer ordering and the matchKind classification the
 * floor keys off. Pure (no DB).
 *
 * Run: node tests/unit/context-active-project-floor.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  scoreProjectForCwd,
  matchKindForCwd,
} = require('../../src/services/contextSyncService.js');
const { closeRedisConnections } = require('../../src/config/redis');

test.after(async () => {
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
});

const CWD = '/Users/dev/code/deerdawn';
const OLD = '2020-01-01T00:00:00.000Z';
const NEW = '2030-01-01T00:00:00.000Z';

const pathMatch = { project_id: 'p_path', project_name: 'Anything', linked_paths: ['/Users/dev/code/deerdawn'], updated_at: OLD };
const nameMatch = { project_id: 'p_name', project_name: 'DeerDawn', linked_paths: [], updated_at: OLD };
const recencyOnly = { project_id: 'p_recent', project_name: 'Unrelated Stream', linked_paths: [], updated_at: NEW };

test('scorer ranks path > name > recency-only', () => {
  const sPath = scoreProjectForCwd(pathMatch, CWD);
  const sName = scoreProjectForCwd(nameMatch, CWD);
  const sRecency = scoreProjectForCwd(recencyOnly, CWD);
  assert.ok(sPath > sName, 'path beats name');
  assert.ok(sName > sRecency, 'name beats recency-only even when recency-only is far newer');
});

test('matchKind classifies path / name / recency_fallback', () => {
  assert.equal(matchKindForCwd(pathMatch, CWD).kind, 'path');
  assert.equal(matchKindForCwd(nameMatch, CWD).kind, 'name');
  assert.equal(matchKindForCwd(recencyOnly, CWD).kind, 'recency_fallback');
});

test('a deeper monorepo sub-package linked path outranks the repo root', () => {
  const root = { project_id: 'root', project_name: 'x', linked_paths: ['/Users/dev/code/deerdawn'], updated_at: OLD };
  const sub = { project_id: 'sub', project_name: 'x', linked_paths: ['/Users/dev/code/deerdawn/apps/api'], updated_at: OLD };
  const subCwd = '/Users/dev/code/deerdawn/apps/api';
  assert.ok(scoreProjectForCwd(sub, subCwd) > scoreProjectForCwd(root, subCwd), 'deepest linked path wins');
});

test('workspace match is a real signal: outranks name+recency, classifies as workspace', () => {
  const ws = 'remote:github.com/org/deerdawn';
  // A sibling work-stream in the same repo, in a dir it has no path/name match for.
  const sibling = { project_id: 'p_ws', project_name: 'Audit Stream', linked_paths: [], workspace_key: ws, updated_at: OLD };
  const otherRepoRecent = { project_id: 'p_other', project_name: 'Other', linked_paths: [], updated_at: NEW };
  const otherCwd = '/Users/dev/code/somerepo';
  assert.ok(scoreProjectForCwd(sibling, otherCwd, ws) > scoreProjectForCwd(otherRepoRecent, otherCwd, ws), 'same-workspace beats recency-only');
  assert.equal(matchKindForCwd(sibling, otherCwd, ws).kind, 'workspace');
  assert.equal(matchKindForCwd(otherRepoRecent, otherCwd, ws).kind, 'recency_fallback');
});

test('a precise linked-path match still outranks a workspace match', () => {
  const ws = 'remote:github.com/org/deerdawn';
  const pathProj = { project_id: 'p_path', project_name: 'x', linked_paths: [CWD], workspace_key: ws, updated_at: OLD };
  const wsProj = { project_id: 'p_ws', project_name: 'x', linked_paths: [], workspace_key: ws, updated_at: NEW };
  assert.ok(scoreProjectForCwd(pathProj, CWD, ws) > scoreProjectForCwd(wsProj, CWD, ws), 'path beats workspace');
  assert.equal(matchKindForCwd(pathProj, CWD, ws).kind, 'path');
});

test('the wrong-project regression: recency-only never out-scores a name match', () => {
  // The exact bug — a freshly-touched unrelated work-stream vs the repo-named
  // project, in the repo dir. The name match must win, and the recency-only one
  // must classify as recency_fallback (which resolveActiveProject skips).
  assert.ok(scoreProjectForCwd(nameMatch, CWD) > scoreProjectForCwd(recencyOnly, CWD));
  assert.equal(matchKindForCwd(recencyOnly, CWD).kind, 'recency_fallback');
});
