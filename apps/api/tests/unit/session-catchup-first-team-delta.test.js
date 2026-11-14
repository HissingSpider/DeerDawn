/**
 * A NEW TEAMMATE'S FIRST SESSION IS THE ONE THE TEAM DELTA EXISTS FOR.
 *
 * Making "since last session" per person (#479) gave a first-time reader a NULL
 * cutoff, and the attributed filter reads null as "nothing qualifies". So the
 * brief that had to carry somebody else's work carried none — and with it went
 * team_context_received, the team activation event, which can only fire from
 * this path. Signup, connection and first sync were all still true while the
 * thing being sold had never happened.
 *
 * Two workspaces of their own, never the shared 'org-system' sentinel: the solo
 * assertions are about a workspace with exactly one person in it, and another
 * suite leaving a membership row behind would quietly turn that into a team.
 *
 * DB-backed; run via scripts/run-db-test.sh node --test tests/unit/session-catchup-first-team-delta.test.js
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const service = require('../../src/services/contextSyncService');
const store = require('../../src/store/contextSyncStore');
const db = require('../../src/config/db');
const workspace = require('../../src/services/workspaceService');
const { buildSessionCatchup } = require('../../src/services/sessionCatchupService');
const { closeRedisConnections } = require('../../src/config/redis');

const RUN = crypto.randomBytes(4).toString('hex');
const TEAM_ORG = `org-${crypto.randomUUID()}`;
const SOLO_ORG = `org-${crypto.randomUUID()}`;
const ALICE = `user-first-delta-alice-${RUN}`;
const BOB = `user-first-delta-bob-${RUN}`;
const SOLO = `user-first-delta-solo-${RUN}`;
const PEOPLE = [ALICE, BOB, SOLO];
const ORGS = [TEAM_ORG, SOLO_ORG];

const alice = () => ({ type: 'user', id: ALICE, org_id: TEAM_ORG });
const bob = () => ({ type: 'user', id: BOB, org_id: TEAM_ORG });
const solo = () => ({ type: 'user', id: SOLO, org_id: SOLO_ORG });

const DAY = 24 * 3600 * 1000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

async function teamContextReceivedCount(userId, orgId = TEAM_ORG) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS n FROM product_events
      WHERE user_id = $1 AND org_id = $2 AND event_name = 'team_context_received'`,
    [userId, orgId],
    orgId
  );
  return result.rows[0]?.n || 0;
}

// The event is emitted off the request path (setImmediate + an async insert), so
// poll rather than assume it has landed.
async function waitForCount(userId, expected, orgId = TEAM_ORG, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let seen = await teamContextReceivedCount(userId, orgId);
  while (seen !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    seen = await teamContextReceivedCount(userId, orgId);
  }
  return seen;
}

async function clearEvents() {
  await db.query('DELETE FROM product_events WHERE user_id = ANY($1)', [PEOPLE], TEAM_ORG).catch(() => {});
}

test.before(async () => {
  for (const orgId of ORGS) {
    await db.query(
      `INSERT INTO organizations (org_id, name, plan_tier, subscription_status)
       VALUES ($1, 'First-delta fixture', 'starter', 'active')
       ON CONFLICT (org_id) DO NOTHING`,
      [orgId],
      orgId
    );
  }
  // product_events.user_id is a foreign key onto users, so an event for a person
  // who does not exist is silently dropped by the database — and every assertion
  // about team_context_received would read a comfortable zero for the wrong
  // reason.
  for (const [id, orgId] of [[ALICE, TEAM_ORG], [BOB, TEAM_ORG], [SOLO, SOLO_ORG]]) {
    await db.query(
      `INSERT INTO users (user_id, email, role, org_id)
       VALUES ($1, $2, 'admin', $3) ON CONFLICT (user_id) DO NOTHING`,
      [id, `${id}@example.com`, orgId],
      orgId
    );
  }
  await workspace.addMember(TEAM_ORG, ALICE, { role: 'owner' });
  await workspace.addMember(TEAM_ORG, BOB, { role: 'member' });
});

test.after(async () => {
  try {
    await db.query('DELETE FROM product_events WHERE user_id = ANY($1)', [PEOPLE], TEAM_ORG);
    await db.query('DELETE FROM context_session_loads WHERE owner_key = ANY($1)', [ORGS], TEAM_ORG);
    await db.query('DELETE FROM context_projects WHERE owner_key = ANY($1)', [ORGS], TEAM_ORG);
    await db.query('DELETE FROM workspace_members WHERE owner_key = ANY($1)', [ORGS], TEAM_ORG);
    await db.query('DELETE FROM users WHERE user_id = ANY($1)', [PEOPLE], TEAM_ORG);
  } catch (_) { /* best effort */ }
  try { await closeRedisConnections(); } catch (_) { /* best effort */ }
  try { await db.pool?.end?.(); } catch (_) { /* best effort */ }
});

// What Alice has been recording while Bob was not yet on the project.
const aliceContext = () => ({
  current_task: 'ship the trail importer',
  recent_decisions: [
    { summary: 'drop the section allowlist from the share policy', decided_at: ago(2 * DAY), contributed_by: ALICE },
  ],
  shipped: [
    { summary: 'per-person session cutoff', shipped_at: ago(3 * DAY), contributed_by: ALICE },
  ],
  landmines: [
    { summary: 'the graph join has no index on evidence.node_id', added_at: ago(4 * DAY), contributed_by: ALICE },
  ],
});

test('a new teammate\'s FIRST session carries the team delta and activates the team', async () => {
  await clearEvents();
  const project = await service.createProject(alice(), {
    project_name: `FirstSessionTeamDelta ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  // Alice has been here; Bob never has.
  await store.recordSessionLoad(TEAM_ORG, project.project_id, { userId: ALICE, identities: [ALICE] });

  const first = await buildSessionCatchup(
    bob(),
    { project_id: project.project_id, project_name: 'FirstSessionTeamDelta', context: aliceContext() },
    'claude_code'
  );

  assert.ok(first, 'catch-up built for a first session');
  assert.equal(first.session_number, 1, 'it really is Bob\'s first session on this project');
  assert.equal(first.last_session_at, null, 'and he has no prior cutoff');

  assert.ok(first.team_delta, 'the team delta is present on the session it exists for');
  assert.equal(first.team_delta.author_count, 1);
  assert.deepEqual(
    first.team_delta.rows.map((row) => row.summary).sort(),
    [
      'drop the section allowlist from the share policy',
      'per-person session cutoff',
      'the graph join has no index on evidence.node_id',
    ],
    'everything Alice recorded in the recent window reaches him, whatever slot it sat in'
  );
  for (const row of first.team_delta.rows) assert.equal(row.author, ALICE);

  assert.ok(first.text, 'a first session on a shared project is not silent');
  assert.match(first.text, /drop the section allowlist/, 'her work is in the rendered block');
  assert.doesNotMatch(first.text, /While you were away/, 'there was no away to be while');

  // His OWN delta stays honestly empty — he has no history to have a delta from.
  assert.deepEqual(first.since_last_session, { shipped: [], decided: [], landmines: [] });

  assert.equal(await waitForCount(BOB, 1), 1, 'team_context_received fired on the session it can fire on');
});

test('the team activation event does not re-fire on the same person\'s second session', async () => {
  // Continues from the test above deliberately: "once per person per workspace"
  // is a claim about a SECOND delivery, so it can only be tested against the
  // first one having happened. A different project in the same workspace is not
  // a second activation either, which is what the first half here checks.
  const project = await service.createProject(alice(), {
    project_name: `SecondSessionTeamDelta ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });
  await store.recordSessionLoad(TEAM_ORG, project.project_id, { userId: ALICE, identities: [ALICE] });

  const first = await buildSessionCatchup(
    bob(),
    { project_id: project.project_id, project_name: 'SecondSessionTeamDelta', context: aliceContext() },
    'claude_code'
  );
  assert.ok(first.team_delta, 'a first session on another shared project still delivers the delta');
  assert.equal(await waitForCount(BOB, 1), 1, 'still exactly one activation for this person in this workspace');

  const second = await buildSessionCatchup(
    bob(),
    { project_id: project.project_id, project_name: 'SecondSessionTeamDelta', context: aliceContext() },
    'claude_code'
  );
  assert.equal(second.session_number, 2);
  assert.ok(second.team_delta === null || Array.isArray(second.team_delta.rows), 'a second session is a normal catch-up');
  // Give the off-path emission the same chance to land as the first one had.
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(
    await teamContextReceivedCount(BOB),
    1,
    'a teammate\'s every subsequent session is not a new activation — that would make it a usage counter'
  );
});

test('a solo first session is unchanged: no team delta, no text, no event', async () => {
  await clearEvents();
  const project = await service.createProject(solo(), {
    project_name: `SoloFirstSession ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  const first = await buildSessionCatchup(
    solo(),
    {
      project_id: project.project_id,
      project_name: 'SoloFirstSession',
      context: {
        current_task: 'wire the importer',
        recent_decisions: [{ summary: 'use zod for the payload', decided_at: ago(1 * DAY), contributed_by: SOLO }],
      },
    },
    'claude_code'
  );

  assert.ok(first, 'catch-up still builds');
  assert.equal(first.session_number, 1);
  assert.equal(first.team_delta, null, 'nobody else is here');
  assert.equal(first.text, null, 'a first solo session has nothing to catch up on');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await teamContextReceivedCount(SOLO, SOLO_ORG), 0, 'and no team activation was invented');
});

test('a first session on a shared project whose only author is the reader stays silent', async () => {
  await clearEvents();
  const project = await service.createProject(alice(), {
    project_name: `OwnWorkOnly ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  const first = await buildSessionCatchup(
    bob(),
    {
      project_id: project.project_id,
      project_name: 'OwnWorkOnly',
      context: {
        recent_decisions: [{ summary: 'bob\'s own note', decided_at: ago(1 * DAY), contributed_by: BOB }],
      },
    },
    'claude_code'
  );

  assert.equal(first.team_delta, null, 'your own work is not a team delta');
  assert.equal(first.text, null);
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(await teamContextReceivedCount(BOB), 0, 'and reading your own work is not team activation');
});

test('the first-session window is bounded — a project\'s whole life is not replayed', async () => {
  const project = await service.createProject(alice(), {
    project_name: `BoundedWindow ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  const first = await buildSessionCatchup(
    bob(),
    {
      project_id: project.project_id,
      project_name: 'BoundedWindow',
      context: {
        recent_decisions: [
          { summary: 'ancient decision from last year', decided_at: ago(400 * DAY), contributed_by: ALICE },
          { summary: 'recent decision', decided_at: ago(2 * DAY), contributed_by: ALICE },
        ],
      },
    },
    'claude_code'
  );

  assert.deepEqual(
    first.team_delta.rows.map((row) => row.summary),
    ['recent decision'],
    'the delta is recent work, not the archive'
  );
});

// "YOU HAVE NO HISTORY HERE" IS A CLAIM ABOUT THE READER, AND IT CAN BE FALSE.
//
// #510 made team deltas reachable on the hosted connector, which brought this
// header to people it had never been shown to: the project's own AUTHOR, on the
// first session a session row was ever recorded for. Telling somebody they have
// no history on a project they created and filled is the brief being wrong about
// the one thing the reader can check.
//
// Both answers are already in memory — owner_user_id on the project row,
// contributed_by on the entries — so a solo account pays for no extra query.
test('the author is not told they have no history on their own project', async () => {
  await clearEvents();
  const project = await service.createProject(alice(), {
    project_name: `AuthorFirstSession ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  const first = await buildSessionCatchup(
    alice(),
    {
      project_id: project.project_id,
      project_name: 'AuthorFirstSession',
      // owner_user_id rides on every project row resolveActiveProject returns.
      owner_user_id: ALICE,
      context: {
        recent_decisions: [
          { summary: 'alice chose advisory locks', decided_at: ago(3 * DAY), contributed_by: ALICE },
          { summary: 'bob rewired the webhook retry', decided_at: ago(1 * DAY), contributed_by: BOB },
        ],
      },
    },
    'claude_code'
  );

  assert.ok(first.text, 'a teammate has recorded something, so there is still a block');
  assert.match(first.text, /bob rewired the webhook retry/, 'and it carries their work');
  assert.doesNotMatch(
    first.text,
    /you have no history here/,
    'THE BUG: the project\'s own author was told they had never been here',
  );
});

test('a reader who has written here is not told they have no history either', async () => {
  await clearEvents();
  const project = await service.createProject(alice(), {
    project_name: `ContributorFirstSession ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  const first = await buildSessionCatchup(
    bob(),
    {
      project_id: project.project_id,
      project_name: 'ContributorFirstSession',
      owner_user_id: ALICE,
      context: {
        recent_decisions: [{ summary: 'alice chose advisory locks', decided_at: ago(3 * DAY), contributed_by: ALICE }],
        shipped: [{ summary: 'bob shipped the retry policy', shipped_at: ago(2 * DAY), contributed_by: BOB }],
      },
    },
    'claude_code'
  );

  assert.ok(first.text);
  assert.doesNotMatch(first.text, /you have no history here/);
});

test('a genuinely new reader is still told so', async () => {
  await clearEvents();
  const project = await service.createProject(alice(), {
    project_name: `NewReaderFirstSession ${RUN}`, description: 'fixture', goals: [], current_status: '',
  });

  const first = await buildSessionCatchup(
    bob(),
    {
      project_id: project.project_id,
      project_name: 'NewReaderFirstSession',
      owner_user_id: ALICE,
      context: {
        recent_decisions: [{ summary: 'alice chose advisory locks', decided_at: ago(3 * DAY), contributed_by: ALICE }],
      },
    },
    'claude_code'
  );

  assert.ok(first.text);
  assert.match(first.text, /First session on NewReaderFirstSession/);
  assert.match(first.text, /you have no history here/, 'the sentence is right when it is true');
});
