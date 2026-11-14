/**
 * The referral cap is a rolling window on signups that never activated.
 *
 * countReferralGrants counted every 'signed_up' row for all time. The referred
 * side is paid at signup, so those rows do have to count — a farmer's puppets
 * never activate — but counted FOREVER they also meant an honest referrer whose
 * first few invitees signed up and drifted away was locked out of the programme
 * permanently, with nothing they could do to clear it. A window bounds the same
 * abuse (CAP free months per window) without the life sentence.
 *
 * The rule is in SQL, so it is tested against a real database:
 *   bash scripts/run-db-test.sh node --test tests/integration/referral-cap-window.test.js
 */

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const db = require('../../src/config/db');
const { closeRedisConnections } = require('../../src/config/redis');
const referralService = require('../../src/services/referralService');

const ORG = `org-${uuidv4()}`;
const REFERRER = `user-referrer-${uuidv4().slice(0, 8)}`;

async function addReferral(status, ageDays) {
  await db.query(
    `INSERT INTO referrals
       (referral_id, referral_code, referrer_user_id, referrer_org_id, referred_user_id, referred_org_id, status, created_at, updated_at)
     VALUES ($1, 'WINDOW1', $2, $3, $4, $3, $5, NOW() - make_interval(days => $6), NOW())`,
    [`ref-${uuidv4()}`, REFERRER, ORG, `user-referred-${uuidv4().slice(0, 8)}`, status, ageDays],
    'org-system',
  );
}

test.before(async () => {
  await db.query(
    'INSERT INTO organizations (org_id, name, subscription_status) VALUES ($1, $2, $3)',
    [ORG, 'Referral window', 'active'],
    ORG,
  );
});

test.after(async () => {
  await db.query('DELETE FROM referrals WHERE referrer_org_id = $1', [ORG], 'org-system').catch(() => {});
  await db.query('DELETE FROM organizations WHERE org_id = $1', [ORG], ORG).catch(() => {});
  await closeRedisConnections().catch(() => {});
});

test('signups that never activated stop counting against the cap once they age out', async () => {
  for (let i = 0; i < referralService.REFERRAL_REWARDED_CAP; i += 1) await addReferral('signed_up', 200);
  const grants = await referralService.countReferralGrants(REFERRER);
  assert.equal(
    grants.granted,
    0,
    'THE BUG: invitees who signed up seven months ago and never came back still hold the referrer at the cap',
  );
});

test('recent signups still count, so a farmer is still bounded', async () => {
  await addReferral('signed_up', 3);
  await addReferral('signed_up', 40);
  const grants = await referralService.countReferralGrants(REFERRER);
  assert.equal(grants.granted, 2);
});

test('a referral that activated or was rewarded counts however old it is', async () => {
  await addReferral('activated', 400);
  await addReferral('rewarded', 400);
  const grants = await referralService.countReferralGrants(REFERRER);
  assert.equal(grants.granted, 4);
  assert.equal(grants.rewarded, 1);
});
