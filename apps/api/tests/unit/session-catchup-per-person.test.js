/**
 * "Since last session" is per PERSON, not per workspace.
 *
 * Every teammate on a shared project writes context_session_loads rows under the
 * same (owner_key, project_id). The catch-up used to take MAX(created_at) over
 * that pair, so Bob starting a session moved Alice's cutoff forward and her next
 * catch-up silently omitted everything that happened between her last session
 * and Bob's. These tests pin the person-scoped read, and that a solo workspace
 * (including its legacy unattributed rows) reads exactly as before.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/session-catchup-per-person.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { buildSessionCatchup } = require('../../src/services/sessionCatchupService');
const { closeRedisConnections } = require('../../src/config/redis');

const OWNER = 'org-system';
const ALICE = 'user-catchup-pp-alice';
const BOB = 'user-catchup-pp-bob';
const alice = () => ({ type: 'user', id: ALICE, org_id: OWNER });
const bob = () => ({ type: 'user', id: BOB, org_id: OWNER });
// Bob reaching the server through an API key rather than a session: the actor id
// is the KEY, and the person is owner_id.
const bobViaKey = () => ({ type: 'key', id: 'key-catchup-pp-bob', owner_id: BOB, org_id: OWNER });

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function leaveWorkspace() {
  await db.query(
    'DELETE FROM workspace_members WHERE owner_key = $1 AND user_id = ANY($2)',
    [OWNER, [ALICE, BOB]],
    OWNER
  ).catch(() => {});
}

async function makeProject(name) {
  return service.createProject(alice(), {
    project_name: name, description: 'catch-up fixture', goals: [], current_status: '',
  });
}

// Move the newest load of `userId` (NULL for an unattributed row) back in time.
async function backdateLatest(projectId, userId, when) {
  await db.query(
    `UPDATE context_session_loads SET created_at = $3
      WHERE load_id = (
        SELECT load_id FROM context_session_loads
         WHERE owner_key = $1 AND project_id = $2 AND user_id IS NOT DISTINCT FROM $4
         ORDER BY created_at DESC LIMIT 1)`,
    [OWNER, projectId, when, userId],
    OWNER
  );
}

test('a teammate starting a session does not move my "since last session" cutoff', async () => {
  await store.clearAll();
  await leaveWorkspace();
  await workspace.addMember(OWNER, ALICE, { role: 'owner' });
  await workspace.addMember(OWNER, BOB, { role: 'member' });
  const project = await makeProject('PerPersonCatchup');

  // Alice was last here three days ago; Bob started a session two days ago.
  await store.recordSessionLoad(OWNER, project.project_id, { userId: ALICE });
  const aliceLast = ago(3 * DAY);
  await backdateLatest(project.project_id, ALICE, aliceLast);
  await store.recordSessionLoad(OWNER, project.project_id, { userId: BOB });
  await backdateLatest(project.project_id, BOB, ago(2 * DAY));

  // Bob decided something between Alice's last visit and his own session start.
  const context = {
    recent_decisions: [
      { summary: 'move the session store to Redis', decided_at: ago(2.5 * DAY), contributed_by: BOB },
    ],
  };
  const catchup = await buildSessionCatchup(
    alice(),
    { project_id: project.project_id, project_name: 'PerPersonCatchup', context },
    'claude_code'
  );

  assert.ok(catchup, 'catch-up built');
  assert.equal(
    Date.parse(catchup.last_session_at),
    Date.parse(aliceLast),
    'the cutoff is Alice\'s own last session, not Bob\'s later one'
  );
  assert.equal(catchup.session_number, 2, 'Bob\'s sessions are not Alice\'s sessions');
  assert.deepEqual(
    catchup.since_last_session.decided,
    ['move the session store to Redis'],
    'the decision Bob made while Alice was away reaches her catch-up'
  );
});

test('a person\'s history spans their credentials, and excludes a teammate\'s rows', async () => {
  await store.clearAll();
  await leaveWorkspace();
  await workspace.addMember(OWNER, ALICE, { role: 'owner' });
  await workspace.addMember(OWNER, BOB, { role: 'member' });
  const project = await makeProject('PerPersonCredentials');

  // Bob once via his session, Alice later, then Bob again through an API key.
  await buildSessionCatchup(bob(), { project_id: project.project_id, context: {} }, 'claude_web');
  const bobFirst = ago(2 * DAY);
  await backdateLatest(project.project_id, BOB, bobFirst);
  await buildSessionCatchup(alice(), { project_id: project.project_id, context: {} }, 'claude_code');
  await backdateLatest(project.project_id, ALICE, ago(1 * DAY));

  const viaKey = await buildSessionCatchup(bobViaKey(), { project_id: project.project_id, context: {} }, 'claude_code');
  assert.equal(viaKey.session_number, 2, 'the key-authed load counts Bob\'s own earlier session and not Alice\'s');
  assert.equal(Date.parse(viaKey.last_session_at), Date.parse(bobFirst));

  const stored = await db.query(
    `SELECT user_id FROM context_session_loads
      WHERE owner_key = $1 AND project_id = $2 ORDER BY created_at ASC`,
    [OWNER, project.project_id],
    OWNER
  );
  assert.deepEqual(
    stored.rows.map((r) => r.user_id),
    [BOB, ALICE, BOB],
    'the PERSON is stored, never the key id'
  );
});

test('a solo workspace reads exactly as before, legacy unattributed rows included', async () => {
  await store.clearAll();
  await leaveWorkspace();
  const project = await makeProject('SoloCatchup');

  // A legacy load with no person on it (an ownerless key), then Alice's own.
  await store.recordSessionLoad(OWNER, project.project_id, { userId: null });
  const legacyAt = ago(5 * DAY);
  await backdateLatest(project.project_id, null, legacyAt);
  await store.recordSessionLoad(OWNER, project.project_id, { userId: ALICE, identities: [ALICE] });
  const aliceLast = ago(1 * DAY);
  await backdateLatest(project.project_id, ALICE, aliceLast);

  const load = await store.recordSessionLoad(OWNER, project.project_id, { userId: ALICE, identities: [ALICE] });
  assert.equal(load.session_number, 3, 'unattributed history still counts for the solo person');
  assert.equal(Date.parse(load.last_session_at), Date.parse(aliceLast));
  assert.equal(Date.parse(load.first_session_at), Date.parse(legacyAt));

  // No person resolves (an internal actor): the read stays workspace-wide.
  const internal = await store.recordSessionLoad(OWNER, project.project_id, { userId: null });
  assert.equal(internal.session_number, 4);
});

test('the person-scoped read has an index that leads with owner, project and person', async () => {
  // Source first: a shared dev database keeps an index created by an earlier run,
  // so the catalog alone cannot prove this checkout still creates it.
  const source = require('node:fs').readFileSync(require.resolve('../../src/store/contextSyncStore'), 'utf8');
  assert.match(
    source,
    /idx_context_session_loads_owner_project_user ON context_session_loads\(owner_key, project_id, user_id, created_at DESC\)/
  );
  await store.getSessionLoadStats(OWNER); // runs ensureSchema
  const result = await db.query(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'context_session_loads'
        AND indexname = 'idx_context_session_loads_owner_project_user'`,
    [],
    OWNER
  );
  assert.equal(result.rows.length, 1, 'index exists');
  assert.match(result.rows[0].indexdef, /\(owner_key, project_id, user_id, created_at DESC\)/);
});

test.after(async () => {
  try { await store.clearAll(); } catch (_) { /* best effort */ }
  try { await leaveWorkspace(); } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
  try { await db.pool?.end?.(); } catch (_) { /* best effort */ }
});
