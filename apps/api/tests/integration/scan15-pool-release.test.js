/**
 * SCAN 15 — THE TEAMS FILES THAT "PASSED, THEN NEVER EXITED".
 *
 * On fix/scan14 a run of teams integration files reported every subtest passing
 * and then failed the FILE on the runner's 180s per-file timeout. Two things are
 * pinned here, because either one produces that symptom:
 *
 *   1. A pooled client checked out on a request path and never released. That is
 *      a production bug, not a test artefact: with DB_POOL_MAX ~10, ten leaks and
 *      every request waits on the pool until the API stalls. Every round-14 teams
 *      path that takes a client (the advisory-locked membership transaction,
 *      including its 402 seat refusal thrown from inside it; the domain door that
 *      spends the joiner's own invitation; accept with its seat rule; removal with
 *      re-home, invitation revocation and the personal-project carry; the
 *      nothing-to-remove early ROLLBACK; the viewer-move refusal) is driven
 *      repeatedly and the pool must return to zero checked-out clients each time.
 *
 *   2. The pool holding the process open while merely IDLE. With allowExitOnIdle
 *      false, a finished file waited idleTimeoutMillis (30s) for its connections to
 *      close — most of a teams file's wall time, and the window a sleeping laptop
 *      turned into a per-file timeout. Under NODE_ENV=test the pool now lets the
 *      process exit once every client is idle (src/config/db.js); a LEAKED client
 *      is not idle, so a leak still holds the process open and still fails here.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/scan15-pool-release.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');
const { invalidateOrgCache } = require('../../src/services/enforcementService');

const ROUNDS = 4;
const q = (sql, params) => db.query(sql, params, 'org-system');

async function makeOrg(label, plan, seats) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : (seats || 5)],
  );
  return orgId;
}

async function makePerson(label, { plan = 'free', domain = 'e2e.test', seats } = {}) {
  const orgId = await makeOrg(label, plan, seats);
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@${domain}`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

function as(method, route, person, ws = null) {
  let r = request(httpServer)[method](route).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

/**
 * Clients checked out of the pool right now. Fire-and-forget writes (product
 * events, audit rows) may still hold one for a moment after a response, so this
 * waits for the pool to settle — a released client comes back within
 * milliseconds; a leaked one never does.
 */
async function settledCheckedOut(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const out = db.pool.totalCount - db.pool.idleCount;
    if ((out === 0 && db.pool.waitingCount === 0) || Date.now() >= deadline) {
      return { out, waiting: db.pool.waitingCount };
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function assertPoolBalanced(where) {
  const { out, waiting } = await settledCheckedOut();
  assert.equal(out, 0, `${where}: ${out} pooled client(s) still checked out — a request path did not release its client`);
  assert.equal(waiting, 0, `${where}: ${waiting} caller(s) still waiting on the pool`);
}

test('every round-14 teams path that takes a pooled client gives it back, refusals included', async () => {
  await assertPoolBalanced('baseline');
  for (let round = 0; round < ROUNDS; round += 1) {
    // The domain door, full: the 402 is THROWN from inside addMember's
    // advisory-locked transaction (seatCheck -> checkLimit).
    const domain = `pool-${uuidv4().slice(0, 6)}.example`;
    const owner = await makePerson('pool-owner', { plan: 'developer_pro', domain, seats: 2 });
    const added = await as('post', '/api/v1/teams/domains', owner, owner.orgId).send({ domain, role: 'member' });
    assert.equal(added.status, 201, JSON.stringify(added.body));

    // The door spending the joiner's OWN invitation (seatCheck.email, FOR UPDATE).
    const invited = await makePerson('pool-invited', { domain });
    const inv = await as('post', '/api/v1/teams/invite', owner, owner.orgId).send({ email: invited.email, role: 'member' });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    const door = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, invited);
    assert.equal(door.status, 200, JSON.stringify(door.body));
    await assertPoolBalanced(`round ${round}: domain door on the joiner's own invitation`);

    const stranger = await makePerson('pool-stranger', { domain });
    const full = await as('post', `/api/v1/teams/joinable/${owner.orgId}/accept`, stranger);
    assert.equal(full.status, 402, JSON.stringify(full.body));
    await assertPoolBalanced(`round ${round}: 402 seat refusal inside the membership transaction`);

    // Accept with the occupancy rule, admitted and refused.
    const team = await makePerson('pool-team', { plan: 'developer_pro', seats: 4 });
    const a = await makePerson('pool-a');
    const b = await makePerson('pool-b');
    const ia = await workspace.createInvite(team.orgId, a.email, { role: 'member', invitedBy: team.userId });
    const ib = await workspace.createInvite(team.orgId, b.email, { role: 'viewer', invitedBy: team.userId });
    const ra = await as('post', '/api/v1/teams/invite/accept', a).send({ token: ia.token });
    assert.equal(ra.status, 200, JSON.stringify(ra.body));
    const rb = await as('post', '/api/v1/teams/invite/accept', b).send({ token: ib.token });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    await assertPoolBalanced(`round ${round}: invitation accept`);

    await q('UPDATE organizations SET purchased_seats = 3 WHERE org_id = $1', [team.orgId]);
    await invalidateOrgCache(team.orgId).catch(() => {});
    const c = await makePerson('pool-c');
    const ic = await workspace.createInvite(team.orgId, c.email, { role: 'member', invitedBy: team.userId });
    const rc = await as('post', '/api/v1/teams/invite/accept', c).send({ token: ic.token });
    assert.equal(rc.status, 409, JSON.stringify(rc.body));
    await assertPoolBalanced(`round ${round}: accept refused on a full team`);

    // A viewer's move is refused before anything is written.
    const own = await as('post', '/api/v1/context/projects', b, b.orgId)
      .send({ project_name: `pool own ${uuidv4().slice(0, 6)}`, current_task: 'x' });
    assert.equal(own.status, 201, JSON.stringify(own.body));
    const moved = await as('post', `/api/v1/teams/projects/${own.body.project.project_id}/move`, b, b.orgId)
      .send({ workspace: team.orgId });
    assert.equal(moved.status, 403, `viewer move: ${moved.status} ${JSON.stringify(moved.body)}`);
    assert.equal(moved.body.error, 'share_write_forbidden');
    await assertPoolBalanced(`round ${round}: viewer move refusal`);

    // Removal: an ordinary member (carry to their own org, invitations revoked),
    // then the same person again (nothing to remove: the early ROLLBACK return).
    const personal = await as('post', '/api/v1/context/projects', a, team.orgId)
      .send({ project_name: `pool personal ${uuidv4().slice(0, 6)}`, current_task: 'x' });
    assert.equal(personal.status, 201, JSON.stringify(personal.body));
    await workspace.createInvite(team.orgId, a.email, { role: 'member', invitedBy: team.userId }).catch(() => null);
    const gone = await workspace.removeMemberAndRehome(team.orgId, a.userId);
    assert.equal(gone.removed, true);
    const again = await workspace.removeMemberAndRehome(team.orgId, a.userId);
    assert.equal(again.removed, false);
    await assertPoolBalanced(`round ${round}: member removal and the no-op removal`);

    // Removal of a founder whose signup org IS the team: re-homed into a new
    // personal workspace inside the same transaction.
    const founder = await makePerson('pool-founder', { plan: 'developer_pro' });
    const co = await makePerson('pool-co');
    const ico = await workspace.createInvite(founder.orgId, co.email, { role: 'owner', invitedBy: founder.userId });
    assert.equal((await workspace.acceptInvite(ico.token, { id: co.userId, email: co.email })).ok, true);
    const removal = await as('delete', `/api/v1/teams/members/${founder.userId}`, co, founder.orgId);
    assert.equal(removal.status, 200, JSON.stringify(removal.body));
    assert.ok(removal.body.rehomed_to);
    await assertPoolBalanced(`round ${round}: founder removal with re-home`);
  }
});

test('under test, an idle pool does not hold the process open (a leaked client still would)', async () => {
  // A child that runs one query and then does nothing: it must exit on its own,
  // promptly. Before, it sat for idleTimeoutMillis (30s) on the idle connection.
  const dbPath = path.resolve(__dirname, '../../src/config/db');
  const script = `
    process.env.NODE_ENV = 'test';
    const db = require(${JSON.stringify(dbPath)});
    db.query('SELECT 1', [], 'org-system').then(() => { process.stdout.write('queried'); })
      .catch((err) => { process.stderr.write(String(err && err.message)); process.exitCode = 2; });
  `;
  const started = Date.now();
  const child = spawn(process.execPath, ['-e', script], {
    env: { ...process.env, NODE_ENV: 'test', DB_ALLOW_EXIT_ON_IDLE: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  const LIMIT_MS = 15000;
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, LIMIT_MS);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  const elapsed = Date.now() - started;
  assert.notEqual(code, 'timeout', `an idle pool held the process open for ${LIMIT_MS}ms+ (stderr: ${err.slice(-300)})`);
  assert.equal(code, 0, `child failed: ${err.slice(-300)}`);
  assert.match(out, /queried/);
  assert.ok(elapsed < LIMIT_MS, `exited after ${elapsed}ms`);
});
