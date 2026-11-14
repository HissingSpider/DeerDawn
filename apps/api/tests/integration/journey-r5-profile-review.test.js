/**
 * JOURNEY ROUND 5. A profile that existed before extraction stopped filling it
 * may hold lines lifted from the person's projects. Nothing is deleted; the
 * dashboard You page shows a one-time note asking the person to check it.
 *
 * The marker is context_globals.profile_reviewed_at: NULL on a row with data
 * means "not yet looked at". It is set when the person dismisses the note or
 * saves their profile (PATCH /context/global), and by nothing else.
 *
 * DB-backed:
 *   bash scripts/run-db-test.sh node --test tests/integration/journey-r5-profile-review.test.js
 */

process.env.NODE_ENV = 'test';
process.env.SKIP_RATE_LIMIT = 'true';
if (!process.env.ENCRYPTION_MASTER_KEY) process.env.ENCRYPTION_MASTER_KEY = 'ab'.repeat(32);

const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { v4: uuidv4 } = require('uuid');
const app = require('../../src/app');

const httpServer = app.listen(0);
test.after(() => new Promise((resolve) => httpServer.close(resolve)));

const db = require('../../src/config/db');
const { hashPassword, generateToken } = require('../../src/utils/security');
const workspace = require('../../src/services/workspaceService');

const q = (sql, params) => db.query(sql, params, 'org-system');

async function makePerson(label, { plan = 'free' } = {}) {
  const orgId = `org-${uuidv4()}`;
  await q(
    'INSERT INTO organizations (org_id, name, plan, plan_tier, subscription_status, purchased_seats) VALUES ($1, $2, $3, $4, $5, $6)',
    [orgId, `${label} workspace`, plan, plan, 'active', plan === 'free' ? null : 5],
  );
  const userId = `user-${uuidv4()}`;
  const email = `${label}-${uuidv4().slice(0, 8)}@e2e.test`;
  await q(
    'INSERT INTO users (user_id, email, password_hash, role, org_id) VALUES ($1, $2, $3, $4, $5)',
    [userId, email, await hashPassword('password123'), 'admin', orgId],
  );
  await workspace.ensureOwnerMembership(orgId, userId);
  const jwt = generateToken({ user_id: userId, org_id: orgId, role: 'admin', email });
  return { label, orgId, userId, email, jwt };
}

function as(method, path, person, ws = null) {
  let r = request(httpServer)[method](path).set('Authorization', `Bearer ${person.jwt}`);
  if (ws) r = r.set('x-deerdawn-workspace', ws);
  return r;
}

async function join(owner, joiner, role = 'member') {
  const invite = await workspace.createInvite(owner.orgId, joiner.email, { role, invitedBy: owner.userId });
  const accepted = await workspace.acceptInvite(invite.token, { id: joiner.userId, email: joiner.email });
  assert.ok(accepted.ok, accepted.reason);
}

const stored = (person, global) => q(
  `INSERT INTO context_globals (owner_key, person_id, global, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
   ON CONFLICT (owner_key, person_id) DO UPDATE SET global = EXCLUDED.global`,
  [person.orgId, person.userId, JSON.stringify(global)],
);
const review = async (person, ws = person.orgId) => {
  const res = await as('get', '/api/v1/context/global', person, ws);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.review_needed;
};

test('a profile that existed before the change, with data, asks to be reviewed once', async () => {
  const P = await makePerson('r5rev');
  await stored(P, { goals: ['leave the company by November'], updated_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(await review(P), true, 'THE GAP: no review note for a profile that may hold lines lifted from projects');
  // Reading it does not clear it.
  assert.equal(await review(P), true);
  const dismissed = await as('post', '/api/v1/context/global/review', P, P.orgId).send({});
  assert.equal(dismissed.status, 200, JSON.stringify(dismissed.body));
  assert.equal(await review(P), false);
  assert.equal(await review(P), false, 'never again once dismissed');
  // Nothing was deleted.
  const global = (await as('get', '/api/v1/context/global', P, P.orgId)).body.global;
  assert.deepEqual(global.goals, ['leave the company by November']);
});

test('saving the profile settles the note, and a profile written after the change never shows it', async () => {
  const P = await makePerson('r5rev2');
  await stored(P, { working_style: 'terse', updated_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(await review(P), true);
  const saved = await as('patch', '/api/v1/context/global', P, P.orgId).send({ user_profile: 'Founder.' });
  assert.equal(saved.status, 200);
  assert.equal(await review(P), false);

  const fresh = await makePerson('r5rev3');
  assert.equal(await review(fresh), false, 'nothing stored: nothing to check');
  await as('patch', '/api/v1/context/global', fresh, fresh.orgId).send({ goals: ['ship v2'] });
  assert.equal(await review(fresh), false, 'their own explicit save is reviewed by definition');
});

test('an empty profile row does not ask for review, and the note is per person', async () => {
  const P = await makePerson('r5rev4');
  await stored(P, { goals: [], preferences: [], user_profile: '', updated_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(await review(P), false);

  const O = await makePerson('r5rev5', { plan: 'developer_pro' });
  const M = await makePerson('r5rev6');
  await join(O, M);
  await stored({ ...O, orgId: O.orgId, userId: O.userId }, { goals: ['old goal'] });
  assert.equal(await review(O), true);
  assert.equal(await review(M, O.orgId), false, 'a colleague\'s unreviewed profile is not mine to review');
  await as('post', '/api/v1/context/global/review', M, O.orgId).send({});
  assert.equal(await review(O), true, 'and my colleague dismissing theirs does not settle mine');
});

test('a profile that is carried home when its person leaves a team keeps its review state', async () => {
  const ann = await makePerson('r5rev7', { plan: 'developer_pro' });
  const lee = await makePerson('r5rev8');
  await join(ann, lee);
  // An unchecked profile stored under the team.
  await q(
    'INSERT INTO context_globals (owner_key, person_id, global, updated_at) VALUES ($1, $2, $3::jsonb, NOW())',
    [ann.orgId, lee.userId, JSON.stringify({ goals: ['carried goal'] })],
  );
  const left = await as('delete', `/api/v1/teams/members/${lee.userId}`, lee, ann.orgId);
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.profile_moved, true, JSON.stringify(left.body));
  assert.equal(await review(lee), true, 'still unchecked at home');
  await as('post', '/api/v1/context/global/review', lee, lee.orgId).send({});
  assert.equal(await review(lee), false);
});

test('the automatic profile seed never clears the note; only the person\'s own save or dismissal does', async () => {
  const P = await makePerson('r5rev9');
  await stored(P, { goals: ['lifted goal'], updated_at: '2026-09-01T00:00:00.000Z' });
  assert.equal(await review(P), true);
  // What the local first-run seed sends (a file about the person, unattended).
  const seeded = await as('patch', '/api/v1/context/global', P, P.orgId).send({ user_profile: 'Staff engineer', source: 'seed' });
  assert.equal(seeded.status, 200, JSON.stringify(seeded.body));
  assert.equal(seeded.body.global.user_profile, 'Staff engineer', 'the seed still writes');
  assert.equal(await review(P), true, 'THE GAP: an automatic write cleared the note');
  // The person\'s own explicit save does.
  await as('patch', '/api/v1/context/global', P, P.orgId).send({ working_style: 'terse' });
  assert.equal(await review(P), false);

  // A profile the seed creates from nothing has nothing pre-existing to check.
  const fresh = await makePerson('r5rev10');
  await as('patch', '/api/v1/context/global', fresh, fresh.orgId).send({ user_profile: 'New here', source: 'seed' });
  assert.equal(await review(fresh), false);

  // The seed over an already-reviewed profile leaves it reviewed.
  await as('patch', '/api/v1/context/global', fresh, fresh.orgId).send({ goals: ['mine'], source: 'seed' });
  assert.equal(await review(fresh), false);
});
