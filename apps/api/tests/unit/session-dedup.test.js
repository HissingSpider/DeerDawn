/**
 * Cross-connection session-load dedup.
 *
 * A user can have DeerDawn connected via more than one surface at once (e.g. the
 * claude.ai connector AND a local Claude Code MCP). checkAndMarkSessionLoad lets
 * the second start_session within the window return a compact "already loaded"
 * pointer instead of repeating the full brief. Keyed by (user, project) so a
 * different project never collides, and different surfaces are reported so the
 * message can say "via your other DeerDawn connection".
 *
 * Uses the in-memory Redis stub (NODE_ENV=test). No DB required.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkAndMarkSessionLoad, markerKey } = require('../../src/services/sessionDedup');

function actor(id = 'user-dedup-1') {
  return { id, org_id: id };
}

// The pairs below used to be two claude_code loads. Two LOCAL loads are two
// processes, never one host's two connections, and counting them as a duplicate
// withheld a real session's brief (see session-dedup-surfaces.test.js). Each
// pair now has a hosted connection on one side, the pair the dedup exists for,
// so the tests that expect "not a duplicate" still fail if the key collides.
test('first load is not a duplicate; second load for same user+project is', async () => {
  const a = actor('user-A');
  const first = await checkAndMarkSessionLoad(a, 'proj-1', 'claude_web');
  assert.equal(first.duplicate, false, 'first load is fresh');

  const second = await checkAndMarkSessionLoad(a, 'proj-1', 'claude_code');
  assert.equal(second.duplicate, true, 'second load within window is a duplicate');
  assert.ok(Number.isFinite(second.secondsAgo), 'reports how long ago');
});

test('a different project for the same user does not collide', async () => {
  const a = actor('user-B');
  await checkAndMarkSessionLoad(a, 'proj-x', 'claude_code');
  const other = await checkAndMarkSessionLoad(a, 'proj-y', 'claude_web');
  assert.equal(other.duplicate, false, 'distinct project is independent');
});

test('a different user does not collide', async () => {
  await checkAndMarkSessionLoad(actor('user-C'), 'shared-proj', 'claude_code');
  const otherUser = await checkAndMarkSessionLoad(actor('user-D'), 'shared-proj', 'claude_web');
  assert.equal(otherUser.duplicate, false, 'markers are scoped per user');
});

test('reports the other surface when the duplicate comes from a different connection', async () => {
  const a = actor('user-E');
  await checkAndMarkSessionLoad(a, 'proj-2', 'claude_code'); // local MCP loads first
  const viaConnector = await checkAndMarkSessionLoad(a, 'proj-2', 'claude_web'); // claude.ai connector second
  assert.equal(viaConnector.duplicate, true);
  assert.equal(viaConnector.otherSurface, 'claude_code', 'surfaces the other connection');
});

test('same surface duplicate does not claim a different connection', async () => {
  const a = actor('user-F');
  await checkAndMarkSessionLoad(a, 'proj-3', 'claude_web');
  const same = await checkAndMarkSessionLoad(a, 'proj-3', 'claude_web');
  assert.equal(same.duplicate, true);
  assert.equal(same.otherSurface, null, 'no cross-connection claim for same surface');
});

// ── Per person, not per workspace ────────────────────────────────────────────
// Real actors on a shared workspace all resolve to the SAME owner_key. The marker
// used to be keyed by that alone, so a teammate's start_session inside the window
// was reported as Alice's duplicate, which skipped her catch-up and session
// accounting. These actors carry the shapes the auth middleware actually mints.
const teammate = (id) => ({ type: 'user', id, org_id: 'org-team-dedup', workspace_key: 'org-team-dedup' });

test('a teammate starting on the same shared project does not suppress my session', async () => {
  const first = await checkAndMarkSessionLoad(teammate('user-bob-dd'), 'shared-team-proj', 'claude_code');
  assert.equal(first.duplicate, false);
  const mine = await checkAndMarkSessionLoad(teammate('user-alice-dd'), 'shared-team-proj', 'claude_web');
  assert.equal(mine.duplicate, false, 'Bob\'s marker is not Alice\'s');
});

test('the same person twice inside the window is still a duplicate, across credentials', async () => {
  const viaSession = teammate('user-carol-dd');
  const viaKey = { type: 'key', id: 'key-carol-dd', owner_id: 'user-carol-dd', org_id: 'org-team-dedup', workspace_key: 'org-team-dedup' };
  await checkAndMarkSessionLoad(viaSession, 'shared-team-proj-2', 'claude_web');
  const again = await checkAndMarkSessionLoad(viaKey, 'shared-team-proj-2', 'claude_code');
  assert.equal(again.duplicate, true, 'one person through two connections is one session');
  assert.equal(again.otherSurface, 'claude_web');
});

test('with no person, the marker keeps its workspace-level key', () => {
  assert.equal(markerKey({ id: 'org-internal-dd' }, 'p1'), 'dd:ss:org-internal-dd:p1');
  assert.equal(markerKey({ type: 'system', id: 'system-key', org_id: 'org-system' }, 'p1'), 'dd:ss:org-system:p1');
  assert.equal(markerKey({ type: 'key', id: 'key-x', owner_id: null, org_id: 'org-y' }, null), 'dd:ss:org-y:workspace');
});
